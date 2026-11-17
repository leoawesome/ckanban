//! `executeOnce` (`src/board/board.ts`): one attempt of a run. Where it works, the prompt, the claude process and
//! its events, then what the card shows when it ends (the result line, a failure, a stop, a cap, a usage limit, a
//! passing API error retried once, a lost session started over once, a stall restarted in the same session).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::board::{ActiveRun, RunLoop, RunSpend, now_iso, obj, queued_of, ts};
use super::prompt::{RunBrowsers, auto_huddles_on, comment, follow_up_place, prompt_ticket, run_cap_for};
use super::rules;
use crate::git::landing::Session;
use crate::git::repo::RepoKind;
use crate::index::ticket::Tk;
use crate::prompts::types::{self as pt, RunRole};
use crate::quickchat::text::{Draft, DraftTracker, localize_attachments};
use crate::runs::activity::{extract_final_text, summarize_event};
use crate::runs::js;
use crate::runs::result::{RunResult, parse_result};
use crate::runs::runner::{self, BackgroundTask, RunOptions, RunOutput};

/// What `executeOnce` worked out before the process starts (blocking work).
struct Prep {
    prompt: String,
    system_prompt: Option<String>,
    fresh: bool,
    fresh_chat: bool,
    refine: bool,
    quiet: bool,
    run_no: f64,
    output_dir: PathBuf,
    profile: Map<String, Value>,
    ticket: Arc<Tk>,
}

/// The run's state while its process runs (Bun's closure variables).
struct Live {
    last_write: f64,
    pending_activity: Option<String>,
    draft: DraftTracker,
    draft_gen: u64,
    draft_timer: bool,
    shows_interrupted: bool,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// `spentWith`: a run's messages plus its workflows' helper agents.
pub fn spent_with(spend: &Mutex<RunSpend>) -> f64 {
    let mut sp = spend.lock();
    let mut total: f64 = sp.main_order.iter().filter_map(|k| sp.main.get(k)).sum();
    let dirs = sp.workflow_dirs.clone();
    for d in dirs {
        total += crate::sessions::workflows::workflow_dir_cost(Path::new(&d), &mut sp.files);
    }
    total
}

impl RunLoop {
    /// `executeOnce`. healed: the one retry in a new session after Claude couldn't find the old one. resume: the
    /// board continues this run's own work in its session with this text as the whole prompt.
    pub(super) fn execute_once(self: Arc<Self>, run: Arc<ActiveRun>, healed: bool, resume_text: Option<String>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let (slug, id) = (run.slug.clone(), run.id.clone());
            let started_at = now_iso();
            let session = match self.git.ensure_session(&slug, &id).await {
                Ok(s) => s,
                Err(msg) => {
                    let me = self.clone();
                    let r = run.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        me.note(&r.slug, &r.id, &format!("Could not start: {msg}"));
                        let fetch = msg.starts_with("Couldn't reach the online copy of your project");
                        let mut p = me.end_status(&r);
                        p.extend(obj(json!({ "outcome": if fetch { "blocked" } else { "failed" }, "error": msg, "lastActivity": null })));
                        if r.chat().is_some_and(|c| c.refine()) {
                            p.insert("refineStarted".into(), Value::Bool(false));
                        }
                        me.patch_quiet(&r.slug, &r.id, p);
                    })
                    .await;
                    return;
                }
            };
            if self.shutting_down() {
                return;
            }
            // A run log compressed while the ticket sat in Done comes back first.
            let log = self.tickets.ticket_dir(&slug, &id).join("activity.jsonl");
            if let Err(e) = crate::runs::run_log::restore_log(&log).await {
                let full = e.raw_os_error() == Some(libc::ENOSPC);
                let msg = if full {
                    "Could not start: the Mac's disk is too full to bring back this ticket's old run log. Free some space, then send the message again.".to_string()
                } else {
                    format!("Could not start: this ticket's old run log could not be brought back ({e}). It is kept as it was; try again.")
                };
                self.blocking_end(&run, msg.clone(), obj(json!({ "outcome": "failed", "error": msg, "lastActivity": null }))).await;
                return;
            }
            let (stop, chat) = {
                let st = run.st.lock();
                (st.stop_requested, st.chat.clone())
            };
            // Unattended runs refuse to share a session with an open terminal; chat messages are the user's call.
            if session.existed && !stop && chat.is_none() {
                let t0 = self.get(&slug, &id);
                let title = t0.as_ref().and_then(|t| ts(t, "workdir")).and_then(|w| crate::runs::claude::session_title(w, &session.session_id, &Default::default()));
                if crate::runs::claude::is_session_live(&session.session_id, title.as_deref()).await {
                    let msg = rules::SESSION_OPEN_MSG.to_string();
                    self.blocking_end(&run, msg.clone(), obj(json!({ "outcome": "blocked", "error": msg, "lastActivity": null }))).await;
                    return;
                }
            }
            if stop {
                self.blocking_end(&run, "Run stopped by user.".into(), obj(json!({ "outcome": "stopped", "lastActivity": null }))).await;
                return;
            }
            let me = self.clone();
            let r = run.clone();
            let sess = session.clone();
            let rt = resume_text.clone();
            let prep = match tokio::task::spawn_blocking(move || me.prepare(&r, &sess, rt.as_deref())).await {
                Ok(Some(p)) => p,
                _ => return,
            };
            let lease = RunLoop::key(&slug, &id);
            let browsers: Option<RunBrowsers> = if self.browsers.is_some() { Some(self.run_browsers(&slug, &id, &lease, &prep.output_dir).await) } else { None };
            if run.st.lock().stop_requested || self.shutting_down() {
                if !self.shutting_down() {
                    self.blocking_end(&run, "Run stopped by user.".into(), obj(json!({ "outcome": "stopped", "lastActivity": null }))).await;
                }
                return;
            }
            let me = self.clone();
            let r = run.clone();
            let sess = session.clone();
            let resumed = resume_text.is_some();
            let launched = tokio::task::spawn_blocking(move || me.launch(&r, &sess, prep, browsers, resumed)).await;
            let Ok(Some((handle, live, spend, cap, prep))) = launched else { return };
            let cap_watch = cap.map(|cap| {
                let me = self.clone();
                let r = run.clone();
                let sp = spend.clone();
                let h = handle.clone();
                let every = self.opts.cap_poll_ms.max(10);
                tokio::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_millis(every));
                    tick.tick().await;
                    loop {
                        tick.tick().await;
                        let skip = {
                            let st = r.st.lock();
                            sp.lock().workflow_dirs.is_empty() || st.stop_requested || st.workflow_cap_hit.is_some()
                        };
                        if skip {
                            continue;
                        }
                        let sp2 = sp.clone();
                        let total = tokio::task::spawn_blocking(move || spent_with(&sp2)).await.unwrap_or(0.0);
                        if total < cap {
                            continue;
                        }
                        r.st.lock().workflow_cap_hit = Some(total);
                        let (m, r2) = (me.clone(), r.clone());
                        let _ = tokio::task::spawn_blocking(move || m.patch_quiet(&r2.slug, &r2.id, obj(json!({ "lastActivity": "Stopping: spending cap reached" })))).await;
                        h.stop();
                    }
                })
            });
            let out = handle.wait().await;
            if let Some(w) = cap_watch {
                w.abort();
            }
            let me = self.clone();
            let r = run.clone();
            let out2 = out.clone();
            let handle2 = handle.clone();
            let next = tokio::task::spawn_blocking(move || me.finish(&r, &session, prep, &out2, &handle2, live, spend, cap, &started_at, healed)).await;
            match next {
                Ok(Next::Done) | Err(_) => {}
                Ok(Next::Again(text)) => self.execute_once(run, healed, Some(text)).await,
                Ok(Next::Healed) => self.execute_once(run, true, None).await,
                Ok(Next::Retry(delay)) => {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    if self.shutting_down() {
                        return;
                    }
                    if run.st.lock().stop_requested {
                        let me = self.clone();
                        let r = run.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            me.note(&r.slug, &r.id, "Run stopped by user.");
                            let mut p = me.end_status(&r);
                            p.extend(obj(json!({ "stalled": null, "outcome": "stopped", "error": null, "lastActivity": null })));
                            p.extend(me.drop_auto_wait(&r.slug, &r.id));
                            me.patch_quiet(&r.slug, &r.id, p);
                        })
                        .await;
                        return;
                    }
                    self.execute_once(run, healed, Some(crate::runs::retry::RETRY_TEXT.into())).await
                }
            }
        })
    }

    /// A run that ends before its process: a comment and the card's end.
    async fn blocking_end(self: &Arc<Self>, run: &Arc<ActiveRun>, comment: String, extra: Map<String, Value>) {
        let me = self.clone();
        let r = run.clone();
        let _ = tokio::task::spawn_blocking(move || {
            me.note(&r.slug, &r.id, &comment);
            let mut p = me.end_status(&r);
            p.extend(extra);
            me.patch_quiet(&r.slug, &r.id, p);
        })
        .await;
    }

    /// `dropAutoWait`: a stopped ticket no longer waits for an auto-huddle slot.
    pub(super) fn drop_auto_wait(&self, slug: &str, id: &str) -> Map<String, Value> {
        let waiting = self.get(slug, id).and_then(|t| t.get("autoHuddle").and_then(|a| a.get("state")).and_then(Value::as_str).map(|s| s == "waiting")).unwrap_or(false);
        if waiting { obj(json!({ "autoHuddle": null })) } else { Map::new() }
    }

    /// The prompt and what the run needs (blocking): Bun's `executeOnce` from the ticket read to the notes.
    fn prepare(&self, run: &Arc<ActiveRun>, session: &Session, resume_text: Option<&str>) -> Option<Prep> {
        let (slug, id) = (run.slug.as_str(), run.id.as_str());
        let t = self.get(slug, id)?;
        let chat = run.chat();
        let resume = if session.existed { resume_text.map(str::to_string) } else { None };
        let refine = chat.as_ref().is_some_and(|c| c.refine());
        let quiet = chat.as_ref().is_some_and(|c| c.quiet);
        let profile = self.profile(slug)?;
        let run_count = t.get("runCount").and_then(Value::as_f64).unwrap_or(0.0);
        let run_no = run_count + 1.0;
        let last_run = ts(&t, "lastRunAt").map(str::to_string);
        let new_comments: Vec<Value> = self
            .comments(slug, id)
            .into_iter()
            .filter(|c| (s(c, "author").as_deref() == Some("user") || js::truthy(c.get("from"))) && last_run.as_ref().is_none_or(|l| s(c, "at").is_some_and(|a| a > *l)))
            .collect();
        let output_dir = self.outputs_dir(slug, id);
        let out_s = output_dir.to_string_lossy().into_owned();
        let fresh = t.is("freshSession") && chat.is_none();
        let fresh_chat = t.is("freshSession") && chat.is_some() && !session.existed && (!chat.as_ref().is_some_and(|c| c.raw) || self.seeds_from_status(slug, &t));
        let mut texts: Vec<Option<&str>> = vec![Some(&t.body), chat.as_ref().map(|c| c.text.as_str())];
        let comment_texts: Vec<String> = new_comments.iter().filter_map(|c| s(c, "text")).collect();
        texts.extend(comment_texts.iter().map(|c| Some(c.as_str())));
        let artifacts = js::truthy(profile.get("artifacts")) || crate::prompts::rules::mentions_artifact(&texts);
        let repo = session.repo.as_str();
        let role: Option<RunRole> = self.role_of(slug, &t, repo, session.in_place);
        // "What we did before" goes into a chat's first Planning turn, a fresh session's prompt and a first run.
        let wants_recall = resume.is_none()
            && match &chat {
                Some(c) => !c.raw && refine && !session.existed,
                None => fresh || run_count == 0.0 || !session.existed,
            };
        let recall = match (wants_recall, self.recall.get()) {
            (true, Some(f)) => f(slug, &t.json),
            _ => String::new(),
        };
        if !t.is("worktree") && !t.is("branch") && !t.is("workdir") && matches!(session.repo, RepoKind::Plain | RepoKind::Empty) {
            let digests = self.digests.clone();
            let file = self.tickets.ticket_dir(slug, id).join("activity.jsonl");
            self.rt.spawn(async move {
                let _ = digests.get(&file).await;
            });
        }
        let pticket = prompt_ticket(&t);
        let comments: Vec<pt::Comment> = new_comments.iter().map(comment).collect();
        let attachments = self.root.join("attachments");
        let home = pt::Home {
            folder: profile.get("path").and_then(Value::as_str).unwrap_or("").into(),
            base_branch: profile.get("baseBranch").and_then(Value::as_str).unwrap_or("").into(),
        };
        let mut prompt = match resume {
            Some(r) => r,
            None => {
                let body = if let Some(c) = chat.as_ref().filter(|c| c.raw) {
                    let mut x = c.text.clone();
                    if fresh_chat {
                        x.push_str("\n\n");
                        x.push_str(&self.fresh_chat_context(slug, &t));
                    }
                    x
                } else if let Some(c) = &chat {
                    let list = self.tickets.list(slug);
                    let place = if refine && role.is_none() { follow_up_place(&list, &t.id) } else { None };
                    let mut x = crate::prompts::chat::chat_prompt(&pticket, &c.text, &c.mode, &out_s, artifacts, repo, session.in_place, &recall, role.as_ref(), place.as_ref());
                    if !refine && !quiet {
                        let notes: Vec<pt::Comment> = comments.iter().filter(|c| c.is_note()).cloned().collect();
                        x.push_str(&crate::prompts::chat::chat_notes(&notes));
                    }
                    if fresh_chat {
                        x.push_str("\n\n");
                        x.push_str(&self.fresh_chat_context(slug, &t));
                    }
                    x
                } else if fresh {
                    self.fresh_prompt(slug, &t, repo, session.in_place, &out_s, &recall)
                } else if let (Some(RunRole::Tool(r)), true) = (&role, run_count == 0.0 || !session.existed) {
                    crate::prompts::main_role::tool_first_prompt(
                        &pticket,
                        r,
                        &crate::prompts::main_role::ToolContext { comments: Some(comments.clone()), auto_huddles: Some(auto_huddles_on(Some(&profile))), artifacts: Some(artifacts), recall: Some(recall.clone()) },
                    )
                } else if run_count == 0.0 || !session.existed {
                    let linked = t.is("workdir");
                    let cs: Vec<pt::Comment> = if linked || run_count > 0.0 { comments.clone() } else { comments.iter().filter(|c| c.is_note()).cloned().collect() };
                    let main = match &role {
                        Some(RunRole::Main(m)) => Some(m.clone()),
                        _ => None,
                    };
                    let ctx = pt::PromptContext {
                        repo: repo.into(),
                        in_place: Some(session.in_place),
                        home: Some(home.clone()),
                        linked: Some(linked),
                        comments: Some(cs),
                        output_dir: out_s.clone(),
                        schedule: if t.is("scheduleId") { self.schedule_context(slug, &t) } else { None },
                        auto_huddles: Some(auto_huddles_on(Some(&profile))),
                        artifacts: Some(artifacts),
                        recall: Some(recall.clone()),
                        main,
                    };
                    crate::prompts::chat::first_run_prompt(&pticket, &ctx)
                } else {
                    crate::prompts::chat::resume_prompt(&pticket, &comments, &out_s, auto_huddles_on(Some(&profile)), artifacts, repo, session.in_place, Some(&home), role.as_ref())
                };
                let body = localize_attachments(&body, &attachments);
                self.with_setup_note(slug, &t, &profile, &session.dir, refine, body)
            }
        };
        let mut system_prompt: Option<String> = None;
        let slash = chat.as_ref().and_then(|c| c.slash.clone());
        if slash.is_some()
            && resume_text.is_none()
            && let Some(cut) = prompt.find("\n\n<ckanban-context")
        {
            {
                system_prompt = Some(format!("The user's message in this turn is a slash command sent from the kanban board's ticket chat. The board's instructions for this run:\n\n{}", &prompt[cut + 2..]));
                prompt.truncate(cut);
            }
        }
        let add = |sp: &mut Option<String>, note: String| {
            *sp = Some(match sp.take() {
                Some(x) => format!("{x}\n\n{note}"),
                None => note,
            });
        };
        if !refine && let Some(b) = &self.browsers {
            let devices: Vec<pt::Device> = b.devices.devices().iter().map(|d| pt::Device { name: d.name.clone(), description: Some(d.description.clone()).filter(|x| !x.is_empty()), capacity: d.capacity as f64 }).collect();
            let needs: Vec<String> = t.get("needs").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            if let Some(n) = crate::prompts::rules::devices_note(&devices, &needs) {
                add(&mut system_prompt, n);
            }
        }
        let _ = run_no;
        Some(Prep { prompt, system_prompt, fresh, fresh_chat, refine, quiet, run_no, output_dir, profile, ticket: t })
    }

    /// The notes on top of the prompt and the claude process (blocking): from the browsers to `startRun`.
    #[allow(clippy::type_complexity)]
    fn launch(self: &Arc<Self>, run: &Arc<ActiveRun>, session: &Session, mut prep: Prep, browsers: Option<RunBrowsers>, resumed: bool) -> Option<(Arc<runner::RunHandle>, Arc<Mutex<Live>>, Arc<Mutex<RunSpend>>, Option<f64>, Prep)> {
        let (slug, id) = (run.slug.clone(), run.id.clone());
        let chat = run.chat();
        let slash = chat.as_ref().and_then(|c| c.slash.clone());
        let add = |sp: &mut Option<String>, note: String| {
            *sp = Some(match sp.take() {
                Some(x) => format!("{x}\n\n{note}"),
                None => note,
            });
        };
        let chrome_note = browsers.as_ref().and_then(|b| b.note.clone());
        if browsers.as_ref().is_some_and(|b| b.no_chrome) {
            prep.prompt = crate::prompts::rules::without_chrome_rule(&prep.prompt);
            if let Some(sp) = &prep.system_prompt {
                prep.system_prompt = Some(crate::prompts::rules::without_chrome_rule(sp));
            }
        }
        if let Some(n) = &chrome_note {
            add(&mut prep.system_prompt, n.clone());
            if session.existed && slash.is_none() {
                prep.prompt.push_str("\n\n");
                prep.prompt.push_str(&crate::prompts::rules::chrome_turn_note(n));
            }
        }
        // A resumed session may hold old copies of board tools it loaded before they changed.
        if let Some(now) = self.opts.tools_version.clone()
            && ts(&prep.ticket, "toolsVersion") != Some(now.as_str())
        {
            if session.existed && slash.is_none() {
                prep.prompt.push_str("\n\n");
                prep.prompt.push_str(&crate::prompts::rules::tools_changed_note());
            }
            self.patch_quiet(&slug, &id, obj(json!({ "toolsVersion": now })));
        }
        let role = self.role_of(&slug, &prep.ticket, session.repo.as_str(), session.in_place);
        if let Some(RunRole::Main(m)) = &role
            && !prep.quiet
        {
            add(&mut prep.system_prompt, crate::prompts::main_role::main_ticket_rules(m));
        }
        if !chat.as_ref().is_some_and(|c| c.nudge) && !prep.quiet {
            if let Some(n) = self.feature_note(&slug, &prep.ticket) {
                add(&mut prep.system_prompt, n);
            }
            if !resumed && let Some(notes) = self.take_status_notes(&slug, &id) {
                prep.prompt.push_str("\n\n");
                prep.prompt.push_str(&notes);
            }
        }
        let t = self.get(&slug, &id)?;
        let cap = if prep.refine || prep.quiet { None } else { run_cap_for(&t, Some(&prep.profile)) };
        if !prep.refine && !prep.quiet && t.is("capNextUsd") {
            self.patch_quiet(&slug, &id, obj(json!({ "capNextUsd": null })));
        }
        let spend = Arc::new(Mutex::new(RunSpend::default()));
        let prompt_msg = {
            let mut st = run.st.lock();
            st.spend = Some(spend.clone());
            st.prompt_msg_id.clone()
        };
        if let Some(pid) = &prompt_msg
            && queued_of(&t).iter().any(|m| m.get("id").and_then(Value::as_str) == Some(pid) && js::truthy(m.get("telegram")))
        {
            run.st.lock().telegram_from = Some(0.0);
        }
        if !resumed {
            let kind = if prep.refine {
                "planning"
            } else if prep.quiet {
                "reply"
            } else if chat.as_ref().is_some_and(|c| c.follow_up) {
                "follow-up"
            } else if chat.is_some() {
                "chat"
            } else {
                "work"
            };
            self.append_activity(&slug, &id, prep.run_no, &json!({ "type": "ckanban_run", "kind": kind }));
        }
        let live = Arc::new(Mutex::new(Live { last_write: 0.0, pending_activity: None, draft: DraftTracker::default(), draft_gen: 0, draft_timer: false, shows_interrupted: t.is("interrupted") }));
        let args = self.chat_args(&slug, &t, &prep.profile, prep.refine, &session.session_id, session.existed, prep.system_prompt.clone(), cap, browsers.as_ref());
        let me = self.clone();
        let r = run.clone();
        let lv = live.clone();
        let sp = spend.clone();
        let run_no = prep.run_no;
        let refine = prep.refine;
        let mut chrome_watch = self.browsers.as_ref().map(|b| crate::browsers::chromes::ChromeWatch::new(b.chromes.clone()));
        let init_cwd = session.dir.to_string_lossy().into_owned();
        let init_projects = vec![prep.profile.get("path").and_then(Value::as_str).unwrap_or("").to_string()];
        let on_event: runner::OnEvent = Box::new(move |ev: &Value| {
            me.on_event(&r, &lv, &sp, run_no, refine, ev);
            crate::chat::commands::remember_init(&init_cwd, ev, &init_projects);
            if ev.get("type").and_then(Value::as_str) != Some("stream_event")
                && let Some(w) = chrome_watch.as_mut()
            {
                w.feed(ev);
            }
        });
        let mut o = RunOptions::new(self.opts.claude_bin.clone(), session.dir.clone(), args, on_event);
        o.input = Some(prep.prompt.clone());
        o.input_local = slash.as_deref() == Some("local") && !resumed;
        o.planning = prep.refine;
        o.env = self.chat_env(&slug, &id, &prep.output_dir.to_string_lossy());
        o.stall_ms = self.stall_ms(&prep.profile);
        let (me, r) = (self.clone(), run.clone());
        let profile = prep.profile.clone();
        o.on_stall = Some(Box::new(move |stalled: bool| me.on_stall(&r, &profile, stalled)));
        let (me, r, lv) = (self.clone(), run.clone(), live.clone());
        o.on_waiting = Some(Box::new(move |tasks: Option<&[BackgroundTask]>| me.on_waiting(&r, &lv, tasks)));
        let handle = Arc::new(runner::start_run(o));
        run.st.lock().handle = Some(handle.clone());
        // A local command is never echoed back: it was read once it was written.
        if slash.as_deref() == Some("local") && !resumed {
            let pid = run.st.lock().prompt_msg_id.take();
            if let Some(pid) = pid {
                self.drop_queued(&slug, &id, &[pid]);
            }
        }
        // Messages sent while the run was starting up, or left from a run the daemon restarted.
        let pid = run.st.lock().prompt_msg_id.clone();
        for msg in self.waiting(&slug, &id) {
            if !js::truthy(msg.get("nextRun")) || pid.as_deref() == msg.get("id").and_then(Value::as_str) {
                self.steer(run, &msg);
            }
        }
        Some((handle, live, spend, cap, prep))
    }

    /// `store.appendActivity`: one line of the run log, saved keys hidden.
    pub(super) fn append_activity(&self, slug: &str, id: &str, run_no: f64, ev: &Value) {
        let line = json!({ "run": ckanban_core::jsnum::num(run_no), "at": now_iso(), "event": ev });
        let text = (self.opts.mask_json)(&js::stringify(&line));
        let file = self.tickets.ticket_dir(slug, id).join("activity.jsonl");
        if let Err(e) = crate::runs::run_log::append_line(&file, &text) {
            eprintln!("[board] run log of {slug}/{id}: {e}");
        }
    }

    /// One event of the run (`onEvent`): drafts, workflows, the run log, the card's live line. On the run's task.
    fn on_event(self: &Arc<Self>, run: &Arc<ActiveRun>, live: &Arc<Mutex<Live>>, spend: &Arc<Mutex<RunSpend>>, run_no: f64, refine: bool, ev: &Value) {
        let (slug, id) = (&run.slug, &run.id);
        let changed = {
            let mut l = live.lock();
            let d = l.draft.feed(ev);
            run.st.lock().draft = l.draft.text.clone();
            match d {
                Draft::Same => None,
                Draft::Cleared => {
                    l.draft_gen += 1;
                    l.draft_timer = false;
                    Some((String::new(), Some(l.draft.finished.clone()).filter(|f| !f.is_empty())))
                }
                Draft::Changed => {
                    if !l.draft_timer {
                        l.draft_timer = true;
                        let gen_now = l.draft_gen;
                        let (me, lv, s2, i2) = (self.clone(), live.clone(), slug.clone(), id.clone());
                        self.rt.spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(rules::DRAFT_THROTTLE_MS)).await;
                            let text = {
                                let mut l = lv.lock();
                                if l.draft_gen != gen_now || !l.draft_timer {
                                    return;
                                }
                                l.draft_timer = false;
                                l.draft.text.clone()
                            };
                            me.bus.emit_json(json!({ "type": "draft", "profile": s2, "id": i2, "text": (me.opts.mask)(&text) }));
                        });
                    }
                    None
                }
            }
        };
        if let Some((_, finished)) = changed {
            let mut e = json!({ "type": "draft", "profile": slug, "id": id, "text": "" });
            if let Some(f) = finished {
                e["final"] = Value::String((self.opts.mask)(&f));
            }
            self.bus.emit_json(e);
        }
        let ty = ev.get("type").and_then(Value::as_str);
        if ty == Some("stream_event") {
            return;
        }
        self.watch_workflows(slug, id, ev, spend);
        if self.versions.learn(ev) {
            // Learned a newer model version: nothing else to do here (the file is saved).
        }
        // rememberInit (the slash command list from the init event) runs in the run's event callback.
        if refine && ty == Some("assistant") {
            self.save_mockups(slug, id, ev);
        }
        let shows = live.lock().shows_interrupted;
        if shows && !self.shutting_down() && rules::has_text(ev) {
            live.lock().shows_interrupted = false;
            self.patch_quiet(slug, id, obj(json!({ "interrupted": null })));
        }
        if let Some(read) = rules::replay_text(ev) {
            self.delivered(run, &read);
        }
        self.append_activity(slug, id, run_no, ev);
        self.bus.emit_json(json!({ "type": "activity", "profile": slug, "id": id, "run": ckanban_core::jsnum::num(run_no), "event": ev }));
        let Some(sum) = summarize_event(ev, false) else { return };
        if run.st.lock().stop_requested {
            return;
        }
        let now = self.now();
        let write = {
            let mut l = live.lock();
            l.pending_activity = Some(sum.clone());
            if now - l.last_write >= rules::ACTIVITY_THROTTLE_MS as f64 {
                l.last_write = now;
                l.pending_activity = None;
                true
            } else {
                false
            }
        };
        if write {
            self.patch_quiet(slug, id, obj(json!({ "lastActivity": sum })));
        }
    }

    /// `saveMockups`: Planning replies carry mockups as blocks (they can't write files); saved for the Outputs tab.
    fn save_mockups(&self, slug: &str, id: &str, ev: &Value) {
        let Some(Value::Array(content)) = ev.get("message").and_then(|m| m.get("content")) else { return };
        let text: Vec<&str> = content.iter().map(|b| if b.get("type").and_then(Value::as_str) == Some("text") { b.get("text").and_then(Value::as_str).unwrap_or("") } else { "" }).collect();
        let saved = crate::extras::mockups::save_mockups(&self.outputs_dir(slug, id), &text.join("\n"));
        if saved.as_ref().is_ok_and(|n| n.is_empty()) {
            return;
        }
        match saved {
            Ok(names) => {
                self.patch_quiet(slug, id, obj(json!({ "lastActivity": format!("Saved mockup{} {}", if names.len() > 1 { "s" } else { "" }, names.join(", ")) })));
            }
            Err(e) => self.note(slug, id, &format!("Couldn't save mockups: {e}")),
        }
    }

    fn on_stall(&self, run: &Arc<ActiveRun>, profile: &Map<String, Value>, stalled: bool) {
        let (slug, id) = (&run.slug, &run.id);
        if self.shutting_down() {
            return;
        }
        let Some(t) = self.get(slug, id) else { return };
        if !stalled {
            if t.is("stalled") {
                self.patch_quiet(slug, id, obj(json!({ "stalled": null })));
            }
            return;
        }
        if run.st.lock().stop_requested {
            return;
        }
        let minutes = ((self.stall_ms(profile) as f64 / 60_000.0).round()).max(1.0);
        self.patch_quiet(slug, id, obj(json!({ "stalled": { "at": now_iso(), "minutes": ckanban_core::jsnum::num(minutes) } })));
    }

    fn on_waiting(&self, run: &Arc<ActiveRun>, live: &Arc<Mutex<Live>>, tasks: Option<&[BackgroundTask]>) {
        if run.st.lock().stop_requested || self.shutting_down() {
            return;
        }
        let what = match tasks {
            None => None,
            Some([one]) => Some(format!("Waiting for background task: {}", one.description)),
            Some(list) => Some(format!("Waiting for {} background tasks", list.len())),
        };
        if what.is_some() {
            live.lock().pending_activity = None;
        }
        let list = tasks.map(|l| Value::Array(l.iter().map(BackgroundTask::to_json).collect())).unwrap_or(Value::Null);
        let mut p = obj(json!({ "waitingOn": list }));
        if let Some(w) = what {
            p.insert("lastActivity".into(), Value::String(w));
        }
        self.patch_quiet(&run.slug, &run.id, p);
    }

    /// After the process ended (blocking): what the card shows; Next says whether the board goes on.
    #[allow(clippy::too_many_arguments)]
    fn finish(&self, run: &Arc<ActiveRun>, session: &Session, prep: Prep, out: &RunOutput, handle: &runner::RunHandle, live: Arc<Mutex<Live>>, spend: Arc<Mutex<RunSpend>>, cap: Option<f64>, started_at: &str, healed: bool) -> Next {
        let (slug, id) = (run.slug.as_str(), run.id.as_str());
        run.st.lock().spend = None;
        let telegram_from = run.st.lock().telegram_from;
        if let Some(from) = telegram_from {
            let spent = spent_with(&spend) - from;
            super::text::add_telegram_spend(&self.root, spent, self.now());
            run.st.lock().telegram_from = Some(0.0);
        }
        let draft = {
            let mut l = live.lock();
            l.draft_gen += 1;
            l.draft_timer = false;
            l.draft.text.clone()
        };
        if !draft.is_empty() {
            self.bus.emit_json(json!({ "type": "draft", "profile": slug, "id": id, "text": "", "final": (self.opts.mask)(&draft) }));
        }
        run.st.lock().draft.clear();
        if self.shutting_down() {
            return Next::Done;
        }
        // The run's transcript is complete: its summary (open questions, proposals) is read now, before the card says
        // how the run ended.
        self.sessions.refresh(slug, id, &session.session_id);
        let final_text = extract_final_text(&out.events);
        let (stop_requested, restart_requested, cap_hit, chat, target) = {
            let st = run.st.lock();
            (st.stop_requested, st.restart_requested, st.workflow_cap_hit, st.chat.clone(), st.target_status.clone())
        };
        if !(handle.stopped() && restart_requested && !stop_requested) {
            let sat = self.satellite.clone();
            let (s2, i2, text) = (slug.to_string(), id.to_string(), (self.opts.mask)(&final_text));
            self.rt.spawn(async move {
                if let Err(e) = sat.turn_ended(&s2, &i2, &text).await {
                    eprintln!("[board] turnEnded {s2}/{i2}: {e}");
                }
            });
        }
        let mut result: Option<RunResult> = parse_result(&final_text).or_else(|| {
            out.events.iter().filter(|e| e.get("type").and_then(Value::as_str) == Some("result")).filter_map(|e| e.get("result").and_then(Value::as_str)).filter_map(parse_result).next_back()
        });
        let started = session.existed
            || self.session_exists(&session.session_id)
            || out.events.iter().any(|e| {
                let ty = e.get("type").and_then(Value::as_str);
                (ty == Some("system") && e.get("subtype").and_then(Value::as_str) == Some("init")) || ty == Some("assistant")
            });
        let refine = prep.refine;
        let quiet = prep.quiet;
        let pending = live.lock().pending_activity.clone();
        let mut base = self.end_status(run);
        base.insert("stalled".into(), Value::Null);
        base.insert("sessionStarted".into(), Value::Bool(started));
        base.insert("runEndedAt".into(), Value::String(now_iso()));
        if (prep.fresh || prep.fresh_chat) && started {
            base.insert("freshSession".into(), Value::Bool(false));
            base.insert("freshAuto".into(), Value::Null);
        }
        if !refine && !quiet {
            base.insert("lastRunAt".into(), Value::String(started_at.to_string()));
            base.insert("runCount".into(), ckanban_core::jsnum::num(prep.run_no));
        }
        let last = pending.map(Value::String).unwrap_or_else(|| self.get(slug, id).and_then(|t| t.get("lastActivity").cloned()).unwrap_or(Value::Null));
        base.insert("lastActivity".into(), last);
        let with = |extra: Value| -> Map<String, Value> {
            let mut p = base.clone();
            p.extend(obj(extra));
            p
        };
        // Restart on a stalled run: the stuck process is gone, now the same session picks the work up again.
        if handle.stopped() && restart_requested && !stop_requested {
            run.st.lock().restart_requested = false;
            self.note(slug, id, "Restarted the stalled run: it continues in the same session.");
            self.patch_quiet(slug, id, obj(json!({ "sessionStarted": started, "stalled": null, "lastActivity": "Restarting…" })));
            return Next::Again(rules::STALL_RESTART_TEXT.to_string());
        }
        if let (Some(hit), Some(cap)) = (cap_hit, cap) {
            self.cap_reached(slug, id, base, cap, Some(hit));
            return Next::Done;
        }
        if handle.stopped() {
            self.note(slug, id, "Run stopped by user.");
            let mut p = with(json!({ "outcome": "stopped", "error": null, "lastActivity": null }));
            p.extend(self.drop_auto_wait(slug, id));
            self.patch_quiet(slug, id, p);
            return Next::Done;
        }
        if let Some(cap) = cap
            && out.events.iter().any(|e| e.get("type").and_then(Value::as_str) == Some("result") && e.get("subtype").and_then(Value::as_str) == Some("error_max_budget_usd"))
        {
            let with_wf = if spend.lock().workflow_dirs.is_empty() { None } else { Some(spent_with(&spend)) };
            self.cap_reached(slug, id, base, cap, with_wf);
            return Next::Done;
        }
        // The account hit its usage limit: not a failure of the work.
        let limited = if quiet || result.is_some() { None } else { crate::runs::retry::limit_message(&out.events, if out.code != 0 { &out.stderr } else { "" }) };
        if let Some(m) = limited {
            self.limit_hit(slug, id, base, &m);
            return Next::Done;
        }
        if out.code != 0 {
            let stderr = js::trim(&out.stderr);
            let error = if !stderr.is_empty() {
                stderr.to_string()
            } else if !js::trim(&final_text).is_empty() {
                js::trim(&final_text).to_string()
            } else {
                format!("claude exited with code {}", out.code)
            };
            let workdir = self.get(slug, id).is_some_and(|t| t.is("workdir"));
            if !healed && !workdir && rules::session_missing(&error, &out.events) {
                eprintln!("[board] ticket {slug}/{id}: session {} not found, starting a new one", session.session_id);
                self.patch_quiet(slug, id, obj(json!({ "sessionId": super::board::uuid(), "sessionStarted": false, "error": null })));
                return Next::Healed;
            }
            let retried = run.st.lock().retried;
            let transient = if retried || stop_requested { None } else { crate::runs::retry::transient_error(&out.events, &out.stderr) };
            if let Some(tr) = transient {
                run.st.lock().retried = true;
                let delay = self.opts.retry_delay_ms;
                let line = tr.split('\n').rev().find(|l| !js::trim(l).is_empty()).map(|l| js::head16(js::trim(l), 200).to_string()).unwrap_or(tr.clone());
                let secs = ((delay as f64 / 1000.0).round()).max(1.0);
                self.note(slug, id, &format!("Run hit a temporary API error ({line}). Retrying once in {}s in the same session.", secs as i64));
                self.patch_quiet(slug, id, obj(json!({ "sessionStarted": started, "error": null, "lastActivity": "Temporary API error, retrying shortly…" })));
                return Next::Retry(delay);
            }
            let shown = if rules::session_missing(&error, &out.events) && !rules::session_missing(&error, &[]) {
                format!("No conversation found with session ID: {}", session.session_id)
            } else {
                rules::claude_setup_hint(&error).map(str::to_string).unwrap_or(error)
            };
            let lines: Vec<&str> = shown.split('\n').collect();
            let tail = lines[lines.len().saturating_sub(3)..].join("\n");
            self.note(slug, id, &format!("Run failed (exit {}): {tail}", out.code));
            self.patch_quiet(slug, id, with(json!({ "outcome": "failed", "error": shown })));
            return Next::Done;
        }
        let body = js::trim(&super::text::result_body(&final_text)).to_string();
        let Some(current) = self.get(slug, id) else { return Next::Done };
        // A working main ticket's reply that only answered or reported progress isn't waiting on the user.
        if let Some(r) = &result {
            let asked = !self.open_form(&current).is_empty() || body.contains('?') || self.keys_open(&current);
            let running_plan = current.plan_state() == Some("running");
            if r.status == "questions" && current.main && !current.tool && running_plan && !asked {
                result = Some(RunResult { status: "done".into(), ..r.clone() });
            }
        }
        let nudge = chat.as_ref().is_some_and(|c| c.nudge);
        let prs = |cur: &Tk, urls: &[String]| crate::git::pr::add_prs(&Value::Object(cur.json.clone()), urls);
        if quiet && !refine && !nudge && let Some(r) = &result {
            let text = if r.status == "questions" { body.clone() } else { r.summary.clone() };
            self.note(slug, id, if !text.is_empty() { &text } else if !body.is_empty() { &body } else { "(no output)" });
            let mut p = with(json!({ "lastActivity": null, "error": null }));
            if !current.is("autoHuddle") {
                p.insert("outcome".into(), Value::String(if r.status == "questions" { "needs_input".into() } else { r.status.clone() }));
                if r.status == "questions" {
                    p.insert("interviewed".into(), Value::Bool(true));
                }
            }
            if !current.is("plan") {
                p.extend(prs(&current, &r.pr_urls));
            }
            if current.kind.as_deref() == Some("test") && !current.is("autoHuddle") && r.status == "done" {
                p.insert("verdict".into(), r.verdict.clone().map(Value::String).unwrap_or(Value::Null));
            }
            self.patch_quiet(slug, id, p);
            return Next::Done;
        }
        if refine || quiet {
            self.patch_quiet(slug, id, with(json!({ "lastActivity": null, "error": null })));
            return Next::Done;
        }
        let blocked = result.as_ref().is_some_and(|r| r.status == "blocked");
        if let Some(c) = &chat
            && c.act()
            && target.is_none()
            && !blocked
            && super::text::moves_to_planning(&final_text)
        {
            let summary = result.as_ref().map(|r| r.summary.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| if body.is_empty() { "(no output)".into() } else { body.clone() });
            self.note(slug, id, &summary);
            let mut p = with(json!({ "status": "planning", "outcome": null, "error": null, "refineStarted": true, "lastActivity": null }));
            if let Some((st, oc)) = &c.from
                && rules::reopenable(st)
            {
                p.insert("reopenedFrom".into(), json!({ "status": st, "outcome": oc }));
            }
            self.patch_quiet(slug, id, p);
            return Next::Done;
        }
        if let Some(c) = &chat
            && c.act()
            && !c.raw
            && target.is_none()
            && let Some((st, oc)) = &c.from
            && st != "in_progress"
            && !blocked
            && super::text::stays(&final_text)
            && !self.huddle_open(slug, id)
        {
            self.patch_quiet(slug, id, with(json!({ "status": st, "outcome": oc, "error": null, "lastActivity": null })));
            return Next::Done;
        }
        // A quiet schedule's run that found nothing: Done without a word to the user.
        if chat.is_none() && target.is_none() && let Some(r) = &result
            && self.can_end_quietly(slug, &current, r)
            && !self.huddle_open(slug, id)
        {
            let summary = if !r.summary.is_empty() { r.summary.clone() } else if !body.is_empty() { body.clone() } else { "Nothing new.".into() };
            run.st.lock().quiet_end = Some((summary.clone(), spent_with(&spend)));
            self.note(slug, id, &summary);
            self.patch_quiet(slug, id, with(json!({ "status": "done", "outcome": "done", "error": null, "lastActivity": null })));
            return Next::Done;
        }
        let questions = result.as_ref().is_some_and(|r| r.status == "questions");
        let summary = {
            let x = if questions { body.clone() } else { result.as_ref().map(|r| r.summary.clone()).unwrap_or_default() };
            if !x.is_empty() {
                x
            } else if !body.is_empty() {
                body.clone()
            } else {
                "(no output)".into()
            }
        };
        self.note(slug, id, &summary);
        let urls: Vec<String> = result.as_ref().map(|r| r.pr_urls.clone()).unwrap_or_default();
        if let Some(auto) = current.get("autoHuddle").filter(|a| js::truthy(Some(a)))
            && target.is_none()
            && !blocked
            && !questions
        {
            let mut p = with(json!({ "status": "in_progress", "outcome": null, "error": null, "lastActivity": rules::auto_huddle_activity(auto) }));
            p.extend(prs(&current, &urls));
            self.patch_quiet(slug, id, p);
            return Next::Done;
        }
        let asks = questions || blocked;
        if chat.as_ref().is_some_and(|c| c.follow_up) && asks && matches!(base.get("status").and_then(Value::as_str), Some("done" | "backlog")) {
            base.insert("status".into(), "review".into());
        }
        let status_done = result.as_ref().map(|r| r.status.as_str()).unwrap_or("done") == "done";
        let merge_fails = current.get("mergeFails").and_then(Value::as_f64).unwrap_or(0.0);
        let unmerged = current.tool && merge_fails >= crate::git::landing::MERGE_TRIES as f64 && status_done;
        let tool_done = current.tool && !unmerged && status_done && target.is_none() && !self.huddle_open(slug, id);
        let mut p = base.clone();
        if tool_done {
            p.insert("status".into(), "done".into());
        }
        let outcome = if unmerged {
            "blocked".to_string()
        } else if questions {
            "needs_input".into()
        } else {
            result.as_ref().map(|r| r.status.clone()).unwrap_or_else(|| "done".into())
        };
        p.insert("outcome".into(), Value::String(outcome));
        if questions {
            p.insert("interviewed".into(), Value::Bool(true));
        }
        if !(chat.as_ref().is_some_and(|c| c.raw && !c.host_wake)) {
            p.extend(prs(&current, &urls));
        }
        if current.kind.as_deref() == Some("test") && let Some(r) = &result {
            p.insert("verdict".into(), r.verdict.clone().map(Value::String).unwrap_or(Value::Null));
        }
        p.insert("error".into(), Value::Null);
        self.patch_quiet(slug, id, p);
        if unmerged {
            self.note(slug, id, &format!("Ended blocked: merging into the main ticket's copy failed {} times.", crate::git::landing::MERGE_TRIES));
        }
        self.families.report_to_main(slug, id, &summary);
        self.note_step_waiting(slug, id, &summary);
        Next::Done
    }

    /// `canEndQuietly` (`src/schedules/quiet.ts`): a quiet schedule's run that found nothing for the user.
    fn can_end_quietly(&self, slug: &str, t: &Tk, r: &RunResult) -> bool {
        let Some(sid) = ts(t, "scheduleId") else { return false };
        let file = ckanban_core::DataDir::new(self.root.clone()).profile_dir(slug).join("schedules").join(format!("{sid}.json"));
        let Some(s) = std::fs::read_to_string(file).ok().and_then(|x| js::parse(&x)) else { return false };
        if !js::truthy(s.get("quiet")) || !r.quiet {
            return false;
        }
        if s.get("id").and_then(Value::as_str) != Some(sid) {
            return false;
        }
        if !r.pr_urls.is_empty() || t.is("prUrl") || t.is("autoHuddle") || !self.waiting(slug, &t.id).is_empty() {
            return false;
        }
        let list = self.tickets.list(slug);
        !list.tickets.iter().any(|o| o.get("raisedBy").and_then(|b| b.get("ticketId")).and_then(Value::as_str) == Some(&t.id))
    }

    /// `noteStepWaiting`: a "with you" step ended waiting for the user: a board note in its main ticket's chat.
    fn note_step_waiting(&self, slug: &str, id: &str, summary: &str) {
        let Some(t) = self.get(slug, id) else { return };
        if !crate::index::attention::you_waiting(&t, false) {
            return;
        }
        let list = self.tickets.list(slug);
        let Some(main) = crate::index::family::main_of(&list, &t).map(|i| list.tickets[i].clone()).filter(|m| m.id != id) else { return };
        let form = self.open_form(&t);
        let ask = form.first().and_then(|q| q.get("question")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| summary.to_string());
        let first = ask.split('\n').map(super::text::strip_bullet).find(|l| !l.is_empty()).unwrap_or_default();
        let line = if js::len16(&first) > 160 { format!("{}…", js::head16(&first, 159)) } else { first };
        let text = format!("{} needs you{}", crate::index::attention::step_name(&t), if line.is_empty() { String::new() } else { format!(": {line}") });
        let note = json!({ "at": now_iso(), "ticketId": t.id, "text": text });
        let _ = self.tickets.update_with(slug, &main.id, |meta| {
            let mut notes = meta.get("boardNotes").and_then(Value::as_array).cloned().unwrap_or_default();
            notes.push(note);
            let keep = notes.len().saturating_sub(30);
            Ok(obj(json!({ "boardNotes": notes[keep..].to_vec() })))
        });
    }

    /// `openForm`: the questions form in the ticket's chat still waiting for the user's answers.
    pub fn open_form(&self, t: &Tk) -> Vec<Value> {
        if crate::index::family::ask_closed(t) {
            return Vec::new();
        }
        ts(t, "sessionId").and_then(|s| self.sessions.summary(s)).and_then(|s| s.get("openForm").and_then(Value::as_array).cloned()).unwrap_or_default()
    }

    /// `keysOpen`: a key box in the chat still waits for the user.
    pub fn keys_open(&self, t: &Tk) -> bool {
        let pending = ts(t, "sessionId").and_then(|s| self.sessions.summary(s)).and_then(|s| s.get("pendingKeys").and_then(Value::as_array).cloned()).unwrap_or_default();
        let cards = t.get("keyCards");
        pending.iter().filter_map(Value::as_str).any(|k| !js::truthy(cards.and_then(|c| c.get(k))))
    }

    /// `watchWorkflows`: keep a run's workflow progress for the chat, and what it spends for the cap.
    fn watch_workflows(&self, slug: &str, id: &str, ev: &Value, spend: &Arc<Mutex<RunSpend>>) {
        let ty = ev.get("type").and_then(Value::as_str);
        if ty == Some("system") && ev.get("subtype").and_then(Value::as_str) == Some("task_progress") {
            if let (Some(tool), Some(p)) = (ev.get("tool_use_id").and_then(Value::as_str), ev.get("workflow_progress").filter(|p| p.is_array())) {
                self.state.lock().workflow_live.insert(format!("{slug}/{id}/{tool}"), p.clone());
            }
        } else if ty == Some("assistant") && let Some(usage) = ev.get("message").and_then(|m| m.get("usage")).filter(|u| js::truthy(Some(u))) {
            let mut sp = spend.lock();
            let mid = ev.get("message").and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("#{}", sp.main.len()));
            let model = ev.get("message").and_then(|m| m.get("model")).map(js::to_string).unwrap_or_default();
            let cost = crate::sessions::workflows::message_cost(&model, usage);
            if sp.main.insert(mid.clone(), cost).is_none() {
                sp.main_order.push(mid);
            }
        } else if ty == Some("user") && let Some(Value::Array(content)) = ev.get("message").and_then(|m| m.get("content")) {
            for b in content {
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let text = match b.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a.iter().map(|c| c.get("text").and_then(Value::as_str).unwrap_or("")).collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                if text.starts_with("Workflow launched")
                    && let Some(dir) = crate::sessions::workflows::transcript_dir_of(&text)
                {
                    let mut sp = spend.lock();
                    if !sp.workflow_dirs.contains(&dir) {
                        sp.workflow_dirs.push(dir);
                    }
                }
            }
        }
    }

    /// The live progress of a workflow in this ticket's run (`workflowProgress`).
    pub fn workflow_progress(&self, slug: &str, id: &str, tool_use_id: &str) -> Option<Value> {
        self.state.lock().workflow_live.get(&format!("{slug}/{id}/{tool_use_id}")).cloned()
    }
}

/// What the board does after an attempt.
pub(super) enum Next {
    Done,
    /// Continue in the same session with this text (a stall restart).
    Again(String),
    /// Start over once in a new session (Claude lost the old one).
    Healed,
    /// A passing API error: resume once after this many ms.
    Retry(u64),
}

#[allow(dead_code)]
fn _unused(_: HashMap<String, String>) {}
