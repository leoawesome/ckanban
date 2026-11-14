import { watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

/** How often watchers fed by the change feeds still look at everything, in case they missed a change. */
export const SAFETY_PASS_MS = 60_000;
/**
 * The same for Done tickets, most of a big board: they change only through a Store write or a session the feed
 * reports, which the watchers already follow, so their safety pass can wait this long.
 */
export const DONE_PASS_MS = 10 * 60_000;

/**
 * A Claude session's files changed: its transcript (`file` is its path), or something in its folder (subagents,
 * workflows; `file` null). null: something changed but the watch couldn't say what (do a full pass).
 */
export type SessionChange = { sessionId: string; file: string | null } | null;

/** What watchers need from the feed: whether it is watching now, and its changes. */
export interface SessionChanges {
  readonly live: boolean;
  subscribe(fn: (c: SessionChange) => void): () => void;
}

/**
 * One recursive watch on Claude's projects folder (`<project>/<session>.jsonl`, `<project>/<session>/...`) reporting
 * new and growing transcripts, so watchers look only at the sessions that changed instead of every ticket's files
 * every few seconds. Watchers keep a slow full pass as a safety net for missed events; while the watch isn't
 * running (`live` false) they poll as before.
 */
export class SessionFeed implements SessionChanges {
  private fns = new Set<(c: SessionChange) => void>();
  private watcher: FSWatcher | null = null;

  constructor(private root: string) {}

  get live(): boolean {
    return this.watcher !== null;
  }

  /** Starts the watch; false when it can't (no projects folder yet, or no recursive watch here): watchers poll. */
  start(): boolean {
    if (this.watcher) return true;
    try {
      const w = watch(this.root, { recursive: true }, (_event, name) => this.path(name ? String(name) : null));
      w.on("error", (e) => {
        console.error("session feed", e);
        this.stop();
      });
      this.watcher = w;
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
  }

  subscribe(fn: (c: SessionChange) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  /** A path the watch reported, relative to the projects folder. */
  path(name: string | null): void {
    if (name === null) return this.emit(null);
    const parts = name.split(sep);
    // A project folder itself: nothing in it to look at yet (its files come as their own events).
    if (parts.length < 2) return;
    const own = parts.length === 2 && parts[1].endsWith(".jsonl");
    const sessionId = own ? parts[1].slice(0, -6) : parts[1];
    if (sessionId) this.emit({ sessionId, file: own ? join(this.root, name) : null });
  }

  private emit(c: SessionChange): void {
    for (const fn of this.fns) {
      try {
        fn(c);
      } catch (e) {
        console.error("session feed listener", e);
      }
    }
  }
}
