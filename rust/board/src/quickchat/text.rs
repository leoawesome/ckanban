//! The pure parts of quick chats, the same text as Bun: `autoTitle` and `quickChatNote` (`src/chat/quickchat.ts`),
//! `localizeAttachments` (`src/board/attachments.ts`), `DraftTracker` (`src/chat/draft.ts`) and `sessionMissing`
//! (`src/board/board-types.ts`). Checked against Bun by `tests/fixtures/quickchat.json`.

use std::path::Path;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;

use crate::prompts::rules::WRITING_RULE;
use crate::runs::js as rjs;
use crate::sessions::js;

/// Longest title (UTF-16 units), from Rename or the first message.
pub const TITLE_MAX: usize = 80;
/// Longest message (UTF-16 units).
pub const MESSAGE_MAX: usize = 100_000;
/// What a reply a restart cut off gets on the other side.
pub const CONTINUE_TEXT: &str = "The board restarted while you were replying. Continue where you left off.";

static IMAGE_MD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK_MD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());

/// `/^[#>*\-\s`]+/` removed from the start of a line.
fn strip_marks(line: &str) -> &str {
    line.trim_start_matches(|c: char| matches!(c, '#' | '>' | '*' | '-' | '`') || js::is_space(c))
}

/// `autoTitle`: the first message's first line without images, links or markdown marks, cut to fit.
pub fn auto_title(text: Option<&str>) -> String {
    let t = text.unwrap_or("");
    let t = IMAGE_MD.replace_all(t, " ");
    let t = LINK_MD.replace_all(&t, "$1");
    let plain = t.split('\n').map(|l| js::trim(strip_marks(l))).find(|l| !l.is_empty()).unwrap_or("");
    if plain.is_empty() {
        return "New chat".into();
    }
    if js::len16(plain) > TITLE_MAX {
        format!("{}…", js::trim_end(js::slice16(plain, 0, Some(TITLE_MAX - 1))))
    } else {
        plain.to_string()
    }
}

/// `quickChatNote`: what every quick chat run gets (--append-system-prompt): where it runs and how to reach the board.
pub fn quick_chat_note(name: &Value, slug: &str, path: &Value) -> String {
    let name = rjs::to_string(name);
    let path = rjs::to_string(path);
    [
        "You are running in a quick chat of ckanban, a local kanban board that runs tickets through Claude. This chat is not a ticket.".to_string(),
        format!("It belongs to the board (profile) \"{name}\" (slug: {slug}), whose folder is {path}, your working folder."),
        "You can read, edit and run commands there when the user asks.".to_string(),
        "For board work (making, finding, updating or moving tickets) use the ckanban MCP tools: create_ticket, list_tickets, get_ticket, update_ticket, move_ticket, comment_ticket.".to_string(),
        format!("Use profile \"{slug}\" unless the user names another board. New tickets land in Backlog. The user can also turn this whole chat into a ticket with the Make ticket button."),
        "When the conversation turns up a real problem or a piece of work (a bug, a change to make), offer once, in one short sentence, to wrap this chat up into a ticket: the user can press Make ticket, or say yes and you make it with create_ticket. If the work belongs to an open feature (list_tickets marks them), add the ticket to that feature with partOf. Don't offer a ticket for a plain question you have answered, and don't offer again once the user has said no.".to_string(),
        "If you use Claude in Chrome, open your own new tab and don't take over the user's tabs.".to_string(),
        format!("The user may not be technical and may read this on a phone: answer in plain words. {}", *WRITING_RULE),
    ]
    .join(" ")
}

const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "gif", "webp"];
const FILE_EXTS: [&str; 35] = [
    "pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "tsv", "json", "js", "jsx", "ts", "tsx", "py", "rb", "go", "java", "c", "h",
    "cpp", "cs", "php", "swift", "kt", "rs", "html", "css", "yaml", "yml", "xml", "toml", "ini", "log", "sql", "sh",
];
pub const IMAGES_NOTE: &str = "Images in this message are local files; open them with the Read tool to see them.";
pub const FILES_NOTE: &str = "Files attached to this message are local files. Open images, PDFs and text files with the Read tool. For Word, Excel or PowerPoint files, convert them to text yourself with what this computer already has (for example unzip the file and read its XML, textutil on macOS, python or pandoc); don't ask the user to install anything. If you can't read a file, tell the user which one.";

/// `URL_RE`: the UI's attachment URL, the name as the first group.
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    let alt = IMAGE_EXTS.iter().chain(FILE_EXTS.iter()).copied().collect::<Vec<_>>().join("|");
    Regex::new(&format!(r"/api/attachments/([0-9a-f]{{32}}\.(?:{alt}))\b")).unwrap()
});

/// `localizeAttachments`: the UI's attachment URLs become paths in the attachments folder, with a note for Claude.
pub fn localize_attachments(prompt: &str, dir: &Path) -> String {
    if !prompt.contains("/api/attachments/") {
        return prompt.to_string();
    }
    let mut files = false;
    let out = URL_RE.replace_all(prompt, |c: &Captures| {
        let name = &c[1];
        let ext = name.rsplit('.').next().unwrap_or("");
        if !IMAGE_EXTS.contains(&ext) {
            files = true;
        }
        dir.join(name).to_string_lossy().into_owned()
    });
    let note = if files { FILES_NOTE } else { IMAGES_NOTE };
    match out.rfind("</ckanban-context>") {
        Some(close) => format!("{}\n{note}\n{}", &out[..close], &out[close..]),
        None => format!("{out}\n\n{note}"),
    }
}

/// `DraftTracker`: the text Claude has written so far in the current message, from `--include-partial-messages`.
#[derive(Debug, Default, Clone)]
pub struct DraftTracker {
    pub text: String,
    /// On a clear, the full text of the message that just ended.
    pub finished: String,
    block_has_text: bool,
}

/// What `DraftTracker::feed` saw.
#[derive(Debug, PartialEq, Eq)]
pub enum Draft {
    Same,
    Cleared,
    Changed,
}

impl DraftTracker {
    pub fn feed(&mut self, ev: &Value) -> Draft {
        let ty = ev.get("type").and_then(Value::as_str);
        let parent = js::truthy(ev.get("parent_tool_use_id"));
        if ty == Some("assistant") && !parent {
            if self.text.is_empty() {
                return Draft::Same;
            }
            self.reset();
            return Draft::Cleared;
        }
        if ty != Some("stream_event") || parent {
            return Draft::Same;
        }
        let e = ev.get("event");
        match e.and_then(|e| e.get("type")).and_then(Value::as_str) {
            Some("message_start") => {
                let had = !self.text.is_empty();
                self.reset();
                if had { Draft::Cleared } else { Draft::Same }
            }
            Some("content_block_start") => {
                self.block_has_text = false;
                Draft::Same
            }
            Some("content_block_delta") => {
                let d = e.and_then(|e| e.get("delta"));
                let (Some("text_delta"), Some(t)) = (d.and_then(|d| d.get("type")).and_then(Value::as_str), d.and_then(|d| d.get("text")).and_then(Value::as_str)) else {
                    return Draft::Same;
                };
                if !self.block_has_text && !self.text.is_empty() {
                    self.text.push_str("\n\n");
                }
                self.block_has_text = true;
                self.text.push_str(t);
                // Bun returns the text: "" (an empty first delta) reads as a clear there.
                if self.text.is_empty() { Draft::Cleared } else { Draft::Changed }
            }
            _ => Draft::Same,
        }
    }

    fn reset(&mut self) {
        self.finished = std::mem::take(&mut self.text);
        self.block_has_text = false;
    }
}

static MISSING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)No conversation found with session ID").unwrap());

/// `sessionMissing`: Claude's answer to `--resume` with a session it has no transcript for.
pub fn session_missing(error: &str, events: &[Value]) -> bool {
    MISSING.is_match(error)
        || events.iter().any(|e| {
            e.get("type").and_then(Value::as_str) == Some("result")
                && e.get("errors").and_then(Value::as_array).is_some_and(|a| a.iter().any(|m| m.as_str().is_some_and(|m| MISSING.is_match(m))))
        })
}

/// `crypto.randomUUID()`: a version 4 UUID.
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // No OS randomness: still unique enough for a session id (time, pid, counter).
        let id = format!("{}{}", ckanban_core::atomic::new_id(), ckanban_core::atomic::new_id());
        b.copy_from_slice(&id.as_bytes()[..16]);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `String(x).trim()` then the last non-blank line, cut to 500 UTF-16 units (a failed reply's error line).
pub fn error_line(error: &str) -> String {
    match error.split('\n').rev().find(|l| !js::trim(l).is_empty()) {
        Some(l) => js::slice16(js::trim(l), 0, Some(500)).to_string(),
        None => js::slice16(error, 0, Some(500)).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn titles_and_uuids() {
        assert_eq!(auto_title(Some("What is in this folder?\nmore lines")), "What is in this folder?");
        assert_eq!(auto_title(None), "New chat");
        assert_eq!(auto_title(Some("  \n## [Docs](http://x) here")), "Docs here");
        let u = random_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }

    #[test]
    fn drafts_follow_the_stream() {
        let mut d = DraftTracker::default();
        let delta = |t: &str| json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}});
        assert_eq!(d.feed(&json!({"type": "stream_event", "event": {"type": "message_start"}})), Draft::Same);
        assert_eq!(d.feed(&delta("Work ")), Draft::Changed);
        assert_eq!(d.feed(&json!({"type": "stream_event", "event": {"type": "content_block_start"}})), Draft::Same);
        assert_eq!(d.feed(&delta("done")), Draft::Changed);
        assert_eq!(d.text, "Work \n\ndone");
        assert_eq!(d.feed(&json!({"type": "assistant"})), Draft::Cleared);
        assert_eq!(d.finished, "Work \n\ndone");
    }
}
