//! Which linked tickets have their Claude session open in a terminal right now (port of `src/browser/terminals.ts`,
//! `terminalOpen` in a ticket's view). One `ps` per poll for all tickets; views read the last result.
//!
//! Bun keeps a title cache refreshed in passes because reading a session summary there could mean a transcript read
//! on its event loop; here titles come from `SessionInfo` (an in-memory cache), and the poll runs on a blocking
//! thread, so it simply asks each time.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::shell::is_claude_command;
use crate::api::SessionInfo;

/// A ticket linked to a Claude session that a terminal may have open: (board, ticket id, session id). Only tickets
/// with a session and a working folder count (Bun's `t.sessionId && t.workdir`).
pub type Linked = Arc<dyn Fn() -> Vec<(String, String, String)> + Send + Sync>;

/// Told for a ticket whose open state changed: (board, ticket id).
pub type Changed = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct TerminalWatcher {
    open: Mutex<HashSet<String>>,
    /// None until the board index plugs in its listing (`set_linked`): nothing is watched then.
    linked: parking_lot::RwLock<Option<Linked>>,
    sessions: Arc<dyn SessionInfo>,
    /// Told for each ticket whose open state changed (`ticket.updated`).
    changed: Changed,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// `ps -axo args=`, the claude lines only.
async fn claude_commands() -> Vec<String> {
    let out = tokio::process::Command::new("ps").args(["-axo", "args="]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().await;
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).split('\n').filter(|l| !l.is_empty() && is_claude_command(l)).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

impl TerminalWatcher {
    pub fn new(sessions: Arc<dyn SessionInfo>, changed: Changed) -> Arc<Self> {
        Arc::new(TerminalWatcher { open: Mutex::new(HashSet::new()), linked: parking_lot::RwLock::new(None), sessions, changed, timer: Mutex::new(None) })
    }

    pub fn set_linked(&self, f: Linked) {
        *self.linked.write() = Some(f);
    }

    fn linked(&self) -> Vec<(String, String, String)> {
        let f = self.linked.read().clone();
        f.map(|f| f()).unwrap_or_default()
    }

    pub fn is_open(&self, slug: &str, id: &str) -> bool {
        self.open.lock().contains(&format!("{slug}/{id}"))
    }

    /// Which linked tickets the claude command lines show (a session id, or its title, in any of them).
    pub fn matches(&self, linked: Vec<(String, String, String)>, cmds: &[String]) -> HashSet<String> {
        let mut next = HashSet::new();
        if cmds.is_empty() {
            return next;
        }
        let all = cmds.join("\n");
        for (slug, id, session) in linked {
            let hit = all.contains(&session)
                || self.sessions.summary(&session).and_then(|s| s.get("title").and_then(|t| t.as_str()).map(str::to_string)).is_some_and(|t| !t.is_empty() && all.contains(&t));
            if hit {
                next.insert(format!("{slug}/{id}"));
            }
        }
        next
    }

    pub async fn poll(self: &Arc<Self>) {
        let me = self.clone();
        let Ok(linked) = tokio::task::spawn_blocking(move || me.linked()).await else { return };
        // No linked ticket: nothing to look for (and no `ps`).
        let cmds = if linked.is_empty() { Vec::new() } else { claude_commands().await };
        let me = self.clone();
        let Ok(next) = tokio::task::spawn_blocking(move || me.matches(linked, &cmds)).await else { return };
        let changed: Vec<String> = {
            let mut open = self.open.lock();
            let mut c: Vec<String> = next.iter().filter(|k| !open.contains(*k)).cloned().collect();
            c.extend(open.iter().filter(|k| !next.contains(*k)).cloned());
            *open = next;
            c
        };
        for k in changed {
            if let Some((slug, id)) = k.split_once('/') {
                (self.changed)(slug, id);
            }
        }
    }

    /// Polls every `every` until `stop`.
    pub fn start(self: &Arc<Self>, every: Duration) {
        let me = Arc::downgrade(self);
        let t = tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(me) = me.upgrade() else { return };
                me.poll().await;
            }
        });
        *self.timer.lock() = Some(t);
    }

    pub fn stop(&self) {
        if let Some(t) = self.timer.lock().take() {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::StandIn;

    #[test]
    fn a_session_id_in_a_claude_command_marks_the_ticket_open() {
        let w = TerminalWatcher::new(Arc::new(StandIn), Arc::new(|_: &str, _: &str| {}));
        w.set_linked(Arc::new(|| vec![("b".into(), "t1".into(), "abc-123".into()), ("b".into(), "t2".into(), "zzz".into())]));
        let open = w.matches(w.linked(), &["claude --resume abc-123".into()]);
        assert_eq!(open, HashSet::from(["b/t1".to_string()]));
        assert!(w.matches(w.linked(), &[]).is_empty());
    }
}
