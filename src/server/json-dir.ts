import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** How often a folder's every file is stat'ed again even though the folder itself didn't change (see JsonDir). */
export const JSON_DIR_RECHECK_MS = 5 * 60_000;

type Dir<T> = {
  /** The folder's mtime when its names were last read. */
  mtime: number;
  /** When every file was last stat'ed. */
  checkedAt: number;
  /** Parsed files by name, keyed by their mtime and size; null: the file didn't parse. */
  files: Map<string, { key: string; value: T | null }>;
  /** The sorted values, built on demand; null after a change. */
  list: readonly T[] | null;
  live: readonly T[] | null;
  /** Moves on whenever the list changes. */
  gen: number;
};

export type JsonDirOptions<T> = {
  /** Which file names in the folder are entries (e.g. "*.json" but not "*.state.json"). */
  match: (name: string) => boolean;
  /** The entry from its file's text; null to leave the file out. Throwing counts as null. */
  parse: (raw: string) => T | null;
  sort: (a: T, b: T) => number;
  /**
   * Entries still in play (a scheduled job, an open huddle): their files are stat'ed on every read, so an edit made
   * in place by another process shows at once. The rest rely on the folder's mtime (every writer renames a temp file
   * into place, which changes it) and on a full stat every JSON_DIR_RECHECK_MS (in slices by recheck() in the daemon).
   */
  live?: (v: T) => boolean;
  now?: () => number;
};

const keyOf = (file: string): string | null => {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
};

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/**
 * A folder of small JSON files (jobs, schedules, automations, huddles), parsed once and kept by file mtime and size.
 * Reading the list costs a stat of the folder and of the live entries; only files that changed are read again. The
 * Store tells it about its own writes (saved), so those don't make it look at the whole folder. Entries are shared and
 * frozen: copy one before changing it.
 */
export class JsonDir<T> {
  private dirs = new Map<string, Dir<T>>();
  private now: () => number;
  constructor(private o: JsonDirOptions<T>) {
    this.now = o.now ?? Date.now;
  }

  /** The folder's entries, sorted. Shared and frozen. */
  list(dir: string): readonly T[] {
    const d = this.current(dir);
    if (!d) return [];
    if (!d.list) d.list = Object.freeze([...d.files.values()].flatMap((f) => (f.value === null ? [] : [f.value])).sort(this.o.sort));
    return d.list;
  }

  /** Only the live entries (see JsonDirOptions.live), sorted. Shared and frozen. */
  liveList(dir: string): readonly T[] {
    const d = this.current(dir);
    if (!d) return [];
    const live = this.o.live;
    if (!d.live) d.live = Object.freeze(this.list(dir).filter((v) => !live || live(v)));
    return d.live;
  }

  /** A number that moves on whenever the folder's list changes. */
  version(dir: string): number {
    return this.current(dir)?.gen ?? 0;
  }

  /**
   * Reads a folder not read yet (or changed from outside) with a pause between files, so a big folder's first read
   * doesn't freeze the daemon. After it, list() is a cache hit.
   */
  async load(dir: string, pause: () => Promise<void>): Promise<void> {
    let mtime: number;
    let names: string[];
    const d = this.dirs.get(dir);
    try {
      mtime = statSync(dir).mtimeMs;
      // Read already and unchanged: a stat, not the folder's names (thousands, on every Inbox poll and list GET).
      if (d && d.mtime === mtime) return;
      names = readdirSync(dir).filter(this.o.match);
    } catch {
      return;
    }
    const startedAt = this.now();
    const files = new Map(d?.files ?? []);
    const next = new Map<string, { key: string; value: T | null }>();
    for (const name of names) {
      await pause();
      const f = this.readOne(join(dir, name), files.get(name));
      if (f) next.set(name, f);
    }
    // Another read or a Store write got there while this one paused: it is at least as new.
    const now = this.dirs.get(dir);
    if (now && now !== d) return;
    this.dirs.set(dir, { mtime, checkedAt: startedAt, files: next, list: null, live: null, gen: (d?.gen ?? 0) + 1 });
  }

  /**
   * After the Store wrote (value) or deleted (null) one file of the folder. mtimeBefore: the folder's mtime just before
   * the write; when it is the one the cache knows, the folder's new mtime is taken as ours (no rescan), otherwise
   * someone else changed the folder too and the next read looks at all of it.
   */
  saved(dir: string, name: string, value: T | null, mtimeBefore: number | null): void {
    const d = this.dirs.get(dir);
    if (!d) return;
    if (value === null) d.files.delete(name);
    else {
      const key = keyOf(join(dir, name));
      if (key === null) d.files.delete(name);
      else d.files.set(name, { key, value: deepFreeze(structuredClone(value)) });
    }
    if (mtimeBefore !== null && d.mtime === mtimeBefore) {
      try {
        d.mtime = statSync(dir).mtimeMs;
      } catch {}
    }
    this.changed(d);
  }

  /**
   * After the Store added a file to the folder that isn't an entry (a huddle's message log, a schedule's history):
   * when the folder's mtime just before was the one the cache knows, its new mtime is taken as ours, so the next read
   * doesn't stat every file for it.
   */
  touched(dir: string, mtimeBefore: number | null): void {
    const d = this.dirs.get(dir);
    if (!d || mtimeBefore === null || d.mtime !== mtimeBefore) return;
    try {
      d.mtime = statSync(dir).mtimeMs;
    } catch {}
  }

  /** Set by recheck(): the daemon stats the files again in the background, reads don't do it because time passed. */
  private rechecking = false;

  /**
   * Stats every known file of the folder again, pausing between files, to catch an entry edited in place from outside
   * (a changed one shows in the next read). Once called, reads leave this to it (the daemon calls it every
   * JSON_DIR_RECHECK_MS): the same in one go, inside whichever read came next, froze the daemon on big folders.
   * New and deleted files change the folder's mtime, which every read checks.
   */
  async recheck(dir: string, pause: () => Promise<void>): Promise<void> {
    this.rechecking = true;
    const d = this.dirs.get(dir);
    if (!d) return;
    const startedAt = this.now();
    let changed = false;
    for (const name of [...d.files.keys()]) {
      await pause();
      // A full read replaced the cache meanwhile: it is at least as new.
      if (this.dirs.get(dir) !== d) return;
      const f = d.files.get(name);
      if (!f) continue;
      const next = this.readOne(join(dir, name), f);
      if (next === f) continue;
      if (next) d.files.set(name, next);
      else d.files.delete(name);
      changed = true;
    }
    if (changed) this.changed(d);
    d.checkedAt = Math.max(d.checkedAt, startedAt);
  }

  /** The folder's mtime now, or null when it doesn't exist (pass it to saved). */
  mtime(dir: string): number | null {
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return null;
    }
  }

  private changed(d: Dir<T>) {
    d.list = null;
    d.live = null;
    d.gen++;
  }

  private readOne(file: string, prev: { key: string; value: T | null } | undefined): { key: string; value: T | null } | null {
    const key = keyOf(file);
    if (key === null) return null;
    if (prev?.key === key) return prev;
    let value: T | null = null;
    try {
      value = this.o.parse(readFileSync(file, "utf8"));
    } catch {}
    return { key, value: value === null ? null : deepFreeze(value) };
  }

  /** The folder's cache, brought up to date; null when the folder doesn't exist. */
  private current(dir: string): Dir<T> | null {
    let mtime: number;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      this.dirs.delete(dir);
      return null;
    }
    const d = this.dirs.get(dir);
    if (!d || d.mtime !== mtime || (!this.rechecking && this.now() - d.checkedAt >= JSON_DIR_RECHECK_MS)) return this.rescan(dir, mtime, d);
    // The folder is as it was: only the live entries can have been rewritten in place.
    const live = this.o.live;
    let changed = false;
    for (const [name, f] of d.files) {
      if (f.value === null || (live && !live(f.value))) continue;
      const next = this.readOne(join(dir, name), f);
      if (next === f) continue;
      if (next) d.files.set(name, next);
      else d.files.delete(name);
      changed = true;
    }
    if (changed) this.changed(d);
    return d;
  }

  /**
   * Names read again, every file stat'ed, only changed files read. Synchronous: a stat each (a few ms per thousand);
   * the expensive first read of a big folder goes through load() at startup.
   */
  private rescan(dir: string, mtime: number, d: Dir<T> | undefined): Dir<T> | null {
    let names: string[];
    try {
      names = readdirSync(dir).filter(this.o.match);
    } catch {
      this.dirs.delete(dir);
      return null;
    }
    const files = new Map<string, { key: string; value: T | null }>();
    let changed = !d || d.files.size !== names.length;
    for (const name of names) {
      const prev = d?.files.get(name);
      const f = this.readOne(join(dir, name), prev);
      if (!f) {
        changed = true;
        continue;
      }
      if (f !== prev) changed = true;
      files.set(name, f);
    }
    const next: Dir<T> = d && !changed
      ? { ...d, mtime, checkedAt: this.now() }
      : { mtime, checkedAt: this.now(), files, list: null, live: null, gen: (d?.gen ?? 0) + 1 };
    this.dirs.set(dir, next);
    return next;
  }
}
