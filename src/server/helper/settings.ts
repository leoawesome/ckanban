// The helper's settings, owned by the board (`<root>/helper.json`): its model, "My night", whether it may wake the user
// at night, and "What the helper knows about you" (the feedback list: the helper reads it, only the user changes it).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../store";

export type HelperModel = "sonnet" | "haiku";
export const HELPER_MODELS: HelperModel[] = ["sonnet", "haiku"];

/** "My night" in this Mac's time: HH:MM to HH:MM (may wrap past midnight). */
export interface Night {
  start: string;
  end: string;
}

export const DEFAULT_NIGHT: Night = { start: "22:00", end: "07:00" };

/** One line of "What the helper knows about you". */
export interface FeedbackLine {
  id: string;
  text: string;
  at: string;
  /** Where it came from: typed by the user, or a tap (Should have pinged me). */
  source: "user" | "should-have-pinged";
}

export interface HelperSettings {
  model: HelperModel;
  night: Night;
  /** May the helper wake the user at night for urgent things? null: not asked yet (then it doesn't). */
  nightOptIn: boolean | null;
  feedback: FeedbackLine[];
}

export const FEEDBACK_MAX = 300;
export const FEEDBACK_LINES_MAX = 100;

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export const defaultHelperSettings = (): HelperSettings => ({ model: "sonnet", night: { ...DEFAULT_NIGHT }, nightOptIn: null, feedback: [] });

/** Minutes after midnight of "HH:MM", or null. */
export function hm(v: string): number | null {
  const m = HM.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Normalises "7:00" to "07:00"; throws on anything else. */
function hmText(v: unknown, what: string): string {
  const n = typeof v === "string" ? hm(v) : null;
  if (n === null) throw new Error(`${what} must be a time like 22:00`);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** Minutes after local midnight of a time. */
const minuteOfDay = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

/** The time is inside "My night" (this Mac's time zone). */
export function inNight(ms: number, night: Night): boolean {
  const s = hm(night.start) ?? 22 * 60;
  const e = hm(night.end) ?? 7 * 60;
  const m = minuteOfDay(ms);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** When the night that holds `ms` ends (the morning), or `ms` itself when it isn't night. */
export function nightEnd(ms: number, night: Night): number {
  if (!inNight(ms, night)) return ms;
  const e = hm(night.end) ?? 7 * 60;
  const d = new Date(ms);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(e / 60), e % 60).getTime();
  return end > ms ? end : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, Math.floor(e / 60), e % 60).getTime();
}

/**
 * A safety-net digest held by the night goes this long after the night ends: the helper wakes at the night's end and
 * its morning summary goes first; if the helper fails, the digest still goes out.
 */
export const MORNING_GRACE_MS = 30 * 60_000;

/** When a digest due at `ms` may go: `ms` itself in the daytime, or the night's end plus the morning grace. */
export function morningDigestAt(ms: number, night: Night): number {
  return inNight(ms, night) ? nightEnd(ms, night) + MORNING_GRACE_MS : ms;
}

export class HelperSettingsStore {
  readonly file: string;

  constructor(root: string, private now: () => number = Date.now) {
    this.file = join(root, "helper.json");
  }

  get(): HelperSettings {
    const out = defaultHelperSettings();
    if (!existsSync(this.file)) return out;
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (HELPER_MODELS.includes(v?.model)) out.model = v.model;
      if (v?.night && hm(String(v.night.start ?? "")) !== null && hm(String(v.night.end ?? "")) !== null) out.night = { start: v.night.start, end: v.night.end };
      if (typeof v?.nightOptIn === "boolean") out.nightOptIn = v.nightOptIn;
      if (Array.isArray(v?.feedback)) out.feedback = v.feedback.filter((f: any) => f && typeof f.id === "string" && typeof f.text === "string");
    } catch (e) {
      console.warn(`helper: helper.json could not be read (${(e as Error).message}); using defaults`);
    }
    return out;
  }

  private save(s: HelperSettings): HelperSettings {
    atomicWrite(this.file, JSON.stringify(s, null, 2) + "\n");
    return s;
  }

  /** Changes model, night and nightOptIn; throws (with a plain message) on bad input. */
  update(raw: any): HelperSettings {
    const s = this.get();
    if (!raw || typeof raw !== "object") return s;
    if (raw.model !== undefined) {
      if (!HELPER_MODELS.includes(raw.model)) throw new Error(`model must be one of ${HELPER_MODELS.join(", ")}`);
      s.model = raw.model;
    }
    if (raw.night !== undefined) {
      const start = hmText(raw.night?.start, "night start");
      const end = hmText(raw.night?.end, "night end");
      if (start === end) throw new Error("night start and end must differ");
      s.night = { start, end };
    }
    if (raw.nightOptIn !== undefined) {
      if (typeof raw.nightOptIn !== "boolean" && raw.nightOptIn !== null) throw new Error("nightOptIn must be true or false");
      s.nightOptIn = raw.nightOptIn;
    }
    return this.save(s);
  }

  addFeedback(text: unknown, source: FeedbackLine["source"] = "user"): FeedbackLine {
    const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    if (!t) throw new Error("text is required");
    if (t.length > FEEDBACK_MAX) throw new Error(`text is too long (${t.length} characters, max ${FEEDBACK_MAX})`);
    const s = this.get();
    const line: FeedbackLine = { id: `f_${this.now().toString(36)}${randomBytes(2).toString("hex")}`, text: t, at: new Date(this.now()).toISOString(), source };
    s.feedback = [...s.feedback, line].slice(-FEEDBACK_LINES_MAX);
    this.save(s);
    return line;
  }

  removeFeedback(id: string): boolean {
    const s = this.get();
    const before = s.feedback.length;
    s.feedback = s.feedback.filter((f) => f.id !== id);
    if (s.feedback.length === before) return false;
    this.save(s);
    return true;
  }
}
