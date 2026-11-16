//! What the prompt builders read: the fields of Bun's types they use (`Ticket`, `Comment`, `Huddle`, the run roles...),
//! read from the same JSON names. Missing and null fields read as their default, like `undefined` in Bun.

use serde::Deserialize;
use serde_json::Value;

/// A ticket's fields the prompts use (`Ticket` in `src/core/types.ts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ticket {
    pub id: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub mode: Option<String>,
    pub interviewed: Option<bool>,
    pub branch: Option<String>,
    pub run_count: f64,
    pub source: Option<TicketSource>,
    pub tags: Option<Vec<String>>,
    pub reopened_from: Option<ReopenedFrom>,
    pub main: Option<bool>,
    pub tool: Option<bool>,
    pub important: Option<bool>,
    pub follow_up: Option<FollowUp>,
    pub follow_up_log: Option<Vec<FollowUpLogEntry>>,
    pub seen_at: Option<String>,
    pub automation_setup: Option<bool>,
    pub checkin_setup: Option<bool>,
}

impl Ticket {
    pub fn is_interview(&self) -> bool {
        self.mode.as_deref() == Some("interview")
    }
    pub fn has_tags(&self) -> bool {
        self.tags.as_ref().is_some_and(|t| !t.is_empty())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TicketSource {
    pub provider: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ReopenedFrom {
    pub status: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FollowUp {
    pub note: String,
    pub set_at: String,
    pub due_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FollowUpLogEntry {
    pub at: String,
    pub kind: String,
    pub cost_usd: Option<f64>,
}

/// A ticket comment; `from` set: a note another ticket's run left.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Comment {
    pub author: String,
    pub text: String,
    pub at: String,
    pub from: Option<String>,
}

impl Comment {
    pub fn is_note(&self) -> bool {
        self.from.as_deref().is_some_and(|f| !f.is_empty())
    }
}

/// Where a repo without a remote collects finished work.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Home {
    pub folder: String,
    pub base_branch: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietContext {
    pub last_check_at: Option<String>,
    pub open: Vec<QuietOpen>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietOpen {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ScheduleRef {
    pub id: String,
    pub name: Option<String>,
    pub board: String,
    pub quiet: Option<QuietContext>,
}

/// `PromptContext` of `prompts-rules.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptContext {
    pub repo: String,
    pub in_place: Option<bool>,
    pub home: Option<Home>,
    pub linked: Option<bool>,
    pub comments: Option<Vec<Comment>>,
    pub output_dir: String,
    pub schedule: Option<ScheduleRef>,
    pub auto_huddles: Option<bool>,
    pub artifacts: Option<bool>,
    pub recall: Option<String>,
    pub main: Option<MainRole>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct IdTitle {
    pub id: String,
    pub title: String,
}

/// `MainRole` of `prompts-main.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MainRole {
    pub repo: String,
    pub branch: Option<String>,
    pub in_place: bool,
    pub paused: Option<bool>,
    pub planned: Option<String>,
    pub sub_feature_of: Option<IdTitle>,
    /// The board's Task models setting as stored (each kind's `{model, effort}`); checked like Bun's `validPick`.
    pub task_models: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DepReport {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
}

/// `ToolRole` of `prompts-main.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolRole {
    pub repo: String,
    pub parent: IdTitle,
    pub main: IdTitle,
    pub goal: String,
    pub status_path: Option<String>,
    pub dep_reports: Vec<DepReport>,
    pub main_branch: Option<String>,
    pub output_dir: String,
    pub with_you: Option<bool>,
}

impl ToolRole {
    pub fn with_you(&self) -> bool {
        self.with_you.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunRole {
    Main(MainRole),
    Tool(ToolRole),
}

/// `FreshContext` of `prompts-chat.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FreshContext {
    pub repo: String,
    pub in_place: Option<bool>,
    pub home: Option<Home>,
    pub linked: bool,
    pub base_branch: String,
    pub last_result: Option<String>,
    pub comments: Vec<Comment>,
    pub output_dir: String,
    pub auto_huddles: Option<bool>,
    pub artifacts: Option<bool>,
    pub recall: Option<String>,
}

/// Where a Planning chat's follow-up work goes (`web/src/features/ticket/followUp.ts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "as", rename_all = "lowercase")]
pub enum FollowUpPlace {
    Step { main: IdTitle },
    Main,
    Ticket {},
}

/// The feature part of a fresh chat note (a main ticket).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FreshFeature {
    pub status: Option<String>,
    pub table: String,
    pub auto: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Question {
    pub question: String,
    pub context: Option<String>,
    pub options: Vec<QuestionOption>,
    pub multi_select: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    pub recommended: Option<bool>,
    pub mockup: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChromeDevice {
    pub device_id: String,
    pub name: String,
    pub note: Option<String>,
}

/// `ChromeChoice` of `src/browser/chromes.ts` (null is `None`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ChromeChoice {
    #[serde(rename_all = "camelCase")]
    Device { device_id: String, name: String, #[serde(default)] note: Option<String> },
    Devices { list: Vec<ChromeDevice> },
    Ask { named: Vec<ChromeDevice> },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct BoardBrowserChoice {
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    pub server: String,
    pub available: bool,
    pub why: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Device {
    pub name: String,
    pub description: Option<String>,
    pub capacity: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Brief {
    pub text: String,
    pub by: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AutoReason {
    pub reason: String,
}

/// A huddle's fields the prompts use (`Huddle` in `src/core/types.ts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Huddle {
    pub id: String,
    pub participants: Vec<HuddleParticipant>,
    pub host: Option<String>,
    pub brief: Option<Brief>,
    pub template: Option<String>,
    pub topic: Option<String>,
    pub host_rules: Option<String>,
    pub auto: Option<AutoReason>,
}

impl Huddle {
    pub fn host(&self) -> Option<&str> {
        self.host.as_deref().filter(|h| !h.is_empty())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub branch: Option<String>,
    pub sha: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HelperCopy {
    pub kind: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HuddleParticipant {
    pub handle: String,
    pub role: String,
    pub prompt: String,
    pub focus: Option<String>,
    pub mode: String,
    pub lead: bool,
    pub can_edit: bool,
    pub branch: Option<String>,
    pub snapshot: Option<Snapshot>,
    pub copy: Option<HelperCopy>,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HuddleMessage {
    pub seq: f64,
    pub from: String,
    pub text: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoHuddle {
    pub reason: String,
    pub trigger: Option<String>,
    pub template: String,
    pub max_cost_usd: Option<f64>,
    pub topic: Option<String>,
}
