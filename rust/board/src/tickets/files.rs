//! Files next to the tickets, as Bun keeps them: pasted attachments (`src/board/attachments.ts`, `<data>/attachments/`),
//! the user's avatar choices (`src/board/avatars.ts`, `<data>/avatars.json`) and prompt snippets
//! (`src/board/snippets.ts`, `<data>/snippets.json`). Pure file work; the routes are in `routes.rs`.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ckanban_core::atomic::new_id;
use ckanban_core::datafile::{formats, write_json};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::writer::{Refusal, bad, now};

// ---- Attachments ----

pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const IMAGE_TYPES: [(&str, &str); 4] = [("image/png", "png"), ("image/jpeg", "jpg"), ("image/gif", "gif"), ("image/webp", "webp")];
const DOC_EXTS: [&str; 4] = ["pdf", "docx", "xlsx", "pptx"];
const TEXT_EXTS: [&str; 31] = [
    "txt", "md", "csv", "tsv", "json", "js", "jsx", "ts", "tsx", "py", "rb", "go", "java", "c", "h", "cpp", "cs", "php", "swift", "kt", "rs",
    "html", "css", "yaml", "yml", "xml", "toml", "ini", "log", "sql", "sh",
];
pub const UNSUPPORTED: &str = "this kind of file can't be attached (images, PDF, Word, Excel, PowerPoint, text and code files can)";

fn ext_alt() -> String {
    let mut all: Vec<&str> = IMAGE_TYPES.iter().map(|(_, e)| *e).collect();
    all.extend(DOC_EXTS);
    all.extend(TEXT_EXTS);
    all.join("|")
}

static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^[0-9a-f]{{32}}\\.(?:{})$", ext_alt())).unwrap());
/// `REF_RE`: the UI URL or an absolute path into an attachments folder (`\b` after the name, ASCII like JS).
static REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:/api/attachments/|/attachments/)([0-9a-f]{{32}}\\.(?:{}))(?-u:\\b)", ext_alt())).unwrap());

pub fn attachments_dir(root: &Path) -> PathBuf {
    root.join("attachments")
}

pub fn is_attachment_name(name: &str) -> bool {
    NAME_RE.is_match(name)
}

fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_lowercase()
}

/// `attachmentType`: what a stored attachment is served as; text and code always as plain text.
pub fn attachment_type(name: &str) -> Option<&'static str> {
    if !is_attachment_name(name) {
        return None;
    }
    let ext = ext_of(name);
    if let Some((t, _)) = IMAGE_TYPES.iter().find(|(_, e)| *e == ext) {
        return Some(t);
    }
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "text/plain; charset=utf-8",
    })
}

/// `opensInline`: images, PDF and text open in the browser; Office files download.
pub fn opens_inline(name: &str) -> bool {
    !["docx", "xlsx", "pptx"].contains(&ext_of(name).as_str())
}

/// `looksLike`: the file's first bytes match its type.
fn looks_like(ext: &str, b: &[u8]) -> bool {
    let at = |i: usize, xs: &[u8]| xs.iter().enumerate().all(|(k, x)| b.get(i + k) == Some(x));
    match ext {
        "png" => at(0, &[0x89, 0x50, 0x4e, 0x47]),
        "jpg" => at(0, &[0xff, 0xd8, 0xff]),
        "gif" => at(0, &[0x47, 0x49, 0x46, 0x38]),
        "webp" => at(0, &[0x52, 0x49, 0x46, 0x46]) && at(8, &[0x57, 0x45, 0x42, 0x50]),
        "pdf" => at(0, &[0x25, 0x50, 0x44, 0x46]),
        "docx" | "xlsx" | "pptx" => at(0, &[0x50, 0x4b, 0x03, 0x04]),
        _ => TEXT_EXTS.contains(&ext) && !b[..b.len().min(8192)].contains(&0),
    }
}

/// `uploadExt`: from the file name when there is one, else from an image content type.
pub fn upload_ext(content_type: &str, file_name: Option<&str>) -> Option<String> {
    let ext = file_name.filter(|n| n.contains('.')).map(ext_of).unwrap_or_default();
    if !ext.is_empty() {
        if DOC_EXTS.contains(&ext.as_str()) || TEXT_EXTS.contains(&ext.as_str()) {
            return Some(ext);
        }
        if ext == "jpeg" {
            return Some("jpg".into());
        }
        if IMAGE_TYPES.iter().any(|(_, e)| *e == ext) {
            return Some(ext);
        }
    }
    IMAGE_TYPES.iter().find(|(t, _)| *t == content_type).map(|(_, e)| e.to_string())
}

pub fn is_image_type(t: &str) -> bool {
    IMAGE_TYPES.iter().any(|(x, _)| *x == t)
}

/// `saveAttachment`: checked, then saved under a new `<32 hex>.<ext>` name.
pub fn save_attachment(dir: &Path, ext: Option<&str>, bytes: &[u8]) -> Result<String, Refusal> {
    let Some(ext) = ext.filter(|e| is_attachment_name(&format!("{}.{e}", "0".repeat(32)))) else { return Err((415, UNSUPPORTED.into())) };
    if bytes.is_empty() {
        return Err(bad("file is empty"));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err((413, "file is larger than 25 MB".into()));
    }
    if !looks_like(ext, bytes) {
        return Err(bad(format!("file is not a valid {} file", ext.to_uppercase())));
    }
    std::fs::create_dir_all(dir).map_err(|e| (500, e.to_string()))?;
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| (500, e.to_string()))?;
    let name = format!("{}.{ext}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>());
    std::fs::write(dir.join(&name), bytes).map_err(|e| (500, e.to_string()))?;
    Ok(name)
}

pub fn attachment_file(dir: &Path, name: &str) -> Option<PathBuf> {
    if !is_attachment_name(name) {
        return None;
    }
    let f = dir.join(name);
    f.exists().then_some(f)
}

/// `referencedAttachments`: attachment names referenced anywhere in the texts, first seen first.
pub fn referenced_attachments(texts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in texts {
        for c in REF_RE.captures_iter(t) {
            let n = c[1].to_string();
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// `deleteAttachments`.
pub fn delete_attachments(root: &Path, names: &[String]) {
    let dir = attachments_dir(root);
    for n in names.iter().filter(|n| is_attachment_name(n)) {
        let _ = std::fs::remove_file(dir.join(n));
    }
}

/// `cleanFileName`: a name that can't break the markdown link it sits in.
pub fn clean_file_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '`' | '\\'))
        .map(|c| match c {
            '[' => '(',
            ']' => ')',
            c if (c as u32) < 0x20 || c as u32 == 0x7f => ' ',
            c => c,
        })
        .collect();
    let squashed = crate::index::text::squash_spaces(&s);
    let t = crate::index::text::js_trim(&squashed);
    let cut = crate::index::text::slice16(t, 120);
    let out = crate::index::text::js_trim(cut);
    if out.is_empty() { "file".into() } else { out.to_string() }
}

/// `attachmentHeader`: `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`.
pub fn attachment_header(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if (' '..='~').contains(&c) && c != '"' && c != '\\' { c } else { '_' }).collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", encode_uri_component(name))
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(s, KEEP).to_string()
}

// ---- Avatars ----

const FACES: [&str; 7] = ["robot", "person", "critter", "cat", "bear", "alien", "ghost"];
const HAIRS: [&str; 10] = ["none", "short", "ponytail", "bun", "spiky", "long", "curly", "mohawk", "pigtails", "fringe"];
const HATS: [&str; 8] = ["none", "crown", "bow", "cap", "beanie", "wizard", "party", "tophat"];
const ACCESSORIES: [&str; 9] = ["none", "glasses", "headset", "magnifier", "sunglasses", "bowtie", "scarf", "flower", "eyepatch"];
const EYES: [&str; 5] = ["dots", "round", "big", "sleepy", "lashes"];
const DETAILS: [&str; 5] = ["none", "blush", "freckles", "moustache", "beard"];
const BACKGROUNDS: [&str; 5] = ["plain", "fade", "stripes", "dots", "stars"];
const MAX_AVATARS: usize = 500;
pub const CLAUDE_KEY: &str = "claude";
const MAX_CLAUDE_NAME: usize = 24;

static AVATAR_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap());
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap());

pub fn is_avatar_name(v: &str) -> bool {
    v.encode_utf16().count() <= 64 && AVATAR_NAME.is_match(v)
}

/// `cleanClaudeName`: one line, spaces collapsed, trimmed, at most 24 characters; "" for "Claude" or nothing usable.
pub fn clean_claude_name(v: Option<&Value>) -> String {
    let Some(Value::String(s)) = v else { return String::new() };
    let mut one = String::new();
    let mut ctrl = false;
    for c in s.chars() {
        let u = c as u32;
        let is_ctrl = u < 0x20 || (0x7f..=0x9f).contains(&u) || c == '\u{2028}' || c == '\u{2029}';
        if is_ctrl {
            if !ctrl {
                one.push(' ');
            }
            ctrl = true;
            continue;
        }
        ctrl = false;
        if is_format(c) {
            continue;
        }
        one.push(c);
    }
    let squashed = crate::index::text::squash_spaces(&one);
    let trimmed = crate::index::text::js_trim(&squashed);
    let name: String = trimmed.chars().take(MAX_CLAUDE_NAME).collect();
    let name = crate::index::text::js_trim(&name).to_string();
    if name.to_lowercase() == "claude" { String::new() } else { name }
}

/// Unicode `Cf` (format) characters a name may carry: soft hyphen, zero-width and direction marks, BOM and the like.
fn is_format(c: char) -> bool {
    matches!(c as u32, 0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0xE0001 | 0xE0020..=0xE007F)
}

fn one_of(list: &[&str], v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| list.contains(s)).map(str::to_string)
}

/// `cleanLook`: the known, valid fields of one look, in Bun's order.
pub fn clean_look(v: &Value, key: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    let Value::Object(x) = v else { return out };
    let hex = |k: &str| x.get(k).and_then(Value::as_str).filter(|s| HEX.is_match(s)).map(|s| s.to_lowercase());
    if let Some(f) = one_of(&FACES, x.get("face")) {
        out.insert("face".into(), f.into());
    }
    if let Some(c) = hex("color") {
        out.insert("color".into(), c.into());
    }
    if let Some(h) = one_of(&HAIRS, x.get("hair")) {
        out.insert("hair".into(), h.into());
    }
    if let Some(c) = hex("hairColor") {
        out.insert("hairColor".into(), c.into());
    }
    if let Some(h) = one_of(&HATS, x.get("hat")) {
        out.insert("hat".into(), h.into());
    }
    if let Some(a) = one_of(&ACCESSORIES, x.get("accessory")) {
        out.insert("accessory".into(), a.into());
    }
    if let Some(e) = one_of(&EYES, x.get("eyes")) {
        out.insert("eyes".into(), e.into());
    }
    if let Some(d) = one_of(&DETAILS, x.get("detail")) {
        out.insert("detail".into(), d.into());
    }
    if let Some(b) = one_of(&BACKGROUNDS, x.get("background")) {
        out.insert("background".into(), b.into());
    }
    if !out.contains_key("hat") {
        if let Some(old) = one_of(&["crown", "bow"], x.get("accessory")) {
            out.insert("hat".into(), old.into());
            out.insert("accessory".into(), "none".into());
        } else if out.contains_key("accessory") {
            out.insert("hat".into(), "none".into());
        }
    }
    if key == Some(CLAUDE_KEY) {
        let name = clean_claude_name(x.get("name"));
        if !name.is_empty() {
            out.insert("name".into(), name.into());
        }
    }
    out
}

/// `cleanAvatars`.
pub fn clean_avatars(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Value::Object(m) = v else { return out };
    for (name, raw) in m {
        if out.len() >= MAX_AVATARS {
            break;
        }
        if !is_avatar_name(name) {
            continue;
        }
        let look = clean_look(raw, Some(name));
        if !look.is_empty() {
            out.insert(name.clone(), Value::Object(look));
        }
    }
    out
}

fn avatars_file(root: &Path) -> PathBuf {
    root.join("avatars.json")
}

/// `Store.listAvatars`.
pub fn list_avatars(root: &Path) -> Map<String, Value> {
    match std::fs::read_to_string(avatars_file(root)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(v) => clean_avatars(&v),
        None => Map::new(),
    }
}

/// `Store.saveAvatars`: pretty, final newline.
pub fn save_avatars(root: &Path, map: &Map<String, Value>) -> Result<(), Refusal> {
    let clean = clean_avatars(&Value::Object(map.clone()));
    write_json(&avatars_file(root), &Value::Object(clean), formats::AVATARS).map_err(|e| (500, e.to_string()))
}

fn kept_name(map: &Map<String, Value>, name: &str) -> Option<String> {
    if name != CLAUDE_KEY {
        return None;
    }
    let n = clean_claude_name(map.get(name).and_then(|l| l.get("name")));
    (!n.is_empty()).then_some(n)
}

/// `withAvatar`.
pub fn with_avatar(map: &Map<String, Value>, name: &str, look: &Value) -> Result<Map<String, Value>, Refusal> {
    if !is_avatar_name(name) {
        return Err(bad("name may only use lowercase letters, digits and dashes"));
    }
    let mut clean = clean_look(look, Some(name));
    clean.remove("name");
    if clean.is_empty() {
        return Err(bad("nothing to save: use known parts and #rrggbb colours"));
    }
    if !map.contains_key(name) && map.len() >= MAX_AVATARS {
        return Err(bad(format!("at most {MAX_AVATARS} avatars can be saved")));
    }
    if let Some(n) = kept_name(map, name) {
        clean.insert("name".into(), n.into());
    }
    let mut out = map.clone();
    out.insert(name.to_string(), Value::Object(clean));
    Ok(out)
}

/// `withoutAvatar`: Claude's display name stays.
pub fn without_avatar(map: &Map<String, Value>, name: &str) -> Map<String, Value> {
    let kept = kept_name(map, name);
    let mut out = Map::new();
    for (k, v) in map {
        if k != name {
            out.insert(k.clone(), v.clone());
        } else if let Some(n) = &kept {
            out.insert(k.clone(), json!({ "name": n }));
        }
    }
    out
}

/// `withClaudeName`.
pub fn with_claude_name(map: &Map<String, Value>, raw: Option<&Value>) -> Result<Map<String, Value>, Refusal> {
    if let Some(v) = raw
        && !v.is_null()
        && !v.is_string()
    {
        return Err(bad("name must be text"));
    }
    let name = clean_claude_name(raw);
    let mut next = match map.get(CLAUDE_KEY) {
        Some(Value::Object(l)) => l.clone(),
        _ => Map::new(),
    };
    next.remove("name");
    if !name.is_empty() {
        next.insert("name".into(), name.clone().into());
    }
    if !map.contains_key(CLAUDE_KEY) && !name.is_empty() && map.len() >= MAX_AVATARS {
        return Err(bad(format!("at most {MAX_AVATARS} avatars can be saved")));
    }
    let keep = !next.is_empty();
    let mut out = Map::new();
    for (k, v) in map {
        if k != CLAUDE_KEY {
            out.insert(k.clone(), v.clone());
        } else if keep {
            out.insert(k.clone(), Value::Object(next.clone()));
        }
    }
    if keep {
        out.insert(CLAUDE_KEY.into(), Value::Object(next));
    }
    Ok(out)
}

// ---- Snippets ----

const SNIPPET_MAX_NAME: usize = 40;
const SNIPPET_MAX_TEXT: usize = 20_000;

fn snippets_file(root: &Path) -> PathBuf {
    root.join("snippets.json")
}

fn read_snippets(root: &Path) -> Vec<Value> {
    match std::fs::read_to_string(snippets_file(root)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    }
}

/// Writes the list (pretty, final newline) and says so on the bus (`snippets.updated`).
fn write_snippets(root: &Path, list: &[Value], bus: &crate::bus::Bus) -> Result<(), Refusal> {
    write_json(&snippets_file(root), &Value::Array(list.to_vec()), formats::SNIPPETS).map_err(|e| (500, e.to_string()))?;
    bus.emit_json(json!({ "type": "snippets.updated" }));
    Ok(())
}

fn s_str<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `localeCompare` for snippet names and scopes (lowercase letters, digits and dashes): close enough to ICU's order
/// for these characters when compared case-blind first.
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    key(a).cmp(&key(b)).then_with(|| a.cmp(b))
}

/// `Snippets.list`: global snippets plus the board's own (all without a board), by name.
pub fn list_snippets(root: &Path, profile: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = read_snippets(root)
        .into_iter()
        .filter(|s| profile.is_none_or(|p| s_str(s, "scope") == "global" || s_str(s, "scope") == p))
        .collect();
    out.sort_by(|a, b| locale_cmp(s_str(a, "name"), s_str(b, "name")).then_with(|| locale_cmp(s_str(a, "scope"), s_str(b, "scope"))));
    out
}

/// `String(v ?? dflt)`.
pub fn js_string(v: Option<&Value>, dflt: &str) -> String {
    match v {
        None | Some(Value::Null) => dflt.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => ckanban_core::jsnum::js_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn validate_snippet(root: &Path, input: &Value, list: &[Value], self_id: Option<&str>) -> Result<(String, String, String), Refusal> {
    let raw = js_string(input.get("name"), "");
    let trimmed = crate::index::text::js_trim(&raw);
    let name = trimmed.strip_prefix('@').unwrap_or(trimmed).to_string();
    let text = js_string(input.get("text"), "");
    let scope = js_string(input.get("scope"), "global");
    static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap());
    if name.is_empty() {
        return Err(bad("name is required"));
    }
    if name.encode_utf16().count() > SNIPPET_MAX_NAME {
        return Err(bad(format!("name is too long (max {SNIPPET_MAX_NAME} characters)")));
    }
    if !NAME.is_match(&name) {
        return Err(bad("name may only use lowercase letters, digits and dashes"));
    }
    if crate::index::text::js_trim(&text).is_empty() {
        return Err(bad("text is required"));
    }
    if text.encode_utf16().count() > SNIPPET_MAX_TEXT {
        return Err(bad(format!("text is too long (max {SNIPPET_MAX_TEXT} characters)")));
    }
    if scope != "global" && ckanban_core::DataDir::new(root).profile(&scope).is_none() {
        return Err(bad(format!("board {scope} not found")));
    }
    if list.iter().any(|s| Some(s_str(s, "id")) != self_id && s_str(s, "scope") == scope && s_str(s, "name") == name) {
        let place = if scope == "global" { "on all boards" } else { "on this board" };
        return Err((409, format!("@{name} already exists {place}")));
    }
    Ok((name, text, scope))
}

/// `Snippets.create`.
pub fn create_snippet(root: &Path, input: &Value, bus: &crate::bus::Bus) -> Result<Value, Refusal> {
    let mut list = read_snippets(root);
    let (name, text, scope) = validate_snippet(root, input, &list, None)?;
    let at = now();
    let s = json!({ "id": new_id(), "name": name, "text": text, "scope": scope, "createdAt": at, "updatedAt": at });
    list.push(s.clone());
    write_snippets(root, &list, bus)?;
    Ok(s)
}

/// `Snippets.update`.
pub fn update_snippet(root: &Path, id: &str, patch: &Value, bus: &crate::bus::Bus) -> Result<Value, Refusal> {
    let mut list = read_snippets(root);
    let Some(i) = list.iter().position(|s| s_str(s, "id") == id) else { return Err((404, "snippet not found".into())) };
    let mut merged = list[i].as_object().cloned().unwrap_or_default();
    if let Value::Object(p) = patch {
        for (k, v) in p {
            merged.insert(k.clone(), v.clone());
        }
    }
    let (name, text, scope) = validate_snippet(root, &Value::Object(merged), &list, Some(id))?;
    let mut next = list[i].as_object().cloned().unwrap_or_default();
    next.insert("name".into(), name.into());
    next.insert("text".into(), text.into());
    next.insert("scope".into(), scope.into());
    next.insert("updatedAt".into(), now().into());
    list[i] = Value::Object(next.clone());
    write_snippets(root, &list, bus)?;
    Ok(Value::Object(next))
}

/// `Snippets.remove`.
pub fn remove_snippet(root: &Path, id: &str, bus: &crate::bus::Bus) -> Result<(), Refusal> {
    let list = read_snippets(root);
    if !list.iter().any(|s| s_str(s, "id") == id) {
        return Err((404, "snippet not found".into()));
    }
    let kept: Vec<Value> = list.into_iter().filter(|s| s_str(s, "id") != id).collect();
    write_snippets(root, &kept, bus)
}

/// `Snippets.dropScope`: a deleted board's own snippets go with it.
pub fn drop_snippet_scope(root: &Path, profile: &str, bus: &crate::bus::Bus) {
    let list = read_snippets(root);
    if list.iter().any(|s| s_str(s, "scope") == profile) {
        let kept: Vec<Value> = list.into_iter().filter(|s| s_str(s, "scope") != profile).collect();
        if let Err((_, e)) = write_snippets(root, &kept, bus) {
            eprintln!("[board] snippets of {profile}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_names_and_refs() {
        let n = format!("{}.png", "a".repeat(32));
        assert!(is_attachment_name(&n));
        assert!(!is_attachment_name("../x.png"));
        let texts = vec![format!("see /api/attachments/{n} and /x/attachments/{n}"), format!("![](/api/attachments/{}.pdf)", "b".repeat(32))];
        assert_eq!(referenced_attachments(&texts), vec![n.clone(), format!("{}.pdf", "b".repeat(32))]);
        assert_eq!(upload_ext("application/octet-stream", Some("Notes.MD")), Some("md".into()));
        assert_eq!(upload_ext("image/png", Some("x.heic")), Some("png".into()));
        assert_eq!(upload_ext("application/octet-stream", Some("a.exe")), None);
        assert_eq!(attachment_header("Bild ä.png"), "attachment; filename=\"Bild _.png\"; filename*=UTF-8''Bild%20%C3%A4.png");
        assert_eq!(clean_file_name(" a [b]\n<c> "), "a (b) c");
    }

    #[test]
    fn avatars_like_bun() {
        let look = json!({ "face": "cat", "color": "#AABBCC", "accessory": "crown", "x": 1 });
        assert_eq!(Value::Object(clean_look(&look, None)), json!({ "face": "cat", "color": "#aabbcc", "hat": "crown", "accessory": "none" }));
        let m = with_claude_name(&Map::new(), Some(&json!("  Clawd\u{200B} "))).unwrap();
        assert_eq!(Value::Object(m.clone()), json!({ "claude": { "name": "Clawd" } }));
        let m = with_avatar(&m, "claude", &json!({ "face": "robot" })).unwrap();
        assert_eq!(Value::Object(m.clone()), json!({ "claude": { "face": "robot", "name": "Clawd" } }));
        assert_eq!(Value::Object(without_avatar(&m, "claude")), json!({ "claude": { "name": "Clawd" } }));
        assert!(with_avatar(&m, "Bad Name", &json!({ "face": "cat" })).is_err());
        assert_eq!(clean_claude_name(Some(&json!("claude"))), "");
    }
}
