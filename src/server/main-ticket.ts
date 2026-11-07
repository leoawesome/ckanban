// Main tickets and tool tickets: pure decisions the board applies (Board in board.ts runs them).
// A main ticket is the conversation the user started: it talks, decides and keeps the feature's status, and never edits
// files. Tool tickets in its family (made by Claude, `tool: true`) explore, build, test and review, unattended, and
// report back to their parent as events and result cards.
import { familyState, groupSummary, hiddenTool, withYouTool, workingInFamily, type TicketKind } from "../../web/src/family";
import type { Plan, Ticket } from "./types";

/** Model and effort a tool ticket gets from its kind when create_ticket leaves them out. */
export const KIND_DEFAULTS: Record<TicketKind, { model: string; effort: string }> = {
  explore: { model: "claude-sonnet-5-5", effort: "medium" },
  test: { model: "claude-sonnet-5-5", effort: "medium" },
  review: { model: "claude-sonnet-5-5", effort: "medium" },
  build: { model: "claude-opus-5-5", effort: "medium" },
  fix: { model: "claude-opus-5-5", effort: "medium" },
  group: { model: "claude-sonnet-5-5", effort: "low" },
  round: { model: "claude-sonnet-5-5", effort: "low" },
  with_you: { model: "claude-sonnet-5-5", effort: "medium" },
};

export function kindDefaults(kind: string | null | undefined): { model: string; effort: string } | null {
  return kind && kind in KIND_DEFAULTS ? KIND_DEFAULTS[kind as TicketKind] : null;
}

/** merge_into_main tries before the tool ticket ends blocked. */
export const MERGE_TRIES = 3;
/** ask_ticket waits this long for an answer, then reports "no answer". */
export const ASK_TIMEOUT_MS = 5 * 60_000;
/** Result cards kept per ticket. */
export const RESULTS_KEEP = 60;
/** No-progress wakes in a row before a main ticket's plan is stuck. */
export const NO_PROGRESS_WAKES = 3;
/** The tool ticket's report, in its outputs folder. */
export const REPORT_FILE = "report.md";

/**
 * A ticket that runs a family of tool tickets with the plan engine: a main ticket, or a tool ticket that groups others
 * (kind group or round). Its runs may manage that family whoever started them.
 */
export function isManager(t: Pick<Ticket, "main" | "tool" | "kind"> | null | undefined): boolean {
  return !!t && (!!t.main || (!!t.tool && (t.kind === "group" || t.kind === "round")));
}

/** A plan the main-ticket engine runs (finished events, build limit and the no-progress rule). */
export function managedPlan(t: Pick<Ticket, "main" | "tool" | "kind">): boolean {
  return isManager(t);
}

/**
 * Whether a run's reply really asked the user something: an ask_questions form still open for it (openForm, the
 * session's unanswered form), or else a "?" in the last text the reply shows (the result line left out).
 */
export function replyAsked(openForm: readonly unknown[], lastText: string): boolean {
  if (openForm.length > 0) return true;
  return lastText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").includes("?");
}

/**
 * A main ticket whose plan is running that ended a reply with "questions" but asked nothing (replyAsked false): the
 * board treats it as "done", so the card doesn't say it needs the user. Tool tickets and with_you steps keep theirs.
 */
export function askedNothing(t: Pick<Ticket, "main" | "tool" | "plan">, status: string | undefined, asked: boolean): boolean {
  return status === "questions" && !!t.main && !t.tool && t.plan?.state === "running" && !asked;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The "finished" event a parent gets for a tool ticket's result. */
export function finishedLine(t: Pick<Ticket, "id" | "title" | "outcome" | "verdict" | "kind">, summary: string, report: string | null): string {
  const outcome = t.outcome === "needs_input" ? "questions" : t.outcome ?? "done";
  return `finished: ${t.id} "${t.title}"; outcome ${outcome}${t.kind === "test" && t.verdict ? `; verdict ${t.verdict}` : ""}; ` +
    `summary: ${clip(oneLine(summary) || "(none)", 1200)}; report: ${report ?? "no report"}`;
}

/** At most n sentences (ask_ticket's answers). */
export function sentences(text: string, n = 5): string {
  const flat = oneLine(text);
  const parts = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [flat];
  return clip(parts.slice(0, n).join("").trim(), 1500);
}

/**
 * The family table for a main ticket's wake, collapsed: only tool tickets that work, failed or wait, plus one row per
 * group ("Testing round 1: 6 done"). Finished ones are counted in the last line.
 */
export function wakeTable(kids: Ticket[], all: Ticket[], running: (id: string) => boolean): string {
  const lines: string[] = [];
  let finished = 0;
  for (const t of kids) {
    const own = all.filter((c) => c.parentId === t.id || c.partOf === t.id);
    if (own.length || t.kind === "group" || t.kind === "round") {
      const states = own.map((c) => ({ kind: c.kind, state: familyState({ ...c, running: running(c.id) } as any) }));
      const parts = [groupSummary(states)];
      const working = states.filter((s) => s.state === "working").length;
      const failed = states.filter((s) => s.state === "failed").length;
      if (working) parts.push(`${working} working`);
      if (failed) parts.push(`${failed} failed`);
      lines.push(`- ${t.id} ${t.title}: ${parts.join(", ")}${running(t.id) || t.status === "ready" || t.status === "in_progress" ? " (group working)" : ""}`);
      continue;
    }
    const state = familyState({ ...t, running: running(t.id) } as any);
    if (state === "done" || state === "passed" || state === "problem") {
      finished++;
      continue;
    }
    const why = t.outcome === "needs_input" ? "asking a question" : state === "waiting" ? (t.dependsOn?.length ? `waiting for ${t.dependsOn.join(", ")}` : "waiting to start") : state.replace("_", " ");
    lines.push(`- ${t.id} "${t.title}"${t.kind ? ` (${t.kind})` : ""}: ${why}`);
  }
  if (finished) lines.push(`- ${finished} other tool ticket${finished === 1 ? "" : "s"} finished (get_family lists them)`);
  return lines.length ? lines.join("\n") : "- (no tool tickets yet)";
}

/**
 * A main ticket's plan is about to wake it: count wakes in a row with nothing new in the family (sig: familySig of its
 * tool tickets). stuck: the plan has had NO_PROGRESS_WAKES of them.
 */
export function progressStep(plan: Pick<Plan, "progressSig" | "noProgress">, sig: string): { progressSig: string; noProgress: number; stuck: boolean } {
  const same = plan.progressSig != null && plan.progressSig === sig;
  const noProgress = same ? (plan.noProgress ?? 0) + 1 : 0;
  return { progressSig: sig, noProgress, stuck: noProgress >= NO_PROGRESS_WAKES };
}

// ---- The main ticket's card: one card per feature (tool tickets have none) ----

/** Refusal for notify_user in a tool ticket (with_you ones may ping the user). */
export const TOOL_NO_NOTIFY = "Tool tickets report to their main ticket; end your run with your question instead.";

const KIND_WORD: Partial<Record<TicketKind, string>> = { explore: "Explore", build: "Build", test: "Test", review: "Review", fix: "Fix" };

/** How the card names a step: its title, led by its kind unless the title already says it ("Test: checkout sign-in"). */
export function stepName(t: Pick<Ticket, "title" | "kind">): string {
  const word = t.kind ? KIND_WORD[t.kind] : undefined;
  if (!word || t.title.toLowerCase().startsWith(word.toLowerCase())) return t.title;
  return `${word}: ${t.title}`;
}

/** Why a tool ticket waits (it ended and only its main ticket or the user can move it on), or null. */
export interface StepWait {
  id: string;
  /** "Test: checkout sign-in asks a question" */
  label: string;
  attention: "questions" | "failed" | "blocked" | "limit";
  since: string;
  /** A "with you" step waiting for the user's answer: only the user moves it on, never the main ticket. */
  withYou?: true;
}

/**
 * A "with you" tool ticket waits for the user's answer (its run ended asking, and no answer is on its way). It talks
 * to the user in its main ticket's chat; the main ticket's card says "Needs you" meanwhile.
 */
export function youWaiting(t: Ticket, running: boolean): boolean {
  if (!withYouTool(t) || running || t.outcome !== "needs_input") return false;
  if (t.status === "done" || t.status === "ready" || t.status === "in_progress" || t.status === "backlog") return false;
  return !(t.queued?.length);
}

export function stepWait(t: Ticket, running: boolean): StepWait | null {
  if (youWaiting(t, running)) return { id: t.id, label: `${stepName(t)} needs you`, attention: "questions", since: t.runEndedAt ?? t.updatedAt, withYou: true };
  if (running || t.status === "done" || t.status === "ready" || t.status === "in_progress" || t.status === "backlog") return null;
  const since = t.runEndedAt ?? t.updatedAt;
  const at = (why: string, attention: StepWait["attention"]): StepWait => ({ id: t.id, label: `${stepName(t)} ${why}`, attention, since });
  if (t.outcome === "needs_input") return at("asks a question", "questions");
  // A failure says why in a few words (its error's last line), so the user needn't open the tool ticket.
  const why = (t.error ?? "").trim().split("\n").findLast((l) => l.trim())?.trim();
  if (t.outcome === "failed") return at(why ? `failed: ${clip(why, 80)}` : "failed", "failed");
  if (t.outcome === "blocked") return at(t.capHit ? `stopped at its $${t.capHit.capUsd.toFixed(2)} cap` : "is blocked", "blocked");
  if (t.outcome === "limit" && !t.limit?.auto) return at("hit the usage limit", "limit");
  return null;
}

/** The main card's working line: fail (red) for a failed step, warn for a step that needs the user, stuck or paused. */
export interface FamilyLine {
  text: string;
  tone: "work" | "warn" | "fail";
  /** Paused on a usage limit: when it resumes (the card adds "resumes at 15:00"). */
  until?: string | null;
}

/** What a main ticket's card shows of its family. */
export interface FamilyCard {
  /** Its tool tickets (hidden and with you). */
  tools: number;
  /** Its tool tickets that finished (Done): the card's "7 of 16 steps". */
  toolsDone: number;
  /** Its tool tickets not finished yet (anything not in Done, or still running): Backlog / Done ask first only then. */
  open: number;
  /** Titles of the tool tickets working or queued now (Stop's count: it stops tool tickets only). */
  running: string[];
  /**
   * Titles of every family ticket working or queued now: tool tickets and tickets the user added (the main ticket
   * itself left out). Non-empty: the card shows the working stripe and line (board.familyWorking moves it).
   */
  working: string[];
  /** What the whole family spent so far (main ticket included). */
  costUsd: number;
  line: FamilyLine | null;
  /** The oldest step waiting on a decision the main ticket hasn't made yet (or passes on to the user). */
  waiting: StepWait | null;
  /** "With you" steps waiting for the user's answer, oldest first: the card's "Needs you · n". */
  needsYou: StepWait[];
}

/**
 * The main card's summary. family: every ticket below the main one (familyOf order); all: the board, for groups'
 * children. The working line names the current step: one that needs the user, then failed or stuck, then paused, then
 * the most recently started working group or ticket ("Testing round 2: 4 of 6 done").
 */
export function familyCard(main: Ticket, family: Ticket[], all: Ticket[], running: (id: string) => boolean, costUsd: number): FamilyCard {
  const tools = family.filter((t) => t.tool);
  const startedAt = (t: Ticket) => t.runStartedAt ?? t.lastRunAt ?? t.updatedAt;
  // Any family ticket counts (tool tickets and tickets the user added), so the card never moves without a working line.
  const working = workingInFamily(family, main.id, (t) => running(t.id));
  const newestStart = working.reduce((m, t) => (startedAt(t) > m ? startedAt(t) : m), "");
  // Steps the main ticket hasn't seen yet (it ran before they ended), or any when it passes a question on to the user.
  const seenUntil = main.runEndedAt ?? "";
  const waits = tools.filter(hiddenTool).map((t) => stepWait(t, running(t.id))).filter((w): w is StepWait => !!w)
    .sort((a, b) => a.since.localeCompare(b.since));
  const mainAsks = !running(main.id) && (main.outcome === "needs_input" || main.outcome === "blocked" || main.plan?.state === "stuck");
  // A "with you" step waits for the user whatever the main ticket saw: only the user answers it.
  const needsYou = waits.filter((w) => w.withYou);
  const waiting = needsYou[0] ?? waits.find((w) => w.since > seenUntil) ?? (mainAsks ? waits[0] ?? null : null);
  let line: FamilyLine | null = null;
  const tone = (w: StepWait): FamilyLine["tone"] => (w.attention === "failed" ? "fail" : "warn");
  if (waiting) line = { text: waiting.label, tone: tone(waiting) };
  // In Done, or every step finished: the feature rests, so an old Stuck or Paused (the plan's, a usage limit's) is no
  // longer news. A step that still waits or failed above keeps its line.
  const resting = main.status === "done" || (tools.length > 0 && tools.every((t) => t.status === "done" && !running(t.id)));
  if (!line && !resting && main.plan?.state === "stuck") line = { text: `Stuck: ${clip(oneLine(main.plan.reason ?? "no progress"), 140)}`, tone: "warn" };
  if (!line) {
    const stalled = working.find((t) => t.stalled);
    if (stalled) line = { text: `Stuck: ${stepName(stalled)} has had no output for ${stalled.stalled!.minutes} min`, tone: "warn" };
  }
  if (!line) {
    // A failure the main ticket hasn't moved past: nothing started since it ended.
    const failed = waits.filter((w) => w.attention !== "questions" && w.since > newestStart).at(-1);
    if (failed) line = { text: failed.label, tone: tone(failed) };
  }
  if (!line && !resting) {
    const paused = tools.filter((t) => t.outcome === "limit" && t.limit?.auto && t.status !== "done" && !running(t.id))
      .sort((a, b) => a.limit!.resetAt.localeCompare(b.limit!.resetAt))[0];
    if (paused) line = { text: "Paused: usage limit", tone: "warn", until: paused.limit!.resetAt };
    else if (main.outcome === "limit" && main.limit?.auto && !running(main.id)) line = { text: "Paused: usage limit", tone: "warn", until: main.limit.resetAt };
  }
  // Stopped by the user: new steps wait until they act on it again (it must not look finished).
  if (!line && !resting && main.plan?.state === "paused") line = { text: "Paused: new tasks wait until you press Resume", tone: "warn" };
  if (!line && working.length) {
    const top = [...working].sort((a, b) => startedAt(b).localeCompare(startedAt(a)))[0];
    // The step's group (a level-1 group or round) speaks for it: "Testing round 2: 4 of 6 done".
    const isGroup = (g: Ticket) => g.kind === "group" || g.kind === "round";
    const group = isGroup(top) ? top : top.parentId && top.parentId !== main.id ? family.find((g) => g.id === top.parentId && isGroup(g)) : undefined;
    if (group) {
      const kids = all.filter((c) => c.parentId === group.id || c.partOf === group.id);
      line = { text: `${group.title}: ${groupSummary(kids.map((c) => ({ kind: c.kind, state: familyState({ ...c, running: running(c.id) } as any) })))}`, tone: "work" };
    } else line = { text: stepName(top), tone: "work" };
  }
  const open = tools.filter((t) => t.status !== "done" || running(t.id)).length;
  return {
    tools: tools.length, open, toolsDone: tools.filter((t) => t.status === "done").length,
    running: working.filter((t) => t.tool).map((t) => stepName(t)), working: working.map((t) => stepName(t)), costUsd, line, waiting, needsYou,
  };
}
