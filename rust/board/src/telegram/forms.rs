//! A ticket's question form answered from Telegram (`src/helper/tgforms.ts`). One message per question follows an
//! alert that names a ticket waiting on a form: numbered buttons (up to 8), "Type my own", and on a form with a
//! multi-select "Done, send my answers"; once every question has an answer the answers go to the ticket once, in the
//! board's format. A form is a pending action (kind "form") kept on disk, so taps survive a restart.

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::replies::Incoming;
use super::stores::{Action, LinkItem, State, Take, action_data, action_id, action_used, action_used_by};
use super::text::{NOT_TAKING, board_answer, clock_hm, form_answer_text, form_message, multi, question_text, questions, rows_of, short};
use super::{Button, Out, Rows, Say, Telegram, s};
use crate::helper::waits::normalize_question;
use crate::runs::js;
use ckanban_core::time::parse_date;

/// A form shown on Telegram can be answered this long.
pub const FORM_TTL_MS: f64 = 24.0 * 3600_000.0;
/// Numbered buttons per question.
pub const MAX_BUTTONS: usize = 8;
/// Tickets per alert whose forms are shown.
pub const FORMS_PER_ALERT: usize = 3;
pub const TYPE_OWN: &str = "Type my own";
pub const DONE: &str = "Done, send my answers";

fn sig(qs: &[Value]) -> String {
    let v: Vec<Value> = qs
        .iter()
        .map(|q| {
            let labels: Vec<Value> = q.get("options").and_then(Value::as_array).map(|o| o.iter().map(|x| x.get("label").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
            json!([q.get("question").cloned().unwrap_or(Value::Null), q.get("multiSelect").cloned().unwrap_or(Value::Null), labels])
        })
        .collect();
    js::stringify(&Value::Array(v))
}

fn has_multi(d: &Value) -> bool {
    questions(d).iter().any(multi)
}

fn answered(d: &Value, i: usize) -> bool {
    let a = board_answer(d, i);
    !a.picked.is_empty() || !js::trim(&a.other).is_empty()
}

fn msgs(d: &Value) -> Vec<Option<i64>> {
    d.get("msgs").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_f64().map(|n| n as i64)).collect()).unwrap_or_default()
}

/// `d.msgs.at(-1) ?? d.alertTg ?? undefined`.
fn last_or_alert(d: &Value) -> Option<i64> {
    msgs(d).last().copied().flatten().or_else(|| d.get("alertTg").and_then(Value::as_f64).map(|n| n as i64))
}

fn n_questions(d: &Value) -> usize {
    questions(d).len()
}

fn d_mut(d: &mut Value) -> &mut Map<String, Value> {
    if !d.is_object() {
        *d = Value::Object(Map::new());
    }
    d.as_object_mut().expect("object")
}

impl Telegram {
    /// The form the ticket asks now, if it is the one this wait is about (`openForm`).
    fn open_form(&self, board: &str, ticket_id: &str, key: Option<&str>) -> Option<Vec<Value>> {
        let t = self.ticket(board, ticket_id)?;
        if t.status == "done" || t.status == "in_progress" || self.running(board, ticket_id) {
            return None;
        }
        let form: Vec<Value> = t
            .s("sessionId")
            .filter(|x| !x.is_empty())
            .and_then(|sid| self.helper.core.board.session(sid))
            .and_then(|sum| sum.get("openForm").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        if form.is_empty() {
            return None;
        }
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            let rec = self.helper.core.lock().waits.get(k).cloned()?;
            if js::truthy(rec.get("closedAt")) || rec.get("kind").and_then(Value::as_str) != Some("questions") {
                return None;
            }
            let asked: Vec<String> = form.iter().map(|q| js::to_string(q.get("question").unwrap_or(&Value::Null))).collect();
            if normalize_question(rec.get("question").and_then(Value::as_str).unwrap_or("")) != normalize_question(&asked.join("\n")) {
                return None;
            }
        }
        Some(form)
    }

    /// Open forms (not sent, dropped or expired), oldest first.
    fn open_forms(&self, f: &dyn Fn(&Value) -> bool) -> Vec<Action> {
        let now = self.now();
        let mut v: Vec<Action> = self
            .pending
            .all(Some("form"))
            .into_iter()
            .filter(|a| !action_used(a) && a.get("expiresAt").and_then(Value::as_str).and_then(parse_date).is_some_and(|e| e > now) && js::truthy(a.get("data")) && f(action_data(a)))
            .collect();
        v.sort_by(|a, b| js::locale_compare(s(&Value::Object(a.clone()), "at"), s(&Value::Object(b.clone()), "at")));
        v
    }

    /// Whether any form is open (the 1 s look at changed tickets skips the work otherwise).
    pub fn has_open_forms(&self) -> bool {
        !self.open_forms(&|_| true).is_empty()
    }

    fn form_head(&self, d: &Value) -> String {
        let (board, id) = (s(d, "board"), s(d, "ticketId"));
        let title = self.ticket(board, id).map(|t| t.title.clone()).unwrap_or_else(|| id.to_string());
        let n = n_questions(d);
        let asks = if n == 1 { "a question".to_string() } else { format!("{n} questions") };
        format!("❓ {}: \"{title}\" asks {asks}", self.board_name(board))
    }

    fn form_buttons(&self, id: &str, d: &Value, i: usize) -> Rows {
        let qs = questions(d);
        let q = &qs[i];
        let (picked, _) = super::text::answer_at(d, i);
        let opts = q.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
        let nums: Vec<Button> = opts
            .iter()
            .take(MAX_BUTTONS)
            .enumerate()
            .map(|(k, o)| {
                let label = js::to_string(o.get("label").unwrap_or(&Value::Null));
                let text = if picked.contains(&label) { format!("{} ✓", k + 1) } else { format!("{}", k + 1) };
                Button::data(&text, format!("p:{id}:{i}{k}"))
            })
            .collect();
        let mut rows = rows_of(&nums);
        rows.push(vec![Button::data(TYPE_OWN, format!("p:{id}:{i}o"))]);
        if i == qs.len() - 1 && has_multi(d) {
            rows.push(vec![Button::data(DONE, format!("p:{id}:d"))]);
        }
        rows
    }

    /// An alert went out: forms of the tickets it names (at most 3) follow it, once per form.
    pub async fn forms_show(&self, items: &[LinkItem], alert_tg: i64, chat_id: i64) {
        let mut seen = std::collections::HashSet::new();
        let mut shown = 0;
        for i in items {
            let Some(key) = i.key.as_deref().filter(|k| !k.is_empty()) else { continue };
            if seen.contains(&format!("{}/{}", i.board, i.ticket_id)) || shown >= FORMS_PER_ALERT {
                continue;
            }
            seen.insert(format!("{}/{}", i.board, i.ticket_id));
            let Some(form) = self.open_form(&i.board, &i.ticket_id, Some(key)) else { continue };
            shown += 1;
            self.show_form(&i.board, &i.ticket_id, key, form, alert_tg, chat_id).await;
        }
    }

    async fn show_form(&self, board: &str, ticket_id: &str, key: &str, qs: Vec<Value>, alert_tg: i64, chat_id: i64) {
        let Some(out) = self.out(chat_id, true) else { return };
        let sg = sig(&qs);
        let existing = self
            .open_forms(&|d| d.get("chatId").and_then(Value::as_f64) == Some(chat_id as f64) && s(d, "board") == board && s(d, "ticketId") == ticket_id && s(d, "key") == key && sig(&questions(d)) == sg)
            .pop();
        let mut a = match existing {
            Some(a) => a,
            None => {
                let n = qs.len();
                let data = json!({
                    "chatId": chat_id, "board": board, "ticketId": ticket_id, "key": key, "questions": qs, "alertTg": alert_tg,
                    "answers": (0..n).map(|_| json!({ "picked": [], "other": "" })).collect::<Vec<_>>(),
                    "msgs": vec![Value::Null; n], "prompts": [],
                });
                match self.pending.create("form", data, FORM_TTL_MS, self.now()) {
                    Ok(a) => a,
                    Err(e) => {
                        eprintln!("telegram: form: {e}");
                        return;
                    }
                }
            }
        };
        let id = action_id(&a).to_string();
        let head = self.form_head(action_data(&a));
        for i in 0..qs.len() {
            if msgs(action_data(&a)).get(i).copied().flatten().is_some() {
                continue;
            }
            let d = action_data(&a).clone();
            let reply_to = if i == 0 { alert_tg } else { msgs(&d).first().copied().flatten().unwrap_or(alert_tg) };
            let say = Say {
                reply_to: Some(reply_to),
                buttons: self.form_buttons(&id, &d, i),
                link: vec![LinkItem::new(board, ticket_id, Some(key))],
                level: Some("form".into()),
                force_reply: None,
            };
            let Some(tg) = out.say(&question_text(&d, i, &head), say).await else { return };
            // Read again: a tap may have changed it meanwhile.
            let Some((now_a, _)) = self.pending.peek(&id, self.now()) else { return };
            let mut nd = action_data(&now_a).clone();
            if let Some(m) = nd.get_mut("msgs").and_then(Value::as_array_mut)
                && i < m.len()
            {
                m[i] = tg.into();
            }
            self.pending.update(&id, nd.clone(), self.now());
            a = now_a;
            a.insert("data".into(), nd);
        }
    }

    /// The form a Telegram message (a question or a "Type my own" prompt) belongs to: (form, question, prompt).
    fn by_message(&self, chat_id: i64, tg: i64) -> Option<(Action, usize, bool)> {
        for a in self.pending.all(Some("form")).into_iter().rev() {
            let d = action_data(&a);
            if !d.is_object() || d.get("chatId").and_then(Value::as_f64) != Some(chat_id as f64) {
                continue;
            }
            if let Some(q) = msgs(d).iter().position(|m| *m == Some(tg)) {
                return Some((a, q, false));
            }
            let p = d.get("prompts").and_then(Value::as_array).and_then(|ps| ps.iter().find(|x| x.get("tg").and_then(Value::as_f64) == Some(tg as f64)).cloned());
            if let Some(p) = p {
                let q = p.get("q").and_then(Value::as_f64).unwrap_or(0.0) as usize;
                return Some((a, q, true));
            }
        }
        None
    }

    /// Whether the form still asks what the ticket asks; if not, it is closed and its messages say why.
    fn still_asked<'a>(&'a self, a: &'a Action) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let d = action_data(a);
            let (board, id) = (s(d, "board"), s(d, "ticketId"));
            let form = self.open_form(board, id, Some(s(d, "key")));
            if form.as_ref().is_some_and(|f| sig(f) == sig(&questions(d))) {
                return true;
            }
            let why = if self.ticket(board, id).is_some() && form.is_none() { "board" } else { "gone" };
            self.drop_form(a, why).await;
            false
        })
    }

    /// A tap on a form's button (choice "<q><k>", "<q>o" or "d").
    pub async fn forms_on_tap(&self, id: &str, choice: &str, chat_id: i64, message_id: i64, out: &Out, update_id: Option<i64>) -> String {
        let Some((a, st)) = self.pending.peek(id, self.now()) else { return "That button no longer works.".into() };
        if action_data(&a).get("chatId").and_then(Value::as_f64) != Some(chat_id as f64) {
            return "That button no longer works.".into();
        }
        let closed = s(action_data(&a), "closed").to_string();
        if st == State::Used {
            if update_id.is_some() && action_used_by(&a) == update_id && closed == "sent" {
                return self.finish(&a, update_id.unwrap_or(0), message_id, true).await;
            }
            return if closed == "sent" { "Already sent".into() } else { "This form is closed.".into() };
        }
        if st == State::Expired {
            if message_id != 0 {
                let d = action_data(&a);
                let q = msgs(d).iter().position(|m| *m == Some(message_id)).unwrap_or(0);
                out.edit(message_id, &format!("{}\n\nThis expired. Answer on the board.", question_text(d, q, &self.form_head(d))), None).await;
            }
            return "This form expired.".into();
        }
        if !self.still_asked(&a).await {
            return "Already answered".into();
        }
        if choice == "d" {
            return self.finish(&a, update_id.unwrap_or(0), message_id, false).await;
        }
        let bytes = choice.as_bytes();
        let ok = bytes.len() == 2 && bytes[0].is_ascii_digit() && (bytes[1].is_ascii_digit() || bytes[1] == b'o');
        let q = if ok { (bytes[0] - b'0') as usize } else { usize::MAX };
        let mut d = action_data(&a).clone();
        let qs = questions(&d);
        let Some(question) = qs.get(q).cloned().filter(|_| ok) else { return "That button no longer works.".into() };
        if bytes[1] == b'o' {
            let n = qs.len();
            let head = format!("({} of {n})", q + 1);
            let qtext = js::to_string(question.get("question").unwrap_or(&Value::Null));
            let say = Say {
                reply_to: msgs(&d).get(q).copied().flatten(),
                force_reply: Some("Your answer".into()),
                link: vec![LinkItem::new(s(&d, "board"), s(&d, "ticketId"), Some(s(&d, "key")))],
                level: Some("form".into()),
                buttons: Vec::new(),
            };
            let tg = match self.out(chat_id, true) {
                Some(o) => o.say(&format!("Type your answer to {head} {} as a reply to this message.", short(&qtext, 200)), say).await,
                None => None,
            };
            let Some(tg) = tg else { return "Couldn't ask. Try again.".into() };
            let Some((now_a, _)) = self.pending.peek(id, self.now()) else { return "Type your answer".into() };
            let mut nd = action_data(&now_a).clone();
            let mut prompts = nd.get("prompts").and_then(Value::as_array).cloned().unwrap_or_default();
            prompts.push(json!({ "tg": tg, "q": q }));
            let keep = prompts.len().saturating_sub(20);
            d_mut(&mut nd).insert("prompts".into(), Value::Array(prompts[keep..].to_vec()));
            self.pending.update(id, nd, self.now());
            return "Type your answer".into();
        }
        let k = (bytes[1] - b'0') as usize;
        let Some(opt) = question.get("options").and_then(|o| o.get(k)).cloned() else { return "That button no longer works.".into() };
        let label = js::to_string(opt.get("label").unwrap_or(&Value::Null));
        let mut ans = d.get("answers").and_then(|x| x.get(q)).cloned().unwrap_or_else(|| json!({ "picked": [], "other": "" }));
        let mut picked: Vec<Value> = ans.get("picked").and_then(Value::as_array).cloned().unwrap_or_default();
        let has = picked.iter().any(|p| js::to_string(p) == label);
        if multi(&question) {
            if has {
                picked.retain(|p| js::to_string(p) != label);
            } else {
                picked.push(label.clone().into());
            }
            ans["picked"] = Value::Array(picked.clone());
        } else {
            ans["picked"] = json!([label]);
            ans["other"] = "".into();
        }
        if let Some(list) = d.get_mut("answers").and_then(Value::as_array_mut)
            && q < list.len()
        {
            list[q] = ans;
        }
        self.pending.update(id, d.clone(), self.now());
        let mut a2 = a.clone();
        a2.insert("data".into(), d.clone());
        if !has_multi(&d) && (0..n_questions(&d)).all(|i| answered(&d, i)) {
            return self.finish(&a2, update_id.unwrap_or(0), message_id, false).await;
        }
        self.redraw(&a2, q).await;
        let now_picked = super::text::answer_at(&d, q).0.contains(&label);
        if multi(&question) && !now_picked { format!("Unticked {}", short(&label, 60)) } else { format!("✓ {}", short(&label, 60)) }
    }

    async fn redraw(&self, a: &Action, q: usize) {
        let d = action_data(a);
        let Some(tg) = msgs(d).get(q).copied().flatten() else { return };
        let Some(chat) = d.get("chatId").and_then(Value::as_f64) else { return };
        let Some(out) = self.out(chat as i64, true) else { return };
        out.edit(tg, &question_text(d, q, &self.form_head(d)), Some(self.form_buttons(action_id(a), d, q))).await;
    }

    /// A reply to a form's question or its "Type my own" prompt: that question's answer, no echo.
    pub async fn forms_on_reply(&self, r: &Incoming, out: &Out) -> bool {
        let Some((hit, hq, prompt)) = self.by_message(r.chat_id, r.reply_to) else { return false };
        let Some((a, st)) = self.pending.peek(action_id(&hit), self.now()) else { return false };
        let closed = s(action_data(&a), "closed").to_string();
        if st == State::Used {
            if action_used_by(&a) == Some(r.update_id) && closed == "sent" {
                self.finish(&a, r.update_id, r.tg, true).await;
                return true;
            }
            let text = if closed == "sent" { "That form was already sent, so I didn't send this." } else { "That form was already answered, so I didn't send this." };
            out.say(text, Say::reply(r.tg)).await;
            return true;
        }
        if st == State::Expired {
            out.say("That form expired, so I didn't send this. Answer on the board.", Say::reply(r.tg)).await;
            return true;
        }
        if !self.still_asked(&a).await {
            out.say("That question was already answered, so I didn't send this.", Say::reply(r.tg)).await;
            return true;
        }
        if r.text.starts_with('/') {
            out.say("Commands only work on the board, so I didn't take this as an answer.", Say::reply(r.tg)).await;
            return true;
        }
        let mut d = action_data(&a).clone();
        let qs = questions(&d);
        let is_multi = qs.get(hq).is_some_and(multi);
        if let Some(ans) = d.get_mut("answers").and_then(|x| x.get_mut(hq)) {
            ans["other"] = r.text.clone().into();
            if !is_multi {
                ans["picked"] = json!([]);
            }
        }
        let id = action_id(&a).to_string();
        self.pending.update(&id, d.clone(), self.now());
        let mut a2 = a.clone();
        a2.insert("data".into(), d.clone());
        if !has_multi(&d) && (0..n_questions(&d)).all(|i| answered(&d, i)) {
            self.finish(&a2, r.update_id, r.tg, false).await;
            return true;
        }
        self.redraw(&a2, hq).await;
        let n = qs.len();
        let left = (0..n).filter(|i| !answered(&d, *i)).count();
        let tail = if has_multi(&d) { " Tap Done when you're ready.".to_string() } else if left > 0 { format!(" {left} to go.") } else { String::new() };
        let note = format!("✓ Noted your answer to ({} of {n}).{tail}", hq + 1);
        if prompt {
            if let Some(o) = d.get("chatId").and_then(Value::as_f64).and_then(|c| self.out(c as i64, true)) {
                o.edit(r.reply_to, &note, None).await;
            }
        } else {
            out.say(&note, Say::reply(r.tg)).await;
        }
        true
    }

    fn sent_line(&self, d: &Value) -> String {
        let id = s(d, "ticketId");
        let title = self.ticket(s(d, "board"), id).map(|t| t.title.clone()).unwrap_or_else(|| id.to_string());
        let n = n_questions(d);
        let what = match n {
            1 => "your answer".to_string(),
            2 => "both answers".to_string(),
            n => format!("all {n} answers"),
        };
        format!("✓ Sent {what} to \"{title}\".")
    }

    /// Sends the form's answers as one message; taken first (with the update that finished it).
    fn finish<'a>(&'a self, a: &'a Action, update_id: i64, tg: i64, replay: bool) -> BoxFuture<'a, String> {
        Box::pin(async move {
            let mut d = action_data(a).clone();
            let id = action_id(a).to_string();
            let chat = d.get("chatId").and_then(Value::as_f64).map(|c| c as i64).unwrap_or(0);
            let out = self.out(chat, true);
            if !replay {
                d_mut(&mut d).insert("closed".into(), "sent".into());
                self.pending.update(&id, d.clone(), self.now());
                if let Take::Gone(_) = self.pending.take(&id, Some(update_id), self.now()) {
                    return "Already sent".into();
                }
            }
            let r = self.form_send(&d, update_id, tg).await;
            if r != "sent" {
                if r != "already"
                    && let Some(o) = &out
                {
                    o.say(&r, Say::reply_opt(last_or_alert(&d))).await;
                }
                return if r == "already" { "Already sent".into() } else { "Not sent".into() };
            }
            let head = self.form_head(&d);
            self.close_messages(&d, &|i| format!("{}\n\n✓ {}", question_text(&d, i, &head), short(&form_answer_text(&d, i), 300))).await;
            if let Some(o) = &out {
                o.say(&self.sent_line(&d), Say::reply_opt(last_or_alert(&d))).await;
            }
            "Sent".into()
        })
    }

    /// Into the ticket's chat: "sent", "already", or what to tell the user.
    async fn form_send(&self, d: &Value, update_id: i64, tg: i64) -> String {
        if !self.taking() {
            return NOT_TAKING.into();
        }
        let (board, id) = (s(d, "board"), s(d, "ticketId"));
        let title = self.ticket(board, id).map(|t| t.title.clone()).unwrap_or_else(|| "the ticket".into());
        let from = json!({ "updateId": update_id, "tg": tg, "chatId": d.get("chatId").cloned().unwrap_or(Value::Null), "key": d.get("key").cloned().unwrap_or(Value::Null) });
        match self.env.chat_from_telegram(board, id, &form_message(d), from).await {
            Ok(true) => "sent".into(),
            Ok(false) => "already".into(),
            Err(e) => format!("Couldn't send your answers to \"{title}\": {e}"),
        }
    }

    /// Each question's message changes to its closing line, without buttons.
    async fn close_messages(&self, d: &Value, text: &(dyn Fn(usize) -> String + Sync)) {
        let Some(out) = d.get("chatId").and_then(Value::as_f64).and_then(|c| self.out(c as i64, true)) else { return };
        for (i, m) in msgs(d).into_iter().enumerate() {
            if let Some(tg) = m {
                out.edit(tg, &text(i), None).await;
            }
        }
    }

    /// Closes an open form: its taps are dropped and its messages say why.
    async fn drop_form(&self, a: &Action, why: &str) {
        let mut d = action_data(a).clone();
        d_mut(&mut d).insert("closed".into(), why.into());
        let id = action_id(a).to_string();
        self.pending.update(&id, d.clone(), self.now());
        if let Take::Gone(_) = self.pending.take(&id, None, self.now()) {
            return;
        }
        let qs = questions(&d);
        let n = qs.len();
        let line = match why {
            "board" => format!("✓ Answered on the Mac {}", clock_hm(self.now())),
            "typed" => "✓ Answered by your message".into(),
            _ => "This question is no longer open.".into(),
        };
        let qline = |i: usize| format!("({} of {n}) {}", i + 1, js::to_string(qs.get(i).and_then(|q| q.get("question")).unwrap_or(&Value::Null)));
        self.close_messages(&d, &|i| format!("{}\n\n{line}", qline(i))).await;
    }

    /// Other text is about to reach this ticket: a half-answered form's answers go first. False when they couldn't.
    pub async fn forms_flush_before(&self, board: &str, ticket_id: &str, update_id: i64, tg: i64) -> bool {
        let done = self
            .pending
            .all(Some("form"))
            .into_iter()
            .find(|a| action_used(a) && action_used_by(a) == Some(-update_id) && s(action_data(a), "board") == board && s(action_data(a), "ticketId") == ticket_id);
        if let Some(a) = done {
            let r = self.form_send(action_data(&a), -update_id, tg).await;
            return r == "sent" || r == "already";
        }
        for a in self.open_forms(&|d| s(d, "board") == board && s(d, "ticketId") == ticket_id) {
            let d0 = action_data(&a);
            if !(0..n_questions(d0)).any(|i| answered(d0, i)) || !self.still_asked(&a).await {
                continue;
            }
            let mut d = d0.clone();
            d_mut(&mut d).insert("closed".into(), "sent".into());
            let id = action_id(&a).to_string();
            self.pending.update(&id, d.clone(), self.now());
            if let Take::Gone(_) = self.pending.take(&id, Some(-update_id), self.now()) {
                continue;
            }
            let r = self.form_send(&d, -update_id, tg).await;
            if r != "sent" && r != "already" {
                return false;
            }
            let head = self.form_head(&d);
            self.close_messages(&d, &|i| format!("{}\n\n✓ Sent with your message", question_text(&d, i, &head))).await;
        }
        true
    }

    /// Text reached the ticket from Telegram: forms still open for it are closed by it.
    pub async fn forms_closed_by_text(&self, board: &str, ticket_id: &str) {
        for a in self.open_forms(&|d| s(d, "board") == board && s(d, "ticketId") == ticket_id) {
            self.drop_form(&a, "typed").await;
        }
    }

    /// The ticket changed: an open form it no longer asks was answered on the board (or replaced).
    pub async fn forms_sync(&self, board: &str, ticket_id: &str) {
        for a in self.open_forms(&|d| s(d, "board") == board && s(d, "ticketId") == ticket_id) {
            self.still_asked(&a).await;
        }
    }
}
