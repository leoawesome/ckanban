//! Which version each model alias (opus, fable, sonnet, haiku) means today, learned from real runs
//! (`src/runs/model-versions.ts`, with `familyVersion`, `newerVersion` and `KNOWN_VERSIONS` of `web/src/lib/models.ts`).
//! Every run's `system/init` event names its full model id; the newest seen per family is kept and saved in
//! `<data>/model-versions.json`.

use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::js;

/// The built-in table (`KNOWN_VERSIONS`).
pub const KNOWN_VERSIONS: [(&str, &str); 4] = [("opus", "5.5"), ("fable", "5.2"), ("sonnet", "5.5"), ("haiku", "5.5")];

const FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];

/// `familyVersion`: "claude-fable-5-2[1m]" → ("fable", "5.2"); "claude-haiku-4-5-20251001" → ("haiku", "4.5").
pub fn family_version(id: &str) -> Option<(String, String)> {
    // /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/i, by hand (no lookahead in Rust's regex).
    let s = js::trim(id);
    let b = s.as_bytes();
    let ends_ok = |i: usize| i == b.len() || b[i] == b'-' || b[i] == b'[';
    let digits = |i: usize| b[i.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    for start in 0..b.len() {
        if !b[start..].get(..7).is_some_and(|p| p.eq_ignore_ascii_case(b"claude-")) {
            continue;
        }
        let at = start + 7;
        for fam in FAMILIES {
            let end = at + fam.len();
            if !b.get(at..end).is_some_and(|p| p.eq_ignore_ascii_case(fam.as_bytes())) || b.get(end) != Some(&b'-') {
                continue;
            }
            let d0 = end + 1;
            let n = digits(d0);
            if n == 0 {
                continue;
            }
            // \d+ backtracks, but only the longest run can be followed by "-" or the end.
            let major_end = d0 + n;
            if b.get(major_end) == Some(&b'-') {
                let m = digits(major_end + 1);
                for j in (1..=m.min(2)).rev() {
                    if ends_ok(major_end + 1 + j) {
                        return Some((fam.to_string(), format!("{}.{}", &s[d0..major_end], &s[major_end + 1..major_end + 1 + j])));
                    }
                }
            }
            if ends_ok(major_end) {
                return Some((fam.to_string(), s[d0..major_end].to_string()));
            }
        }
    }
    None
}

/// `newerVersion`: a is newer than b ("5.10" > "5.9").
pub fn newer_version(a: &str, b: &str) -> bool {
    let x: Vec<f64> = a.split('.').map(js::number_of_str).collect();
    let y: Vec<f64> = b.split('.').map(js::number_of_str).collect();
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (x.get(i).copied().unwrap_or(0.0), y.get(i).copied().unwrap_or(0.0));
        // NaN !== NaN in JS: a part that isn't a number decides, and it is never "newer".
        if p != q || p.is_nan() {
            return p > q;
        }
    }
    false
}

fn is_version(v: &str) -> bool {
    !v.is_empty() && v.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}

/// The learned versions and where they are saved (Bun keeps them in module globals; one of these per daemon).
pub struct ModelVersions {
    file: Option<PathBuf>,
    /// family → version, in the order JS keeps the object's keys.
    versions: Mutex<Option<Vec<(String, String)>>>,
}

impl ModelVersions {
    /// `useModelVersionsFile`: `<data>/model-versions.json`, or None to keep them in memory only.
    pub fn new(file: Option<PathBuf>) -> Self {
        ModelVersions { file, versions: Mutex::new(None) }
    }

    fn load(&self) -> Vec<(String, String)> {
        let saved = self
            .file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| js::parse(&t))
            .and_then(|v| v.get("versions").cloned());
        let mut out = Vec::new();
        if let Some(Value::Object(m)) = saved {
            for (k, v) in m {
                if let Some(v) = v.as_str().filter(|v| is_version(v)) {
                    out.push((k, v.to_string()));
                }
            }
        }
        out
    }

    /// `learnedVersions`: family → newest version seen in a run, in the order they were learned.
    pub fn learned(&self) -> Map<String, Value> {
        let mut g = self.versions.lock();
        g.get_or_insert_with(|| self.load()).iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()
    }

    /// `learnModel`: an init event's model teaches its family's version when it is newer than the one known (learned,
    /// else built in), so a run on an old pinned id never lowers a label. True when it learned something.
    pub fn learn(&self, ev: &Value) -> bool {
        if ev.get("type").and_then(Value::as_str) != Some("system") || ev.get("subtype").and_then(Value::as_str) != Some("init") {
            return false;
        }
        let Some((family, version)) = ev.get("model").and_then(Value::as_str).and_then(family_version) else { return false };
        let saved = {
            let mut g = self.versions.lock();
            let now = g.get_or_insert_with(|| self.load());
            let known = now
                .iter()
                .find(|(k, _)| *k == family)
                .map(|(_, v)| v.clone())
                .or_else(|| KNOWN_VERSIONS.iter().find(|(k, _)| *k == family).map(|(_, v)| v.to_string()));
            if known.is_some_and(|k| !newer_version(&version, &k)) {
                return false;
            }
            match now.iter_mut().find(|(k, _)| *k == family) {
                Some(e) => e.1 = version,
                None => now.push((family, version)),
            }
            now.clone()
        };
        if let Some(f) = &self.file {
            let m: Map<String, Value> = saved.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
            let text = serde_json::to_string_pretty(&serde_json::json!({ "versions": m })).unwrap_or_default();
            if let Err(e) = ckanban_core::atomic::atomic_write(f, text) {
                eprintln!("couldn't save model versions {e}");
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_versions() {
        assert_eq!(family_version("claude-fable-5-2[1m]"), Some(("fable".into(), "5.2".into())));
        assert_eq!(family_version("claude-haiku-4-5-20251001"), Some(("haiku".into(), "4.5".into())));
        assert_eq!(family_version("claude-fable-5-123"), Some(("fable".into(), "5".into())));
        assert_eq!(family_version("claude-opus-45x"), None);
        assert_eq!(family_version("Claude-OPUS-4"), Some(("opus".into(), "4".into())));
        assert!(newer_version("5.10", "5.9"));
        assert!(!newer_version("5.2", "5.2"));
    }
}
