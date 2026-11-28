import type { AutomationProposal } from "../../../features/schedules/automationTypes";
import type { ChatCacheInfo } from "../../../features/chat/cacheNote";
import type { SetupResult } from "./board";
import type { KeysAsk } from "./connections";
import type { RosterEntry, SquadProposal, TeammateProposal } from "./huddle";
import type { Proposal, Question } from "./ticket";

/** "Help me understand" questions (src/chat/explain.ts). */
export type HelpKind = "recap" | "changes";

/** One "Help me understand" answer, shown as a card in the ticket's chat. */
export interface HelpCard {
  id: string;
  /** "lessons": an old "Learn from this ticket" card (not shown any more). */
  kind: HelpKind | "lessons";
  at: string;
  text: string;
  costUsd: number;
  model: string;
}

/** A quick chat with Claude in the board's folder, no ticket (src/chat/quickchat.ts QuickChatView). */
export interface QuickChat {
  id: string;
  sessionId: string;
  /** The user's title, else the first message's first line. */
  title: string;
  renamed: boolean;
  firstMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** Claude saved the conversation (Make ticket needs it). */
  started: boolean;
  /** Make ticket turned it into this ticket; the conversation continues there. */
  ticketId: string | null;
  error: string | null;
  running: boolean;
  /** What Claude is doing now. */
  activity: string | null;
  /** Messages waiting for a board restart to finish. */
  waiting: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  state: "queued" | "unsent";
  /** From another session (a huddle's messages): text is the full prompt. */
  peer?: boolean;
  /** Sent by another ticket's Claude: which one (shown with that ticket's name, not as yours). */
  from?: { ticketId: string; title: string };
  /** A later item of an automation's thread: which automation (shown with its name, not as yours). */
  automation?: { loopId: string; name: string };
  /** A slash command: Claude Code runs it as its own turn, after the current one. */
  slash?: "prompt" | "local";
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** A user-role message the user didn't write: a huddle digest, or an automation's item. */
  from?: "huddle" | "automation";
  /** Claude's quiet reply to such a message. */
  peerReply?: boolean;
}

export interface SessionSummary {
  title: string | null;
  lastMessage: SessionMessage | null;
  artifacts: { url: string; label: string; at: string }[];
  updatedAt: string;
  openQuestions: number;
  pendingProposal: { title: string; description: string } | null;
  pendingTeammates?: string[];
  /** Squad cards since the user's last message (Ticket.squadCards says which were answered). */
  pendingSquads?: string[];
  /** Conversation size and cache time at Claude's last reply, for the old-chat line and Send ask (cacheNote.ts). */
  cache?: ChatCacheInfo | null;
}

export interface SessionEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  /** agent: a subagent Claude started (its own row with status, steps and result). */
  kind: "text" | "tool" | "board" | "agent" | "workflow";
  text: string;
  /** Tool rows: the tool_use id (api.tool loads its full input and output). */
  toolUseId?: string;
  /** Tool rows whose result was an error. */
  error?: true;
  /** A plain message of the user's: the chat can rewind to it. */
  rewind?: true;
  agent?: AgentInfo;
  /** A workflow Claude started (kind "workflow"): its phases and helper agents. */
  workflow?: WorkflowInfo;
  questions?: Question[];
  proposal?: Proposal;
  /** Claude offered to branch this ticket (Branch button). */
  branch?: { reason: string };
  /** Claude proposed a huddle (propose_huddle): the roster card with Start. */
  huddle?: { roster: RosterEntry[]; reason: string; template?: string; maxCostUsd?: number; topic?: string };
  /** Claude asked to delete tickets (propose_delete): the card with Cancel / Delete. */
  /** cancelJobs: Claude proposed cancelling the tickets' waiting jobs too (true: all; else job ids); the user's click decides. */
  deletion?: { ids: string[]; reason: string; cancelJobs?: true | string[] };
  /** Claude asked to delete a schedule (delete_schedule in a board chat or run): the card with Keep / Delete. */
  scheduleDeletion?: { id: string; reason: string };
  /** Claude suggested a line for what the helper knows about the user (propose_helper_rule): the card with Not now / Add. */
  helperRule?: { text: string; reason: string };
  /** Claude proposed a teammate (propose_teammate): the card with Save teammate / Edit first / Dismiss. */
  teammate?: TeammateProposal;
  /** Claude proposed a squad (propose_squad): the card with Save for this board / Save for all boards / Edit first / Dismiss. */
  squad?: SquadProposal;
  /** Claude proposed an automation (propose_automation): the card with Connect and Save automation. */
  automation?: AutomationProposal;
  /** Claude asked for keys (ask_keys): a key box. Names only, never values. */
  keys?: KeysAsk;
  /** Mockups Claude sent in this reply, saved as outputs/mockups/<name>. */
  mockups?: string[];
  moved?: "planning";
  /** A board block whose JSON couldn't be read (left visible as text). "tickets": an old reply's proposed tickets (no Resend). */
  unreadable?: "questions" | "proposal" | "tickets";
  /** A message from outside the user (a huddle digest): in = into this session. */
  /** ticketId and title: a message another ticket's Claude sent (text is just the message); ticketId null: a huddle digest. */
  peer?: { dir: "in" | "out"; ticketId: string | null; title?: string; automation?: string };
  /** Huddle messages delivered to this ticket's session (a peer entry too): the huddle's id. text is the digest. */
  huddleId?: string;
  /** Worktree setup that ran before this prompt (shown as a row before it). */
  setup?: SetupResult;
  /** A user message that ran this slash command (name without the slash). */
  command?: string;
  /** Output of a built-in command (/context), not a reply from Claude. */
  commandOutput?: boolean;
  /** A message the board sent by itself (status refresh, tool ticket updates; kind "board"): its one-line summary. text is the full message. */
  wake?: string;
}

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** One thing a subagent did: a tool call or a message it wrote. */
export interface AgentStep {
  kind: "tool" | "text";
  text: string;
  /** Tool calls: the tool_use id (api.tool loads its full input and output). */
  id?: string;
  error?: true;
}

/** One tool call in full, loaded when its row is opened. */
export interface ToolDetail {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** null while the call has no result yet (or the session lost it). */
  output: string | null;
  isError: boolean;
  truncated: boolean;
}

export interface AgentInfo {
  /** The parent's Agent tool_use id. */
  toolUseId: string;
  description: string;
  type: string | null;
  background: boolean;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  /** In the conversation: only the last steps; stepCount counts all. */
  steps: AgentStep[];
  stepCount: number;
  current: string | null;
  result: string | null;
  error: string | null;
}

export type WorkflowStatus = "running" | "done" | "failed" | "stopped";
export type WorkflowAgentStatus = "waiting" | "running" | "done" | "failed" | "stopped";

export interface WorkflowAgent {
  /** null for an agent still waiting to start. */
  agentId: string | null;
  label: string;
  /** "" when the script named no phase. */
  phase: string;
  status: WorkflowAgentStatus;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  costUsd: number;
  current: string | null;
  stepCount: number;
}

/** One helper agent in full: what it did and what it handed back. */
export interface WorkflowAgentDetail extends WorkflowAgent {
  steps: AgentStep[];
  result: string | null;
}

export interface WorkflowInfo {
  /** The Workflow tool_use id. */
  toolUseId: string;
  runId: string | null;
  taskId: string | null;
  name: string;
  description: string;
  /** Phase titles in script order. */
  phases: string[];
  status: WorkflowStatus;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  agents: WorkflowAgent[];
  costUsd: number;
  error: string | null;
}

export interface ClaudeProject {
  path: string;
  name: string;
  lastUsed: string | null;
  hasProfile: boolean;
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  lastActive: string;
  live: boolean;
  ticket: { id: string; title: string } | null;
}
