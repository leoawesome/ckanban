// The helper runner: wakes the helper (one side call with a JSON schema, no tools), checks its decision (decide.ts)
// and carries it out through the core (store, send, mark told). It also fires the reminder steps the helper planned,
// backs off when runs fail and sends directly with one pause message after 3 failures in a row, sends the first
// hello and summary, and keeps the status the screens show. Like FollowUpWatcher it polls state kept on disk, so a
// restart or a killed run changes nothing; it is not a board run (a restart neither waits for it nor holds it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BusEvent } from "../events";
import { trackedInterval } from "../lag";
import type { NotifySettings } from "../notify";
import { addSideSpend, type SideCaller } from "../side-call";
import { atomicWrite, type Store } from "../store";
import { clockTime, cut, directLabel, type HelperCore, type HelperSink, type OutBody, type WaitEventReason } from "./core";
import {
  checkDecision, DECISION_SCHEMA, HELPER_SYSTEM, parseDecision, REMIND_MAX_MIN, REMIND_MAX_STEPS, summaryAllowedAt, urgentRefusal, type CheckedDecision, type CheckedSend,
  type HelperInput, type InputItem, type ItemState,
} from "./decide";
import type { MessageItem, NewMessage, StoredMessage } from "./messages";
import { buildSummary, type SummaryInput } from "./summary";
import { HelperSettingsStore, inNight, MORNING_GRACE_MS, morningDigestAt, nightEnd, type HelperSettings, type Night } from "./settings";
import { snoozeForever } from "../attention";
import { DIGEST_MS, FALLBACK_MS, pending, type WaitRecord } from "./waits";

/** A new wait waits this long for others before the helper wakes (an asker's urgent mark wakes it at once). */
export const BATCH_MS = 60_000;
/** No wake sooner than this after the last run. */
export const LOOP_GUARD_MS = 60_000;
/** Failed runs in a row before waits go out directly with one pause message. */
export const FAIL_LIMIT = 3;
/** Retry after a failed run: 1, 2, 4, 8, 16, then 30 minutes. */
export const backoffMs = (failures: number) => Math.min(30, 2 ** Math.max(0, failures - 1)) * 60_000;
/** A run that takes longer is killed and counts as failed. */
export const RUN_TIMEOUT_MS = 90_000;
/** Keep the Mac awake when a wake or a reminder is due within this long. */
export const AWAKE_AHEAD_MS = 15 * 60_000;
/** An urgent alert that reached no channel and has no later step: the helper looks again this soon. */
export const URGENT_RETRY_MS = 5 * 60_000;
export const RUNS_KEEP = 50;
/** A wait whose snooze ended early with its safety-net times further off than this gets them back from now. */
export const UNSNOOZED_MAX_MS = 24 * 3600_000;
/** The helper looks at held items this long before the board's 4-hour digest would send them. */
export const DIGEST_LEAD_MS = 5 * 60_000;

/**
 * When the helper looks at held items due a digest soon (`before`: 5 minutes before it). At night, or within the
 * morning grace after a night (a digest the night moved), it looks when the night ends: the morning summary goes
 * first, and the user isn't woken.
 */
export function lookBeforeDigest(before: number, night: Night): number {
  if (inNight(before, night)) return nightEnd(before, night);
  const graceStart = before - MORNING_GRACE_MS;
  return inNight(graceStart, night) ? nightEnd(graceStart, night) : before;
}
export const REACTIONS_KEEP = 20;
/** The helper's spend, for the "Helper" line in today's spend (spend.ts). */
export const helperSpendFile = (root: string) => join(root, "helper-spend.jsonl");

/** Plain names of channels, for the user. */
export const CHANNEL_LABEL: Record<string, string> = { mac: "this Mac", push: "phone", webhook: "ntfy", telegram: "Telegram" };
const label = (c: string) => CHANNEL_LABEL[c] ?? c;

/** One wake in the helper's log. */
export interface RunLog {
  at: string;
  ok: boolean;
  /** Nothing waited: no model call. */
  skipped?: boolean;
  costUsd?: number;
  model?: string;
  sends?: number;
  log?: string;
  error?: string | null;
  fixes?: string[];
}

interface RunnerState {
  nextWakeAt: string | null;
  /** When the last model run started, succeeded (start time), failed; when the helper last looked (skips included). */
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastCheckAt: string | null;
  failures: number;
  failReason: string | null;
  pauseSentAt: string | null;
  notes: string;
  helloSentAt: string | null;
  /** The one-time "notifications now come grouped" notice was seen (the screens show it until then). */
  noticeSeenAt: string | null;
  firstUrgentAsked: boolean;
  /** Check-in items already named in a message (key -> when). */
  named: Record<string, string>;
  reactions: { at: string; text: string }[];
  /** The last urgent alert sent at night (the morning message asks whether it was right). */
  nightWokeAt: string | null;
  nightWokeFor: string | null;
  /** Non-urgent board messages stored during the night: they go out when the night ends (oldest first). */
  heldSends: HeldSend[];
  runs: RunLog[];
}

/** A stored message whose send waits for the end of the night. */
interface HeldSend {
  messageId: string;
  title: string;
  body: string;
  tag: string;
  /** "pause": dropped instead of sent when the helper works again by then. */
  kind?: "pause";
}

const emptyState = (): RunnerState => ({
  nextWakeAt: null, lastRunAt: null, lastOkAt: null, lastFailAt: null, lastCheckAt: null, failures: 0, failReason: null, pauseSentAt: null,
  notes: "", helloSentAt: null, noticeSeenAt: null, firstUrgentAsked: false, named: {}, reactions: [], nightWokeAt: null, nightWokeFor: null, heldSends: [], runs: [],
});

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** The helper's log note for what it kept quiet: "Kept quiet: 2 tickets, nothing urgent. They'll be in the next summary, by 12:41." */
export function keptQuietLine(n: number, by: string): string {
  return n === 1
    ? `Kept quiet: 1 ticket, nothing urgent. It'll be in the next summary, by ${by}.`
    : `Kept quiet: ${n} tickets, nothing urgent. They'll be in the next summary, by ${by}.`;
}

/** An urgent alert or one of its reminder steps reached the user about this wait. */
/** What a told mark replaces, to give it back (WaitStore.unclaim). */
const claimOf = (r: WaitRecord) => ({ key: r.key, toldAt: r.toldAt, toldVia: r.toldVia, fallbackAt: r.fallbackAt, digestAt: r.digestAt });
const alerted = (r: WaitRecord) => r.reminders.some((x) => x.sentAt && !x.failed && !x.skipped);
/** Steps this wait has used so far (every alert on it counts): the 6-step cap is per wait. */
const stepsUsed = (r: WaitRecord) => (r.stepsUsed ?? 0) + r.reminders.filter((x) => x.sentAt && !x.skipped).length;

/** A check-in's meeting prep title: "Prep: <meeting> at HH:MM". */
const PREP = /^prep:.*\bat\s+(\d{1,2})[:.](\d{2})\b/i;

/**
 * When a prep item's meeting starts: the day it was raised at HH:MM, or the next day when that is earlier than when
 * it was raised. null when the title names no time.
 */
export function meetingTime(title: string, createdAt: string): number | null {
  const m = PREP.exec(title.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const c = new Date(createdAt);
  let at = new Date(c.getFullYear(), c.getMonth(), c.getDate(), h, min).getTime();
  if (at < c.getTime()) at = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1, h, min).getTime();
  return at;
}

export interface HelperRunnerDeps {
  root: string;
  store: Store;
  core: HelperCore;
  /** Notification settings (helper on/off, channels). */
  notifySettings: () => NotifySettings;
  sideCall: SideCaller;
  /** Link to a ticket, and to a message's page. */
  link: (slug: string, id?: string) => string;
  messageLink: (id: string) => string;
  /** Until when the ticket is snoozed in the Inbox (null: not snoozed). */
  snoozedUntil?: (slug: string, id: string) => string | null;
  /** The board is on screen on some device. */
  onScreen?: () => boolean;
  /** Phones or other computers phone push reaches (not this Mac). */
  phoneDevices?: () => number;
  /** Offer the calendar and messages check-in (a connection exists and no check-in is set up). */
  checkinOffer?: () => boolean;
  emit?: (e: BusEvent) => void;
  now?: () => number;
}

/** A check-in item the helper may name. */
interface CheckinItem {
  key: string;
  board: string;
  ticketId: string;
  title: string;
  boardName: string;
  meetingAt: number | null;
  createdAt: string;
}

/** What one wake sees. */
interface Gathered {
  now: number;
  open: WaitRecord[];
  snoozed: Set<string>;
  checkins: CheckinItem[];
  olderCheckins: number;
  states: Map<string, ItemState>;
  newFeedback: string[];
  anything: boolean;
}

/** The status the screens show (GET /api/helper). */
export interface HelperStatus {
  on: boolean;
  model: HelperSettings["model"];
  night: HelperSettings["night"];
  nightOptIn: boolean | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  nextWakeAt: string | null;
  /** Failing: runs failed in a row and why; paused once that reaches 3 (waits go out directly). */
  failures: number;
  failReason: string | null;
  paused: boolean;
  /** No phone channel works: "I can only reach you on this Mac". */
  onlyMac: boolean;
  /** Show the one-time "notifications now come grouped" notice. */
  notice: boolean;
  /** The status line: "Helper on, checked 2:41, nothing waits on you". */
  line: string;
  /** Problem with the line (red on screen). */
  problem: boolean;
  /** Waiting items the helper tracks (not snoozed). */
  waiting: number;
  /** A helper line per waiting ticket, keyed "<board>/<ticketId>". */
  lines: Record<string, string>;
  runs: RunLog[];
}

export class HelperRunner implements HelperSink {
  readonly settings: HelperSettingsStore;
  private state: RunnerState;
  private file: string;
  private now: () => number;
  private busy = false;
  private ticking = false;
  /** A batch of new waits: wake at this time (in memory; a restart re-reports open records). */
  private batchAt: number | null = null;

  constructor(private d: HelperRunnerDeps) {
    this.now = d.now ?? Date.now;
    this.file = join(d.root, "helper-state.json");
    this.settings = new HelperSettingsStore(d.root, this.now);
    this.state = this.load();
    // Plugged in before Notifier.start, so start-up waits come here.
    d.core.setSink(this);
    // The board's buttons and Telegram's go through the runner: taps are noted for the helper, Got it blocks re-alerts.
    d.core.setActions({
      gotIt: (id) => this.tap(() => this.gotIt(id)),
      notUrgent: (id) => this.tap(() => this.notUrgent(id)),
    });
  }

  private load(): RunnerState {
    try {
      return { ...emptyState(), ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    atomicWrite(this.file, JSON.stringify(this.state, null, 1) + "\n");
  }

  private changed(): void {
    this.save();
    this.d.emit?.({ type: "helper.updated" });
  }

  // ---------- HelperSink ----------

  healthy(): boolean {
    return this.state.failures < FAIL_LIMIT;
  }

  lastSuccessAt(): number | null {
    const t = ms(this.state.lastOkAt);
    return Number.isFinite(t) ? t : null;
  }

  onWait(rec: WaitRecord, reason: WaitEventReason): void {
    const now = this.now();
    // At night the fallback digest waits for the morning, with a grace after the night ends: the helper's morning
    // summary goes first.
    const night = this.settings.get().night;
    if (rec.digestAt && inNight(ms(rec.digestAt), night)) this.d.core.waits.update(rec.key, { digestAt: new Date(morningDigestAt(ms(rec.digestAt), night)).toISOString() });
    if (reason === "urgent" || rec.urgent) this.requestWake(now);
    // Not "only when no wake is set": a far-off wake (a snooze's end) must not hold the batch back.
    else this.requestWake(now + BATCH_MS);
    this.d.emit?.({ type: "helper.updated" });
  }

  morning(now: number): number | null {
    const night = this.settings.get().night;
    return inNight(now, night) ? morningDigestAt(now, night) : null;
  }

  /** Wake at this time (or sooner if already due sooner). The loop guard and the failure backoff still apply. */
  requestWake(at: number): void {
    this.batchAt = this.batchAt === null ? at : Math.min(this.batchAt, at);
  }

  /** When the next wake may run: the batch or the chosen time, not before the loop guard or the backoff. null: none. */
  dueAt(): number | null {
    const want = [this.batchAt, ms(this.state.nextWakeAt)].filter((x): x is number => x !== null && Number.isFinite(x));
    if (!want.length) return null;
    let at = Math.min(...want);
    const last = ms(this.state.lastRunAt);
    if (Number.isFinite(last)) at = Math.max(at, last + LOOP_GUARD_MS);
    const failed = ms(this.state.lastFailAt);
    if (this.state.failures > 0 && Number.isFinite(failed)) at = Math.max(at, failed + backoffMs(this.state.failures));
    return at;
  }

  private active(): boolean {
    return this.d.core.plugged(this.d.notifySettings());
  }

  // ---------- the timer ----------

  /** Every ~10 s: reminder steps, safety-net times, then a wake if one is due. */
  async tick(): Promise<void> {
    // Ticks don't overlap: a slow send must not let the next tick fire the same step again.
    if (this.ticking || !this.active()) return;
    this.ticking = true;
    try {
      await this.reminders();
      this.maintain();
      await this.sendHeld();
      const due = this.dueAt();
      if (due !== null && due <= this.now()) await this.wake();
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = 10_000): () => void {
    // First start with the helper: the hello (and the first summary) go out on the first wake.
    // A restart inside a batch: what is open and untold gets its wake (the batch was in memory).
    const untold = this.d.core.waits.open().some((r) => !r.toldAt);
    if (!this.state.helloSentAt || this.d.core.waits.firstSummaryPending || untold) this.requestWake(this.now() + BATCH_MS);
    const run = () => this.tick().catch((e) => console.error("helper: tick", e));
    const timer = trackedInterval("helper", run, intervalMs);
    return () => clearInterval(timer);
  }

  /**
   * Snoozed items wait for their snooze before any fallback sends them, and the helper looks again when a snooze ends
   * (re-set every tick, so a wake during the snooze or a restart doesn't lose it).
   */
  private maintain(): void {
    const now = this.now();
    for (const r of this.d.core.waits.open()) {
      const until = this.snoozed(r);
      if (!until) {
        // Unsnoozed (or the ticket changed) before the end: the safety nets come back from now, not from the old end
        // (a snooze "until I unsnooze" would otherwise leave no digest at all).
        if (r.toldAt) continue;
        const patch: Partial<WaitRecord> = {};
        // Only ends over a day away (a week, no end): a digest moved to the morning stays where the night put it.
        if (r.digestAt && ms(r.digestAt) > now + UNSNOOZED_MAX_MS) patch.digestAt = new Date(now + DIGEST_MS).toISOString();
        if (r.fallbackAt && ms(r.fallbackAt) > now + UNSNOOZED_MAX_MS) patch.fallbackAt = new Date(now + FALLBACK_MS).toISOString();
        if (Object.keys(patch).length) {
          this.d.core.waits.update(r.key, patch);
          // The helper looks at it again soon, before the fallbacks would send it.
          this.requestWake(now + BATCH_MS);
        }
        continue;
      }
      const u = ms(until);
      // No end ("until I unsnooze"): nothing to wake for.
      if (!snoozeForever(until)) this.requestWake(u);
      if (r.toldAt) continue;
      const patch: Partial<WaitRecord> = {};
      if (r.fallbackAt && ms(r.fallbackAt) < u) patch.fallbackAt = until;
      if (r.digestAt && ms(r.digestAt) < u) patch.digestAt = until;
      if (Object.keys(patch).length) this.d.core.waits.update(r.key, patch);
    }
  }

  private snoozed(r: Pick<WaitRecord, "board" | "ticketId">): string | null {
    const until = this.d.snoozedUntil?.(r.board, r.ticketId) ?? null;
    return until && ms(until) > this.now() ? until : null;
  }

  // ---------- what a wake sees ----------

  private checkins(now: number): { list: CheckinItem[]; older: number } {
    const list: CheckinItem[] = [];
    let older = 0;
    for (const p of this.d.store.listProfiles()) {
      for (const t of this.d.store.listTickets(p.slug)) {
        if (!t.raisedBy || t.status === "done") continue;
        const key = `checkin:${p.slug}/${t.id}`;
        const meetingAt = meetingTime(t.title, t.createdAt);
        // A prep item leaves at its meeting time; others are named once, then counted.
        if (meetingAt !== null) {
          if (meetingAt <= now) continue;
        } else if (this.state.named[key]) {
          older++;
          continue;
        }
        list.push({ key, board: p.slug, ticketId: t.id, title: t.title, boardName: p.name, meetingAt, createdAt: t.createdAt });
      }
    }
    return { list, older };
  }

  private gather(now: number, s: HelperSettings): Gathered {
    const open = this.d.core.waits.open();
    const snoozed = new Set(open.filter((r) => this.snoozed(r)).map((r) => r.key));
    const { list: checkins, older } = this.checkins(now);
    const states = new Map<string, ItemState>();
    for (const r of open) {
      states.set(r.key, this.itemState(r, snoozed.has(r.key)));
    }
    for (const c of checkins) states.set(c.key, { open: true, snoozed: false, checkin: true, told: !!this.state.named[c.key], pendingReminders: false, stopped: null });
    const seen = this.state.lastOkAt ?? "";
    const newFeedback = s.feedback.filter((f) => f.at > seen).map((f) => f.text);
    const anything = open.some((r) => !snoozed.has(r.key)) || checkins.some((c) => !this.state.named[c.key]) || newFeedback.length > 0;
    return { now, open, snoozed, checkins, olderCheckins: older, states, newFeedback, anything };
  }

  private itemState(r: WaitRecord, snoozed: boolean): ItemState {
    return { open: !r.closedAt, snoozed, checkin: false, told: !!r.toldAt, pendingReminders: pending(r), stopped: r.remindersStopped ?? null, opened: !!r.openedAt, alerted: alerted(r) };
  }

  private told(r: WaitRecord): InputItem["told"] {
    if (!r.toldAt) return "no";
    if (r.toldVia !== "helper") return "direct";
    return r.reminders.length ? "urgent" : "summary";
  }

  /** The wake's input (exported shape: HelperInput). */
  input(g: Gathered, s: HelperSettings): HelperInput {
    const lastOk = ms(this.state.lastOkAt);
    const items: InputItem[] = g.open.map((r) => {
      const it = this.d.core.item(r);
      return {
        key: r.key, type: "wait", ticket: it.title, board: it.boardName, question: r.question.slice(0, 1500), label: r.label, urgent: !!r.urgent, why: r.why ?? null,
        waitingMin: Math.max(0, Math.round((g.now - (Number.isFinite(ms(r.since)) ? ms(r.since) : ms(r.queuedAt))) / 60_000)),
        new: !Number.isFinite(lastOk) || ms(r.queuedAt) > lastOk, opened: !!r.openedAt, snoozed: g.snoozed.has(r.key), told: this.told(r),
        reminders: pending(r) ? "running" : r.remindersStopped ?? null,
      };
    });
    for (const c of g.checkins) {
      items.push({
        key: c.key, type: "checkin", ticket: c.title, board: c.boardName, question: "Raised for you by a check-in", label: "Check-in", urgent: false, why: null,
        waitingMin: Math.round((g.now - ms(c.createdAt)) / 60_000), new: !this.state.named[c.key], opened: false, snoozed: false,
        told: this.state.named[c.key] ? "summary" : "no", reminders: null, meetingAt: c.meetingAt ? new Date(c.meetingAt).toString() : null,
      });
    }
    const night = inNight(g.now, s.night);
    const askAboutNight = this.state.nightWokeAt && !night ? `You woke the user at ${clockTime(this.state.nightWokeAt)} for: ${this.state.nightWokeFor ?? "an urgent item"}` : null;
    return {
      now: new Date(g.now).toISOString(), localTime: new Date(g.now).toString(),
      night: { start: s.night.start, end: s.night.end, nowIsNight: night, mayWakeAtNight: s.nightOptIn === true },
      boardOnScreen: this.d.onScreen?.() ?? false, items, olderCheckins: g.olderCheckins,
      channels: this.d.core.channels.enabled(this.d.notifySettings()).map((c) => c.name),
      feedback: s.feedback.map((f) => f.text), newFeedback: g.newFeedback, reactions: this.state.reactions.map((r) => r.text),
      notes: this.state.notes, firstSummary: this.d.core.waits.firstSummaryPending, askAboutNight,
      nextSummaryAt: this.nextSummaryAt(g.now, s),
    };
  }

  /** When the last routine summary reached the user (ms), or null. */
  lastSummaryAt(): number | null {
    const m = this.d.core.messages.listNewest().find((x) => x.level === "summary" && x.sends.some((r) => r.ok));
    return m ? Date.parse(m.at) : null;
  }

  /** The next routine summary may go out then (local time text for the helper), or null: one may go now. */
  private nextSummaryAt(now: number, s: HelperSettings): string | null {
    const at = summaryAllowedAt(this.lastSummaryAt(), now, s.night);
    return at === null ? null : new Date(at).toString();
  }

  // ---------- a wake ----------

  /** One wake: look, ask the helper (unless nothing waits), check its decision and carry it out. */
  async wake(): Promise<RunLog | null> {
    if (this.busy || !this.active()) return null;
    this.busy = true;
    const started = this.now();
    this.batchAt = null;
    const s = this.settings.get();
    let entry: RunLog = { at: new Date(started).toISOString(), ok: false };
    try {
      this.state.lastCheckAt = entry.at;
      await this.hello(s);
      const g = this.gather(started, s);
      // While runs fail, the retry asks the helper even with nothing waiting: it is how the helper gets healthy again
      // (waits go out directly meanwhile and never wake it).
      if (!g.anything && this.state.failures === 0) {
        // Nothing waiting, due or new: no model call.
        this.state.nextWakeAt = null;
        if (this.d.core.waits.firstSummaryPending) this.d.core.waits.firstSummaryPending = false;
        entry = { ...entry, ok: true, skipped: true, log: "Nothing waits on you." };
        return entry;
      }
      this.state.lastRunAt = entry.at;
      this.save();
      const res = await this.d.sideCall({ system: HELPER_SYSTEM, prompt: JSON.stringify(this.input(g, s)), model: s.model, jsonSchema: DECISION_SCHEMA, timeoutMs: RUN_TIMEOUT_MS });
      if (!res.ok) {
        // A failed call may still have cost money: it counts in the Helper spend line too.
        if (res.costUsd) {
          addSideSpend(helperSpendFile(this.d.root), "helper", res.costUsd, new Date(this.now()));
          entry = { ...entry, costUsd: res.costUsd };
        }
        return (entry = await this.failed(entry, res.error));
      }
      addSideSpend(helperSpendFile(this.d.root), "helper", res.costUsd, new Date(this.now()));
      entry = { ...entry, costUsd: res.costUsd, model: res.model };
      const parsed = parseDecision(res.text);
      if (!parsed.ok) return (entry = await this.failed(entry, parsed.error));
      // Turned off while the helper thought: the off digest already told what it held; nothing more goes out.
      if (!this.active()) return (entry = { ...entry, ok: true, sends: 0, log: "The helper was turned off during this run: nothing sent." });
      // The decision is 20-90 s old: check it against what waits now.
      const now = this.now();
      const fresh = this.gather(now, s);
      const checked = checkDecision(parsed.raw, {
        now, items: fresh.states, channels: this.d.core.channels.names(), on: this.d.core.channels.enabled(this.d.notifySettings()).map((c) => c.name),
        night: s.night, nightOptIn: s.nightOptIn === true,
      });
      if (!checked.ok) return (entry = await this.failed(entry, checked.error));
      Object.assign(this.state, { failures: 0, failReason: null, pauseSentAt: null, lastOkAt: entry.at, notes: checked.decision.notes });
      const sent = await this.apply(checked.decision, fresh, s);
      entry = { ...entry, ok: true, sends: sent, log: checked.decision.log, ...(checked.decision.fixes.length ? { fixes: checked.decision.fixes } : {}) };
      return entry;
    } catch (e) {
      return (entry = await this.failed(entry, (e as Error).message));
    } finally {
      this.state.runs = [...this.state.runs, entry].slice(-RUNS_KEEP);
      this.busy = false;
      this.changed();
    }
  }

  private async failed(entry: RunLog, error: string): Promise<RunLog> {
    const now = this.now();
    this.state.failures++;
    this.state.failReason = error;
    this.state.lastFailAt = new Date(now).toISOString();
    // Try again after the backoff (dueAt applies it).
    this.state.nextWakeAt = new Date(now).toISOString();
    console.warn(`helper: run failed (${this.state.failures} in a row): ${error}`);
    if (this.state.failures >= FAIL_LIMIT && !this.state.pauseSentAt) {
      this.state.pauseSentAt = new Date(now).toISOString();
      this.save();
      // At night only urgent ones go now; the rest wait for the morning digest.
      const held = this.d.core.holdForMorning(this.d.core.waits.open().filter((r) => !r.toldAt && !this.snoozed(r)));
      if (held.length) await this.d.core.digest(held, "fallback", "The helper couldn't run, so the board sends these itself.");
      const next = Math.round(backoffMs(this.state.failures) / 60_000);
      const text = [
        "The helper can't run right now, so you get each wait directly, one notification per ticket, as before.",
        `What went wrong: ${cut(error, 200)}`,
        `It keeps trying by itself (next try in about ${next} minute${next === 1 ? "" : "s"}) and takes over again once it works.`,
      ].join("\n\n");
      await this.sendOrHold(
        { level: "pause", oneLine: "The helper can't run right now: you get each wait directly", text, why: error },
        { title: "ckanban helper paused", body: "You get each wait directly until it works again", tag: "helper-pause", kind: "pause" },
      );
    }
    return { ...entry, ok: false, error };
  }

  /** Carries out a checked decision; returns how many messages went out. */
  private async apply(dec: CheckedDecision, g: Gathered, s: HelperSettings): Promise<number> {
    let sent = 0;
    const first = this.d.core.waits.firstSummaryPending;
    let firstDone = false;
    /** Urgent alerts that reached no channel: not held, and the helper looks again soon unless a later step retries. */
    const unreached = new Set<string>();
    let retry = false;
    /** A routine summary held by the 3-hour gap: the helper looks again when the gap ends. */
    let gapEnds: number | null = null;
    for (const raw of dec.sends) {
      // Turned off during an earlier send: the off digest took over.
      if (!this.active()) return sent;
      // At send time: still waiting?
      const keys = raw.keys.filter((k) => this.stillOpen(k));
      if (!keys.length) continue;
      const send = raw.oneLine ? raw : { ...raw, oneLine: this.fallbackLine(keys) };
      if (send.level === "urgent") {
        const r = await this.sendUrgent(send, keys, s);
        if (!r.ok) {
          for (const k of r.tried) unreached.add(k);
          if (r.tried.length && r.steps < 2) retry = true;
          continue;
        }
      } else {
        // At most one routine summary every 3 hours in the daytime (not the first one, not the morning one).
        const allowed = first && !firstDone ? null : summaryAllowedAt(this.lastSummaryAt(), this.now(), s.night);
        if (allowed !== null) {
          gapEnds = gapEnds === null ? allowed : Math.min(gapEnds, allowed);
          dec.fixes.push(`held a summary: the last one went out under 3 hours ago; the next may go at ${clockTime(new Date(allowed).toISOString())}`);
          continue;
        }
        if (await this.sendSummary(send, keys, g, first && !firstDone)) firstDone = first;
        else continue;
      }
      sent++;
    }
    if (!this.active()) return sent;
    const night = inNight(this.now(), s.night);
    // The first summary after an upgrade or fresh install names every seeded wait, whatever the helper chose. At
    // night it waits (still pending) for the first wake after the night ends.
    if (first && !night) {
      const seeded = this.d.core.waits.open().filter((r) => r.seeded && !r.toldAt && !g.snoozed.has(r.key)).map((r) => r.key);
      if (seeded.length) {
        const n = seeded.length;
        const line = `${n} ${n === 1 ? "ticket waits" : "tickets wait"} on you`;
        if (await this.sendSummary({ level: "summary", oneLine: line, why: "", keys: seeded, steps: [] }, seeded, g, !firstDone)) sent++;
      }
      this.d.core.waits.firstSummaryPending = false;
    }
    // What it holds: until its next wake (the Inbox line says so), and one held entry in the log.
    // At night the helper looks again by the end of the night at the latest: what it holds goes in the morning summary.
    let next = retry ? Math.min(dec.nextWakeAt, this.now() + URGENT_RETRY_MS) : dec.nextWakeAt;
    if (night) next = Math.min(next, nightEnd(this.now(), s.night));
    if (gapEnds !== null) next = Math.min(next, gapEnds);
    const held = this.d.core.waits.open().filter((r) => !r.toldAt && !g.snoozed.has(r.key) && !unreached.has(r.key));
    if (held.length) {
      // Whatever this wake was for (an urgent alert, a new item), held items get their look: when the 3-hour gap
      // ends, and before the board's own digest would send them.
      const gap = summaryAllowedAt(this.lastSummaryAt(), this.now(), s.night);
      if (gap !== null) next = Math.min(next, gap);
      const digests = held.map((r) => ms(r.digestAt)).filter((t) => Number.isFinite(t));
      const before = digests.length ? Math.min(...digests) - DIGEST_LEAD_MS : NaN;
      if (Number.isFinite(before) && before > this.now()) next = Math.min(next, lookBeforeDigest(before, s.night));
    }
    const nextIso = new Date(next).toISOString();
    for (const r of held) this.d.core.waits.update(r.key, { heldUntil: nextIso });
    if (held.length) {
      const items = held.map((r) => this.d.core.item(r));
      this.d.core.messages.add({
        level: "routine", held: true, oneLine: cut(keptQuietLine(held.length, clockTime(nextIso))),
        text: [dec.log, ...items.map((it, i) => `- ${it.title} (${it.boardName}): ${directLabel(held[i])}`)].filter(Boolean).join("\n"), items,
      });
    }
    this.state.nextWakeAt = nextIso;
    if (sent && this.state.nightWokeAt && !inNight(this.now(), s.night)) this.state.nightWokeAt = this.state.nightWokeFor = null;
    return sent;
  }

  private stillOpen(key: string): boolean {
    if (key.startsWith("checkin:")) {
      const [board, id] = key.slice("checkin:".length).split("/");
      const t = this.d.store.getTicket(board, id);
      return !!t && t.status !== "done";
    }
    const r = this.d.core.waits.get(key);
    return !!r && !r.closedAt;
  }

  /** The line for a send the helper left without one: what the ticket needs, or how many wait. */
  private fallbackLine(keys: string[]): string {
    const recs = keys.map((k) => this.d.core.waits.get(k)).filter((r): r is WaitRecord => !!r);
    if (keys.length === 1 && recs.length === 1) return cut(`${directLabel(recs[0])}: ${this.d.core.item(recs[0]).title}`);
    if (keys.length === 1) return cut(this.checkinItem(keys[0])?.title ?? "1 ticket waits on you");
    return `${keys.length} tickets wait on you`;
  }

  private checkinItem(key: string): MessageItem | null {
    const [board, id] = key.slice("checkin:".length).split("/");
    const t = this.d.store.getTicket(board, id);
    if (!t) return null;
    return { key, board, boardName: this.d.store.getProfile(board)?.name ?? board, ticketId: id, title: t.title, question: "Raised for you by a check-in" };
  }

  private boards(items: MessageItem[]): boolean {
    return new Set(items.map((i) => i.board)).size > 1 || this.d.store.listProfiles().length > 1;
  }

  // ---------- urgent ----------

  /**
   * Sends an urgent alert along its step chain. ok: a channel reached the user. When none did, the records stay untold
   * (so a later step, the next wake or the 4-hour digest still reaches the user) and the failure is logged.
   * One alert per wait: the 2-hour / 6-step cap counts every alert on the wait (a retry after one that reached no one
   * gets what is left of it); a wait past its cap stops as "expired" and isn't sent.
   * The plan and the told mark are written before the send, so Got it, Not urgent or opening the ticket while it is
   * under way stop it, and no fallback or digest sends the same wait meanwhile; the mark is given back if no one was reached.
   */
  private async sendUrgent(send: CheckedSend, keys: string[], s: HelperSettings): Promise<{ ok: boolean; tried: string[]; steps: number }> {
    const now = this.now();
    const recs: WaitRecord[] = [];
    for (const k of keys) {
      const r = this.d.core.waits.get(k);
      if (!r || r.closedAt) continue;
      // Re-checked at send time (an earlier send in this wake may have taken it, or the user tapped meanwhile).
      if (urgentRefusal(this.itemState(r, false))) continue;
      const until = r.remindUntil ? ms(r.remindUntil) : Infinity;
      if (stepsUsed(r) >= REMIND_MAX_STEPS || until <= now) {
        this.d.core.waits.update(k, { remindersStopped: "expired" });
        continue;
      }
      recs.push(r);
    }
    if (!recs.length) return { ok: false, tried: [], steps: 0 };
    keys = recs.map((r) => r.key);
    const until = Math.min(now + REMIND_MAX_MIN * 60_000, ...recs.map((r) => (r.remindUntil ? ms(r.remindUntil) : Infinity)));
    const left = REMIND_MAX_STEPS - Math.max(...recs.map(stepsUsed));
    const steps = send.steps.filter((x, i) => i < left && (i === 0 || now + x.afterMin * 60_000 < until));
    const items = recs.map((r) => this.d.core.item(r));
    const next = steps[1];
    const nextLine = next
      ? `${NEXT_PREFIX} on ${label(next.channel)} at ${clockTime(new Date(now + next.afterMin * 60_000).toISOString())}, until ${clockTime(new Date(until).toISOString())} at most, unless you open it.`
      : NO_REMINDERS;
    const ask = !this.state.firstUrgentAsked ? `${ASK_PREFIX} Tap Got it if this was worth interrupting you, or Not urgent if it wasn't.` : null;
    const boards = this.boards(items);
    const text = [
      send.oneLine, send.why ? `Why: ${send.why}` : null,
      ...items.map((it, i) => `${it.title}${boards ? ` (${it.boardName})` : ""}\n${recs[i].question}\n${this.d.link(it.board, it.ticketId)}`),
      nextLine, ask,
    ].filter(Boolean).join("\n\n");
    const message = this.d.core.messages.add({ level: "urgent", oneLine: send.oneLine, text, why: send.why || null, items });
    const out = this.out(message, items.length === 1 ? items[0].title : "Urgent", send.oneLine, text, true, `urgent-${message.id}`);
    const on = this.d.core.channels.enabled(this.d.notifySettings()).map((c) => c.name);
    const chain = steps.length ? stepChain(steps[0].channel, steps.slice(1).map((x) => x.channel), on) : on;
    const at = new Date(now).toISOString();
    // Claim and plan first (see above).
    const claims = recs.filter((r) => !r.toldAt).map(claimOf);
    this.d.core.markTold(keys, "helper", message.id);
    for (const r of recs) {
      this.d.core.waits.update(r.key, {
        messageId: message.id, heldUntil: null, remindersStopped: null, remindUntil: new Date(until).toISOString(), stepsUsed: stepsUsed(r),
        reminders: [{ channel: steps[0]?.channel ?? "none", dueAt: at, sentAt: at, messageId: message.id }, ...steps.slice(1).map((x) => ({ channel: x.channel, dueAt: new Date(now + x.afterMin * 60_000).toISOString() }))],
      });
    }
    const results = await this.d.core.deliver(message, out, undefined, chain);
    const ok = results.some((r) => r.ok);
    const used = results.find((r) => r.ok)?.channel ?? steps[0]?.channel ?? "none";
    if (!ok) {
      this.d.core.waits.unclaim(claims);
      console.warn(`helper: urgent alert ${message.id} reached no channel (${failures(results)}); it stays untold`);
    }
    // Re-read: only the alert's own step changes; what the user did meanwhile (stops, opening) stays.
    for (const k of keys) {
      const fresh = this.d.core.waits.get(k);
      if (!fresh) continue;
      const reminders = fresh.reminders.map((x) => (x.messageId === message.id && x.dueAt === at ? { ...x, channel: used, ...(ok ? {} : { failed: true }) } : x));
      this.d.core.waits.update(k, { reminders });
    }
    if (ok) {
      this.state.firstUrgentAsked = true;
      if (inNight(now, s.night)) Object.assign(this.state, { nightWokeAt: at, nightWokeFor: send.oneLine });
    }
    this.d.emit?.({ type: "helper.message", id: message.id, level: "urgent", oneLine: send.oneLine });
    return { ok, tried: keys, steps: steps.length };
  }

  private out(m: StoredMessage, title: string, body: string, text: string, urgent: boolean, tag: string): OutBody {
    return { level: m.level, title, body, text, url: (id) => this.d.messageLink(id), tag, urgent, everyDevice: urgent };
  }

  /** Fires reminder steps that are due (one message per alert and step), and ends reminders past the hard expiry. */
  async reminders(): Promise<void> {
    const now = this.now();
    const due = new Map<string, { recs: WaitRecord[]; index: number }>();
    const expired = new Map<string, WaitRecord[]>();
    for (const r of this.d.core.waits.open()) {
      if (!pending(r)) continue;
      if (r.remindUntil && ms(r.remindUntil) <= now) {
        const k = r.messageId ?? r.key;
        expired.set(k, [...(expired.get(k) ?? []), r]);
        continue;
      }
      if (this.snoozed(r)) continue;
      // After sleep or a snooze several steps may be overdue: fire only the latest, skip the ones before it.
      const index = r.reminders.findLastIndex((x) => !x.sentAt && ms(x.dueAt) <= now);
      if (index < 0) continue;
      const at = new Date(now).toISOString();
      if (r.reminders.some((x, i) => i < index && !x.sentAt)) {
        this.d.core.waits.update(r.key, { reminders: r.reminders.map((x, i) => (i < index && !x.sentAt ? { ...x, sentAt: at, skipped: true } : x)) });
      }
      const k = `${r.messageId ?? r.key}|${index}`;
      const g = due.get(k) ?? { recs: [], index };
      g.recs.push(r);
      due.set(k, g);
    }
    for (const [, g] of due) await this.fireStep(g.recs, g.index);
    for (const [, recs] of expired) {
      for (const r of recs) this.d.core.waits.stopReminders(r.key, "expired");
      const items = recs.map((r) => this.d.core.item(r));
      const names = items.map((i) => i.title).join(", ");
      const text = `I've stopped reminding you about ${names}. ${recs.length === 1 ? "It's" : "They're"} still in your Inbox.`;
      await this.sendOrHold({ level: "reminder", oneLine: cut(`I've stopped reminding you: ${names}`), text, items }, { title: "Reminders stopped", body: cut(`I've stopped reminding you: ${names}`), tag: "stopped" });
    }
    if (due.size || expired.size) this.changed();
  }

  private async fireStep(recs: WaitRecord[], index: number): Promise<void> {
    const now = this.now();
    const first = recs[0];
    const orig = first.messageId ? this.d.core.messages.get(first.messageId) : null;
    const items = recs.map((r) => this.d.core.item(r));
    const step = first.reminders[index];
    const total = first.reminders.length;
    const later = first.reminders.slice(index + 1);
    const nextLine = later.length
      ? `Next reminder on ${label(later[0].channel)} at ${clockTime(later[0].dueAt)}${first.remindUntil ? `, until ${clockTime(first.remindUntil)} at most` : ""}.`
      : "This is the last reminder.";
    const oneLine = cut(`Reminder: ${orig?.oneLine ?? items.map((i) => i.title).join(", ")}`);
    const text = [`Reminder ${index + 1} of ${total}, not opened yet.`, (orig ? reminderBody(orig.text) : null) ?? items.map((i) => `${i.title}\n${this.d.link(i.board, i.ticketId)}`).join("\n\n"), nextLine].join("\n\n");
    const message = this.d.core.messages.add({ level: "reminder", oneLine, text, why: orig?.why ?? null, items });
    // Claim the step before sending: nothing fires it a second time while the send is under way.
    const claimed = new Date(now).toISOString();
    for (const r of recs) {
      const fresh = this.d.core.waits.get(r.key);
      if (fresh) this.d.core.waits.update(r.key, { reminders: fresh.reminders.map((x, i) => (i === index ? { ...x, sentAt: claimed, messageId: message.id } : x)) });
    }
    const on = this.d.core.channels.enabled(this.d.notifySettings()).map((c) => c.name);
    // A failed send moves to the next planned channel at once (then any other that is on; a phone step tries this Mac last).
    const results = await this.d.core.deliver(message, this.out(message, items.length === 1 ? items[0].title : "Reminder", oneLine, text, true, `urgent-${first.messageId ?? message.id}`), undefined,
      stepChain(step.channel, later.map((x) => x.channel), on));
    const ok = results.some((r) => r.ok);
    const used = results.find((r) => r.ok)?.channel ?? step.channel;
    const at = new Date(now).toISOString();
    // The first alert may have reached no one: the first step that gets through tells the records.
    const untold = recs.map((r) => this.d.core.waits.get(r.key)).filter((r): r is WaitRecord => !!r && !r.toldAt).map((r) => r.key);
    if (ok) this.d.core.markTold(untold, "helper", message.id);
    else {
      console.warn(`helper: reminder ${message.id} reached no channel (${failures(results)})`);
      // Nothing told yet and no step left: the helper looks again soon (the 4-hour digest is the backstop).
      if (untold.length && !later.length) this.requestWake(now + URGENT_RETRY_MS);
    }
    for (const r of recs) {
      const fresh = this.d.core.waits.get(r.key);
      if (!fresh) continue;
      const reminders = fresh.reminders.map((x, i) => (i === index ? { ...x, channel: used, sentAt: at, messageId: message.id, ...(ok ? {} : { failed: true }) } : x));
      const done = { ...fresh, reminders };
      // The last step: this wait's reminders are over (no new alert on it; "expired"). One that reached no one yet may still be retried.
      const over = !later.length && !fresh.remindersStopped && !pending(done) && alerted(done);
      this.d.core.waits.update(r.key, { reminders, ...(over ? { remindersStopped: "expired" } : {}) });
    }
    this.d.emit?.({ type: "helper.message", id: message.id, level: "reminder", oneLine });
  }

  // ---------- summaries ----------

  private async sendSummary(send: CheckedSend, keys: string[], g: Gathered, first: boolean): Promise<StoredMessage | null> {
    const waitKeys = keys.filter((k) => !k.startsWith("checkin:"));
    const checkKeys = keys.filter((k) => k.startsWith("checkin:"));
    const named = waitKeys.map((k) => this.d.core.waits.get(k)!).filter(Boolean);
    const fresh = named.filter((r) => !r.toldAt);
    const freshKeys = new Set(fresh.map((r) => r.key));
    const still = this.d.core.waits.open().filter((r) => r.toldAt && !freshKeys.has(r.key) && !g.snoozed.has(r.key));
    const newChecks = checkKeys.map((k) => this.checkinItem(k)).filter((x): x is MessageItem => !!x);
    if (!fresh.length && !newChecks.some((c) => !this.state.named[c.key!])) return null;
    const freshItems = fresh.map((r) => this.d.core.item(r));
    const stillItems = still.map((r) => this.d.core.item(r));
    const boards = this.boards([...freshItems, ...stillItems, ...newChecks]);
    const total = fresh.length + still.length;
    // The board writes the count itself (the helper's own count can be off).
    send = { ...send, oneLine: summaryLine(total, send.oneLine) };
    const offer = first && this.d.checkinOffer?.()
      ? "Want me to watch your calendar and messages too? Set up a check-in in Schedules → Proactive check-ins (one tap: Set up check-ins)." : null;
    const input = (it: MessageItem, r: WaitRecord): SummaryInput => ({ ...it, label: directLabel(r), since: r.since || r.queuedAt });
    const checkinSince = (c: MessageItem) => this.d.store.getTicket(c.board, c.ticketId)?.createdAt ?? new Date(this.now()).toISOString();
    const { text, view } = buildSummary({
      headline: send.oneLine,
      fresh: fresh.map((r, i) => input(freshItems[i], r)),
      still: still.map((r, i) => input(stillItems[i], r)),
      checkins: newChecks.map((c) => ({ ...c, label: c.title.toLowerCase().startsWith("prep:") ? "prep ready" : "raised for you", since: checkinSince(c) })),
      olderCheckins: g.olderCheckins,
      notes: [first ? "This is your first summary from the helper. Routine things come grouped like this; only urgent ones interrupt you." : null, offer].filter((x): x is string => !!x),
      boards, now: this.now(),
    });
    const title = total ? (total === 1 ? "1 ticket waits on you" : `${total} tickets wait on you`) : "From your check-ins";
    // A summary's why is the helper's own reasoning: it stays out of the text and the page.
    const message = this.d.core.messages.add({ level: "summary", oneLine: send.oneLine, text, why: null, items: [...freshItems, ...newChecks, ...stillItems], summary: view });
    // Told before the send (a claim): the 4-hour digest or a restart meanwhile doesn't send these again. Given back
    // when the send reached no channel, so the next message or the digest still tells them.
    const claims = fresh.map(claimOf);
    this.d.core.markTold(fresh.map((r) => r.key), "helper", message.id);
    for (const r of fresh) this.d.core.waits.update(r.key, { heldUntil: null, messageId: message.id });
    const results = await this.d.core.deliver(message, this.out(message, title, send.oneLine, text, false, "helper-summary"));
    const tried = results.filter((r) => !r.skipped);
    if (tried.length && !tried.some((r) => r.ok)) {
      this.d.core.waits.unclaim(claims);
      console.warn(`helper: summary ${message.id} reached no channel (${failures(results)}); its new items stay untold`);
    }
    const at = new Date(this.now()).toISOString();
    for (const c of newChecks) this.state.named[c.key!] = at;
    this.d.emit?.({ type: "helper.message", id: message.id, level: "summary", oneLine: send.oneLine });
    return message;
  }

  // ---------- first run ----------

  /** The first successful look: a hello on each channel that is on (it doubles as the channel test). */
  private async hello(s: HelperSettings): Promise<void> {
    if (this.state.helloSentAt) return;
    this.state.helloSentAt = new Date(this.now()).toISOString();
    this.save();
    const text = [
      "Hi, I'm the helper. I now sit in front of your ckanban notifications: routine things come grouped in a summary, and only urgent ones interrupt you, repeating until you act.",
      "Tap any message to read it in full. If you got this, this channel works.",
      `My night is ${s.night.start} to ${s.night.end}; change it in Settings. Alerts need this Mac on and awake; a closed lid means no alerts.`,
      "ntfy can get through Focus if you allow the ntfy app in that Focus; for Telegram, allow Telegram in your Focus (not guaranteed).",
    ].join("\n\n");
    await this.sendOrHold(
      { level: "hello", oneLine: "Hi, I'm the helper: routine things come grouped, urgent ones interrupt", text },
      { title: "ckanban helper", body: "Routine things come grouped now; only urgent ones interrupt you", tag: "helper-hello" },
    );
  }

  // ---------- held for the morning ----------

  /**
   * The board's own non-urgent messages (hello, pause, reminders stopped): stored now, and sent now, or during the
   * user's night held until it ends (only urgent alerts may interrupt at night).
   */
  private async sendOrHold(m: NewMessage, o: Omit<HeldSend, "messageId">): Promise<void> {
    const message = this.d.core.messages.add(m);
    if (inNight(this.now(), this.settings.get().night)) {
      this.state.heldSends = [...this.state.heldSends, { messageId: message.id, ...o }];
      this.save();
      this.requestWake(nightEnd(this.now(), this.settings.get().night));
      return;
    }
    await this.d.core.deliver(message, this.heldOut(message, o));
  }

  private heldOut(message: StoredMessage, o: Omit<HeldSend, "messageId">): OutBody {
    const tag = o.tag === "stopped" ? `stopped-${message.id}` : o.tag;
    return { level: message.level, title: o.title, body: o.body, text: message.text, url: (id) => this.d.messageLink(id), tag };
  }

  /** The night is over: the held messages go out (a pause notice only if the helper still can't run). */
  private async sendHeld(): Promise<void> {
    if (!this.state.heldSends.length || inNight(this.now(), this.settings.get().night)) return;
    const held = this.state.heldSends;
    // Claimed before the sends: a slow send or a restart doesn't send them twice.
    this.state.heldSends = [];
    this.save();
    for (const x of held) {
      if (!this.active()) return;
      if (x.kind === "pause" && this.healthy()) continue;
      const message = this.d.core.messages.get(x.messageId);
      if (message) await this.d.core.deliver(message, this.heldOut(message, x));
    }
    this.changed();
  }

  // ---------- the user's taps ----------

  private react(text: string): void {
    this.state.reactions = [...this.state.reactions, { at: new Date(this.now()).toISOString(), text }].slice(-REACTIONS_KEEP);
  }

  private tapped(messageId: string, key?: string | null): { message: StoredMessage; recs: WaitRecord[] } {
    const message = this.d.core.messages.get(messageId);
    if (!message) throw new HelperError("message not found", 404);
    const keys = message.items.map((i) => i.key).filter((k): k is string => !!k && (!key || k === key));
    const recs = keys.map((k) => this.d.core.waits.get(k)).filter((r): r is WaitRecord => !!r);
    this.d.core.messages.markRead(message.id);
    return { message, recs };
  }

  /** Marks the tap on the tapped message and on the alert and reminders it belongs to, so each of their pages shows it. */
  private markTapped(message: StoredMessage, recs: WaitRecord[], how: "got-it" | "not-urgent"): void {
    const ids = new Set([message.id]);
    for (const r of recs) {
      if (r.messageId) ids.add(r.messageId);
      for (const x of r.reminders) if (x.messageId) ids.add(x.messageId);
    }
    for (const id of ids) this.d.core.messages.markTapped(id, how);
  }

  private tap(f: () => { text: string }): string {
    try {
      return f().text;
    } catch (e) {
      return e instanceof HelperError && e.status === 404 ? "That message is gone." : `That didn't work: ${(e as Error).message}`;
    }
  }

  /** Got it: reminders for this message's items stop, and don't come back. */
  gotIt(messageId: string, key?: string | null): { stopped: number; text: string } {
    const { message, recs } = this.tapped(messageId, key);
    this.markTapped(message, recs, "got-it");
    let stopped = 0;
    for (const r of recs) {
      if (this.d.core.waits.stopReminders(r.key, "got-it")) stopped++;
      // Got it on an urgent alert: no re-alert later. On a summary it is only "seen".
      else if (!r.remindersStopped && r.reminders.length) this.d.core.waits.update(r.key, { remindersStopped: "got-it" });
    }
    const names = recs.map((r) => this.d.core.item(r).title).join(", ") || "this";
    this.react(`Got it on "${names}" at ${clockTime(new Date(this.now()).toISOString())}`);
    this.changed();
    return { stopped, text: stopped ? `Got it: no more reminders for ${names}` : `Got it: ${names}` };
  }

  /** Not urgent: that item's reminders stop at once. */
  notUrgent(messageId: string, key?: string | null): { stopped: number; text: string } {
    const { message, recs } = this.tapped(messageId, key);
    this.markTapped(message, recs, "not-urgent");
    let stopped = 0;
    for (const r of recs) {
      if (this.d.core.waits.stopReminders(r.key, "not-urgent")) stopped++;
      else this.d.core.waits.update(r.key, { remindersStopped: "not-urgent" });
    }
    const names = recs.map((r) => this.d.core.item(r).title).join(", ") || "this";
    this.react(`Not urgent on "${names}"`);
    this.changed();
    return { stopped, text: `Stopped reminders for ${names}` };
  }

  /** Should have pinged me, on a held item: a feedback line, and the helper looks again at once. */
  shouldHavePinged(board: string, ticketId: string): { text: string } {
    const recs = this.d.core.waits.openFor(board, ticketId);
    const t = this.d.store.getTicket(board, ticketId);
    if (!t) throw new HelperError("ticket not found", 404);
    const what = recs[0] ? directLabel(recs[0]) : "what it waited on";
    const line = this.settings.addFeedback(cut(`Should have pinged me about "${t.title}": ${what}`, 300), "should-have-pinged");
    this.react(`Should have pinged me on "${t.title}"`);
    this.requestWake(this.now());
    this.changed();
    return { text: line.text };
  }

  /** A feedback line was added: the helper looks again at once (the loop guard applies). */
  feedbackAdded(): void {
    this.requestWake(this.now());
    this.changed();
  }

  noticeSeen(): void {
    if (this.state.noticeSeenAt) return;
    this.state.noticeSeenAt = new Date(this.now()).toISOString();
    this.changed();
  }

  // ---------- keep awake, status ----------

  /** Keep the Mac awake: an urgent item is open, a wake or reminder is due within 15 minutes, or a fallback is. */
  wantsAwake(): boolean {
    if (!this.active()) return false;
    const now = this.now();
    const soon = now + AWAKE_AHEAD_MS;
    const due = this.dueAt();
    if (due !== null && due <= soon) return true;
    for (const r of this.d.core.waits.open()) {
      if (pending(r)) return true;
      const stopped = r.remindersStopped === "got-it" || r.remindersStopped === "not-urgent";
      if (r.urgent && !r.toldAt && !stopped) return true;
      if (!r.toldAt && ((r.fallbackAt && ms(r.fallbackAt) <= soon) || (r.digestAt && ms(r.digestAt) <= soon))) return true;
    }
    return false;
  }

  /** The helper line for one record, or null. */
  lineFor(r: WaitRecord): string | null {
    if (this.snoozed(r)) return "Snoozed: the helper leaves it out until the snooze ends";
    if (r.reminders.length) {
      const trail = r.reminders.filter((x) => !x.skipped).map((x) => `${label(x.channel)} ${clockTime(x.sentAt ?? x.dueAt)}${x.failed ? " (didn't get through)" : ""}`).join(", ");
      if (r.remindersStopped === "got-it") return `Urgent: ${trail}; you tapped Got it`;
      if (r.remindersStopped === "not-urgent") return `Urgent: ${trail}; you said not urgent`;
      if (r.remindersStopped === "expired") return `Urgent: ${trail}; reminders stopped`;
      return `Urgent: ${trail}`;
    }
    if (r.toldAt) {
      if (r.toldVia === "helper") return `In the ${clockTime(r.toldAt)} summary`;
      if (r.toldVia === "direct" || r.toldVia === "digest") return `Sent directly at ${clockTime(r.toldAt)}`;
      return null;
    }
    if (r.heldUntil) return `In the ${clockTime(r.heldUntil)} summary: ${directLabel(r)}`;
    return "With the helper: it looks within a minute or two";
  }

  status(): HelperStatus {
    const ns = this.d.notifySettings();
    const s = this.settings.get();
    const on = this.d.core.plugged(ns);
    const open = this.d.core.waits.open();
    const lines: Record<string, string> = {};
    let waiting = 0;
    if (on) {
      // Urgent and untold records first: the most telling line wins per ticket.
      const rank = (r: WaitRecord) => (pending(r) ? 0 : !r.toldAt ? 1 : 2);
      for (const r of [...open].sort((a, b) => rank(a) - rank(b))) {
        if (!this.snoozed(r)) waiting++;
        const k = `${r.board}/${r.ticketId}`;
        if (lines[k]) continue;
        const l = this.lineFor(r);
        if (l) lines[k] = l;
      }
    }
    const enabled = this.d.core.channels.enabled(ns).map((c) => c.name);
    const onlyMac = !enabled.some((n) => n !== "mac" && n !== "push") && !(this.d.phoneDevices?.() ?? 0);
    const paused = this.state.failures >= FAIL_LIMIT;
    const checked = this.state.lastCheckAt ? `checked ${clockTime(this.state.lastCheckAt)}` : "not checked yet";
    const line = !on
      ? "Helper off: you get one notification per wait"
      : paused
        ? `Helper paused: ${cut(this.state.failReason ?? "its runs fail", 80)}. You get each wait directly.`
        : this.state.failures
          ? `Helper on, last try failed: ${cut(this.state.failReason ?? "", 80)}`
          : `Helper on, ${checked}, ${waiting ? `${waiting} wait${waiting === 1 ? "s" : ""} on you` : "nothing waits on you"}`;
    return {
      on, model: s.model, night: s.night, nightOptIn: s.nightOptIn, lastCheckAt: this.state.lastCheckAt, lastOkAt: this.state.lastOkAt,
      nextWakeAt: on && this.dueAt() !== null ? new Date(this.dueAt()!).toISOString() : null,
      failures: this.state.failures, failReason: this.state.failReason, paused, onlyMac, notice: !this.state.noticeSeenAt, line,
      problem: on && this.state.failures > 0, waiting, lines, runs: this.state.runs.slice(-10),
    };
  }
}

export class HelperError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const unique = (xs: string[]) => [...new Set(xs)];

/** A count the helper put at the start of a summary line: "6 tickets wait on you: ", "5 wait on you - ", "3 need you, ". */
const LEADING_COUNT = /^\s*\d+\s+(?:[\p{L}-]+\s+){0,3}?(?:waits?|are\s+waiting|is\s+waiting|needs?\s+you|need\s+your\s+\w+)(?:\s+on\s+you|\s+for\s+you)?\s*(?:[:,.;\u2014\u2013-]\s*)?/iu;

/**
 * A summary's one line with the board's own count: "N wait on you", then what the helper said is new (its own
 * leading count, if any, dropped). No count when nothing waits (check-ins only).
 */
export function summaryLine(total: number, line: string): string {
  const rest = line.replace(LEADING_COUNT, "").trim();
  if (!total) return cut(rest || line.trim());
  const head = `${total} ${total === 1 ? "waits" : "wait"} on you`;
  return cut(rest ? `${head}: ${rest}` : head);
}

/** The urgent alert's own plan and question lines (a reminder leaves them out: it says its own next step). */
const NEXT_PREFIX = "Next: I'll remind you";
const NO_REMINDERS = "No reminders planned: this is the only alert.";
const ASK_PREFIX = "Right call?";

/** A reminder's text from the alert's: the alert without its closing "Next: ..." and "Right call?" lines. */
export function reminderBody(text: string): string {
  const parts = text.split("\n\n");
  const plan = (p: string) => p.startsWith(NEXT_PREFIX) || p === NO_REMINDERS || p.startsWith(ASK_PREFIX);
  while (parts.length > 1 && plan(parts.at(-1)!)) parts.pop();
  return parts.join("\n\n");
}

/**
 * The fail-over order for one step: its own channel, then the later planned ones, then any other that is on. A step
 * meant for the phone (any channel but this Mac) tries every other phone channel before falling back to this Mac.
 */
export function stepChain(channel: string, later: string[], on: string[]): string[] {
  const chain = unique([channel, ...later, ...on]);
  return channel === "mac" ? chain : [...chain.filter((c) => c !== "mac"), ...chain.filter((c) => c === "mac")];
}

/** What went wrong on each channel, for the log. */
const failures = (results: { channel: string; error?: string | null }[]) =>
  results.length ? results.map((r) => `${r.channel}: ${r.error ?? "not reached"}`).join("; ") : "no channel is on";
