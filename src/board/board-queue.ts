import { localizeAttachments, localizeUrls } from "./attachments";
import { steerPrompt } from "../runs/prompts";
import { run as runCmd } from "../runs/git";
import { EFFORT_HELP, runOptions, ultracodeOn, validEffort, listCommands, MODEL_HELP, validModel, type SlashCommand } from "../chat/commands";
import { type QueuedMessage, type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { ActiveRun, ChatOptions, ANSWER_REPEAT_MS, ANSWER_PREFIX, spentWith, ConflictError } from "./board-types";

/** What `/` can run in this ticket's chat (the composer's picker lists the same). */
export function commands(this: Board, slug: string, id: string): SlashCommand[] {
  const t = this.store.getTicket(slug, id);
  const profile = this.store.getProfile(slug);
  if (!t || !profile) return [];
  return listCommands(t.workdir ?? t.worktree ?? profile.path, { projects: [profile.path] });
}

/** /model: the board's own command. Claude Code's version only lasts for one run (see commands.ts). */
export function boardCommand(this: Board, slug: string, id: string, name: string, args: string): Ticket {
  const t = this.store.getTicket(slug, id)!;
  if (name === "model") {
    const profile = this.store.getProfile(slug)!;
    const fallback = profile.model ? `the board's model (${profile.model})` : "Claude Code's default model";
    if (!args) {
      return this.patch(slug, id, { notice: t.model ? `This ticket uses model ${t.model}. Change it with /model <name>, or /model default.` : `This ticket uses ${fallback}. Change it with /model <name>, e.g. /model sonnet.` });
    }
    const reset = args === "default" || args === "reset";
    if (!reset && !validModel(args)) throw new Error(`"${args}" is not a model name. Use ${MODEL_HELP}.`);
    const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its model)" : "from the next run";
    return this.patch(slug, id, { model: reset ? null : args, notice: reset ? `Model reset: this ticket uses ${fallback} ${when}.` : `Model set to ${args} for this ticket, ${when}.` });
  }
  if (name === "effort") {
    const profile = this.store.getProfile(slug)!;
    const level = (e: string | null | undefined) => (e === "ultracode" ? "xhigh" : e || null);
    const boardUltra = !!runOptions(null, profile, true).ultracode;
    const fallback = level(profile.effort) ? `the board's effort (${level(profile.effort)})` : "Claude Code's default effort";
    const ultraText = (on: boolean) => (on ? ", ultracode on" : "");
    const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its settings)" : "from the next run";
    if (!args) {
      const mine = level(t.effort);
      const ultra = ultracodeOn(t, profile);
      return this.patch(slug, id, {
        notice: `${mine ? `This ticket uses effort ${mine}` : `This ticket uses ${fallback}`}${ultraText(ultra)}. Change it with /effort <level>, /effort ultracode (on or off), or /effort default.`,
      });
    }
    const words = args.toLowerCase().split(/\s+/);
    // Ultracode is a switch next to the effort level, like Claude Code's: /effort ultracode, /effort ultracode off.
    if (words[0] === "ultracode") {
      const on = words[1] !== "off";
      // The first version saved ultracode as the effort level: keep its level (xhigh) when switching it separately.
      const effort = t.effort === "ultracode" ? "xhigh" : t.effort;
      return this.patch(slug, id, {
        ultracode: on, effort: effort ?? null,
        notice: `Ultracode ${on ? "on" : "off"} for this ticket, ${when}.${on ? " Claude runs a workflow of helper agents for every substantial task, which uses much more of your plan." : ""}`,
      });
    }
    const reset = args === "default" || args === "reset";
    if (!reset && !validEffort(args)) throw new Error(`"${args}" is not an effort level. Use ${EFFORT_HELP}.`);
    if (reset) {
      return this.patch(slug, id, { effort: null, ultracode: null, notice: `Effort reset: this ticket uses ${fallback}${ultraText(boardUltra)} ${when}.` });
    }
    // A level set over the old "ultracode" effort keeps ultracode on.
    const keep = t.effort === "ultracode" && t.ultracode == null ? { ultracode: true } : {};
    const ultra = ultracodeOn({ ...t, ...keep, effort: args }, profile);
    return this.patch(slug, id, { effort: args, ...keep, notice: `Effort set to ${args}${ultraText(ultra)} for this ticket, ${when}.` });
  }
  return t;
}

/** Send a message that was left unsent by Stop, as if the user typed it now. */
export async function sendQueued(this: Board, slug: string, id: string, msgId: string): Promise<Ticket> {
  const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
  if (!msg) throw new Error("message not found");
  if (msg.state !== "unsent") throw new ConflictError("message is already on its way to Claude");
  this.dropQueued(slug, id, [msgId]);
  return this.chat(slug, id, msg.text, {
    peer: msg.peer, fromPlanner: msg.fromPlanner, from: msg.from, automation: msg.automation, slash: msg.slash, hostWake: msg.hostWake, followUp: msg.followUp, nextRun: msg.nextRun,
  });
}

export function discardQueued(this: Board, slug: string, id: string, msgId: string): Ticket {
  const msg = this.held(slug, id, msgId);
  const t = this.dropQueued(slug, id, [msgId]);
  // The last reply waiting for a slot is gone: nothing is left to start, so the card goes back.
  return t.slotWait && !this.waiting(slug, id).length ? this.cancelSlotWait(slug, id) : t;
}

/** Fix a message Claude hasn't received yet: it keeps its place in the queue. */
export function editQueued(this: Board, slug: string, id: string, msgId: string, text: string): Ticket {
  if (!text.trim()) throw new Error("message is empty");
  const msg = this.held(slug, id, msgId);
  const t = this.store.getTicket(slug, id)!;
  return this.patch(slug, id, { queued: (t.queued ?? []).map((m) => (m.id === msg.id ? { ...m, text } : m)) });
}

/**
 * A queued message the user can still change: left unsent by Stop, or waiting for the folder or a restart.
 * With a run going it was written to Claude's stdin at once (peer messages included), so it is delivered.
 */
export function held(this: Board, slug: string, id: string, msgId: string): QueuedMessage {
  const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
  if (!msg) throw new Error("message not found");
  if (msg.state === "unsent") return msg;
  if (msg.peer || this.isRunning(slug, id)) throw new ConflictError("message is already on its way to Claude");
  return msg;
}

export function dropQueued(this: Board, slug: string, id: string, ids: string[]): Ticket {
  const t = this.store.getTicket(slug, id)!;
  return this.patch(slug, id, { queued: (t.queued ?? []).filter((m) => !ids.includes(m.id)) });
}

/**
 * A form answer ("My answers: …") identical to one already waiting on the ticket, on its way to Claude, or taken in
 * the last ANSWER_REPEAT_MS: true (it isn't sent again). Otherwise it is noted as taken now.
 */
export function repeatedAnswer(this: Board, slug: string, id: string, t: Ticket, text: string, opts: ChatOptions): boolean {
  if (opts.peer || opts.hostWake || opts.followUp || opts.fromPlanner || !text.startsWith(ANSWER_PREFIX)) return false;
  const key = this.key(slug, id);
  const now = this.now().getTime();
  for (const [k, v] of this.recentAnswers) if (now - v.at >= ANSWER_REPEAT_MS) this.recentAnswers.delete(k);
  const norm = text.trim();
  const recent = this.recentAnswers.get(key);
  if ((recent && recent.text === norm) || (t.queued ?? []).some((m) => m.state === "queued" && m.text.trim() === norm)) {
    console.log(`board: ${slug}/${id}: the same form answer came again within ${ANSWER_REPEAT_MS / 1000}s; sent once`);
    return true;
  }
  this.recentAnswers.set(key, { text: norm, at: now });
  return false;
}

/** Hand a queued message to the live claude process; false when there is none to take it yet. */
export function steer(this: Board, run: ActiveRun, msg: QueuedMessage): boolean {
  if (run.inFlight.has(msg.id) || run.promptMsgId === msg.id) return true;
  // A slash command goes alone: anything after it would become the command's arguments.
  const text = msg.slash ? localizeUrls(msg.text, this.store.attachmentsDir) : localizeAttachments(msg.peer || msg.hostWake || msg.followUp ? msg.text : steerPrompt(msg.text), this.store.attachmentsDir);
  if (!run.handle?.send(text, { local: msg.slash === "local" })) return false;
  // Claude never echoes a local command back: it is read once it is written.
  if (msg.slash === "local") this.dropQueued(run.slug, run.id, [msg.id]);
  else run.inFlight.set(msg.id, text);
  if (!msg.peer && !msg.fromPlanner && !msg.hostWake && !msg.followUp && !msg.slash) run.userSteered = true;
  // From Telegram: the rest of this attempt counts as Telegram's.
  if (msg.telegram && run.telegramFrom === undefined) run.telegramFrom = run.spend ? spentWith(run.spend) : 0;
  return true;
}

/** Messages Claude has not read yet, waiting to be handed to a run. */
export function waiting(this: Board, slug: string, id: string): QueuedMessage[] {
  return (this.store.getTicket(slug, id)?.queued ?? []).filter((m) => m.state === "queued");
}

/** Claude echoed a user message back: it has read it, so it leaves the queue. */
export function delivered(this: Board, run: ActiveRun, text: string) {
  let msgId = [...run.inFlight].find(([, sent]) => sent === text)?.[0];
  if (msgId) run.inFlight.delete(msgId);
  // Anything else echoed back is the run's own prompt.
  else if (run.promptMsgId) [msgId, run.promptMsgId] = [run.promptMsgId, undefined];
  if (msgId) this.dropQueued(run.slug, run.id, [msgId]);
}

/** Entering Planning means "shape this with Claude": start the interview once, without a click. */
export function autoRefine(this: Board, slug: string, id: string): void {
  const t = this.store.getTicket(slug, id);
  if (!t || t.status !== "planning" || t.refineStarted || this.isRunning(slug, id) || this.shuttingDown) return;
  if (t.error?.startsWith("corrupt")) return;
  // A linked session is already a conversation about work underway; an interview would be noise.
  // A run stopped before Claude saved its session left nothing to talk over: interview as if new.
  if (t.workdir || (t.sessionStarted && t.sessionId && this.sessionExists(t.sessionId))) return;
  if (this.restartPending) {
    this.patch(slug, id, { refineStarted: true, interrupted: { at: nowIso(), mode: "refine", prompt: { text: "" }, held: true } });
    return;
  }
  this.start(slug, id, { text: "", mode: "refine" });
}
