import { closeSync, openSync, readSync, statSync } from "node:fs";
import { day } from "./quiet";
import type { ScheduleHistoryEntry } from "./types";

/** Days of fires and quiet runs kept for the spend figure (the list shows 7; one more for the day boundary). */
const RECENT_MS = 8 * 86_400_000;
/** Fired entries kept for a quiet run's "last check" (the run's own fire is left out there). */
const LAST_FIRED = 3;
/** History files kept in memory. */
const MAX_FILES = 200;
const CHUNK = 1024 * 1024;

/** What the schedules list and a quiet run need from a schedule's history, without its whole file. */
export type ScheduleHistoryDigest = {
  /** Quiet runs per local day (all of the history). */
  quietPerDay: ReadonlyMap<string, number>;
  /** The last "paused" edit, unless a later "resumed" undid it (lastPause). */
  lastPause: { at: string; by: "user" | { ticketId: string } } | null;
  /** Fires and quiet runs of about the last 8 days (scheduleSpend over 7). */
  recent: readonly ScheduleHistoryEntry[];
  /** The last few fires (quietContext). */
  lastFired: readonly ScheduleHistoryEntry[];
};

type State = { offset: number; mtime: number; quiet: Map<string, number>; lastPause: ScheduleHistoryDigest["lastPause"]; recent: ScheduleHistoryEntry[]; lastFired: ScheduleHistoryEntry[] };

const none = (): ScheduleHistoryDigest => ({ quietPerDay: new Map(), lastPause: null, recent: [], lastFired: [] });
const empty = (): State => ({ offset: 0, mtime: 0, quiet: new Map(), lastPause: null, recent: [], lastFired: [] });

/**
 * Per schedule history file (append-only), what the daemon needs from it, reading only the bytes appended since last
 * time. A file that got shorter, or changed without growing, is read again from the start.
 */
export class ScheduleHistoryDigests {
  private files = new Map<string, State>();
  constructor(private now: () => number = Date.now) {}

  /** The digest, reading what was appended since last time in one go. */
  get(file: string): ScheduleHistoryDigest {
    const at = this.start(file);
    if (!at) return none();
    const [s, size, mtime] = at;
    for (const _ of this.read(file, s, size));
    return this.keep(file, s, mtime);
  }

  /**
   * The same, with a pause after each 256 KB read: a history of years (megabytes) read for the first time doesn't
   * freeze the daemon. Works on its own copy, so a get() meanwhile can't fold the same lines twice.
   */
  async getAsync(file: string, pause: () => Promise<void>): Promise<ScheduleHistoryDigest> {
    const at = this.start(file);
    if (!at) return none();
    const [kept, size, mtime] = at;
    const s: State = { ...kept, quiet: new Map(kept.quiet), recent: [...kept.recent], lastFired: [...kept.lastFired] };
    for (const _ of this.read(file, s, size, CHUNK / 4)) await pause();
    // A get() meanwhile read at least as far: keep its state.
    const now = this.files.get(file);
    if (now && now !== kept && now.offset >= s.offset) return this.keep(file, now, now.mtime);
    return this.keep(file, s, mtime);
  }

  /** The file's state to read on from (a fresh one when the file was replaced), its size and mtime; null: no file. */
  private start(file: string): [State, number, number] | null {
    let size: number;
    let mtime: number;
    try {
      const st = statSync(file);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      this.files.delete(file);
      return null;
    }
    let s = this.files.get(file);
    if (!s || size < s.offset || (size === s.offset && mtime !== s.mtime)) s = empty();
    return [s, size, mtime];
  }

  private keep(file: string, s: State, mtime: number): ScheduleHistoryDigest {
    s.mtime = mtime;
    this.files.delete(file);
    this.files.set(file, s);
    if (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!);
    return { quietPerDay: s.quiet, lastPause: s.lastPause, recent: s.recent, lastFired: s.lastFired };
  }

  /** Folds the lines from s.offset up to size into s, one chunk at a time (yields after each). */
  private *read(file: string, s: State, size: number, chunk = CHUNK): Generator<void> {
    if (size <= s.offset) return;
    const from = new Date(this.now() - RECENT_MS).toISOString();
    const fd = openSync(file, "r");
    try {
      let rest = Buffer.alloc(0);
      while (s.offset + rest.length < size) {
        const buf = Buffer.alloc(Math.min(chunk, size - s.offset - rest.length));
        const n = readSync(fd, buf, 0, buf.length, s.offset + rest.length);
        if (n <= 0) break;
        const all = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        // Only whole lines: a line still being written is read next time.
        const end = all.lastIndexOf(0x0a) + 1;
        for (const line of all.subarray(0, end).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            this.fold(s, JSON.parse(line), from);
          } catch {}
        }
        s.offset += end;
        rest = all.subarray(end);
        yield;
      }
    } finally {
      closeSync(fd);
    }
    if (s.recent.length && s.recent[0].at < from) s.recent = s.recent.filter((e) => e.at >= from);
  }

  private fold(s: State, e: ScheduleHistoryEntry, from: string): void {
    if (!e || typeof e !== "object" || typeof e.at !== "string") return;
    if (e.kind === "quiet") s.quiet.set(day(e.at), (s.quiet.get(day(e.at)) ?? 0) + 1);
    if (e.kind === "edited" && e.action === "paused") s.lastPause = { at: e.at, by: e.by };
    if (e.kind === "edited" && e.action === "resumed") s.lastPause = null;
    if (e.kind === "fired" || e.kind === "quiet") {
      // Old entries are dropped as newer ones come (the list only looks at the last 7 days).
      if (e.at >= from) s.recent.push(e);
    }
    if (e.kind === "fired") {
      s.lastFired.push(e);
      if (s.lastFired.length > LAST_FIRED) s.lastFired.shift();
    }
  }
}
