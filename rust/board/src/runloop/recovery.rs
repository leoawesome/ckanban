//! Stop, restart and resume (`src/board/board-recovery.ts`): Stop on a run, a main ticket's family Stop, the
//! restart gate (`requestRestart`: no new run starts while it waits, at most 2 minutes), shutdown (runs cut off are
//! marked so the next start resumes them), `recover` (what the last daemon left: Bun's leftovers and Rust's are the
//! same files), and the one-click session fixes (fresh session, fresh chat, take over).

use std::sync::Arc;

use serde_json::{Value, json};

use super::board::{ActiveRun, RunError, RunLoop, corrupt, now_iso, obj, ts, uuid};
use super::rules;
use super::types::Chat;
use crate::index::family::feature_rows;
use crate::index::ticket::Tk;

impl RunLoop {
    /// `stopRun`.
    pub fn stop_run(&self, run: &Arc<ActiveRun>) {
        let (started, has_handle) = {
            let st = run.st.lock();
            (st.started, st.handle.is_some())
        };
        if !started && !has_handle && !self.git.busy(&run.slug, &run.id) {
            let end = self.end_status(run);
            let mut p = end.clone();
            if end.contains_key("status") {
                p.insert("outcome".into(), "stopped".into());
            }
            p.extend(obj(json!({ "lastActivity": null, "runStartedAt": null })));
            self.drop_run(run, p);
            self.note(&run.slug, &run.id, "Run stopped by user (it had never started).");
            return;
        }
        let first = !run.st.lock().stop_requested;
        if first && self.get(&run.slug, &run.id).is_some() {
            self.patch_quiet(&run.slug, &run.id, obj(json!({ "lastActivity": "Stopping…" })));
        }
        let h = {
            let mut st = run.st.lock();
            st.stop_requested = true;
            st.handle.clone()
        };
        if let Some(h) = h {
            h.stop();
        }
        self.git.stop_setup(&run.slug, &run.id);
    }

    /// `stop`: the ticket's run, a reply waiting for a slot, or a card In Progress with no run behind it.
    pub fn stop(&self, slug: &str, id: &str) -> bool {
        if let Some(r) = self.run_of(slug, id) {
            self.stop_run(&r);
            return true;
        }
        let Some(t) = self.get(slug, id) else { return false };
        if t.is("slotWait") {
            let _ = self.tickets.cancel_slot_wait(slug, id);
            return true;
        }
        if t.status != "in_progress" {
            return false;
        }
        let auto = t.is("autoHuddle");
        self.note(slug, id, if auto { "Stopped by user while waiting for its auto huddle." } else { "Run stopped by user." });
        let mut p = obj(json!({ "status": "review", "outcome": "stopped", "error": null, "lastActivity": null }));
        if auto {
            p.insert("autoHuddle".into(), Value::Null);
        }
        self.patch_quiet(slug, id, p);
        true
    }

    /// `toolTickets`: a main ticket's own tool tickets.
    fn tool_tickets(&self, slug: &str, main: &str) -> Vec<Arc<Tk>> {
        self.tickets.tool_tickets(slug, main)
    }

    /// `stopFamily`: a main ticket and its running tool tickets; (stopped anything, tool tickets stopped).
    pub fn stop_family(&self, slug: &str, id: &str) -> (bool, usize) {
        let stopped = self.stop(slug, id);
        let mut tools = 0;
        let mut sub_stopped = false;
        let t = self.get(slug, id);
        if let Some(t) = t.as_ref().filter(|t| t.main) {
            let mut queued = 0;
            for o in self.tool_tickets(slug, id) {
                if self.is_running(slug, &o.id) || o.status == "in_progress" {
                    if self.stop(slug, &o.id) {
                        tools += 1;
                    }
                } else if o.status == "ready" {
                    self.patch_quiet(slug, &o.id, obj(json!({ "status": "backlog" })));
                    queued += 1;
                }
            }
            if let Some(now) = self.get(slug, id)
                && (tools > 0 || queued > 0)
                && matches!(now.plan_state(), Some("running" | "finishing"))
            {
                let mut plan = now.get("plan").and_then(Value::as_object).cloned().unwrap_or_default();
                plan.insert("state".into(), "paused".into());
                plan.insert("awaiting".into(), Value::Null);
                self.patch_quiet(slug, id, obj(json!({ "plan": plan })));
                self.note(slug, id, &format!("Stopped by you with {tools} running tool ticket{}; new tasks wait until you move this ticket to ready, write in its chat or press Resume.", if tools == 1 { "" } else { "s" }));
            }
            let list = self.tickets.list(slug);
            let subs: Vec<Arc<Tk>> = feature_rows(&list, id).iter().filter(|r| r.depth > 0 && list.at(r.idx).main).map(|r| list.tickets[r.idx].clone()).collect();
            for sub in subs {
                let was = sub.plan_state().map(str::to_string);
                let (s, n) = self.stop_family(slug, &sub.id);
                let paused = was.as_deref() != Some("paused") && self.get(slug, &sub.id).is_some_and(|x| x.plan_state() == Some("paused"));
                if s || paused {
                    tools += n;
                    sub_stopped |= s;
                    self.note(slug, &sub.id, &format!("Stopped with the feature \"{}\" it is part of.", t.title));
                }
            }
        }
        (stopped || tools > 0 || sub_stopped, tools)
    }

    /// `stopAll`.
    pub fn stop_all(&self) {
        let runs: Vec<Arc<ActiveRun>> = self.state.lock().runs.values().cloned().collect();
        for r in runs {
            self.stop_run(&r);
        }
    }

    /// `markInterrupted`: a chat reply cut off by shutdown is remembered so the next start resumes it.
    fn mark_interrupted(&self, r: &Arc<ActiveRun>) {
        let Some(t) = self.get(&r.slug, &r.id) else { return };
        let (chat, stop, handle, prompt, draft) = {
            let st = r.st.lock();
            (st.chat.clone(), st.stop_requested, st.handle.is_some(), st.prompt_msg_id.clone(), st.draft.clone())
        };
        let Some(chat) = chat else { return };
        if stop || t.status == "in_progress" {
            return;
        }
        if !handle && prompt.is_some() {
            return;
        }
        let mut i = obj(json!({ "at": now_iso(), "mode": chat.mode }));
        if chat.quiet {
            i.insert("quiet".into(), Value::Bool(true));
        }
        if chat.user {
            i.insert("user".into(), Value::Bool(true));
        }
        if !draft.is_empty() {
            i.insert("partial".into(), Value::String(draft));
        }
        if !handle {
            i.insert("prompt".into(), if chat.raw { json!({ "text": chat.text, "raw": true }) } else { json!({ "text": chat.text }) });
        }
        self.patch_quiet(&r.slug, &r.id, obj(json!({ "interrupted": i, "lastActivity": null, "runStartedAt": null })));
    }

    /// `shutdown`: every run killed without an outcome; tickets stay as they are for `recover`. Waits at most 6 s.
    pub async fn shutdown(self: &Arc<Self>) {
        let me = self.clone();
        let _ = tokio::task::spawn_blocking(move || {
            me.state.lock().shutting_down = true;
            me.families.shutdown();
            let runs: Vec<Arc<ActiveRun>> = me.state.lock().runs.values().cloned().collect();
            for r in &runs {
                me.mark_interrupted(r);
            }
            for r in &runs {
                let h = {
                    let mut st = r.st.lock();
                    st.stop_requested = true;
                    st.handle.clone()
                };
                if let Some(h) = h {
                    h.stop();
                }
                me.git.stop_setup(&r.slug, &r.id);
            }
            let asks: Vec<_> = std::mem::take(&mut *me.asks.lock());
            for (h, cut_off) in asks {
                cut_off();
                h.stop();
            }
        })
        .await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(6), self.when_idle()).await;
    }

    /// `whenIdle`.
    pub async fn when_idle(&self) {
        loop {
            let runs: Vec<Arc<ActiveRun>> = self.state.lock().runs.values().cloned().collect();
            if runs.is_empty() {
                return;
            }
            for r in runs {
                r.finished().await;
            }
        }
    }

    /// `onRestartBusy`: more work a restart waits for (each call lists the board of each piece active now).
    pub fn on_restart_busy(&self, f: Arc<dyn Fn() -> Vec<String> + Send + Sync>) {
        self.restart_busy.lock().push(f);
    }

    /// `busyBoards`: the board of each piece of active work, repeats included.
    pub fn busy_boards(&self) -> Vec<String> {
        let mut out: Vec<String> = self.state.lock().runs.values().map(|r| r.slug.clone()).collect();
        let fs: Vec<_> = self.restart_busy.lock().clone();
        for f in fs {
            out.extend(f());
        }
        out
    }

    /// `activeWork`.
    pub fn active_work(&self) -> usize {
        self.busy_boards().len()
    }

    /// `restartState`.
    pub fn restart_state(&self) -> Value {
        json!({ "pending": self.restart_pending(), "waiting": self.active_work() })
    }

    /// `emitRestart`.
    pub fn emit_restart(&self) {
        let mut e = obj(json!({ "type": "restart.updated" }));
        if let Value::Object(s) = self.restart_state() {
            e.extend(s);
        }
        self.bus.emit_json(Value::Object(e));
    }

    /// `restartWorkChanged`.
    pub fn restart_work_changed(&self) {
        if self.restart_pending() {
            self.emit_restart();
        }
    }

    /// `requestRestart`: restart once no work is active, at most `max_wait_ms` from now; nothing new starts meanwhile
    /// except replies to messages the user types. (running, already pending).
    pub fn request_restart(self: &Arc<Self>, on_idle: Arc<dyn Fn() + Send + Sync>, max_wait_ms: u64) -> (usize, bool) {
        let running = self.active_work();
        {
            let mut st = self.state.lock();
            if st.restart_pending {
                return (running, true);
            }
            st.restart_pending = true;
        }
        self.emit_restart();
        let me = self.clone();
        self.rt.spawn(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_wait_ms);
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if me.active_work() == 0 || std::time::Instant::now() >= deadline {
                    break;
                }
            }
            let left = me.active_work();
            if left > 0 {
                eprintln!("restart: {left} run(s) still active after {}s; restarting anyway", max_wait_ms / 1000);
            }
            on_idle();
        });
        (running, false)
    }

    /// `recover`: what the last daemon left: work runs to resume, follow-up wakes, main tickets to wake from their
    /// events, chat replies cut off or held, and queued messages no run got to. Blocking.
    pub fn recover(&self) {
        let _g = self.decide.lock();
        for slug in self.boards() {
            let list = self.tickets.list(&slug);
            for t in list.tickets.iter() {
                if t.status != "in_progress" || t.is("slotWait") || t.is("autoHuddle") || self.is_running(&slug, &t.id) {
                    continue;
                }
                if let Some(rt) = t.get("followUpRun").filter(|v| crate::runs::js::truthy(Some(v))) {
                    self.note(&slug, &t.id, "Follow-up interrupted by daemon restart; resuming.");
                    let back = rt.get("returnTo").and_then(Value::as_str).unwrap_or("review").to_string();
                    self.patch_quiet(&slug, &t.id, obj(json!({ "status": back, "lastActivity": null })));
                    let chat = Chat { text: crate::prompts::chat::interrupted_prompt(), mode: "act".into(), raw: true, return_to: Some(back), follow_up: true, ..Default::default() };
                    self.start(&slug, &t.id, Some(chat), None);
                    continue;
                }
                if t.main {
                    self.note(&slug, &t.id, "Interrupted by daemon restart; waking it again from its saved events.");
                    let mut plan = t
                        .get("plan")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_else(|| obj(json!({ "state": "running", "wakeups": 0, "startedAt": now_iso(), "originalCount": 0, "inbox": [], "seen": {}, "retries": {}, "awaiting": null })));
                    let st = plan.get("state").and_then(Value::as_str).unwrap_or("").to_string();
                    let awaiting_final = plan.get("awaiting").and_then(Value::as_str) == Some("final");
                    let next = if awaiting_final || st == "done" || st == "finishing" { "running".to_string() } else { st };
                    plan.insert("state".into(), Value::String(next));
                    plan.insert("awaiting".into(), Value::Null);
                    let mut inbox = plan.get("inbox").and_then(Value::as_array).cloned().unwrap_or_default();
                    inbox.push(json!("The board restarted while your last run was going; check where things stand before you continue."));
                    plan.insert("inbox".into(), Value::Array(inbox));
                    self.patch_quiet(&slug, &t.id, obj(json!({ "status": "review", "outcome": null, "lastActivity": null, "plan": plan })));
                    continue;
                }
                let awaiting = t.get("plan").and_then(|p| p.get("awaiting")).filter(|a| crate::runs::js::truthy(Some(a))).cloned();
                if let Some(a) = awaiting
                    && crate::index::attention::plan_active(t)
                {
                    self.note(&slug, &t.id, "Planner interrupted by daemon restart; waking it again.");
                    let mut plan = t.get("plan").and_then(Value::as_object).cloned().unwrap_or_default();
                    if a.as_str() == Some("final") {
                        plan.insert("state".into(), "finishing".into());
                    }
                    plan.insert("awaiting".into(), Value::Null);
                    plan.insert("seen".into(), json!({}));
                    self.patch_quiet(&slug, &t.id, obj(json!({ "status": "review", "outcome": null, "lastActivity": null, "plan": plan })));
                    continue;
                }
                self.note(&slug, &t.id, "Interrupted by daemon restart; resuming.");
                self.patch_quiet(&slug, &t.id, obj(json!({ "status": "ready" })));
            }
            self.dispatch(&slug);
            self.families.advance_plans(&slug);
            // Chat replies a restart cut off (or held back): continue them in the same session and mode.
            let list = self.tickets.list(&slug);
            for t in list.tickets.iter() {
                let Some(i) = t.get("interrupted").filter(|v| crate::runs::js::truthy(Some(v))).cloned() else { continue };
                if self.is_running(&slug, &t.id) || t.status == "in_progress" || corrupt(t) {
                    continue;
                }
                if !crate::runs::js::truthy(i.get("held")) {
                    self.note(&slug, &t.id, "Reply interrupted by daemon restart; resuming.");
                }
                let b = |k: &str| crate::runs::js::truthy(i.get(k));
                let mode = i.get("mode").and_then(Value::as_str).unwrap_or("act").to_string();
                if let Some(p) = i.get("prompt").filter(|v| crate::runs::js::truthy(Some(v))) {
                    let chat = Chat { text: p.get("text").and_then(Value::as_str).unwrap_or("").into(), mode, raw: crate::runs::js::truthy(p.get("raw")), quiet: b("quiet"), user: b("user"), ..Default::default() };
                    self.start(&slug, &t.id, Some(chat), None);
                } else if self.waiting(&slug, &t.id).is_empty() {
                    let chat = Chat { text: crate::prompts::chat::interrupted_prompt(), mode, raw: true, quiet: b("quiet"), user: b("user"), ..Default::default() };
                    self.start(&slug, &t.id, Some(chat), None);
                }
            }
            // Messages a restarted chat run never got to: answer them now.
            let list = self.tickets.list(&slug);
            for t in list.tickets.iter() {
                let Some(next) = self.waiting(&slug, &t.id).into_iter().next() else { continue };
                if self.is_running(&slug, &t.id) || t.status == "ready" || t.is("slotWait") || corrupt(t) {
                    continue;
                }
                let t = self.get(&slug, &t.id).unwrap_or_else(|| t.clone());
                let chat = rules::chat_for(&t.json, &next);
                if rules::takes_slot(Some(&chat), t.main) && chat.act() && self.folder_busy(&slug, &t) {
                    let _ = self.wait_for_slot(&slug, &t.id);
                } else {
                    self.start(&slug, &t.id, Some(chat), Some(super::board::msg_id(&next).to_string()));
                }
            }
        }
    }

    // ---- One-click recovery from a lost or busy session ----

    /// `requeue`: the ticket's work run starts now if it can, otherwise when it may.
    pub fn requeue(&self, slug: &str, id: &str) -> Result<Arc<Tk>, RunError> {
        self.patch(slug, id, obj(json!({ "status": "ready", "outcome": null, "error": null })))?;
        self.dispatch(slug);
        self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))
    }

    /// `recoverable`.
    fn recoverable(&self, slug: &str, id: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        if corrupt(&t) {
            return Err(RunError::other("ticket file is corrupt"));
        }
        if self.is_running(slug, id) {
            return Err(RunError::conflict("Claude is already working on this ticket"));
        }
        Ok(t)
    }

    /// `startFresh`: a new session, the copy kept, a work run queued that continues from the branch.
    pub fn start_fresh(&self, slug: &str, id: &str) -> Result<Arc<Tk>, RunError> {
        self.recoverable(slug, id)?;
        self.patch(slug, id, obj(json!({ "sessionId": uuid(), "sessionStarted": false, "freshSession": true })))?;
        self.note(slug, id, "Started a fresh session: the previous conversation is gone, so Claude continues from the ticket, its last result and the branch as it is now.");
        self.requeue(slug, id)
    }

    /// `freshChat`: the next message starts a new Claude session; history, status and outputs stay.
    pub fn fresh_chat(&self, slug: &str, id: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        if corrupt(&t) {
            return Err(RunError::other("ticket file is corrupt"));
        }
        if self.is_running(slug, id) {
            return Err(RunError::conflict("Claude is working on this ticket; start a fresh chat once Claude is done"));
        }
        if t.is("freshSession") {
            return Ok(t);
        }
        self.start_fresh_chat(slug, id, false)
    }

    /// `takeOver`: the session is no longer open in a terminal (or was in the board's own, closed here): resume
    /// here. (ticket, external: open in a terminal the board can't close).
    pub async fn take_over(self: &Arc<Self>, slug: &str, id: &str) -> Result<(Arc<Tk>, bool), RunError> {
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        let t = tokio::task::spawn_blocking(move || me.recoverable(&s, &i)).await.map_err(|e| RunError::other(e.to_string()))??;
        if let Some(sid) = ts(&t, "sessionId") {
            // STAND-IN (R9/R7b): a session open in the board's own terminal (the dock) isn't closed here yet.
            let title = ts(&t, "workdir").and_then(|w| crate::runs::claude::session_title(w, sid, &Default::default()));
            if crate::runs::claude::is_session_live(sid, title.as_deref()).await {
                return Ok((t, true));
            }
        }
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        let t = tokio::task::spawn_blocking(move || {
            me.note(&s, &i, "Took over the session: it was no longer open in a terminal, so the run resumed here.");
            me.requeue(&s, &i)
        })
        .await
        .map_err(|e| RunError::other(e.to_string()))??;
        Ok((t, false))
    }

    /// `endQuietly`: a quiet schedule's ticket whose run found nothing goes, noted in the schedule's history.
    /// STAND-IN (R10): the history line and its cost in today's spend come with the scheduler.
    pub(super) async fn end_quietly(self: &Arc<Self>, slug: &str, id: &str, _end: &(String, f64)) -> bool {
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        tokio::task::spawn_blocking(move || {
            let Some(t) = me.get(&s, &i) else { return false };
            if !t.is("scheduleId") || t.status != "done" || me.is_running(&s, &i) || !me.waiting(&s, &i).is_empty() {
                return false;
            }
            match me.tickets.delete(&s, &i) {
                Ok(()) => true,
                Err((_, e)) => {
                    eprintln!("ticket {s}/{i}: could not remove the quiet schedule run: {e}");
                    false
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    /// `nudgeStatus`: after a chat reply or plan wake of a feature's top ticket that didn't update the status while
    /// the family changed, one short quiet turn asking Claude to update it. At most once per run.
    pub(super) async fn nudge_status(self: Arc<Self>, run: Arc<ActiveRun>, started_at: String) -> bool {
        let me = self.clone();
        let r = run.clone();
        let go = tokio::task::spawn_blocking(move || me.nudge_turn(&r, &started_at)).await.unwrap_or(false);
        if go {
            self.execute_once(run, false, None).await;
        }
        go
    }

    fn nudge_turn(&self, run: &Arc<ActiveRun>, started_at: &str) -> bool {
        {
            let st = run.st.lock();
            if st.nudged || !st.status_eligible || st.stop_requested {
                return false;
            }
        }
        if self.shutting_down() || self.restart_pending() || !self.waiting(&run.slug, &run.id).is_empty() {
            return false;
        }
        let list = self.tickets.list(&run.slug);
        let Some(top) = crate::index::family::feature_root(&list, &run.id).map(|i| list.tickets[i].clone()) else { return false };
        if top.id != run.id || !crate::families::rules::is_feature(&list, &top) {
            return false;
        }
        let dir = self.tickets.ticket_dir(&run.slug, &run.id).join("outputs");
        let Some(saved) = crate::families::status::read_status(&dir) else { return false };
        if saved.get("claudeAt").and_then(Value::as_str).is_some_and(|c| c >= started_at) {
            return false;
        }
        let rows: Vec<Arc<Tk>> = feature_rows(&list, &top.id).into_iter().skip(1).map(|r| list.tickets[r.idx].clone()).collect();
        let sig = crate::families::plan::family_sig(rows.iter().map(|t| &**t));
        let before = saved.get("familySig").and_then(Value::as_str).unwrap_or("").to_string();
        if before == sig {
            return false;
        }
        run.st.lock().nudged = true;
        let Some(path) = self.families.refresh_status_file(&run.slug, &run.id) else { return false };
        let mode = run.chat().map(|c| c.mode).unwrap_or_else(|| "act".into());
        let open: Vec<crate::prompts::types::Question> = self.get(&run.slug, &run.id).map(|t| self.open_form(&t)).unwrap_or_default().into_iter().filter_map(|q| serde_json::from_value(q).ok()).collect();
        let titles: Vec<(String, String)> = rows.iter().map(|t| (t.id.clone(), t.title.clone())).collect();
        let changes = rules::sig_changes(&before, &sig, &titles);
        let text = crate::prompts::planning::status_nudge_prompt(&path.to_string_lossy(), &changes, &open);
        {
            let mut st = run.st.lock();
            st.chat = Some(Chat { text, mode, raw: true, quiet: true, nudge: true, ..Default::default() });
            st.prompt_msg_id = None;
            st.in_flight.clear();
            st.handle = None;
            st.retried = false;
            st.restart_requested = false;
        }
        self.begin(run).is_ok()
    }

    /// Bun's `addComment` route call: a comment by the user, or with `from` a note another ticket's run left.
    pub fn add_comment(&self, slug: &str, id: &str, text: &str, from: Option<&str>) -> Result<Value, RunError> {
        Ok(self.tickets.add_comment(slug, id, text, from)?)
    }

    /// `linkSession`: a Claude session the user already started in the board's folder (None unlinks).
    pub async fn link_session(self: &Arc<Self>, slug: &str, id: &str, session: Option<&str>) -> Result<Arc<Tk>, RunError> {
        let (profile, t) = (self.profile(slug), self.get(slug, id));
        let (Some(profile), Some(t)) = (profile, t) else { return Err(RunError::other("ticket not found")) };
        if self.is_running(slug, id) {
            return Err(RunError::other("ticket is running; stop it before linking a session"));
        }
        if let Some(s) = session
            && !(s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        {
            return Err(RunError::other("invalid session id"));
        }
        if let (Some(wt), Some(_)) = (ts(&t, "worktree"), session) {
            let r = self.git.remove_ticket_worktree(&Value::Object(profile.clone()), std::path::Path::new(wt)).await;
            if !r.removed {
                return Err(RunError::other(format!("ticket already has a worktree with changes ({wt}); cannot switch session")));
            }
        }
        let p = match session {
            None => obj(json!({ "sessionId": null, "workdir": null })),
            Some(s) => obj(json!({ "sessionId": s, "workdir": profile.get("path").cloned().unwrap_or(Value::Null), "worktree": null, "runCount": 0, "lastRunAt": now_iso(), "status": "review" })),
        };
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        tokio::task::spawn_blocking(move || me.patch(&s, &i, p)).await.map_err(|e| RunError::other(e.to_string()))?
    }
}
