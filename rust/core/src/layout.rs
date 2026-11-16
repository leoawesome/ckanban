//! Where every saved file lives in the data folder (`contracts/data-files.md`, "Layout at a glance"), and the id
//! checks the Store applies before building a path. Kept apart from `home.rs` (the usage and spend paths) so later
//! port steps add paths here without touching it.

use crate::home::DataDir;
use std::path::PathBuf;

/// Schedule, job, automation and quick chat ids: `^[a-z0-9]+$`.
pub fn is_short_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Huddle ids: `^h_[a-z0-9_]+$`, case-insensitive.
pub fn is_huddle_id(id: &str) -> bool {
    id.len() > 2 && id[..2].eq_ignore_ascii_case("h_") && id[2..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Ticket ids: `^t_\d{8}_[0-9a-z]{4}$` (the Store itself doesn't check them; the API only uses ids it listed).
pub fn is_ticket_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 15
        && id.starts_with("t_")
        && b[2..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'_'
        && b[11..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `newTicketId()`: `t_<UTC YYYYMMDD>_<4 base36>`.
pub fn new_ticket_id(now_ms: f64) -> String {
    let day = crate::time::iso(now_ms);
    format!("t_{}{}{}_{}", &day[0..4], &day[5..7], &day[8..10], &crate::atomic::new_id()[..4])
}

/// The level of a file kept both for all boards and per board (huddle presets, templates and notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level<'a> {
    Global,
    Board(&'a str),
}

impl DataDir {
    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }
    pub fn attachments_dir(&self) -> PathBuf {
        self.root.join("attachments")
    }

    // ---- a board ----
    pub fn profile_file(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("profile.json")
    }
    pub fn board_tools(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("board-tools.json")
    }
    pub fn learned_rules(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("learned-rules.md")
    }
    pub fn run_logs_compressed(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("run-logs-compressed.jsonl")
    }
    pub fn key_backups_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join(".key-backups")
    }

    // ---- a ticket ----
    pub fn ticket_file(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("ticket.md")
    }
    pub fn comments(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("comments.jsonl")
    }
    pub fn help_cards(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("help.json")
    }
    pub fn simplified(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("simplified.json")
    }
    pub fn context_cache(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("context.json")
    }
    pub fn outputs_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("outputs")
    }
    pub fn feature_status(&self, slug: &str, id: &str) -> PathBuf {
        self.outputs_dir(slug, id).join("status.json")
    }

    // ---- quick chats ----
    /// `chats/<id><suffix>`: ".json", ".activity.jsonl", ".side-spend.jsonl", ".simplified.json", ".context.json".
    pub fn chat_file(&self, slug: &str, id: &str, suffix: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}{suffix}"))
    }

    // ---- schedules, jobs, automations, huddles ----
    pub fn schedules_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("schedules")
    }
    pub fn schedule(&self, slug: &str, id: &str) -> Option<PathBuf> {
        is_short_id(id).then(|| self.schedules_dir(slug).join(format!("{id}.json")))
    }
    pub fn schedule_history(&self, slug: &str, id: &str) -> PathBuf {
        self.schedules_dir(slug).join(format!("{id}.history.jsonl"))
    }
    pub fn jobs_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("jobs")
    }
    pub fn job(&self, slug: &str, id: &str) -> Option<PathBuf> {
        is_short_id(id).then(|| self.jobs_dir(slug).join(format!("{id}.json")))
    }
    pub fn loops_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("loops")
    }
    pub fn loop_file(&self, slug: &str, id: &str) -> Option<PathBuf> {
        is_short_id(id).then(|| self.loops_dir(slug).join(format!("{id}.json")))
    }
    pub fn loop_script(&self, slug: &str, id: &str) -> PathBuf {
        self.loops_dir(slug).join(format!("{id}.sh"))
    }
    pub fn loop_state(&self, slug: &str, id: &str) -> PathBuf {
        self.loops_dir(slug).join(format!("{id}.state.json"))
    }
    pub fn huddles_dir(&self, slug: &str) -> PathBuf {
        self.profile_dir(slug).join("huddles")
    }
    pub fn huddle(&self, slug: &str, id: &str) -> Option<PathBuf> {
        is_huddle_id(id).then(|| self.huddles_dir(slug).join(format!("{id}.json")))
    }
    pub fn huddle_messages(&self, slug: &str, id: &str) -> PathBuf {
        self.huddles_dir(slug).join(format!("{id}.messages.jsonl"))
    }

    // ---- files kept for all boards and per board ----
    fn level_dir(&self, level: Level) -> PathBuf {
        match level {
            Level::Global => self.root.clone(),
            Level::Board(slug) => self.profile_dir(slug),
        }
    }
    pub fn huddle_presets(&self, level: Level) -> PathBuf {
        self.level_dir(level).join("huddle-presets.json")
    }
    pub fn huddle_templates(&self, level: Level) -> PathBuf {
        self.level_dir(level).join("huddle-templates.json")
    }
    /// `huddle-notes/<role>.md` (`_all` for every role).
    pub fn huddle_notes(&self, level: Level, role: &str) -> PathBuf {
        self.level_dir(level).join("huddle-notes").join(format!("{role}.md"))
    }

    // ---- root files ----
    /// A file directly in the data folder, by its name in `contracts/data-files.md` (e.g. "notify.json").
    pub fn root_file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    pub fn learned_dir(&self) -> PathBuf {
        self.root.join("learned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_checks() {
        assert!(is_short_id("k3x9a2bq") && !is_short_id("../x") && !is_short_id("") && !is_short_id("A1"));
        assert!(is_huddle_id("h_4f2kq9zb") && is_huddle_id("H_ab_C") && !is_huddle_id("h_") && !is_huddle_id("h_a/b"));
        assert!(is_ticket_id("t_20261115_qjnt") && !is_ticket_id("t_2026111_qjnt") && !is_ticket_id("t_20261115_QJNT"));
        let id = new_ticket_id(crate::time::parse_date("2026-11-16T23:59:00.000Z").unwrap());
        assert!(id.starts_with("t_20261116_") && is_ticket_id(&id), "{id}");
    }

    #[test]
    fn paths_follow_the_contract() {
        let d = DataDir::new("/r");
        assert_eq!(d.ticket_file("b", "t_1"), PathBuf::from("/r/profiles/b/tickets/t_1/ticket.md"));
        assert_eq!(d.schedule("b", "../x"), None);
        assert_eq!(d.huddle_notes(Level::Board("b"), "_all"), PathBuf::from("/r/profiles/b/huddle-notes/_all.md"));
        assert_eq!(d.huddle_presets(Level::Global), PathBuf::from("/r/huddle-presets.json"));
        assert_eq!(d.chat_file("b", "c1", ".activity.jsonl"), PathBuf::from("/r/profiles/b/chats/c1.activity.jsonl"));
    }
}
