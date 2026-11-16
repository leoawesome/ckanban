//! Files of a board's folder, a ticket's copy and its outputs (port of `src/core/files.ts`, the outputs listing of
//! `src/core/store.ts`, `fileRoots`/`rawFile` of `src/api/context.ts`). Every path from a request is checked to stay
//! inside its folder, symlinks included, before anything is read. All of it is blocking file work: callers run it
//! off the runtime (`spawn_blocking`).

use std::cmp::Ordering;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError {
    pub status: u16,
    pub message: String,
}

fn ferr(status: u16, message: impl Into<String>) -> FileError {
    FileError { status, message: message.into() }
}

pub const MAX_VIEW_BYTES: u64 = 1024 * 1024;
/// Most entries one folder listing sends.
pub const MAX_DIR_ENTRIES: usize = 2000;
/// Most output files listed (newest first).
pub const MAX_OUTPUT_FILES: usize = 2000;
/// Dependency, build and version-history folders: never deliverables, and they can hold tens of thousands of files.
const SKIPPED_OUTPUT_DIRS: [&str; 9] = ["node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__"];

/// `rel.split(/[/\\]/).includes("..")`.
fn has_dotdot(rel: &str) -> bool {
    rel.split(['/', '\\']).any(|p| p == "..")
}

/// `join(root, rel)` as Node does it: `rel` is appended even when it starts with "/".
fn node_join(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.as_os_str().to_owned();
    p.push("/");
    p.push(rel);
    PathBuf::from(p)
}

/// `resolveInside`: the real path of `rel` inside `root`; 400 for `..` or a NUL, 404 when missing, 403 when it
/// leaves `root` (through a symlink).
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, FileError> {
    if rel.contains('\0') {
        return Err(ferr(400, "invalid path"));
    }
    if has_dotdot(rel) {
        return Err(ferr(400, "path must not contain .."));
    }
    let real_root = std::fs::canonicalize(root).map_err(|_| ferr(404, "board folder not found"))?;
    let real = std::fs::canonicalize(node_join(&real_root, rel)).map_err(|_| ferr(404, "not found"))?;
    if real != real_root && !real.starts_with(&real_root) {
        return Err(ferr(403, "path is outside the board folder"));
    }
    Ok(real)
}

/// `ticketFolder`: a ticket's own copy while it exists on disk, else the board folder (`ticket` None).
pub fn ticket_folder(board_path: &Path, id: &str, worktree: Option<&str>) -> (PathBuf, Option<String>) {
    match worktree.filter(|w| !w.is_empty() && Path::new(w).exists()) {
        Some(w) => (PathBuf::from(w), Some(id.to_string())),
        None => (board_path.to_path_buf(), None),
    }
}

/// `openWithSystem`: opens a file inside `root` with the system's default app (argv only, never a shell).
pub fn open_with_system(root: &Path, rel: &str, bin: Option<&str>) -> Result<PathBuf, FileError> {
    let file = resolve_inside(root, rel)?;
    let bin = bin.map(str::to_string).unwrap_or_else(|| if cfg!(target_os = "macos") { "open".into() } else { "xdg-open".into() });
    let spawned = std::process::Command::new(&bin)
        .arg(&file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        // Reaped in the background, like Bun's unref'd child.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
            Ok(file)
        }
        Err(e) => Err(ferr(500, format!("couldn't run {bin}: {e}"))),
    }
}

/// Entries of the given names (relative to `root`) that git ignores; empty when `root` isn't a repo.
fn git_ignored(root: &Path, rels: &[String]) -> HashSet<String> {
    if rels.is_empty() {
        return HashSet::new();
    }
    let child = std::process::Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return HashSet::new() };
    let input = format!("{}\0", rels.join("\0"));
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let Ok(out) = child.wait_with_output() else { return HashSet::new() };
    // 0 = some ignored, 1 = none, 128 = not a repo.
    if !out.status.success() {
        return HashSet::new();
    }
    String::from_utf8_lossy(&out.stdout).split('\0').filter(|x| !x.is_empty()).map(|x| x.trim_end_matches('/').to_string()).collect()
}

/// Where a character sorts in `localeCompare` (ICU root collation, first level): spaces and punctuation, then
/// symbols, then digits, then letters (case folded). Good for the file names a folder holds; not a full collator.
fn primary(c: char) -> (u8, u32) {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if c.is_whitespace() {
        return (0, c as u32);
    }
    if let Some(i) = PUNCT.find(c) {
        return (1, i as u32);
    }
    if c.is_ascii_digit() {
        return (3, c as u32);
    }
    if c.is_alphabetic() {
        let f = c.to_lowercase().next().unwrap_or(c);
        return (4, fold_accent(f) as u32);
    }
    (2, c as u32)
}

/// Latin letters with accents sort with their base letter at the first level.
fn fold_accent(c: char) -> char {
    match c {
        'à'..='å' => 'a',
        'ç' => 'c',
        'è'..='ë' => 'e',
        'ì'..='ï' => 'i',
        'ñ' => 'n',
        'ò'..='ö' | 'ø' => 'o',
        'ù'..='ü' => 'u',
        'ý' | 'ÿ' => 'y',
        _ => c,
    }
}

/// `a.localeCompare(b)` for file names (see `primary`); ties: accents, then lowercase before uppercase.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let pa: Vec<(u8, u32)> = a.chars().map(primary).collect();
    let pb: Vec<(u8, u32)> = b.chars().map(primary).collect();
    pa.cmp(&pb)
        .then_with(|| {
            let fa: Vec<char> = a.chars().flat_map(char::to_lowercase).collect();
            let fb: Vec<char> = b.chars().flat_map(char::to_lowercase).collect();
            fa.cmp(&fb)
        })
        .then_with(|| {
            // Lowercase first at the first difference in case.
            for (x, y) in a.chars().zip(b.chars()) {
                if x != y {
                    return y.is_lowercase().cmp(&x.is_lowercase()).then(x.cmp(&y));
                }
            }
            a.len().cmp(&b.len())
        })
}

/// `listDir`: one folder level, folders first then files, each alphabetical; `.git` and git-ignored entries hidden.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Value>, FileError> {
    let dir = resolve_inside(root, rel)?;
    if !dir.is_dir() {
        return Err(ferr(400, "not a directory"));
    }
    let real_root = std::fs::canonicalize(root).map_err(|_| ferr(404, "board folder not found"))?;
    let base: String = dir.strip_prefix(&real_root).map(|p| p.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/")).unwrap_or_default();
    let mut entries: Vec<(String, bool)> = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| ferr(500, e.to_string()))?;
    for e in rd.flatten() {
        let Ok(name) = e.file_name().into_string() else { continue };
        if name == ".git" {
            continue;
        }
        let ft = e.file_type().ok();
        let mut is_dir = ft.is_some_and(|t| t.is_dir());
        if ft.is_some_and(|t| t.is_symlink()) {
            is_dir = std::fs::metadata(dir.join(&name)).map(|m| m.is_dir()).unwrap_or(false);
        }
        entries.push((name, is_dir));
    }
    let probe: Vec<String> = entries.iter().map(|(n, d)| if *d { format!("{n}/") } else { n.clone() }).collect();
    let ignored = git_ignored(&dir, &probe);
    let mut kept: Vec<(String, bool)> = entries.into_iter().filter(|(n, _)| !ignored.contains(n)).collect();
    kept.sort_by(|a, b| match (a.1, b.1) {
        (x, y) if x == y => locale_cmp(&a.0, &b.0),
        (true, _) => Ordering::Less,
        _ => Ordering::Greater,
    });
    Ok(kept
        .into_iter()
        .map(|(name, d)| {
            let path = if base.is_empty() { name.clone() } else { format!("{base}/{name}") };
            json!({ "name": name, "path": path, "type": if d { "dir" } else { "file" } })
        })
        .collect())
}

/// `listDirPage`: the first `MAX_DIR_ENTRIES` entries and how many more there are.
pub fn list_dir_page(root: &Path, rel: &str) -> Result<(Vec<Value>, usize), FileError> {
    let mut all = list_dir(root, rel)?;
    let more = all.len().saturating_sub(MAX_DIR_ENTRIES);
    all.truncate(MAX_DIR_ENTRIES);
    Ok((all, more))
}

/// `readFileForView`: `{path, size, content, binary, tooLarge}`; content is null for a binary or too large file.
pub fn read_file_for_view(root: &Path, rel: &str) -> Result<Value, FileError> {
    let file = resolve_inside(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|_| ferr(404, "not found"))?;
    if !meta.is_file() {
        return Err(ferr(400, "not a file"));
    }
    let size = meta.len();
    let too_large = size > MAX_VIEW_BYTES;
    if too_large {
        return Ok(json!({ "path": rel, "size": size, "content": null, "binary": false, "tooLarge": true }));
    }
    let mut buf = Vec::with_capacity(size as usize);
    std::fs::File::open(&file).and_then(|f| f.take(size).read_to_end(&mut buf)).map_err(|e| ferr(500, e.to_string()))?;
    // Bun allocates `size` bytes and reads into them: a file that shrank meanwhile ends in zero bytes.
    buf.resize(size as usize, 0);
    if buf[..buf.len().min(8192)].contains(&0) {
        return Ok(json!({ "path": rel, "size": size, "content": null, "binary": true, "tooLarge": false }));
    }
    Ok(json!({ "path": rel, "size": size, "content": String::from_utf8_lossy(&buf), "binary": false, "tooLarge": false }))
}

/// A folder a chat message's file paths may point into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRoot {
    /// "ticket", "project" or "outputs".
    pub name: &'static str,
    pub dir: PathBuf,
}

/// A file found in one of the roots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundFile {
    pub root: &'static str,
    pub dir: PathBuf,
    pub rel: String,
    pub file: PathBuf,
}

/// Node's `path.resolve` without the current folder: lexical `.` and `..`.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(x) => out.push(x),
        }
    }
    out
}

/// `fileRoots`: the ticket's own copy (when it has one apart from the project folder), the project folder, its
/// outputs, then the outputs folders of reports its result cards name.
pub fn file_roots(profile: &Value, ticket: &Value, outputs: &Path) -> Vec<FileRoot> {
    let project = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
    let mut roots = Vec::new();
    let own = ticket.get("worktree").and_then(Value::as_str).filter(|x| !x.is_empty()).or_else(|| ticket.get("workdir").and_then(Value::as_str).filter(|x| !x.is_empty()));
    if let Some(own) = own {
        if normalize(Path::new(own)) != normalize(&project) {
            roots.push(FileRoot { name: "ticket", dir: PathBuf::from(own) });
        }
    }
    roots.push(FileRoot { name: "project", dir: project });
    roots.push(FileRoot { name: "outputs", dir: outputs.to_path_buf() });
    let mut seen = HashSet::new();
    for r in ticket.get("results").and_then(Value::as_array).into_iter().flatten() {
        let Some(report) = r.get("report").and_then(Value::as_str).filter(|x| !x.is_empty()) else { continue };
        let dir = Path::new(report).parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        if seen.insert(dir.clone()) {
            roots.push(FileRoot { name: "outputs", dir });
        }
    }
    roots
}

/// `findInRoots`: a file a message mentions (absolute, `~/...`, or relative to the first root that holds it); None
/// when missing, a folder, has `..` or leaves every root (symlinks included).
pub fn find_in_roots(roots: &[FileRoot], written: &str, home: &Path) -> Option<FoundFile> {
    let mut p = written.trim().to_string();
    if p.is_empty() || p.contains('\0') || has_dotdot(&p) {
        return None;
    }
    if let Some(rest) = p.strip_prefix("~/") {
        p = home.join(rest).to_string_lossy().into_owned();
    }
    let mut seen = HashSet::new();
    for root in roots {
        let Ok(real_root) = std::fs::canonicalize(&root.dir) else { continue };
        if !seen.insert(real_root.clone()) {
            continue;
        }
        let file = if p.starts_with('/') {
            match std::fs::canonicalize(&p) {
                Ok(f) => f,
                Err(_) => continue,
            }
        } else {
            match resolve_inside(&real_root, p.strip_prefix("./").unwrap_or(&p)) {
                Ok(f) => f,
                Err(_) => continue,
            }
        };
        if file != real_root && !file.starts_with(&real_root) {
            continue;
        }
        if !std::fs::metadata(&file).map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let rel = file.strip_prefix(&real_root).map(|r| r.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/")).unwrap_or_default();
        return Some(FoundFile { root: root.name, dir: real_root, rel, file });
    }
    None
}

/// `store.listOutputs`: the ticket's output files, newest first (`{name, size, updatedAt}`); dependency and build
/// folders skipped, symlinks not followed, at most `MAX_OUTPUT_FILES`.
pub fn list_outputs(dir: &Path) -> std::io::Result<Vec<Value>> {
    let mut found: Vec<(String, u64, f64)> = Vec::new();
    fn walk(dir: &Path, sub: &str, found: &mut Vec<(String, u64, f64)>) -> std::io::Result<()> {
        let rd = match std::fs::read_dir(if sub.is_empty() { dir.to_path_buf() } else { dir.join(sub) }) {
            Ok(r) => r,
            // No outputs folder, or a subfolder removed meanwhile: left out.
            Err(e) if sub.is_empty() || e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        for e in rd.flatten() {
            let Ok(name) = e.file_name().into_string() else { continue };
            let rel = if sub.is_empty() { name.clone() } else { format!("{sub}/{name}") };
            let Ok(st) = std::fs::symlink_metadata(dir.join(&rel)) else { continue };
            if st.is_dir() {
                if !SKIPPED_OUTPUT_DIRS.contains(&name.as_str()) {
                    walk(dir, &rel, found)?;
                }
            } else if st.is_file() {
                let at = st.modified().map(ckanban_core::time::system_ms).unwrap_or(0.0).floor();
                found.push((rel, st.len(), at));
            }
        }
        Ok(())
    }
    walk(dir, "", &mut found)?;
    // Stable, newest first, like Bun's sort by time.
    found.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal));
    found.truncate(MAX_OUTPUT_FILES);
    Ok(found.into_iter().map(|(name, size, at)| json!({ "name": name, "size": size, "updatedAt": ckanban_core::time::iso(at) })).collect())
}

/// `store.outputPath`: an output file by name, None when it is missing, not a file or outside the outputs folder.
pub fn output_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let file = normalize(&dir.join(name));
    let mut prefix = dir.as_os_str().to_owned();
    prefix.push("/");
    if !file.as_os_str().to_string_lossy().starts_with(&*prefix.to_string_lossy()) {
        return None;
    }
    std::fs::metadata(&file).ok().filter(|m| m.is_file()).map(|_| file)
}

/// `OUTPUT_IMAGE_TYPES`: raster images get their real type so the Outputs tab can preview them.
pub fn image_type(file: &Path) -> Option<&'static str> {
    let name = file.to_string_lossy();
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_else(|| name.to_lowercase());
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// `rawFile`'s headers: plain text in a sandbox (files Claude wrote must never run as HTML on this origin), raster
/// images as themselves, and a download name when asked.
pub fn raw_headers(file: &Path, download: bool) -> Vec<(&'static str, String)> {
    let mut h = vec![
        ("content-type", image_type(file).unwrap_or("text/plain; charset=utf-8").to_string()),
        ("x-content-type-options", "nosniff".into()),
        ("content-security-policy", "sandbox".into()),
    ];
    if download {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        h.push(("content-disposition", super::share::attachment_header(&name)));
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn resolve_inside_refuses_escapes() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("root");
        write(&root, "a/b.txt", "x");
        write(t.path(), "secret.txt", "s");
        std::os::unix::fs::symlink(t.path().join("secret.txt"), root.join("link")).unwrap();
        assert!(resolve_inside(&root, "a/b.txt").unwrap().ends_with("a/b.txt"));
        assert!(resolve_inside(&root, "/a/b.txt").is_ok(), "a leading slash stays inside");
        assert_eq!(resolve_inside(&root, "../secret.txt").unwrap_err(), ferr(400, "path must not contain .."));
        assert_eq!(resolve_inside(&root, "a\0").unwrap_err().status, 400);
        assert_eq!(resolve_inside(&root, "nope").unwrap_err(), ferr(404, "not found"));
        assert_eq!(resolve_inside(&root, "link").unwrap_err(), ferr(403, "path is outside the board folder"));
        assert_eq!(resolve_inside(&t.path().join("gone"), "x").unwrap_err(), ferr(404, "board folder not found"));
    }

    #[test]
    fn lists_folders_first_without_git_and_ignored() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("r");
        fs::create_dir_all(&root).unwrap();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(&root).status().unwrap();
        write(&root, ".gitignore", "secret.env\nbuild/\n");
        write(&root, "secret.env", "");
        write(&root, "build/x", "");
        write(&root, "b.txt", "");
        write(&root, "A.txt", "");
        write(&root, "src/main.rs", "");
        write(&root, "_x", "");
        let names: Vec<String> = list_dir(&root, "").unwrap().iter().map(|e| e["path"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["src", "_x", ".gitignore", "A.txt", "b.txt"]);
        assert_eq!(list_dir(&root, "src").unwrap(), vec![json!({ "name": "main.rs", "path": "src/main.rs", "type": "file" })]);
        assert_eq!(list_dir(&root, "b.txt").unwrap_err().status, 400);
        let (page, more) = list_dir_page(&root, "").unwrap();
        assert_eq!((page.len(), more), (5, 0));
    }

    #[test]
    fn locale_order() {
        // Bun 1.4's `.sort((a, b) => a.localeCompare(b))` of the same names.
        let want = [
            "_x", "_z", "-a", ".gitignore", "#x", "~t", "$y", "10", "2", "a", "A", "ä", "a b", "a_b", "a-b", "a.b", "A.txt", "b", "B", "b.txt", "é",
            "readme.md", "README.md", "x1", "x10", "x2", "zeta", "Zeta",
        ];
        let mut v = want.to_vec();
        v.reverse();
        v.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(v, want);
    }

    #[test]
    fn reads_files_for_view() {
        let t = tempfile::tempdir().unwrap();
        write(t.path(), "t.txt", "héllo");
        fs::write(t.path().join("bin"), [1u8, 0, 2]).unwrap();
        assert_eq!(read_file_for_view(t.path(), "t.txt").unwrap(), json!({ "path": "t.txt", "size": 6, "content": "héllo", "binary": false, "tooLarge": false }));
        assert_eq!(read_file_for_view(t.path(), "bin").unwrap()["binary"], true);
        let big = fs::File::create(t.path().join("big")).unwrap();
        big.set_len(MAX_VIEW_BYTES + 1).unwrap();
        assert_eq!(read_file_for_view(t.path(), "big").unwrap()["tooLarge"], true);
        assert_eq!(read_file_for_view(t.path(), "").unwrap_err(), ferr(400, "not a file"));
    }

    #[test]
    fn finds_files_in_roots() {
        let t = tempfile::tempdir().unwrap();
        let (copy, project, outputs) = (t.path().join("copy"), t.path().join("project"), t.path().join("out"));
        write(&copy, "src/a.ts", "");
        write(&project, "src/a.ts", "");
        write(&project, "only.md", "");
        write(&outputs, "report.md", "");
        write(t.path(), "outside.txt", "");
        let profile = json!({ "path": project });
        let ticket = json!({ "worktree": copy, "results": [{ "report": outputs.join("report.md") }, { "report": null }] });
        let roots = file_roots(&profile, &ticket, &outputs);
        assert_eq!(roots.iter().map(|r| r.name).collect::<Vec<_>>(), ["ticket", "project", "outputs", "outputs"]);
        let home = t.path();
        let f = find_in_roots(&roots, "src/a.ts", home).unwrap();
        assert_eq!((f.root, f.rel.as_str()), ("ticket", "src/a.ts"));
        assert_eq!(find_in_roots(&roots, "./only.md", home).unwrap().root, "project");
        assert_eq!(find_in_roots(&roots, &outputs.join("report.md").to_string_lossy(), home).unwrap().root, "outputs");
        assert_eq!(find_in_roots(&roots, "~/out/report.md", home).unwrap().rel, "report.md");
        assert!(find_in_roots(&roots, &t.path().join("outside.txt").to_string_lossy(), home).is_none());
        assert!(find_in_roots(&roots, "../outside.txt", home).is_none());
        assert!(find_in_roots(&roots, "src", home).is_none());
        // A ticket working in the project folder has no copy of its own.
        let inplace = file_roots(&profile, &json!({ "workdir": format!("{}/", project.display()) }), &outputs);
        assert_eq!(inplace[0].name, "project");
    }

    #[test]
    fn outputs_listing_and_paths() {
        let t = tempfile::tempdir().unwrap();
        let out = t.path().join("outputs");
        write(&out, "a.md", "aa");
        write(&out, "sub/b.png", "b");
        write(&out, "node_modules/x.js", "");
        std::os::unix::fs::symlink(t.path(), out.join("loop")).unwrap();
        let list = list_outputs(&out).unwrap();
        let mut names: Vec<&str> = list.iter().map(|v| v["name"].as_str().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["a.md", "sub/b.png"]);
        assert!(list[0]["updatedAt"].as_str().unwrap().ends_with('Z'));
        assert!(list_outputs(&t.path().join("none")).unwrap().is_empty());
        assert!(output_path(&out, "sub/b.png").is_some());
        assert!(output_path(&out, "../outputs/a.md").is_some());
        assert!(output_path(&out, "../x").is_none());
        assert!(output_path(&out, "sub").is_none());
        assert_eq!(raw_headers(Path::new("/x/p.PNG"), false)[0].1, "image/png");
        let h = raw_headers(Path::new("/x/page.svg"), true);
        assert_eq!(h[0].1, "text/plain; charset=utf-8");
        assert_eq!(h[3].1, "attachment; filename=\"page.svg\"; filename*=UTF-8''page.svg");
    }
}
