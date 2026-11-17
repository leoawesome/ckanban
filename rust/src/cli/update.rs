//! `ckanban update` (`update()` in Bun's `src/cli/cli.ts`): downloads the latest release's binary for this Mac's chip,
//! checks it against the release's SHA256SUMS, makes sure it is signed and starts, swaps it in for this binary and
//! restarts the daemon. Nothing is replaced unless every check passes. A build from source ("dev") says how to update
//! from source instead. `CKANBAN_RELEASES_URL` (tests only) points it at a local stand-in for GitHub's API.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{launchd, out};

const REPO: &str = "leoawesome/ckanban";
const API_TIMEOUT: Duration = Duration::from_secs(8);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

struct Release {
    version: String,
    assets: Vec<(String, String)>,
}

/// The release asset for this binary's chip (the names release.yml publishes), or None for one ckanban doesn't ship.
pub fn asset_name() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Some("ckanban-darwin-arm64"),
        "x86_64" => Some("ckanban-darwin-x64"),
        _ => None,
    }
}

/// The sha256 for `asset` in a SHA256SUMS file (`<hash>  <name>` or `<hash> *<name>`), lower case.
pub fn expected_sum(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        let (hash, name) = (it.next()?, it.next()?);
        (name == asset || name.strip_prefix('*') == Some(asset)).then(|| hash.to_ascii_lowercase())
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn release_of(j: &Value) -> Release {
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
    let tag = s(j.get("tag_name"));
    let assets = j
        .get("assets")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|x| (s(x.get("name")), s(x.get("browser_download_url")))).collect())
        .unwrap_or_default();
    Release { version: tag.strip_prefix('v').unwrap_or(&tag).to_string(), assets }
}

async fn latest_release(http: &reqwest::Client) -> Option<Release> {
    let url = std::env::var("CKANBAN_RELEASES_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases/latest"));
    let r = http
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "ckanban")
        .timeout(API_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let j: Value = serde_json::from_slice(&r.bytes().await.ok()?).ok()?;
    j.is_object().then(|| release_of(&j))
}

async fn download(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let r = http.get(url).header("user-agent", "ckanban").timeout(DOWNLOAD_TIMEOUT).send().await.map_err(|e| format!("Download failed: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        return Err(format!("Download failed: {} {}", status.as_u16(), status.canonical_reason().unwrap_or("")).trim_end().to_string());
    }
    r.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("Download failed: {e}"))
}

/// The checks a downloaded binary passes before it replaces this one: macOS accepts its signature, and it starts and
/// reports the release's version.
fn check_new_binary(file: &Path, version: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let ok = Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            return Err("The downloaded app's signature doesn't check out. Not updated.".into());
        }
    }
    let got = Command::new(file).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output();
    match got {
        Ok(o) if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == version => Ok(()),
        Ok(o) if o.status.success() => Err(format!("The downloaded app reports version {}, not v{version}. Not updated.", String::from_utf8_lossy(&o.stdout).trim())),
        _ => Err("The downloaded app doesn't start. Not updated.".into()),
    }
}

/// Writes the new binary next to this one and renames it over it (same folder, so the swap is one rename).
fn swap_in(exe: &Path, bin: &[u8], version: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let tmp = PathBuf::from(format!("{}.new", exe.display()));
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, bin)?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Can't write {}: {e}. Not updated.", tmp.display()));
    }
    if let Err(e) = check_new_binary(&tmp, version) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, exe).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Can't replace {}: {e}. Not updated.", exe.display())
    })
}

async fn fetch_verified(version: &str) -> Result<Option<(String, Vec<u8>)>, String> {
    let http = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let Some(rel) = latest_release(&http).await else {
        return Err("Could not reach GitHub to check for updates.".into());
    };
    if rel.version == version {
        out(&format!("Already on the latest version (v{version})."));
        return Ok(None);
    }
    let Some(name) = asset_name() else {
        return Err(format!("No build for darwin-{} in release v{}.", std::env::consts::ARCH, rel.version));
    };
    let url_of = |n: &str| rel.assets.iter().find(|(a, _)| a == n).map(|(_, u)| u.clone());
    let Some(asset_url) = url_of(name) else {
        return Err(format!("No build for {} in release v{}.", name.trim_start_matches("ckanban-"), rel.version));
    };
    let Some(sums_url) = url_of("SHA256SUMS") else {
        return Err(format!("Release v{} has no SHA256SUMS, so the download can't be verified. Not updated.", rel.version));
    };
    out(&format!("Updating v{version} → v{}…", rel.version));
    let (bin, sums) = tokio::join!(download(&http, &asset_url), download(&http, &sums_url));
    let (bin, sums) = (bin?, sums?);
    let got = sha256_hex(&bin);
    match expected_sum(&String::from_utf8_lossy(&sums), name) {
        None => Err(format!("SHA256SUMS has no entry for {name}. Not updated.")),
        Some(want) if want != got => {
            Err(format!("Checksum mismatch for {name}: expected {want}, got {got}. The download may be corrupt or tampered with. Not updated."))
        }
        Some(_) => Ok(Some((rel.version, bin))),
    }
}

pub fn run(version: &str) -> u8 {
    if version == "dev" {
        out("Running from source: use `git pull && bun run build:web && scripts/build-rust.sh && ckanban restart`.");
        return 0;
    }
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let (latest, bin) = match rt.block_on(fetch_verified(version)) {
        Ok(Some(v)) => v,
        Ok(None) => return 0,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    drop(rt);
    let exe = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Can't find this app's file: {e}. Not updated.");
            return 1;
        }
    };
    if let Err(e) = swap_in(&exe, &bin, &latest) {
        eprintln!("{e}");
        return 1;
    }
    let (running, waiting) = launchd::restart_after_update();
    let tail = match (running, waiting) {
        (false, _) => String::new(),
        (true, Some(n)) if n > 0 => format!(" Daemon restarts once {n} active run{} finish; then refresh the board.", if n == 1 { "" } else { "s" }),
        (true, _) => " Daemon restarted; refresh the board.".into(),
    };
    out(&format!("Updated to v{latest}.{tail}"));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_and_assets() {
        let sums = "ABC123  ckanban-darwin-arm64\ndef456 *ckanban-darwin-x64\n\n";
        assert_eq!(expected_sum(sums, "ckanban-darwin-arm64").as_deref(), Some("abc123"));
        assert_eq!(expected_sum(sums, "ckanban-darwin-x64").as_deref(), Some("def456"));
        assert_eq!(expected_sum(sums, "ckanban-darwin"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let rel = release_of(&serde_json::json!({
            "tag_name": "v1.2.3",
            "assets": [{ "name": "SHA256SUMS", "browser_download_url": "https://x/SHA256SUMS" }],
        }));
        assert_eq!(rel.version, "1.2.3");
        assert_eq!(rel.assets, vec![("SHA256SUMS".to_string(), "https://x/SHA256SUMS".to_string())]);
        assert!(asset_name().is_some());
    }

    #[test]
    fn a_bad_download_is_never_swapped_in() {
        let dir = std::env::temp_dir().join(format!("ckupdate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("ckanban");
        std::fs::write(&exe, b"old").unwrap();
        let e = swap_in(&exe, b"#!/bin/sh\necho 9.9.9\n", "1.0.0").unwrap_err();
        assert!(e.ends_with("Not updated."), "{e}");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        assert!(!dir.join("ckanban.new").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
