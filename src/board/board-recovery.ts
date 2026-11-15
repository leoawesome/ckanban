import { existsSync, readFileSync } from "node:fs";
import { isSessionLive as psSessionLive, sessionTitle } from "../runs/claude";
import { type HostHuddle } from "../helper/attention";
import { RecallIndex, recallText } from "./recall";
import { pauser } from "../core/lag";
import { featureRows, isFeature, subFeaturesOf } from "../../web/src/features/family/family";
import { chatIsCold, FRESH_CHAT_TOKENS } from "../chat/chat-cache";
import { learnedRulesBlock } from "./learn";
import { lessonsBlock } from "./lessons";
import { wakeTable } from "./main-ticket";
import { freshChatNote, freshSessionPrompt, interruptedPrompt, mentionsArtifact } from "../runs/prompts";
import { planActive } from "./plan";
import { run as runCmd } from "../runs/git";
import { BOARD_NOTE_RE } from "../core/store";
import { autoHuddlesOn, type Interrupted, type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { ActiveRun, chatFor, takesSlot, Session, RESTART_MAX_WAIT_MS, AUTO_FRESH_NOTE, ConflictError } from "./board-types";

/** The first prompt of a fresh session: ticket, last result, recent comments, and where to look for the work so far. */
export function freshPrompt(this: Board, slug: string, t: Ticket, session: Pick<Session, "repo" | "inPlace">, outputDir: string, recall: string): string {
  const comments = this.store.listComments(slug, t.id);
  const last = comments.findLast((c) => c.author === "ai" && !BOARD_NOTE_RE.test(c.text));
  const recent = comments.filter((c) => !BOARD_NOTE_RE.test(c.text) && c !== last).slice(-10);
  const profile = this.store.getProfile(slug);
  return freshSessionPrompt(t, {
    repo: session.repo, inPlace: session.inPlace, home: profile ? { folder: profile.path, baseBranch: profile.baseBranch } : undefined, linked: !!t.workdir, baseBranch: profile?.baseBranch || "main",
    lastResult: last?.text ?? null, comments: recent, outputDir, autoHuddles: autoHuddlesOn(profile), artifacts: !!profile?.artifacts || mentionsArtifact(t.body, last?.text, ...recent.map((c) => c.text)),
    recall,
  });
}

export function freshChatContext(this: Board, slug: string, t: Ticket): string {
  const comments = this.store.listComments(slug, t.id);
  const last = comments.findLast((c) => c.author === "ai" && !BOARD_NOTE_RE.test(c.text));
  const recent = comments.filter((c) => !BOARD_NOTE_RE.test(c.text) && c !== last).slice(-10);
  if (!this.seedsFromStatus(slug, t)) return freshChatNote(t, last?.text ?? null, recent);
  // A main ticket or feature starts from its status and its collapsed family table; search_chat finds the rest.
  let status: string | null = null;
  try {
    const path = this.refreshStatusFile(slug, t.id);
    status = path && existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (e) {
    console.error(`status of ${slug}/${t.id}:`, e);
  }
  const all = this.store.listTickets(slug);
  const kids = all.filter((c) => c.parentId === t.id || c.partOf === t.id);
  const table = wakeTable(kids, all, (id) => this.isRunning(slug, id));
  return freshChatNote(t, last?.text ?? null, recent, { status, table, auto: !!t.freshAuto });
}

/** A main ticket, or the top ticket of a feature: its fresh chats start from the status (and may start by themselves). */
export function seedsFromStatus(this: Board, slug: string, t: Ticket): boolean {
  if (t.main) return true;
  try {
    return isFeature(this.store.listTickets(slug), t);
  } catch {
    return false;
  }
}

/**
 * The next turn of a main ticket's or feature's chat that has gone cold and is large (over the board's freshChatTokens)
 * starts as a fresh chat seeded from the status, instead of re-reading the whole conversation. Returns the ticket as it
 * is now (unchanged when not).
 */
export function autoFresh(this: Board, slug: string, t: Ticket): Ticket {
  if (t.freshSession || !t.sessionId || !this.seedsFromStatus(slug, t)) return t;
  const cache = this.sessionSummary(t.sessionId)?.cache;
  if (!cache || !chatIsCold(cache, (this.opts.now?.() ?? new Date()).getTime())) return t;
  const limit = this.store.getProfile(slug)?.freshChatTokens || FRESH_CHAT_TOKENS;
  if ((cache.coldTokens ?? cache.tokens) <= limit) return t;
  return this.startFreshChat(slug, t.id, true);
}

/**
 * "What we did before on this board": related past tickets for t's first prompt (see recall.ts), the rules the board
 * learned from the user's corrections (learn.ts), and the project's saved lessons a run in a worktree can't see yet
 * (lessons.ts); "" for none.
 */
export async function recall(this: Board, slug: string, t: Ticket): Promise<string> {
  let index = this.recallIndexes.get(slug);
  if (!index) this.recallIndexes.set(slug, (index = new RecallIndex()));
  // Tokenises only tickets that changed since the last run start (the first one after a start reads them all, in slices).
  const picked = await index.pick(t, this.store.listTickets(slug), (id) => this.store.lastAiSummary(slug, id), (id) => this.store.commentStamp(slug, id), pauser());
  const profile = this.store.getProfile(slug);
  const now = this.store.getTicket(slug, t.id) ?? t;
  const lessons = profile ? lessonsBlock(profile.path, now.worktree ?? now.workdir ?? null) : "";
  return [recallText(picked), learnedRulesBlock(this.store, slug), lessons].filter(Boolean).join("\n\n");
}

/** Queues the ticket's work run: it starts now if a slot is free (dispatch), otherwise when one frees up. */
export function requeue(this: Board, slug: string, id: string): Ticket {
  this.patch(slug, id, { status: "ready", outcome: null, error: null });
  this.dispatch(slug);
  return this.store.getTicket(slug, id)!;
}

export function recoverable(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
  if (this.isRunning(slug, id)) throw new ConflictError("Claude is already working on this ticket");
  return t;
}

/**
 * Start fresh session: drops the ticket's Claude session (its conversation can't be resumed) but keeps the
 * worktree and branch, then queues a work run whose prompt tells Claude to continue from the branch's state.
 */
export function startFresh(this: Board, slug: string, id: string): Ticket {
  this.recoverable(slug, id);
  this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true });
  this.store.addComment(slug, id, "ai", "Started a fresh session: the previous conversation is gone, so Claude continues from the ticket, its last result and the branch as it is now.");
  return this.requeue(slug, id);
}

/**
 * "Fresh chat (keeps status)" in the ticket panel: like "Send in a fresh chat" without a message. The next message
 * starts a new Claude session; the chat history, the feature status, outputs and the card's column stay as they are.
 */
export function freshChat(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
  if (this.runs.get(this.key(slug, id))) throw new ConflictError("Claude is working on this ticket; start a fresh chat once Claude is done");
  if (t.freshSession) return t;
  return this.startFreshChat(slug, id);
}

/**
 * "Send in a fresh chat" (an old chat would be re-read in full): the next message starts a new session that gets the
 * ticket, its last result and recent comments instead of the old conversation. Unlike startFresh, nothing is queued
 * and the card stays where it is; the old session is kept so the ticket chat still shows it.
 */
export function startFreshChat(this: Board, slug: string, id: string, auto = false): Ticket {
  const t = this.store.getTicket(slug, id)!;
  const earlier = t.sessionId && (t.sessionStarted || this.sessionExists(t.sessionId))
    ? [...(t.earlierSessions ?? []), { sessionId: t.sessionId, endedAt: nowIso() }]
    : t.earlierSessions;
  this.store.addComment(slug, id, "ai", auto
    ? AUTO_FRESH_NOTE
    : this.seedsFromStatus(slug, t)
    ? "Started a fresh chat: Claude starts from the status and can look up earlier messages."
    : "Started a fresh chat: Claude no longer sees the earlier messages; it gets the ticket, its last result and recent comments instead.");
  return this.patch(slug, id, {
    sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true, freshAuto: auto || null, ...(earlier ? { earlierSessions: earlier } : {}),
  });
}

/**
 * Take over here: the ticket's session is open in a terminal. If that's the board's own (dock) terminal, it is
 * closed and the run resumes here; one in an external terminal can't be closed (external: the UI offers
 * Start fresh session instead).
 */
export async function takeOver(this: Board, slug: string, id: string): Promise<{ ticket: Ticket; external: boolean }> {
  const t = this.recoverable(slug, id);
  if (t.sessionId) {
    const owned = await this.opts.findOwnedSession?.(t.sessionId) ?? null;
    if (owned) {
      if (!(await owned.close())) throw new Error("Couldn't close the session in the board's terminal. Exit it there (Ctrl+D or /exit), then try again.");
      this.store.addComment(slug, id, "ai", "Took over the session: closed it in the board's terminal and resumed the run here.");
      return { ticket: this.requeue(slug, id), external: false };
    }
    const title = t.workdir ? sessionTitle(t.workdir, t.sessionId) : null;
    if (await this.isSessionLive(t.sessionId, title)) return { ticket: t, external: true };
  }
  this.store.addComment(slug, id, "ai", "Took over the session: it was no longer open in a terminal, so the run resumed here.");
  return { ticket: this.requeue(slug, id), external: false };
}

/** A comment: the user's (or a planner's), or with from, a note another ticket's run left (shown as Claude's). */
export function addComment(this: Board, slug: string, id: string, text: string, from?: string) {
  const c = this.store.addComment(slug, id, from ? "ai" : "user", text, from);
  this.emitTicket(slug, this.store.getTicket(slug, id)!);
  return c;
}

export function stopRun(this: Board, run: ActiveRun) {
  // A run with nothing behind it (no promise, no claude, no setup) has nothing to wait for: clear it at once.
  if (!run.started && !run.handle && !this.setups.has(this.key(run.slug, run.id))) {
    const end = this.endStatus(run);
    this.dropRun(run, { ...end, ...(end.status ? { outcome: "stopped" as const } : {}), lastActivity: null, runStartedAt: null });
    try {
      this.store.addComment(run.slug, run.id, "ai", "Run stopped by user (it had never started).");
    } catch {}
    return;
  }
  // Show the stop at once: setup (worktree, session checks) or SIGTERM can take a while to finish.
  if (!run.stopRequested && this.store.getTicket(run.slug, run.id)) this.patch(run.slug, run.id, { lastActivity: "Stopping…" });
  run.stopRequested = true;
  run.handle?.stop();
  this.setups.get(this.key(run.slug, run.id))?.abort.abort();
}

/** A main ticket's own tool tickets (hidden, shown on the board and with you), from featureRows: not a sub-feature's. */
export function toolTickets(this: Board, slug: string, mainId: string, tickets = this.store.listTickets(slug)): Ticket[] {
  return featureRows(tickets, mainId).map((r) => r.ticket).filter((t) => t.id !== mainId && t.tool);
}

/** Stop a main ticket and its running tool tickets (other family members are left alone). How many tool tickets stopped. */
export function stopFamily(this: Board, slug: string, id: string): { stopped: boolean; tools: number } {
  const stopped = this.stop(slug, id);
  let tools = 0;
  let subStopped = false;
  const t = this.store.getTicket(slug, id);
  if (t?.main) {
    let queued = 0;
    for (const o of this.toolTickets(slug, id)) {
      if (this.isRunning(slug, o.id) || o.status === "in_progress") {
        if (this.stop(slug, o.id)) tools++;
      } else if (o.status === "ready") {
        // Queued to start: back to waiting (Backlog), so nothing new starts behind the user's Stop.
        this.patch(slug, o.id, { status: "backlog" });
        queued++;
      }
    }
    // Nothing new starts behind the user's Stop: the plan pauses until the user acts on the ticket again (moves it to
    // ready, writes or answers in its chat: resumeStoppedPlan). A Stop that only cut off the main ticket's own reply
    // held no step back, so it doesn't pause at all.
    const now = this.store.getTicket(slug, id);
    if ((tools > 0 || queued > 0) && now?.plan && (now.plan.state === "running" || now.plan.state === "finishing")) {
      this.patch(slug, id, { plan: { ...now.plan, state: "paused", awaiting: null } });
      this.store.addComment(slug, id, "ai", `Stopped by you with ${tools} running tool ticket${tools === 1 ? "" : "s"}; new tasks wait until you move this ticket to ready, write in its chat or press Resume.`);
    }
    // Stop reaches into its sub-features too (each stops like its own Stop and resumes on its own).
    for (const sub of subFeaturesOf(this.store.listTickets(slug), id)) {
      const was = sub.plan?.state;
      const r = this.stopFamily(slug, sub.id);
      const paused = was !== "paused" && this.store.getTicket(slug, sub.id)?.plan?.state === "paused";
      if (r.stopped || paused) {
        tools += r.tools;
        subStopped ||= r.stopped;
        this.store.addComment(slug, sub.id, "ai", `Stopped with the feature "${t.title}" it is part of.`);
      }
    }
  }
  return { stopped: stopped || tools > 0 || subStopped, tools };
}

/** A merge_into_main into this main ticket's copy is running. */
export function merging(this: Board, slug: string, mainId: string): boolean {
  return this.mergeLocks.has(this.key(slug, mainId));
}

export function stop(this: Board, slug: string, id: string): boolean {
  const r = this.runs.get(this.key(slug, id));
  if (r) {
    this.stopRun(r);
    return true;
  }
  const t = this.store.getTicket(slug, id);
  if (t?.slotWait) {
    this.cancelSlotWait(slug, id);
    return true;
  }
  // In Progress with no run behind it (e.g. the daemon lost it, or it waits for its auto huddle): clear the card.
  if (t?.status !== "in_progress") return false;
  this.store.addComment(slug, id, "ai", t.autoHuddle ? "Stopped by user while waiting for its auto huddle." : "Run stopped by user.");
  this.patch(slug, id, { status: "review", outcome: "stopped", error: null, lastActivity: null, ...(t.autoHuddle ? { autoHuddle: null } : {}) });
  return true;
}

export function stopAll(this: Board): void {
  for (const r of this.runs.values()) this.stopRun(r);
}

/** Kill all runs without recording an outcome; tickets stay in_progress for recover(). */
export async function shutdown(this: Board): Promise<void> {
  this.shuttingDown = true;
  for (const r of this.runs.values()) this.markInterrupted(r);
  for (const r of this.runs.values()) {
    r.stopRequested = true;
    r.handle?.stop();
  }
  for (const s of this.setups.values()) s.abort.abort();
  for (const [a, cutOff] of this.asks) {
    cutOff(); // saved on the asker now (the fork's own end may come after the process exits); recover() wakes it
    a.stop();
  }
  this.asks.clear();
  await Promise.race([this.whenIdle(), Bun.sleep(6000)]);
}

/** A chat reply is being cut off by shutdown: remember it so recover() resumes it (work runs stay in_progress). */
export function markInterrupted(this: Board, r: ActiveRun): void {
  const t = this.store.getTicket(r.slug, r.id);
  if (!t || !r.chat || r.stopRequested || t.status === "in_progress") return;
  // Not spawned yet with a queued message: it is still in the queue, and recover() answers it.
  if (!r.handle && r.promptMsgId) return;
  const i: Interrupted = { at: nowIso(), mode: r.chat.mode };
  if (r.chat.quiet) i.quiet = true;
  if (r.chat.user) i.user = true;
  if (r.draft?.text) i.partial = r.draft.text;
  // Claude never got the prompt: send it again rather than asking it to continue.
  if (!r.handle) i.prompt = r.chat.raw ? { text: r.chat.text, raw: true } : { text: r.chat.text };
  this.patch(r.slug, r.id, { interrupted: i, lastActivity: null, runStartedAt: null });
}

/** Huddles tells the board about its host tickets' huddles, which change whether those tickets need the user. */
export function onHostHuddles(this: Board, f: (slug: string) => Map<string, HostHuddle>): void {
  this.hostHuddleStates = f;
}

/** Open huddles by host ticket on a board. */
export function hostHuddles(this: Board, slug: string): Map<string, HostHuddle> {
  return this.hostHuddleStates(slug);
}

/** Count more active work a restart waits for: busy() lists the board of each piece of work active now. */
export function onRestartBusy(this: Board, busy: () => string[]): void {
  this.restartBusy.push(busy);
}

/** Board runs plus other active work a restart waits for. */
export function activeWork(this: Board): number {
  return this.busyBoards().length;
}

/** The board of each piece of active work (runs, chat replies, huddle agents mid-turn, job commands), repeats included. */
export function busyBoards(this: Board): string[] {
  return [...[...this.runs.values()].map((r) => r.slug), ...this.restartBusy.flatMap((f) => f())];
}

/**
 * Restart once no run is active. Until then nothing new starts: Ready tickets wait, chat messages queue and
 * Planning interviews are held; recover() starts them after the restart. After maxWaitMs it restarts anyway.
 */
export function requestRestart(this: Board, onIdle: () => void, maxWaitMs = RESTART_MAX_WAIT_MS): { running: number; alreadyPending: boolean } {
  const running = this.activeWork();
  if (this.restartPending) return { running, alreadyPending: true };
  this.restartPending = true;
  this.emitRestart();
  void (async () => {
    const deadline = Date.now() + maxWaitMs;
    // Always yield first, so the caller's HTTP response goes out before the daemon exits.
    do await Bun.sleep(200);
    while (this.activeWork() && Date.now() < deadline);
    const left = this.activeWork();
    if (left) console.log(`restart: ${left} run(s) still active after ${Math.round(maxWaitMs / 1000)}s; restarting anyway`);
    onIdle();
  })();
  return { running, alreadyPending: false };
}

export function isRestartPending(this: Board): boolean {
  return this.restartPending;
}

/** pending: a restart holds new runs; waiting: active runs it waits for. */
export function restartState(this: Board): { pending: boolean; waiting: number } {
  return { pending: this.restartPending, waiting: this.activeWork() };
}

/** Other active work (see onRestartBusy) changed: update the pending restart's count. */
export function restartWorkChanged(this: Board): void {
  if (this.restartPending) this.emitRestart();
}

export function emitRestart(this: Board): void {
  this.bus.emit({ type: "restart.updated", ...this.restartState() });
}

export function recover(this: Board): void {
  for (const p of this.store.listProfiles()) {
    for (const t of this.store.listTickets(p.slug)) {
      // Replies waiting for a slot keep waiting: dispatch() below starts them first.
      // Tickets waiting for their auto huddle stay put: the huddle (or a freed slot) wakes them.
      if (t.status !== "in_progress" || t.slotWait || t.autoHuddle || this.isRunning(p.slug, t.id)) continue;
      if (t.followUpRun) {
        // A follow-up wake was cut off: continue it as a follow-up, and the card goes back where it was.
        this.store.addComment(p.slug, t.id, "ai", "Follow-up interrupted by daemon restart; resuming.");
        const returnTo = t.followUpRun.returnTo;
        this.patch(p.slug, t.id, { status: returnTo, lastActivity: null });
        this.start(p.slug, t.id, { text: interruptedPrompt(), mode: "act", raw: true, returnTo, followUp: true });
        continue;
      }
      if (t.main) {
        // A main ticket never gets a work run from a restart: it is woken again from its saved events.
        this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; waking it again from its saved events.");
        const plan = t.plan ?? this.newPlan(0);
        this.patch(p.slug, t.id, {
          status: "review", outcome: null, lastActivity: null,
          plan: {
            ...plan, state: plan.awaiting === "final" || plan.state === "done" || plan.state === "finishing" ? "running" : plan.state, awaiting: null,
            inbox: [...(plan.inbox ?? []), "The board restarted while your last run was going; check where things stand before you continue."],
          },
        });
        continue;
      }
      if (t.plan?.awaiting && planActive(t.plan)) {
        // A planner wake-up was cut off: wake it again with the children's current state.
        this.store.addComment(p.slug, t.id, "ai", "Planner interrupted by daemon restart; waking it again.");
        this.patch(p.slug, t.id, {
          status: "review", outcome: null, lastActivity: null,
          plan: { ...t.plan, state: t.plan.awaiting === "final" ? "finishing" : t.plan.state, awaiting: null, seen: {} },
        });
        continue;
      }
      this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; resuming.");
      this.patch(p.slug, t.id, { status: "ready" });
    }
    this.dispatch(p.slug);
    this.advancePlans(p.slug);
    // Chat replies a restart cut off (or held back): continue them in the same session and mode.
    for (const t of this.store.listTickets(p.slug)) {
      const i = t.interrupted;
      if (!i || this.isRunning(p.slug, t.id) || t.status === "in_progress" || t.error?.startsWith("corrupt")) continue;
      if (!i.held) this.store.addComment(p.slug, t.id, "ai", "Reply interrupted by daemon restart; resuming.");
      const user = i.user ? { user: true } : {};
      if (i.prompt) this.start(p.slug, t.id, { text: i.prompt.text, mode: i.mode, raw: i.prompt.raw, quiet: i.quiet, ...user });
      // With a queued message waiting, the pass below answers it instead (one reply, not two).
      else if (!this.waiting(p.slug, t.id).length) this.start(p.slug, t.id, { text: interruptedPrompt(), mode: i.mode, raw: true, quiet: i.quiet, ...user });
    }
    // Messages a restarted chat run never got to: answer them in a chat reply now.
    for (const t of this.store.listTickets(p.slug)) {
      const next = this.waiting(p.slug, t.id)[0];
      if (!next || this.isRunning(p.slug, t.id) || t.status === "ready" || t.slotWait || t.error?.startsWith("corrupt")) continue;
      const chat = chatFor(t, next);
      if (takesSlot(chat, t.main) && chat.mode === "act" && this.folderBusy(p.slug, t)) this.waitForSlot(p.slug, t.id);
      else this.start(p.slug, t.id, chat, next.id);
    }
  }
}

export async function whenIdle(this: Board): Promise<void> {
  while (this.runs.size) {
    await Promise.all([...this.runs.values()].map((r) => r.promise));
  }
}
