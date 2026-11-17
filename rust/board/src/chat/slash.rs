//! The board's side of slash commands (`commands` and `boardCommand` of `src/board/board-queue.ts`): what `/` can run
//! in a ticket's chat, and /model and /effort, which the board runs itself.

use std::sync::Arc;

use serde_json::{Value, json};

use super::commands::{SlashCommand, list_commands};
use crate::index::ticket::Tk;
use crate::runloop::board::{RunError, obj, ts};
use crate::runloop::RunLoop;
use crate::tickets::norm::{effort_help, model_help, valid_effort, valid_model};

impl RunLoop {
    /// `commands`: what `/` can run in this ticket's chat (the composer's picker lists the same). Blocking.
    pub fn commands(&self, slug: &str, id: &str) -> Vec<SlashCommand> {
        let (Some(t), Some(p)) = (self.get(slug, id), self.profile(slug)) else { return Vec::new() };
        let path = p.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let cwd = t.get("workdir").and_then(Value::as_str).or_else(|| t.get("worktree").and_then(Value::as_str)).unwrap_or(&path).to_string();
        list_commands(&cwd, &[path])
    }

    /// `boardCommand`: /model and /effort set the ticket and leave a notice; no run starts.
    pub fn board_command(&self, slug: &str, id: &str, name: &str, args: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let profile = self.profile(slug).unwrap_or_default();
        let running = self.is_running(slug, id);
        if name == "model" {
            let fallback = match profile.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                Some(m) => format!("the board's model ({m})"),
                None => "Claude Code's default model".to_string(),
            };
            if args.is_empty() {
                let notice = match ts(&t, "model") {
                    Some(m) => format!("This ticket uses model {m}. Change it with /model <name>, or /model default."),
                    None => format!("This ticket uses {fallback}. Change it with /model <name>, e.g. /model sonnet."),
                };
                return self.patch(slug, id, obj(json!({ "notice": notice })));
            }
            let reset = args == "default" || args == "reset";
            if !reset && !valid_model(args) {
                return Err(RunError::other(format!("\"{args}\" is not a model name. Use {}.", model_help())));
            }
            let when = if running { "from the next run (the current one keeps its model)" } else { "from the next run" };
            let (model, notice) = if reset {
                (Value::Null, format!("Model reset: this ticket uses {fallback} {when}."))
            } else {
                (json!(args), format!("Model set to {args} for this ticket, {when}."))
            };
            return self.patch(slug, id, obj(json!({ "model": model, "notice": notice })));
        }
        if name == "effort" {
            let level = |e: Option<&str>| match e {
                Some("ultracode") => Some("xhigh".to_string()),
                Some(e) if !e.is_empty() => Some(e.to_string()),
                _ => None,
            };
            let board_ultra = crate::runloop::prompt::run_options(None, Some(&profile), true).1;
            let fallback = match level(profile.get("effort").and_then(Value::as_str)) {
                Some(l) => format!("the board's effort ({l})"),
                None => "Claude Code's default effort".to_string(),
            };
            let ultra_text = |on: bool| if on { ", ultracode on" } else { "" };
            let when = if running { "from the next run (the current one keeps its settings)" } else { "from the next run" };
            let effort = t.get("effort").and_then(Value::as_str);
            if args.is_empty() {
                let mine = level(effort);
                let ultra = crate::runloop::prompt::run_options(Some(&t), Some(&profile), true).1;
                let head = match mine {
                    Some(m) => format!("This ticket uses effort {m}"),
                    None => format!("This ticket uses {fallback}"),
                };
                let notice = format!("{head}{}. Change it with /effort <level>, /effort ultracode (on or off), or /effort default.", ultra_text(ultra));
                return self.patch(slug, id, obj(json!({ "notice": notice })));
            }
            let lower = args.to_lowercase();
            let words: Vec<&str> = lower.split_whitespace().collect();
            if words.first() == Some(&"ultracode") {
                let on = words.get(1) != Some(&"off");
                // The first version saved ultracode as the effort level: keep its level (xhigh).
                let keep = if effort == Some("ultracode") { json!("xhigh") } else { t.get("effort").cloned().unwrap_or(Value::Null) };
                let extra = if on { " Claude runs a workflow of helper agents for every substantial task, which uses much more of your plan." } else { "" };
                let notice = format!("Ultracode {} for this ticket, {when}.{extra}", if on { "on" } else { "off" });
                return self.patch(slug, id, obj(json!({ "ultracode": on, "effort": keep, "notice": notice })));
            }
            let reset = args == "default" || args == "reset";
            if !reset && !valid_effort(args) {
                return Err(RunError::other(format!("\"{args}\" is not an effort level. Use {}.", effort_help())));
            }
            if reset {
                let notice = format!("Effort reset: this ticket uses {fallback}{} {when}.", ultra_text(board_ultra));
                return self.patch(slug, id, obj(json!({ "effort": null, "ultracode": null, "notice": notice })));
            }
            // A level set over the old "ultracode" effort keeps ultracode on.
            let keep = effort == Some("ultracode") && t.get("ultracode").is_none_or(Value::is_null);
            let mut probe = t.json.clone();
            if keep {
                probe.insert("ultracode".into(), json!(true));
            }
            probe.insert("effort".into(), json!(args));
            let ultra = crate::runloop::prompt::run_options(Some(&Tk::from_json(probe, false)), Some(&profile), true).1;
            let mut patch = obj(json!({ "effort": args }));
            if keep {
                patch.insert("ultracode".into(), json!(true));
            }
            patch.insert("notice".into(), json!(format!("Effort set to {args}{} for this ticket, {when}.", ultra_text(ultra))));
            return self.patch(slug, id, patch);
        }
        Ok(t)
    }
}
