import { run as runCmd } from "../runs/git";
import { applyUndo, RewindRefused, undoBlocked, type RewindUndo, type UndoResult } from "../chat/rewind";
import { type Ticket } from "../core/types";
import type { Board } from "./board";
import { claudeSessionFile, REWINDING, ConflictError } from "./board-types";

/**
 * The folder a ticket's Claude edits, once it is known (its own copy, a linked folder, or the project folder after
 * the first run edited it in place); null before that, so rewind never snapshots the wrong folder.
 */
export function rewindDir(this: Board, slug: string, id: string): string | null {
  const t = this.store.getTicket(slug, id);
  const profile = this.store.getProfile(slug);
  if (!t || !profile) return null;
  if (t.workdir || t.worktree) return t.workdir ?? t.worktree ?? null;
  return t.baseSha ? profile.path : null;
}

/** Why the chat can't be rewound right now, or null when it can. held: asked from inside withRewind (the lock is ours). */
export function rewindBlocked(this: Board, slug: string, id: string, held = false): string | null {
  const t = this.store.getTicket(slug, id);
  if (!t) return "ticket not found";
  if (!held && this.rewinding.has(this.key(slug, id))) return REWINDING;
  if (this.isRunning(slug, id)) return "Claude is working. Stop it or wait until it has replied.";
  if (t.queued?.length) return "A message is still waiting to be sent. Send or discard it first.";
  // In the project folder itself, another ticket's run edits the same files: putting them back would undo its work too.
  if (!t.workdir && !t.worktree && this.folderBusy(slug, t)) return "Another ticket is editing this folder right now. Try again when it has finished.";
  return null;
}

/**
 * The conversation was cut by a rewind: with nothing left of it, the next message starts a new session.
 * undo: what Undo needs to put it back (its newSessionId is filled in here).
 */
export function rewound(this: Board, slug: string, id: string, emptied: boolean, undo: RewindUndo | null = null): Ticket {
  this.recoverable(slug, id);
  const sessionId = emptied ? crypto.randomUUID() : null;
  const rewindUndo = undo ? { ...undo, newSessionId: sessionId } : null;
  return this.patch(slug, id, sessionId
    ? { sessionId, sessionStarted: false, freshSession: true, lastActivity: null, rewindUndo }
    : { lastActivity: null, rewindUndo });
}

/** Why the last rewind can't be undone now (rewindBlocked, then rewind.ts undoBlocked), or null. */
export async function undoRewindBlocked(this: Board, slug: string, id: string, files: boolean, held = false): Promise<string | null> {
  const t = this.store.getTicket(slug, id);
  if (!t) return "ticket not found";
  const busy = this.rewindBlocked(slug, id, held);
  if (busy) return busy;
  const u = t.rewindUndo;
  const started = !!t.sessionId && t.sessionId !== u?.sessionId && (!!t.sessionStarted || this.sessionExists(t.sessionId));
  return undoBlocked(u, u ? claudeSessionFile(u.sessionId) : null, { sessionId: t.sessionId ?? null, started }, files);
}

/** Undo the last rewind: files (unless files is false) and the chat come back as they were just before it. */
export async function undoRewind(this: Board, slug: string, id: string, files: boolean): Promise<UndoResult> {
  return this.withRewind(slug, id, () => this.undoRewindNow(slug, id, files));
}

export async function undoRewindNow(this: Board, slug: string, id: string, files: boolean): Promise<UndoResult> {
  const blocked = await this.undoRewindBlocked(slug, id, files, true);
  if (blocked) throw new ConflictError(blocked);
  const t = this.store.getTicket(slug, id)!;
  const u = t.rewindUndo!;
  let r: UndoResult;
  try {
    r = await applyUndo(u, claudeSessionFile(u.sessionId)!, id, files, () => this.rewindBlocked(slug, id, true));
  } catch (e) {
    throw e instanceof RewindRefused ? new ConflictError(e.message) : e;
  }
  this.recoverable(slug, id);
  this.patch(slug, id, {
    rewindUndo: null, lastActivity: null,
    ...(u.newSessionId ? { sessionId: u.sessionId, sessionStarted: true, freshSession: false } : {}),
  });
  return r;
}
