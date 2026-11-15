// Huddle types, limits and helpers (split from huddle.ts; huddle.ts re-exports them).
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeSessionFile } from "../board/board";
import { parseSession, type SessionEntry } from "../runs/session";
import { branchExists, removeWorktree, run as git, worktreeDir } from "../runs/git";
import { LEGACY_SUMMARY_FILE, MAIN_HANDLE, summaryFile, USER_HANDLE } from "./huddle-roster";
import { type LessonInput } from "./huddle-notes";
import { type HuddleTemplate } from "./huddle-templates";
import { type RunHandle } from "../runs/runner";
import { type SquadProposal } from "./squad";
import type { HandIn, Huddle, HuddleFinding, HuddleMessage, HuddleParticipant, Profile, Ticket } from "../core/types";

export class HuddleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Most message text one wake hands a session. Normally every unread message goes in whole; only a session that slept
 * through far more than this gets the newest ones that fit, the older ones left to huddle_read, so one huge digest
 * doesn't make it compress its own memory.
 */
export const DIGEST_MAX_CHARS = 100_000;

/** The newest unread messages whose text fits in DIGEST_MAX_CHARS (always at least the newest one). */
export function digestWindow<M extends { text: string }>(unread: M[], max = DIGEST_MAX_CHARS): M[] {
  let total = 0;
  let i = unread.length;
  while (i > 0 && (i === unread.length || total + unread[i - 1].text.length <= max)) total += unread[--i].text.length;
  return unread.slice(i);
}

/** Longest message anyone can post: longer reports go in a file. */
export const POST_MAX = 2000;
/** Longest pinned brief. */
export const BRIEF_MAX = 8000;
/** A finding's title as system lines show it (the findings list has the whole text). */
const FINDING_TITLE = 100;
export const ACTIVITY_THROTTLE_MS = 1000;
export const DEFAULT_MAX_COST_USD = 20;
/** Most an auto huddle (start_huddle) may ask for; a run asking for more gets this. */
export const AUTO_MAX_COST_USD = 100;
export const BUDGET_WARN = 0.8;
/** Teammates one agent may have waiting for the user's review at once. */
export const MAX_PENDING_TEAMMATES = 2;
/** A live huddle with nobody working and nothing owed for this long wakes @main (see idleSweep). */
export const HUDDLE_IDLE_MS = 5 * 60_000;
/** How often the idle watchdog looks at the open huddles. */
export const IDLE_SWEEP_MS = 30_000;

/** What the huddle spent so far: every participant's runs (agents) and huddle replies (@main and invited tickets). */
export const huddleCost = (h: Huddle) => h.participants.reduce((s, p) => s + (p.costUsd ?? 0), 0);

/** What one huddle's teammates (its agents) spent, for the host ticket's cost. */
export interface HuddleTeammateSpend {
  id: string;
  status: Huddle["status"];
  createdAt: string;
  costUsd: number;
  teammates: { handle: string; role: string; costUsd: number }[];
}

/**
 * What the agents of a ticket's huddles spent: it counts on the host ticket's card and Usage tab. Ticket sessions
 * (@main, invited tickets) are left out, their huddle replies are runs of their own ticket and counted there.
 */
export function teammateSpend(huddles: readonly Huddle[], ticketId: string): { costUsd: number; huddles: HuddleTeammateSpend[] } {
  const out: HuddleTeammateSpend[] = [];
  for (const h of huddles) {
    if (h.hostTicket !== ticketId) continue;
    const teammates = h.participants
      .filter((p) => p.kind === "agent" && (p.costUsd ?? 0) > 0)
      .map((p) => ({ handle: p.handle, role: p.role, costUsd: p.costUsd ?? 0 }));
    if (teammates.length) out.push({ id: h.id, status: h.status, createdAt: h.createdAt, costUsd: teammates.reduce((a, t) => a + t.costUsd, 0), teammates });
  }
  return { costUsd: out.reduce((a, h) => a + h.costUsd, 0), huddles: out };
}

/** A participant's cost after a result line reporting its session's running total. */
export function costAfter(p: HuddleParticipant | undefined, total: number): Pick<HuddleParticipant, "costUsd" | "sessionCostUsd"> {
  const prev = p?.sessionCostUsd ?? 0;
  return { costUsd: (p?.costUsd ?? 0) + (total >= prev ? total - prev : total), sessionCostUsd: total };
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export type ParticipantView = Omit<HuddleParticipant, "token"> & {
  running: boolean;
  /** Estimated cost of the turn it is in now, not yet in costUsd (≈, priced from the turn's messages). */
  liveCostUsd?: number;
};
/**
 * quiet: live, nobody working, no unanswered tags and no open findings (a sign it can be wrapped up);
 * idleSince: when the last message or turn was. forYou: messages tagging @you since the user last posted or acted
 * (forYouSince: that seq), plus the learnings waiting for the user's review (learningsPending).
 */
export type HuddleView = Omit<Huddle, "participants"> & {
  participants: ParticipantView[]; hostTitle: string | null; quiet: boolean; idleSince: string | null; forYou: number; forYouSince: number;
  learningsPending: number;
  /** The huddle's summary, relative to the host ticket's outputs folder; null while there is none. */
  summary: string | null;
};

/** Teammates and squads agents proposed, waiting for the user (lessons no longer wait: they go to the board's pile, learner.ts). */
export const pendingLearnings = (h: Huddle) => (h.learnings ?? []).filter((l) => l.status === "pending" && (!!l.teammate || !!l.squad));

/** What "Save as squad…" returns: the card (null when the call failed, with error), and the huddle's setup as it was. */
export interface GenericSquadResult {
  proposal: SquadProposal | null;
  error: string | null;
  /** The roster as it was (nothing made generic), for the filled-in editor. */
  setup: HuddleTemplate;
  costUsd: number;
}

/** The seq the user has seen up to: their last post or action (Stop, Resume, restart…). */
export function userSeenSeq(h: Huddle, msgs: readonly HuddleMessage[]): number {
  const me = h.participants.find((p) => p.handle === USER_HANDLE);
  const posted = msgs.findLast((m) => m.from === USER_HANDLE)?.seq ?? 0;
  return Math.max(me?.cursor ?? 0, posted);
}

/** A message that needs the user: it tags @you (brake and close-request system lines included) after `since`. */
export const isForYou = (m: HuddleMessage, since: number) => m.seq > since && m.from !== USER_HANDLE && m.mentions.includes(USER_HANDLE);

export { LEGACY_SUMMARY_FILE, summaryFile };

/**
 * The summary the board writes itself when a huddle closed without one and @main can't write it: the brief, the
 * roster with costs, the findings, each lead's last message and the output files the messages mention.
 */
export function fallbackSummary(h: Huddle, msgs: readonly HuddleMessage[], outputs: string[]): string {
  const span = `${h.createdAt.slice(0, 16).replace("T", " ")}${h.closedAt ? ` to ${h.closedAt.slice(0, 16).replace("T", " ")}` : ""} UTC`;
  const agents = h.participants.filter((p) => p.kind !== "human");
  const leads = agents.filter((p) => p.lead || p.handle === MAIN_HANDLE);
  const last = leads.map((p) => ({ p, m: msgs.findLast((m) => m.from === p.handle && m.kind !== "system") })).filter((x) => x.m);
  const said = msgs.map((m) => m.text).join("\n");
  const mine = summaryFile(h.id);
  const mentioned = new Set(outputs.filter((f) => f !== mine && said.includes(f)));
  for (const m of said.matchAll(/outputs\/([\w.\/-]+\.\w+)/g)) if (m[1] !== mine) mentioned.add(m[1]);
  const finding = (f: HuddleFinding) =>
    `- [${f.status === "resolved" ? "x" : " "}] ${f.text.replace(/\s*\n\s*/g, " ")} (pinned by @${f.by}${f.resolvedBy ? `, resolved by @${f.resolvedBy}` : ""})`;
  return [
    "# Huddle summary",
    "",
    `_Written by the board: huddle ${h.id} closed without a summary. ${span}, ${h.seq} messages, ${money(huddleCost(h))} spent._`,
    "",
    "## Brief",
    "",
    h.brief?.text.trim() || "No brief was pinned.",
    "",
    "## Participants",
    "",
    ...(agents.length ? agents.map((p) => `- @${p.handle}: ${p.role}${p.lead ? " (lead)" : ""} · ${p.status} · ${money(p.costUsd ?? 0)}`) : ["None."]),
    "",
    "## Findings",
    "",
    ...(h.findings.length ? h.findings.map(finding) : ["None pinned."]),
    "",
    ...(h.handIns?.length ? [
      "## Changes handed in",
      "",
      ...h.handIns.map((x) => `- ${x.id} from @${x.from}: ${x.summary} (${handInFiles(x.files)}): ${x.status}${x.by ? ` by @${x.by}` : ""}${x.reason ? ` (${x.reason})` : ""}`),
      "",
    ] : []),
    "## Last word from the leads",
    "",
    ...(last.length ? last.flatMap(({ p, m }) => [`### @${p.handle} (#${m!.seq})`, "", m!.text.trim(), ""]) : ["No lead posted.", ""]),
    "## Output files mentioned",
    "",
    ...(mentioned.size ? [...mentioned].sort().map((f) => `- ${f}`) : ["None."]),
    "",
  ].join("\n");
}

/** Who is calling, from the request: a board run's ticket (RUN_HEADER) and a huddle agent (HUDDLE_HEADER). Neither: the user. */
export interface Caller {
  run?: string | null;
  agent?: string | null;
}

export interface HuddleOptions {
  claudeBin: string;
  /** How long a monitor-mode session stays open between turns (default 30 min). */
  idleMs?: number;
  sessionExists?: (sessionId: string) => boolean;
  /**
   * Lessons an agent proposed when it turned done, with the role they would go to: they go to the board's pile of
   * lessons (learner.ts), not to the user, and are saved once they come back. Without it they are dropped.
   */
  learn?: (slug: string, h: Huddle, p: HuddleParticipant, role: string, lessons: LessonInput[]) => void;
  /** The ticket's chat, for the plan a plan review checks (default: its session file, parsed). */
  entries?: (t: Ticket) => SessionEntry[];
}

/** A ticket's chat entries read straight from its session file; [] when it has none. */
export function sessionEntries(t: Ticket): SessionEntry[] {
  const f = t.sessionId ? claudeSessionFile(t.sessionId) : null;
  return f ? parseSession(readFileSync(f, "utf8")).entries : [];
}

export interface AgentRun {
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Between Claude's result and its next turn. */
  idle: boolean;
  /** Monitor: messages came in mid-turn; they go in at the next turn boundary. */
  pending: boolean;
  /** Messages came in after input closed: deliver them in a new run once this one ends. */
  again: boolean;
  stopRequested: boolean;
  /** Snapshot agent between turns: its worktree is being reset (refreshing), or was reset for the next wake (fresh). */
  refreshing?: Promise<void> | null;
  fresh?: boolean;
  /** Estimated cost of the turn in progress by assistant message id (its result line gives the exact total). */
  turn?: Map<string, number>;
  /** Its conversation's size at the latest assistant message (saved as contextTokens with the next activity write). */
  ctx?: number;
}

export const isCoordinator = (h: Huddle, p: HuddleParticipant) => p.kind === "ticket-main" && p.ticketId === h.hostTicket;
export const canManage = (h: Huddle, p: HuddleParticipant) => p.kind === "human" || isCoordinator(h, p) || p.lead;
/** A read-only agent in the shared workspace: it works in a detached snapshot of the host's HEAD. */
/** A Done host's huddle started before the host last moved to Done (or the move's time isn't known) ends with it. */
export const endedByDone = (h: Pick<Huddle, "createdAt">, t: Pick<Ticket, "doneAt">) => !t.doneAt || h.createdAt <= t.doneAt;

/** closeForTicket's default reason: the host ticket is gone, so nobody writes a summary. */
export const DELETED = "the host ticket was deleted";

/** The queued message asking @main for a closed huddle's summary. */
export const summaryAsk = (h: Huddle, file: string) =>
  `Huddle ${h.id} was closed without a summary. Write it to ${file}: what was decided, the findings and their state, what is left to do. ` +
  "The huddle is closed, so don't post there; just write the file and end your turn.";

export const isSnapshot = (p: HuddleParticipant) => p.kind === "agent" && p.workspace === "shared" && !p.canEdit;
/** done / blocked: set by the participant itself; its runs' turns ending don't change it. */
export const settled = (p: HuddleParticipant | undefined) => p?.status === "done" || p?.status === "blocked";


export type StatusChange = "done" | "blocked" | "active";

/** Longest one-line summary of a hand-in. */
export const HANDIN_SUMMARY_MAX = 300;

/** A hand-in's files in plain words: "changed logo.png, added styles/new.css, removed old.txt" (the first 20). */
export function handInFiles(files: HandIn["files"], max = 20): string {
  const shown = files.slice(0, max).map((f) => `${f.change} ${f.path}`).join(", ");
  return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}

/** A finding's first line, cut to FINDING_TITLE characters. */
export function findingTitle(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > FINDING_TITLE ? `${line.slice(0, FINDING_TITLE - 1).trimEnd()}…` : line;
}

/** An agent's own or snapshot worktree: next to the board's worktree folder, so its startup sweep (one folder per ticket id) leaves it alone. */
export function agentDir(profile: Profile, h: Huddle, p: HuddleParticipant): string {
  return join(dirname(worktreeDir(profile, h.hostTicket)), `${h.hostTicket}.huddle`, p.handle);
}

/** The main checkout of the repo `dir` belongs to (the host's folder may be one of its worktrees, which can go away first). */
export async function mainRepo(dir: string): Promise<string> {
  const common = (await git(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], dir)).stdout.trim();
  return common && basename(common) === ".git" ? dirname(common) : dir;
}

/** Remove an agent's own worktree and branch; the reason it was kept instead, or null once removed. */
export async function removeOwnWorktree(repo: string, dir: string, branch: string | null, base: string): Promise<string | null> {
  const hasBranch = !!branch && (await branchExists(repo, branch));
  if (hasBranch) {
    const ahead = await git(["git", "rev-list", "--count", `${base}..${branch}`], repo);
    if (ahead.code !== 0) return `couldn't compare it with ${base}: ${ahead.stderr.trim()}`;
    const n = Number(ahead.stdout.trim());
    if (n > 0) return `${n} commit${n === 1 ? "" : "s"} not on ${base}`;
  }
  const r = await removeWorktree(repo, dir);
  if (!r.removed) return r.reason ?? "couldn't remove it";
  if (hasBranch) await git(["git", "branch", "-D", branch!], repo);
  return null;
}
