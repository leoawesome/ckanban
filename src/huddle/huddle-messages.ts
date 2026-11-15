// Huddles: posts, brief, status changes, close requests, the budget brake (methods of the Huddles class in huddle.ts, split by topic).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { activeHost, MAIN_HANDLE, summaryFile, USER_HANDLE } from "./huddle-roster";
import { cleanLessons, type LessonInput } from "./huddle-notes";
import type { Huddle, HuddleMessage, HuddleMessageKind, HuddleParticipant, HuddleSource, HuddleStopReason } from "../core/types";
import { nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, POST_MAX, BRIEF_MAX, DEFAULT_MAX_COST_USD, BUDGET_WARN, huddleCost, money, isCoordinator, canManage, settled, StatusChange } from "./huddle-types";

/**
 * Post a message as `by` (the daemon decided who that is) and route it. status: the sender is done or blocked
 * (reason) with this message, as with setStatus.
 */
export function post(this: Huddles,
  slug: string, hid: string, by: HuddleParticipant, text: string, kind: HuddleMessageKind = "message",
  status?: { status: StatusChange; reason?: string; lessons?: unknown }, source?: HuddleSource,
): HuddleMessage {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!text.trim()) throw new HuddleError(400, "text is required");
  const len = text.trim().length;
  if (len > POST_MAX) {
    throw new HuddleError(400, `your message is ${len} characters, over the huddle's limit of ${POST_MAX}. Nothing was posted. ` +
      "Shorten it, split it into a few messages, or put the details in a file in your outputs folder and post its path.");
  }
  if (kind !== "message" && kind !== "finding") throw new HuddleError(400, "kind must be message or finding");
  if (by.status === "stopped" && by.kind !== "human") throw new HuddleError(409, `@${by.handle} was stopped by the user`);
  if (status) this.checkLessons(h, by, status.status, status.lessons);
  if (status) this.checkStatus(by, status.status, status.reason);
  const m = this.append(slug, hid, by.handle, text.trim(), kind, h.participants.map((p) => p.handle), canManage(h, by), source);
  // Stopped: the log keeps it; Resume wakes whoever it tags (wakeIfOwed).
  if (h.status === "live" && this.brakes(slug, hid, by, m)) this.route(slug, hid, m);
  if (status) this.setStatus(slug, hid, by, status.status, status.reason, status.lessons);
  return m;
}

/** Set (or clear, with "") the pinned brief: the goal and decisions so far, at the head of every digest. Leads, @main and the user. */
export function setBrief(this: Huddles, slug: string, hid: string, by: HuddleParticipant, text: string): Huddle {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, "only a lead, @main or the user can change the brief; suggest the change to your lead");
  const t = text.trim();
  if (t.length > BRIEF_MAX) throw new HuddleError(400, `the brief is ${t.length} characters, over the limit of ${BRIEF_MAX}; keep only the goal and the decisions`);
  if ((h.brief?.text ?? "") === t) return h;
  this.update(slug, hid, (x) => void (x.brief = t ? { text: t, by: by.handle, at: nowIso() } : null));
  this.system(slug, hid, t ? `@${by.handle} updated the pinned brief.` : `@${by.handle} cleared the pinned brief.`);
  return this.get(slug, hid);
}

export function checkStatus(this: Huddles, by: HuddleParticipant, status: StatusChange, reason?: string) {
  if (by.kind === "human") throw new HuddleError(400, "the user has no huddle status");
  if (status !== "done" && status !== "blocked" && status !== "active") throw new HuddleError(400, "status must be done, blocked or active");
  if (status === "blocked" && !reason?.trim()) throw new HuddleError(400, "say what blocks you (reason)");
}

/** Lessons proposed with a status change, checked: only an agent turning done, at most MAX_LESSONS, each a short rule. */
export function checkLessons(this: Huddles, h: Huddle, by: HuddleParticipant, status: StatusChange, lessons: unknown): LessonInput[] {
  let out: LessonInput[];
  try {
    out = cleanLessons(lessons);
  } catch (e) {
    throw new HuddleError(400, `${(e as Error).message}. Nothing was changed.`);
  }
  if (!out.length) return out;
  if (status !== "done") throw new HuddleError(400, "lessons go with status done, when your job is finished");
  if (by.kind !== "agent") throw new HuddleError(400, "only huddle agents propose lessons");
  return out;
}

/**
 * A participant says it is done (only a lead, @main or the user wakes it again; a lead wakes on any tag), blocked on something (@main is
 * tagged; @you when @main itself is blocked), or active again. lessons (agents turning done): proposed for the
 * user to review; they become role notes only when the user saves them.
 */
export function setStatus(this: Huddles, slug: string, hid: string, by: HuddleParticipant, status: StatusChange, reason?: string, lessons?: unknown): HuddleParticipant {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  const proposed = this.checkLessons(h, by, status, lessons);
  this.checkStatus(by, status, reason);
  const p = h.participants.find((x) => x.handle === by.handle)!;
  if (p.status === "stopped") throw new HuddleError(409, `@${p.handle} was stopped by the user`);
  const why = reason?.trim() || null;
  // The host blocking itself: the note that @main runs the huddle again says why (see hostMoved).
  const wasHost = h.status === "live" && !!h.host && activeHost(h) === p.handle;
  if (status === "active") {
    if (!settled(p)) return p;
    this.updateP(slug, hid, p.handle, { status: this.working(slug, h, p) ? "working" : "idle", statusReason: null });
    this.system(slug, hid, `@${p.handle} is active again.`);
  } else {
    this.updateP(slug, hid, p.handle, { status, statusReason: why });
    if (proposed.length) this.addLearnings(slug, hid, p, proposed);
    const n = proposed.length;
    const learned = n ? `${why ? "." : ""} It noted ${n} lesson${n === 1 ? "" : "s"} for future huddles; the board saves ${n === 1 ? "it" : "them"} once ${n === 1 ? "it comes" : "they come"} up again (Team, Learned).` : "";
    if (status === "done") this.system(slug, hid, `@${p.handle} is done${why ? `: ${why}` : "."}${learned}`);
    else if (!wasHost) this.system(slug, hid, `@${p.handle} is blocked: ${why}`, [isCoordinator(h, p) ? USER_HANDLE : activeHost(h)]);
  }
  return this.get(slug, hid).participants.find((x) => x.handle === p.handle)!;
}

/**
 * @main or a lead asks the user to close the huddle, once it has written the summary into the host ticket's
 * outputs. Only the user closes it.
 */
export function requestClose(this: Huddles, slug: string, hid: string, by: HuddleParticipant, reason: string): Huddle {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, "only @main or a lead can ask to close the huddle; tell your lead you are done (huddle_status done)");
  const summary = join(this.store.outputsDir(slug, h.hostTicket), summaryFile(hid));
  if (!existsSync(summary)) {
    throw new HuddleError(409, `write the huddle summary first: ${summary} (what was decided, the findings and their state, what is left to do), then call huddle_close again`);
  }
  // Without a closing full stop: the reason goes inside sentences that add their own.
  const why = reason.trim().replace(/\.+$/, "") || "the work is done";
  // An auto huddle runs while the user is away: its coordinator closes it itself.
  if (h.auto && isCoordinator(h, by)) return this.close(slug, hid, `closed by @main (${why})`);
  this.update(slug, hid, (x) => void (x.closeRequest = { by: by.handle, at: nowIso(), reason: why }));
  this.system(slug, hid, `@${by.handle} asks to close the huddle: ${why}. The summary is in the host ticket's outputs (${summaryFile(hid)}). @you: press Close huddle to end it; only you can close it.`, [USER_HANDLE]);
  return this.get(slug, hid);
}

/** Counts a new message. The budget is the only brake: agents talk until they reach a conclusion. */
export function brakes(this: Huddles, slug: string, hid: string, by: HuddleParticipant, _m: HuddleMessage): boolean {
  this.update(slug, hid, (x) => {
    x.posts = (x.posts ?? 0) + 1;
    x.sinceUser = by.kind === "human" ? 0 : (x.sinceUser ?? 0) + 1;
  });
  return true;
}

/** The huddle stops by itself (see HuddleStopReason). budget and messages stop every huddle run too; loop only pauses routing. */
export function halt(this: Huddles, slug: string, hid: string, reason: HuddleStopReason, text: string) {
  const h = this.get(slug, hid);
  // The budget also stops a huddle whose routing was only paused.
  if (h.status === "closed" || (h.status !== "live" && reason !== "budget") || h.stopReason === reason) return;
  const hard = reason !== "loop";
  if (hard) for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
  this.update(slug, hid, (x) => {
    x.status = "stopped";
    x.stopReason = reason;
    if (hard) for (const p of x.participants) if (p.kind === "agent") p.status = "stopped";
  });
  this.system(slug, hid, text, [USER_HANDLE]);
  if (h.auto) this.autoEnded(slug, hid, "halt", reason === "budget" ? "it hit its budget cap" : reason === "messages" ? "it hit its message limit" : "its agents kept answering each other, so routing paused");
}

/** After a cost update: warn the leads at 80% of the budget, stop at 100%. */
export function checkBudget(this: Huddles, slug: string, hid: string) {
  const h = this.load(slug, hid);
  if (!h || h.status === "closed") return;
  const max = h.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const spent = huddleCost(h);
  if (spent >= max) {
    // One line: the board's brake dock shows the details (the close request, the ways on).
    const by = h.participants.filter((p) => (p.costUsd ?? 0) > 0).map((p) => `@${p.handle} ${money(p.costUsd!)}`).join(", ");
    const stop = `■ Paused at the ${money(max)} budget (${money(spent)} spent${by ? `: ${by}` : ""}); every run was stopped.`;
    // The last wrap-up turn can tip it over after the work is finished: then Close is the next step, not more budget.
    const finished = !!h.closeRequest || this.quiet(slug, h, this.store.readHuddleMessages(slug, hid)).quiet;
    if (!finished) {
      this.halt(slug, hid, "budget", `${stop} @you: resume it with more budget if it should go on.`);
      return;
    }
    this.update(slug, hid, (x) => void (x.finishedAtStop = true));
    this.halt(slug, hid, "budget", `${stop} @you: the work looks finished, so check the result and close the huddle.`);
    return;
  }
  if (spent >= max * BUDGET_WARN && !h.budgetWarned) {
    this.update(slug, hid, (x) => void (x.budgetWarned = true));
    // A host running the room wraps it up; @main isn't woken for it.
    const hosted = activeHost(h) !== MAIN_HANDLE;
    const leads = h.participants.filter((p) => p.lead && p.kind !== "human" && p.status !== "stopped" && !(hosted && p.handle === MAIN_HANDLE)).map((p) => p.handle);
    this.system(slug, hid,
      `${leads.map((x) => `@${x}`).join(" ")}${leads.length ? ": t" : "T"}he huddle has spent ${money(spent)} of its ${money(max)} budget (${Math.round((spent / max) * 100)}%). ` +
      "Wrap up: send the consolidated findings now and only start what is needed; at 100% every run stops.", leads);
  }
}
