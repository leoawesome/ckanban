//! `web/src/features/ticket/questionForms.ts`: which question forms in a chat are open, answered, closed or asked again,
//! the progress that carries between them, the answers message a form sends and whether a reply only repeats its form.
//! Saved progress comes from the user's browser, so it is read as loose JSON and checked like Bun does.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::js::{self, JS_SPACE_CLASS};
use super::types::Question;

/// One answer: the picked options and the typed text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Answer {
    pub picked: Vec<String>,
    pub other_on: bool,
    pub other: String,
}

fn question_sig(q: &Question) -> Value {
    json!([q.question, q.options.iter().map(|o| o.label.clone()).collect::<Vec<_>>()])
}

/// Ties saved progress to these exact questions (`signature`).
pub fn signature(questions: &[Question]) -> String {
    Value::Array(questions.iter().map(question_sig).collect()).to_string()
}

/// A question's starting answer: its recommended option, else (single choice) its first (`initial`).
pub fn initial(q: &Question) -> Answer {
    let rec = q.options.iter().find(|o| o.recommended.unwrap_or(false)).or_else(|| {
        if q.multi_select.unwrap_or(false) { None } else { q.options.first() }
    });
    Answer { picked: rec.map(|o| vec![o.label.clone()]).unwrap_or_default(), other_on: false, other: String::new() }
}

/// Fresh progress for these questions (`fresh`), as JSON.
pub fn fresh(questions: &[Question]) -> Value {
    json!({
        "sig": signature(questions),
        "answers": questions.iter().map(initial).collect::<Vec<_>>(),
        "step": 0,
        "note": "",
    })
}

fn valid_answer(a: Option<&Value>) -> bool {
    match a {
        Some(Value::Object(m)) => m.get("picked").is_some_and(Value::is_array) && m.get("other").is_some_and(Value::is_string),
        _ => false,
    }
}

/// Where a form starts (`startProgress`): its own saved progress, else what carries over question by question from an
/// earlier form it replaced, else fresh.
pub fn start_progress(questions: &[Question], saved: Option<&Value>) -> Value {
    let sig = signature(questions);
    let obj = saved.and_then(Value::as_object);
    if let Some(s) = obj {
        let answers = s.get("answers").and_then(Value::as_array);
        if s.get("sig").and_then(Value::as_str) == Some(sig.as_str())
            && answers.is_some_and(|a| a.len() == questions.len() && a.iter().all(|x| valid_answer(Some(x))))
        {
            return saved.cloned().unwrap_or(Value::Null);
        }
    }
    let mut base = fresh(questions);
    let Some(s) = obj else { return base };
    let (Some(saved_sig), Some(saved_answers)) = (s.get("sig").and_then(Value::as_str), s.get("answers").and_then(Value::as_array)) else {
        return base;
    };
    let old: Vec<String> = match serde_json::from_str::<Value>(saved_sig) {
        Ok(Value::Array(items)) => items.iter().map(Value::to_string).collect(),
        _ => Vec::new(),
    };
    let base_answers = base["answers"].as_array().cloned().unwrap_or_default();
    let answers: Vec<Value> = questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let key = question_sig(q).to_string();
            let a = old.iter().position(|o| *o == key).and_then(|j| saved_answers.get(j));
            if valid_answer(a) { a.cloned().unwrap_or(Value::Null) } else { base_answers[i].clone() }
        })
        .collect();
    base["answers"] = Value::Array(answers);
    base["note"] = Value::String(s.get("note").and_then(Value::as_str).unwrap_or("").to_string());
    base
}

/// A chat entry's fields the form states read (`SessionEntry` in questionForms.ts).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FormEntry {
    pub uuid: String,
    pub role: String,
    pub kind: String,
    pub huddle_id: Option<String>,
    pub peer: Option<Peer>,
    pub questions: Option<Vec<Question>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Peer {
    pub automation: Option<String>,
}

/// A form's state (`FormState`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum FormState {
    Open { key: String },
    Answered {
        #[serde(skip_serializing_if = "Option::is_none")]
        by: Option<usize>,
    },
    Closed,
    Replaced { same: bool },
}

fn answers_forms(e: &FormEntry) -> bool {
    e.role == "user"
        && e.kind == "text"
        && js::some_text(&e.huddle_id).is_none()
        && e.peer.as_ref().and_then(|p| js::some_text(&p.automation)).is_none()
}

/// The state of every questions form in the chat, by entry index, in the order Bun's Map holds them (`formStates`).
pub fn form_states(entries: &[FormEntry], replying: bool, closed: &[String], close_latest: bool) -> Vec<(usize, FormState)> {
    let mut out: Vec<(usize, FormState)> = Vec::new();
    let set = |out: &mut Vec<(usize, FormState)>, i: usize, s: FormState| match out.iter_mut().find(|(k, _)| *k == i) {
        Some(slot) => slot.1 = s,
        None => out.push((i, s)),
    };
    let mut chain: Option<(String, usize)> = None;
    for (i, e) in entries.iter().enumerate() {
        if answers_forms(e) {
            if let Some((_, last)) = &chain {
                set(&mut out, *last, FormState::Answered { by: Some(i) });
            }
            chain = None;
            continue;
        }
        let Some(qs) = &e.questions else { continue };
        if let Some((_, last)) = &chain {
            let prev = entries[*last].questions.as_deref().unwrap_or(&[]);
            set(&mut out, *last, FormState::Replaced { same: signature(prev) == signature(qs) });
        }
        let key = chain.as_ref().map(|(k, _)| k.clone()).unwrap_or_else(|| e.uuid.clone());
        chain = Some((key.clone(), i));
        set(&mut out, i, FormState::Open { key });
        if closed.contains(&e.uuid) {
            set(&mut out, i, FormState::Closed);
            chain = None;
        }
    }
    if let Some((_, last)) = chain {
        if replying {
            set(&mut out, last, FormState::Answered { by: None });
        } else if close_latest {
            set(&mut out, last, FormState::Closed);
        }
    }
    out
}

static ANSWERS_HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^[{JS_SPACE_CLASS}]*My answers:\n")).unwrap());

/// The answers in the message a form sent, paired with its questions by their text (`parseAnswers`).
pub fn parse_answers(text: &str, questions: &[Question]) -> (Vec<Option<String>>, String) {
    let Some(m) = ANSWERS_HEAD.find(text) else { return (questions.iter().map(|_| None).collect(), String::new()) };
    let lines: Vec<&str> = text[m.end()..].split('\n').collect();
    let mut items: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        if let Some(rest) = l.strip_prefix("- ") {
            items.push(rest.to_string());
        } else if l.starts_with("  ") && !items.is_empty() {
            let last = items.last_mut().expect("an item");
            last.push('\n');
            last.push_str(&l[2..]);
        } else {
            break;
        }
        i += 1;
    }
    let note = js::trim(&lines[i..].join("\n")).to_string();
    let mut used = vec![false; items.len()];
    let answers = questions
        .iter()
        .map(|q| {
            let head = format!("{} → ", q.question);
            let j = items.iter().enumerate().position(|(k, it)| !used[k] && it.starts_with(&head))?;
            used[j] = true;
            // The pick alone: newer messages add " (not your pick: …)" for Claude when it differs from the recommended one.
            Some(js::trim(&NOT_YOUR_PICK.replace(&items[j][head.len()..], "")).to_string())
        })
        .collect();
    (answers, note)
}

/// The note `answers_message` adds after a single pick that differs from Claude's recommended option.
static NOT_YOUR_PICK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" \(not your pick: [^\n]*\)$").unwrap());

/// One answer as the sent message shows it (`answerText`).
pub fn answer_text(a: &Answer) -> String {
    let mut parts = a.picked.clone();
    let other = js::trim(&a.other);
    if a.other_on && !other.is_empty() {
        parts.push(other.to_string());
    }
    // Older messages said "(no preference)" here; parse_answers shows either as written.
    if parts.is_empty() { "skipped".into() } else { parts.join("; ").replace('\n', "\n  ") }
}

static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{JS_SPACE_CLASS}]*\n[{JS_SPACE_CLASS}]*")).unwrap());

/// What Claude reads for one answer (`answerForClaude`): `answer_text`, plus " (not your pick: <recommended>)" when the
/// user picked one option of a pick-one question and it isn't the one Claude recommended.
fn answer_for_claude(q: &Question, a: &Answer) -> String {
    let text = answer_text(a);
    let rec = if q.multi_select == Some(true) { None } else { q.options.iter().find(|o| o.recommended == Some(true)) };
    match rec {
        Some(rec) if a.picked.len() == 1 && a.picked[0] != rec.label => {
            format!("{text} (not your pick: {})", js::trim(&LINE_BREAK.replace_all(&rec.label, " ")))
        }
        _ => text,
    }
}

/// The one chat message a form sends (`answersMessage`).
pub fn answers_message(questions: &[Question], answers: &[Answer], note: &str) -> String {
    let empty = Answer::default();
    let lines: Vec<String> =
        questions.iter().enumerate().map(|(i, q)| format!("- {} → {}", q.question, answer_for_claude(q, answers.get(i).unwrap_or(&empty)))).collect();
    let note = js::trim(note);
    format!("My answers:\n{}{}", lines.join("\n"), if note.is_empty() { String::new() } else { format!("\n\n{note}") })
}

static LINK_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\]\([^){JS_SPACE_CLASS}]*\)")).unwrap());
static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

/// Words only: lower case, no marks, punctuation or extra spaces.
fn words(s: &str) -> String {
    let lower = s.to_lowercase();
    let a = LINK_TARGET.replace_all(&lower, " ");
    let b = NOT_WORD.replace_all(&a, " ");
    js::trim(&b).to_string()
}

/// `text.split(/\n+|(?<=[.!?:])\s+/)`.
fn split_sentences(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut parts = Vec::new();
    let mut from = 0;
    let mut k = 0;
    while k < chars.len() {
        let (pos, c) = chars[k];
        let mut end = k;
        if c == '\n' {
            while end < chars.len() && chars[end].1 == '\n' {
                end += 1;
            }
        } else if k > 0 && matches!(chars[k - 1].1, '.' | '!' | '?' | ':') && js::is_js_space(c) {
            while end < chars.len() && js::is_js_space(chars[end].1) {
                end += 1;
            }
        }
        if end > k {
            parts.push(&text[from..pos]);
            from = chars.get(end).map(|(p, _)| *p).unwrap_or(text.len());
            k = end;
        } else {
            k += 1;
        }
    }
    parts.push(&text[from..]);
    parts
}

/// Whether a reply only repeats a questions form it follows (`repeatsForm`).
pub fn repeats_form(text: &str, questions: &[Question]) -> bool {
    let all: Vec<&str> = questions
        .iter()
        .flat_map(|q| {
            let mut v = vec![q.question.as_str(), q.context.as_deref().unwrap_or("")];
            for o in &q.options {
                v.push(&o.label);
                v.push(o.description.as_deref().unwrap_or(""));
            }
            v
        })
        .collect();
    let form = format!(" {} ", words(&all.join("\n")));
    let parts: Vec<String> = split_sentences(text).into_iter().map(words).filter(|p| !p.is_empty()).collect();
    let total: usize = parts.iter().map(|p| js::len16(p)).sum();
    if total == 0 {
        return false;
    }
    let repeated: Vec<&String> = parts.iter().filter(|p| form.contains(&format!(" {p} "))).collect();
    let asked_text: Vec<&str> = questions.iter().flat_map(|q| [q.question.as_str(), q.context.as_deref().unwrap_or("")]).collect();
    let asked = format!(" {} ", words(&asked_text.join("\n")));
    if !repeated.iter().any(|p| p.contains(' ') && asked.contains(&format!(" {p} "))) {
        return false;
    }
    let rep: usize = repeated.iter().map(|p| js::len16(p)).sum();
    rep as f64 / total as f64 >= 0.8
}
