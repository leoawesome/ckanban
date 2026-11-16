//! Huddle role notes (`src/huddle/huddle-notes.ts`): lessons the user saved from past huddles, added to the system
//! prompt of every new agent of that role. Only the user writes them. General notes are global
//! (`<home>/huddle-notes/<role>.md`), repo notes one board's (`profiles/<slug>/huddle-notes/<role>.md`); `_all` holds
//! the notes for every role. Each file is a Markdown list, newest first, one note per line with its source in a
//! trailing HTML comment. Plain helpers; files are in `store.rs`.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::jsv;
use super::presets::preset_name;
use crate::prompts::js;

/// The notes of every role.
pub const ALL_ROLES: &str = "_all";
/// Lines per file that go into an agent's instructions (newest first); older ones stay stored.
pub const NOTES_CAP: usize = 30;
/// A proposed lesson's text.
pub const LESSON_MAX: usize = 200;
/// A note's text (the user may write longer than an agent).
pub const NOTE_MAX: usize = 400;
/// Lessons one done can propose.
pub const MAX_LESSONS: usize = 3;

/// `NoteScope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    General,
    Repo,
}

impl Scope {
    pub fn of(s: &str) -> Option<Scope> {
        match s {
            "general" => Some(Scope::General),
            "repo" => Some(Scope::Repo),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Scope::General => "general",
            Scope::Repo => "repo",
        }
    }
}

/// `HuddleNote`, fields in Bun's order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Note {
    pub text: String,
    /// "you" (written by the user) or the handle of the agent that proposed it.
    pub by: String,
    /// YYYY-MM-DD.
    pub date: Option<String>,
    /// The huddle it came from.
    pub huddle: Option<String>,
}

/// `LessonInput`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Lesson {
    pub text: String,
    pub evidence: String,
    pub scope: &'static str,
}

/// JS `.`: anything but a line terminator.
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

static LINE: LazyLock<Regex> = LazyLock::new(|| {
    let s = format!("[{}]", js::JS_SPACE_CLASS);
    Regex::new(&format!(r"^- ({DOT}*?)(?:{s}*<!--{s}*({DOT}*?){s}*-->)?{s}*$")).expect("note line pattern")
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{}]+", js::JS_SPACE_CLASS)).expect("space pattern"));
static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new("<!--|-->").expect("comment pattern"));
static FROM: LazyLock<Regex> = LazyLock::new(|| Regex::new("^from @([a-zA-Z0-9_-]+)$").expect("from pattern"));
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}$").expect("date pattern"));
static HUDDLE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[hH][uU][dD][dD][lL][eE] [hH]_[a-zA-Z0-9]+$").expect("huddle pattern"));
static BY: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-zA-Z0-9_-]+$").expect("by pattern"));
static HUDDLE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[hH]_[a-zA-Z0-9]+$").expect("huddle id pattern"));

/// `noteRole`: a role key for a notes file ("_all", or a preset name); None when it can't be one.
pub fn note_role(s: Option<&Value>) -> Option<String> {
    let s = jsv::str_of(s)?;
    if s == ALL_ROLES {
        return Some(ALL_ROLES.into());
    }
    let n = preset_name(s);
    (!n.is_empty() && n == s).then_some(n)
}

/// `noteText`: one line of text: comment markers out, white space runs as one space, trimmed.
pub fn note_text(s: &str) -> String {
    let no_comments = COMMENT.replace_all(s, "");
    let one_line = SPACES.replace_all(&no_comments, " ");
    js::trim(&one_line).to_string()
}

/// `parseNotes`.
pub fn parse_notes(md: &str) -> Vec<Note> {
    let mut out = Vec::new();
    for line in md.split('\n') {
        let Some(m) = LINE.captures(js::trim_end(line)) else { continue };
        let text = js::trim(m.get(1).map_or("", |x| x.as_str()));
        if text.is_empty() {
            continue;
        }
        let src: Vec<&str> = m.get(2).map_or("", |x| x.as_str()).split(',').map(js::trim).collect();
        let from = FROM.captures(src[0]).map(|c| c[1].to_string());
        out.push(Note {
            text: text.to_string(),
            by: from.unwrap_or_else(|| "you".into()),
            date: src.iter().find(|s| DATE.is_match(s)).map(|s| s.to_string()),
            huddle: src.iter().find(|s| HUDDLE.is_match(s)).map(|s| s[7..].to_string()),
        });
    }
    out
}

/// `noteSource`: "from @qa-1, 2026-10-10, huddle h_x" or "by you, 2026-10-10".
pub fn note_source(n: &Note) -> String {
    let mut parts = vec![if n.by == "you" { "by you".to_string() } else { format!("from @{}", n.by) }];
    parts.extend(n.date.clone().filter(|d| !d.is_empty()));
    parts.extend(n.huddle.clone().filter(|h| !h.is_empty()).map(|h| format!("huddle {h}")));
    parts.join(", ")
}

/// `serializeNotes`: the file's text.
pub fn serialize_notes(role: &str, scope: Scope, notes: &[Note]) -> String {
    let who = if role == ALL_ROLES { "all roles".to_string() } else { format!("role {role}") };
    let place = if scope == Scope::General { "all repos" } else { "this repo" };
    let mut s = format!("# Huddle notes: {who}, {place}\n<!-- Newest first. The first {NOTES_CAP} lines go into new agents' instructions. -->\n\n");
    for n in notes {
        s.push_str(&format!("- {} <!-- {} -->\n", note_text(&n.text), note_source(n)));
    }
    s
}

/// `cleanNotes`: notes from a request body, checked (text required, one line, NOTE_MAX), source kept when well formed.
pub fn clean_notes(v: Option<&Value>) -> Result<Vec<Note>, String> {
    let Some(Value::Array(items)) = v else { return Err("notes must be a list".into()) };
    items
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let f = |k: &str| jsv::str_of(jsv::field(Some(x), k));
            let text = note_text(f("text").unwrap_or(""));
            if text.is_empty() {
                return Err(format!("note {} is empty", i + 1));
            }
            let len = js::len16(&text);
            if len > NOTE_MAX {
                return Err(format!("note {} is {len} characters, over the limit of {NOTE_MAX}", i + 1));
            }
            Ok(Note {
                text,
                by: f("by").filter(|b| BY.is_match(b)).unwrap_or("you").to_string(),
                date: f("date").filter(|d| DATE.is_match(d)).map(String::from),
                huddle: f("huddle").filter(|h| HUDDLE_ID.is_match(h)).map(String::from),
            })
        })
        .collect()
}

/// A role's notes in both scopes (`RoleNotes`).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RoleNotes {
    pub general: Vec<Note>,
    pub repo: Vec<Note>,
}

/// `lessonsSection`: the "Lessons from past huddles" part of an agent's system prompt; empty when there are none.
pub fn lessons_section(all: &RoleNotes, role: Option<&RoleNotes>, role_name: Option<&str>) -> String {
    let lines = |ns: &[Note]| ns.iter().take(NOTES_CAP).map(|n| format!("- {}", note_text(&n.text))).collect::<Vec<_>>();
    let every: Vec<String> = [lines(&all.general), lines(&all.repo)].concat();
    let own: Vec<String> = role.map(|r| [lines(&r.general), lines(&r.repo)].concat()).unwrap_or_default();
    let name = role_name.map_or("null".to_string(), String::from);
    let parts: Vec<String> = [("For every role".to_string(), every), (format!("For your role ({name})"), own)]
        .into_iter()
        .filter(|(_, ls)| !ls.is_empty())
        .map(|(title, ls)| format!("{title}:\n{}", ls.join("\n")))
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    format!(
        "# Lessons from past huddles\nThe user saved these from earlier huddles. Follow them unless the brief or the user says otherwise here.\n{}",
        parts.join("\n")
    )
}

/// `cleanLessons`: lessons from a huddle_status / huddle_post call, checked.
pub fn clean_lessons(v: Option<&Value>) -> Result<Vec<Lesson>, String> {
    let items = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("lessons must be a list of {text, evidence, scope}".into()),
    };
    if items.len() > MAX_LESSONS {
        return Err(format!("at most {MAX_LESSONS} lessons; keep only the ones most worth reusing"));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let f = |k: &str| jsv::field(Some(x), k);
            let text = note_text(jsv::str_of(f("text")).unwrap_or(""));
            if text.is_empty() {
                return Err(format!("lesson {}: text is required, written as a rule", i + 1));
            }
            let len = js::len16(&text);
            if len > LESSON_MAX {
                return Err(format!("lesson {} is {len} characters, over the limit of {LESSON_MAX}; write it as one short rule", i + 1));
            }
            let scope = match jsv::or(f("scope"), None) {
                None => "general",
                Some(v) if v == "general" => "general",
                Some(v) if v == "repo" => "repo",
                Some(_) => return Err(format!("lesson {}: scope must be general or repo", i + 1)),
            };
            let evidence = js::slice16(&note_text(jsv::str_of(f("evidence")).unwrap_or("")), LESSON_MAX).to_string();
            Ok(Lesson { text, evidence, scope })
        })
        .collect()
}
