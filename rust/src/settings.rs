//! What `ckanban-rs dev` needs before it starts: the board's port, where Bun and the repo are, an internal port for
//! the Bun child and the secret it shares with it. Same env as the Bun daemon (`src/cli/daemon.ts`).

use std::env;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};

/// The Bun daemon's default port when neither CKANBAN_PORT nor the data folder's config.json sets one
/// (`DEFAULT_CONFIG` in `src/core/store.ts`).
pub const DEFAULT_PORT: u16 = 7777;

/// The data folder: CKANBAN_HOME, else ~/.claude-kanban (`defaultRoot` in `src/core/store.ts`).
pub fn data_root() -> PathBuf {
    match env::var_os("CKANBAN_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".claude-kanban"),
    }
}

#[derive(serde::Deserialize)]
struct Config {
    port: Option<u16>,
}

/// The board's port: CKANBAN_PORT, else `port` in config.json, else 7777 (as the Bun daemon decides it).
pub fn board_port(env_port: Option<&str>, config_json: Option<&str>) -> u16 {
    if let Some(p) = env_port.and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p > 0) {
        return p;
    }
    config_json
        .and_then(|s| serde_json::from_str::<Config>(s).ok())
        .and_then(|c| c.port)
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT)
}

/// The phone access port the Bun child will open itself (`remoteListenPort` in `src/integrations/remote.ts`), so the
/// internal port never takes it.
pub fn remote_port(board: u16, env_remote: Option<&str>, config_json: Option<&str>) -> u16 {
    #[derive(serde::Deserialize)]
    struct Remote {
        #[serde(rename = "remotePort")]
        remote_port: Option<u16>,
    }
    env_remote
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .or_else(|| config_json.and_then(|s| serde_json::from_str::<Remote>(s).ok()).and_then(|c| c.remote_port).filter(|p| *p > 0))
        .unwrap_or(board.wrapping_add(1))
}

/// Bun: CKANBAN_BUN, else the Bun that started us (when our parent process is a `bun` binary), else `bun` on PATH,
/// else the usual install places.
pub fn bun_path() -> Result<PathBuf, String> {
    if let Some(b) = env::var_os("CKANBAN_BUN").filter(|b| !b.is_empty()) {
        return Ok(PathBuf::from(b));
    }
    if let Some(b) = parent_bun() {
        return Ok(b);
    }
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let c = dir.join("bun");
            if c.is_file() {
                return Ok(c);
            }
        }
    }
    let home = PathBuf::from(env::var_os("HOME").unwrap_or_default());
    for c in [home.join(".bun/bin/bun"), PathBuf::from("/opt/homebrew/bin/bun"), PathBuf::from("/usr/local/bin/bun")] {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("can't find bun: set CKANBAN_BUN or put bun on PATH".into())
}

/// The executable of our parent process, when it is Bun (e.g. `bun run test:contract:rust` started us).
fn parent_bun() -> Option<PathBuf> {
    let ppid = unsafe { libc::getppid() };
    if ppid <= 1 {
        return None;
    }
    let mut buf = vec![0u8; 4096];
    // SAFETY: buf is valid for buf.len() bytes; proc_pidpath writes at most that many and returns the length.
    let n = unsafe { proc_pidpath(ppid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let p = PathBuf::from(String::from_utf8_lossy(&buf[..n as usize]).into_owned());
    (p.file_name()? == "bun").then_some(p)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
}

#[cfg(not(target_os = "macos"))]
unsafe fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int {
    match std::fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(p) => {
            let b = p.as_os_str().as_encoded_bytes();
            let n = b.len().min(buffersize as usize);
            unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), buffer.cast(), n) };
            n as libc::c_int
        }
        Err(_) => -1,
    }
}

/// The repo root (the folder with `src/cli.ts`): CKANBAN_REPO, else the nearest folder above the binary that has it
/// (the binary sits in `rust/target/release/`).
pub fn repo_root(env_repo: Option<&Path>, exe: &Path) -> Result<PathBuf, String> {
    if let Some(r) = env_repo {
        return if r.join("src/cli.ts").is_file() { Ok(r.to_path_buf()) } else { Err(format!("CKANBAN_REPO {} has no src/cli.ts", r.display())) };
    }
    let exe = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
    exe.ancestors()
        .skip(1)
        .find(|d| d.join("src/cli.ts").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("can't find the ckanban repo above {}: set CKANBAN_REPO", exe.display()))
}

/// A free port on 127.0.0.1 for the Bun child, never one of `avoid` (the board's and phone access ports).
pub fn free_port(avoid: &[u16]) -> std::io::Result<u16> {
    for _ in 0..50 {
        let l = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        let p = l.local_addr()?.port();
        if !avoid.contains(&p) {
            return Ok(p);
        }
    }
    Err(std::io::Error::other("no free port"))
}

/// A fresh random secret (64 hex characters) for this start; the Bun child gets it on stdin (`src/core/front.ts`).
pub fn new_secret() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("no randomness for the secret: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_from_env_then_config_then_default() {
        assert_eq!(board_port(Some("4321"), Some(r#"{"port":5555}"#)), 4321);
        assert_eq!(board_port(None, Some(r#"{"port":5555,"prPollMinutes":5}"#)), 5555);
        assert_eq!(board_port(Some("nope"), None), DEFAULT_PORT);
        assert_eq!(board_port(Some("0"), Some("not json")), DEFAULT_PORT);
    }

    #[test]
    fn remote_port_like_bun() {
        assert_eq!(remote_port(7777, None, None), 7778);
        assert_eq!(remote_port(7777, Some("9000"), Some(r#"{"remotePort":9100}"#)), 9000);
        assert_eq!(remote_port(7777, None, Some(r#"{"remotePort":9100}"#)), 9100);
    }

    #[test]
    fn secret_is_random_hex() {
        let a = new_secret().unwrap();
        let b = new_secret().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn free_port_avoids() {
        let p = free_port(&[]).unwrap();
        assert!(p > 0);
        assert_ne!(free_port(&[p]).unwrap(), p);
    }

    #[test]
    fn repo_found_above_binary() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let fake_exe = here.join("target/release/ckanban-rs");
        assert_eq!(repo_root(None, &fake_exe).unwrap(), here.parent().unwrap().canonicalize().unwrap());
        assert!(repo_root(Some(Path::new("/nonexistent")), &fake_exe).is_err());
    }
}
