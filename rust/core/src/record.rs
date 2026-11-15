//! A JSON record read from the data folder and written back without losing anything: fields this code doesn't know
//! (written by a newer Bun daemon, or by hand) stay, in their place. Bun gets this for free from `JSON.parse` +
//! spread; here the record is the parsed object itself and typed code reads fields from it.

use crate::atomic::atomic_write;
use serde_json::{Map, Value};
use std::io;
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsonRecord(pub Map<String, Value>);

impl JsonRecord {
    /// Ok(None) when the file is missing or isn't a JSON object; Err for other read errors.
    pub fn read(file: &Path) -> io::Result<Option<Self>> {
        let text = match std::fs::read_to_string(file) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        Ok(match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => Some(Self(crate::jsnum::normalize_map(m))),
            _ => None,
        })
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }
    /// Sets a field; an existing one keeps its place, a new one goes last (like a JS assignment).
    pub fn set(&mut self, key: &str, v: Value) {
        self.0.insert(key.to_string(), v);
    }

    /// `JSON.stringify(record, null, 2) + "\n"`, written atomically.
    pub fn write_pretty(&self, file: &Path) -> io::Result<()> {
        let mut s = serde_json::to_string_pretty(&self.0).map_err(io::Error::other)?;
        s.push('\n');
        atomic_write(file, s)
    }

    /// `JSON.stringify(record)` (compact, no final newline), written atomically.
    pub fn write_compact(&self, file: &Path) -> io::Result<()> {
        atomic_write(file, serde_json::to_string(&self.0).map_err(io::Error::other)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::{DataDir, Profile};

    #[test]
    fn unknown_fields_survive_a_rewrite() {
        let root = std::env::temp_dir().join(format!("ckrs-record-{}", crate::atomic::new_id()));
        let dir = DataDir::new(&root);
        let file = dir.profile_dir("demo").join("profile.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // As Bun writes it (pretty, 2 spaces, final newline), with fields this crate knows nothing about.
        let original = "{\n  \"slug\": \"demo\",\n  \"futureThing\": {\n    \"deep\": [\n      1,\n      2.5\n    ]\n  },\n  \"name\": \"Demo\",\n  \"createdAt\": \"2026-11-01T00:00:00.000Z\",\n  \"zLast\": null\n}\n";
        std::fs::write(&file, original).unwrap();

        let p = dir.profile("demo").unwrap();
        p.save(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);

        let mut p = Profile { record: p.record };
        p.record.set("name", "Renamed".into());
        p.save(&dir).unwrap();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back["futureThing"]["deep"][1], serde_json::json!(2.5));
        assert_eq!(back["zLast"], Value::Null);
        assert_eq!(back["name"], "Renamed");
        let keys: Vec<_> = back.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["slug", "futureThing", "name", "createdAt", "zLast"]);
        let _ = std::fs::remove_dir_all(root);
    }
}
