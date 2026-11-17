//! A Telegram reply to an alert goes into that ticket's chat (`src/helper/tgreply.ts`): an answer to its open
//! question gets a Send echo first (Settings can turn it off); anything else a Confirm; a usage limit, proposal or
//! huddle "This needs the board."; an old or answered alert sends nothing (an answered one offers "Send anyway"); a
//! summary about several tickets asks which one. Buttons are pending actions (single-use, ~10 minutes); every tap
//! checks the ticket again. When a ticket that got a message from Telegram ends its turn, its reply goes back.

use serde_json::{Value, json};

use super::stores::{ACTION_TTL_MS, Action, LinkItem, Take, action_card, action_data, action_id, action_kind, link_items};
use super::text::{NEEDS_BOARD, NOT_TAKING, TELEGRAM_MAX, report_parts, short};
use super::{Button, Out, Rows, Say, Telegram, s};
use crate::helper::waits::Rec;
use crate::runs::js;
use ckanban_core::time::{iso, parse_date};

/// A reply to an alert older than this is refused.
pub const STALE_REPLY_MS: f64 = 24.0 * 3600_000.0;
/// A ticket's reply goes back to Telegram only this long after the message that asked.
pub const REPORT_MS: f64 = 24.0 * 3600_000.0;
/// Longest report back.
pub const REPORT_PARTS: usize = 3;

const ANSWER_KINDS: [&str; 1] = ["questions"];
const BOARD_KINDS: [&str; 3] = ["limit", "proposal", "huddle"];

/// `IncomingReply`.
#[derive(Clone, Debug)]
pub struct Incoming {
    pub chat_id: i64,
    pub update_id: i64,
    pub tg: i64,
    pub reply_to: i64,
    pub text: String,
}

impl Incoming {
    pub fn to_json(&self) -> Value {
        json!({ "chatId": self.chat_id, "updateId": self.update_id, "tg": self.tg, "replyTo": self.reply_to, "text": self.text })
    }
    pub fn of(v: &Value) -> Incoming {
        let n = |k: &str| v.get(k).and_then(Value::as_f64).map(|x| x as i64).unwrap_or(0);
        Incoming { chat_id: n("chatId"), update_id: n("updateId"), tg: n("tg"), reply_to: n("replyTo"), text: s(v, "text").to_string() }
    }
}

/// What a reply to one ticket may do now.
enum Check {
    Stop(String, Option<String>),
    Go(&'static str, Option<String>),
    Stale(Option<String>),
}

fn kind_of(r: &Rec) -> &str {
    r.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn named(title: &str, board: &str) -> String {
    format!("\"{title}\" ({board})")
}

fn target_of(v: &Value) -> LinkItem {
    LinkItem::of(v)
}

/// A target `{board, ticketId, key, linkAt}` with another key.
fn with_key(t: &Value, key: Option<&str>) -> Value {
    let mut t = t.clone();
    t["key"] = key.map(Value::from).unwrap_or(Value::Null);
    t
}

impl Telegram {
    fn wait(&self, key: &str) -> Option<Rec> {
        self.helper.core.lock().waits.get(key).cloned()
    }

    fn open_waits(&self, board: &str, id: &str) -> Vec<Rec> {
        self.helper.core.lock().waits.open_for(board, Some(id))
    }

    /// The update was sent already (`sentAlready`).
    pub fn sent_already(&self, board: &str, id: &str, update_id: i64) -> bool {
        let Some(t) = self.ticket(board, id) else { return false };
        let u = json!(update_id);
        t.get("telegramIn").and_then(Value::as_array).is_some_and(|a| a.iter().any(|m| m.get("updateId") == Some(&u)))
            || t.get("queued").and_then(Value::as_array).is_some_and(|a| a.iter().any(|m| m.get("telegram").and_then(|g| g.get("updateId")) == Some(&u)))
    }

    /// A card with an action's buttons went out (noted), or didn't (the action goes).
    pub fn card(&self, id: &str, tg: Option<i64>) {
        match tg {
            Some(tg) => self.pending.shown(id, tg, self.now()),
            None => self.pending.remove(id, self.now()),
        }
    }

    /// `onReply`: a reply to one of the board's messages. False: the fixed answer.
    pub async fn on_reply(&self, r: &Incoming, out: &Out) -> bool {
        if self.forms_on_reply(r, out).await {
            return true;
        }
        let Some(link) = self.links.get(r.chat_id, r.reply_to, &self.bot_id()) else { return false };
        let link_at = link.get("at").cloned().unwrap_or(Value::Null);
        let mut seen = std::collections::HashSet::new();
        let items: Vec<Value> = link_items(&link)
            .into_iter()
            .filter(|i| seen.insert(format!("{}/{}", i.board, i.ticket_id)))
            .map(|i| {
                let mut v = i.to_json();
                v["linkAt"] = link_at.clone();
                v
            })
            .collect();
        if items.is_empty() {
            return false;
        }
        if items.iter().any(|i| self.sent_already(s(i, "board"), s(i, "ticketId"), r.update_id)) {
            return true;
        }
        let (u, c) = (r.update_id, r.chat_id);
        let shown = self.pending.find(self.now(), &|a: &Action| {
            let rr = action_data(a).get("r");
            rr.and_then(|x| x.get("updateId")).and_then(Value::as_f64) == Some(u as f64) && rr.and_then(|x| x.get("chatId")).and_then(Value::as_f64) == Some(c as f64)
        });
        if let Some(a) = &shown {
            if action_card(a).is_some() {
                return true;
            }
            self.pending.remove(action_id(a), self.now());
        }
        if items.len() > 1 {
            if self.desk_ready() {
                return false;
            }
            self.pick(r, &items, out).await;
            return true;
        }
        self.route(r, &items[0], out).await;
        true
    }

    /// A summary about several tickets: one button per ticket.
    async fn pick(&self, r: &Incoming, items: &[Value], out: &Out) {
        let live: Vec<Value> = items.iter().filter(|i| self.ticket(s(i, "board"), s(i, "ticketId")).is_some()).take(8).cloned().collect();
        if live.is_empty() {
            out.say("Those tickets are gone, so I didn't send this.", Say::reply(r.tg)).await;
            return;
        }
        let Ok(a) = self.pending.create("pick", json!({ "r": r.to_json(), "items": live }), ACTION_TTL_MS, self.now()) else { return };
        let id = action_id(&a).to_string();
        let mut rows: Rows = live
            .iter()
            .enumerate()
            .map(|(n, i)| {
                let t = self.ticket(s(i, "board"), s(i, "ticketId")).map(|t| t.title.clone()).unwrap_or_default();
                vec![Button::data(&short(&format!("{t} ({})", self.board_name(s(i, "board"))), 60), format!("p:{id}:{n}"))]
            })
            .collect();
        rows.push(vec![Button::data("Cancel", format!("p:{id}:x"))]);
        let tg = out.say("That message was about several tickets. Which one is this for?", Say::reply(r.tg).buttons(rows)).await;
        self.card(&id, tg);
    }

    /// `check`.
    fn check(&self, t: &Value, r: &Incoming) -> Check {
        let (board, id) = (s(t, "board"), s(t, "ticketId"));
        let has_board = self.helper.core.board.has_profile(board);
        let ticket = self.ticket(board, id);
        let Some(ticket) = ticket.filter(|_| has_board) else {
            return Check::Stop("That ticket was deleted or moved to another board, so I didn't send this.".into(), None);
        };
        let board_name = self.board_name(board);
        if ticket.status == "done" {
            return Check::Stop(format!("{} is done, so I didn't send this. Open it on the board to pick it up again.", named(&ticket.title, &board_name)), None);
        }
        let link_at = t.get("linkAt").and_then(Value::as_str).and_then(parse_date).unwrap_or(f64::NAN);
        if self.now() - link_at > STALE_REPLY_MS {
            return Check::Stop("That message is more than a day old, so I didn't send this. Answer on the board, or reply to a newer alert.".into(), None);
        }
        if r.text.starts_with('/') {
            return Check::Stop("Commands only work on the board, so I didn't send this.".into(), None);
        }
        let url = self.ticket_url(board, id);
        let key = t.get("key").and_then(Value::as_str).filter(|k| !k.is_empty());
        let mut rec = key.and_then(|k| self.wait(k));
        if rec.as_ref().is_some_and(|w| BOARD_KINDS.contains(&kind_of(w))) {
            return Check::Stop(NEEDS_BOARD.into(), url);
        }
        let closed = |w: &Rec| js::truthy(w.get("closedAt"));
        let why = |w: &Rec| w.get("closedWhy").and_then(Value::as_str).unwrap_or("").to_string();
        if rec.as_ref().is_some_and(|w| closed(w) && !ANSWER_KINDS.contains(&kind_of(w)) && why(w) != "deleted") {
            rec = None;
        } else if let Some(k) = key
            && rec.as_ref().is_none_or(closed)
        {
            if rec.as_ref().is_some_and(|w| why(w) == "deleted") {
                return Check::Stop("That ticket was deleted, so I didn't send this.".into(), None);
            }
            let said = ticket
                .get("telegramIn")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().rev().find(|m| m.get("key").and_then(Value::as_str) == Some(k)))
                .and_then(|m| m.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string);
            return Check::Stale(said);
        }
        let open = self.open_waits(board, id);
        if rec.is_none() {
            rec = open.iter().find(|w| ANSWER_KINDS.contains(&kind_of(w))).or_else(|| open.iter().find(|w| BOARD_KINDS.contains(&kind_of(w)))).cloned();
        }
        if rec.as_ref().is_some_and(|w| BOARD_KINDS.contains(&kind_of(w))) {
            return Check::Stop(NEEDS_BOARD.into(), url);
        }
        let rkey = rec.as_ref().and_then(|w| w.get("key")).and_then(Value::as_str).map(str::to_string);
        if rec.as_ref().is_some_and(|w| ANSWER_KINDS.contains(&kind_of(w))) {
            let outcome = ticket.s("outcome").unwrap_or("");
            if outcome == "failed" || outcome == "blocked" || js::truthy(ticket.get("stalled")) {
                return Check::Go("steer", rkey);
            }
            return Check::Go("answer", rkey);
        }
        Check::Go("steer", rkey)
    }

    /// Why a steer needs a Confirm.
    fn state_line(&self, t: &Value) -> &'static str {
        let (board, id) = (s(t, "board"), s(t, "ticketId"));
        let Some(ticket) = self.ticket(board, id) else { return "This isn't an answer to its question: it starts the ticket working." };
        let kind = match t.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) {
            Some(k) => self.wait(k).map(|w| kind_of(&w).to_string()),
            None => self.open_waits(board, id).first().map(|w| kind_of(w).to_string()),
        }
        .unwrap_or_default();
        let outcome = ticket.s("outcome").unwrap_or("");
        if self.running(board, id) {
            return "It is working now: this changes what it does.";
        }
        if kind == "failed" || outcome == "failed" {
            return "Its run failed: this starts it again.";
        }
        if kind == "blocked" || outcome == "blocked" {
            return "It is blocked: this starts it again.";
        }
        if kind == "stalled" {
            return "It looks stuck: this goes to it as a new message.";
        }
        if ticket.status == "review" {
            return "It is in Review: this starts it working again.";
        }
        "This isn't an answer to its question: it starts the ticket working."
    }

    /// One ticket: stop, echo (answer), Confirm (steer) or "already answered" with Send anyway.
    fn route<'a>(&'a self, r: &'a Incoming, t: &'a Value, out: &'a Out) -> futures_util::future::BoxFuture<'a, ()> {
        Box::pin(async move {
            match self.check(t, r) {
                Check::Stop(text, url) => {
                    let mut o = Say::reply(r.tg);
                    if let Some(u) = url {
                        o.buttons = vec![vec![Button::url("Open", &u)]];
                    }
                    out.say(&text, o).await;
                }
                Check::Stale(said) => {
                    let (board, id) = (s(t, "board"), s(t, "ticketId"));
                    let title = self.ticket(board, id).map(|x| x.title.clone()).unwrap_or_default();
                    let Ok(a) = self.pending.create("anyway", json!({ "r": r.to_json(), "t": with_key(t, None), "mode": "steer" }), ACTION_TTL_MS, self.now()) else { return };
                    let aid = action_id(&a).to_string();
                    let said = said.map(|x| format!(" You answered: \"{}\"", short(&x, 300))).unwrap_or_default();
                    let text = format!("{}: that question was already answered.{said}\n\nI didn't send this.", named(&title, &self.board_name(board)));
                    let rows = vec![vec![Button::data("Send anyway", format!("p:{aid}:y")), Button::data("Cancel", format!("p:{aid}:x"))]];
                    let tg = out.say(&text, Say::reply(r.tg).buttons(rows)).await;
                    self.card(&aid, tg);
                }
                Check::Go(mode, key) => {
                    let target = with_key(t, key.as_deref());
                    let ask_typed = self.tg_settings().get("askTyped").and_then(Value::as_bool).unwrap_or(false);
                    if mode == "answer" && !ask_typed {
                        self.deliver(r, &target, out, None).await;
                        return;
                    }
                    self.ask(r, &target, mode, out, None).await;
                }
            }
        })
    }

    /// The echo (answer) or Confirm (steer) card; `edit`: change that card instead of sending a new one.
    async fn ask(&self, r: &Incoming, t: &Value, mode: &str, out: &Out, edit: Option<i64>) {
        let (board, id) = (s(t, "board"), s(t, "ticketId"));
        let title = self.ticket(board, id).map(|x| x.title.clone()).unwrap_or_default();
        let bname = self.board_name(board);
        let Ok(a) = self.pending.create("send", json!({ "r": r.to_json(), "t": t, "mode": mode }), ACTION_TTL_MS, self.now()) else { return };
        let aid = action_id(&a).to_string();
        let text = if mode == "answer" {
            format!("Send this to {}?\n\n\"{}\"", named(&title, &bname), short(&r.text, 3000))
        } else {
            let first = r.text.split('\n').find(|l| !js::trim(l).is_empty()).unwrap_or(&r.text);
            format!("Confirm: send this to {}?\n{}\n\n\"{}\"", named(&title, &bname), self.state_line(t), short(first, 300))
        };
        let rows = vec![vec![Button::data(if mode == "answer" { "Send" } else { "Confirm" }, format!("p:{aid}:y")), Button::data("Cancel", format!("p:{aid}:x"))]];
        match edit {
            Some(e) => {
                out.edit(e, &text, Some(rows)).await;
                self.card(&aid, Some(e));
            }
            None => {
                let tg = out.say(&text, Say::reply(r.tg).buttons(rows)).await;
                self.card(&aid, tg);
            }
        }
    }

    /// Into the ticket's chat. `edit`: the card to change into the outcome. The tap's short answer.
    async fn deliver(&self, r: &Incoming, t: &Value, out: &Out, edit: Option<i64>) -> String {
        let tell = |text: String| async move {
            match edit {
                Some(e) => out.edit(e, &text, None).await,
                None => {
                    out.say(&text, Say::reply(r.tg)).await;
                }
            }
        };
        if !self.taking() {
            tell(NOT_TAKING.into()).await;
            return "Not sent".into();
        }
        let (board, id) = (s(t, "board"), s(t, "ticketId"));
        let title = self.ticket(board, id).map(|x| x.title.clone()).unwrap_or_default();
        if !self.forms_flush_before(board, id, r.update_id, r.tg).await {
            tell(format!("Couldn't send your form answers to \"{title}\" first, so I didn't send this either. Answer on the board.")).await;
            return "Not sent".into();
        }
        // Checked again right before it is queued: a /lock, Pause or Unpair meanwhile refuses it.
        if !self.taking() {
            tell(NOT_TAKING.into()).await;
            return "Not sent".into();
        }
        let from = json!({ "updateId": r.update_id, "tg": r.tg, "chatId": r.chat_id, "key": t.get("key").cloned().unwrap_or(Value::Null) });
        match self.env.chat_from_telegram(board, id, &r.text, from).await {
            Ok(true) => {}
            Ok(false) => {
                tell(format!("Already sent to \"{title}\".")).await;
                return "Already sent".into();
            }
            Err(e) => {
                tell(format!("Couldn't send this to \"{title}\": {e}")).await;
                return "Not sent".into();
            }
        }
        self.forms_closed_by_text(board, id).await;
        tell(format!("✓ Sent to \"{title}\". I'll reply here when it has news.")).await;
        "Sent".into()
    }

    /// A tap on a router, form or front desk button (`p:<id>:<choice>`): the short answer for answerCallbackQuery.
    pub async fn on_tap(&self, id: &str, choice: &str, chat_id: i64, message_id: i64, out: &Out, update_id: Option<i64>) -> String {
        let now = self.now();
        let kind = self.pending.peek(id, now).map(|(a, _)| action_kind(&a).to_string());
        if kind.as_deref() == Some("form") {
            return self.forms_on_tap(id, choice, chat_id, message_id, out, update_id).await;
        }
        if kind.as_deref() == Some("fd") {
            return if self.desk_ready() { self.desk_on_tap(id, choice, chat_id, message_id, out, update_id).await } else { "That button no longer works.".into() };
        }
        let a = match self.pending.take(id, update_id, now) {
            Take::Gone(g) => {
                if g == "expired" && message_id != 0 {
                    out.edit(message_id, "This expired. Reply to the alert again to send it.", None).await;
                }
                return if g == "expired" { "This button expired.".into() } else { "This button was already used.".into() };
            }
            Take::Action(a, _) => a,
        };
        let d = action_data(&a).clone();
        let r = Incoming::of(d.get("r").unwrap_or(&Value::Null));
        if d.get("r").and_then(|x| x.get("chatId")).and_then(Value::as_f64) != Some(chat_id as f64) {
            return "That button no longer works.".into();
        }
        if choice == "x" {
            out.edit(message_id, "Cancelled. Nothing was sent.", None).await;
            return "Cancelled".into();
        }
        if action_kind(&a) == "pick" {
            let items = d.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            let Some(t) = choice.parse::<usize>().ok().filter(|_| choice.bytes().all(|b| b.is_ascii_digit())).and_then(|n| items.get(n)) else {
                return "That button no longer works.".into();
            };
            let ticket = self.ticket(s(t, "board"), s(t, "ticketId"));
            let text = match &ticket {
                Some(x) => format!("For \"{}\" ({}).", x.title, self.board_name(s(t, "board"))),
                None => "That ticket is gone.".into(),
            };
            out.edit(message_id, &text, None).await;
            if ticket.is_some() {
                self.route(&r, t, out).await;
            }
            return if ticket.is_some() { "OK".into() } else { "Gone".into() };
        }
        if choice != "y" {
            return "That button no longer works.".into();
        }
        let t = d.get("t").cloned().unwrap_or(Value::Null);
        let mode = s(&d, "mode").to_string();
        let target = target_of(&t);
        if self.sent_already(&target.board, &target.ticket_id, r.update_id) {
            let title = self.ticket(&target.board, &target.ticket_id).map(|x| x.title.clone()).unwrap_or_else(|| "the ticket".into());
            out.edit(message_id, &format!("✓ Sent to \"{title}\". I'll reply here when it has news."), None).await;
            return "Already sent".into();
        }
        let c = self.check(&if mode == "steer" { with_key(&t, None) } else { t.clone() }, &r);
        if let Check::Stop(text, _) = &c {
            out.edit(message_id, text, None).await;
            return "Not sent".into();
        }
        if action_kind(&a) == "anyway" {
            let key = match &c {
                Check::Go(_, k) => k.clone(),
                _ => None,
            };
            self.ask(&r, &with_key(&t, key.as_deref()), "steer", out, Some(message_id)).await;
            return "Confirm to send".into();
        }
        let still_answer = matches!(&c, Check::Go("answer", k) if k.as_deref() == t.get("key").and_then(Value::as_str));
        if mode == "answer" && !still_answer {
            out.edit(message_id, "That question was answered or changed meanwhile, so I didn't send this. Reply to the newest alert.", None).await;
            return "Not sent".into();
        }
        self.deliver(&r, &t, out, Some(message_id)).await
    }

    /// `turnEnded`: a Telegram message that waits for the ticket's reply gets it (split at line breaks).
    pub async fn turn_ended(&self, board: &str, id: &str, text: &str) {
        let Some(t) = self.ticket(board, id) else { return };
        let Some(rep) = t.get("telegramReport").filter(|r| r.is_object()).cloned() else { return };
        let clear = || self.env.patch_telegram(board, id, json!({ "telegramReport": null }));
        let at = rep.get("at").and_then(Value::as_str).and_then(parse_date).unwrap_or(f64::NAN);
        if self.now() - at > REPORT_MS {
            clear();
            return;
        }
        let board_name = self.board_name(board);
        let head = format!("{} ({board_name}):", t.title);
        let link = self.ticket_url(board, id);
        let parts = report_parts(&head, text, REPORT_PARTS, TELEGRAM_MAX, link.as_deref());
        if parts.is_empty() {
            clear();
            return;
        }
        let chat = rep.get("chatId").and_then(Value::as_f64).map(|c| c as i64);
        let Some(o) = chat.and_then(|c| self.out(c, false)) else {
            clear();
            return;
        };
        // Cleared first: a second turn end meanwhile doesn't send it again.
        clear();
        let reply_to = rep.get("tg").and_then(Value::as_f64).map(|x| x as i64);
        let mut sent = 0;
        for p in &parts {
            let say = Say { reply_to, link: vec![LinkItem::new(board, id, None)], ..Default::default() };
            if o.say(p, say).await.is_some() {
                sent += 1;
            }
        }
        if sent == 0 {
            return;
        }
        let after = self.ticket(board, id);
        let joined = parts.join("\n");
        let body = js::trim(joined.get(head.len()..).unwrap_or("")).to_string();
        let mut list = after.and_then(|a| a.get("telegramOut").and_then(Value::as_array).cloned()).unwrap_or_default();
        list.push(json!({ "at": iso(self.now()), "text": js::head16(&body, 300), "replyTo": rep.get("tg").cloned().unwrap_or(Value::Null) }));
        let keep = list.len().saturating_sub(30);
        self.env.patch_telegram(board, id, json!({ "telegramOut": list[keep..].to_vec() }));
    }
}
