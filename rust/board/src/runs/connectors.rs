//! What every board run leaves out of Claude's context (`src/runs/connectors.ts`): built-in tools board runs never
//! use, and the claude.ai connectors its board turned off.

use std::collections::BTreeMap;

use parking_lot::RwLock;
use serde_json::Value;

use super::js;

/// Claude Code tools board runs never use. Workflow stays for ultracode runs (see `run_disallowed`).
pub const UNUSED_TOOLS: [&str; 7] = ["Workflow", "ScheduleWakeup", "AskUserQuestion", "ShareOnboardingGuide", "CronCreate", "CronDelete", "CronList"];

/// A run's --disallowedTools: its own list plus the unused tools, without repeats. Ultracode keeps Workflow.
pub fn run_disallowed(own: &[String], ultracode: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let unused = UNUSED_TOOLS.iter().filter(|t| !(ultracode && **t == "Workflow")).map(|t| t.to_string());
    for t in own.iter().cloned().chain(unused) {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// "all" (the default), "none", or the connector names to keep ("Slack", without the "claude.ai " prefix).
#[derive(Debug, Clone, PartialEq)]
pub enum Connectors {
    All,
    None,
    Keep(Vec<String>),
}

impl Connectors {
    pub fn to_json(&self) -> Value {
        match self {
            Connectors::All => Value::String("all".into()),
            Connectors::None => Value::String("none".into()),
            Connectors::Keep(v) => Value::Array(v.iter().cloned().map(Value::String).collect()),
        }
    }
}

pub const CLAUDE_AI_PREFIX: &str = "claude.ai ";

/// "claude.ai Slack" and "Slack" both become "Slack".
pub fn short_connector_name(name: &str) -> String {
    js::trim(name.strip_prefix(CLAUDE_AI_PREFIX).unwrap_or(name)).to_string()
}

fn keep_list(v: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in v.iter().filter_map(Value::as_str).map(short_connector_name) {
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// `connectorSetting`: the board's `claudeAiConnectors`; anything missing or unknown counts as "all".
pub fn connector_setting(v: Option<&Value>) -> Connectors {
    match v {
        Some(Value::String(s)) if s == "none" => Connectors::None,
        Some(Value::Array(a)) => Connectors::Keep(keep_list(a)),
        _ => Connectors::All,
    }
}

/// `parseConnectorSetting`: checks a PATCH value; None when it isn't one of the three forms.
pub fn parse_connector_setting(v: &Value) -> Option<Connectors> {
    match v {
        Value::String(s) if s == "all" => Some(Connectors::All),
        Value::String(s) if s == "none" => Some(Connectors::None),
        Value::Array(a) if a.iter().all(Value::is_string) => Some(connector_setting(Some(v))),
        _ => None,
    }
}

/// The tool name prefix Claude Code gives a connector's tools: "claude.ai Claude Docs" → "mcp__claude_ai_Claude_Docs".
pub fn connector_tool_prefix(name: &str) -> String {
    let full = if name.starts_with(CLAUDE_AI_PREFIX) { name.to_string() } else { format!("{CLAUDE_AI_PREFIX}{name}") };
    // JS replaces each UTF-16 unit: a character outside the BMP becomes two underscores.
    let mut out = String::from("mcp__");
    for c in full.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push_str(&"_".repeat(c.len_utf16()));
        }
    }
    out
}

/// Environment that turns every claude.ai connector off for one run.
pub const NO_CONNECTORS_ENV: (&str, &str) = ("ENABLE_CLAUDEAI_MCP_SERVERS", "false");

/// What a run adds for its board's setting: more --disallowedTools entries and environment.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConnectorRunOptions {
    pub disallowed: Vec<String>,
    pub env: BTreeMap<String, String>,
}

fn no_connectors() -> ConnectorRunOptions {
    ConnectorRunOptions { disallowed: Vec::new(), env: BTreeMap::from([(NO_CONNECTORS_ENV.0.to_string(), NO_CONNECTORS_ENV.1.to_string())]) }
}

/// `connectorRunOptions`. known: the account's claude.ai connector names as last listed (None: not listed yet). A
/// keep-list hides every other known connector; without a list to hide from, or with nothing to keep, the run gets
/// none, so the cheap setting never turns into "all".
pub fn connector_run_options(setting: &Connectors, known: Option<&[String]>) -> ConnectorRunOptions {
    let keep = match setting {
        Connectors::All => return ConnectorRunOptions::default(),
        Connectors::None => return no_connectors(),
        Connectors::Keep(k) => k,
    };
    let known = match known {
        Some(k) if !k.is_empty() && !keep.is_empty() => k,
        _ => return no_connectors(),
    };
    let keep: Vec<String> = keep.iter().map(|n| short_connector_name(n)).collect();
    let mut known_short: Vec<String> = Vec::new();
    for n in known.iter().map(|n| short_connector_name(n)) {
        if !known_short.contains(&n) {
            known_short.push(n);
        }
    }
    if !known_short.iter().any(|n| keep.contains(n)) {
        return no_connectors();
    }
    ConnectorRunOptions {
        disallowed: known_short.iter().filter(|n| !keep.contains(n)).map(|n| connector_tool_prefix(n)).collect(),
        env: BTreeMap::new(),
    }
}

/// The account's claude.ai connectors, as the Connections list last saw them.
static KNOWN: RwLock<Option<Vec<String>>> = RwLock::new(None);

pub fn known_connectors() -> Option<Vec<String>> {
    KNOWN.read().clone()
}

/// `setKnownConnectors`: short names, without repeats, sorted like JS's `sort()`.
pub fn set_known_connectors(names: Option<&[String]>) {
    *KNOWN.write() = names.map(|n| {
        let mut v: Vec<String> = Vec::new();
        for s in n.iter().map(|x| short_connector_name(x)) {
            if !v.contains(&s) {
                v.push(s);
            }
        }
        v.sort_by(|a, b| js::cmp16(a, b));
        v
    });
}

/// `boardConnectorOptions`: for a run of a board whose profile has this `claudeAiConnectors` value.
pub fn board_connector_options(setting: Option<&Value>) -> ConnectorRunOptions {
    connector_run_options(&connector_setting(setting), known_connectors().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_list_hides_the_others() {
        let known = vec!["claude.ai Slack".to_string(), "Gmail".to_string()];
        let o = connector_run_options(&Connectors::Keep(vec!["Slack".into()]), Some(&known));
        assert_eq!(o.disallowed, vec!["mcp__claude_ai_Gmail"]);
        assert!(o.env.is_empty());
        assert_eq!(connector_run_options(&Connectors::Keep(vec!["X".into()]), Some(&known)), no_connectors());
        assert_eq!(connector_tool_prefix("Claude Docs"), "mcp__claude_ai_Claude_Docs");
    }
}
