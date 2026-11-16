//! Board mode (plan 3.1): whether this start of `ckanban-rs dev` runs the board in Rust (with Bun as the satellite) or
//! leaves the whole board to Bun, and the record of that choice, `<data>/rust-board-status.json`.
//!
//! - Wanted when `CKANBAN_RUST_BOARD=1`, or when that variable is unset (or empty) and `<data>/rust-board` holds `on`.
//!   Any other value of the variable means off, whatever the file says.
//! - Fallbacks to Bun's full mode: (1) the switch is off (`rm <data>/rust-board`, then `ckanban restart`); (2) the
//!   Rust core can't start (the data lock is held, a file it can't read...); (3) board mode ended without a clean stop
//!   three times within 10 minutes. After (3) Bun keeps the board until the `rust-board` file is written again (newer
//!   than the fallback) or the status file is removed.
//!
//! The status file (2-space JSON, written atomically):
//! `{"mode": "rust"|"bun", "reason": string|null, "at": iso, "pid": n, "running": bool, "crashes": [iso...]}`.
//! `running` is true while a board-mode start hasn't stopped cleanly; the next start counts it as a crash.

use std::fs;
use std::path::{Path, PathBuf};

use ckanban_core::atomic::atomic_write;
use ckanban_core::time::{iso, now_ms, parse_date, system_ms};
use serde_json::{Value, json};

pub const SWITCH_FILE: &str = "rust-board";
pub const STATUS_FILE: &str = "rust-board-status.json";
pub const ENV: &str = "CKANBAN_RUST_BOARD";
/// Crashes within this window count toward the third fallback.
pub const CRASH_WINDOW_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const CRASH_LIMIT: usize = 3;

/// Whether board mode is asked for, and by what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wanted {
    Off,
    /// `CKANBAN_RUST_BOARD=1`.
    ByEnv,
    /// The `rust-board` file.
    ByFile,
}

pub fn wanted(env: Option<&str>, root: &Path) -> Wanted {
    match env.filter(|v| !v.is_empty()) {
        Some("1") => Wanted::ByEnv,
        Some(_) => Wanted::Off,
        None => match fs::read_to_string(root.join(SWITCH_FILE)) {
            Ok(t) if t.trim() == "on" => Wanted::ByFile,
            _ => Wanted::Off,
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub mode: String,
    pub reason: Option<String>,
    pub at: String,
    pub pid: u32,
    pub running: bool,
    pub crashes: Vec<String>,
}

impl Status {
    fn to_json(&self) -> Value {
        json!({ "mode": self.mode, "reason": self.reason, "at": self.at, "pid": self.pid, "running": self.running, "crashes": self.crashes })
    }

    fn from_json(v: &Value) -> Option<Status> {
        Some(Status {
            mode: v.get("mode")?.as_str()?.to_string(),
            reason: v.get("reason").and_then(Value::as_str).map(str::to_string),
            at: v.get("at").and_then(Value::as_str).unwrap_or_default().to_string(),
            pid: v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
            running: v.get("running").and_then(Value::as_bool).unwrap_or(false),
            crashes: v
                .get("crashes")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
        })
    }
}

pub fn status_path(root: &Path) -> PathBuf {
    root.join(STATUS_FILE)
}

pub fn read_status(root: &Path) -> Option<Status> {
    let text = fs::read_to_string(status_path(root)).ok()?;
    Status::from_json(&serde_json::from_str(&text).ok()?)
}

pub fn write_status(root: &Path, s: &Status) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(&s.to_json()).unwrap_or_default() + "\n";
    atomic_write(&status_path(root), text)
}

/// What this start does, decided before anything is locked or started.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Board mode is off: Bun runs the whole board, as before.
    Off,
    /// Board mode: try to start the Rust core. `crashes` are the recent unclean ends, this one's restart included.
    Try { crashes: Vec<String> },
    /// Board mode is asked for, but Bun keeps the board (fallback 3).
    Fallback { reason: String, crashes: Vec<String> },
}

/// Decides from the switch and the last status, at time `now` (ms).
pub fn decide(wanted: &Wanted, last: Option<&Status>, switch_written_ms: Option<f64>, now: f64) -> Decision {
    if *wanted == Wanted::Off {
        return Decision::Off;
    }
    let Some(last) = last else { return Decision::Try { crashes: Vec::new() } };
    // An earlier fallback for crashes holds until the switch file is written again after it.
    if last.mode == "bun" && last.crashes.len() >= CRASH_LIMIT {
        let fell_at = parse_date(&last.at).unwrap_or(0.0);
        let rewritten = *wanted == Wanted::ByFile && switch_written_ms.is_some_and(|m| m > fell_at);
        if !rewritten {
            return Decision::Fallback { reason: crash_reason(), crashes: last.crashes.clone() };
        }
        return Decision::Try { crashes: Vec::new() };
    }
    let mut crashes: Vec<String> =
        last.crashes.iter().filter(|c| parse_date(c).is_some_and(|t| now - t <= CRASH_WINDOW_MS)).cloned().collect();
    if last.mode == "rust" && last.running {
        crashes.push(iso(now));
    }
    if crashes.len() >= CRASH_LIMIT {
        return Decision::Fallback { reason: crash_reason(), crashes };
    }
    Decision::Try { crashes }
}

fn crash_reason() -> String {
    format!(
        "board mode stopped unexpectedly {CRASH_LIMIT} times within 10 minutes; Bun runs the whole board until {SWITCH_FILE} is written again (or {STATUS_FILE} is removed)"
    )
}

/// When the switch file was last written, in ms.
pub fn switch_written(root: &Path) -> Option<f64> {
    fs::metadata(root.join(SWITCH_FILE)).and_then(|m| m.modified()).ok().map(system_ms)
}

/// Board mode is starting (after the core started): `running` until a clean stop.
pub fn record_board(root: &Path, crashes: Vec<String>) -> std::io::Result<()> {
    write_status(root, &Status { mode: "rust".into(), reason: None, at: iso(now_ms()), pid: std::process::id(), running: true, crashes })
}

/// Bun keeps the whole board this start, and why.
pub fn record_fallback(root: &Path, reason: &str, crashes: Vec<String>) -> std::io::Result<()> {
    write_status(
        root,
        &Status { mode: "bun".into(), reason: Some(reason.to_string()), at: iso(now_ms()), pid: std::process::id(), running: false, crashes },
    )
}

/// Board mode ended. A clean stop (exit code 0) is not a crash; any other end leaves `running` for the next start.
pub fn record_stop(root: &Path, clean: bool) {
    if !clean {
        return;
    }
    if let Some(mut s) = read_status(root).filter(|s| s.mode == "rust" && s.pid == std::process::id()) {
        s.running = false;
        let _ = write_status(root, &s);
    }
}

/// Board mode is off (fallback 1): an existing status file says so, so it doesn't count the last board-mode start as
/// a crash later. Nothing is written when there is no status file (a board that never tried board mode).
pub fn record_off(root: &Path) {
    if let Some(s) = read_status(root)
        && (s.mode != "bun" || s.running || s.reason.as_deref() != Some(OFF_REASON))
    {
        let _ = write_status(
            root,
            &Status { mode: "bun".into(), reason: Some(OFF_REASON.into()), at: iso(now_ms()), pid: std::process::id(), running: false, crashes: Vec::new() },
        );
    }
}

pub const OFF_REASON: &str = "board mode is off";

#[cfg(test)]
mod tests {
    use super::*;

    fn st(mode: &str, at: f64, running: bool, crashes: &[f64]) -> Status {
        Status { mode: mode.into(), reason: None, at: iso(at), pid: 1, running, crashes: crashes.iter().map(|c| iso(*c)).collect() }
    }

    #[test]
    fn the_switch_env_wins_over_the_file() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(wanted(None, d.path()), Wanted::Off);
        fs::write(d.path().join(SWITCH_FILE), "on\n").unwrap();
        assert_eq!(wanted(None, d.path()), Wanted::ByFile);
        assert_eq!(wanted(Some(""), d.path()), Wanted::ByFile);
        assert_eq!(wanted(Some("0"), d.path()), Wanted::Off);
        assert_eq!(wanted(Some("1"), d.path()), Wanted::ByEnv);
        fs::write(d.path().join(SWITCH_FILE), "off").unwrap();
        assert_eq!(wanted(None, d.path()), Wanted::Off);
        fs::remove_file(d.path().join(SWITCH_FILE)).unwrap();
        assert_eq!(wanted(Some("1"), d.path()), Wanted::ByEnv);
    }

    #[test]
    fn three_unclean_ends_in_ten_minutes_fall_back() {
        let now = 1_800_000_000_000.0;
        let min = 60_000.0;
        assert_eq!(decide(&Wanted::Off, None, None, now), Decision::Off);
        assert_eq!(decide(&Wanted::ByEnv, None, None, now), Decision::Try { crashes: vec![] });
        // A clean last stop: no crash.
        assert_eq!(decide(&Wanted::ByEnv, Some(&st("rust", now - min, false, &[])), None, now), Decision::Try { crashes: vec![] });
        // Unclean: counted now.
        assert_eq!(decide(&Wanted::ByEnv, Some(&st("rust", now - min, true, &[])), None, now), Decision::Try { crashes: vec![iso(now)] });
        // Old ones drop out of the window.
        let d = decide(&Wanted::ByEnv, Some(&st("rust", now - min, true, &[now - 11.0 * min, now - 2.0 * min])), None, now);
        assert_eq!(d, Decision::Try { crashes: vec![iso(now - 2.0 * min), iso(now)] });
        // The third within 10 minutes: Bun.
        let d = decide(&Wanted::ByEnv, Some(&st("rust", now - min, true, &[now - 9.0 * min, now - 2.0 * min])), None, now);
        assert!(matches!(d, Decision::Fallback { ref crashes, .. } if crashes.len() == 3), "{d:?}");
    }

    #[test]
    fn a_crash_fallback_holds_until_the_switch_is_written_again() {
        let now = 1_800_000_000_000.0;
        let fell = st("bun", now - 60_000.0, false, &[now - 3e5, now - 2e5, now - 1e5]);
        assert!(matches!(decide(&Wanted::ByFile, Some(&fell), Some(now - 9e5), now), Decision::Fallback { .. }));
        // Even an hour later.
        assert!(matches!(decide(&Wanted::ByFile, Some(&fell), Some(now - 9e5), now + 3.6e6), Decision::Fallback { .. }));
        assert!(matches!(decide(&Wanted::ByEnv, Some(&fell), None, now), Decision::Fallback { .. }));
        // Written again after the fallback: try again with a clean count.
        assert_eq!(decide(&Wanted::ByFile, Some(&fell), Some(now - 1000.0), now), Decision::Try { crashes: vec![] });
        // A fallback for another reason (the lock) doesn't hold.
        let other = Status { reason: Some("lock".into()), ..st("bun", now - 60_000.0, false, &[]) };
        assert_eq!(decide(&Wanted::ByFile, Some(&other), None, now), Decision::Try { crashes: vec![] });
    }

    #[test]
    fn status_file_round_trip_and_clean_stop() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_status(d.path()), None);
        record_off(d.path());
        assert!(!status_path(d.path()).exists(), "no status file for a board that never tried board mode");
        record_board(d.path(), vec!["2026-11-17T00:00:00.000Z".into()]).unwrap();
        let s = read_status(d.path()).unwrap();
        assert_eq!((s.mode.as_str(), s.running, s.crashes.len()), ("rust", true, 1));
        let text = fs::read_to_string(status_path(d.path())).unwrap();
        assert!(text.starts_with("{\n  \"mode\": \"rust\",\n  \"reason\": null,"), "{text}");
        record_stop(d.path(), false);
        assert!(read_status(d.path()).unwrap().running);
        record_stop(d.path(), true);
        assert!(!read_status(d.path()).unwrap().running);
        record_fallback(d.path(), "the data lock is held", vec![]).unwrap();
        let s = read_status(d.path()).unwrap();
        assert_eq!((s.mode.as_str(), s.reason.as_deref(), s.running), ("bun", Some("the data lock is held"), false));
        record_off(d.path());
        assert_eq!(read_status(d.path()).unwrap().reason.as_deref(), Some(OFF_REASON));
    }
}
