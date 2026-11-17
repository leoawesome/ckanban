//! `askTicket` (`src/board/board-main.ts`): a fork of a family ticket's session at its latest saved point answers a
//! question in at most 5 sentences with read-only tools; the answer reaches the asker as an event (or "no answer"
//! after the timeout). It needs no run slot and works while the ticket runs.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use serde_json::Value;

use super::board::{RunLoop, ts, uuid};
use crate::runs::js;
use crate::runs::runner::{self, BuildArgs, NO_EDIT_TOOLS, RunOptions};

static SENTENCE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[^.!?]+[.!?]+(\s|$)|[^.!?]+$").unwrap());

/// `oneLine`.
fn one_line(s: &str) -> String {
    js::trim(&js::squash_ws(s)).to_string()
}

/// `clip`.
fn clip(s: &str, n: usize) -> String {
    if js::len16(s) > n { format!("{}…", js::head16(s, n - 1)) } else { s.to_string() }
}

/// `sentences(text, 5)`.
pub fn sentences(text: &str) -> String {
    let flat = one_line(text);
    let parts: Vec<&str> = SENTENCE.find_iter(&flat).map(|m| m.as_str()).collect();
    let joined = if parts.is_empty() { flat.clone() } else { parts.iter().take(5).copied().collect::<String>() };
    clip(js::trim(&joined), 1500)
}

/// `forkSessionFile` with the same folder: the transcript copied under a new session id.
fn fork_session_file(src: &Path, from: &str, to: &str, cwd: &str) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(cwd).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| cwd.to_string());
    let dest = crate::sessions::files::projects_dir(None).join(crate::runs::claude::encode_project_dir(&real)).join(format!("{to}.jsonl"));
    if dest.exists() {
        return Err(format!("a Claude session {to} already exists"));
    }
    let raw = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let out: Vec<String> = raw
        .split('\n')
        .map(|line| {
            if js::trim(line).is_empty() {
                return line.to_string();
            }
            let Some(mut ev) = js::parse(line) else { return line.to_string() };
            if !ev.is_object() {
                return line.to_string();
            }
            if ev.get("sessionId").and_then(Value::as_str) == Some(from) {
                ev["sessionId"] = Value::String(to.into());
            }
            js::stringify(&ev)
        })
        .collect();
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    ckanban_core::atomic::atomic_write(&dest, out.join("\n")).map_err(|e| e.to_string())?;
    Ok(dest)
}

impl RunLoop {
    /// `askTicket`. Blocking; the fork runs in the background.
    pub fn ask_ticket(&self, slug: &str, asker_id: &str, target_id: &str, question: &str) -> Result<String, String> {
        let asker = self.get(slug, asker_id);
        let target = self.get(slug, target_id);
        let profile = self.profile(slug);
        let (Some(asker), Some(target), Some(profile)) = (asker, target, profile) else {
            return Err(format!("ticket {} not found", if self.get(slug, target_id).is_none() { target_id } else { asker_id }));
        };
        if js::trim(question).is_empty() {
            return Err("the question is empty".into());
        }
        let label = format!("{} \"{}\"", target.id, target.title);
        let src = ts(&target, "sessionId").and_then(|s| crate::sessions::files::find_session_file(&crate::sessions::files::projects_dir(None), s));
        let dir = ts(&target, "workdir").or_else(|| ts(&target, "worktree")).map(str::to_string).or_else(|| profile.get("path").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        let fam = self.families.clone();
        let (s2, a2) = (slug.to_string(), asker_id.to_string());
        let reply = move |line: String| fam.push_event(&s2, &a2, &line);
        let (Some(src), true) = (src, Path::new(&dir).exists()) else {
            let line = format!("no answer from {label} to \"{question}\": it has no conversation yet.");
            self.rt.spawn_blocking(move || reply(line));
            return Ok(format!("{} has no conversation yet, so it can't answer; you'll get that as an event.", target.id));
        };
        let fork = uuid();
        let file = fork_session_file(&src, ts(&target, "sessionId").unwrap_or(""), &fork, &dir)?;
        let prompt = format!(
            "{} ({}) asks you a question about your work on this ticket. This is a copy of your conversation: answer from what you did and know, in at most 5 sentences. You may read files, but don't change anything and don't start new work. Don't write a CKANBAN_RESULT line.\n\nQuestion: {}",
            asker.title,
            asker.id,
            js::trim(question)
        );
        let mut disallowed: Vec<String> = NO_EDIT_TOOLS.split(',').map(str::to_string).collect();
        disallowed.push("Bash".into());
        let model = ts(&target, "model").map(str::to_string).or_else(|| profile.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string));
        let args = runner::build_args(&BuildArgs { session_id: fork.clone(), resume: true, model, disallowed, effort: Some("low".into()), ..Default::default() });
        let mut o = RunOptions::new(self.opts.claude_bin.clone(), PathBuf::from(&dir), args, Box::new(|_| {}));
        o.input = Some(prompt);
        o.env.insert("CKANBAN_OUTPUT_DIR".into(), self.tickets.ticket_dir(slug, &target.id).join("outputs").to_string_lossy().into_owned());
        let handle = Arc::new(runner::start_run(o));
        let reply = Arc::new(reply);
        let cut: Arc<dyn Fn() + Send + Sync> = {
            let (reply, label, q) = (reply.clone(), label.clone(), question.to_string());
            Arc::new(move || reply(format!("no answer from {label} to \"{q}\": the board restarted before it answered. Ask again if you still need it.")))
        };
        self.asks.lock().push((handle.clone(), cut));
        let timeout = self.opts.ask_timeout_ms;
        let minutes = ((timeout as f64) / 60_000.0).round() as u64;
        let me = self.arc();
        let q = question.to_string();
        let label2 = label.clone();
        self.rt.spawn(async move {
            let label = label2;
            let out = tokio::select! {
                o = handle.wait() => Some(o),
                _ = tokio::time::sleep(std::time::Duration::from_millis(timeout)) => None,
            };
            let timed_out = out.is_none();
            if timed_out {
                handle.stop();
            }
            let out = handle.wait().await;
            me.asks.lock().retain(|(h, _)| !Arc::ptr_eq(h, &handle));
            let _ = std::fs::remove_file(&file);
            if me.shutting_down() {
                return;
            }
            let text = js::trim(&super::text::result_body(&crate::runs::activity::extract_final_text(&out.events))).to_string();
            let line = if timed_out || text.is_empty() {
                let within = if timed_out { format!(" within {} minute{}", if minutes == 0 { "a few".to_string() } else { minutes.to_string() }, if minutes == 1 { "" } else { "s" }) } else { String::new() };
                format!("no answer from {label} to \"{q}\"{within}.")
            } else {
                format!("answer from {label} to \"{q}\": {}", sentences(&text))
            };
            let _ = tokio::task::spawn_blocking(move || reply(line)).await;
        });
        Ok(format!(
            "Asked {label}. Its answer (or \"no answer\" after {} minutes) comes back as an event when you are woken; end your run if you have nothing else to do.",
            if minutes == 0 { 1 } else { minutes }
        ))
    }
}
