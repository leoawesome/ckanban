//! `recordWindow` from `src/usage/ticket-usage.ts`: after each good usage answer, remember the 5h window in
//! `usage-windows.json`, so runs keep a % after their window has reset. Bun's usage cache does this on every
//! answer; a Rust server serving /api/usage must too, or ticket Usage tabs lose their window history.

use crate::atomic::atomic_write;
use crate::jsnum::{normalize, num};
use crate::time::{iso, parse_date};
use crate::usage::UsageResult;
use serde_json::{Map, Value};
use std::path::Path;

const FIVE_HOURS: f64 = 5.0 * 3600_000.0;
const SAME_WINDOW_MS: f64 = 15.0 * 60_000.0;
const KEEP: usize = 500;

/// `readWindows`: the saved list, or empty when missing or not an array.
pub fn read_windows(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match normalize(v) {
            Value::Array(a) => Some(a),
            _ => None,
        })
        .unwrap_or_default()
}

pub fn record_window(file: &Path, r: &UsageResult) -> std::io::Result<()> {
    let UsageResult::Answer { windows, fetched_at } = r else { return Ok(()) };
    let Some(w) = windows.iter().find(|x| x.key == "five_hour") else { return Ok(()) };
    let Some(end) = w.resets_at.as_deref().and_then(parse_date) else { return Ok(()) };
    let mut snap = Map::new();
    snap.insert("start".into(), iso(end - FIVE_HOURS).into());
    snap.insert("end".into(), iso(end).into());
    snap.insert("utilization".into(), num(w.percent));
    snap.insert("seenAt".into(), fetched_at.clone().into());
    // resets_at can wobble by seconds between answers; anything within 15 min is the same window.
    let end_of = |x: &Value| x.get("end").and_then(Value::as_str).and_then(parse_date);
    let mut list: Vec<Value> = read_windows(file).into_iter().filter(|x| end_of(x).is_some_and(|e| (e - end).abs() >= SAME_WINDOW_MS)).collect();
    list.push(Value::Object(snap));
    let end_str = |x: &Value| x.get("end").and_then(Value::as_str).unwrap_or("").to_string();
    list.sort_by_key(end_str); // stable, like Array.prototype.sort; ISO strings compare like localeCompare
    let from = list.len().saturating_sub(KEEP);
    atomic_write(file, serde_json::to_string(&list[from..]).map_err(std::io::Error::other)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::UsageWindow;

    #[test]
    fn replaces_the_same_window_and_keeps_others_sorted() {
        let dir = std::env::temp_dir().join(format!("ckrs-win-{}", crate::atomic::new_id()));
        let file = dir.join("usage-windows.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, r#"[{"start":"2026-11-15T05:00:00.000Z","end":"2026-11-15T10:00:00.000Z","utilization":50,"seenAt":"x"},{"start":"2026-11-14T05:00:00.000Z","end":"2026-11-14T10:00:00.000Z","utilization":90.0,"seenAt":"y"}]"#).unwrap();
        let w = |p: f64, r: &str| UsageResult::Answer {
            windows: vec![UsageWindow { key: "five_hour".into(), label: "l".into(), percent: p, resets_at: Some(r.into()) }],
            fetched_at: "2026-11-15T09:00:00.000Z".into(),
        };
        record_window(&file, &w(61.0, "2026-11-15T10:00:05Z")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"[{"start":"2026-11-14T05:00:00.000Z","end":"2026-11-14T10:00:00.000Z","utilization":90,"seenAt":"y"},{"start":"2026-11-15T05:00:05.000Z","end":"2026-11-15T10:00:05.000Z","utilization":61,"seenAt":"2026-11-15T09:00:00.000Z"}]"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
