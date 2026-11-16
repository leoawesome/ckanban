//! R11b parity: every case of the team fixture table (`tests/fixtures/team.json`, written by Bun's
//! `test/rust-team-fixtures.test.ts`) gives Bun's answer in Rust: the same JSON, or the same error text. One
//! exception: a JSON syntax error in "Save as squad…"'s answer is worded by each side's parser, so only the start of
//! that message is compared.

use ckanban_board::team::jsv::Obj;
use ckanban_board::team::layers::{self, Level};
use ckanban_board::team::notes::{self, RoleNotes, Scope};
use ckanban_board::team::{plan_review, presets, proposal, roster, squad, templates};
use ckanban_core::datafile::{Layout, to_text};
use serde_json::{Value, json};

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}
fn objs(v: &Value) -> Vec<Obj> {
    v.as_array().map(|a| a.iter().map(obj).collect()).unwrap_or_default()
}
fn names(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}
fn arg(args: &[Value], i: usize) -> Option<&Value> {
    args.get(i).filter(|v| !v.is_null())
}
fn of_objs(list: Vec<Obj>) -> Value {
    Value::Array(list.into_iter().map(Value::Object).collect())
}
fn role_notes(v: &Value) -> RoleNotes {
    let ns = |k: &str| -> Vec<notes::Note> {
        v[k].as_array()
            .map(|a| {
                a.iter()
                    .map(|n| notes::Note {
                        text: n["text"].as_str().unwrap_or("").into(),
                        by: n["by"].as_str().unwrap_or("").into(),
                        date: n["date"].as_str().map(String::from),
                        huddle: n["huddle"].as_str().map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    RoleNotes { general: ns("general"), repo: ns("repo") }
}
fn level(v: &Value) -> Level {
    Level::of(Some(v)).expect("a level")
}
fn text(r: Result<String, String>) -> Result<Value, String> {
    r.map(Value::from)
}
fn list_reset(r: Result<(Vec<Obj>, bool), String>) -> Result<Value, String> {
    r.map(|(l, reset)| json!({ "list": of_objs(l), "reset": reset }))
}

/// One case in Rust: Ok(JSON) or Err(message).
fn run(f: &str, a: &[Value]) -> Result<Value, String> {
    let a0 = arg(a, 0);
    match f {
        "presetName" => Ok(Value::from(presets::preset_name(a[0].as_str().unwrap()))),
        "presetFromInput" => presets::preset_from_input(a0, arg(a, 1).map(obj).as_ref()).map(Value::Object),
        "savePreset" => {
            let lower = arg(a, 2).map(objs).unwrap_or_else(|| presets::builtins().to_vec());
            presets::save_preset(&objs(&a[0]), arg(a, 1), &lower).map(|(l, p)| json!({ "list": of_objs(l), "preset": p }))
        }
        "deletePreset" => list_reset(presets::delete_preset(&objs(&a[0]), a[1].as_str().unwrap(), presets::builtins())),
        "cleanPresets" => Ok(of_objs(presets::clean_presets(a0))),
        "mergePresets" => Ok(of_objs(presets::merge_presets(&objs(&a[0]), &arg(a, 1).map(objs).unwrap_or_default()))),
        "presetLine" => Ok(Value::from(presets::preset_line(&obj(&a[0])))),
        "templateFromInput" => templates::template_from_input(a0, arg(a, 1).map(obj).as_ref(), arg(a, 2).map(names).as_deref()).map(Value::Object),
        "saveTemplate" => templates::save_template(&objs(&a[0]), arg(a, 1), arg(a, 2).map(names).as_deref(), templates::builtins())
            .map(|(l, t)| json!({ "list": of_objs(l), "template": t })),
        "deleteTemplate" => list_reset(templates::delete_template(&objs(&a[0]), a[1].as_str().unwrap(), templates::builtins())),
        "cleanTemplates" => Ok(of_objs(templates::clean_templates(a0))),
        "mergeTemplates" => Ok(of_objs(templates::merge_templates(&objs(&a[0]), &arg(a, 1).map(objs).unwrap_or_default()))),
        "templateBrief" => Ok(Value::from(templates::template_brief(&obj(&a[0]), a[1].as_f64().unwrap(), arg(a, 2).and_then(Value::as_str)))),
        "topicInput" => templates::topic_input(a0).map(|t| t.map(Value::from).unwrap_or(Value::Null)),
        "customReviewBrief" => Ok(Value::from(templates::custom_review_brief(a[0].as_f64().unwrap()))),
        "templateLine" => Ok(Value::from(templates::template_line(&obj(&a[0])))),
        "lowerLevels" => Ok(of_objs(layers::lower_levels(&objs(&a[0]), &objs(&a[1]), level(&a[2])))),
        "mergeLayers" => Ok(of_objs(layers::merge_layers(&objs(&a[0]), &objs(&a[1]), &objs(&a[2])))),
        "rosterError" => {
            let max = arg(a, 1).and_then(Value::as_u64).map_or(roster::DEFAULT_MAX_PARTICIPANTS, |m| m as usize);
            Ok(roster::roster_error(a0, max, arg(a, 2).map(names).as_deref()).map(Value::from).unwrap_or(Value::Null))
        }
        "handleBase" => Ok(Value::from(roster::handle_base(a[0].as_str().unwrap()))),
        "noteRole" => Ok(notes::note_role(a0).map(Value::from).unwrap_or(Value::Null)),
        "noteText" => Ok(Value::from(notes::note_text(a[0].as_str().unwrap()))),
        "parseNotes" => Ok(serde_json::to_value(notes::parse_notes(a[0].as_str().unwrap())).unwrap()),
        "serializeNotes" => {
            let ns = role_notes(&json!({ "general": a[2] })).general;
            Ok(Value::from(notes::serialize_notes(a[0].as_str().unwrap(), Scope::of(a[1].as_str().unwrap()).unwrap(), &ns)))
        }
        "cleanNotes" => notes::clean_notes(a0).map(|n| serde_json::to_value(n).unwrap()),
        "lessonsSection" => {
            let role = arg(a, 1).map(role_notes);
            Ok(Value::from(notes::lessons_section(&role_notes(&a[0]), role.as_ref(), arg(a, 2).and_then(Value::as_str))))
        }
        "cleanLessons" => notes::clean_lessons(a0).map(|l| serde_json::to_value(l).unwrap()),
        "teammateProposal" => proposal::teammate_proposal(a0).map(Value::Object),
        "parseTeammateProposal" => Ok(proposal::parse_teammate_proposal(a0).map(Value::Object).unwrap_or(Value::Null)),
        "proposalPreset" => Ok(Value::Object(proposal::proposal_preset(&obj(&a[0])))),
        "teammateNameFor" => Ok(Value::from(squad::teammate_name_for(&obj(&a[0])))),
        "squadProposal" => squad::squad_proposal(a0, arg(a, 1).map(names).as_deref()).map(Value::Object),
        "parseSquadProposal" => Ok(squad::parse_squad_proposal(a0).map(Value::Object).unwrap_or(Value::Null)),
        "withNewTeammates" => Ok(Value::Object(squad::with_new_teammates(&obj(&a[0]), a[1].as_str().unwrap()))),
        "squadSavePlan" => squad::squad_save_plan(a0, &names(&a[1]), arg(a, 2).map(names).as_deref())
            .map(|p| json!({ "squad": p.squad, "create": of_objs(p.create), "reused": p.reused })),
        "squadSetup" => Ok(Value::Object(squad::squad_setup(&a[0], &objs(&a[1]), arg(a, 2).map(obj).as_ref()))),
        "chatTail" => {
            let max = arg(a, 1).and_then(Value::as_u64).map_or(squad::GENERIC_SQUAD_SOURCE_MAX, |m| m as usize);
            Ok(Value::from(squad::chat_tail(a[0].as_array().unwrap(), max)))
        }
        "genericSquadPrompt" => {
            let i = &a[0];
            let setup = obj(&i["setup"]);
            let learnings = names(&i["learnings"]);
            let source = i.get("source").filter(|s| !s.is_null()).map(|s| (s["kind"].as_str().unwrap(), s["text"].as_str().unwrap()));
            text(Ok(squad::generic_squad_prompt(&squad::GenericInput { setup: &setup, brief: i["brief"].as_str(), learnings: &learnings, source })))
        }
        "parseGenericSquad" => squad::parse_generic_squad(a[0].as_str().unwrap(), arg(a, 1).map(names).as_deref()).map(Value::Object),
        "planProposal" => Ok(Value::from(plan_review::plan_proposal(&a[0], a[1].as_array().unwrap()))),
        other => panic!("no Rust function for {other}"),
    }
}

/// Bun's answer in the same shape as `run`'s (save and delete give `{ list, preset|template|reset }`).
fn bun(c: &Value) -> Result<Value, String> {
    if let Some(e) = c.get("error") {
        return Err(e.as_str().unwrap().to_string());
    }
    Ok(c["json"].clone())
}

#[test]
fn every_case_matches_bun() {
    let text = include_str!("fixtures/team.json");
    let cases: Vec<Value> = ckanban_core::datafile::parse_json(text).and_then(|v| v.as_array().cloned()).expect("fixture table");
    let mut bad = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let f = c["fn"].as_str().unwrap();
        let want = bun(c);
        let got = run(f, c["args"].as_array().unwrap());
        let same = match (&want, &got) {
            (Err(w), Err(g)) if w.starts_with("the answer wasn't valid JSON (") => g.starts_with("the answer wasn't valid JSON ("),
            // Compared as text, so key order and number spelling count too.
            (Ok(w), Ok(g)) => to_text(w, Layout::Compact) == to_text(g, Layout::Compact),
            _ => want == got,
        };
        if !same {
            bad.push(format!("case {i} {f} {}\n  bun:  {want:?}\n  rust: {got:?}", c["args"]));
        }
    }
    assert!(bad.is_empty(), "{} of {} cases differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}

#[test]
fn builtins_load() {
    assert!(presets::is_builtin("reviewer"));
    assert!(templates::is_builtin("plan-critique-debate"));
    assert!(squad::generic_squad_system().starts_with("You turn one huddle"));
}
