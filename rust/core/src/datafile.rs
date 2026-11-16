//! Reading and writing the data folder's JSON files in the exact format Bun uses for each one
//! (`contracts/data-files.md`, "Write styles" and "JSON serialisation"): pretty or compact text, a final newline or
//! not, and how the file is replaced (atomic temp file, a fixed `.tmp` name, or straight over it), with `0600` for
//! files that hold secrets.
//!
//! Values are `serde_json::Value` with Bun's key order (`preserve_order`) and JavaScript number text (`jsnum`), so a
//! file read and written back unchanged keeps its bytes, and fields this code doesn't know stay where they were.
//! Writes are plain blocking calls: callers on an async server run them with `spawn_blocking`, which replaces Bun's
//! `pauser()` slicing (nothing here holds a shared event loop).

use crate::atomic::new_id;
use crate::jsnum::normalize;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// How the JSON text is laid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// `JSON.stringify(v)`
    Compact,
    /// `JSON.stringify(v, null, n)`: 2 for "pretty", 1 for `waits.json` and `helper-state.json`.
    Indent(usize),
}

/// How the file is replaced on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Replace {
    /// `atomicWrite`: `<file>.tmp-<8 base36>`, then rename (parent folders made first).
    Atomic,
    /// `<file>.tmp` (always that name), then rename.
    FixedTmp,
    /// Written straight over the file.
    Plain,
}

/// One data file's format: what Bun writes there, byte for byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub layout: Layout,
    pub newline: bool,
    pub replace: Replace,
    /// Created with mode 0600 and chmod'ed to it (files with secrets).
    pub private: bool,
}

const fn f(layout: Layout, newline: bool, replace: Replace, private: bool) -> Format {
    Format { layout, newline, replace, private }
}
const PRETTY: Layout = Layout::Indent(2);
const COMPACT: Layout = Layout::Compact;
use Replace::{Atomic, FixedTmp, Plain};

/// Every JSON file of `contracts/data-files.md` with the format Bun writes it in.
pub mod formats {
    use super::*;
    // Boards and tickets
    pub const PROFILE: Format = f(PRETTY, true, Atomic, false);
    /// `board-tools.json`: random temp name, 0600 (`writeBoardTools`).
    pub const BOARD_TOOLS: Format = f(PRETTY, true, Atomic, true);
    pub const HELP: Format = f(PRETTY, true, Atomic, false);
    pub const SIMPLIFIED: Format = f(PRETTY, true, Atomic, false);
    pub const CONTEXT: Format = f(COMPACT, false, Atomic, false);
    /// `outputs/status.json`: pretty, no final newline, fixed `.tmp`.
    pub const FEATURE_STATUS: Format = f(PRETTY, false, FixedTmp, false);
    pub const QUICK_CHAT: Format = f(PRETTY, true, Atomic, false);
    pub const SCHEDULE: Format = f(PRETTY, true, Atomic, false);
    pub const JOB: Format = f(PRETTY, true, Atomic, false);
    pub const LOOP: Format = f(PRETTY, true, Atomic, false);
    pub const LOOP_STATE: Format = f(COMPACT, true, Atomic, false);
    pub const HUDDLE: Format = f(PRETTY, true, Atomic, false);
    // Board knowledge
    pub const HUDDLE_PRESETS: Format = f(PRETTY, true, Atomic, false);
    pub const HUDDLE_TEMPLATES: Format = f(PRETTY, true, Atomic, false);
    pub const LEARNED_PILE: Format = f(PRETTY, true, Atomic, false);
    pub const LEARNED_CHANGES: Format = f(PRETTY, true, Atomic, false);
    pub const AVATARS: Format = f(PRETTY, true, Atomic, false);
    pub const SNIPPETS: Format = f(PRETTY, true, Atomic, false);
    // Settings and connections
    pub const NOTIFY: Format = f(PRETTY, true, FixedTmp, true);
    pub const PUSH: Format = f(PRETTY, true, FixedTmp, true);
    pub const REMOTE: Format = f(PRETTY, true, FixedTmp, false);
    pub const AUTOMATION_PASSES: Format = f(PRETTY, true, Atomic, true);
    pub const HELPER: Format = f(PRETTY, true, Atomic, false);
    pub const DEVICES: Format = f(PRETTY, false, FixedTmp, false);
    pub const BROWSERS: Format = f(PRETTY, false, FixedTmp, false);
    pub const BOARD_BROWSERS: Format = f(PRETTY, false, FixedTmp, false);
    // Spend history
    pub const SPEND_DAYS: Format = f(COMPACT, true, Atomic, false);
    pub const TELEGRAM_SPEND: Format = f(COMPACT, true, Atomic, false);
    pub const USAGE_WINDOWS: Format = f(COMPACT, false, Atomic, false);
    // State
    pub const MESSAGES: Format = f(COMPACT, true, FixedTmp, false);
    pub const WAITS: Format = f(Layout::Indent(1), true, FixedTmp, false);
    pub const HELPER_STATE: Format = f(Layout::Indent(1), true, Atomic, false);
    pub const TELEGRAM_STORE: Format = f(COMPACT, true, FixedTmp, true);
    pub const TELEGRAM_OFFSET: Format = f(COMPACT, true, FixedTmp, false);
    pub const TELEGRAM_FRONTDESK: Format = f(COMPACT, true, Atomic, false);
    // Caches
    pub const SESSION_SUMMARIES: Format = f(COMPACT, false, Atomic, false);
    pub const USAGE_LAST: Format = f(COMPACT, false, Atomic, false);
    pub const MCP_SEEN: Format = f(COMPACT, false, Plain, false);
    pub const CLAUDE_COMMANDS: Format = f(PRETTY, false, Atomic, false);
    pub const MODEL_VERSIONS: Format = f(PRETTY, false, Atomic, false);
    pub const LEARNED_SCANNED_AT: Format = f(COMPACT, true, Atomic, false);
}

/// The text Bun's `JSON.stringify` gives for a value. Numbers must already be in JS form (values read through
/// `read_json`, or built with `jsnum::num`); string escaping is the same in both (`\"`, `\\`, `\b\f\n\r\t`, other
/// control characters as `\u00xx`, everything else raw UTF-8).
pub fn to_text(v: &Value, layout: Layout) -> String {
    let v = crate::jskeys::ordered(v);
    let v = v.as_ref();
    match layout {
        Layout::Compact => serde_json::to_string(v).expect("JSON value to text"),
        Layout::Indent(n) => {
            let indent = vec![b' '; n];
            let mut out = Vec::new();
            let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(&indent));
            v.serialize(&mut ser).expect("JSON value to text");
            String::from_utf8(out).expect("JSON text is UTF-8")
        }
    }
}

/// The file's whole text in `format`.
pub fn render(v: &Value, format: Format) -> String {
    let mut s = to_text(v, format.layout);
    if format.newline {
        s.push('\n');
    }
    s
}

/// Parses JSON text the way `JSON.parse` would leave it (numbers in JS form, index keys first). None when it isn't JSON.
pub fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().map(|v| crate::jskeys::order(normalize(v)))
}

/// A JSON file: Ok(None) when it is missing or not valid JSON (Bun's readers fall back to defaults then);
/// Err for other read errors.
pub fn read_json(file: &Path) -> io::Result<Option<Value>> {
    match fs::read_to_string(file) {
        Ok(t) => Ok(parse_json(&t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes `v` in the file's format.
pub fn write_json(file: &Path, v: &Value, format: Format) -> io::Result<()> {
    write_text(file, render(v, format).as_bytes(), format.replace, format.private)
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

#[cfg(unix)]
fn create(path: &Path, private: bool) -> io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    if private {
        o.mode(0o600);
    }
    let file = o.open(path)?;
    if private {
        // The mode only applies to a new file; an existing one is tightened too, as Bun's chmod does.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Writes bytes with one of Bun's replace styles. Atomic and fixed-tmp make the parent folders first; a failed
/// write or rename removes its temp file.
pub fn write_text(file: &Path, bytes: &[u8], replace: Replace, private: bool) -> io::Result<()> {
    if replace == Replace::Plain {
        return create(file, private)?.write_all(bytes);
    }
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let tmp = match replace {
        Replace::Atomic => with_suffix(file, &format!(".tmp-{}", new_id())),
        _ => with_suffix(file, ".tmp"),
    };
    let r = create(&tmp, private).and_then(|mut f| f.write_all(bytes)).and_then(|()| fs::rename(&tmp, file));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// Whether a file name is one of the temp files writers leave on a crash (`.tmp-<id>` or `.tmp`): skip it.
pub fn is_temp_name(name: &str) -> bool {
    name.contains(".tmp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ckrs-{tag}-{}", new_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn layouts_match_json_stringify() {
        let v = parse_json(r#"{"a":[1,2.50,{}],"b":{"c":[]},"s":"é\u0001\n\"","n":1e21,"m":0.0000015}"#).unwrap();
        assert_eq!(to_text(&v, Layout::Compact), r#"{"a":[1,2.5,{}],"b":{"c":[]},"s":"é\u0001\n\"","n":1e+21,"m":0.0000015}"#);
        assert_eq!(to_text(&json!({"a": [1], "e": []}), Layout::Indent(2)), "{\n  \"a\": [\n    1\n  ],\n  \"e\": []\n}");
        assert_eq!(to_text(&json!({"a": {"b": 1}}), Layout::Indent(1)), "{\n \"a\": {\n  \"b\": 1\n }\n}");
    }

    #[test]
    fn replace_styles_and_private_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp_dir("datafile");
        let v = json!({"x": 1});
        for (name, fmt) in [("a.json", formats::NOTIFY), ("b.json", formats::BOARD_TOOLS), ("c.json", formats::MCP_SEEN), ("d.json", formats::DEVICES)] {
            let file = d.join("sub").join(name);
            if fmt.replace == Replace::Plain {
                fs::create_dir_all(file.parent().unwrap()).unwrap();
            }
            write_json(&file, &v, fmt).unwrap();
            assert_eq!(fs::read_to_string(&file).unwrap(), render(&v, fmt));
            let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            if fmt.private {
                assert_eq!(mode, 0o600, "{name}");
            }
        }
        let names: Vec<_> = fs::read_dir(d.join("sub")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert!(names.iter().all(|n| !is_temp_name(n)), "{names:?}");
        assert_eq!(read_json(&d.join("sub/a.json")).unwrap(), Some(v));
        assert_eq!(read_json(&d.join("missing.json")).unwrap(), None);
        let _ = fs::remove_dir_all(d);
    }
}
