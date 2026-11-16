//! The data folder's JSONL files (comments, run logs, side spend, schedule history, huddle messages), read and
//! appended the way `src/core/store.ts` does: one compact JSON value per line ending in `\n`, appended with one write
//! and no lock; readers skip blank lines and lines that don't parse (a last line still being written is left out
//! until it is whole).
//!
//! Masking saved keys before a line is written (`maskSaved` in Bun) is the caller's job: it needs the board's keys.

use crate::datafile::{parse_json, to_text, Layout};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

/// `appendFileSync(file, JSON.stringify(v) + "\n")`. The folder must exist, as in Bun (callers make it first where
/// Bun does).
pub fn append(file: &Path, v: &Value) -> io::Result<()> {
    append_line(file, &to_text(v, Layout::Compact))
}

/// Appends one line (a `\n` is added) in a single write.
pub fn append_line(file: &Path, line: &str) -> io::Result<()> {
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line.as_bytes());
    buf.push(b'\n');
    OpenOptions::new().create(true).append(true).open(file)?.write_all(&buf)
}

/// Every value of a JSONL text, skipping blank and bad lines (`parseJsonl`).
pub fn parse_lines(text: &str) -> Vec<Value> {
    text.split('\n').filter(|l| !l.trim().is_empty()).filter_map(parse_json).collect()
}

/// The whole file (`readJsonl`); empty when it is missing. Only for files that stay small (comments): logs and
/// histories grow for years, read them with `read_page` or a `Tail`.
pub fn read_all(file: &Path) -> io::Result<Vec<Value>> {
    match fs::read(file) {
        Ok(b) => Ok(parse_lines(&String::from_utf8_lossy(&b))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// About how much of an activity log one page holds (`ACTIVITY_PAGE_BYTES`).
pub const PAGE_BYTES: u64 = 512 * 1024;

/// Something read at positions: a file, or bytes in memory (a decompressed `activity.jsonl.gz`).
pub trait ReadAt {
    fn size(&self) -> u64;
    fn read_at(&self, buf: &mut [u8], pos: u64) -> io::Result<usize>;
}

impl ReadAt for File {
    fn size(&self) -> u64 {
        self.metadata().map(|m| m.len()).unwrap_or(0)
    }
    fn read_at(&self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        std::os::unix::fs::FileExt::read_at(self, buf, pos)
    }
}

impl ReadAt for [u8] {
    fn size(&self) -> u64 {
        self.len() as u64
    }
    fn read_at(&self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        let start = (pos as usize).min(self.len());
        let n = buf.len().min(self.len() - start);
        buf[..n].copy_from_slice(&self[start..start + n]);
        Ok(n)
    }
}

/// One page read from the end of a JSONL file.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub entries: Vec<Value>,
    /// Where the page starts (pass it back as `before` for the page before); None once the page reaches the first line.
    pub before: Option<u64>,
}

/// `readPage` in store.ts: the whole lines that end before byte `before` (default: the end), about `max_bytes` of
/// them (more when one line is bigger).
pub fn read_page<R: ReadAt + ?Sized>(log: &R, before: Option<u64>, max_bytes: Option<u64>) -> io::Result<Page> {
    let size = log.size();
    let end = before.unwrap_or(size).min(size);
    let mut want = max_bytes.unwrap_or(PAGE_BYTES).max(1);
    loop {
        let start = end.saturating_sub(want);
        let mut buf = vec![0u8; (end - start) as usize];
        let mut got = 0;
        while got < buf.len() {
            let n = log.read_at(&mut buf[got..], start + got as u64)?;
            if n == 0 {
                break;
            }
            got += n;
        }
        // The chunk starts mid-line unless it starts the file: the page begins after its first newline.
        let skip = if start == 0 { 0 } else { buf.iter().position(|b| *b == b'\n').map_or(0, |p| p + 1) };
        if start > 0 && skip == 0 {
            want *= 2;
            continue;
        }
        let entries = parse_lines(&String::from_utf8_lossy(&buf[skip..]));
        if entries.is_empty() && start > 0 {
            want *= 2;
            continue;
        }
        return Ok(Page { entries, before: if start == 0 { None } else { Some(start + skip as u64) } });
    }
}

/// `readJsonlPage`: a page of a plain JSONL file; an empty last page when the file is missing.
pub fn read_file_page(file: &Path, before: Option<u64>, max_bytes: Option<u64>) -> io::Result<Page> {
    match File::open(file) {
        Ok(f) => read_page(&f, before, max_bytes),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Page { entries: Vec::new(), before: None }),
        Err(e) => Err(e),
    }
}

/// The run log's bytes when only its compressed copy (`activity.jsonl.gz`) is there; None when there is none.
/// Bun's rule: when both exist, the plain file wins.
pub fn read_gz_log(file: &Path) -> io::Result<Option<Vec<u8>>> {
    if file.exists() {
        return Ok(None);
    }
    let mut gz = file.as_os_str().to_owned();
    gz.push(".gz");
    match File::open(gz) {
        Ok(f) => {
            let mut all = Vec::new();
            flate2::read::MultiGzDecoder::new(f).read_to_end(&mut all)?;
            Ok(Some(all))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// A page of a run log, plain or compressed.
pub fn read_log_page(file: &Path, before: Option<u64>, max_bytes: Option<u64>) -> io::Result<Page> {
    match read_gz_log(file)? {
        Some(bytes) => read_page(bytes.as_slice(), before, max_bytes),
        None => read_file_page(file, before, max_bytes),
    }
}

/// An append-only JSONL file read as it grows (huddle messages, `readHuddleMessages`): each `read` parses only the
/// whole lines added since the last one. A file that got shorter (replaced) is read again from the start.
#[derive(Debug, Default, Clone)]
pub struct Tail {
    pub offset: u64,
    pub entries: Vec<Value>,
}

impl Tail {
    /// Brings the entries up to date; returns how many were added. A missing file empties it.
    pub fn read(&mut self, file: &Path) -> io::Result<usize> {
        let f = match File::open(file) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                *self = Tail::default();
                return Ok(0);
            }
            Err(e) => return Err(e),
        };
        let size = ReadAt::size(&f);
        if size < self.offset {
            *self = Tail::default();
        }
        if size == self.offset {
            return Ok(0);
        }
        let mut buf = vec![0u8; (size - self.offset) as usize];
        let n = ReadAt::read_at(&f, &mut buf, self.offset)?;
        buf.truncate(n);
        // Only whole lines: a line still being written is read next time.
        let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1);
        let added = parse_lines(&String::from_utf8_lossy(&buf[..end]));
        self.offset += end as u64;
        let n = added.len();
        self.entries.extend(added);
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ckrs-{tag}-{}", crate::atomic::new_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn append_and_read_skip_bad_lines() {
        let d = tmp("jsonl");
        let f = d.join("c.jsonl");
        append(&f, &json!({"id": "a", "n": 1.5})).unwrap();
        fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"not json\n\n").unwrap();
        append(&f, &json!({"id": "b"})).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "{\"id\":\"a\",\"n\":1.5}\nnot json\n\n{\"id\":\"b\"}\n");
        assert_eq!(read_all(&f).unwrap(), vec![json!({"id": "a", "n": 1.5}), json!({"id": "b"})]);
        assert!(read_all(&d.join("none")).unwrap().is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn pages_from_the_end() {
        let text: String = (0..100).map(|i| format!("{{\"i\":{i}}}\n")).collect();
        let bytes = text.as_bytes();
        let mut before = None;
        let mut seen = Vec::new();
        loop {
            let p = read_page(bytes, before, Some(64)).unwrap();
            let mut ids: Vec<i64> = p.entries.iter().map(|e| e["i"].as_i64().unwrap()).collect();
            ids.extend(seen);
            seen = ids;
            match p.before {
                Some(b) => before = Some(b),
                None => break,
            }
        }
        assert_eq!(seen, (0..100).collect::<Vec<_>>());
        // A line longer than the page is still read whole.
        let long = format!("{{\"s\":\"{}\"}}\n{{\"i\":1}}\n", "x".repeat(300));
        let p = read_page(long.as_bytes(), None, Some(16)).unwrap();
        assert_eq!(p.entries, vec![json!({"i": 1})]);
    }

    #[test]
    fn tail_reads_only_whole_new_lines() {
        let d = tmp("tail");
        let f = d.join("m.jsonl");
        let mut t = Tail::default();
        assert_eq!(t.read(&f).unwrap(), 0);
        fs::write(&f, "{\"a\":1}\n{\"a\":").unwrap();
        assert_eq!(t.read(&f).unwrap(), 1);
        fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"2}\n").unwrap();
        assert_eq!(t.read(&f).unwrap(), 1);
        assert_eq!(t.entries, vec![json!({"a": 1}), json!({"a": 2})]);
        fs::write(&f, "{\"b\":1}\n").unwrap();
        t.read(&f).unwrap();
        assert_eq!(t.entries, vec![json!({"b": 1})]);
        let _ = fs::remove_dir_all(d);
    }
}
