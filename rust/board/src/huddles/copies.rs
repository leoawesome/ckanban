//! Hand-ins from a helper's own copy of the folder (`handIn`, `accept` and what they use in
//! `src/huddle/huddle-copies.ts`). Making and removing the copies is R11c's; this reads the base the copy was made
//! from (`<copy>.copy.json`), saves what changed under `<copy>.handins/<id>/`, and brings it into the host's folder,
//! all or nothing, a file the host's folder also changed being a conflict.
//!
//! Blocking file work: callers run it on the blocking pool.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

/// Folders a plain copy leaves out (`COPY_SKIP`).
pub const COPY_SKIP: [&str; 9] = [".git", "node_modules", ".DS_Store", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".cache"];

/// Path -> sha1 of the file's bytes.
pub type Manifest = BTreeMap<String, String>;

pub struct CopyState {
    pub base: Manifest,
    pub handed: Option<Manifest>,
}

pub(super) fn hash_bytes(b: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

fn hash_file(file: &Path) -> Option<String> {
    let m = fs::symlink_metadata(file).ok()?;
    if !m.is_file() {
        return None;
    }
    fs::read(file).ok().map(|b| hash_bytes(&b))
}

fn walk(dir: &Path) -> Vec<String> {
    fn go(root: &Path, d: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if COPY_SKIP.contains(&name.as_str()) {
                continue;
            }
            let f = e.path();
            let Ok(m) = fs::symlink_metadata(&f) else { continue };
            if m.is_dir() {
                go(root, &f, out);
            } else if m.is_file()
                && let Ok(rel) = f.strip_prefix(root)
            {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    go(dir, dir, &mut out);
    out.sort();
    out
}

fn list_files(dir: &Path, kind: &str) -> Result<Vec<String>, String> {
    if kind == "folder" {
        return Ok(walk(dir));
    }
    let r = std::process::Command::new("git")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("couldn't list the files of {}: {e}", dir.display()))?;
    if !r.status.success() {
        return Err(format!("couldn't list the files of {}: {}", dir.display(), String::from_utf8_lossy(&r.stderr).trim()));
    }
    let mut v: Vec<String> = String::from_utf8_lossy(&r.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
    v.sort();
    v.dedup();
    Ok(v)
}

pub fn scan(dir: &Path, kind: &str) -> Result<Manifest, String> {
    let mut out = Manifest::new();
    for f in list_files(dir, kind)? {
        if let Some(h) = hash_file(&dir.join(&f)) {
            out.insert(f, h);
        }
    }
    Ok(out)
}

/// `changes`: the files that differ, as a hand-in lists them, by path.
pub fn changes(base: &Manifest, now: &Manifest) -> Vec<Map<String, Value>> {
    let mut out: Vec<(String, Map<String, Value>)> = Vec::new();
    for (path, hash) in now {
        if base.get(path) == Some(hash) {
            continue;
        }
        let was = base.get(path);
        let v = json!({ "path": path, "change": if was.is_some() { "changed" } else { "added" }, "base": was, "hash": hash });
        out.push((path.clone(), v.as_object().cloned().unwrap_or_default()));
    }
    for (path, hash) in base {
        if !now.contains_key(path) {
            let v = json!({ "path": path, "change": "removed", "base": hash, "hash": null });
            out.push((path.clone(), v.as_object().cloned().unwrap_or_default()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, v)| v).collect()
}

pub fn state_file(copy: &str) -> PathBuf {
    PathBuf::from(format!("{copy}.copy.json"))
}
/// `handInDir`.
pub fn hand_in_dir(copy: &str, id: &str) -> PathBuf {
    PathBuf::from(format!("{copy}.handins")).join(id)
}

fn manifest(v: Option<&Value>) -> Option<Manifest> {
    let m = v?.as_object()?;
    Some(m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
}

pub fn read_state(copy: &str) -> Option<CopyState> {
    let v: Value = serde_json::from_str(&fs::read_to_string(state_file(copy)).ok()?).ok()?;
    let base = manifest(v.get("base"))?;
    Some(CopyState { base, handed: manifest(v.get("handed")) })
}

pub fn write_state(copy: &str, st: &CopyState) -> std::io::Result<()> {
    if let Some(parent) = Path::new(copy).parent() {
        fs::create_dir_all(parent)?;
    }
    let v = json!({ "base": st.base, "handed": st.handed });
    fs::write(state_file(copy), serde_json::to_string(&v).unwrap_or_default())
}

/// `BAD_NAME`: control characters and line separators.
pub(super) fn bad_name(p: &str) -> bool {
    p.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f || c == '\u{2028}' || c == '\u{2029}')
}

/// `plainPath`: nothing on the way is a symlink or a file, and the file itself is a plain file or nothing.
pub(super) fn plain_path(root: &Path, path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let mut cur = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        cur = cur.join(part);
        let Ok(m) = fs::symlink_metadata(&cur) else { return true };
        let ok = if i < parts.len() - 1 { m.is_dir() && !m.file_type().is_symlink() } else { m.is_file() };
        if !ok {
            return false;
        }
    }
    true
}

/// `inside`: a hand-in path that stays under `root`.
fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let escapes = p.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)));
    if path.is_empty() || path.starts_with('/') || bad_name(path) || escapes {
        return Err(format!("unsafe path in a hand-in: {}", serde_json::to_string(path).unwrap_or_default()));
    }
    Ok(root.join(p))
}

/// `handIn`: what changed in the copy, saved aside under `id`; empty when nothing changed.
pub fn hand_in(copy: &str, kind: &str, id: &str) -> Result<Vec<Map<String, Value>>, String> {
    let st = read_state(copy).ok_or_else(|| "the board lost track of this copy of the folder".to_string())?;
    let root = Path::new(copy);
    let mut now = scan(root, kind)?;
    now.retain(|f, _| !bad_name(f) && plain_path(root, f));
    let mut files: Vec<Map<String, Value>> = changes(&st.base, &now).into_iter().filter(|f| !bad_name(f["path"].as_str().unwrap_or(""))).collect();
    if files.is_empty() {
        return Ok(files);
    }
    let dir = hand_in_dir(copy, id);
    let _ = fs::remove_dir_all(&dir);
    for f in files.iter_mut() {
        if f["hash"].is_null() {
            continue;
        }
        let path = f["path"].as_str().unwrap_or("").to_string();
        let bytes = fs::read(root.join(&path)).map_err(|e| e.to_string())?;
        f.insert("hash".into(), Value::from(hash_bytes(&bytes)));
        let dest = dir.join(&path);
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    write_state(copy, &CopyState { base: st.base, handed: Some(now) }).map_err(|e| e.to_string())?;
    Ok(files)
}

/// `accept`: brings a hand-in into the host folder; with any conflict nothing is written. Ok(conflicts).
pub fn accept(host: &Path, copy: &str, id: &str, files: &[Value]) -> Result<Vec<String>, String> {
    let stash = hand_in_dir(copy, id);
    let fs_of = |f: &Value, k: &str| f.get(k).and_then(Value::as_str).map(str::to_string);
    let mut conflicts = Vec::new();
    for f in files {
        let path = fs_of(f, "path").unwrap_or_default();
        let file = inside(host, &path)?;
        if !plain_path(host, &path) {
            conflicts.push(path);
            continue;
        }
        let cur = hash_file(&file);
        if cur != fs_of(f, "base") && cur != fs_of(f, "hash") {
            conflicts.push(path);
        }
    }
    if !conflicts.is_empty() {
        return Ok(conflicts);
    }
    let mut done: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
    let res = (|| -> Result<(), String> {
        for f in files {
            let path = fs_of(f, "path").unwrap_or_default();
            let file = inside(host, &path)?;
            let before = if file.exists() { fs::read(&file).ok() } else { None };
            if let Some(hash) = fs_of(f, "hash") {
                let bytes = fs::read(inside(&stash, &path)?).map_err(|e| e.to_string())?;
                if hash_bytes(&bytes) != hash {
                    return Err(format!("the handed-in {path} changed after the hand-in"));
                }
                if let Some(p) = file.parent() {
                    fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                done.push((file.clone(), before));
                fs::write(&file, &bytes).map_err(|e| e.to_string())?;
            } else if before.is_some() {
                done.push((file.clone(), before));
                fs::remove_file(&file).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    if let Err(e) = res {
        for (file, before) in done.into_iter().rev() {
            let _ = match before {
                Some(b) => fs::write(&file, b),
                None => fs::remove_file(&file),
            };
        }
        return Err(e);
    }
    // Later hand-ins count from what the host folder now has.
    if let Some(mut st) = read_state(copy) {
        for f in files {
            let path = fs_of(f, "path").unwrap_or_default();
            match fs_of(f, "hash") {
                Some(h) => st.base.insert(path, h),
                None => st.base.remove(&path),
            };
        }
        let _ = write_state(copy, &st);
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hand_in_then_accept_into_a_plain_folder() {
        let d = tempfile::tempdir().unwrap();
        let host = d.path().join("host");
        let copy = d.path().join("copy");
        fs::create_dir_all(&host).unwrap();
        fs::create_dir_all(&copy).unwrap();
        fs::write(host.join("a.txt"), "a").unwrap();
        fs::write(copy.join("a.txt"), "a").unwrap();
        let c = copy.to_string_lossy().to_string();
        write_state(&c, &CopyState { base: scan(&copy, "folder").unwrap(), handed: None }).unwrap();
        assert!(hand_in(&c, "folder", "c1").unwrap().is_empty());
        fs::write(copy.join("b.txt"), "b").unwrap();
        fs::remove_file(copy.join("a.txt")).unwrap();
        let files = hand_in(&c, "folder", "c1").unwrap();
        assert_eq!(files.iter().map(|f| (f["path"].as_str().unwrap(), f["change"].as_str().unwrap())).collect::<Vec<_>>(), [("a.txt", "removed"), ("b.txt", "added")]);
        let vals: Vec<Value> = files.into_iter().map(Value::Object).collect();
        assert!(accept(&host, &c, "c1", &vals).unwrap().is_empty());
        assert_eq!(fs::read_to_string(host.join("b.txt")).unwrap(), "b");
        assert!(!host.join("a.txt").exists());
        // A conflict writes nothing.
        fs::write(copy.join("b.txt"), "b2").unwrap();
        fs::write(host.join("b.txt"), "theirs").unwrap();
        let vals: Vec<Value> = hand_in(&c, "folder", "c2").unwrap().into_iter().map(Value::Object).collect();
        assert_eq!(accept(&host, &c, "c2", &vals).unwrap(), ["b.txt"]);
        assert_eq!(fs::read_to_string(host.join("b.txt")).unwrap(), "theirs");
        assert!(inside(&host, "../x").is_err());
    }
}
