//! What `ckanban-rs dev` needs before it starts: the data folder, the board's and phone access ports and the source
//! folder whose built web page it serves. Same env as the Bun daemon had (`src/cli/daemon.ts` before P4).

use std::env;
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

/// The phone access port (`remoteListenPort` of Bun's `src/integrations/remote.ts`): CKANBAN_REMOTE_PORT, else
/// `remotePort` in config.json, else the board's port + 1.
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

/// The source folder (the one with `web/index.html`): CKANBAN_REPO, else the nearest folder above the binary that
/// has it (the binary sits in `rust/target/release/`).
pub fn repo_root(env_repo: Option<&Path>, exe: &Path) -> Result<PathBuf, String> {
    if let Some(r) = env_repo {
        return if r.join("web/index.html").is_file() { Ok(r.to_path_buf()) } else { Err(format!("CKANBAN_REPO {} has no web/index.html", r.display())) };
    }
    let exe = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
    exe.ancestors()
        .skip(1)
        .find(|d| d.join("web/index.html").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("can't find the ckanban source folder above {}: set CKANBAN_REPO", exe.display()))
}

/// The built web page (`bun run build:web` writes it): `<source folder>/web/dist`.
pub fn web_dir(repo: &Path) -> PathBuf {
    repo.join("web").join("dist")
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
    fn repo_found_above_binary() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let fake_exe = here.join("target/release/ckanban-rs");
        assert_eq!(repo_root(None, &fake_exe).unwrap(), here.parent().unwrap().canonicalize().unwrap());
        assert!(repo_root(Some(Path::new("/nonexistent")), &fake_exe).is_err());
    }
}
