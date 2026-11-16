//! The board routes that write (`src/api/profiles.ts`): `POST /api/profiles` (a new board), `PATCH` and `DELETE
//! /api/profiles/:p` (`detect-setup` is R6's, in `git::routes`). `profile.json` is written pretty with a final newline,
//! keys in Bun's order (a changed key keeps its place, a new one goes last), and `profile.updated` goes out.

use std::path::Path;

use ckanban_core::DataDir;
use ckanban_core::home::Profile;
use ckanban_core::jsnum::{num, truthy};
use ckanban_core::record::JsonRecord;
use serde_json::{Map, Value, json};

use super::files::{drop_snippet_scope, js_string};
use super::norm::{EFFORTS, KIND_DEFAULTS, TICKET_KINDS, effort_help, model_help, slugify, valid_effort, valid_model};
use super::routes::{Reply, Req, Writes, cap_value, user_only_refusal};
use super::writer::{Refusal, bad, block, now};
use crate::git::{repo, setup};
use crate::index::text::js_trim;
use crate::runs::connectors::{Connectors, parse_connector_setting};

fn body_obj(req: &Req) -> Result<Map<String, Value>, Refusal> {
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(m)) => Ok(ckanban_core::jsnum::normalize_map(m)),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(bad("invalid JSON body")),
    }
}

/// `realFolder`: the folder as the OS sees it; the path as written when it doesn't exist.
fn real_folder(p: &str) -> String {
    std::fs::canonicalize(p).map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

/// `refuseSharedFolder`: one board per folder.
fn refuse_shared(others: &[Map<String, Value>], path: &str) -> Result<(), Refusal> {
    let want = real_folder(path);
    if let Some(o) = others.iter().find(|p| real_folder(p.get("path").and_then(Value::as_str).unwrap_or("")) == want) {
        let name = o.get("name").filter(|v| truthy(Some(v))).or_else(|| o.get("slug")).map(|v| js_string(Some(v), "")).unwrap_or_default();
        return Err(bad(format!("The board \"{name}\" already uses this folder. Open that board instead.")));
    }
    Ok(())
}

fn workspace_value(v: &Value) -> Result<Value, Refusal> {
    match v.as_str() {
        Some("worktree" | "folder") => Ok(v.clone()),
        _ => Err(bad("workspace must be \"worktree\" or \"folder\"")),
    }
}

fn profiles(root: &Path) -> Vec<Map<String, Value>> {
    let mut all: Vec<Map<String, Value>> = DataDir::new(root).list_profiles().unwrap_or_default().into_iter().map(|p| p.record.0).collect();
    all.sort_by(|a, b| js_string(a.get("createdAt"), "").cmp(&js_string(b.get("createdAt"), "")));
    all
}

fn save(w: &Writes, slug: &str, p: Map<String, Value>) -> Result<(), Refusal> {
    let data = DataDir::new(w.tickets.root().to_path_buf());
    Profile { record: JsonRecord(p.clone()) }.save(&data).map_err(|e| (500, e.to_string()))?;
    w.tickets.bus.emit_json(json!({ "type": "profile.updated", "slug": slug, "profile": Value::Object(p) }));
    Ok(())
}

/// `POST /api/profiles`: a new board for a folder.
pub fn create(w: &Writes, req: &Req) -> Result<Reply, Refusal> {
    let b = body_obj(req)?;
    let name = js_trim(&js_string(b.get("name"), "")).to_string();
    let raw = js_trim(&js_string(b.get("path"), "")).to_string();
    let path = match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{}{rest}", std::env::var("HOME").unwrap_or_else(|_| "~".into())),
        _ => raw,
    };
    if name.is_empty() {
        return Err(bad("name is required"));
    }
    if path.is_empty() || !Path::new(&path).is_dir() {
        return Err(bad(format!("path is not a directory: {path}")));
    }
    if truthy(b.get("effort")) && !valid_effort(&js_string(b.get("effort"), "")) {
        return Err(bad(format!("\"{}\" is not an effort level. Use {}.", js_string(b.get("effort"), ""), effort_help())));
    }
    let root = w.tickets.root().to_path_buf();
    refuse_shared(&profiles(&root), &path)?;
    let data = DataDir::new(root.clone());
    let base = slugify(&name, 40);
    let mut slug = base.clone();
    let mut i = 2;
    while data.profile(&slug).is_some() {
        slug = format!("{base}-{i}");
        i += 1;
    }
    let base_branch = if truthy(b.get("baseBranch")) {
        b["baseBranch"].clone()
    } else {
        let p = Path::new(&path);
        let found = block(async {
            if !repo::is_git_repo(p).await {
                return String::new();
            }
            let detected = repo::detect_base_branch(p).await;
            repo::resolve_base_branch(p, &detected).await.unwrap_or_default()
        });
        Value::String(found)
    };
    let mut p = Map::new();
    p.insert("name".into(), name.into());
    p.insert("slug".into(), slug.clone().into());
    p.insert("path".into(), path.clone().into());
    p.insert("baseBranch".into(), base_branch);
    p.insert("model".into(), if truthy(b.get("model")) { b["model"].clone() } else { Value::Null });
    if truthy(b.get("effort")) {
        p.insert("effort".into(), js_string(b.get("effort"), "").into());
    }
    if b.get("ultracode") == Some(&Value::Bool(true)) {
        p.insert("ultracode".into(), true.into());
    }
    p.insert("createdAt".into(), now().into());
    if let Some(ws) = b.get("workspace") {
        p.insert("workspace".into(), workspace_value(ws)?);
    }
    let detected = block(setup::detect_setup(Path::new(&path)));
    let saved = match setup::apply_detection(&Value::Object(p), &detected, false) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    std::fs::create_dir_all(data.profile_dir(&slug)).map_err(|e| (500, e.to_string()))?;
    save(w, &slug, saved.clone())?;
    Ok(Reply::Json(201, Value::Object(saved)))
}

/// `parseTaskModels`: null clears; else kind → {model, effort}, only overrides kept.
fn parse_task_models(v: &Value) -> Result<Value, String> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let Value::Object(m) = v else { return Err("taskModels must be an object of task kind → { model, effort }, or null".into()) };
    let mut out = Map::new();
    for (kind, pick) in m {
        if !TICKET_KINDS.contains(&kind.as_str()) {
            return Err(format!("taskModels: \"{kind}\" is not a task kind. Use {}.", TICKET_KINDS.join(", ")));
        }
        if pick.is_null() {
            continue;
        }
        let model = pick.get("model");
        let effort = pick.get("effort");
        if !model.and_then(Value::as_str).is_some_and(valid_model) {
            return Err(format!("taskModels.{kind}: \"{}\" is not a model name. Use {}.", js_string(model, "undefined"), model_help()));
        }
        if !effort.and_then(Value::as_str).is_some_and(valid_effort) {
            return Err(format!("taskModels.{kind}: \"{}\" is not an effort level. Use {}.", js_string(effort, "undefined"), EFFORTS.join(", ")));
        }
        let (model, effort) = (model.and_then(Value::as_str).unwrap_or(""), effort.and_then(Value::as_str).unwrap_or(""));
        let d = KIND_DEFAULTS.iter().find(|(k, _, _)| k == kind).map(|(_, m, e)| (*m, *e)).unwrap_or(("", ""));
        if model != d.0 || effort != d.1 {
            out.insert(kind.clone(), json!({ "model": model, "effort": effort }));
        }
    }
    Ok(if out.is_empty() { Value::Null } else { Value::Object(out) })
}

fn connectors_json(c: Connectors) -> Value {
    match c {
        Connectors::All => "all".into(),
        Connectors::None => "none".into(),
        Connectors::Keep(list) => json!(list),
    }
}

/// `PATCH`/`DELETE /api/profiles/:p`.
pub fn routes(w: &Writes, req: &Req, slug: &str) -> Result<Reply, Refusal> {
    let root = w.tickets.root().to_path_buf();
    let data = DataDir::new(root.clone());
    let profile = data.profile(slug).map(|p| p.record.0).ok_or_else(|| (404, format!("board {slug} not found")))?;
    let folder = profile.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    if req.method == "DELETE" {
        if w.reads.live.board_running(slug) > 0 {
            return Err((409, "board has running tickets".into()));
        }
        let _ = std::fs::remove_dir_all(data.profile_dir(slug));
        w.tickets.forget_board(slug);
        drop_snippet_scope(&root, slug, &w.tickets.bus);
        w.tickets.hooks().kill_shells(slug);
        w.tickets.bus.emit_json(json!({ "type": "profile.updated", "slug": slug, "profile": null }));
        return Ok(Reply::Empty(204));
    }
    let b = body_obj(req)?;
    let mut next = profile.clone();
    let set = |next: &mut Map<String, Value>, k: &str, v: Value| {
        next.insert(k.into(), v);
    };
    for k in ["name", "path", "baseBranch"] {
        if let Some(v) = b.get(k) {
            set(&mut next, k, js_string(Some(v), "").into());
        }
    }
    if let Some(v) = b.get("model") {
        set(&mut next, "model", if truthy(Some(v)) { v.clone() } else { Value::Null });
    }
    if let Some(v) = b.get("mainModel") {
        if truthy(Some(v)) && !v.as_str().is_some_and(valid_model) {
            return Err(bad(format!("\"{}\" is not a model name. Use {}.", js_string(Some(v), ""), model_help())));
        }
        set(&mut next, "mainModel", if truthy(Some(v)) { v.clone() } else { Value::Null });
    }
    if let Some(v) = b.get("taskModels") {
        set(&mut next, "taskModels", parse_task_models(v).map_err(bad)?);
    }
    if let Some(v) = b.get("freshChatTokens") {
        let ok = v.is_null() || v.as_f64().is_some_and(|n| n > 0.0 && n <= 10_000_000.0);
        if !ok {
            return Err(bad("freshChatTokens must be a positive number, or null for the default"));
        }
        set(&mut next, "freshChatTokens", v.as_f64().map(|n| num((n + 0.5).floor())).unwrap_or(Value::Null));
    }
    if b.contains_key("chrome") || b.contains_key("browsers") {
        if req.run.is_some() || req.huddle {
            return Err((403, "only the user picks the board's browsers".into()));
        }
        if b.contains_key("browsers") && (req.run.is_some() || req.huddle || !(req.user)()) {
            return Err(user_only_refusal("Choosing the board's browsers"));
        }
        let (chrome, browsers) = w.tickets.hooks().browsers(b.get("browsers"), b.get("chrome"))?;
        if b.contains_key("browsers") {
            set(&mut next, "browsers", browsers);
            set(&mut next, "chrome", chrome);
        } else {
            set(&mut next, "chrome", chrome);
            set(&mut next, "browsers", browsers);
        }
    }
    if let Some(v) = b.get("checkinOfferDismissed") {
        set(&mut next, "checkinOfferDismissed", (v == &Value::Bool(true)).into());
    }
    if let Some(v) = b.get("effort") {
        if truthy(Some(v)) && !valid_effort(&js_string(Some(v), "")) {
            return Err(bad(format!("\"{}\" is not an effort level. Use {}.", js_string(Some(v), ""), effort_help())));
        }
        set(&mut next, "effort", if truthy(Some(v)) { v.clone() } else { Value::Null });
    }
    if let Some(v) = b.get("ultracode") {
        if !v.is_boolean() {
            return Err(bad("ultracode must be true or false"));
        }
        set(&mut next, "ultracode", v.clone());
        if next.get("effort").and_then(Value::as_str) == Some("ultracode") {
            set(&mut next, "effort", "xhigh".into());
        }
    }
    if let Some(v) = b.get("copyFiles") {
        let Value::Array(a) = v else { return Err(bad("copyFiles must be a list of paths")) };
        let mut out: Vec<String> = Vec::new();
        for f in a.iter().map(|f| js_trim(&js_string(Some(f), "")).to_string()).filter(|f| !f.is_empty()) {
            if !out.contains(&f) {
                out.push(f);
            }
        }
        set(&mut next, "copyFiles", json!(out));
    }
    for k in ["setupCommand", "cleanupCommand"] {
        if let Some(v) = b.get(k) {
            set(&mut next, k, js_trim(&js_string(Some(v), "")).into());
        }
    }
    for k in ["autoHuddles", "keepAwake"] {
        if let Some(v) = b.get(k) {
            set(&mut next, k, truthy(Some(v)).into());
        }
    }
    if let Some(v) = b.get("runCapUsd") {
        if req.run.is_some() {
            return Err((403, "only the user can change the board's spending cap".into()));
        }
        let cap = cap_value(v, true)?;
        // `capValue(...) || null`: 0 (none) is saved as null too.
        set(&mut next, "runCapUsd", if truthy(Some(&cap)) { cap } else { Value::Null });
    }
    if let Some(v) = b.get("artifacts") {
        set(&mut next, "artifacts", truthy(Some(v)).into());
    }
    if let Some(v) = b.get("workspace") {
        set(&mut next, "workspace", workspace_value(v)?);
    }
    if let Some(v) = b.get("claudeAiConnectors") {
        let c = parse_connector_setting(v).ok_or_else(|| bad("claudeAiConnectors must be \"all\", \"none\" or a list of connector names"))?;
        set(&mut next, "claudeAiConnectors", connectors_json(c));
    }
    if let Some(v) = b.get("stallMinutes") {
        let ok = v.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=1440.0).contains(&n));
        if !ok {
            return Err(bad("stallMinutes must be a whole number of minutes from 0 (off) to 1440"));
        }
        set(&mut next, "stallMinutes", v.clone());
    }
    if let Some(v) = b.get("setupDetected") {
        set(&mut next, "setupDetected", if truthy(Some(v)) && v.is_object() { v.clone() } else { Value::Null });
    }
    let new_path = next.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    if new_path != folder && real_folder(&new_path) != real_folder(&folder) {
        let others: Vec<Map<String, Value>> = profiles(&root).into_iter().filter(|p| p.get("slug").and_then(Value::as_str) != Some(slug)).collect();
        refuse_shared(&others, &new_path)?;
    }
    if new_path != folder {
        w.tickets.hooks().kill_shells(slug);
    }
    save(w, slug, next.clone())?;
    w.tickets.hooks().board_changed(slug);
    Ok(Reply::Json(200, Value::Object(next)))
}
