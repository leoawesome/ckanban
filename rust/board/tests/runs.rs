//! The run engine against Bun's answers (`tests/fixtures/runs.json`, written by
//! `test/rust-board-runs-fixtures.test.ts`): every case's output, as JSON text, must equal Bun's byte for byte.

use std::ffi::CString;
use std::path::Path;

use ckanban_board::runs::{activity, activity_digest, claude, connectors, js, live_cut, model_versions, result, retry, runner, side_call};
use serde_json::{Value, json};

fn doc() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/runs.json")).expect("fixture file");
    serde_json::from_str(&text).expect("fixture JSON")
}

fn opt_str(v: Option<String>) -> Value {
    v.map(Value::String).unwrap_or(Value::Null)
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn set_mtime(p: &Path, secs: i64) {
    let c = CString::new(p.as_os_str().as_encoded_bytes()).expect("path");
    let t = libc::timeval { tv_sec: secs, tv_usec: 0 };
    assert_eq!(unsafe { libc::utimes(c.as_ptr(), [t, t].as_ptr()) }, 0, "utimes {}", p.display());
}

/// Writes a fixture's files under `dir` (a path ending in "/" is a folder).
fn lay(dir: &Path, files: &[(String, String, Option<i64>)]) {
    for (path, text, mtime) in files {
        let p = dir.join(path);
        if path.ends_with('/') {
            std::fs::create_dir_all(&p).unwrap();
        } else {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, text).unwrap();
        }
        if let Some(m) = mtime {
            set_mtime(&p, *m);
        }
    }
}

fn file_list(c: &Value, sub: &dyn Fn(&str) -> String) -> Vec<(String, String, Option<i64>)> {
    c["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let mut path = sub(f["path"].as_str().unwrap());
            if let Some(p) = f.get("project").and_then(Value::as_str) {
                path = format!("{path}{}/", claude::encode_project_dir(&sub(p)));
            }
            (path, sub(f.get("text").and_then(Value::as_str).unwrap_or("")), f.get("mtime").and_then(Value::as_i64))
        })
        .collect()
}

fn mask(s: &str) -> String {
    s.replace("SECRET-KEY-123", "***")
}

fn connectors_of(v: &Value) -> connectors::Connectors {
    match v {
        Value::String(s) if s == "all" => connectors::Connectors::All,
        Value::String(s) if s == "none" => connectors::Connectors::None,
        _ => connectors::Connectors::Keep(strs(v)),
    }
}

fn run_case(group: &str, c: &Value) -> Value {
    match group {
        "parseResult" => result::parse_result(c["text"].as_str().unwrap()).map(|r| r.to_json()).unwrap_or(Value::Null),
        "transientError" => {
            let events = c["events"].as_array().unwrap();
            let stderr = c["stderr"].as_str().unwrap();
            json!({ "transient": opt_str(retry::transient_error(events, stderr)), "limit": opt_str(retry::limit_message(events, stderr)) })
        }
        "textChecks" => {
            let t = c["text"].as_str().unwrap();
            json!({ "transient": retry::is_transient_text(t), "limit": retry::is_limit_text(t) })
        }
        "describeTool" => Value::String(activity::describe_tool(c["name"].as_str().unwrap(), &c["input"])),
        "summarizeEvent" => json!({
            "plain": opt_str(activity::summarize_event(&c["event"], false)),
            "raw": opt_str(activity::summarize_event(&c["event"], true)),
        }),
        "extractFinalText" => Value::String(activity::extract_final_text(c["events"].as_array().unwrap())),
        "liveJson" => Value::String(live_cut::live_json(&js::parse(&c["value"].to_string()).unwrap(), &mask, c["max"].as_u64().unwrap() as usize)),
        "runDisallowed" => json!(connectors::run_disallowed(&strs(&c["own"]), c["ultracode"].as_bool().unwrap())),
        "connectorSetting" => {
            let v = c.get("value");
            json!({
                "setting": connectors::connector_setting(v).to_json(),
                "parsed": v.and_then(connectors::parse_connector_setting).map(|s| s.to_json()).unwrap_or(Value::Null),
            })
        }
        "connectorToolPrefix" => Value::String(connectors::connector_tool_prefix(c["name"].as_str().unwrap())),
        "connectorRunOptions" => {
            let known = c["known"].as_array().map(|_| strs(&c["known"]));
            let o = connectors::connector_run_options(&connectors_of(&c["setting"]), known.as_deref());
            json!({ "disallowed": o.disallowed, "env": o.env })
        }
        "familyVersion" => match c["id"].as_str().and_then(model_versions::family_version) {
            Some((f, v)) => json!([f, v]),
            None => Value::Null,
        },
        "newerVersion" => Value::Bool(model_versions::newer_version(c["a"].as_str().unwrap(), c["b"].as_str().unwrap())),
        "learnModel" => {
            let dir = tempfile::tempdir().unwrap();
            let f = dir.path().join("model-versions.json");
            if let Some(s) = c.get("saved").and_then(Value::as_str) {
                std::fs::write(&f, s).unwrap();
            }
            let mv = model_versions::ModelVersions::new(Some(f.clone()));
            for ev in c["events"].as_array().unwrap() {
                mv.learn(ev);
            }
            json!({ "learned": Value::Object(mv.learned()), "file": opt_str(std::fs::read_to_string(&f).ok()) })
        }
        "buildArgs" => {
            let s = |k: &str| c.get(k).and_then(Value::as_str).map(str::to_string);
            let more = c.get("more").cloned().unwrap_or(Value::Null);
            let o = runner::BuildArgs {
                session_id: s("sessionId").unwrap(),
                resume: c["resume"].as_bool().unwrap(),
                model: s("model"),
                disallowed: strs(c.get("disallowed").unwrap_or(&Value::Null)),
                mcp: s("mcp"),
                system_prompt: s("systemPrompt"),
                max_budget_usd: c.get("maxBudgetUsd").and_then(Value::as_f64),
                effort: s("effort"),
                ultracode: c.get("ultracode").and_then(Value::as_bool).unwrap_or(false),
                settings: more.get("settings").and_then(Value::as_object).cloned(),
                tools: more.get("tools").map(strs),
                strict_mcp: more.get("strictMcp").and_then(Value::as_bool).unwrap_or(false),
                no_chrome: more.get("noChrome").and_then(Value::as_bool).unwrap_or(false),
            };
            json!(runner::build_args(&o))
        }
        "controlResponse" => runner::control_response(&c["event"], c["planning"].as_bool().unwrap()),
        "sideCallArgs" => {
            let i = &c["input"];
            let input = side_call::SideCallInput {
                prompt: i["prompt"].as_str().unwrap().into(),
                system: i["system"].as_str().unwrap().into(),
                model: i.get("model").and_then(Value::as_str).map(str::to_string),
                tools: strs(i.get("tools").unwrap_or(&Value::Null)),
                json_schema: i.get("jsonSchema").cloned(),
                ..Default::default()
            };
            json!(side_call::side_call_args(&input))
        }
        "parseSideResult" => side_call::parse_side_result(
            c["out"].as_str().unwrap(),
            c["code"].as_i64().unwrap() as i32,
            c["err"].as_str().unwrap(),
            c["model"].as_str().unwrap(),
        )
        .to_json(),
        "encodeProjectDir" => Value::String(claude::encode_project_dir(c["path"].as_str().unwrap())),
        "isClaudeCommand" => Value::Bool(claude::is_claude_command(c["cmd"].as_str().unwrap())),
        "liveSessionMatch" => Value::Bool(claude::live_session_match(&strs(&c["commands"]), c["id"].as_str().unwrap(), c["title"].as_str())),
        "listSessions" => {
            let config = tempfile::tempdir().unwrap();
            let project = c["project"].as_str().unwrap();
            lay(&config.path().join("projects").join(claude::encode_project_dir(project)), &file_list(c, &|s| s.to_string()));
            let d = claude::Dirs { config_dir: Some(config.path().to_path_buf()), ..Default::default() };
            json!(claude::list_sessions(project, &d, c["limit"].as_u64().unwrap() as usize).iter().map(|s| s.to_json()).collect::<Vec<_>>())
        }
        "listClaudeProjects" => {
            let home = tempfile::tempdir().unwrap();
            let h = home.path().to_string_lossy().into_owned();
            let sub = |s: &str| s.replace("$HOME", &h);
            lay(home.path(), &file_list(c, &sub));
            let d = claude::Dirs {
                home_dir: Some(home.path().to_path_buf()),
                config_dir: Some(home.path().join(".claude")),
                exclude_prefixes: Some(strs(&c["exclude"]).iter().map(|s| sub(s)).collect()),
                data_dir: Some(sub(c["dataDir"].as_str().unwrap()).into()),
            };
            let out = json!(claude::list_claude_projects(&d).iter().map(|p| p.to_json()).collect::<Vec<_>>());
            serde_json::from_str(&js::stringify(&out).replace(&h, "$HOME")).unwrap()
        }
        "claudeDefaults" => {
            let config = tempfile::tempdir().unwrap();
            if let Some(s) = c.get("settings").and_then(Value::as_str) {
                std::fs::write(config.path().join("settings.json"), s).unwrap();
            }
            let (model, effort) = claude::claude_defaults(&claude::Dirs { config_dir: Some(config.path().to_path_buf()), ..Default::default() });
            json!({ "model": model, "effort": effort })
        }
        "activityDigest" => {
            let dir = tempfile::tempdir().unwrap();
            let f = dir.path().join("activity.jsonl");
            std::fs::write(&f, c["log"].as_str().unwrap()).unwrap();
            activity_digest::ActivityDigests::default().get_now(&f).to_json()
        }
        "readSideSpend" => {
            let dir = tempfile::tempdir().unwrap();
            let f = dir.path().join("side-spend.jsonl");
            std::fs::write(&f, c["ledger"].as_str().unwrap()).unwrap();
            side_call::read_side_spend(&f).to_json()
        }
        other => panic!("no Rust case runner for {other}"),
    }
}

#[test]
fn run_engine_gives_buns_answers() {
    let d = doc();
    let mut failures = Vec::new();
    let mut count = 0;
    for (group, cases) in d["groups"].as_object().unwrap() {
        for (i, c) in cases.as_array().unwrap().iter().enumerate() {
            count += 1;
            let got = js::stringify(&run_case(group, c));
            let want = c["expect"].as_str().unwrap();
            if got != want {
                failures.push(format!("{group}[{i}]\n  input: {}\n  bun:   {want}\n  rust:  {got}", js::stringify(c)));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {count} cases differ:\n{}", failures.len(), failures.join("\n"));
    assert!(count > 200, "only {count} cases");
}
