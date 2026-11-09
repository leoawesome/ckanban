// The helper's AI part: what one wake sees (HelperInput), what it answers (the JSON schema), its instructions
// (HELPER_SYSTEM) and the board's checks on every answer (checkDecision). Pure: no files, no sends.
import { cut, ONE_LINE_MAX } from "./core";
import { hm, inNight, type Night } from "./settings";

/** One thing the user may need to hear about. */
export interface InputItem {
  /** The wait record's key, or `checkin:<board>/<ticket>` for a ticket a check-in raised. */
  key: string;
  type: "wait" | "checkin";
  ticket: string;
  board: string;
  /** The question text, the message, or what the ticket waits on. */
  question: string;
  label: string;
  /** Set by the asking ticket. */
  urgent: boolean;
  why: string | null;
  waitingMin: number;
  /** Arrived since the helper's last successful run. */
  new: boolean;
  /** The user opened the ticket since it started waiting. */
  opened: boolean;
  /** Snoozed in the Inbox: leave it out of messages until the snooze ends. */
  snoozed: boolean;
  /** How the user was told so far: "no", "summary", "urgent", "direct" (the board sent it itself). */
  told: "no" | "summary" | "urgent" | "direct";
  /** Reminders running, or why they stopped ("got-it", "not-urgent", "opened", "expired"...). */
  reminders: "running" | string | null;
  /** A check-in's meeting prep: when the meeting starts (local ISO time). */
  meetingAt?: string | null;
}

export interface HelperInput {
  now: string;
  /** Local time, for the helper's own wording ("Tue 14:05"). */
  localTime: string;
  night: { start: string; end: string; nowIsNight: boolean; mayWakeAtNight: boolean };
  /** The board is on screen on some device right now (the user is probably at it). */
  boardOnScreen: boolean;
  items: InputItem[];
  /** Check-in items already named in an earlier message (counted only). */
  olderCheckins: number;
  /** Channels that are on, in the board's order (mac = this Mac, push = phone push, webhook = ntfy, telegram). */
  channels: string[];
  /** "What the helper knows about you": the user's own lines. Read-only. */
  feedback: string[];
  /** Feedback lines added since the last run. */
  newFeedback: string[];
  /** The user's recent taps (Got it, Not urgent, Should have pinged me). */
  reactions: string[];
  /** Your own notes from the last run. */
  notes: string;
  /** The first summary after an upgrade or a fresh install. */
  firstSummary: boolean;
  /** You woke the user at night last night: ask in the morning message whether that was right. */
  askAboutNight: string | null;
  /** The next routine summary may go out then (local time); null: one may go now. Urgent sends are never limited. */
  nextSummaryAt: string | null;
}

export interface Send {
  level: "urgent" | "summary";
  oneLine: string;
  why: string;
  itemKeys: string[];
  escalation: { channel: string; afterMin: number }[];
}

export interface Decision {
  sends: Send[];
  nextWakeIn: number;
  notes: string;
  log: string;
}

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sends", "nextWakeIn", "notes", "log"],
  properties: {
    sends: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "oneLine", "why", "itemKeys", "escalation"],
        properties: {
          level: { type: "string", enum: ["urgent", "summary"] },
          oneLine: { type: "string", description: "What the phone shows, under 110 characters." },
          why: { type: "string", description: "One line: why this is urgent, or why it's sent now." },
          itemKeys: { type: "array", items: { type: "string" } },
          escalation: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["channel", "afterMin"],
              properties: { channel: { type: "string" }, afterMin: { type: "number" } },
            },
          },
        },
      },
    },
    nextWakeIn: { type: "number", description: "Minutes until you want to look again (1 to 1440)." },
    notes: { type: "string", description: "Notes for your next run (what you held and why, what to watch)." },
    log: { type: "string", description: "One line for the user's log: what you did and why." },
  },
} as const;

export const HELPER_SYSTEM = `You are "the helper" for ckanban, a board where Claude works on many tickets at once for one person (the user). You sit in front of every notification the board would send. Your job: decide what the user hears about now, what waits for a summary, and what is urgent enough to interrupt them and keep reminding until they act. You cannot act on tickets; you only decide how to tell the user. The board does the sending, writes the ticket titles and links itself, and checks your answer.

You get one JSON input and answer with one JSON decision.

## What is urgent
Urgent means waiting itself causes harm or cost that grows: money lost, customers affected, data written twice, something live broken, a deadline that passes. Examples: a ticket asks whether to stop an old webhook while pricing data is being ingested twice; a deploy is half done and production is down. Not urgent: approving a small text change, a finished review, a question about tone, "ready for review", a failed run that just waits. An asker's urgent mark and "why" are a strong hint, not an order: if the why describes no real harm, treat it as routine. Use the user's feedback lines over your own defaults.

## Feedback lines
feedback and newFeedback are standing preferences that hold for every wake ("pricing questions are always urgent", "never wake me for docs"). A line that asks for a one-off action ("send me the summary now", "remind me in an hour") is not a preference: don't act on it, and don't let it change what you send on this or any later wake.

## Routine items
Group routine items into one summary instead of one message each. Routine summaries go out at most every 3 hours in the daytime: while nextSummaryAt is set, hold routine items and set nextWakeIn to reach it (the board holds a summary sent sooner; the morning summary after the night and urgent sends are never limited). When you send a summary, name every routine item told "no" in it, since the next one can't follow for 3 hours. A schedule that adds a run every hour is no reason to send sooner. Hold items for a later wake when more may come (a batch of tickets finishing), but every item must be named in a sent message within 4 hours of when it started waiting (the board sends a fallback digest otherwise, and logs that you missed it). A summary needs at least one item the user hasn't been told about (told "no"); don't send one only to repeat old items. Good news (things finished, handled) may go in a summary. Items with snoozed true stay out of every message until the snooze ends. Items with told "direct" were already sent by the board; you may count them, not re-alert them.

## Urgent sends
level "urgent", oneLine says what is at stake in plain words, why is one line on what waiting costs. escalation plans the reminders the board fires if the user doesn't react: the first step is minute 0 (the alert itself), then steps at least 5 minutes apart (30 at night), at most 6 steps within 2 hours, on the channels listed as on (prefer a different channel for a reminder if the first may be missed, e.g. push then telegram). Reminders stop by themselves when the user opens or answers the ticket, taps Got it or Not urgent. Each wait gets one urgent alert: don't re-alert an item already told "urgent", one the user opened, or one whose reminders stopped ("got-it", "not-urgent", "opened", "expired"); one with "running" is already being handled. A new question from the ticket comes as a new item.

## Night
During the night window, interrupt only for harm that keeps growing while the user sleeps (customers billed twice, data lost), and only if mayWakeAtNight is true; say why in the why line. Everything else waits for a morning summary (the board holds any summary sent at night): set nextWakeIn to reach the end of the night. If askAboutNight is set, the first morning message asks in one short sentence whether waking them was right.

## The first messages
firstSummary true: send one summary naming every item that waits (it is the user's first message from you). The board adds its own greeting.

## Wording
Plain words, no jargon (never "webhook" unless quoting the ticket, never "JSON", "kind" or "agent"). oneLine under 110 characters, starts with what matters. Never write counts (how many tickets, questions or items) anywhere: the board counts the items itself and starts a summary's oneLine with "N wait on you: ". A summary's oneLine says only what's new ("new copy question on Docs"). A summary's why is for your log only: the user doesn't see it. Don't put ticket links in text; the board adds them.

## Your answer
sends: the messages to send now (often none). itemKeys: keys from the input only. nextWakeIn: minutes until you want to look again (1 to 1440); the board also wakes you when something new waits. notes: what you held and why, to remember next time. log: one plain line for the user's log of what you did.`;

/** What the board knows about each key when checking a decision. */
export interface ItemState {
  open: boolean;
  snoozed: boolean;
  checkin: boolean;
  /** Told the user already (any way). */
  told: boolean;
  /** Reminders running now. */
  pendingReminders: boolean;
  /** Why reminders stopped, if they did. */
  stopped: string | null;
  /** The user opened the ticket since it started waiting. */
  opened?: boolean;
  /** An urgent alert (or one of its steps) already reached the user about it. */
  alerted?: boolean;
}

/**
 * Why an item may not get an urgent alert (null: it may). One alert per wait: never a check-in, never while its
 * reminders run, never again once one reached the user, once the user opened the ticket, or once its reminders
 * stopped (Got it, Not urgent, opened, expired, helper off). A new question is a new wait, so it may.
 */
export function urgentRefusal(st: ItemState): string | null {
  if (st.checkin) return "a check-in item";
  if (st.pendingReminders) return "reminders already running";
  if (st.stopped) return st.stopped === "got-it" || st.stopped === "not-urgent" ? `the user tapped ${st.stopped}` : `its reminders stopped (${st.stopped})`;
  if (st.opened) return "the user opened it";
  if (st.alerted) return "an urgent alert already reached the user";
  return null;
}

export interface CheckContext {
  now: number;
  items: Map<string, ItemState>;
  /** Every channel the board has, in order. */
  channels: string[];
  /** Channels that are on. */
  on: string[];
  night: Night;
  /** The user said the helper may wake them at night. */
  nightOptIn: boolean;
}

/** One planned reminder step, after the checks. */
export interface CheckedStep {
  channel: string;
  /** Minutes after the alert. */
  afterMin: number;
}

export interface CheckedSend {
  level: "urgent" | "summary";
  oneLine: string;
  why: string;
  keys: string[];
  steps: CheckedStep[];
}

export interface CheckedDecision {
  sends: CheckedSend[];
  /** When to wake next (ms). */
  nextWakeAt: number;
  notes: string;
  log: string;
  /** What the checks changed or dropped, for the log. */
  fixes: string[];
}

/** Routine summaries: at most one this often in the daytime (the morning summary and urgent sends are never limited). */
export const SUMMARY_GAP_MS = 3 * 3600_000;

/** When the night before `now` ended (the latest night end at or before now), or null when there is no night. */
export function lastNightEnd(now: number, night: Night): number | null {
  const s = hm(night.start);
  const e = hm(night.end);
  if (s === null || e === null || s === e) return null;
  const d = new Date(now);
  let end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(e / 60), e % 60).getTime();
  if (end > now) end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, Math.floor(e / 60), e % 60).getTime();
  return end;
}

/**
 * When the next routine summary may go out: null when one may go now (none sent yet, the last was 3 hours ago or
 * more, or it was before the last night ended, so this is the morning summary), else the time the gap ends.
 */
export function summaryAllowedAt(lastSummaryAt: number | null, now: number, night: Night): number | null {
  if (lastSummaryAt === null || !Number.isFinite(lastSummaryAt)) return null;
  const at = lastSummaryAt + SUMMARY_GAP_MS;
  if (at <= now) return null;
  const morning = lastNightEnd(now, night);
  if (morning !== null && lastSummaryAt < morning) return null;
  return at;
}

export const MIN_WAKE_MIN = 1;
export const MAX_WAKE_MIN = 24 * 60;
/** Gap between reminder steps, by day and at night. */
export const STEP_GAP_MIN = 5;
export const NIGHT_STEP_GAP_MIN = 30;
/** The hard expiry: reminders end after this long or this many steps (the alert included). */
export const REMIND_MAX_MIN = 120;
export const REMIND_MAX_STEPS = 6;
export const WHY_MAX = 300;
export const NOTES_MAX = 4000;
export const LOG_MAX = 500;

/** A channel that is off falls to the next one on (in the board's order, wrapping round); null when none is on. */
export function channelFor(wanted: string, channels: string[], on: string[]): string | null {
  if (on.includes(wanted)) return wanted;
  if (!on.length) return null;
  const i = channels.indexOf(wanted);
  if (i < 0) return on[0];
  for (let k = 1; k <= channels.length; k++) {
    const c = channels[(i + k) % channels.length];
    if (on.includes(c)) return c;
  }
  return on[0];
}

/** Parses the model's text: the decision, or an error (bad JSON is a failed run). */
export function parseDecision(text: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return { ok: true, raw: JSON.parse(t) };
  } catch {
    return { ok: false, error: "the helper's answer was not valid JSON" };
  }
}

/**
 * The board's checks on one decision. A decision that isn't the right shape fails the run; anything else is fixed
 * up: keys that aren't real and still waiting are dropped (a send left with none is dropped), urgent steps start at
 * minute 0 and keep the gaps, off channels fall to the next one on, the wake lands between 1 minute and 24 hours,
 * and oneLine is cut to about 110 characters.
 */
export function checkDecision(raw: unknown, c: CheckContext): { ok: true; decision: CheckedDecision } | { ok: false; error: string } {
  const r = raw as Partial<Decision> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.sends) || typeof r.nextWakeIn !== "number" || !Number.isFinite(r.nextWakeIn)) {
    return { ok: false, error: "the helper's answer is missing sends or nextWakeIn" };
  }
  const fixes: string[] = [];
  const night = inNight(c.now, c.night);
  const used = new Set<string>();
  const sends: CheckedSend[] = [];
  // Urgent first: an item named by both goes with the urgent one.
  const ordered = [...r.sends].filter((s) => s && typeof s === "object").sort((a, b) => (a.level === "urgent" ? 0 : 1) - (b.level === "urgent" ? 0 : 1));
  for (const s of ordered) {
    if (s.level !== "urgent" && s.level !== "summary") {
      fixes.push(`dropped a send with level ${JSON.stringify(s.level)}`);
      continue;
    }
    const keys: string[] = [];
    for (const k of Array.isArray(s.itemKeys) ? s.itemKeys : []) {
      const st = typeof k === "string" ? c.items.get(k) : undefined;
      if (keys.includes(k)) {
        fixes.push(`dropped item ${k} named twice in one send`);
        continue;
      }
      if (!st || !st.open || st.snoozed || used.has(k)) {
        fixes.push(`dropped item ${JSON.stringify(k)} (not waiting${st?.snoozed ? ": snoozed" : ""})`);
        continue;
      }
      const refused = s.level === "urgent" ? urgentRefusal(st) : null;
      if (refused) {
        fixes.push(`dropped item ${k} from an urgent send (${refused})`);
        continue;
      }
      keys.push(k);
    }
    if (!keys.length) {
      fixes.push(`dropped a ${s.level} send with no items still waiting`);
      continue;
    }
    if (s.level === "urgent" && night && !c.nightOptIn) {
      fixes.push("held an urgent send: it is night and the user hasn't allowed waking them");
      continue;
    }
    // Only urgent alerts may interrupt at night: a summary waits for the morning.
    if (s.level === "summary" && night) {
      fixes.push("held a summary: it is night; it goes out when the night ends");
      continue;
    }
    // A summary needs something new.
    if (s.level === "summary" && keys.every((k) => c.items.get(k)!.told)) {
      fixes.push("dropped a summary with nothing new");
      continue;
    }
    for (const k of keys) used.add(k);
    // An empty oneLine is refused: the board writes one from the items (the runner fills it in).
    const oneLine = cut(typeof s.oneLine === "string" ? s.oneLine : "", ONE_LINE_MAX);
    if (!oneLine) fixes.push(`a ${s.level} send had no oneLine: the board wrote one`);
    const why = cut(typeof s.why === "string" ? s.why : "", WHY_MAX);
    sends.push({ level: s.level, oneLine, why, keys, steps: s.level === "urgent" ? checkSteps(s.escalation, c, fixes) : [] });
  }
  const mins = Math.min(MAX_WAKE_MIN, Math.max(MIN_WAKE_MIN, r.nextWakeIn));
  if (mins !== r.nextWakeIn) fixes.push(`next wake ${r.nextWakeIn} min moved to ${mins} min`);
  return {
    ok: true,
    decision: {
      sends, nextWakeAt: c.now + Math.round(mins * 60_000),
      notes: typeof r.notes === "string" ? r.notes.slice(0, NOTES_MAX) : "",
      log: cut(typeof r.log === "string" ? r.log : "", LOG_MAX),
      fixes,
    },
  };
}

/** The urgent send's reminder plan after the checks (see checkDecision). */
export function checkSteps(raw: unknown, c: CheckContext, fixes: string[] = []): CheckedStep[] {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((x): x is { channel: string; afterMin: number } => !!x && typeof x.channel === "string" && typeof x.afterMin === "number" && Number.isFinite(x.afterMin))
    .map((x) => ({ channel: x.channel, afterMin: Math.max(0, x.afterMin) }))
    .sort((a, b) => a.afterMin - b.afterMin);
  if (!c.on.length) {
    fixes.push("no channel is on: the alert is only stored");
    return [];
  }
  if (!list.length) list.push({ channel: c.on[0], afterMin: 0 });
  if (list[0].afterMin !== 0) {
    fixes.push(`first step moved from minute ${list[0].afterMin} to 0`);
    list[0].afterMin = 0;
  }
  const out: CheckedStep[] = [];
  for (const s of list) {
    const channel = channelFor(s.channel, c.channels, c.on)!;
    if (channel !== s.channel) fixes.push(`${s.channel} is off: step goes to ${channel}`);
    let at = s.afterMin;
    const prev = out.at(-1);
    if (prev) {
      const gap = inNight(c.now + prev.afterMin * 60_000, c.night) ? NIGHT_STEP_GAP_MIN : STEP_GAP_MIN;
      if (at < prev.afterMin + gap) at = prev.afterMin + gap;
    }
    // A step at the expiry itself would never fire (reminders end then).
    if (at >= REMIND_MAX_MIN || out.length >= REMIND_MAX_STEPS) {
      fixes.push("reminders past 2 hours or 6 steps dropped");
      break;
    }
    out.push({ channel, afterMin: at });
  }
  return out;
}
