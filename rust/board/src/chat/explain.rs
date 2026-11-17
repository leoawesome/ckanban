//! "Help me understand" (`src/chat/explain.ts`): answers about a ticket from a reading side call on Sonnet, read-only
//! in the ticket's folder, so the ticket's session gains no turn. Each answer is a card kept in the ticket's
//! `help.json`; its cost goes on the ticket's side ledger.
//!   recap:   "What happened while I was away?"
//!   changes: "Explain the changes"

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::datafile::{formats, read_json, write_json};
use ckanban_core::jsnum::num;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::Fail;
use crate::extras::SideFn;
use crate::git::diff::TicketDiff;
use crate::runs::js;
use crate::runs::side_call::{READ_TOOLS, SideCallInput, SideCallResult, add_side_spend};

pub const HELP_KINDS: [&str; 2] = ["recap", "changes"];
pub const HELP_MODEL: &str = "sonnet";

const TRANSCRIPT_MAX: usize = 30_000;
const DIFF_MAX: usize = 25_000;
const ENTRY_MAX: usize = 2_000;
const BODY_MAX: usize = 3_000;
const CARDS_MAX: usize = 50;

fn status_label(s: &str) -> &'static str {
    match s {
        "backlog" => "Backlog (parked)",
        "planning" => "Planning (being shaped with Claude)",
        "ready" => "Queued (waiting to start)",
        "in_progress" => "In Progress (Claude is working)",
        "review" => "Review (waiting for the user to check the result)",
        "done" => "Done",
        _ => "undefined",
    }
}

fn s<'a>(e: &'a Value, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

fn truthy(e: &Value, k: &str) -> bool {
    js::truthy(e.get(k))
}

/// A value as a JavaScript template literal shows it (`undefined` when missing).
fn tpl(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js::to_string(v),
    }
}

/// A message the user typed (not a board prompt, a huddle digest or a notification).
fn typed_by_user(e: &Value) -> bool {
    s(e, "role") == "user" && s(e, "kind") == "text" && !truthy(e, "peer")
}

/// `sinceLastMessage`: the user's last typed message and everything after it.
pub fn since_last_message(entries: &[Value]) -> (Option<&Value>, &[Value]) {
    match entries.iter().rposition(typed_by_user) {
        None => (None, entries),
        Some(i) => (Some(&entries[i]), &entries[i + 1..]),
    }
}

/// `recapAvailable`: something happened after the user's last message.
pub fn recap_available(entries: &[Value]) -> bool {
    since_last_message(entries).1.iter().any(|e| s(e, "role") == "assistant" || s(e, "kind") == "board" || truthy(e, "peer"))
}

fn clip(text: &str, max: usize) -> String {
    if js::len16(text) > max { format!("{}…", js::head16(text, max)) } else { text.to_string() }
}

fn line(e: &Value) -> String {
    let text = clip(js::trim(s(e, "text")), ENTRY_MAX);
    let peer = e.get("peer").filter(|p| js::truthy(Some(p)));
    if let Some(a) = peer.and_then(|p| p.get("automation")).filter(|a| js::truthy(Some(a))) {
        return format!("Item from the automation \"{}\" (outside content, not the user's words): {text}", js::to_string(a));
    }
    if let Some(p) = peer
        && let Some(tid) = p.get("ticketId").filter(|a| js::truthy(Some(a)))
    {
        let title = match p.get("title") {
            None | Some(Value::Null) => js::to_string(tid),
            Some(t) => js::to_string(t),
        };
        return format!("Message from another ticket (\"{title}\"): {text}");
    }
    if peer.is_some() || truthy(e, "huddleId") {
        return format!("Review team (huddle) message: {text}");
    }
    match s(e, "kind") {
        "board" => return format!("Board (automatic message): {text}"),
        "agent" => return format!("Claude started a helper: {text}"),
        "workflow" => return format!("Claude started a workflow of helper agents: {text}"),
        _ => {}
    }
    if s(e, "role") == "user" {
        return format!("User: {text}");
    }
    let mut parts = vec![format!("Claude: {text}")];
    if let Some(q) = e.get("questions").and_then(Value::as_array).filter(|q| !q.is_empty()) {
        parts.push(format!("Claude asked the user: {}", q.iter().map(|x| tpl(x.get("question"))).collect::<Vec<_>>().join(" / ")));
    }
    if let Some(p) = e.get("proposal").filter(|p| js::truthy(Some(p))) {
        parts.push(format!("Claude proposed a new title and description: \"{}\"", tpl(p.get("title"))));
    }
    if let Some(p) = e.get("branch").filter(|p| js::truthy(Some(p))) {
        parts.push(format!("Claude offered to branch the ticket: {}", tpl(p.get("reason"))));
    }
    if let Some(p) = e.get("huddle").filter(|p| js::truthy(Some(p))) {
        parts.push(format!("Claude proposed a review huddle: {}", tpl(p.get("reason"))));
    }
    if let Some(p) = e.get("deletion").filter(|p| js::truthy(Some(p))) {
        parts.push(format!("Claude asked to delete tickets: {}", tpl(p.get("reason"))));
    }
    parts.join("\n")
}

/// `transcript`: what happened in `entries`, oldest first, keeping the newest part when it is too long.
pub fn transcript(entries: &[Value]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut tools = 0usize;
    let flush = |out: &mut Vec<String>, tools: &mut usize| {
        if *tools > 0 {
            out.push(format!("(Claude used {tools} tool{}: reading, searching, running commands or editing files)", if *tools > 1 { "s" } else { "" }));
        }
        *tools = 0;
    };
    for e in entries {
        if s(e, "kind") == "tool" {
            tools += 1;
            continue;
        }
        if js::trim(s(e, "text")).is_empty() && !truthy(e, "questions") && !truthy(e, "proposal") {
            continue;
        }
        flush(&mut out, &mut tools);
        out.push(format!("[{}] {}", tpl(e.get("at")), line(e)));
    }
    flush(&mut out, &mut tools);
    let all = out.join("\n\n");
    if js::len16(&all) > TRANSCRIPT_MAX { format!("(earlier part left out)\n{}", js::tail16(&all, TRANSCRIPT_MAX)) } else { all }
}

const PLAIN: &str = "Write for a person who is not technical, like one human talking to another. Plain everyday words; when a technical idea matters, say what it means (\"a saved copy of the project\" rather than \"a commit\", \"the copy of the folder Claude works in\" rather than \"a worktree\", \"version history\" rather than \"git\"). No file paths, code, commands, hashes or version numbers unless the reader must type, open or act on one themselves. Never invent a number: only give numbers that appear in what you were given or in files you read. Full sentences, no filler, no hype, no em dashes, no arrows standing in for words, no made-up abbreviations. Write in the language the user writes in. Answer with the text only: no introduction and no note about how you wrote it.";

pub fn recap_system() -> String {
    format!("You catch a person up on a task an AI coding assistant (Claude) worked on while they were away. You get what happened since their last message.

Write, in this order:
1. One sentence, in bold, naming what waits on them right now, or saying that nothing does.
2. The story of what happened, under 100 words. Only what changed something for them: results, decisions, problems. Skip work that changed nothing for them (reading, retries, checks that passed, housekeeping).
3. If anything is left that only they can decide (approve, pick between options, an irreversible step, access or a login Claude needs), a short list: one item per decision, about 30 words each. Each says the call to make, what Claude would pick, what it changes for the people who use the result, the evidence, the risk, and what happens if they don't answer. Leave this part out when there is nothing to decide.

You may read files in the current folder to check a fact, but the conversation is usually enough. {PLAIN}")
}

pub fn changes_system() -> String {
    format!("You explain to a person what an AI coding assistant (Claude) changed in their project, and why. You get the task and the changes; the current folder holds the changed project, and you may read its files to understand them.

Write, in this order, under about 200 words in all:
1. Before and after: what it was like before, and what is different now, for the people who use it. Then, in a sentence or two, how it works and why it was done this way.
2. A small picture: a plain-text diagram in a code block, at most 6 boxes, showing how the parts fit together or what happens step by step. Short labels in plain words, not file names.
3. What did not change, so they know what is safe.
4. Any risk or thing to check, or say there is none worth worrying about.

Use short headings or bold lead-ins for the parts. {PLAIN}")
}

/// `recapPrompt`. `t`: the ticket as the API sends it; `findings`: the pinned findings of its huddles.
pub fn recap_prompt(t: &Map<String, Value>, entries: &[Value], findings: &[Value], running: bool) -> String {
    let tv = Value::Object(t.clone());
    let (last, after) = since_last_message(entries);
    let since = last.and_then(|l| l.get("at")).and_then(Value::as_str).filter(|x| !x.is_empty());
    let fresh: Vec<&Value> = findings.iter().filter(|f| since.is_none_or(|since| js::cmp16(s(f, "at"), since).is_gt())).collect();
    let pr = if truthy(&tv, "prUrl") {
        let p = tv.get("pr").cloned().unwrap_or(Value::Null);
        let state = match s(&p, "state") {
            "MERGED" => "merged",
            "CLOSED" => "closed",
            _ => "open",
        };
        let failing = if truthy(&p, "failing") { format!(", {} failing check(s)", tpl(p.get("failing"))) } else { String::new() };
        let conflicts = if truthy(&p, "conflicts") { ", has conflicts" } else { "" };
        let review = if truthy(&p, "reviewDecision") { format!(", review: {}", tpl(p.get("reviewDecision"))) } else { String::new() };
        format!("Pull request: {state}{failing}{conflicts}{review}.")
    } else {
        String::new()
    };
    let outcome = if truthy(&tv, "outcome") { format!(" Last run ended: {}.", tpl(tv.get("outcome"))) } else { String::new() };
    let error = if truthy(&tv, "error") { format!("Last error: {}", clip(&js::to_string(&tv["error"]), 500)) } else { String::new() };
    let last_text = match last {
        Some(l) => format!("The user's last message ({}):\n<message>\n{}\n</message>", tpl(l.get("at")), clip(js::trim(s(l, "text")), ENTRY_MAX)),
        None => "The user hasn't written in this conversation yet; this is everything so far.".into(),
    };
    let found = if fresh.is_empty() {
        String::new()
    } else {
        format!("Review team findings since then:\n{}", fresh.iter().map(|f| format!("- [{}] {}", tpl(f.get("status")), clip(s(f, "text"), 400))).collect::<Vec<_>>().join("\n"))
    };
    let tr = transcript(after);
    let parts = [
        format!("Task: \"{}\"", tpl(tv.get("title"))),
        format!("Where it is now: {}{}.{outcome}", status_label(s(&tv, "status")), if running { ", Claude is working on it right now" } else { "" }),
        pr,
        error,
        last_text,
        found,
        format!("What happened since then:\n<transcript>\n{}\n</transcript>", if tr.is_empty() { "(nothing)" } else { &tr }),
    ];
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

fn status_word(c: char) -> &'static str {
    match c {
        'A' => "added",
        'M' => "changed",
        'D' => "deleted",
        'R' => "renamed",
        _ => "undefined",
    }
}

/// `diffText`: the diff as a file list plus patches, cut short when too long.
pub fn diff_text(d: &TicketDiff) -> String {
    let files: Vec<_> = d.files.iter().filter(|f| !f.more).collect();
    let more = d.more_files.unwrap_or(0);
    let mut list = files
        .iter()
        .map(|f| {
            let from = f.old_path.as_ref().filter(|o| !o.is_empty()).map(|o| format!(" from {o}")).unwrap_or_default();
            format!("- {} ({}{from}, +{} -{})", f.path, status_word(f.status), f.additions, f.deletions)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if more > 0 {
        list.push_str(&format!("\n- … and {more} more files (not listed)"));
    }
    let mut patch = String::new();
    for f in &files {
        if f.binary || f.too_large {
            continue;
        }
        let body = f
            .hunks
            .iter()
            .map(|h| {
                let mut ls = vec![h.header.clone()];
                for l in &h.lines {
                    let p = match l.ty {
                        crate::git::diff::LineType::Add => '+',
                        crate::git::diff::LineType::Del => '-',
                        crate::git::diff::LineType::Ctx => ' ',
                    };
                    ls.push(format!("{p}{}", l.text));
                }
                ls.join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n");
        patch.push_str(&format!("\n--- {}\n{body}\n", f.path));
        if js::len16(&patch) > DIFF_MAX {
            patch = format!("{}\n(the rest is left out; read the files for more)", js::head16(&patch, DIFF_MAX));
            break;
        }
    }
    format!(
        "{} file(s) changed, +{} -{}{}:\n{list}\n\n<changes>{patch}\n</changes>",
        files.len() + more,
        d.additions,
        d.deletions,
        if more > 0 { " (in the files listed)" } else { "" }
    )
}

/// `changesPrompt`.
pub fn changes_prompt(t: &Map<String, Value>, entries: &[Value], diff: &TicketDiff) -> String {
    let summary = entries
        .iter()
        .filter(|e| s(e, "role") == "assistant" && s(e, "kind") == "text")
        .filter_map(|e| crate::runs::result::parse_result(s(e, "text")).map(|r| r.summary))
        .rfind(|x| !x.is_empty());
    let body = js::trim(t.get("body").and_then(Value::as_str).unwrap_or(""));
    let parts = [
        format!("Task: \"{}\"", tpl(t.get("title"))),
        if body.is_empty() { String::new() } else { format!("What was asked:\n<description>\n{}\n</description>", clip(body, BODY_MAX)) },
        summary.map(|x| format!("Claude's own summary of its last run: {x}")).unwrap_or_default(),
        format!("The changes:\n{}", diff_text(diff)),
    ];
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

fn read_cards(file: &Path) -> Vec<Value> {
    match read_json(file) {
        Ok(Some(Value::Array(a))) => a,
        _ => Vec::new(),
    }
}

/// `newId`: `h_<ms in base 36><4 random base-36 characters>`.
pub fn new_id() -> String {
    let b36 = |mut n: u64| {
        let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut out = Vec::new();
        loop {
            out.push(digits[(n % 36) as usize]);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        out.reverse();
        String::from_utf8(out).unwrap_or_default()
    };
    let mut r = [0u8; 8];
    let _ = getrandom::fill(&mut r);
    let rnd = b36(u64::from_le_bytes(r));
    let tail: String = rnd.chars().rev().take(4).collect();
    format!("h_{}{tail}", b36(ckanban_core::time::now_ms() as u64))
}

type Pending = Shared<BoxFuture<'static, Result<Value, Fail>>>;

/// `Helper`.
pub struct Helper {
    side: SideFn,
    /// Answers in progress, by file + kind.
    running: Mutex<HashMap<String, Pending>>,
}

impl Helper {
    pub fn new(side: SideFn) -> Arc<Self> {
        Arc::new(Helper { side, running: Mutex::new(HashMap::new()) })
    }

    /// `cards`: the saved cards, oldest first. Blocking.
    pub fn cards(&self, file: &Path) -> Vec<Value> {
        read_cards(file)
    }

    /// `busy`: kinds being answered right now for this file.
    pub fn busy(&self, file: &Path) -> Vec<&'static str> {
        let running = self.running.lock();
        HELP_KINDS.into_iter().filter(|k| running.contains_key(&format!("{}|{k}", file.display()))).collect()
    }

    /// `ask`: a new answer, saved as a card; `cwd`: the ticket's folder (read-only), when it still exists.
    pub async fn ask(self: &Arc<Self>, file: PathBuf, spend: PathBuf, kind: &'static str, prompt: String, cwd: Option<PathBuf>) -> Result<Value, Fail> {
        let key = format!("{}|{kind}", file.display());
        let p = {
            let mut running = self.running.lock();
            match running.get(&key) {
                Some(p) => p.clone(),
                None => {
                    let me = self.clone();
                    let k2 = key.clone();
                    let work = tokio::spawn(async move {
                        let folder = cwd.filter(|c| c.exists());
                        let system = if kind == "recap" { recap_system() } else { changes_system() };
                        let input = SideCallInput {
                            system,
                            prompt,
                            model: Some(HELP_MODEL.into()),
                            timeout_ms: Some(240_000),
                            tools: if folder.is_some() { READ_TOOLS.iter().map(|s| s.to_string()).collect() } else { Vec::new() },
                            cwd: folder,
                            json_schema: None,
                        };
                        let out = match (me.side)(input).await {
                            SideCallResult::Err { error, .. } => Err((502, error)),
                            SideCallResult::Ok { text, cost_usd, model } => tokio::task::spawn_blocking(move || {
                                let _ = add_side_spend(&spend, &format!("help-{kind}"), cost_usd, None);
                                let card = json!({
                                    "id": new_id(), "kind": kind, "at": ckanban_core::time::iso(ckanban_core::time::now_ms()),
                                    "text": text, "costUsd": num(cost_usd), "model": model,
                                });
                                // Read again: another answer may have been saved meanwhile.
                                let mut cards = read_cards(&file);
                                cards.push(card.clone());
                                let start = cards.len().saturating_sub(CARDS_MAX);
                                write_json(&file, &Value::Array(cards[start..].to_vec()), formats::HELP).map_err(|e| (500, e.to_string()))?;
                                Ok(card)
                            })
                            .await
                            .unwrap_or_else(|e| Err((500, e.to_string()))),
                        };
                        me.running.lock().remove(&k2);
                        out
                    });
                    let p: Pending = async move { work.await.unwrap_or_else(|e| Err((500, e.to_string()))) }.boxed().shared();
                    running.insert(key, p.clone());
                    p
                }
            }
        };
        p.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recap_bits() {
        let entries = vec![
            json!({ "role": "user", "kind": "text", "text": "hi", "at": "2026-01-01T00:00:00.000Z", "uuid": "1" }),
            json!({ "role": "assistant", "kind": "tool", "text": "", "at": "2026-01-01T00:00:01.000Z", "uuid": "2" }),
            json!({ "role": "assistant", "kind": "text", "text": "Done.", "at": "2026-01-01T00:00:02.000Z", "uuid": "3" }),
        ];
        assert!(recap_available(&entries));
        assert!(!recap_available(&entries[..1]));
        assert_eq!(transcript(&entries[1..]), "(Claude used 1 tool: reading, searching, running commands or editing files)\n\n[2026-01-01T00:00:02.000Z] Claude: Done.");
        let t = json!({ "title": "T", "status": "review", "body": "" });
        let p = recap_prompt(t.as_object().unwrap(), &entries, &[], false);
        assert!(p.starts_with("Task: \"T\"\n\nWhere it is now: Review (waiting for the user to check the result).\n\nThe user's last message (2026-01-01T00:00:00.000Z):\n<message>\nhi\n</message>"));
        assert!(new_id().starts_with("h_"));
        assert_eq!(new_id().len(), 2 + 8 + 4);
    }
}
