//! `remote.json` as `RemoteAccess` in `src/integrations/remote.ts` reads it for the request check: `config()` re-read
//! when the file changes (a stat per call), `active()` only while phone access is on. Rust only reads it; turning
//! phone access on and off (Tailscale) stays with the Bun satellite until P2.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde_json::Value;

use super::request::RemoteConfig;
use crate::runs::js;

pub const REMOTE_FILE: &str = "remote.json";

type Stamp = (Option<SystemTime>, u64);

pub struct RemoteFile {
    file: PathBuf,
    cache: Mutex<Option<(Stamp, Option<RemoteConfig>)>>,
}

impl RemoteFile {
    pub fn new(root: &Path) -> Self {
        RemoteFile { file: root.join(REMOTE_FILE), cache: Mutex::new(None) }
    }

    /// `config()`: the saved settings; None when never set up or unreadable.
    pub fn config(&self) -> Option<RemoteConfig> {
        let Ok(meta) = std::fs::metadata(&self.file) else {
            *self.cache.lock() = None;
            return None;
        };
        let stamp = (meta.modified().ok(), meta.len());
        if let Some((s, c)) = &*self.cache.lock()
            && *s == stamp
        {
            return c.clone();
        }
        let config = std::fs::read_to_string(&self.file).ok().and_then(|t| js::parse(&t)).and_then(|v| parse(&v));
        *self.cache.lock() = Some((stamp, config.clone()));
        config
    }

    /// `active()`: the settings while phone access is on (enabled, with a host and a login).
    pub fn active(&self) -> Option<RemoteConfig> {
        self.config().filter(|c| c.enabled && !c.host.is_empty() && !c.allowed_login.is_empty())
    }
}

/// `raw && typeof raw.host === "string" && typeof raw.allowedLogin === "string"`, then the fields as Bun keeps them.
fn parse(raw: &Value) -> Option<RemoteConfig> {
    let host = raw.get("host")?.as_str()?;
    let login = raw.get("allowedLogin")?.as_str()?;
    Some(RemoteConfig {
        enabled: raw.get("enabled") == Some(&Value::Bool(true)),
        host: host.to_string(),
        allowed_login: login.to_string(),
        updated_at: match raw.get("updatedAt") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => js::to_string(v),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_rereads_on_change() {
        let dir = std::env::temp_dir().join(format!("ck-remote-{}-{}", std::process::id(), ckanban_core::time::now_ms() as u64));
        std::fs::create_dir_all(&dir).unwrap();
        let f = RemoteFile::new(&dir);
        assert_eq!(f.config(), None);
        std::fs::write(dir.join(REMOTE_FILE), r#"{"enabled":true,"host":"h.ts.net","allowedLogin":"a@b"}"#).unwrap();
        assert_eq!(f.active().map(|c| c.host), Some("h.ts.net".to_string()));
        std::fs::write(dir.join(REMOTE_FILE), r#"{"enabled":false,"host":"h.ts.net","allowedLogin":"a@b","updatedAt":"x"}"#).unwrap();
        assert!(f.active().is_none());
        assert_eq!(f.config().map(|c| c.updated_at), Some("x".to_string()));
        std::fs::write(dir.join(REMOTE_FILE), r#"{"enabled":"yes","host":"h","allowedLogin":"a"}"#).unwrap();
        assert!(f.active().is_none());
        std::fs::write(dir.join(REMOTE_FILE), r#"{"enabled":true,"host":1,"allowedLogin":"a"}"#).unwrap();
        assert_eq!(f.config(), None);
        std::fs::write(dir.join(REMOTE_FILE), "not json").unwrap();
        assert_eq!(f.config(), None);
        std::fs::remove_file(dir.join(REMOTE_FILE)).unwrap();
        assert_eq!(f.config(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
