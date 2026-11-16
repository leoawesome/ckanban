//! Parity with Bun for subagents, workflows, tool details and chat search: every case in
//! `tests/fixtures/sessions/agents.json` (filled by `test/rust-board-agents-fixtures.test.ts`) must give exactly the
//! recorded `expect`, keys in the same order. Cases with `files` build a temp folder; "$TMP" stands for it.

use ckanban_board::sessions::search::{self, ChatMatch, ChatSource, ReadLine};
use ckanban_board::sessions::{Obj, subagents, tooldetail, workflows};
use ckanban_core::jsnum::num;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

const MTIME: f64 = 1794736800.0;

fn map_strings(v: &Value, f: &dyn Fn(&str) -> String) -> Value {
    match v {
        Value::String(s) => Value::String(f(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| map_strings(x, f)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), map_strings(x, f))).collect()),
        other => other.clone(),
    }
}

fn write(dir: &Path, rel: &str, content: &str, mtime: f64) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, content).unwrap();
    set_mtime(&p, mtime);
}

fn set_mtime(p: &Path, secs: f64) {
    let whole = secs.floor();
    let nanos = ((secs - whole) * 1e9).round() as u32;
    let t = UNIX_EPOCH + Duration::new(whole as u64, nanos);
    fs::File::options().write(true).open(p).unwrap().set_times(fs::FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

fn num_arg(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => other.parse().unwrap_or(f64::NAN),
        }),
        Some(v) => v.as_f64(),
    }
}

fn source(v: &Value) -> ChatSource {
    ChatSource {
        session_id: v["sessionId"].as_str().unwrap().to_string(),
        entries: Arc::new(v["entries"].as_array().cloned().unwrap_or_default()),
        tool_output: v.get("toolOutput").and_then(Value::as_object).map(|m| {
            m.iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string())).collect()
        }),
    }
}

fn sorted(m: HashMap<String, impl Into<Value> + Clone>) -> Value {
    let mut keys: Vec<_> = m.keys().cloned().collect();
    keys.sort();
    Value::Object(keys.into_iter().map(|k| (k.clone(), m[&k].clone().into())).collect())
}

fn answer(f: &str, i: &Value, tmp: Option<&Path>) -> Value {
    match f {
        "toolLabel" => json!(subagents::tool_label(&i["block"])),
        "parseAgentTranscript" => subagents::parse_agent_transcript(i["raw"].as_str().unwrap()),
        "parseTaskNotification" => match subagents::parse_task_notification(i["text"].as_str().unwrap()) {
            Some((id, status, result)) => json!({ "toolUseId": id, "status": status, "result": result }),
            None => Value::Null,
        },
        "notifiedStatus" => json!(subagents::notified_status(i["status"].as_str().unwrap())),
        "withTranscript" => {
            let t = i.get("t").filter(|t| !t.is_null());
            Value::Object(subagents::with_transcript(&obj(&i["a"]), t))
        }
        "settleAgent" => Value::Object(subagents::settle_agent(&obj(&i["a"]), i["runActive"].as_bool().unwrap(), i["now"].as_f64().unwrap())),
        "parseWorkflowMeta" => workflows::workflow_meta_json(i["script"].as_str().unwrap()),
        "workflowFromCall" => {
            Value::Object(workflows::workflow_from_call(i["toolUseId"].as_str().unwrap(), &i["input"], i["at"].as_str().unwrap()))
        }
        "workflowLaunched" => {
            let mut w = obj(&i["w"]);
            workflows::workflow_launched(&mut w, &i["block"], &i["meta"], i["at"].as_str().unwrap());
            Value::Object(w)
        }
        "workflowNotified" => {
            let mut w = obj(&i["w"]);
            workflows::workflow_notified(&mut w, i["status"].as_str().unwrap(), opt_str(&i["result"]), i["at"].as_str().unwrap());
            Value::Object(w)
        }
        "transcriptDirOf" => json!(workflows::transcript_dir_of(i["text"].as_str().unwrap())),
        "transcriptCost" => num(workflows::transcript_cost(i["raw"].as_str().unwrap())),
        "parseJournal" => Value::Array(workflows::parse_journal(i["raw"].as_str().unwrap())),
        "progressStatus" => json!(workflows::progress_status(i.get("state"))),
        "withRun" => {
            let run = i.get("run").filter(|r| !r.is_null());
            let progress = i.get("progress").and_then(Value::as_array).map(Vec::as_slice);
            Value::Object(workflows::with_run(&obj(&i["w"]), run, progress))
        }
        "workflowAgentDetail" => {
            let run = i.get("run").filter(|r| !r.is_null());
            workflows::workflow_agent_detail(&obj(&i["w"]), run, i["agentId"].as_str().unwrap()).unwrap_or(Value::Null)
        }
        "settleWorkflow" => {
            Value::Object(workflows::settle_workflow(&obj(&i["w"]), i["runActive"].as_bool().unwrap(), i["now"].as_f64().unwrap()))
        }
        "workflowScript" => {
            let run = i.get("run").filter(|r| !r.is_null());
            json!(workflows::workflow_script(&obj(&i["w"]), run))
        }
        "findToolDetail" => tooldetail::find_tool_detail(i["raw"].as_str().unwrap(), i["id"].as_str().unwrap()).unwrap_or(Value::Null),
        "findToolDetailIn" => {
            let paths: Vec<PathBuf> = i["paths"].as_array().unwrap().iter().map(|p| PathBuf::from(p.as_str().unwrap())).collect();
            tooldetail::find_tool_detail_in(&paths, i["id"].as_str().unwrap()).unwrap_or(Value::Null)
        }
        "whoWrote" => json!(search::who_wrote(&i["e"])),
        "queryWords" => json!(search::query_words(i["query"].as_str().unwrap())),
        "searchChat" => {
            let sources: Vec<ChatSource> = i["sources"].as_array().unwrap().iter().map(source).collect();
            let limit = i.get("limit").and_then(Value::as_u64).map(|l| l as usize);
            match search::search_chat(&sources, i["query"].as_str().unwrap(), i["includeTools"].as_bool().unwrap_or(false), limit) {
                Ok((matches, total)) => json!({ "matches": matches, "total": total }),
                Err(e) => json!({ "error": e }),
            }
        }
        "parseRef" => match search::parse_ref(i["ref"].as_str().unwrap()) {
            Some((id, index)) => json!({ "sessionId": id, "index": num(index) }),
            None => Value::Null,
        },
        "readChat" => {
            let src = source(&i["src"]);
            match search::read_chat(&src, i["index"].as_f64().unwrap(), num_arg(i.get("before")), num_arg(i.get("after"))) {
                Ok((lines, capped)) => json!({ "lines": lines, "capped": capped }),
                Err(e) => json!({ "error": e }),
            }
        }
        "toolOutputs" => sorted(search::tool_outputs(i["raw"].as_str().unwrap())),
        "matchesText" => {
            let r = &i["r"];
            let matches: Vec<ChatMatch> = r["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| ChatMatch {
                    r#ref: m["ref"].as_str().unwrap().into(),
                    at: m["at"].as_str().unwrap().into(),
                    who: m["who"].as_str().unwrap().into(),
                    snippet: m["snippet"].as_str().unwrap().into(),
                })
                .collect();
            let r = (matches, r["total"].as_u64().unwrap() as usize);
            json!(search::matches_text(i["ticketId"].as_str().unwrap(), i["query"].as_str().unwrap(), &r, i["includeTools"].as_bool().unwrap()))
        }
        "readText" => {
            let r = &i["r"];
            let lines: Vec<ReadLine> = r["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| ReadLine {
                    r#ref: m["ref"].as_str().unwrap().into(),
                    at: m["at"].as_str().unwrap().into(),
                    who: m["who"].as_str().unwrap().into(),
                    text: m["text"].as_str().unwrap().into(),
                })
                .collect();
            json!(search::read_text(i["ticketId"].as_str().unwrap(), &(lines, r["capped"].as_bool().unwrap())))
        }
        "subagentFiles" => {
            let files = subagents::subagent_files(Path::new(i["session"].as_str().unwrap()));
            json!(files.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>())
        }
        "workflowDirCost" => num(workflows::workflow_dir_cost(Path::new(i["dir"].as_str().unwrap()), &mut HashMap::new())),
        "SubagentCache" | "WorkflowCache" => {
            let dir = tmp.unwrap();
            let session = Path::new(i["session"].as_str().unwrap());
            let sub = subagents::SubagentCache::new();
            let wf = workflows::WorkflowCache::new();
            let mut out = vec![];
            for s in i["steps"].as_array().unwrap() {
                out.push(match s["op"].as_str().unwrap() {
                    "version" if f == "SubagentCache" => json!(sub.version(session)),
                    "version" => json!(wf.version(session)),
                    "write" => {
                        write(dir, s["path"].as_str().unwrap(), s["content"].as_str().unwrap(), s.get("mtime").and_then(Value::as_f64).unwrap_or(MTIME));
                        Value::Null
                    }
                    "rm" => {
                        fs::remove_file(dir.join(s["path"].as_str().unwrap())).unwrap();
                        Value::Null
                    }
                    _ if f == "SubagentCache" => sorted(sub.load(session)),
                    _ => {
                        let mut r = wf.load(session, s["runId"].as_str().unwrap()).unwrap();
                        let agents: Vec<Value> = r["agents"].as_object().unwrap().iter().map(|(k, v)| json!([k, v])).collect();
                        r["agents"] = Value::Array(agents);
                        r
                    }
                });
            }
            Value::Array(out)
        }
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn rust_gives_buns_answers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sessions/agents.json");
    let doc: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 70);
    let mut failed = vec![];
    for (n, c) in cases.iter().enumerate() {
        let f = c["fn"].as_str().unwrap();
        let mut input = c["input"].clone();
        let mut tmp_dir = None;
        if let Some(files) = input.get("files").and_then(Value::as_object) {
            let t = tempfile::tempdir().unwrap();
            let root = t.path().to_string_lossy().into_owned();
            for (rel, content) in files {
                write(t.path(), rel, content.as_str().unwrap(), MTIME);
            }
            if let Some(m) = input.get("mtimes").and_then(Value::as_object) {
                for (rel, secs) in m {
                    set_mtime(&t.path().join(rel), secs.as_f64().unwrap());
                }
            }
            input = map_strings(&input, &|s| s.replace("$TMP", &root));
            tmp_dir = Some(t);
        }
        let mut got = answer(f, &input, tmp_dir.as_ref().map(|t| t.path()));
        if let Some(t) = &tmp_dir {
            let root = t.path().to_string_lossy().into_owned();
            got = map_strings(&got, &|s| s.replace(&root, "$TMP"));
        }
        let (g, e) = (serde_json::to_string(&got).unwrap(), serde_json::to_string(&c["expect"]).unwrap());
        if g != e {
            failed.push(format!("case {n} ({f}):\n  rust: {}\n  bun:  {}", &g[..g.len().min(3000)], &e[..e.len().min(3000)]));
        }
    }
    assert!(failed.is_empty(), "{} of {} cases differ:\n{}", failed.len(), cases.len(), failed.join("\n"));
}
