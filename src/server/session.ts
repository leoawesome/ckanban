import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { helperLineText, suggestedLineError } from "./helper/line";
import { pauser, track, trackedInterval } from "./lag";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withoutAttachmentNote } from "./attachments";
import { commandText, localCommandOutput, TERMINAL_COMMANDS } from "./commands";
import type { Bus } from "./events";
import { SAFETY_PASS_MS, type SessionChanges } from "./changefeed";
import { proposedBudget, rosterError, type RosterEntry } from "./huddle-roster";
import { mockupName, stripMockups } from "./mockups";
import { parseResult } from "./result";
import { atomicWrite } from "./atomic";
import { ChatCacheTracker, type ChatCache } from "./chat-cache";
import { VERSION } from "./version";
import { parseTeammateProposal, type TeammateProposal } from "./teammate-proposal";
import { parseSquadProposal, type SquadProposal } from "./squad";
import { TOPIC_MAX } from "./huddle-templates";
import { parseAutomationProposal, type AutomationProposal } from "./automation-proposal";
import { parseKeysAsk, type KeysAsk } from "./ask-keys";
import { maskSaved } from "./board-keys";
import type { Store } from "./store";
import type { Ticket } from "./types";
import { normalizeTags } from "./tags";
import { AGENT_TOOL, notifiedStatus, parseTaskNotification, SubagentCache, subagentFiles, toolLabel, withTranscript, type AgentInfo } from "./subagents";
import { WORKFLOW_TOOL, WorkflowCache, withRun, workflowFromCall, workflowLaunched, workflowNotified, type WorkflowInfo, type WorkflowRun } from "./workflows";
import { findToolDetailIn, type ToolDetail } from "./tooldetail";
import { parseSetupBlock, type SetupResult } from "./worktree-setup";
import { starredTitle } from "./util";

/** One visible item of a Claude Code session, as shown in the ticket's Conversation tab. */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
  /** Mockup this option stands for (file name in outputs/mockups); the form links to its preview. */
  mockup?: string;
}

export interface Question {
  question: string;
  /** Background, folded under the question as "Details" (markdown). Older forms have none. */
  context?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** What the asking Claude said waiting costs (ask_questions urgent / why). */
export interface AskMeta {
  urgent?: boolean;
  why?: string;
  /** A main ticket's question about these tasks: the user answering in one of their chats closes it (closedForms). */
  about?: string[];
}

/** ask_questions' urgent and why, or undefined when neither is set. */
export function parseAskMeta(v: any): AskMeta | undefined {
  const urgent = v?.urgent === true;
  const why = typeof v?.why === "string" && v.why.trim() ? v.why.trim().slice(0, 300) : undefined;
  const about = Array.isArray(v?.about) ? v.about.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).slice(0, 20) : [];
  return urgent || why || about.length ? { ...(urgent ? { urgent } : {}), ...(why ? { why } : {}), ...(about.length ? { about } : {}) } : undefined;
}

export interface TicketProposal {
  title: string;
  description: string;
  /** ⭐ Important: the proposal asked for it (important: true, or a ⭐ before the title, which is left out of title). */
  important?: true;
  /** Move the ticket in its family on Apply: the ticket it is part of, or null to take it out (propose_ticket's partOf, "none"). */
  partOf?: string | null;
}

/** A ticket a planner's chat proposed creating; key/dependsOn order the plan. */
export interface NewTicketDraft extends TicketProposal {
  key?: string;
  dependsOn?: string[];
  /** Exclusive resources (e.g. emulator), see Ticket.needs. */
  needs?: string[];
  /** Tags the ticket gets when created (see Ticket.tags). */
  tags?: string[];
}

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  /** board: a prompt the board sent on the user's behalf (instructions hidden). */
  /** agent: a subagent Claude started (rendered as its own row with status and steps). */
  /** workflow: a workflow Claude started (rendered as a block with its phases and helper agents). */
  kind: "text" | "tool" | "board" | "agent" | "workflow";
  text: string;
  /** Tool rows: the tool_use id (its full input and output load from the tool endpoint). */
  toolUseId?: string;
  /** Tool rows whose result was an error. */
  error?: true;
  agent?: AgentInfo;
  workflow?: WorkflowInfo;
  /** Interview questions Claude asked (rendered as a form). */
  questions?: Question[];
  /** ask_questions' urgent and why (what waiting costs), for the helper. */
  ask?: AskMeta;
  /** Improved title/description Claude proposed (rendered with an Apply button). */
  proposal?: TicketProposal;
  /** New tickets Claude proposed splitting the work into (rendered with Create buttons). */
  newTickets?: NewTicketDraft[];
  /** Claude offered to branch this ticket (rendered with a Branch button). */
  branch?: { reason: string };
  /** Claude proposed a huddle roster (propose_huddle; rendered with a Start button). */
  huddle?: { roster: RosterEntry[]; reason: string; template?: string; maxCostUsd?: number; topic?: string };
  /** Claude asked to delete tickets (propose_delete; rendered with Cancel / Delete buttons). */
  deletion?: { ids: string[]; reason: string };
  /** Claude asked to delete a schedule (delete_schedule in a board run or chat; rendered with Keep / Delete buttons). */
  scheduleDeletion?: { id: string; reason: string };
  /**
   * Claude suggested a line for "What the helper knows about you" (propose_helper_rule in a board run or chat; rendered
   * with Add / Not now). The text is as the helper would save it (spaces folded); the Add route saves this, not the click's body.
   */
  helperRule?: { text: string; reason: string };
  /** Claude proposed a teammate (propose_teammate; rendered with Save teammate / Edit first / Dismiss). */
  teammate?: TeammateProposal;
  /** Claude proposed a squad (propose_squad; rendered with Save for this board / Save for all boards / Edit first / Dismiss). */
  squad?: SquadProposal;
  /** Claude proposed an automation (propose_automation; rendered with Connect buttons and Save automation). */
  automation?: AutomationProposal;
  /** Claude asked for keys (ask_keys; rendered as a key box with Save and "I'll do it myself"). Names only. */
  keys?: KeysAsk;
  /** Mockups Claude sent as blocks (saved to outputs/mockups; the chat links to them). */
  mockups?: string[];
  /** Claude asked the board to move the ticket (a planning-only request arrived in Review). */
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text; the chat says so). */
  unreadable?: BlockKind;
  /**
   * A message from outside the user: in = into this session. A huddle digest has ticketId null; a message another
   * ticket's Claude sent (chat_ticket) has that ticket's id and title, and text is just the message. A later item of an
   * automation's thread (fromAutomationText) has ticketId null and automation set to the automation's name.
   */
  peer?: { dir: "in" | "out"; ticketId: string | null; title?: string; automation?: string };
  /** A plain message of the user's that the chat can rewind to (not one sent mid-turn, not a huddle or peer message). */
  rewind?: true;
  /** Huddle messages delivered to this ticket's session (also a peer entry, ticketId null): the huddle's id. */
  huddleId?: string;
  /** A setup the board ran: before this prompt (older runs), or alone (text "") after `ckanban ticket setup`. Shown as a row. */
  setup?: SetupResult;
  /** A user message that ran a slash command (its name, without the slash); text is `/name args`. */
  command?: string;
  /** Output of a built-in command Claude Code ran itself (/context), not a reply from Claude. */
  commandOutput?: boolean;
  /**
   * A message the board sent by itself (status refresh, tool ticket updates): kind "board", text is what it said, and
   * this is its one-line summary. It never answers a questions form.
   */
  wake?: string;
}

export type BlockKind = "questions" | "proposal" | "tickets";

/** Marker Claude adds when a Review message only asked for planning; the board moves the card. */
export const MOVE_TO_PLANNING_RE = /<ckanban-move\s+to="planning"\s*\/?>(?:\s*<\/ckanban-move>)?/;
/** A Review/Done chat reply that only proposed tickets: the card stays in its column. */
export const STAY_RE = /<ckanban-stay\s*\/?>(?:\s*<\/ckanban-stay>)?/;

const CONTEXT_TAG = "<ckanban-context";

/** End index (exclusive) of the JSON object/array starting at `from`, or -1 when it never closes. */
function jsonEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Find a `<tag>` block and parse its JSON. The JSON's own end decides where the block stops, so a wrong or
 * missing closing tag, or a closing tag quoted inside the JSON text, doesn't break it. A ```json fence around
 * the JSON is fine. Each occurrence of the opening tag is tried in order (prose may mention the tag before the
 * real block); the first whose content parses wins. `raw` is the block's text (to remove it), `value` null when
 * no occurrence parses (then `raw` is the first one).
 */
function findBlock<T>(text: string, tag: string, parse: (v: unknown) => T | null): { raw: string; value: T | null } | null {
  const open = `<${tag}>`;
  let first: string | null = null;
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + open.length)) {
    const head = /^\s*(?:```(?:json)?\s*)?/.exec(text.slice(start + open.length))![0];
    const from = start + open.length + head.length;
    const end = text[from] === "{" || text[from] === "[" ? jsonEnd(text, from) : -1;
    if (end < 0) {
      first ??= text.slice(start);
      continue;
    }
    const tail = /^(?:\s*```)?(?:\s*<\/[\w-]+>)?/.exec(text.slice(end))![0];
    const raw = text.slice(start, end + tail.length);
    let value: T | null = null;
    try {
      value = parse(JSON.parse(text.slice(from, end)));
    } catch {}
    if (value) return { raw, value };
    first ??= raw;
  }
  return first === null ? null : { raw: first, value: null };
}

export function parseQuestions(v: any): Question[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const qs = v.map((q: any) => ({
    question: String(q?.question ?? "").trim(),
    ...(typeof q?.context === "string" && q.context.trim() ? { context: q.context.trim() } : {}),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? "").trim(),
      description: typeof o?.description === "string" && o.description ? o.description : undefined,
      recommended: !!o?.recommended,
      ...(typeof o?.mockup === "string" && mockupName(o.mockup) ? { mockup: mockupName(o.mockup)! } : {}),
    })).filter((o: QuestionOption) => o.label),
  }));
  return qs.every((q) => q.question) ? qs : null;
}

export function parseProposal(v: any): TicketProposal | null {
  const star = starredTitle(typeof v?.title === "string" ? v.title.trim() : "");
  const description = typeof v?.description === "string" ? v.description.trim() : "";
  const title = star.title.trim();
  const partOf = typeof v?.partOf === "string" && v.partOf.trim() ? (/^none$/i.test(v.partOf.trim()) ? null : v.partOf.trim()) : v?.partOf === null ? null : undefined;
  return title || description ? {
    title, description, ...(star.important || v?.important === true ? { important: true } : {}), ...(partOf !== undefined ? { partOf } : {}),
  } : null;
}

export function parseNewTickets(v: any): NewTicketDraft[] | null {
  if (!Array.isArray(v)) return null;
  const ts = v.map((x: any) => {
    const star = starredTitle(typeof x?.title === "string" ? x.title.trim() : "");
    const d: NewTicketDraft = {
      title: star.title.trim(),
      description: typeof x?.description === "string" ? x.description.trim() : "",
    };
    if (star.important || x?.important === true) d.important = true;
    const key = typeof x?.key === "string" ? x.key.trim() : "";
    if (key) d.key = key;
    const deps = Array.isArray(x?.dependsOn) ? x.dependsOn.filter((k: unknown) => typeof k === "string" && k.trim()).map((k: string) => k.trim()) : [];
    if (deps.length) d.dependsOn = deps;
    const needs = Array.isArray(x?.needs) ? x.needs.filter((k: unknown) => typeof k === "string" && k.trim()).map((k: string) => k.trim().toLowerCase()) : [];
    if (needs.length) d.needs = needs;
    const tags = normalizeTags(x?.tags);
    if (tags.length) d.tags = tags;
    return d;
  }).filter((x) => x.title);
  return ts.length ? ts : null;
}

/** Split an assistant text block into visible text + structured questions/proposal/new tickets. */
function assistantBlock(text: string): Pick<SessionEntry, "text" | "questions" | "proposal" | "newTickets" | "mockups" | "moved" | "unreadable"> {
  const { text: rest, names: mockups } = stripMockups(text);
  let out = rest;
  let moved: "planning" | undefined;
  if (MOVE_TO_PLANNING_RE.test(out)) {
    moved = "planning";
    out = out.replace(MOVE_TO_PLANNING_RE, "");
  }
  out = out.replace(STAY_RE, "");
  let unreadable: BlockKind | undefined;
  /** Parse one block and cut it from the text; an unreadable block stays visible and is flagged. */
  const take = <T>(tag: string, kind: BlockKind, parse: (v: unknown) => T | null): T | undefined => {
    const b = findBlock(out, tag, parse);
    if (!b) return undefined;
    if (!b.value) {
      unreadable ??= kind;
      return undefined;
    }
    out = out.replace(b.raw, "");
    return b.value;
  };
  const questions = take("ckanban-questions", "questions", parseQuestions);
  const proposal = take("ckanban-ticket", "proposal", parseProposal);
  const newTickets = take("ckanban-tickets", "tickets", parseNewTickets);
  return {
    text: out.trim(),
    ...(questions ? { questions } : {}),
    ...(proposal ? { proposal } : {}),
    ...(newTickets ? { newTickets } : {}),
    ...(mockups.length ? { mockups } : {}),
    ...(moved ? { moved } : {}),
    ...(unreadable ? { unreadable } : {}),
  };
}

/** The board doesn't move a blocked run to Planning; its reply (up to the next user message) mustn't claim it did. */
function dropBlockedMoves(entries: SessionEntry[]): void {
  entries.forEach((e, i) => {
    if (!e.moved) return;
    for (let j = i; j < entries.length && !(entries[j].role === "user" && !entries[j].huddleId); j++) {
      const r = entries[j].role === "assistant" && entries[j].kind === "text" ? parseResult(entries[j].text) : null;
      if (r?.status === "blocked") return void delete e.moved;
    }
  });
}

export interface SessionArtifact {
  url: string;
  label: string;
  at: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** A user-role message that didn't come from the user: a huddle digest, or an automation's item. */
  from?: "huddle" | "automation";
  /** An assistant message answering such a message (a quiet reply, not one for the user). */
  peerReply?: boolean;
}

export interface ParsedSession {
  title: string | null;
  entries: SessionEntry[];
  artifacts: SessionArtifact[];
  lastMessage: SessionMessage | null;
  /** Questions Claude asked since the user's last message (in its newest form). */
  openQuestions: number;
  /** That form's questions (empty when none waits): a board wake tells Claude to ask them again. */
  openForm: Question[];
  /** That form's urgent / why, when the asking Claude set them. */
  openAsk?: AskMeta;
  /** That form's entry uuid (Ticket.closedForms keys). */
  openFormId?: string;
  /** Latest ticket proposal since the user's last message. */
  pendingProposal: TicketProposal | null;
  /** Latest proposed new tickets since the user's last message (some may already be created). */
  pendingNewTickets: NewTicketDraft[];
  /** Teammate cards (their entry uuids) since the user's last message; Ticket.teammateCards says which were answered. */
  pendingTeammates: string[];
  /** Squad cards (entry uuids) since the user's last message; Ticket.squadCards says which were answered. */
  pendingSquads?: string[];
  /** Automation cards (entry uuids) since the user's last message; Ticket.automationCards says which were saved. */
  pendingAutomations: string[];
  /** Key boxes (entry uuids) since the user's last message; Ticket.keyCards says which were answered. */
  pendingKeys: string[];
  /**
   * Schedule delete cards (entry uuid and schedule id) anywhere in the chat; Ticket.scheduleDeleteCards says which were
   * answered, and one whose schedule is gone no longer waits.
   */
  pendingScheduleDeletes: { uuid: string; id: string }[];
  /** Helper rule cards (entry uuids) anywhere in the chat; Ticket.helperRuleCards says which were answered. */
  pendingHelperRules: string[];
  /** Conversation size and cache time at Claude's last reply (chat-cache.ts); null before any reply with usage. */
  cache: ChatCache | null;
}

/** What the board card and ticket header need; sent over SSE. */
export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: SessionArtifact[];
  updatedAt: string;
  openQuestions: number;
  /** See ParsedSession.openForm. */
  openForm?: Question[];
  /** See ParsedSession.openAsk. */
  openAsk?: AskMeta;
  /** See ParsedSession.openFormId. */
  openFormId?: string;
  pendingProposal: TicketProposal | null;
  pendingNewTickets: NewTicketDraft[];
  pendingTeammates: string[];
  /** Squad cards (entry uuids) since the user's last message; Ticket.squadCards says which were answered. */
  pendingSquads?: string[];
  pendingAutomations?: string[];
  /** See ParsedSession.pendingKeys. */
  pendingKeys?: string[];
  /** See ParsedSession.pendingScheduleDeletes. */
  pendingScheduleDeletes?: { uuid: string; id: string }[];
  /** See ParsedSession.pendingHelperRules. */
  pendingHelperRules?: string[];
  /** See ParsedSession.cache: the ticket chat's "gone cold" note. */
  cache?: ChatCache | null;
}

interface Dirs {
  configDir?: string;
}

export function projectsDir(d: Dirs = {}): string {
  return join(d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

export function findSessionFile(sessionId: string, d: Dirs = {}): string | null {
  const root = projectsDir(d);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/** Every session file under the projects folder by session id (one readdir per project folder, not a stat per id). */
export function scanSessionFiles(d: Dirs = {}): Map<string, string> {
  const root = projectsDir(d);
  const out = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (!out.has(id)) out.set(id, join(root, dir, name));
    }
  }
  return out;
}

/** scanSessionFiles with its reads off the event loop, a few folders at a time. */
export async function scanSessionFilesAsync(d: Dirs = {}, batch = 16): Promise<Map<string, string>> {
  const root = projectsDir(d);
  const out = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (let i = 0; i < dirs.length; i += batch) {
    const part = dirs.slice(i, i + batch);
    const lists = await Promise.all(part.map((dir) => readdir(join(root, dir)).catch(() => [] as string[])));
    part.forEach((dir, j) => {
      for (const name of lists[j]) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -6);
        if (!out.has(id)) out.set(id, join(root, dir, name));
      }
    });
  }
  return out;
}

const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

const HELPER_PUBLISH = /\bartifact publish\b/;
const PUBLISH_TOOL = /(?:^|__)publish_artifact$/;

/** `ckanban ticket setup`: its output ends with the setup block the chat draws a row from. */
const SETUP_HELPER = /\bticket setup\b/;

function isPublisher(block: any): boolean {
  if (block.name === "Artifact" || PUBLISH_TOOL.test(String(block.name ?? ""))) return true;
  return block.name === "Bash" && typeof block.input?.command === "string" && HELPER_PUBLISH.test(block.input.command);
}

/** A Claude Code built-in typed in a terminal session (/exit, /resume): not part of the ticket chat. */
function terminalOnly(cmd: string | null): boolean {
  return !!cmd && TERMINAL_COMMANDS.has(cmd.slice(1).split(" ")[0]);
}

/** How the board labels a message another ticket's Claude sent (http.ts chat): `Message from ticket <id> ("<title>"): text`. */
export const fromTicketText = (ticketId: string, title: string, text: string) => `Message from ticket ${ticketId} ("${title}"): ${text}`;
const FROM_TICKET = /^Message from ticket (t_[\w-]+) \("([\s\S]*?)"\): ([\s\S]*)$/;

/** The sender and message of a text fromTicketText made, or null for anything else. */
export function fromTicket(text: string): { ticketId: string; title: string; text: string } | null {
  const m = FROM_TICKET.exec(text);
  return m ? { ticketId: m[1], title: m[2], text: m[3].trim() } : null;
}

/**
 * How the board labels a later item of an automation's thread (Board.automationItem): outside content the automation
 * copied from a service, never the user's words. The name has no quotes or line breaks, so the label reads back exactly.
 */
export const fromAutomationText = (name: string, text: string) => `Message from automation ("${name.replace(/["\r\n]+/g, "'")}"): ${text}`;
const FROM_AUTOMATION = /^Message from automation \("([^"\r\n]*)"\): ([\s\S]*)$/;

/** The automation's name and the message of a text fromAutomationText made, or null for anything else. */
export function fromAutomation(text: string): { name: string; text: string } | null {
  const m = FROM_AUTOMATION.exec(text);
  return m ? { name: m[1], text: m[2].trim() } : null;
}

function userText(content: unknown): { kind: "text" | "board"; text: string; huddle?: string; setup?: SetupResult; command?: string; wake?: string } | null {
  if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === "tool_result")) return null;
    content = content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n");
  }
  if (typeof content !== "string") return null;
  const ctx = content.indexOf(CONTEXT_TAG);
  if (ctx >= 0) {
    // Board-sent prompt: show only what the user typed; pure instructions become a short note.
    const typed = content.slice(0, ctx).trim();
    const tag = content.slice(ctx, content.indexOf(">", ctx) + 1);
    const setup = parseSetupBlock(content.slice(ctx));
    const extra = setup ? { setup } : {};
    // Huddle messages for this ticket's session: huddle="<huddle id>".
    const huddle = tag.match(/ huddle="([^"]*)"/)?.[1];
    // A wake the board sent by itself (wake="<summary>"): a board note that opens to the full text, never the user's message.
    const wake = tag.match(/ wake="([^"]*)"/)?.[1];
    if (wake !== undefined) return { kind: "board", text: typed, wake: wake || "update", ...extra };
    if (typed && huddle) return { kind: "text", text: typed, huddle, ...extra };
    if (typed) return { kind: "text", text: typed, ...extra };
    const note = content.slice(ctx).match(/note="([^"]*)"/)?.[1];
    return { kind: "board", text: note || "Board sent instructions to Claude", ...extra };
  }
  const t = withoutAttachmentNote(content.trim());
  // A slash command the user ran: Claude Code stores it as tags; show it as typed.
  const cmd = commandText(t);
  if (cmd) return terminalOnly(cmd) ? null : { kind: "text", text: cmd, command: cmd.slice(1).split(" ")[0] };
  // Other slash-command wrappers, hook output and skill preambles are stored as user messages too.
  if (!t || t.startsWith("<") || /^(Base directory for this skill|Caveat:|\[Request interrupted)/.test(t)) return null;
  return { kind: "text", text: t };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Planning-chat tools (ckanban MCP): their input becomes a form or card, like the text blocks. */
const QUESTIONS_TOOL = /(?:^|__)ask_questions$/;
const PROPOSAL_TOOL = /(?:^|__)propose_ticket$/;
const TICKETS_TOOL = /(?:^|__)propose_tickets$/;
const BRANCH_TOOL = /(?:^|__)propose_branch$/;
const HUDDLE_TOOL = /(?:^|__)propose_huddle$/;
const DELETE_TOOL = /(?:^|__)propose_delete$/;
const DELETE_SCHEDULE_TOOL = /(?:^|__)delete_schedule$/;
// Only the board's own tool: a same-named tool from another MCP server never passed propose_helper_rule's checks.
const HELPER_RULE_TOOL = /^mcp__ckanban__propose_helper_rule$/;
export { helperLineText };
const TEAMMATE_TOOL = /(?:^|__)propose_teammate$/;
const SQUAD_TOOL = /(?:^|__)propose_squad$/;
const AUTOMATION_TOOL = /(?:^|__)propose_automation$/;
const KEYS_TOOL = /(?:^|__)ask_keys$/;

/** The form or card a planning-chat tool call shows, or null for other tools (or input that can't be read). */
function cardEntry(block: any): Pick<SessionEntry, "questions" | "ask" | "proposal" | "newTickets" | "branch" | "huddle" | "deletion" | "scheduleDeletion" | "helperRule" | "teammate" | "squad" | "automation" | "keys"> | null {
  const name = String(block.name ?? "");
  // Refused calls (a tool ticket, a line too long) come back as errors and show no card, as for delete_schedule.
  if (HELPER_RULE_TOOL.test(name)) {
    // A line the tool would refuse (too long, invisible characters) shows no card, even before its result arrives.
    const text = helperLineText(block.input?.text);
    return suggestedLineError(text) ? null : { helperRule: { text, reason: helperLineText(block.input?.reason).slice(0, 300) } };
  }
  // A refused call (no such schedule, another board, a huddle helper) comes back as an error and shows no card.
  if (DELETE_SCHEDULE_TOOL.test(name)) {
    const id = typeof block.input?.id === "string" ? block.input.id.trim() : "";
    return id ? { scheduleDeletion: { id, reason: typeof block.input?.reason === "string" ? block.input.reason.trim() : "" } } : null;
  }
  if (KEYS_TOOL.test(name)) {
    const keys = parseKeysAsk(block.input);
    return keys && { keys };
  }
  if (QUESTIONS_TOOL.test(name)) {
    const questions = parseQuestions(block.input?.questions);
    const ask = parseAskMeta(block.input);
    return questions && { questions, ...(ask ? { ask } : {}) };
  }
  if (PROPOSAL_TOOL.test(name)) {
    const proposal = parseProposal(block.input);
    return proposal && { proposal };
  }
  if (TICKETS_TOOL.test(name)) {
    const newTickets = parseNewTickets(block.input?.tickets);
    return newTickets && { newTickets };
  }
  if (BRANCH_TOOL.test(name)) return { branch: { reason: typeof block.input?.reason === "string" ? block.input.reason.trim() : "" } };
  if (DELETE_TOOL.test(name)) {
    const ids = Array.isArray(block.input?.ids) ? [...new Set(block.input.ids.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()))] as string[] : [];
    return ids.length ? { deletion: { ids, reason: typeof block.input?.reason === "string" ? block.input.reason.trim() : "" } } : null;
  }
  if (TEAMMATE_TOOL.test(name)) {
    const teammate = parseTeammateProposal(block.input);
    return teammate && { teammate };
  }
  if (SQUAD_TOOL.test(name)) {
    const squad = parseSquadProposal(block.input);
    return squad && { squad };
  }
  if (AUTOMATION_TOOL.test(name)) {
    const automation = parseAutomationProposal(block.input);
    return automation && { automation };
  }
  if (HUDDLE_TOOL.test(name)) {
    // `squad` is the name Claude is told; older calls say `template`.
    const named = [block.input?.squad, block.input?.template].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const template = named?.trim();
    // With a squad the roster is optional: the card fills in the squad's.
    const roster = template && block.input?.roster === undefined ? [] : block.input?.roster;
    if (!(template && Array.isArray(roster) && !roster.length) && rosterError(roster)) return null;
    const reason = typeof block.input?.reason === "string" ? block.input.reason.trim() : "";
    // A budget Claude was asked for (capped); one that isn't a positive amount is left out, the card's default applies.
    const maxCostUsd = proposedBudget(block.input?.maxCostUsd);
    // What this run of the squad is about; carried to Start (cut to the limit the start route takes).
    const topic = typeof block.input?.topic === "string" ? block.input.topic.trim().slice(0, TOPIC_MAX) : "";
    return { huddle: { roster, reason, ...(template ? { template } : {}), ...(typeof maxCostUsd === "number" ? { maxCostUsd } : {}), ...(topic ? { topic } : {}) } };
  }
  return null;
}

/**
 * Parses a transcript as it grows: feed it the new bytes, read the result when needed. Feeding a transcript in pieces
 * gives the same result as parsing it whole, so a running session's new lines are parsed on their own.
 */
export class SessionParser {
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  /** As parsed; result() copies them before the end-of-transcript fix-ups (errors, failed cards, blocked moves). */
  private entries: SessionEntry[] = [];
  private artifacts = new Map<string, SessionArtifact>();
  private publishers = new Set<string>();
  /** Bash calls running `ckanban ticket setup` (by tool_use id). */
  private setups = new Set<string>();
  /** Card tool calls (by tool_use id) and those whose result was an error: those don't render. */
  private cards = new Set<string>();
  private failed = new Set<string>();
  /** Tool calls whose result was an error (their rows get a ✗). */
  private errored = new Set<string>();
  /** Subagents by the Agent tool_use id; their rows update as results and notifications arrive. */
  private agents = new Map<string, AgentInfo>();
  /** Workflows by the Workflow tool_use id; they update as the launch result and the end notification arrive. */
  private workflows = new Map<string, WorkflowInfo>();
  /** The last command was terminal-only: its output (next local-command-stdout, if any) is hidden too. */
  private hideOutput = false;
  private cache = new ChatCacheTracker();
  /** The bytes after the last newline: a line still being written. */
  private tail: Buffer = Buffer.alloc(0);
  private snapshot: ParsedSession | null = null;

  /** New bytes of the transcript, cut anywhere (even inside a line or a character). */
  feed(chunk: Uint8Array): void {
    let buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const nl = buf.lastIndexOf(10);
    if (nl >= 0) {
      this.lines(buf.toString("utf8", 0, nl));
      buf = buf.subarray(nl + 1);
    }
    // A complete JSON object with no newline yet is a whole line (a whole parse reads it too); a half-written one waits.
    if (buf.length && buf[0] === 0x7b && buf[buf.length - 1] === 0x7d) {
      let ev: any;
      try {
        ev = JSON.parse(buf.toString("utf8"));
      } catch {}
      if (ev && typeof ev === "object") {
        this.event(ev);
        buf = buf.subarray(buf.length);
      }
    }
    this.tail = Buffer.from(buf);
  }

  /** Whole lines of text (the last one may lack its newline). */
  lines(text: string): void {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      this.event(ev);
    }
  }

  private notified(text: unknown, at: string) {
    const n = typeof text === "string" ? parseTaskNotification(text) : null;
    const w = n && this.workflows.get(n.toolUseId);
    if (n && w) workflowNotified(w, n.status, n.result, at);
    const a = n && this.agents.get(n.toolUseId);
    if (!n || !a) return;
    a.status = notifiedStatus(n.status);
    a.endedAt = at || a.endedAt;
    a.updatedAt = at || a.updatedAt;
    if (a.status === "done") a.result = n.result ?? a.result;
    else a.error = n.result ?? `Agent ${n.status}`;
  }

  private peerEntry(u: NonNullable<ReturnType<typeof userText>>, uuid: string, at: string): SessionEntry {
    const from = u.kind === "text" && !u.huddle ? fromTicket(u.text) : null;
    // An automation's item is a peer entry too, so nothing reads it as the user's (lessons, rewind, Explain, chat search).
    const auto = u.kind === "text" && !u.huddle && !from ? fromAutomation(u.text) : null;
    return {
      uuid, at, role: "user", kind: u.kind, text: from ? from.text : auto ? auto.text : u.text, ...(u.command ? { command: u.command } : {}),
      ...(u.huddle ? { peer: { dir: "in" as const, ticketId: null }, huddleId: u.huddle } : {}),
      ...(from ? { peer: { dir: "in" as const, ticketId: from.ticketId, title: from.title } } : {}),
      ...(auto ? { peer: { dir: "in" as const, ticketId: null, automation: auto.name } } : {}),
      ...(u.setup ? { setup: u.setup } : {}), ...(u.wake ? { wake: u.wake } : {}),
    };
  }

  private event(ev: any): void {
    this.snapshot = null;
    if (ev.type === "custom-title" && typeof ev.customTitle === "string") this.customTitle = ev.customTitle;
    else if (ev.type === "ai-title" && typeof ev.aiTitle === "string") this.aiTitle = ev.aiTitle;
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const uuid = typeof ev.uuid === "string" ? ev.uuid : `${this.entries.length}`;
    // A message sent while Claude was working is saved as an attachment to the running turn, not a user message.
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && !ev.isSidechain) this.notified(ev.attachment.prompt, at);
    // A background task's end is queued for Claude first; a run that ends meanwhile (e.g. at its cap) never delivers it.
    if (ev.type === "queue-operation" && ev.operation === "enqueue" && typeof ev.content === "string") this.notified(ev.content, at);
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && ev.attachment.commandMode === "prompt" && !ev.isSidechain) {
      const u = userText(ev.attachment.prompt);
      if (u) this.entries.push(this.peerEntry(u, uuid, at));
      return;
    }
    if (ev.type === "system" && !ev.isSidechain) {
      // What a built-in command printed (/context, /model), and where /compact summarised the conversation.
      const out = ev.subtype === "local_command" && typeof ev.content === "string" ? localCommandOutput(ev.content) : null;
      if (out !== null && this.hideOutput) this.hideOutput = false;
      else if (out) this.entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
      else if (ev.subtype === "compact_boundary") this.entries.push({ uuid, at, role: "user", kind: "board", text: "Conversation compacted" });
      return;
    }
    if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain) return;
    if (!ev.isCompactSummary) this.cache.add(ev);
    const content = ev.message?.content;

    if (ev.type === "user") {
      // The summary /compact left behind: the boundary above already says so.
      if (ev.isCompactSummary) return;
      // A terminal-only command is hidden, and so is what it printed.
      if (typeof content === "string" && terminalOnly(commandText(content.trim()))) {
        this.hideOutput = true;
        return;
      }
      const out = typeof content === "string" ? localCommandOutput(content) : null;
      if (out !== null) {
        if (this.hideOutput) this.hideOutput = false;
        else if (out) this.entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
        return;
      }
      if (!ev.isMeta) this.hideOutput = false;
      this.notified(typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "", at);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result" && this.agents.has(b.tool_use_id)) agentResult(this.agents.get(b.tool_use_id)!, b, ev.toolUseResult, at);
          if (b?.type === "tool_result" && this.workflows.has(b.tool_use_id)) workflowLaunched(this.workflows.get(b.tool_use_id)!, b, ev.toolUseResult, at);
          if (b?.type === "tool_result" && b.is_error && this.cards.has(b.tool_use_id)) this.failed.add(b.tool_use_id);
          if (b?.type === "tool_result" && b.is_error) this.errored.add(b.tool_use_id);
          if (b?.type === "tool_result" && this.setups.has(b.tool_use_id)) {
            const setup = parseSetupBlock(resultText(b.content));
            if (setup) this.entries.push({ uuid: `${b.tool_use_id}:setup`, at, role: "assistant", kind: "board", text: "", setup });
          }
          // Only real publishes: output of the Artifact tool, or of the `ckanban artifact publish`
          // helper / publish_artifact MCP tool headless runs use. Other tools (e.g. Bash grepping a different session's file)
          // can print the same text.
          if (b?.type !== "tool_result" || !this.publishers.has(b.tool_use_id)) continue;
          for (const m of resultText(b.content).matchAll(PUBLISHED)) {
            const label = basename(m[1]).replace(/\.[a-z0-9]+$/i, "");
            this.artifacts.delete(m[2]); // re-insert so the newest publish sorts last
            this.artifacts.set(m[2], { url: m[2], label, at });
          }
        }
      }
      const u = userText(content);
      if (u && !ev.isMeta) {
        const e = this.peerEntry(u, uuid, at);
        if (e.kind === "text" && !e.peer && !e.setup) e.rewind = true;
        this.entries.push(e);
      }
      return;
    }

    this.hideOutput = false;
    if (!Array.isArray(content)) return;
    content.forEach((b: any, i: number) => {
      if (b?.type === "tool_use" && typeof b.id === "string" && isPublisher(b)) this.publishers.add(b.id);
      if (b?.type === "tool_use" && typeof b.id === "string" && b.name === "Bash" && SETUP_HELPER.test(String(b.input?.command ?? ""))) this.setups.add(b.id);
      const id = i ? `${uuid}:${i}` : uuid;
      const card = b?.type === "tool_use" && typeof b.id === "string" ? cardEntry(b) : null;
      if (b?.type === "text" && b.text?.trim()) this.entries.push({ uuid: id, at, role: "assistant", kind: "text", ...assistantBlock(b.text.trim()) });
      else if (card) {
        // The tool_use id keeps the uuid stable, so form drafts and answered/applied state stick to it.
        this.cards.add(b.id);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "text", text: "", ...card });
      } else if (b?.type === "tool_use" && AGENT_TOOL.test(b.name ?? "") && typeof b.id === "string") {
        const input = b.input ?? {};
        const agent: AgentInfo = {
          toolUseId: b.id, description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : "Subagent",
          type: typeof input.subagent_type === "string" ? input.subagent_type : null, background: input.run_in_background === true,
          status: "running", startedAt: at, endedAt: null, updatedAt: at, steps: [], stepCount: 0, current: null, result: null, error: null,
        };
        this.agents.set(b.id, agent);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "agent", text: toolLabel(b), agent });
      } else if (b?.type === "tool_use" && WORKFLOW_TOOL.test(b.name ?? "") && typeof b.id === "string") {
        const workflow = workflowFromCall(b.id, b.input, at);
        this.workflows.set(b.id, workflow);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "workflow", text: workflow.name, workflow });
      } else if (b?.type === "tool_use") {
        this.entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b), ...(typeof b.id === "string" ? { toolUseId: b.id } : {}) });
      }
    });
  }

  /** The session as parsed so far (the same object until more lines arrive; later lines don't change it). */
  result(): ParsedSession {
    if (this.snapshot) return this.snapshot;
    const entries = this.entries.filter((e) => !this.failed.has(e.uuid)).map((e) => {
      const c: SessionEntry = { ...e, ...(e.agent ? { agent: { ...e.agent } } : {}), ...(e.workflow ? { workflow: { ...e.workflow } } : {}) };
      if (c.toolUseId && this.errored.has(c.toolUseId)) c.error = true;
      return c;
    });
    dropBlockedMoves(entries);
    const last = entries.findLast((e) => e.kind === "text" && (e.text || e.questions || e.proposal || e.newTickets || e.branch || e.deletion || e.scheduleDeletion || e.helperRule || e.teammate || e.squad || e.automation || e.keys));
    const lastText = !last ? "" : last.text
      || (last.questions ? `Asked ${last.questions.length} question${last.questions.length > 1 ? "s" : ""}`
        : last.newTickets ? `Proposed ${last.newTickets.length} new ticket${last.newTickets.length > 1 ? "s" : ""}`
        : last.branch ? "Offered to branch this ticket"
        : last.deletion ? `Asked to delete ${last.deletion.ids.length} ticket${last.deletion.ids.length > 1 ? "s" : ""}`
        : last.scheduleDeletion ? "Asked to delete a schedule"
        : last.helperRule ? "Suggested a line for the helper"
        : last.teammate ? `Proposed teammate @${last.teammate.name}`
        : last.squad ? `Proposed squad "${last.squad.squad.label}"`
        : last.automation ? `Proposed automation "${last.automation.name}"` : "Proposed an updated ticket");
    const asked = last?.role === "assistant" ? entries.findLast((e, i) => i < entries.indexOf(last) && e.role === "user" && e.kind === "text") : undefined;
    return (this.snapshot = {
      title: this.customTitle ?? this.aiTitle,
      entries,
      artifacts: [...this.artifacts.values()],
      lastMessage: last
        ? {
          role: last.role, text: lastText, at: last.at,
          ...(last.role === "user" && last.huddleId ? { from: "huddle" as const } : {}),
          ...(last.role === "user" && last.peer?.automation ? { from: "automation" as const } : {}),
          ...(asked?.huddleId ? { peerReply: true } : {}),
        }
        : null,
      ...pendingSince(entries),
      cache: this.cache.result(),
    });
  }
}

export function parseSession(raw: string): ParsedSession {
  const p = new SessionParser();
  p.lines(raw);
  return p.result();
}

/** The parent's tool_result for an Agent call: the report (sync), the launch (background) or an error. */
function agentResult(a: AgentInfo, block: any, meta: any, at: string): void {
  a.updatedAt = at || a.updatedAt;
  if (meta?.status === "async_launched") {
    a.background = true;
    return;
  }
  if (block.is_error) {
    a.status = "failed";
    a.error = resultText(block.content).trim() || "Agent failed";
  } else {
    a.status = "done";
    const report = meta && Array.isArray(meta.content) ? resultText(meta.content).trim() : "";
    a.result = report || handBack(resultText(block.content));
    if (typeof meta?.agentType === "string") a.type ??= meta.agentType;
  }
  a.endedAt = at || null;
}

/** A sync agent's tool_result wraps its report in a notice and indents it; keep just the report. */
function handBack(text: string): string {
  const m = /^\[Subagent hand-back\][^\n]*\n/.exec(text);
  if (!m) return text.trim();
  return text.slice(m[0].length).split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trim();
}

function pendingSince(entries: SessionEntry[]): Pick<ParsedSession, "openQuestions" | "openForm" | "openAsk" | "openFormId" | "pendingProposal" | "pendingNewTickets" | "pendingTeammates" | "pendingSquads" | "pendingAutomations" | "pendingKeys" | "pendingScheduleDeletes" | "pendingHelperRules"> {
  let lastUser = -1;
  entries.forEach((e, i) => {
    // Huddle messages and an automation's items don't answer what Claude asked the user (another ticket's message, e.g.
    // the planner's answer, does).
    if (e.role === "user" && e.kind === "text" && !e.huddleId && !e.peer?.automation) lastUser = i;
  });
  const after = entries.slice(lastUser + 1);
  // A form asked again (after a board wake) replaces the earlier ones: the chat shows only the newest as open.
  const form = after.findLast((e) => e.questions);
  const openForm = form?.questions ?? [];
  return {
    openQuestions: openForm.length,
    openForm,
    ...(form?.ask ? { openAsk: form.ask } : {}),
    ...(form ? { openFormId: form.uuid } : {}),
    pendingProposal: after.findLast((e) => e.proposal)?.proposal ?? null,
    pendingNewTickets: after.findLast((e) => e.newTickets)?.newTickets ?? [],
    pendingTeammates: after.filter((e) => e.teammate).map((e) => e.uuid),
    pendingSquads: after.filter((e) => e.squad).map((e) => e.uuid),
    pendingAutomations: after.filter((e) => e.automation).map((e) => e.uuid),
    pendingKeys: after.filter((e) => e.keys).map((e) => e.uuid),
    // Not only since the user's last message: a schedule waits to be deleted until the card is answered.
    pendingScheduleDeletes: entries.filter((e) => e.scheduleDeletion).map((e) => ({ uuid: e.uuid, id: e.scheduleDeletion!.id })),
    // Likewise: a suggested helper line waits for Add or Not now.
    pendingHelperRules: entries.filter((e) => e.helperRule).map((e) => e.uuid),
  };
}

interface CacheItem {
  file: string;
  /** The file read so far: its inode, size and change time when last checked, and how many bytes were parsed. */
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  parser: SessionParser;
  /** The parse with its subagents' transcripts merged in, for agentKey and that parse. */
  agentKey: string;
  mergedFrom: ParsedSession | null;
  merged: ParsedSession | null;
}

/**
 * How many parsed sessions stay in memory, most recently used first. A parse holds every entry of a transcript, so
 * keeping all of them (hundreds) took most of the daemon's memory; idle ones keep only their saved summary and are
 * parsed again when opened. Running sessions are kept too.
 */
const MAX_PARSED = 30;
/** A session whose transcript changed this recently counts as running and keeps its parse. */
const ACTIVE_MS = 10 * 60_000;

/** How much of a transcript one step of a warm-up reads (about 1 to 2ms of parsing). */
const WARM_CHUNK = 1 << 20;

/** A session file missing this long is searched for at most every MISSING_RETRY_MS. */
const MISSING_GRACE_MS = 5 * 60_000;
const MISSING_RETRY_MS = 60_000;
/** How long one scan of the projects folder answers lookups (a new run's file is found on the next poll). */
const INDEX_MS = 1_000;
/** The same while the session feed watches the folder: it adds new files to the scan, this is only a safety net. */
const FED_INDEX_MS = 60_000;
/** How soon new summaries are written to the summary cache file. */
const SUMMARY_FLUSH_MS = 2_000;

type StoredSummary = Omit<SessionSummary, "updatedAt">;
type SummaryItems = Record<string, { v: string; s: StoredSummary }>;
interface SummaryFile {
  tag: string;
  items: SummaryItems;
  /**
   * Summaries made by older code (another tag) whose transcripts haven't changed. They are shown until warm() has
   * made each one again, so a restart after a change to the parsing doesn't hold the board up while every transcript
   * is read; the file keeps them, so a second restart before that is done doesn't lose them either.
   */
  stale?: SummaryItems;
}

/**
 * The first part of the summaries' tag. Summaries from older code with the same number are shown until they are made
 * again (SummaryFile.stale); fields they lack get the empty summary's values. Raise it when an existing field
 * changes its type or meaning, so the old ones are dropped instead.
 */
const SUMMARY_FORMAT = 2;
const sameFormat = (tag: unknown) => typeof tag === "string" && tag.startsWith(`${SUMMARY_FORMAT}:`);
const isItems = (v: unknown): v is SummaryItems => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Tells summaries made by other code apart: the release version, and from source a hash of the code that makes them
 * (this file and what it imports, recursively), so a fix to the parsing applies at the next restart while a change
 * elsewhere in the server keeps the saved summaries. Most landed tickets change server files; dropping every summary
 * then made the first pass after the restart read every transcript again (seconds on a big board).
 */
export function summaryTag(dir = import.meta.dir, entry = "session"): string {
  const seen = new Set<string>();
  const hash: string[] = [];
  const todo = [entry];
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    let src: string;
    try {
      src = readFileSync(join(dir, `${name}.ts`), "utf8");
    } catch {
      continue;
    }
    hash.push(`${name}:${Bun.hash(src).toString(36)}`);
    for (const m of src.matchAll(/^(?:import|export)(?! type )[^;]*?from "\.\/([\w.-]+)"/gm)) todo.push(m[1]);
  }
  return `${SUMMARY_FORMAT}:${VERSION}:${Bun.hash(hash.sort().join(",")).toString(36)}`;
}

/** Parses session files lazily; re-reads only when size/mtime change. */
export class SessionCache {
  private items = new Map<string, CacheItem>();
  private files = new Map<string, string>();
  private agents = new SubagentCache();
  private workflowFiles = new WorkflowCache();
  /** Sessions whose file wasn't found: since when, and when it was last searched for. */
  private missing = new Map<string, { since: number; at: number }>();
  /**
   * Session files by id from one scan of the projects folder. Searching each id on its own stats a path per projects
   * folder (often 1000+), so a few dozen tickets whose transcripts are gone held the daemon up for seconds.
   */
  private index: { at: number; files: Map<string, string> } | null = null;

  /**
   * Summaries by session id and file version, kept on disk (summaryFile) so the board's first load after a restart
   * doesn't read and parse every ticket's transcript again.
   */
  private summaries: SummaryFile | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The warm-ups started so far (warm()), one after another. */
  private warming: Promise<void> = Promise.resolve();
  /** Settles once the latest warm-up has a summary to show for each of its sessions (ready()). */
  private usable: Promise<void> = Promise.resolve();
  /** What a summary of an empty transcript holds: the values an older summary's missing fields get. */
  private blank: StoredSummary | null = null;
  /** The session feed keeping the scan current (follow()), so it isn't redone every second while a session is missing. */
  private feed: SessionChanges | null = null;

  constructor(private dirs: Dirs = {}, private now: () => number = Date.now, private summaryFile?: string) {}

  private storedSummaries(): SummaryFile {
    if (this.summaries) return this.summaries;
    const tag = summaryTag();
    let items: SummaryItems = {};
    let stale: SummaryItems = {};
    if (this.summaryFile) {
      try {
        const v = JSON.parse(readFileSync(this.summaryFile, "utf8"));
        if (isItems(v?.items) && sameFormat(v.tag)) {
          const older = isItems(v.stale) ? v.stale : {};
          if (v.tag === tag) [items, stale] = [v.items, older];
          else stale = { ...older, ...v.items };
        }
      } catch {}
    }
    return (this.summaries = { tag, items, ...(Object.keys(stale).length ? { stale } : {}) });
  }

  /** An older summary of this session that still matches its transcript (version v), to show until it is made again. */
  private staleSummary(sessionId: string, v: string | null): StoredSummary | null {
    const old = v ? this.storedSummaries().stale?.[sessionId] : undefined;
    if (!old || old.v !== v) return null;
    this.blank ??= this.summaryOf(new SessionParser().result());
    return { ...this.blank, ...old.s };
  }

  private storeSummary(sessionId: string, v: string, s: StoredSummary) {
    if (!this.summaryFile) return;
    const stored = this.storedSummaries();
    stored.items[sessionId] = { v, s };
    if (stored.stale) delete stored.stale[sessionId];
    this.flushTimer ??= setTimeout(() => this.flushSummaries(), SUMMARY_FLUSH_MS);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /** Writes the summary cache file now (also called on a timer after new summaries). */
  flushSummaries(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.summaryFile || !this.summaries) return;
    try {
      atomicWrite(this.summaryFile, JSON.stringify(this.summaries));
    } catch (e) {
      console.error("session summary cache", e);
    }
  }

  /** Keeps the scan of the projects folder current from the feed's new transcripts instead of rescanning it every second. */
  follow(feed: SessionChanges): () => void {
    this.feed = feed;
    const stop = feed.subscribe((c) => {
      if (!c?.file) return;
      this.index?.files.set(c.sessionId, c.file);
      this.scanAdds?.set(c.sessionId, c.file);
      this.missing.delete(c.sessionId);
    });
    return () => {
      stop();
      if (this.feed === feed) this.feed = null;
    };
  }

  private locate(sessionId: string): string | null {
    const known = this.files.get(sessionId);
    if (known) {
      try {
        statSync(known);
        return known;
      } catch {
        // Gone: the scan still lists it until its next refresh (up to a minute while the feed runs).
        this.files.delete(sessionId);
        if (this.index?.files.get(sessionId) === known) this.index.files.delete(sessionId);
      }
    }
    // A search stats one path per projects folder (often 1000+), and old tickets' transcripts get deleted. A new run's
    // file shows up within seconds, so only one missing for a while is searched less often.
    const now = this.now();
    const miss = this.missing.get(sessionId);
    if (miss && now - miss.since >= MISSING_GRACE_MS && now - miss.at < MISSING_RETRY_MS) return null;
    const indexMs = this.feed?.live ? FED_INDEX_MS : INDEX_MS;
    if (!this.index || now - this.index.at >= indexMs || now < this.index.at) {
      // With the feed live a fresh scan is only a safety net: it runs in the background (seconds of frozen daemon on a
      // busy Mac when done here), and the scan we have answers meanwhile.
      if (this.index && this.feed?.live) this.rescan();
      else this.index = { at: now, files: scanSessionFiles(this.dirs) };
    }
    const f = this.index.files.get(sessionId) ?? null;
    if (f) {
      this.files.set(sessionId, f);
      this.missing.delete(sessionId);
    } else this.missing.set(sessionId, { since: miss?.since ?? now, at: now });
    return f;
  }

  /** Files the feed reported while a background scan runs: the scan may have read their folder before they came. */
  private scanAdds: Map<string, string> | null = null;

  /** A fresh index from a scan off the event loop (one at a time); the old index stays until it is done. */
  private rescan(): void {
    if (this.scanAdds) return;
    const adds = (this.scanAdds = new Map());
    const at = this.now();
    void scanSessionFilesAsync(this.dirs)
      .then((files) => {
        for (const [id, f] of adds) files.set(id, f);
        this.index = { at, files };
      }, (e) => console.error("session scan", e))
      .finally(() => {
        if (this.scanAdds === adds) this.scanAdds = null;
      });
  }

  private fileVersion(f: string): string | null {
    try {
      const s = statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** The session's transcript file, wherever it is under the projects folder; null when there is none. */
  file(sessionId: string): string | null {
    return this.locate(sessionId);
  }

  /** Cheap change marker for polling (subagent transcripts included); null when the session file doesn't exist. */
  version(sessionId: string): string | null {
    const f = this.locate(sessionId);
    const v = f && this.fileVersion(f);
    if (!f || !v) return null;
    const agents = this.agents.version(f);
    const workflows = this.workflowFiles.version(f);
    return `${v}${agents ? `|${agents}` : ""}${workflows ? `|w${workflows}` : ""}`;
  }

  /**
   * Parses what the transcript gained since the last call (at most maxBytes of it): only new lines are read, a
   * half-written last line waits for the next call, and a file that shrank or was replaced is parsed from the start.
   */
  private catchUp(sessionId: string, f: string, maxBytes = Infinity): CacheItem | null {
    let st: Stats;
    try {
      st = statSync(f);
    } catch {
      return null;
    }
    let hit = this.items.get(sessionId);
    const rewritten = hit && (hit.file !== f || hit.ino !== st.ino || st.size < hit.offset || (st.size === hit.size && st.mtimeMs !== hit.mtimeMs));
    if (!hit || rewritten) {
      hit = { file: f, ino: st.ino, size: 0, mtimeMs: 0, offset: 0, parser: new SessionParser(), agentKey: "", mergedFrom: null, merged: null };
    }
    hit.size = st.size;
    hit.mtimeMs = st.mtimeMs;
    // Most recently used last; the oldest beyond MAX_PARSED are dropped, except sessions written to lately (running
    // ones: their transcripts are the biggest and are read again every poll).
    this.items.delete(sessionId);
    this.items.set(sessionId, hit);
    if (this.items.size > MAX_PARSED) {
      const recent = this.now() - ACTIVE_MS;
      for (const [k, v] of this.items) {
        if (this.items.size <= MAX_PARSED) break;
        if (k !== sessionId && v.mtimeMs < recent) this.items.delete(k);
      }
    }
    const n = Math.min(st.size - hit.offset, maxBytes);
    if (n <= 0) return hit;
    let fd: number | null = null;
    try {
      fd = openSync(f, "r");
      // In steps of at most WARM_CHUNK: one buffer the size of a big transcript stays with the allocator afterwards.
      const buf = Buffer.allocUnsafe(Math.min(n, WARM_CHUNK));
      for (let left = n; left > 0; ) {
        const got = readSync(fd, buf, 0, Math.min(left, buf.length), hit.offset);
        hit.parser.feed(buf.subarray(0, got));
        hit.offset += got;
        left -= got;
        // The file is shorter than it said (cut while reading): look again next time.
        if (!got) {
          hit.size = hit.offset;
          break;
        }
      }
    } catch {
      this.items.delete(sessionId);
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return hit;
  }

  /** The session's own transcript parsed, without its subagents' transcripts. */
  private parsed(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    return (f ? this.catchUp(sessionId, f)?.parser.result() : null) ?? null;
  }

  get(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    const hit = f && this.catchUp(sessionId, f);
    if (!f || !hit) return null;
    const parsed = hit.parser.result();
    const hasAgents = parsed.entries.some((e) => e.agent);
    const hasWorkflows = parsed.entries.some((e) => e.workflow);
    if (!hasAgents && !hasWorkflows) return parsed;
    const agentKey = `${hasAgents ? this.agents.version(f) : ""}|${hasWorkflows ? this.workflowFiles.version(f) : ""}`;
    if (hit.agentKey !== agentKey || hit.mergedFrom !== parsed || !hit.merged) {
      const transcripts = hasAgents ? this.agents.load(f) : new Map();
      hit.merged = {
        ...parsed,
        entries: parsed.entries.map((e) => {
          if (e.agent) return { ...e, agent: withTranscript(e.agent, transcripts.get(e.agent.toolUseId)) };
          if (e.workflow) return { ...e, workflow: withRun(e.workflow, e.workflow.runId ? this.workflowFiles.load(f, e.workflow.runId) : null) };
          return e;
        }),
      };
      hit.mergedFrom = parsed;
      hit.agentKey = agentKey;
    }
    return hit.merged;
  }

  /**
   * Readies these sessions' summaries without blocking the event loop for more than about sliceMs at a time: big
   * transcripts are read in chunks, with a pause between steps. Sessions whose saved summary is still valid are
   * skipped. Pages that list many tickets wait for it (ready()) instead of parsing everything at once.
   *
   * Two rounds. First the sessions with nothing to show (no saved summary, or the transcript changed since): ready()
   * waits for these only. Then the ones still shown from an older summary (SummaryFile.stale) are made again, and
   * `changed` is called for each whose summary came out different. The returned promise settles after both.
   */
  warm(sessionIds: string[], sliceMs = 30, changed?: (sessionId: string) => void): Promise<void> {
    const pause = pauser(sliceMs);
    const read = async (id: string, f: string) => {
      for (;;) {
        const hit = this.catchUp(id, f, WARM_CHUNK);
        if (!hit || hit.offset >= hit.size) break;
        await pause();
      }
    };
    const missing = async () => {
      for (const id of sessionIds) {
        await pause();
        const f = this.locate(id);
        if (!f) continue;
        const v = this.summaryFile ? this.version(id) : null;
        if (v && (this.storedSummaries().items[id]?.v === v || this.staleSummary(id, v))) continue;
        await read(id, f);
        this.summary(id);
      }
    };
    const remake = async () => {
      if (!this.summaryFile) return;
      for (const id of sessionIds) {
        await pause();
        if (!this.storedSummaries().stale?.[id]) continue;
        const f = this.locate(id);
        const old = f && this.staleSummary(id, this.version(id));
        // Gone, or changed since the first round: summary() reads it when someone asks.
        if (!f || !old) continue;
        await read(id, f);
        const now = this.fresh(id);
        if (now && changed) {
          const { updatedAt: _, ...s } = now;
          if (!Bun.deepEquals(s, old)) changed(id);
        }
      }
      // What is left belongs to sessions nobody asked for (deleted tickets): not kept for another restart.
      const stored = this.storedSummaries();
      if (stored.stale) {
        delete stored.stale;
        this.flushTimer ??= setTimeout(() => this.flushSummaries(), SUMMARY_FLUSH_MS);
        (this.flushTimer as { unref?: () => void }).unref?.();
      }
    };
    const usable = this.warming.then(missing, missing);
    const next: Promise<void> = usable.then(remake).finally(() => {
      if (this.warming === next) this.warming = this.usable = Promise.resolve();
    });
    this.usable = usable;
    return (this.warming = next);
  }

  /**
   * Reads what the session's transcript gained, a chunk at a time with `pause` between, unless its saved summary still
   * holds. Watchers call it before summary(): a running session's first read after a restart (tens of MB) or one that
   * fell out of the parse cache otherwise froze the daemon for seconds in one go.
   */
  async readIn(sessionId: string, pause: () => Promise<void>): Promise<void> {
    const f = this.locate(sessionId);
    if (!f) return;
    if (this.summaryFile) {
      const v = this.version(sessionId);
      if (v && (this.storedSummaries().items[sessionId]?.v === v || this.staleSummary(sessionId, v))) return;
    }
    for (;;) {
      const hit = this.catchUp(sessionId, f, WARM_CHUNK);
      if (!hit || hit.offset >= hit.size) break;
      await pause();
    }
  }

  /**
   * Settles when every session of the warm-ups started so far has a summary to show (some still from older code, until
   * made again: see warm()).
   */
  ready(): Promise<void> {
    return this.usable;
  }

  /** Settles when every warm() started so far has finished: every summary is made by this code. */
  settled(): Promise<void> {
    return this.warming;
  }

  /** A workflow's files (journal, agent transcripts, summary), or null when the session or run is unknown. */
  workflowRun(sessionId: string, runId: string): WorkflowRun | null {
    const f = this.locate(sessionId);
    return f ? this.workflowFiles.load(f, runId) : null;
  }

  /** One tool call in full (input and output), from the session or one of its subagents' transcripts. */
  toolDetail(sessionId: string, toolUseId: string): ToolDetail | null {
    const f = this.locate(sessionId);
    return f ? findToolDetailIn([f, ...subagentFiles(f)], toolUseId) : null;
  }

  summary(sessionId: string): SessionSummary | null {
    const f = this.locate(sessionId);
    if (!f) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    // Its transcript (and its subagents') unchanged since the summary was made: no need to read it.
    const v = this.summaryFile ? this.version(sessionId) : null;
    const hit = v ? this.storedSummaries().items[sessionId] : undefined;
    if (hit && hit.v === v) return { ...hit.s, updatedAt };
    const old = this.staleSummary(sessionId, v);
    if (old) return { ...old, updatedAt };
    return this.fresh(sessionId);
  }

  /** The summary read from the transcript now (and saved), whatever older summary there is. */
  private fresh(sessionId: string): SessionSummary | null {
    const f = this.locate(sessionId);
    const p = f && this.parsed(sessionId);
    if (!f || !p) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    const v = this.summaryFile ? this.version(sessionId) : null;
    const s = this.summaryOf(p);
    if (v) this.storeSummary(sessionId, v, s);
    return { ...s, updatedAt };
  }

  private summaryOf(p: ParsedSession): StoredSummary {
    return {
      // The preview is stored and sent to the UI: a saved key in Claude's last message is hidden there.
      title: p.title, lastMessage: p.lastMessage && this.summaryFile ? { ...p.lastMessage, text: maskSaved(dirname(this.summaryFile), p.lastMessage.text) } : p.lastMessage, artifacts: p.artifacts,
      openQuestions: p.openQuestions, openForm: p.openForm, ...(p.openAsk ? { openAsk: p.openAsk } : {}), ...(p.openFormId ? { openFormId: p.openFormId } : {}), pendingProposal: p.pendingProposal, pendingNewTickets: p.pendingNewTickets, pendingTeammates: p.pendingTeammates, pendingSquads: p.pendingSquads,
      pendingAutomations: p.pendingAutomations, ...(p.pendingKeys.length ? { pendingKeys: p.pendingKeys } : {}),
      ...(p.pendingScheduleDeletes.length ? { pendingScheduleDeletes: p.pendingScheduleDeletes } : {}),
      ...(p.pendingHelperRules.length ? { pendingHelperRules: p.pendingHelperRules } : {}), cache: p.cache,
    };
  }
}

/**
 * One polling pass: emit session.updated for every ticket whose session file changed since last pass. With emit
 * false it only notes the versions and readies the summaries (the watcher's first pass: nothing changed yet for pages
 * that load after it, and their first load finds the summaries ready).
 */
export function pollSessions(store: Store, bus: Bus, cache: SessionCache, state: Map<string, string>, emit = true, seen?: (sessionId: string | null, key: string) => void): void {
  const live = new Set<string>();
  for (const p of store.listProfiles()) {
    for (const t of store.listTickets(p.slug)) {
      seen?.(t.sessionId, `${p.slug}/${t.id}`);
      pollOne(bus, cache, state, live, p.slug, t, emit);
    }
  }
  for (const k of state.keys()) if (!live.has(k)) state.delete(k);
}

/**
 * pollSessions in slices: it pauses every ~sliceMs, also inside a long transcript read. Each ticket's look costs a few
 * stats (its transcript, its subagents' and workflows' folders): tens of ms for a big board on an idle Mac, but seconds
 * of frozen daemon when the Mac is busy (test suites, a virus scan). The listing can be a moment old by the time a
 * ticket is looked at: what changed meanwhile the Store's writes and the feed report to the next pass anyway.
 */
export async function pollSessionsSliced(store: Store, bus: Bus, cache: SessionCache, state: Map<string, string>, emit = true, seen?: (sessionId: string | null, key: string) => void, sliceMs = 30): Promise<void> {
  const pause = pauser(sliceMs);
  const live = new Set<string>();
  for (const p of store.listProfiles()) {
    for (const t of store.listTickets(p.slug)) {
      await pause();
      seen?.(t.sessionId, `${p.slug}/${t.id}`);
      await pollOneSliced(bus, cache, state, live, p.slug, t, emit, pause);
    }
  }
  for (const k of state.keys()) if (!live.has(k)) state.delete(k);
}

/** pollOne, with a changed transcript read in chunks first (SessionCache.readIn). */
async function pollOneSliced(bus: Bus, cache: SessionCache, state: Map<string, string>, live: Set<string>, slug: string, t: Ticket, emit: boolean, pause: () => Promise<void>): Promise<void> {
  if (t.sessionId) {
    const v = cache.version(t.sessionId);
    if (v && state.get(`${slug}/${t.id}`) !== `${t.sessionId}:${v}`) await cache.readIn(t.sessionId, pause);
  }
  pollOne(bus, cache, state, live, slug, t, emit);
}

function pollOne(bus: Bus, cache: SessionCache, state: Map<string, string>, live: Set<string>, slug: string, t: Ticket, emit: boolean): void {
  if (!t.sessionId) return;
  const key = `${slug}/${t.id}`;
  live.add(key);
  const v = cache.version(t.sessionId);
  if (!v || state.get(key) === `${t.sessionId}:${v}`) return;
  state.set(key, `${t.sessionId}:${v}`);
  const session = cache.summary(t.sessionId);
  if (session && emit) bus.emit({ type: "session.updated", profile: slug, id: t.id, session });
}

const SILENT = { emit() {} } as unknown as Bus;

/**
 * The watcher's first pass after a start: readies every ticket's summary (reading transcripts in slices, see
 * SessionCache.warm) and notes the versions. It pauses every ~sliceMs, so a start with no saved summaries (seconds of
 * reading on a big board, minutes on a busy Mac) never freezes the daemon. It sends nothing, except for a ticket whose
 * summary from older code was shown meanwhile and came out different (given `bus`).
 */
export async function primeSessions(store: Store, cache: SessionCache, state: Map<string, string>, sliceMs = 30, bus?: Bus): Promise<void> {
  const tickets = store.listProfiles().flatMap((p) => store.listTickets(p.slug).map((t) => ({ slug: p.slug, t })));
  // Huddle teammates' sessions too: a ticket's links list their artifacts.
  const teammates = store.listProfiles().flatMap((p) => store.listHuddles(p.slug).flatMap((h) => h.participants.flatMap((x) => (x.kind === "agent" && x.sessionId ? [x.sessionId] : []))));
  const remade = new Set<string>();
  await cache.warm([...tickets.flatMap(({ t }) => (t.sessionId ? [t.sessionId] : [])), ...teammates], sliceMs, (id) => remade.add(id));
  const pause = pauser(sliceMs);
  const live = new Set<string>();
  for (const { slug, t } of tickets) {
    await pause();
    if (!t.sessionId) continue;
    if (bus && remade.has(t.sessionId)) {
      // Announce it even when a pass during the warm-up already noted this version (with the older summary).
      const session = cache.summary(t.sessionId);
      if (session) bus.emit({ type: "session.updated", profile: slug, id: t.id, session });
    }
    pollOne(SILENT, cache, state, live, slug, t, false);
  }
}

/**
 * Announces ticket sessions that changed. With a session feed watching Claude's projects folder, a pass looks only at
 * the tickets the Store just wrote and the sessions the feed reported, plus a full pass every safetyMs for missed
 * changes (outside edits to ticket files, a dropped event). Without a live feed every pass is a full one.
 */
export function startSessionWatcher(store: Store, bus: Bus, cache: SessionCache, intervalMs = 2000, o: { feed?: SessionChanges; safetyMs?: number; now?: () => number; sliceMs?: number } = {}): () => void {
  const state = new Map<string, string>();
  const sliceMs = o.sliceMs ?? 30;
  const now = o.now ?? Date.now;
  const safetyMs = o.safetyMs ?? SAFETY_PASS_MS;
  // Changes since the last pass: tickets by "slug/id", sessions by id; unknown when the feed couldn't say what changed.
  const tickets = new Set<string>();
  const sessions = new Set<string>();
  let unknown = false;
  // Ticket keys by session id, from the last full pass and the Store's writes since.
  let owners = new Map<string, Set<string>>();
  // What the full pass under way has seen so far; it replaces owners when the pass is done.
  let nextOwners: Map<string, Set<string>> | null = null;
  const add = (map: Map<string, Set<string>>, sessionId: string, key: string) => {
    let keys = map.get(sessionId);
    if (!keys) map.set(sessionId, (keys = new Set()));
    keys.add(key);
  };
  const own = (sessionId: string | null | undefined, key: string) => {
    if (!sessionId) return;
    add(owners, sessionId, key);
    if (nextOwners) add(nextOwners, sessionId, key);
  };
  const stopStore = store.onChange((c) => {
    if (c.kind === "ticket") tickets.add(`${c.slug}/${c.id}`);
  });
  const stopFeed = o.feed?.subscribe((c) => (c ? sessions.add(c.sessionId) : (unknown = true)));
  // The first timer pass is a full one: it learns which tickets own which sessions.
  let lastFull = -Infinity;
  // A full pass runs in slices (pollSessionsSliced): on a busy Mac it takes seconds, and the daemon answers meanwhile.
  // The owners it learns replace the old ones only when it is done, so changed() keeps finding them until then.
  const full = async (emit: boolean) => {
    tickets.clear();
    sessions.clear();
    unknown = false;
    lastFull = now();
    const next = (nextOwners = new Map());
    try {
      await pollSessionsSliced(store, bus, cache, state, emit, (id, key) => id && add(next, id, key), sliceMs);
      owners = next;
    } finally {
      nextOwners = null;
    }
  };
  // One at a time, in slices: a changed session's transcript may need a long read (SessionCache.readIn).
  let changing: Promise<void> | null = null;
  const changed = () => {
    if (changing) return changing;
    const keys = new Set(tickets);
    for (const id of sessions) for (const k of owners.get(id) ?? []) keys.add(k);
    tickets.clear();
    sessions.clear();
    if (!keys.size) return;
    const pause = pauser(sliceMs);
    const run = async () => {
      for (const key of keys) {
        await pause();
        const i = key.indexOf("/");
        const slug = key.slice(0, i);
        const t = store.getTicket(slug, key.slice(i + 1));
        if (!t?.sessionId) {
          state.delete(key);
          continue;
        }
        own(t.sessionId, key);
        await pollOneSliced(bus, cache, state, new Set(), slug, t, true, pause);
      }
    };
    return (changing = run().catch((e) => console.error("session watcher", e)).finally(() => (changing = null)));
  };
  // The first pass after a start announced every ticket's session (hundreds of events, each built for every open tab:
  // seconds right after a restart). Pages load what they need when they (re)connect, and the notifier takes stock at
  // its start, so the first pass only takes stock. It starts at once (pages wait through cache.ready() until every
  // ticket has a summary to show, the notifier through cache.settled() until the pass is done) and runs in slices; the
  // timer's full passes wait until it is done. Meanwhile, with a live feed, the timer still announces the sessions
  // that change (running tickets' chats keep moving however long the first pass takes on a busy Mac).
  let primed = false;
  let priming = true;
  for (const p of store.listProfiles()) for (const t of store.listTickets(p.slug)) own(t.sessionId, `${p.slug}/${t.id}`);
  void track("session-watcher: first pass", () => primeSessions(store, cache, state, 30, bus))
    .then(() => (primed = true), (e) => console.error("session watcher", e))
    .finally(() => (priming = false));
  let passing = false;
  const timer = trackedInterval("session-watcher", () => {
    try {
      // The first pass or a full one still under way: only what the feed says changed meanwhile.
      if (priming || passing) {
        if (o.feed?.live && !unknown) return changed();
        return;
      }
      if (!primed || !o.feed?.live || unknown || now() - lastFull >= safetyMs) {
        passing = true;
        const emit = primed;
        primed = true;
        return full(emit)
          .catch((e) => console.error("session watcher", e))
          .finally(() => (passing = false));
      }
      return changed();
    } catch (e) {
      console.error("session watcher", e);
    }
  }, intervalMs);
  return () => {
    clearInterval(timer);
    stopStore();
    stopFeed?.();
  };
}
