import { existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isGitRepo, listWorktrees, worktreeDir } from "../runs/git";
import { STUCK_ON_QUESTIONS } from "../server/attention";
import type { Question } from "../runs/session";
import { askClosed, linkProblem, parentLink, withYouTool } from "../../web/src/features/family/family";
import { familySig } from "./feature";
import { mainWakePrompt } from "../runs/prompts";
import { isManager, managedPlan, progressStep, RESULTS_KEEP, wakeTable } from "./main-ticket";
import { orchestratorPrompt, type PlanWake } from "../runs/prompts";
import { childrenOf, isComplete, MAX_RUN_RETURNS, RUN_CHAIN_KEEP, planActive, planProblem, planStep, planTable, wakeupCap } from "./plan";
import { run as runCmd } from "../runs/git";
import { type ResultCard, type Plan, type SelfMove, type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { TELEGRAM_KEEP, ConflictError, sameJson } from "./board-types";

/** Start (or resume) the planner's plan: children switch to auto mode and start in dependency order. */
export function startPlan(this: Board, slug: string, id: string, opts: { byPlanner?: boolean; why?: string } = {}): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const kids = childrenOf(this.store.listTickets(slug), id);
  const problem = planProblem(kids);
  if (problem) throw new Error(`can't start the plan: ${problem}`);
  const prev = t.plan;
  const resuming = prev && prev.state !== "done";
  const plan: Plan = resuming
    ? {
      ...prev,
      state: prev.awaiting === "final" || prev.state === "finishing" ? "finishing" : "running",
      reason: null,
      // A stuck plan starts fresh: its last wake-up is over and the planner looks at every open child again.
      ...(prev.state === "stuck" ? { wakeups: 0, awaiting: null, seen: {} } : {}),
    }
    : { state: "running", wakeups: 0, startedAt: nowIso(), originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null };
  // Unattended: children must not stop to interview the user.
  for (const k of kids) if (k.status === "backlog" && k.mode !== "auto") this.patch(slug, k.id, { mode: "auto" });
  const out = this.patch(slug, id, { plan, ...(t.outcome && t.outcome !== "done" ? { outcome: null } : {}) });
  const by = opts.byPlanner ? " by the planner" : "";
  this.store.addComment(slug, id, "ai", resuming ? `Plan resumed${by}${opts.why ? `: ${opts.why}` : ""}.` : `Plan started${by}: ${kids.length} child tickets; each starts as soon as the ones it waits for are done.`);
  this.advancePlans(slug);
  return this.store.getTicket(slug, id) ?? out;
}

/**
 * Stop on a main ticket pauses its plan only until the user acts on it again: moving it to ready (or In progress),
 * or writing or answering a form in its chat, resumes it (see updateTicket and chat). Any paused main ticket counts,
 * also ones paused before this rule existed. True when a paused plan resumed.
 */
export function resumeStoppedPlan(this: Board, slug: string, id: string, why: string): boolean {
  const t = this.store.getTicket(slug, id);
  if (!t?.main || t.plan?.state !== "paused") return false;
  try {
    this.startPlan(slug, id, { why });
    return true;
  } catch (e) {
    this.store.addComment(slug, id, "ai", `Couldn't resume the paused plan: ${(e as Error).message}`);
    return false;
  }
}

/**
 * A main ticket's own run made a new tool ticket while its card was parked in Done or Backlog: the user asked it for
 * this work, so the card goes back to Review and its plan runs the step (parked, it would sit in Backlog for good).
 * Only for the main ticket's own runs: a tool ticket making steps doesn't undo the user's park. True when it moved.
 */
export function unparkForNewStep(this: Board, slug: string, id: string): boolean {
  return this.unparkMain(slug, id, "it made a new step, so its steps run again");
}

/**
 * A main ticket parked in Done or Backlog goes back to Review (why: what brought it back, shown in a note). With
 * startedOnly, Backlog counts only once its family has started (a new main ticket in Backlog is still being shaped,
 * and goes to Planning as usual). True when it moved.
 */
export function unparkMain(this: Board, slug: string, id: string, why: string, startedOnly = false): boolean {
  const t = this.store.getTicket(slug, id);
  if (!t?.main || (t.status !== "done" && t.status !== "backlog")) return false;
  if (startedOnly && t.status === "backlog" && !t.plan) return false;
  const from = t.status === "done" ? "Done" : "Backlog";
  // patch, not updateTicket: a run of the main ticket may still be going and must not be stopped.
  this.patch(slug, id, { status: "review", reopenedFrom: null });
  this.store.addComment(slug, id, "ai", `Moved back from ${from}: ${why}.`);
  return true;
}

/**
 * The PR poller leaves a main ticket in Review instead of moving it to Done on a merged PR: while its steps are open
 * (Done would park them and its wake when they finish), and once it has been in Done before (the user or a step
 * brought it back, so only the user's own move parks it again).
 */
export function holdsReview(this: Board, slug: string, id: string): boolean {
  const t = this.store.getTicket(slug, id);
  return !!t?.main && (!!t.doneAt || this.openSteps(slug, id));
}

/** A main ticket's family still has tool tickets that aren't finished (waiting, running or needing the user). */
export function openSteps(this: Board, slug: string, id: string): boolean {
  const all = this.store.listTickets(slug);
  const todo = childrenOf(all, id);
  const seen = new Set<string>([id]);
  while (todo.length) {
    const k = todo.pop()!;
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    if (k.tool && (k.status !== "done" || this.isRunning(slug, k.id))) return true;
    todo.push(...childrenOf(all, k.id));
  }
  return false;
}

/** Pause: no new children start and the planner isn't woken; running children finish. */
export function pausePlan(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t?.plan) throw new Error("this ticket has no plan");
  if (t.plan.state === "done") return t;
  this.store.addComment(slug, id, "ai", "Plan paused.");
  return this.patch(slug, id, { plan: { ...t.plan, state: "paused" } });
}

/** Mark the plan done as it stands, without waking the planner (e.g. a stuck plan the user resolved by hand). */
export function markPlanDone(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t?.plan) throw new Error("this ticket has no plan");
  if (t.plan.state === "done") return t;
  return this.closePlan(slug, t, t.plan, "Plan marked done.");
}

/**
 * The ticket's current run works unattended on its own ticket (a Ready / In Progress run, a plan child, a schedule
 * run, or its auto huddle waking it), not a Planning chat, a reply to the user's message or to another ticket.
 */
export function unattendedRun(this: Board, slug: string, id: string): boolean {
  const r = this.runs.get(this.key(slug, id));
  if (!r || r.stopRequested) return false;
  if (!r.chat) return true;
  return !!r.chat.hostWake;
}

/** start_huddle in this run: false when the run already started an auto huddle (one per run). */
export function claimAutoHuddle(this: Board, slug: string, id: string): boolean {
  const r = this.runs.get(this.key(slug, id));
  if (!r || r.autoHuddleStarted) return false;
  r.autoHuddleStarted = true;
  return true;
}

/** Set or clear the ticket's auto huddle state (Huddles drives it). */
export function setAutoHuddle(this: Board, slug: string, id: string, autoHuddle: Ticket["autoHuddle"], extra: Partial<Ticket> = {}): Ticket | null {
  if (!this.store.getTicket(slug, id)) return null;
  return this.patch(slug, id, { autoHuddle, ...extra });
}

/** A stopped ticket no longer waits for an auto-huddle slot (a live auto huddle carries on; the user closes it). */
export function dropAutoWait(this: Board, slug: string, id: string): Partial<Ticket> {
  return this.store.getTicket(slug, id)?.autoHuddle?.state === "waiting" ? { autoHuddle: null } : {};
}

/** The ticket's current run answers a message the user typed in its chat (see ActiveRun.chat.user). */
export function userChatRun(this: Board, slug: string, id: string): boolean {
  return !!this.runs.get(this.key(slug, id))?.chat?.user;
}

/**
 * The ticket's own chat, answering the user's own words (userAskedRun), asks to move its card: the board moves it
 * once the run ends, so the reply isn't cut off. False when the run doesn't answer the user.
 */
export function requestSelfMove(this: Board, slug: string, id: string, status: SelfMove): boolean {
  const run = this.runs.get(this.key(slug, id));
  if (!run || !this.userAskedRun(slug, id)) return false;
  run.selfMove = status;
  return true;
}

/**
 * The ticket's current run acts on the user's own words: it answers a message the user typed in its chat (not a
 * slash command), or the user typed one that was handed to it while it worked. Peer messages, planner messages,
 * huddle wakes and follow-ups don't count. start_huddle with trigger "user" needs this.
 */
export function userAskedRun(this: Board, slug: string, id: string): boolean {
  const r = this.runs.get(this.key(slug, id));
  if (!r || r.stopRequested) return false;
  return (!!r.chat?.user && !r.chat.slash) || !!r.userSteered;
}

/**
 * The planner ticket a run belongs to, if that run may manage the ticket's own children: any run of a running
 * plan (wake-ups), or a reply to the user's chat message in any plan state, so the user can still tidy up a finished
 * plan's children (e.g. mark them done). Restarting a done plan stays refused (see plan_control in http.ts).
 */
export function plannerRights(this: Board, slug: string, runTicketId: string): Ticket | null {
  const t = this.store.getTicket(slug, runTicketId);
  if (!t) return null;
  // A main ticket (or a tool group) manages its own family in every run, whoever started it; not in a quiet reply.
  if (isManager(t)) {
    const r = this.runs.get(this.key(slug, runTicketId));
    if (r && !r.stopRequested && !r.chat?.quiet) return t;
  }
  if (planActive(t.plan)) return t;
  return this.userChatRun(slug, runTicketId) ? t : null;
}

/**
 * The ticket whose Planning chat (refine mode) is answering a message the user typed: that reply may manage
 * other tickets on the board for the user (see plannerFor in http.ts). Plan wake-ups and peer replies don't count.
 */
export function userRequestRights(this: Board, slug: string, runTicketId: string): Ticket | null {
  const chat = this.runs.get(this.key(slug, runTicketId))?.chat;
  return chat?.mode === "refine" && chat.user ? this.store.getTicket(slug, runTicketId) ?? null : null;
}

/**
 * The ticket whose run may change other tickets on its board on its own (see runRights in http.ts): a work run or a
 * chat reply that acts on the ticket. Planning chats keep needing the user's message (userRequestRights), and a quiet
 * reply to another session (a peer run) gets nothing, so asking a ticket a question can't hand it a chain of runs.
 */
export function runnerRights(this: Board, slug: string, runTicketId: string): Ticket | null {
  const r = this.runs.get(this.key(slug, runTicketId));
  if (!r || r.stopRequested || r.chat?.mode === "refine" || r.chat?.quiet) return null;
  return this.store.getTicket(slug, runTicketId) ?? null;
}

/**
 * A run starts another ticket's run (targetId; null for a ticket it creates). No limit on how many or how deep; only
 * a loop is refused: the target already started this chain MAX_RUN_RETURNS times (A starts B, B starts A, ...), so
 * runs can't keep restarting each other with nobody watching. Returns what goes in the started ticket's startedBy.
 */
export function runStart(this: Board, slug: string, runTicketId: string, targetId: string | null = null): NonNullable<Ticket["startedBy"]> {
  const by = this.store.getTicket(slug, runTicketId)?.startedBy;
  const depth = (by?.depth ?? 0) + 1;
  const chain = [...(by?.chain ?? (by ? [by.ticketId] : [])), runTicketId].slice(-RUN_CHAIN_KEEP);
  if (targetId && chain.filter((x) => x === targetId).length >= MAX_RUN_RETURNS) {
    throw new Error(`${targetId} and this run keep starting each other (runs started by runs: ${chain.join(" → ")}): ` +
      "to stop an endless loop, this run can't start it again. Ask the user to start it on the board");
  }
  return { ticketId: runTicketId, depth, chain };
}

/** Who started the ticket's latest run: another ticket's run (runStart), or null when the user started it. */
/**
 * The user's reply from Telegram: the same as typing it in the ticket's chat (http.ts POST .../chat, as the user),
 * carrying its Telegram update so it is sent once. Returns false when that update was already sent.
 */
export async function chatFromTelegram(this: Board, slug: string, id: string, text: string, from: { updateId: number; tg: number; chatId: number; key?: string | null; still?: () => boolean }): Promise<boolean> {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (t.telegramIn?.some((m) => m.updateId === from.updateId) || t.queued?.some((m) => m.telegram?.updateId === from.updateId)) return false;
  const startedBy = this.isRunning(slug, id) ? undefined : null;
  const after = await this.chat(slug, id, text, { telegram: { updateId: from.updateId, tg: from.tg }, ...(from.still ? { still: from.still } : {}) });
  // Written before anything else can run: the queued message (which also carries the update) is still there.
  const at = nowIso();
  const now = this.store.getTicket(slug, id) ?? after;
  this.patch(slug, id, {
    telegramIn: [...(now.telegramIn ?? []), { updateId: from.updateId, tg: from.tg, chatId: from.chatId, at, text: text.slice(0, 2000), key: from.key ?? null }].slice(-TELEGRAM_KEEP),
    telegramReport: { tg: from.tg, chatId: from.chatId, at },
  });
  if (startedBy !== undefined) this.markStartedBy(slug, id, startedBy);
  if (!text.startsWith("/")) this.userReplied(slug, id);
  if (after.tool && !withYouTool(after)) this.noteUserMessage(slug, id, text);
  return true;
}

/**
 * Telegram stopped taking messages (Pause, /lock, Unpair): messages from Telegram that wait in a ticket's queue and
 * Claude hasn't been handed yet are dropped, so none of them reaches a ticket afterwards. Returns how many.
 */
export function dropTelegramQueued(this: Board): number {
  let dropped = 0;
  for (const p of this.store.listProfiles()) {
    for (const t of this.store.listTickets(p.slug)) {
      const run = this.runs.get(this.key(p.slug, t.id));
      const drop = (t.queued ?? []).filter((m) => m.telegram && !run?.inFlight.has(m.id) && run?.promptMsgId !== m.id);
      if (!drop.length) continue;
      this.dropQueued(p.slug, t.id, drop.map((m) => m.id));
      dropped += drop.length;
    }
  }
  return dropped;
}

/** Changes a ticket's Telegram marks (telegramIn / telegramOut / telegramReport) and tells the board UI. */
export function patchTelegram(this: Board, slug: string, id: string, patch: Pick<Partial<Ticket>, "telegramIn" | "telegramOut" | "telegramReport">): Ticket | null {
  if (!this.store.getTicket(slug, id)) return null;
  return this.patch(slug, id, patch);
}

export function markStartedBy(this: Board, slug: string, id: string, by: Ticket["startedBy"]): void {
  const t = this.store.getTicket(slug, id);
  if (!t || (!t.startedBy && !by)) return;
  this.patch(slug, id, { startedBy: by ?? null });
}

/**
 * Manager mode: make existing tickets children of this one, so its plan runs them. Tickets on another board, the
 * ticket itself or its ancestors (a cycle), tickets in another plan and finished ones are skipped with a reason.
 */
export function adoptTickets(this: Board, slug: string, plannerId: string, ids: string[]): { adopted: Ticket[]; skipped: { id: string; reason: string }[] } {
  const planner = this.store.getTicket(slug, plannerId);
  if (!planner) throw new Error(`ticket ${plannerId} not found`);
  const ancestors = new Set<string>();
  for (let p = planner.parentId; p && !ancestors.has(p); p = this.store.getTicket(slug, p)?.parentId) ancestors.add(p);
  const adopted: Ticket[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of [...new Set(ids.map((x) => x.trim()).filter(Boolean))]) {
    const t = this.store.getTicket(slug, id);
    const reason = !t ? `not found on board ${slug}`
      : t.id === plannerId ? "that is this ticket itself"
      : ancestors.has(t.id) ? "it is a parent of this ticket (that would make a cycle)"
      : t.parentId === plannerId ? "already in this plan"
      : t.parentId ? `belongs to plan ${t.parentId}`
      : t.status === "done" ? "already done"
      : t.error?.startsWith("corrupt") ? "its ticket file is corrupt"
      // A sub-feature keeps its own chat and tasks: a plan never takes it in (that would make it a normal ticket).
      : t.main && parentLink(t) ? `"${t.title}" is a sub-feature with its own chat and tasks; a plan can't take it in`
      : !t.partOf ? linkProblem(this.store.listTickets(slug), { id: t.id, title: t.title, main: false }, plannerId)
      : null;
    if (reason) {
      skipped.push({ id, reason });
      continue;
    }
    adopted.push(this.patch(slug, id, { parentId: plannerId, ...(t!.main ? { main: false } : {}) }));
    this.store.addComment(slug, id, "ai", `Adopted by plan ${plannerId} ("${planner.title}").`);
  }
  if (adopted.length) {
    this.store.addComment(slug, plannerId, "ai", `Adopted ${adopted.length} ticket${adopted.length === 1 ? "" : "s"}: ${adopted.map((t) => `${t.id} "${t.title}"`).join(", ")}.`);
    const p = this.store.getTicket(slug, plannerId)!;
    // A plan under way grows with its new children: its create cap and wake-up budget count them.
    if (p.plan && p.plan.state !== "done") this.patch(slug, plannerId, { plan: { ...p.plan, originalCount: p.plan.originalCount + adopted.length } });
    else this.emitTicket(slug, p);
    this.advancePlans(slug);
  }
  return { adopted, skipped };
}

/** The planner restarts a child that already ran: counted, and refused past MAX_RETRIES. */
export function countRetry(this: Board, slug: string, plannerId: string, childId: string, max: number): void {
  const p = this.store.getTicket(slug, plannerId);
  if (!p?.plan) return;
  const n = (p.plan.retries?.[childId] ?? 0) + 1;
  if (n > max) throw new Error(`retry limit reached: ${childId} was already restarted ${max} times; skip or split it, or end with "blocked" for the user`);
  this.patch(slug, plannerId, { plan: { ...p.plan, retries: { ...p.plan.retries, [childId]: n } } });
}

/** Move every running plan on the board forward. Cheap and idempotent: call it after any change. */
export function advancePlans(this: Board, slug: string): void {
  if (this.shuttingDown || this.restartPending) return;
  if (this.advancing.has(slug)) {
    this.advanceAgain.add(slug);
    return;
  }
  this.advancing.add(slug);
  try {
    do {
      this.advanceAgain.delete(slug);
      const all = this.store.listTickets(slug);
      let started = false;
      for (const p of all) {
        if (!p.plan || p.plan.state === "done" || p.plan.state === "paused") continue;
        try {
          started = this.advancePlan(slug, p, childrenOf(all, p.id)) || started;
        } catch (e) {
          console.error(`plan ${slug}/${p.id}:`, e);
        }
      }
      if (started) this.dispatch(slug);
    } while (this.advanceAgain.has(slug));
  } finally {
    this.advancing.delete(slug);
  }
}

/** One plan; true when it moved children to Ready. */
export function advancePlan(this: Board, slug: string, planner: Ticket, kids: Ticket[]): boolean {
  let plan = { ...planner.plan! };
  const plannerBusy = this.isRunning(slug, planner.id);
  // The planner's last wake-up has finished: its outcome decides whether we go on.
  if (plan.awaiting && !plannerBusy) {
    const o = planner.outcome;
    // Waiting for a usage limit to reset: the planner's automatic continue picks the wake-up up again.
    if (o === "limit" && planner.limit?.auto) return false;
    if (o === "limit") {
      this.stuck(slug, planner, plan, "the run that plans the steps hit the usage limit");
      return false;
    }
    if (o === "blocked" || o === "needs_input" || o === "failed" || o === "stopped") {
      this.stuck(slug, planner, plan, o === "needs_input" ? STUCK_ON_QUESTIONS : `the run that plans the steps ${o === "blocked" ? "is blocked" : o}`);
      return false;
    }
    if (plan.awaiting === "final") {
      this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, finishedAt: nowIso() } });
      this.store.addComment(slug, planner.id, "ai", "Plan done: all child tickets finished and the final check ran.");
      this.notify(`Plan done: ${planner.title}`, "All child tickets finished. Summary in the ticket's outputs.", slug, planner.id);
      return false;
    }
    plan.awaiting = null;
  }
  if (plan.state === "stuck" && !planner.main) {
    // Whatever made it stuck is gone once every child is finished (e.g. its last PR got merged): close it, no run needed.
    if (kids.length && kids.every(isComplete)) this.closePlan(slug, planner, plan, "Plan done: every child ticket finished, so the stuck plan was closed without another run.");
    return false;
  }
  if (plan.state === "finishing") {
    if (!plan.awaiting && !plannerBusy) this.wake(slug, planner, plan, "final", [], kids);
    else if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
    return false;
  }
  const managed = managedPlan(planner);
  const step = planStep(plan, kids, (id) => this.isRunning(slug, id), {
    waitingOnUser: (t) => this.userWait(t),
    ...(managed ? { managed: { summary: (t: Ticket) => this.lastSummary(slug, t.id), report: (t: Ticket) => this.reportOf(slug, t.id) } } : {}),
  });
  // A main ticket parked in Backlog or Done: no new tool ticket starts and it isn't woken (running ones finish, queued
  // ones wait); moving it back to In progress lets them go on.
  const parked = !!planner.main && (planner.status === "backlog" || planner.status === "done");
  // (Plans saved before the spending check-in was removed may still have a "checkin" field: nothing reads it.)
  const held = parked;
  // A stuck main ticket isn't woken until the user acts, but its steps still start once their dependencies are done
  // (their results wait in the inbox for its next wake).
  const quiet = plan.state === "stuck";
  if (!held) for (const cid of step.start) this.patch(slug, cid, { status: "ready", mode: "auto", outcome: null, error: null });
  if (step.events.length) {
    plan.inbox = [...(plan.inbox ?? []), ...step.events.map((e) => e.line)];
    plan.seen = { ...plan.seen, ...Object.fromEntries(step.events.map((e) => [e.childId, e.sig])) };
    // Results also show in the planner's chat as cards.
    const cards = step.events.filter((e) => e.result).map((e) => this.resultCard(slug, e.childId)).filter((c): c is ResultCard => !!c);
    if (cards.length) this.patch(slug, planner.id, { results: [...(this.store.getTicket(slug, planner.id)?.results ?? []), ...cards].slice(-RESULTS_KEEP) });
  }
  if (held || quiet) {
    if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
    return !held && step.start.length > 0;
  }
  const inbox = plan.inbox ?? [];
  if (!plannerBusy && !plan.awaiting) {
    if (inbox.length) {
      if (managed) {
        // Runaway loops: wakes in a row in which no tool ticket changed or was made mean the plan is stuck.
        const p = progressStep(plan, familySig(kids));
        if (p.stuck) {
          this.stuck(slug, planner, plan, `${p.noProgress} wakes in a row without any tool ticket changing; waiting events: ${inbox.join("; ").slice(0, 600)}`);
          return false;
        }
      } else if (plan.wakeups >= wakeupCap(Math.max(plan.originalCount, kids.length))) {
        this.stuck(slug, planner, plan, `wake-up limit reached (${plan.wakeups}); waiting events: ${inbox.join("; ")}`);
        return step.start.length > 0;
      }
      const key = this.key(slug, planner.id);
      const due = this.wakeDue.get(key);
      if (due === undefined) {
        const delay = this.opts.planWakeDelayMs ?? 3000;
        this.wakeDue.set(key, Date.now() + delay);
        setTimeout(() => this.advancePlans(slug), delay + 5);
      } else if (Date.now() >= due) {
        this.wakeDue.delete(key);
        this.wake(slug, planner, plan, "event", inbox, kids);
        return step.start.length > 0;
      }
      if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
      return step.start.length > 0;
    }
    if (step.allComplete || (planner.main && !kids.length)) {
      // A main ticket already heard every result: its plan just rests until a new tool ticket comes (no extra wake).
      if (planner.main) {
        this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, reason: null, finishedAt: nowIso() } });
        return false;
      }
      this.wake(slug, planner, { ...plan, state: "finishing" }, "final", [], kids);
      return false;
    }
    if (step.deadEnd && !step.start.length) {
      this.stuck(slug, planner, plan, step.deadEnd);
      return false;
    }
  }
  if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
  return step.start.length > 0;
}

/** The questions form in the ticket's chat still waiting for the user's answers (empty when none). */
export function openForm(this: Board, t: Ticket): Question[] {
  // A question the user closed isn't asked again after a board update.
  if (askClosed(t)) return [];
  return (t.sessionId ? this.sessionSummary(t.sessionId)?.openForm : undefined) ?? [];
}

/**
 * Close question: the user closes a questions form (entry uuid) without answering. Nothing is sent and no run
 * starts; the ticket stops waiting on the user for it (askClosed), until a new run asks again. Only the form still
 * open now can be closed (a stale tab can't hide a newer question); the close remembers the run that asked it.
 */
export function closeForm(this: Board, slug: string, id: string, uuid: string): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (this.isRunning(slug, id)) throw new ConflictError("Claude is working on this ticket; close the question once it has finished");
  if (t.closedForms?.[uuid]) return t;
  const open = t.sessionId ? this.sessionSummary(t.sessionId)?.openFormId : undefined;
  if (!open || open !== uuid) throw new ConflictError("This question isn't the one waiting now; reload the page to see the latest question");
  return this.patch(slug, id, { closedForms: { ...t.closedForms, [uuid]: { at: nowIso(), by: "user", run: t.runEndedAt ?? "" } } });
}

/**
 * The user wrote in a task's chat: a main ticket's open question about that task (ask_questions' about) is settled
 * there, so it closes by itself (as if they pressed Close question). Only when the task was waiting on the user as
 * the message arrived (taskWaited: a question, a proposal), so "status?" to a working task doesn't close it, and only
 * the main ticket's form still open now. Returns the main ticket when it closed one.
 */
export function closeQuestionsAbout(this: Board, slug: string, task: Ticket, taskWaited: boolean): Ticket | null {
  if (!taskWaited) return null;
  const parent = parentLink(task);
  const above = parent ? this.store.getTicket(slug, parent.id) : undefined;
  const main = above ? this.mainOf(slug, above) : null;
  if (!main || !main.sessionId || this.isRunning(slug, main.id) || askClosed(main)) return null;
  const s = this.sessionSummary(main.sessionId);
  if (!s?.openQuestions || !s.openFormId || !s.openAsk?.about?.includes(task.id) || main.closedForms?.[s.openFormId]) return null;
  const out = this.patch(slug, main.id, { closedForms: { ...main.closedForms, [s.openFormId]: { at: nowIso(), by: "task", taskId: task.id, run: main.runEndedAt ?? "" } } });
  this.store.addComment(slug, main.id, "ai", `Closed the question about "${task.title}": you answered it in that task's chat.`);
  return out;
}

/** A key box (ask_keys) in the ticket's chat still waits for the user. */
export function keysOpen(this: Board, t: Ticket): boolean {
  const pending = t.sessionId ? this.sessionSummary(t.sessionId)?.pendingKeys : undefined;
  return !!pending?.some((id) => !t.keyCards?.[id]);
}

/** Resume the planner's session with what happened; several events arrive as one message. */
export function wake(this: Board, slug: string, planner: Ticket, plan: Plan, kind: PlanWake, events: string[], kids: Ticket[]) {
  const managed = managedPlan(planner);
  // Read before autoFresh: a fresh chat no longer has the form, but Claude still asks it again from this list.
  const open = this.openForm(planner);
  const text = managed
    ? mainWakePrompt(planner, { kind, events, table: wakeTable(kids, this.store.listTickets(slug), (id) => this.isRunning(slug, id)), board: slug, group: !planner.main, open })
    : orchestratorPrompt(planner, { kind, events, table: planTable(kids), board: slug, outputDir: this.store.outputsDir(slug, planner.id), repo: this.repoState(slug) ?? this.guessRepo(slug), open });
  const progress = managed ? progressStep(plan, familySig(kids)) : null;
  this.patch(slug, planner.id, { plan: { ...plan, inbox: [], awaiting: kind, wakeups: plan.wakeups + 1, ...(progress ? { progressSig: progress.progressSig, noProgress: progress.noProgress } : {}) } });
  this.autoFresh(slug, this.store.getTicket(slug, planner.id) ?? planner);
  if (planner.main) {
    // Its card stays where it is (a wake isn't new work to review); no slot, no folder lock (it edits nothing). A
    // wake never leaves it in Done while its steps are still at work (parked plans aren't woken, so this is rare).
    if (planner.status === "done" && this.openSteps(slug, planner.id)) this.unparkMain(slug, planner.id, "its steps are still at work");
    this.start(slug, planner.id, { text, mode: "act", raw: true });
    return;
  }
  // Back to where it was (In progress only if a restart cut a wake-up off).
  const returnTo = planner.status === "in_progress" ? "review" : planner.status;
  this.start(slug, planner.id, { text, mode: "act", raw: true, returnTo });
}

export function closePlan(this: Board, slug: string, planner: Ticket, plan: Plan, comment: string): Ticket {
  const out = this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, reason: null, inbox: [], finishedAt: nowIso() } });
  this.store.addComment(slug, planner.id, "ai", comment);
  return out;
}

export function stuck(this: Board, slug: string, planner: Ticket, plan: Plan, reason: string) {
  this.patch(slug, planner.id, { plan: { ...plan, state: "stuck", awaiting: null, reason } });
  // The stuck planner now needs the user (attention.ts): the Notifier tells them.
  this.store.addComment(slug, planner.id, "ai", `Plan stuck: ${reason}. Fix what's needed, then press Resume plan.`);
}

export async function cleanupWorktree(this: Board, slug: string, t: Ticket): Promise<Ticket> {
  const profile = this.store.getProfile(slug);
  if (!profile || !t.worktree) return t;
  const r = await this.removeTicketWorktree(profile, t.worktree);
  if (r.removed) return this.patch(slug, t.id, { worktree: null });
  this.store.addComment(slug, t.id, "ai", `Worktree kept at ${t.worktree}: ${r.reason}`);
  return t;
}

/**
 * Removes worktrees left behind by Done or deleted tickets (run once at startup; never throws).
 * Only the board's own worktree folder is looked at; ones with uncommitted changes are kept and logged.
 */
export async function sweepWorktrees(this: Board): Promise<void> {
  for (const profile of this.store.listProfiles()) {
    try {
      if (!(await isGitRepo(profile.path))) continue;
      const root = dirname(worktreeDir(profile, "x"));
      if (!existsSync(root)) continue;
      const realRoot = realpathSync(root);
      let swept = 0;
      const kept: string[] = [];
      for (const dir of await listWorktrees(profile.path)) {
        if (dirname(dir) !== realRoot && dirname(dir) !== root) continue;
        const id = basename(dir);
        const t = this.store.getTicket(profile.slug, id);
        const key = this.key(profile.slug, id);
        const busy = this.isRunning(profile.slug, id) || this.setups.has(key) || this.sessionLocks.has(key);
        if (t && (t.status !== "done" || busy)) continue;
        const r = await this.removeTicketWorktree(profile, dir);
        if (!r.removed) {
          kept.push(`${id} (${r.reason})`);
          continue;
        }
        swept++;
        if (t?.worktree) this.patch(profile.slug, id, { worktree: null });
      }
      if (swept || kept.length) {
        console.log(`profile ${profile.slug}: swept ${swept} orphan worktree${swept === 1 ? "" : "s"}, kept ${kept.length} with changes${kept.length ? `: ${kept.join(", ")}` : ""}`);
      }
    } catch (e) {
      console.error(`profile ${profile.slug}: worktree sweep failed: ${(e as Error).message}`);
    }
  }
}
