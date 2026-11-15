import { helperLineText, suggestedLineError } from "../server/helper/line";
import { withoutAttachmentNote } from "../board/attachments";
import { commandText, TERMINAL_COMMANDS } from "../chat/commands";
import { proposedBudget, rosterError, type RosterEntry } from "../server/huddle-roster";
import { mockupName, stripMockups } from "../board/mockups";
import { parseResult } from "./result";
import type { ChatCache } from "../chat/chat-cache";
import { parseTeammateProposal, type TeammateProposal } from "../server/teammate-proposal";
import { parseSquadProposal, type SquadProposal } from "../server/squad";
import { TOPIC_MAX } from "../server/huddle-templates";
import { parseAutomationProposal, type AutomationProposal } from "../server/automation-proposal";
import { parseKeysAsk, type KeysAsk } from "../server/ask-keys";
import { normalizeTags } from "../board/tags";
import type { AgentInfo } from "./subagents";
import type { WorkflowInfo } from "./workflows";
import { parseSetupBlock, type SetupResult } from "./worktree-setup";
import { starredTitle } from "../core/util";

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
export function assistantBlock(text: string): Pick<SessionEntry, "text" | "questions" | "proposal" | "newTickets" | "mockups" | "moved" | "unreadable"> {
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
export function dropBlockedMoves(entries: SessionEntry[]): void {
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

export const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/g;

const HELPER_PUBLISH = /\bartifact publish\b/;
const PUBLISH_TOOL = /(?:^|__)publish_artifact$/;

/** `ckanban ticket setup`: its output ends with the setup block the chat draws a row from. */
export const SETUP_HELPER = /\bticket setup\b/;

export function isPublisher(block: any): boolean {
  if (block.name === "Artifact" || PUBLISH_TOOL.test(String(block.name ?? ""))) return true;
  return block.name === "Bash" && typeof block.input?.command === "string" && HELPER_PUBLISH.test(block.input.command);
}

/** A Claude Code built-in typed in a terminal session (/exit, /resume): not part of the ticket chat. */
export function terminalOnly(cmd: string | null): boolean {
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

export function userText(content: unknown): { kind: "text" | "board"; text: string; huddle?: string; setup?: SetupResult; command?: string; wake?: string } | null {
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

export function resultText(content: unknown): string {
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
export function cardEntry(block: any): Pick<SessionEntry, "questions" | "ask" | "proposal" | "newTickets" | "branch" | "huddle" | "deletion" | "scheduleDeletion" | "helperRule" | "teammate" | "squad" | "automation" | "keys"> | null {
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
