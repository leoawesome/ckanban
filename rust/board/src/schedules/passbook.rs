//! What automations read of the board's passes (`automation-passes.json`, `src/integrations/passes.ts`): a pass by id
//! or name, its status and kind, and the keys a check script gets as environment variables. Read again on every use,
//! as Bun's `Passes.list()` does; the front server and the satellite write the file (under its lock). A tool call
//! through a pass is the satellite's (`pass-call`, it holds the sign-ins).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};

pub const PASSES_FILE: &str = "automation-passes.json";

/// `maskText` with the passes' secrets (set by the server; tests keep the text as it is).
pub type Mask = Arc<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Clone)]
pub struct PassBook {
    file: PathBuf,
    pub mask: Mask,
}

fn s<'a>(p: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

impl PassBook {
    pub fn new(root: &Path, mask: Mask) -> Self {
        PassBook { file: root.join(PASSES_FILE), mask }
    }

    /// Every pass (`read()`: an unreadable file is no passes).
    pub fn list(&self) -> Vec<Map<String, Value>> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|t| serde_json::from_slice::<Value>(&t).ok())
            .and_then(|v| v.get("passes").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| match p {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Map<String, Value>> {
        self.list().into_iter().find(|p| s(p, "id") == Some(id))
    }

    /// `find(ref, among, board)`: by id, Claude server name, display name or key name (any case); with `board`,
    /// another board's keys are left out.
    pub fn find(&self, r: &str, among: Option<&[String]>, board: Option<&str>) -> Option<Map<String, Value>> {
        let low = crate::runs::js::trim(r).to_lowercase();
        let list: Vec<_> = self
            .list()
            .into_iter()
            .filter(|p| among.is_none_or(|a| a.iter().any(|x| Some(x.as_str()) == s(p, "id"))))
            .filter(|p| board.is_none_or(|b| !crate::runs::js::truthy(p.get("board")) || s(p, "board") == Some(b)))
            .collect();
        let by = |k: &str| list.iter().find(|p| s(p, k).is_some_and(|v| v.to_lowercase() == low)).cloned();
        list.iter().find(|p| s(p, "id") == Some(r)).cloned().or_else(|| by("claudeName")).or_else(|| by("name")).or_else(|| by("envName"))
    }

    /// `envFor(ids, board)`: the keys meant for scripts among these passes.
    pub fn env_for(&self, ids: &[String], board: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for p in self.list() {
            if crate::runs::js::truthy(p.get("board")) && s(&p, "board") != Some(board) {
                continue;
            }
            let id = s(&p, "id").unwrap_or("");
            if !ids.iter().any(|x| x == id) || s(&p, "kind") != Some("key") || crate::runs::js::truthy(p.get("url")) {
                continue;
            }
            let (Some(name), Some(secret)) = (s(&p, "envName").filter(|n| !n.is_empty()), s(&p, "secret").filter(|v| !v.is_empty())) else { continue };
            match out.iter_mut().find(|(k, _)| k == name) {
                Some(e) => e.1 = secret.to_string(),
                None => out.push((name.to_string(), secret.to_string())),
            }
        }
        out
    }

    pub fn mask(&self, text: &str) -> String {
        (self.mask)(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_and_env() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join(PASSES_FILE),
            r#"{"version":1,"passes":[{"id":"p1","kind":"key","name":"Linear","claudeName":null,"envName":"LIN_KEY","secret":"s3cret!","status":"connected"},{"id":"p2","kind":"key","name":"Other","envName":"O_KEY","secret":"x","board":"b2","status":"connected"}]}"#,
        )
        .unwrap();
        let b = PassBook::new(d.path(), Arc::new(|t: &str| t.to_string()));
        assert_eq!(b.find("linear", None, None).and_then(|p| p.get("id").cloned()), Some(Value::from("p1")));
        assert!(b.find("Other", None, Some("b1")).is_none());
        assert_eq!(b.env_for(&["p1".into(), "p2".into()], "b1"), vec![("LIN_KEY".to_string(), "s3cret!".to_string())]);
    }
}
