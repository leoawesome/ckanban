//! Sharing a ticket's output files from the Outputs tab (port of `src/board/share.ts`): reveal in Finder, the file
//! itself on the clipboard, download headers. Paths are resolved by the caller (`files::output_path`) and passed as
//! argv, never through a shell. Publishing a markdown page to claude.ai stays with the Bun satellite (plan 3.3).

use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareError {
    pub status: u16,
    pub message: String,
}

/// Whether the file clipboard works here (osascript is macOS only).
pub fn can_copy_file() -> bool {
    cfg!(target_os = "macos")
}

/// `revealArgv`: select the file in Finder (`open -R`); other systems open its folder.
pub fn reveal_argv(file: &str, bin: Option<&str>) -> Vec<String> {
    if let Some(b) = bin.filter(|b| !b.is_empty()) {
        return vec![b.into(), "-R".into(), file.into()];
    }
    if cfg!(target_os = "macos") {
        return vec!["open".into(), "-R".into(), file.into()];
    }
    let dir = file.rfind('/').map(|i| &file[..i]).filter(|d| !d.is_empty()).unwrap_or("/");
    vec!["xdg-open".into(), dir.into()]
}

/// Writes the file's URL to the pasteboard the way Finder's Copy does; the path is an argument, never script source.
const COPY_FILE_JXA: &str = "function run(argv) {
  ObjC.import(\"AppKit\");
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  if (!pb.writeObjects($([$.NSURL.fileURLWithPath(argv[0])]))) throw new Error(\"the clipboard refused the file\");
}";

pub fn copy_file_argv(file: &str, bin: Option<&str>) -> Vec<String> {
    vec![bin.filter(|b| !b.is_empty()).unwrap_or("osascript").into(), "-l".into(), "JavaScript".into(), "-e".into(), COPY_FILE_JXA.into(), file.into()]
}

async fn exec(argv: Vec<String>, what: &str) -> Result<(), ShareError> {
    let out = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| ShareError { status: 500, message: format!("couldn't run {}: {e}", argv[0]) })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let why = if err.is_empty() { format!("{} exited with an error", argv[0]) } else { err };
        return Err(ShareError { status: 500, message: format!("{what} failed: {why}") });
    }
    Ok(())
}

/// Show in Finder. `CKANBAN_OPEN_BIN` replaces `open` in tests.
pub async fn reveal_file(file: &Path) -> Result<(), ShareError> {
    let bin = std::env::var("CKANBAN_OPEN_BIN").ok();
    exec(reveal_argv(&file.to_string_lossy(), bin.as_deref()), "Show in Finder").await
}

/// Copy file. `CKANBAN_OSASCRIPT_BIN` replaces osascript in tests.
pub async fn copy_file_to_clipboard(file: &Path) -> Result<(), ShareError> {
    let bin = std::env::var("CKANBAN_OSASCRIPT_BIN").ok().filter(|b| !b.is_empty());
    if bin.is_none() && !can_copy_file() {
        return Err(ShareError { status: 501, message: "copying a file to the clipboard only works on macOS; use Download instead".into() });
    }
    exec(copy_file_argv(&file.to_string_lossy(), bin.as_deref()), "Copy file").await
}

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');

/// `attachmentHeader`: Content-Disposition keeping non-ASCII names (RFC 5987) with a plain ASCII fallback.
pub fn attachment_header(name: &str) -> String {
    // `[^\x20-\x7e]` per UTF-16 unit: a character outside the BMP becomes two "_".
    let ascii: String = name
        .chars()
        .flat_map(|c| {
            let n = if (' '..='~').contains(&c) { 0 } else { c.len_utf16() };
            let keep = if n == 0 { Some(if c == '"' || c == '\\' { '_' } else { c }) } else { None };
            keep.into_iter().chain(std::iter::repeat_n('_', n))
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", utf8_percent_encode(name, URI_COMPONENT))
}

/// `markdownTitle`: the first markdown heading, else the file name without its extension.
pub fn markdown_title(md: &str, file: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)^#{1,2}\s+(.+?)\s*#*\s*$").unwrap());
    if let Some(c) = RE.captures(md) {
        return c[1].replace(['*', '_', '`'], "").trim().to_string();
    }
    let base = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    static EXT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.(md|markdown)$").unwrap());
    EXT.replace(&base, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_and_argv() {
        assert_eq!(attachment_header("a b.txt"), "attachment; filename=\"a b.txt\"; filename*=UTF-8''a%20b.txt");
        assert_eq!(attachment_header("résumé \"x\".pdf"), "attachment; filename=\"r_sum_ _x_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.pdf");
        assert_eq!(attachment_header("😀.md"), "attachment; filename=\"__.md\"; filename*=UTF-8''%F0%9F%98%80.md");
        assert_eq!(reveal_argv("/a/b", Some("fake")), ["fake", "-R", "/a/b"]);
        assert_eq!(copy_file_argv("/a/b", None)[0], "osascript");
        assert_eq!(markdown_title("intro\n## The *Plan* ##\n", "x.md"), "The Plan");
        assert_eq!(markdown_title("no heading", "/d/Notes.Markdown"), "Notes");
    }

    #[tokio::test]
    async fn exec_reports_failures() {
        let e = exec(vec!["sh".into(), "-c".into(), "echo no >&2; exit 1".into()], "Show in Finder").await.unwrap_err();
        assert_eq!(e, ShareError { status: 500, message: "Show in Finder failed: no".into() });
        assert!(exec(vec!["true".into()], "x").await.is_ok());
    }
}
