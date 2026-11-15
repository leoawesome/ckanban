//! The data folder (`defaultRoot()` in `src/core/store.ts`) and the paths the usage and spend routes read, laid out
//! as `contracts/data-files.md` describes them.

use crate::record::JsonRecord;
use std::ffi::CStr;
use std::io;
use std::path::PathBuf;

/// The OS user's home and name from the password database (Node's `os.homedir()` / `os.userInfo()`).
fn passwd() -> Option<(PathBuf, String)> {
    // SAFETY: getpwuid_r with a buffer we own; the strings are copied out before the buffer goes.
    unsafe {
        let mut pw: libc::passwd = std::mem::zeroed();
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let mut buf = vec![0 as libc::c_char; 4096];
        let rc = libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr(), buf.len(), &mut out);
        if rc != 0 || out.is_null() {
            return None;
        }
        let dir = if pw.pw_dir.is_null() { String::new() } else { CStr::from_ptr(pw.pw_dir).to_string_lossy().into_owned() };
        let name = if pw.pw_name.is_null() { String::new() } else { CStr::from_ptr(pw.pw_name).to_string_lossy().into_owned() };
        Some((PathBuf::from(dir), name))
    }
}

/// `os.homedir()`: $HOME, else the password database.
pub fn home_dir() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => passwd().map(|p| p.0).unwrap_or_default(),
    }
}

/// `userInfo().username || $USER`.
pub fn user_name() -> Option<String> {
    passwd().map(|p| p.1).filter(|n| !n.is_empty()).or_else(|| std::env::var("USER").ok().filter(|u| !u.is_empty()))
}

/// The data folder: `CKANBAN_HOME` when set (even empty, like `??`), else `~/.claude-kanban`.
#[derive(Clone, Debug)]
pub struct DataDir {
    pub root: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn from_env() -> Self {
        match std::env::var_os("CKANBAN_HOME") {
            Some(h) => Self::new(h),
            None => Self::new(home_dir().join(".claude-kanban")),
        }
    }

    pub fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }
    pub fn profile_dir(&self, slug: &str) -> PathBuf {
        self.profiles_dir().join(slug)
    }
    pub fn tickets_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("tickets")
    }
    pub fn ticket_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.tickets_dir(slug).join(id)
    }
    pub fn activity_path(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("activity.jsonl")
    }
    pub fn side_spend_path(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("side-spend.jsonl")
    }
    pub fn chats_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("chats")
    }
    pub fn usage_last(&self) -> PathBuf {
        self.root.join("usage-last.json")
    }
    pub fn usage_windows(&self) -> PathBuf {
        self.root.join("usage-windows.json")
    }
    pub fn spend_days(&self) -> PathBuf {
        self.root.join("spend-days.json")
    }
    pub fn helper_spend(&self) -> PathBuf {
        self.root.join("helper-spend.jsonl")
    }

    /// `Store.getProfile`: the board's `profile.json`, or None when missing, unreadable or not an object.
    pub fn profile(&self, slug: &str) -> Option<Profile> {
        JsonRecord::read(&self.profile_dir(slug).join("profile.json")).ok().flatten().map(|record| Profile { record })
    }

    /// `Store.listProfiles`: every readable board, oldest first (by `createdAt`). Errors when `profiles/` is missing,
    /// as Bun's readdirSync does.
    pub fn list_profiles(&self) -> io::Result<Vec<Profile>> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(self.profiles_dir())? {
            let name = e?.file_name();
            if let Some(p) = name.to_str().and_then(|s| self.profile(s)) {
                out.push(p);
            }
        }
        // Bun's localeCompare on ISO times orders them like a plain compare. A board without createdAt (Bun throws
        // there) sorts first.
        out.sort_by(|a, b| a.created_at().cmp(b.created_at()));
        Ok(out)
    }
}

/// A board's `profile.json`. Only the fields these routes read are typed; the rest is kept as is.
#[derive(Clone, Debug)]
pub struct Profile {
    pub record: JsonRecord,
}

impl Profile {
    pub fn slug(&self) -> Option<&str> {
        self.record.str("slug")
    }
    pub fn created_at(&self) -> &str {
        self.record.str("createdAt").unwrap_or("")
    }
    /// `p.name` as stored (normally a string).
    pub fn name(&self) -> serde_json::Value {
        self.record.get("name").cloned().unwrap_or(serde_json::Value::Null)
    }
    pub fn save(&self, dir: &DataDir) -> io::Result<()> {
        let slug = self.slug().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "profile without slug"))?;
        self.record.write_pretty(&dir.profile_dir(slug).join("profile.json"))
    }
}
