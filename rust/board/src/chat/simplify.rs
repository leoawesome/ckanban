//! "Say it simpler" (`src/chat/simplify.ts`): a Claude reply rewritten in plain words by a side call, so the chat's
//! session gains no turn. Rewrites are kept per message in the ticket's `simplified.json` (a quick chat's
//! `<id>.simplified.json`): a second click, a reload or another device gets the saved one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ckanban_core::datafile::{formats, read_json, write_json};
use ckanban_core::jsnum::num;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::Fail;
use crate::extras::SideFn;
use crate::runs::js;
use crate::runs::side_call::{SideCallInput, SideCallResult, add_side_spend};

/// Replies shorter than this have nothing to simplify.
pub const SIMPLIFY_MIN_WORDS: usize = 25;
/// Bump when SIMPLIFY_SYSTEM changes what a rewrite looks like.
pub const SIMPLIFY_VERSION: u64 = 2;

pub const SIMPLIFY_SYSTEM: &str = "You rewrite one message an AI coding assistant sent to a person who is not technical. Restate it. Stop using jargon and speak coherently. State it more simply and concisely, like one human talking to another.

Rules:
- Keep every fact, decision, result and question that matters to the reader. Drop the rest. Never add anything new.
- Plain everyday words. Say what a technical term means instead of using it (\"a saved copy of the project\" rather than \"a commit\"; \"the copy of the folder Claude works in\" rather than \"a worktree\").
- No file paths, file names, code, commands, version numbers or hashes, unless the reader must type, open or act on one themselves.
- Leave out how the work was done and checked (test counts, builds, merges, restarts) unless something went wrong or the reader must wait or act; \"it was checked and works\" is enough.
- Whole sentences, also in list items. No arrows, no symbols standing in for words, no abbreviations, no filler, no hype.
- Light formatting (Markdown) where it makes the message easier to scan: short paragraphs with a blank line between them; **bold** for the one key point, or for what the reader must do or answer; a bullet list when there are three or more items of the same kind (options, steps, results). If the message is a list of items, the rewrite can stay a list. No headings, tables or code blocks.
- If the message asks the reader something or needs them to act, say that clearly, at the end.
- Short: usually two to four sentences, or a short list. Much shorter than the original.
- Write in the same language as the message.
- Answer with the rewritten message only: no introduction, no title, no note about what you changed.";

pub fn simplify_prompt(title: &str, text: &str) -> String {
    format!("The message is about the task \"{title}\".\n\n<message>\n{text}\n</message>")
}

/// `replyText`: the reply as the chat shows it (the first result line taken out).
pub fn reply_text(text: &str) -> String {
    static RESULT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^.*CKANBAN_RESULT:.*$").unwrap());
    js::trim(&RESULT_LINE.replace(text, "")).to_string()
}

pub fn word_count(text: &str) -> usize {
    text.split(js::is_ws).filter(|w| !w.is_empty()).count()
}

fn s<'a>(e: &'a Value, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `simplifiable`: Claude's own text (not a tool row, card or command output), long enough.
pub fn simplifiable(e: &Value) -> bool {
    s(e, "role") == "assistant"
        && s(e, "kind") == "text"
        && !js::truthy(e.get("commandOutput"))
        && !js::truthy(e.get("peer"))
        && !js::truthy(e.get("huddleId"))
        && word_count(&reply_text(s(e, "text"))) >= SIMPLIFY_MIN_WORDS
}

fn hash(text: &str) -> String {
    super::sha256::hex(text.as_bytes())[..16].to_string()
}

/// A saved rewrite still good for a reply with this source hash.
fn fresh(saved: Option<&Value>, source: &str) -> bool {
    saved.is_some_and(|v| v.get("source").and_then(Value::as_str) == Some(source) && v.get("version").and_then(Value::as_f64) == Some(SIMPLIFY_VERSION as f64))
}

fn read_saved(file: &Path) -> Map<String, Value> {
    match read_json(file) {
        Ok(Some(Value::Object(m))) => m,
        _ => Map::new(),
    }
}

type Pending = Shared<BoxFuture<'static, Result<String, Fail>>>;

/// `Simplifier`.
pub struct Simplifier {
    side: SideFn,
    /// Rewrites in progress, by file + message: a double click or a second device waits for the same call.
    running: Mutex<HashMap<String, Pending>>,
}

impl Simplifier {
    pub fn new(side: SideFn) -> Arc<Self> {
        Arc::new(Simplifier { side, running: Mutex::new(HashMap::new()) })
    }

    /// `savedIn`: the saved rewrites in one file by message uuid (only ones still matching their reply). Blocking.
    pub fn saved_in(&self, file: &Path, entries: &[Value]) -> Value {
        let saved = read_saved(file);
        let mut out = Map::new();
        for e in entries {
            let uuid = s(e, "uuid");
            if let Some(v) = saved.get(uuid)
                && fresh(Some(v), &hash(&reply_text(s(e, "text"))))
            {
                out.insert(uuid.to_string(), v.get("text").cloned().unwrap_or(Value::Null));
            }
        }
        Value::Object(out)
    }

    /// `simplifyIn`: the plain-words version of one reply, saved in `file`, its cost logged in `spend`.
    pub async fn simplify_in(self: &Arc<Self>, file: PathBuf, spend: PathBuf, title: &str, entry: &Value) -> Result<Value, Fail> {
        if !simplifiable(entry) {
            return Err((400, "this message is too short to simplify".into()));
        }
        let original = reply_text(s(entry, "text"));
        let source = hash(&original);
        let uuid = s(entry, "uuid").to_string();
        let f2 = file.clone();
        let hit = tokio::task::spawn_blocking(move || read_saved(&f2)).await.unwrap_or_default().remove(&uuid);
        if fresh(hit.as_ref(), &source) {
            return Ok(json!({ "text": hit.and_then(|h| h.get("text").cloned()).unwrap_or(Value::Null), "cached": true }));
        }
        let key = format!("{}|{uuid}", file.display());
        let p = {
            let mut running = self.running.lock();
            match running.get(&key) {
                Some(p) => p.clone(),
                None => {
                    let me = self.clone();
                    let (k2, prompt) = (key.clone(), simplify_prompt(title, &original));
                    let work = tokio::spawn(async move {
                        let r = (me.side)(SideCallInput { system: SIMPLIFY_SYSTEM.into(), prompt, ..Default::default() }).await;
                        let out = match r {
                            SideCallResult::Err { error, .. } => Err((502, error)),
                            SideCallResult::Ok { text, cost_usd, model } => tokio::task::spawn_blocking(move || {
                                let _ = add_side_spend(&spend, "simplify", cost_usd, None);
                                // Read again: other messages may have been saved meanwhile.
                                let mut saved = read_saved(&file);
                                let at = ckanban_core::time::iso(ckanban_core::time::now_ms());
                                saved.insert(
                                    uuid,
                                    json!({ "text": text, "version": SIMPLIFY_VERSION, "source": source, "at": at, "costUsd": num(cost_usd), "model": model }),
                                );
                                write_json(&file, &Value::Object(saved), formats::SIMPLIFIED).map_err(|e| (500, e.to_string()))?;
                                Ok(text)
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
        p.await.map(|text| json!({ "text": text, "cached": false }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_and_words() {
        assert_eq!(reply_text("Done.\nCKANBAN_RESULT: {\"status\":\"done\"}\n"), "Done.");
        assert_eq!(word_count("  a b\n c  "), 3);
        let e = json!({ "role": "assistant", "kind": "text", "text": "word ".repeat(25), "uuid": "u" });
        assert!(simplifiable(&e));
        assert!(!simplifiable(&json!({ "role": "assistant", "kind": "text", "text": "short", "uuid": "u" })));
        assert_eq!(hash("abc"), "ba7816bf8f01cfea");
    }
}
