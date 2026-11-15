import { copy } from "../request";

/** Where a teammate or template is saved (src/server/layers.ts): built-in, for every board (global) or this board. */
export type LayerSource = "builtin" | "global" | "board";
/** A saved level. */
export type Level = "global" | "board";

export interface LayerInfo {
  /** The level whose version is in effect. */
  source: LayerSource;
  /** The version Reset falls back to; null: deleting removes it. */
  base: LayerSource | null;
  /** The name is a built-in. */
  builtin: boolean;
}

/** A huddle role preset, a "teammate" in the UI (src/server/huddle-presets.ts). */
export interface HuddlePreset extends LayerInfo {
  name: string;
  role: string;
  prompt: string;
  model: string | null;
  mode: "tagged" | "monitor";
  lead: boolean;
  canEdit: boolean;
  workspace: "shared" | "own";
}

/** A teammate Claude proposed (src/server/teammate-proposal.ts): fields it left out keep an existing teammate's values. */
export type TeammateProposal = Pick<HuddlePreset, "name" | "prompt"> & Partial<Pick<HuddlePreset, "role" | "model" | "mode" | "lead" | "canEdit" | "workspace">> & { why: string };

export interface TeammateCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: Level;
  at: string;
}

/** A whole-huddle template (src/server/huddle-templates.ts): a roster and its rules. */
export interface HuddleTemplate extends LayerInfo {
  name: string;
  label: string;
  description: string;
  roster: RosterEntry[];
  /** Rounds of discussion before the lead wraps up; null: no limit. */
  rounds: number | null;
  /** Budget in USD; null: the default. */
  maxCostUsd: number | null;
  /** Report format ("" for none). */
  report: string;
  /** The host's process rules ("" for none; older daemons leave it out). */
  hostRules?: string;
}

/** A squad's fields (a template without its level info), as cards carry and the save route takes. */
export type SquadDraft = Omit<HuddleTemplate, keyof LayerInfo>;

/** A squad card's data (src/server/squad.ts): from propose_squad or "Save as squad…". */
export interface SquadProposal {
  squad: SquadDraft & { hostRules: string };
  /** One line: why this squad, or where it came from. */
  why: string;
  /**
   * People with no preset, by roster index: saving saves each as a teammate `name` at the same scope, unless a
   * teammate of that name exists (then it is used as is). Check the board's teammates to mark the new ones.
   */
  newTeammates: { index: number; name: string; role: string }[];
}

/** What the user did with a squad card. */
export interface SquadCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: Level;
  /** Teammates the save made, and existing ones it used as they are. */
  teammates?: { created: string[]; reused: string[] };
  at: string;
}

/** "Save as squad…" (POST .../huddles/:id/generic-squad): the card, or the error and the setup for the filled-in editor. */
export interface GenericSquadResult {
  proposal: SquadProposal | null;
  error: string | null;
  /** The huddle's roster as it was (nothing made generic). */
  setup: SquadDraft & { hostRules: string };
  costUsd: number;
}

/** Where a saved squad card goes: a ticket chat's card, or a huddle agent's proposal under Learnings. */
export type SquadCardRef = { ticketId: string; uuid: string } | { huddleId: string; learningId: string };

/** One line of a huddle roster (src/server/huddle-roster.ts): `count` participants from a preset or a free-form role. */
export interface RosterEntry {
  preset?: string;
  role?: string;
  count?: number;
  focus?: string;
  model?: string | null;
  mode?: HuddleMode;
  workspace?: "shared" | "own";
  lead?: boolean;
  canEdit?: boolean;
  handle?: string;
  /** Runs the huddle instead of @main (one entry, count 1; made a lead). */
  host?: boolean;
  prompt?: string;
}

export type HuddleMode = "tagged" | "monitor";

/** A huddle participant as the daemon shows it (src/server/huddle.ts ParticipantView). */
export interface HuddleParticipant {
  handle: string;
  role: string;
  preset: string | null;
  focus?: string;
  model: string | null;
  mode: HuddleMode;
  lead: boolean;
  canEdit: boolean;
  workspace: "shared" | "own";
  /** done: finished its job (only a lead, @main or the user wakes it). blocked: waiting on something (statusReason). */
  status: "working" | "idle" | "stopped" | "failed" | "done" | "blocked";
  statusReason?: string | null;
  kind: "agent" | "ticket-main" | "human";
  ticketId?: string | null;
  joinedAt: string;
  lastActivity?: string | null;
  costUsd?: number;
  /** ≈ cost of the turn it is in now, not yet in costUsd. */
  liveCostUsd?: number;
  /** Its conversation's size at its latest step (tokens Claude re-reads every step). */
  contextTokens?: number;
  error?: string | null;
  running: boolean;
  /** Read-only agent: the host branch and commit its snapshot shows. */
  snapshot?: { branch: string | null; sha: string } | null;
  sessionId?: string | null;
  /** May change files: its own copy of the ticket's folder, once made. */
  copy?: { kind: "git" | "folder"; dir: string; at: string } | null;
}

/** Changes a helper handed in from its copy (src/server/types.ts HandIn). */
export interface HandIn {
  id: string;
  from: string;
  summary: string;
  files: { path: string; change: "added" | "changed" | "removed" }[];
  status: "waiting" | "accepted" | "rejected" | "conflict";
  at: string;
  by?: string | null;
  decidedAt?: string | null;
  reason?: string | null;
  conflicts?: string[];
}

/** One step of a huddle participant's session (src/server/huddle-session.ts SessionStep). */
export interface SessionStep {
  i: number;
  kind: "text" | "tool" | "post" | "wake";
  text: string;
  at: string | null;
  id?: string;
  out?: string;
  error?: true;
  pending?: true;
  seq?: number;
}

/** A participant's own session for the read-only viewer (src/server/huddle-session.ts ParticipantSession). */
export interface ParticipantSession {
  handle: string;
  kind: HuddleParticipant["kind"];
  role: string;
  model: string | null;
  mode: HuddleMode;
  status: HuddleParticipant["status"];
  live: boolean;
  costUsd: number;
  sessionId: string | null;
  snapshot: { branch: string | null; sha: string } | null;
  ticketId: string | null;
  file: string | null;
  steps: SessionStep[];
  total: number;
  hasMore: boolean;
  current: number | null;
}

export interface HuddleFinding {
  id: string;
  text: string;
  by: string;
  status: "open" | "resolved";
  resolvedBy: string | null;
  at: string;
}

export interface Huddle {
  id: string;
  hostTicket: string;
  hostTitle: string | null;
  status: "live" | "stopped" | "closed";
  maxParticipants: number;
  participants: HuddleParticipant[];
  findings: HuddleFinding[];
  invited: string[];
  /** Highest message seq so far (the message count). */
  seq: number;
  /** Spending limit; the huddle stops when it is spent (default 20). */
  maxCostUsd?: number;
  /** Why it stopped by itself: budget spent, message limit, or too long without the user (routing paused). */
  stopReason?: "budget" | "messages" | "loop" | null;
  /** The budget stopped it after its work was finished: Close is the next step, not Resume. */
  finishedAtStop?: boolean;
  /** @main or a lead asked the user to close the huddle (its summary is in the host's outputs). */
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** The lead that runs the huddle instead of @main (it gets the idle nudges, notes and hand-ins); null: @main runs it. */
  host?: string | null;
  /** Live, nobody working, no unanswered tags, no open findings; idleSince: the last message or turn. */
  quiet?: boolean;
  idleSince?: string | null;
  /** Messages tagging @you since the user last posted, acted (Stop, Resume…) or viewed the latest message; forYouSince: that seq. */
  forYou?: number;
  forYouSince?: number;
  /** Pinned brief (goal, decisions) at the head of every digest. */
  brief?: { text: string; by: string; at: string } | null;
  /** Squad (template) it was started from. */
  template?: string | null;
  /** What it was started on (a squad's topic), and the squad's host rules then. */
  topic?: string | null;
  hostRules?: string | null;
  /** Lessons agents proposed when they turned done; only the user saves them as role notes. */
  learnings?: HuddleLearning[];
  /** Learnings waiting for review (they count in forYou). */
  learningsPending?: number;
  /** Changes helpers handed in, oldest first. */
  handIns?: HandIn[];
  /** Its summary, relative to the host ticket's outputs folder (huddles/<id>/summary.md, or the older huddle-summary.md); null while there is none. */
  summary?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

/** A lesson an agent proposed (src/server/types.ts). target: "_all", a preset name, or "new" (a preset from the ad-hoc role). */
export interface HuddleLearning {
  id: string;
  from: string;
  role: string;
  preset: string | null;
  text: string;
  evidence: string;
  scope: "general" | "repo";
  status: "pending" | "saved" | "discarded";
  target: string;
  at: string;
  newRole?: boolean;
  /** A teammate the agent proposed instead of a lesson (text: its why; scope general: all boards, repo: this board). */
  teammate?: TeammateProposal;
  /** A squad the agent proposed (propose_squad; text: its why). Save it with api.saveSquad and card { huddleId, learningId }, or discardLearning. */
  squad?: SquadProposal;
}

/** A role note (src/server/huddle-notes.ts): by "you" or the agent's handle. */
export interface HuddleNote {
  text: string;
  by: string;
  date: string | null;
  huddle: string | null;
}

export type HuddleNotes = Record<string, { general: HuddleNote[]; repo: HuddleNote[] }>;

export interface HuddleMessage {
  id: string;
  seq: number;
  ts: string;
  from: string;
  text: string;
  mentions: string[];
  kind: "message" | "finding" | "system" | "handin";
  /** Where a post came in from: the board UI, the MCP server/CLI, or a request with neither header. */
  source?: "ui" | "mcp" | "none";
  /** kind handin: the hand-in it shows. */
  handIn?: string;
}
