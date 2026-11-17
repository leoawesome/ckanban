//! The helper's pure rules and file bytes against Bun's answers (`tests/fixtures/helper.json`, written by
//! `test/rust-board-helper-fixtures.test.ts`), in the time zone the file names.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ckanban_board::helper::decide::{self, CheckContext, ItemState};
use ckanban_board::helper::messages::{self, Cursor, MessageStore, NewMessage};
use ckanban_board::helper::settings::{Night, hm, in_night, morning_digest_at, night_end};
use ckanban_board::helper::summary::{self, SummaryBuild, SummaryInput};
use ckanban_board::helper::waits::{self, Claim, NewWait, WaitStore};
use ckanban_board::helper::{notify_settings, runner, text};
use ckanban_board::runs::js;
use ckanban_core::jsnum::num;
use serde_json::{Map, Value, json};

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}
fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}
fn opt_num(x: Option<f64>) -> Value {
    x.map(num).unwrap_or(Value::Null)
}
fn opt_str(x: Option<String>) -> Value {
    x.map(Value::String).unwrap_or(Value::Null)
}
fn night(v: &Value) -> Night {
    Night { start: s(&v["start"]), end: s(&v["end"]) }
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(s).collect()).unwrap_or_default()
}
fn set(v: &Value) -> HashSet<String> {
    strs(v).into_iter().collect()
}
fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
fn msgs(v: &Value) -> Vec<Map<String, Value>> {
    v.as_array().map(|a| a.iter().map(obj).collect()).unwrap_or_default()
}
fn input(v: &Value) -> SummaryInput {
    SummaryInput {
        key: v.get("key").and_then(Value::as_str).map(str::to_string),
        board: s(&v["board"]),
        board_name: s(&v["boardName"]),
        ticket_id: s(&v["ticketId"]),
        title: s(&v["title"]),
        label: s(&v["label"]),
        since: s(&v["since"]),
    }
}
fn inputs(v: &Value) -> Vec<SummaryInput> {
    v.as_array().map(|a| a.iter().map(input).collect()).unwrap_or_default()
}
fn item_state(v: &Value) -> ItemState {
    ItemState {
        open: v["open"].as_bool().unwrap_or(false),
        snoozed: v["snoozed"].as_bool().unwrap_or(false),
        checkin: v["checkin"].as_bool().unwrap_or(false),
        told: v["told"].as_bool().unwrap_or(false),
        pending_reminders: v["pendingReminders"].as_bool().unwrap_or(false),
        stopped: v["stopped"].as_str().map(str::to_string),
        opened: v["opened"].as_bool().unwrap_or(false),
        alerted: v["alerted"].as_bool().unwrap_or(false),
    }
}
fn cursor(v: Option<&Value>) -> Option<Cursor> {
    let v = v?;
    Some(Cursor { at: s(&v["at"]), id: s(&v["id"]) })
}
fn new_wait(v: &Value) -> NewWait {
    NewWait {
        board: s(&v["board"]),
        ticket_id: s(&v["ticketId"]),
        kind: s(&v["kind"]),
        identity: s(&v["identity"]),
        question: s(&v["question"]),
        label: s(&v["label"]),
        since: s(&v["since"]),
        urgent: v["urgent"].as_bool().unwrap_or(false),
        why: v.get("why").and_then(Value::as_str).map(str::to_string),
    }
}

/// The waits.json / messages.json text after each step, message ids numbered by first sight.
fn store_script(kind: &str, steps: &[Value]) -> Value {
    let dir = std::env::temp_dir().join(format!("helper-fx-{}-{}", std::process::id(), kind));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let clock = Arc::new(AtomicU64::new(1794909600000));
    let c = clock.clone();
    let now: Arc<dyn Fn() -> f64 + Send + Sync> = Arc::new(move || c.load(Ordering::SeqCst) as f64);
    let mut w = WaitStore::new(&dir, now.clone());
    let mut m = MessageStore::new(&dir, now.clone(), None);
    let file = dir.join(format!("{kind}.json"));
    let mut ids: Vec<String> = Vec::new();
    let re = regex::Regex::new("m_[a-z0-9]+").unwrap();
    let mut out = Vec::new();
    for st in steps {
        clock.fetch_add(st.get("advance").and_then(Value::as_u64).unwrap_or(0), Ordering::SeqCst);
        let real = |id: &str, ids: &Vec<String>| id.strip_prefix("m_").and_then(|n| n.parse::<usize>().ok()).and_then(|n| ids.get(n - 1).cloned()).unwrap_or(id.to_string());
        let o = st.get("o").cloned().unwrap_or(json!({}));
        match s(&st["op"]).as_str() {
            "add" => {
                w.add(&new_wait(&st["w"]), o["seeded"].as_bool().unwrap_or(false), o["told"].as_str());
            }
            "update" => {
                let patch: Vec<(String, Value)> = obj(&st["patch"]).into_iter().collect();
                w.update(&s(&st["key"]), patch.iter().map(|(k, v)| (k.as_str(), v.clone())).collect());
            }
            "markTold" => w.mark_told(&strs(&st["keys"]), &s(&st["via"]), st["messageId"].as_str()),
            "unclaim" => {
                let prev: Vec<Claim> = st["prev"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| Claim { key: s(&p["key"]), told_at: p["toldAt"].clone(), told_via: p["toldVia"].clone(), fallback_at: p["fallbackAt"].clone(), digest_at: p["digestAt"].clone() })
                    .collect();
                w.unclaim(&prev);
            }
            "stop" => {
                w.stop_reminders(&s(&st["key"]), &s(&st["why"]));
            }
            "close" => {
                w.close(&strs(&st["keys"]), &s(&st["why"]));
            }
            "opened" => {
                w.opened(&s(&st["board"]), &s(&st["ticketId"]));
            }
            "rekey" => {
                w.rekey(&s(&st["from"]), &new_wait(&st["w"]));
            }
            "notifyUser" => w.set_notify_user(&s(&st["board"]), &s(&st["ticketId"]), now()),
            "first" => w.set_first_summary_pending(st["v"].as_bool().unwrap_or(false)),
            "madd" => {
                let x = &st["m"];
                let mut n = NewMessage::new(&s(&x["level"]), s(&x["oneLine"]), s(&x["text"]));
                n.why = x["why"].as_str().map(str::to_string);
                n.items = x["items"].as_array().cloned().unwrap_or_default();
                n.held = x["held"].as_bool().unwrap_or(false);
                n.summary = x.get("summary").cloned();
                n.practice = x["practice"].as_bool().unwrap_or(false);
                n.night_ask = x["nightAsk"].as_bool().unwrap_or(false);
                n.held_overnight = x["heldOvernight"].as_str().map(str::to_string);
                m.add(n);
            }
            "msends" => {
                m.record_sends(&real(&s(&st["id"]), &ids), st["sends"].as_array().cloned().unwrap_or_default());
            }
            "mtap" => {
                m.mark_tapped(&real(&s(&st["id"]), &ids), &s(&st["how"]));
            }
            "mread" => {
                m.mark_read(&real(&s(&st["id"]), &ids));
            }
            "mreadall" => {
                m.mark_all_read();
            }
            other => panic!("unknown op {other}"),
        }
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        for cap in re.find_iter(&text) {
            if !ids.contains(&cap.as_str().to_string()) {
                ids.push(cap.as_str().to_string());
            }
        }
        let named = re.replace_all(&text, |c: &regex::Captures| format!("m_{}", ids.iter().position(|x| x == &c[0]).unwrap() + 1)).into_owned();
        out.push(Value::String(named));
    }
    let _ = std::fs::remove_dir_all(&dir);
    Value::Array(out)
}

fn answer(fun: &str, a: &[Value]) -> Value {
    match fun {
        "system" => json!({ "sha": ckanban_board::chat::sha256::hex(decide::HELPER_SYSTEM.as_bytes()), "schema": decide::DECISION_SCHEMA_TEXT }),
        "cut" => text::cut(&s(&a[0]), a[1].as_u64().unwrap() as usize).into(),
        "clockTime" => text::clock_time(&s(&a[0])).into(),
        "directLabel" => text::direct_label(&s(&a[0]["kind"]), &s(&a[0]["question"]), &s(&a[0]["label"])).into(),
        "usageLimitLine" => text::usage_limit_line(a[0].as_u64().unwrap() as usize, a[1].as_str()).into(),
        "summaryLine" => text::summary_line(a[0].as_u64().unwrap() as usize, &s(&a[1])).into(),
        "reminderCount" => {
            let skipped: Vec<bool> = a[0].as_array().unwrap().iter().map(|x| js::truthy(x.get("skipped"))).collect();
            let (n, of) = text::reminder_count(&skipped, a[1].as_u64().unwrap() as usize);
            json!({ "n": n, "of": of })
        }
        "reminderBody" => text::reminder_body(&s(&a[0])).into(),
        "stepChain" => json!(text::step_chain(&s(&a[0]), &strs(&a[1]), &strs(&a[2]))),
        "keptQuietLine" => text::kept_quiet_line(a[0].as_u64().unwrap() as usize, &s(&a[1])).into(),
        "meetingTime" => opt_num(text::meeting_time(&s(&a[0]), &s(&a[1]))),
        "backoffMs" => num(runner::backoff_ms(f(&a[0]))),
        "lookBeforeDigest" => num(runner::look_before_digest(f(&a[0]), &night(&a[1]))),
        "hm" => hm(&s(&a[0])).map(Value::from).unwrap_or(Value::Null),
        "inNight" => in_night(f(&a[0]), &night(&a[1])).into(),
        "nightEnd" => num(night_end(f(&a[0]), &night(&a[1]))),
        "morningDigestAt" => num(morning_digest_at(f(&a[0]), &night(&a[1]))),
        "lastNightEnd" => opt_num(decide::last_night_end(f(&a[0]), &night(&a[1]))),
        "summaryAllowedAt" => opt_num(decide::summary_allowed_at(a[0].as_f64(), f(&a[1]), &night(&a[2]))),
        "channelFor" => opt_str(decide::channel_for(&s(&a[0]), &strs(&a[1]), &strs(&a[2]))),
        "urgentRefusal" => opt_str(decide::urgent_refusal(&item_state(&a[0]))),
        "parseDecision" => match decide::parse_decision(&s(&a[0])) {
            Ok(raw) => json!({ "ok": true, "raw": raw }),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        "checkDecision" => {
            let c = &a[1];
            let items: HashMap<String, ItemState> = c["items"].as_array().unwrap().iter().map(|p| (s(&p[0]), item_state(&p[1]))).collect();
            let (channels, on, n, feedback) = (strs(&c["channels"]), strs(&c["on"]), night(&c["night"]), strs(&c["feedback"]));
            let ctx = CheckContext { now: f(&c["now"]), items: &items, channels: &channels, on: &on, night: &n, night_opt_in: c["nightOptIn"].as_bool(), feedback: &feedback };
            match decide::check_decision(&a[0], &ctx) {
                Err(e) => json!({ "ok": false, "error": e }),
                Ok(d) => {
                    let sends: Vec<Value> = d
                        .sends
                        .iter()
                        .map(|x| {
                            let mut m = Map::new();
                            m.insert("level".into(), x.level.clone().into());
                            m.insert("oneLine".into(), x.one_line.clone().into());
                            m.insert("why".into(), x.why.clone().into());
                            m.insert("keys".into(), json!(x.keys));
                            m.insert("steps".into(), Value::Array(x.steps.iter().map(|st| json!({ "channel": st.channel, "afterMin": num(st.after_min) })).collect()));
                            if !x.followed.is_empty() {
                                m.insert("followed".into(), json!(x.followed));
                            }
                            Value::Object(m)
                        })
                        .collect();
                    json!({ "ok": true, "decision": { "sends": sends, "nextWakeAt": num(d.next_wake_at), "notes": d.notes, "log": d.log, "fixes": d.fixes } })
                }
            }
        }
        "titleStem" => opt_str(summary::title_stem(&s(&a[0]))),
        "collapseRuns" => Value::Array(summary::collapse_runs(&inputs(&a[0])).into_iter().map(Value::Object).collect()),
        "shortDate" => summary::short_date(&s(&a[0])).into(),
        "buildSummary" => {
            let b = &a[0];
            let (text, view) = summary::build_summary(&SummaryBuild {
                headline: s(&b["headline"]),
                fresh: inputs(&b["fresh"]),
                still: inputs(&b["still"]),
                checkins: inputs(&b["checkins"]),
                older_checkins: b["olderCheckins"].as_u64().unwrap() as usize,
                notes: strs(&b["notes"]),
                boards: b["boards"].as_bool().unwrap(),
                now: f(&b["now"]),
            });
            json!({ "text": text, "view": view })
        }
        "weekStart" => num(summary::week_start(f(&a[0]))),
        "weekRecapLine" => {
            let days: HashMap<String, f64> = obj(&a[1]).into_iter().map(|(k, v)| (k, f(&v))).collect();
            opt_str(summary::week_recap_line(a[0].as_array().unwrap(), &days, f(&a[2])))
        }
        "rowLines" => {
            let (title, sub) = messages::row_lines(&obj(&a[0]));
            json!({ "title": title, "sub": sub })
        }
        "toRow" => messages::to_row(&obj(&a[0]), &set(&a[1])),
        "pageOf" => {
            let list = msgs(&a[0]);
            let o = &a[1];
            let (rows, more) = messages::page_of(&list, &s(&o["tab"]), o["limit"].as_u64().unwrap() as usize, cursor(o.get("before")).as_ref(), cursor(o.get("after")).as_ref(), &set(&a[2]));
            json!({ "rows": rows.into_iter().cloned().map(Value::Object).collect::<Vec<_>>(), "hasMore": more })
        }
        "nearOf" => messages::near_of(&msgs(&a[0]), &obj(&a[1]), &s(&a[2]), &set(&a[3]), a[4].as_str()),
        "needsShown" => json!(messages::needs_shown(&msgs(&a[0]), &set(&a[1]))),
        "needsYouIds" => {
            let list = msgs(&a[0]);
            let map = obj(&a[1]);
            let ids = messages::needs_you_ids(&list, &mut |k, _| map.get(k).and_then(Value::as_str).map(str::to_string));
            json!(list.iter().map(|m| waits::rs(m, "id").to_string()).filter(|id| ids.contains(id)).collect::<Vec<_>>())
        }
        "trimMessages" => json!(messages::trim_messages(msgs(&a[0]), f(&a[1])).iter().map(|m| waits::rs(m, "id").to_string()).collect::<Vec<_>>()),
        "normalizeRecords" => Value::Object(waits::normalize_records(&obj(&a[0]))),
        "questionHash" => waits::question_hash(&s(&a[0])).into(),
        "waitIdentity" => waits::wait_identity(&s(&a[0]), a[1].as_str()).into(),
        "recordForMessage" => {
            let all = msgs(&a[0]);
            waits::record_for_message(all.iter(), &s(&a[1]), &s(&a[2]["id"]), &s(&a[2]["at"])).cloned().map(Value::Object).unwrap_or(Value::Null)
        }
        "normalizeSettings" => match notify_settings::normalize_from_file(&a[0]) {
            Ok(v) => v,
            Err(e) => json!({ "threw": e }),
        },
        "storeScript" => store_script(&s(&a[0]), a[1].as_array().unwrap()),
        other => panic!("no Rust case for {other}"),
    }
}

#[test]
fn helper_matches_bun() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/helper.json")).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    // SAFETY: set before any time is read, in this test binary's only test that reads local time.
    unsafe { std::env::set_var("TZ", doc["tz"].as_str().unwrap()) };
    let mut failed = Vec::new();
    let cases = doc["cases"].as_array().unwrap();
    for (i, c) in cases.iter().enumerate() {
        let fun = c["fn"].as_str().unwrap();
        let args = c["args"].as_array().cloned().unwrap_or_default();
        // The cases were written by JSON.stringify: numbers read back as JS would.
        let args: Vec<Value> = args.into_iter().map(ckanban_core::jsnum::normalize).collect();
        let got = js::stringify(&answer(fun, &args));
        let want = c["expect"].as_str().unwrap();
        // Known gap (as in R3 and R5): a cut through an emoji keeps half of it in Bun (a lone surrogate) and drops it
        // in Rust, whose strings can't hold one.
        if want.contains("\\ud83") {
            continue;
        }
        if got != want {
            failed.push(format!("#{i} {fun}\n  args: {}\n  want: {want}\n  got:  {got}", js::stringify(&Value::Array(args))));
        }
    }
    if !failed.is_empty() {
        let n = failed.len();
        failed.truncate(15);
        panic!("{n} of {} cases differ from Bun:\n{}", cases.len(), failed.join("\n"));
    }
}
