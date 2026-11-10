import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { atomicWrite } from "./store";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { hasCommits, run } from "./git";

/** Rewind: go back to an earlier message of the ticket chat, with the project files as they were just before it. */

/** Snapshots live under this ref folder, so they never show up as branches or touch the user's own history. */
export const REWIND_REFS = "refs/ckanban/rewind";

const IDENTITY = {
  GIT_AUTHOR_NAME: "ckanban", GIT_AUTHOR_EMAIL: "ckanban@localhost",
  GIT_COMMITTER_NAME: "ckanban", GIT_COMMITTER_EMAIL: "ckanban@localhost",
};

/** Same text as the chat shows for a message: attachment links reduce to the file name. */
const norm = (s: string) => s.trim().replace(/\S*\/attachments\/([0-9a-f]{32}\.\w+)/g, "$1");

/** Short fingerprint of a message's text, to tell which snapshot belongs to which message. */
export function textKey(text: string): string {
  return createHash("sha1").update(norm(text)).digest("hex").slice(0, 12);
}

/**
 * Runs f with a throwaway git index, so the folder's own staged changes are never touched. With `seedFrom`, the
 * throwaway index starts as a copy of that folder's real one: git then only re-reads files whose size or time
 * changed, instead of every file in the folder (seconds on a few thousand files, well under one with the copy).
 */
async function withIndex<T>(f: (env: Record<string, string>) => Promise<T>, seedFrom?: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ck-rewind-"));
  try {
    const index = join(dir, "index");
    if (seedFrom) {
      const real = await run(["git", "rev-parse", "--git-path", "index"], seedFrom);
      const path = real.code === 0 && real.stdout.trim() ? resolve(seedFrom, real.stdout.trim()) : null;
      if (path && existsSync(path)) {
        try {
          copyFileSync(path, index);
        } catch {
          // No copy: git builds the index from scratch, only slower.
        }
      }
    }
    return await f({ GIT_INDEX_FILE: index, ...IDENTITY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

/**
 * How long saving the folder may hold up a message. A bigger or slower folder skips the copy for that message
 * (git is stopped, so no late copy appears), and rewinding to it then changes the chat only.
 * CKANBAN_SNAPSHOT_LIMIT_MS overrides it: the tests raise it, since a machine running several test suites is slow.
 */
export const SNAPSHOT_LIMIT_MS = Number(process.env.CKANBAN_SNAPSHOT_LIMIT_MS) || 2000;

/** The repo's top folder when `dir` has version history (a repo with at least one commit), else null. */
async function historyTop(dir: string): Promise<string | null> {
  if (!existsSync(dir) || !(await hasCommits(dir))) return null;
  const top = await run(["git", "rev-parse", "--show-toplevel"], dir);
  return top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
}

/** Tree of everything in `dir` right now (new and changed files included, ignored files left out). */
async function currentTree(dir: string, env: Record<string, string>, timeoutMs?: () => number): Promise<string | null> {
  const add = await run([...GIT, "add", "-A", "--", "."], dir, env, timeoutMs?.());
  if (add.code !== 0) return null;
  const tree = await run([...GIT, "write-tree"], dir, env, timeoutMs?.());
  return tree.code === 0 ? tree.stdout.trim() : null;
}

/**
 * Saves how the folder looks right now as a hidden snapshot, tied to the message about to be sent.
 * Null when there is no version history (nothing to undo later) or the snapshot failed: rewind then leaves files alone.
 */
export async function takeSnapshot(dir: string, ticketId: string, text: string, at = Date.now(), limitMs = SNAPSHOT_LIMIT_MS): Promise<string | null> {
  return saveFolder(dir, `${REWIND_REFS}/${ticketId}/${at}-${textKey(text)}`, `ckanban rewind snapshot for ${ticketId}`, limitMs);
}

/** Saves the folder as it is right now under `ref`. Null when there is no version history or the save failed. */
async function saveFolder(dir: string, ref: string, message: string, limitMs: number): Promise<string | null> {
  // Each git step gets what is left of the limit (at least 1ms, so a spent limit stops it at once).
  const end = Date.now() + limitMs;
  const left = () => Math.max(1, end - Date.now());
  try {
    if (!(await historyTop(dir))) return null;
    return await withIndex(async (env) => {
      const tree = await currentTree(dir, env, left);
      if (!tree) return null;
      const commit = await run([...GIT, "commit-tree", tree, "-m", message], dir, env, left());
      if (commit.code !== 0 || Date.now() >= end) return null;
      const set = await run(["git", "update-ref", ref, commit.stdout.trim()], dir);
      return set.code === 0 ? ref : null;
    }, dir);
  } catch {
    return null;
  }
}

export interface Snapshot {
  ref: string;
  at: number;
  key: string;
}

export async function listSnapshots(dir: string, ticketId: string): Promise<Snapshot[]> {
  if (!existsSync(dir)) return [];
  const r = await run(["git", "for-each-ref", "--format=%(refname)", `${REWIND_REFS}/${ticketId}/`], dir);
  if (r.code !== 0) return [];
  const out: Snapshot[] = [];
  for (const ref of r.stdout.split("\n")) {
    const m = ref.trim().match(/\/(\d+)-([0-9a-f]{12})$/);
    if (m) out.push({ ref: ref.trim(), at: Number(m[1]), key: m[2] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The snapshot taken for a message: the latest one before Claude read it that has the same text. */
export function snapshotFor(snaps: Snapshot[], text: string, readAt: string): Snapshot | null {
  const key = textKey(text);
  const t = Date.parse(readAt);
  const own = snaps.filter((s) => s.key === key && (Number.isNaN(t) || s.at <= t + 1000));
  return own.at(-1) ?? null;
}

export type FileChange = { path: string; status: "A" | "D" | "M" };

/** Files that differ between the snapshot and the folder now. A: new since, D: deleted since, M: edited since. */
export async function changesSince(dir: string, ref: string): Promise<FileChange[] | null> {
  const top = await historyTop(dir);
  if (!top) return null;
  // A folder inside a bigger repo: only its own files count (the seeded index also holds the rest of the repo).
  const prefix = (await run(["git", "rev-parse", "--show-prefix"], dir)).stdout.trim();
  return withIndex(async (env) => {
    const tree = await currentTree(dir, env);
    if (!tree) return null;
    const d = await run(["git", "diff-tree", "-r", "-z", "--name-status", "--no-renames", ref, tree, ...(prefix ? ["--", prefix] : [])], top);
    if (d.code !== 0) return null;
    const parts = d.stdout.split("\0").filter((x) => x !== "");
    const out: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      out.push({ path: parts[i + 1], status: s === "A" || s === "D" ? s : "M" });
    }
    return out;
  }, dir);
}

/** Puts the folder's files back as the snapshot has them. Returns the files that changed back. */
export async function restoreSnapshot(dir: string, ref: string): Promise<FileChange[]> {
  const top = await historyTop(dir);
  if (!top) throw new Error("This folder has no version history, so files can't be changed back.");
  const changes = await changesSince(dir, ref);
  if (!changes) throw new Error("Couldn't compare the files with the earlier point.");
  const inside = (p: string) => {
    const abs = resolve(top, p);
    return abs.startsWith(top + sep) ? abs : null;
  };
  const back = changes.filter((c) => c.status !== "A");
  await withIndex(async (env) => {
    const read = await run([...GIT, "read-tree", ref], top, env);
    if (read.code !== 0) throw new Error(`Couldn't read the earlier point: ${read.stderr.trim()}`);
    for (let i = 0; i < back.length; i += 100) {
      const chunk = back.slice(i, i + 100).map((c) => c.path);
      const r = await run([...GIT, "checkout-index", "-f", "--", ...chunk], top, env);
      if (r.code !== 0) throw new Error(`Couldn't restore files: ${r.stderr.trim()}`);
    }
  });
  for (const c of changes) {
    if (c.status !== "A") continue;
    const abs = inside(c.path);
    if (!abs) continue;
    try {
      unlinkSync(abs);
    } catch {
      continue;
    }
    // Folders the removed file leaves empty go too, never the project folder itself.
    for (let d = dirname(abs); d.startsWith(top + sep) && d !== top; d = dirname(d)) {
      try {
        if (readdirSync(d).length) break;
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  return changes;
}

/** Drops every saved copy of one ticket (it is done or deleted), Undo's too. Never touches other tickets' copies. */
export async function deleteSnapshots(dir: string, ticketId: string): Promise<void> {
  if (!/^[\w-]+$/.test(ticketId)) return;
  await pruneSnapshots(dir, ticketId, null);
  await dropUndoRefs(dir, ticketId);
}

/** Drops the snapshots newer than `keep` (they belonged to messages that are gone now). */
export async function pruneSnapshots(dir: string, ticketId: string, keep: Snapshot | null): Promise<void> {
  for (const s of await listSnapshots(dir, ticketId)) {
    if (!keep || s.at > keep.at) await run(["git", "update-ref", "-d", s.ref], dir);
  }
}

export interface Cut {
  /** Lines the session keeps. */
  kept: number;
  /** True when nothing of the conversation is left. */
  empty: boolean;
}

/**
 * The session text up to (not including) the user message `uuid`. Null when that message isn't a plain user
 * message in the file (a message sent while Claude worked sits mid-turn, and cutting there would leave a tool call without result).
 */
export function cutSession(raw: string, uuid: string): { text: string; cut: Cut } | null {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let ev: any;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (ev?.uuid !== uuid) continue;
    if (ev.type !== "user" || ev.isSidechain) return null;
    const content = ev.message?.content;
    if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return null;
    const kept = lines.slice(0, i).filter(Boolean);
    const empty = !kept.some((l) => {
      try {
        const k = JSON.parse(l);
        return (k?.type === "user" || k?.type === "assistant") && !k.isSidechain;
      } catch {
        return false;
      }
    });
    return { text: kept.length ? `${kept.join("\n")}\n` : "", cut: { kept: kept.length, empty } };
  }
  return null;
}

/** Cuts the session file before the message. The original stays beside it as `<file>.before-rewind`. */
export function rewindSessionFile(file: string, uuid: string): Cut {
  const raw = readFileSync(file, "utf8");
  const r = cutSession(raw, uuid);
  if (!r) throw new Error("This message can't be rewound to.");
  copyFileSync(file, `${file}.before-rewind`);
  writeFileSync(file, r.text);
  return r.cut;
}

export interface RewindPreview {
  /** Files that would change back; null when they can't be (filesReason says why). */
  files: FileChange[] | null;
  filesReason: "no-history" | "no-snapshot" | null;
}

/** What going back to the message would change in the folder. `dir` is null while the ticket's folder isn't known yet. */
export async function previewRewind(dir: string | null, ticketId: string, entry: { text: string; at: string }): Promise<RewindPreview> {
  const snap = dir ? snapshotFor(await listSnapshots(dir, ticketId), entry.text, entry.at) : null;
  const files = dir && snap ? await changesSince(dir, snap.ref) : null;
  if (files) return { files, filesReason: null };
  return { files: null, filesReason: dir && (await hasCommits(dir)) ? "no-snapshot" : "no-history" };
}

/** Where Undo keeps the folder as it was before and right after a rewind, and the snapshots the rewind set aside. */
export const UNDO_REFS = "refs/ckanban/rewind-undo";

/** How long saving the folder before a rewind may take (the user clicked and waits; no message is held up). */
export const UNDO_SAVE_LIMIT_MS = Number(process.env.CKANBAN_UNDO_SAVE_LIMIT_MS) || 60_000;

/**
 * What Undo needs to put a rewind back, kept on the ticket (or quick chat) until the next rewind.
 * Undo is allowed only while the chat is exactly as the rewind left it (see undoBlocked).
 */
export interface RewindUndo {
  at: string;
  /** The session the rewind cut; its file has a `.before-rewind` copy beside it. */
  sessionId: string;
  /** sha1 of the session file right after the cut: any later change (a message, a reply) means the chat moved on. */
  hash: string;
  /** The cut left nothing, so the chat went on in this new session: undo only while it hasn't started. */
  newSessionId: string | null;
  /** Chat messages (yours and Claude's) the rewind took away. */
  messages: number;
  /** The folder the files went back in, and how many changed. */
  dir: string | null;
  files: number;
  /** Saved folder before the rewind (undo puts it back) and right after (undo checks nothing changed since). Null: chat only. */
  before: string | null;
  after: string | null;
  /** Snapshots of the removed messages, set aside under UNDO_REFS so undo can bring them back. */
  kept: string[];
}

/** A rewind or undo stopped because the chat got busy or moved on while it ran (callers answer 409). */
export class RewindRefused extends Error {}

export const hashText = (s: string) => createHash("sha1").update(s).digest("hex");

const validId = (id: string) => /^[\w-]+$/.test(id);

async function refExists(dir: string, ref: string): Promise<boolean> {
  return (await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir)).code === 0;
}

async function moveRef(dir: string, from: string, to: string): Promise<boolean> {
  const sha = await run(["git", "rev-parse", "--verify", "--quiet", from], dir);
  if (sha.code !== 0 || !sha.stdout.trim()) return false;
  if ((await run(["git", "update-ref", to, sha.stdout.trim()], dir)).code !== 0) return false;
  await run(["git", "update-ref", "-d", from], dir);
  return true;
}

/** Drops what Undo kept for one ticket (a new rewind replaces it, or the ticket is done). */
export async function dropUndoRefs(dir: string, ticketId: string): Promise<void> {
  if (!validId(ticketId) || !existsSync(dir)) return;
  const r = await run(["git", "for-each-ref", "--format=%(refname)", `${UNDO_REFS}/${ticketId}/`], dir);
  if (r.code !== 0) return;
  for (const ref of r.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) await run(["git", "update-ref", "-d", ref], dir);
}

/**
 * Goes back to the message: files first (when asked and a saved copy exists, so a failure leaves the chat whole),
 * then the chat is cut before it. Before files change, the folder is saved as it is, so Undo can put it back.
 * Returns how many files changed back, what is left of the conversation, and what Undo needs (newSessionId and
 * messages are the caller's to fill in).
 */
export async function applyRewind(
  o: {
    dir: string | null; ticketId: string; entry: { uuid: string; text: string; at: string }; sessionFile: string; files: boolean; sessionId?: string;
    /** Asked again right before the chat is cut (the folder saves take a while): a reason stops the rewind and puts the files back. */
    still?: () => string | null;
  },
): Promise<{ restored: number; cut: Cut; undo: RewindUndo }> {
  // A message that can't be cut to is refused before anything changes.
  const raw = readFileSync(o.sessionFile, "utf8");
  if (!cutSession(raw, o.entry.uuid)) throw new Error("This message can't be rewound to.");
  const dir = o.dir && validId(o.ticketId) ? o.dir : null;
  const snap = dir ? snapshotFor(await listSnapshots(dir, o.ticketId), o.entry.text, o.entry.at) : null;
  // One level of undo: what an earlier rewind kept goes.
  if (dir) await dropUndoRefs(dir, o.ticketId);
  let restored = 0;
  let before: string | null = null;
  let after: string | null = null;
  // Something went wrong after files started changing: they go back to the save, and this call's refs go.
  const putBack = async () => {
    if (dir && before) await restoreSnapshot(dir, before).catch(() => {});
    for (const ref of [before, after]) if (dir && ref) await run(["git", "update-ref", "-d", ref], dir).catch(() => {});
  };
  if (o.files && dir && snap) {
    before = await saveFolder(dir, `${UNDO_REFS}/${o.ticketId}/before`, `ckanban folder before rewind for ${o.ticketId}`, UNDO_SAVE_LIMIT_MS);
    try {
      restored = (await restoreSnapshot(dir, snap.ref)).length;
    } catch (e) {
      await putBack();
      throw e;
    }
    if (before) after = await saveFolder(dir, `${UNDO_REFS}/${o.ticketId}/after`, `ckanban folder after rewind for ${o.ticketId}`, UNDO_SAVE_LIMIT_MS);
    if (before && !after) {
      // Without the after copy undo can't tell whether files changed since, so it restores the chat only.
      await run(["git", "update-ref", "-d", before], dir);
      before = null;
    }
  }
  let cut: Cut;
  try {
    const stop = o.still?.();
    if (stop) throw new RewindRefused(stop);
    cut = rewindSessionFile(o.sessionFile, o.entry.uuid);
  } catch (e) {
    // The chat stays whole, so the files go back to how they were too.
    await putBack();
    throw e;
  }
  // The removed messages' snapshots are set aside (undo brings them back), not deleted.
  const kept: string[] = [];
  if (dir && snap) {
    for (const s of await listSnapshots(dir, o.ticketId)) {
      if (s.at <= snap.at) continue;
      const to = `${UNDO_REFS}/${o.ticketId}/kept/${s.at}-${s.key}`;
      if (await moveRef(dir, s.ref, to)) kept.push(to);
      else await run(["git", "update-ref", "-d", s.ref], dir).catch(() => {});
    }
  }
  const undo: RewindUndo = {
    at: new Date().toISOString(), sessionId: o.sessionId ?? "", hash: hashText(readFileSync(o.sessionFile, "utf8")), newSessionId: null,
    messages: 0, dir, files: restored, before, after, kept,
  };
  return { restored, cut, undo };
}

/**
 * Why the rewind can't be undone now, or null when it can. `sessionFile` is the file of u.sessionId; `current` the
 * chat's session id now and whether that session has a transcript. Safe rule: the chat must be exactly as the rewind
 * left it (same session, file unchanged byte for byte, the new session of an emptied chat not started), and with
 * files, the folder must still be as the rewind left it; otherwise undo would lose what came after.
 */
export async function undoBlocked(
  u: RewindUndo | null | undefined, sessionFile: string | null, current: { sessionId: string | null; started: boolean }, files: boolean,
): Promise<string | null> {
  if (!u) return "There is no rewind to undo.";
  if (!sessionFile || !existsSync(sessionFile) || !existsSync(`${sessionFile}.before-rewind`)) return "The chat from before the rewind is gone, so it can't come back.";
  const moved = "The chat has moved on since the rewind (a message was sent), so it can't be undone without losing that.";
  if (u.newSessionId ? current.sessionId !== u.newSessionId || current.started : current.sessionId !== u.sessionId) return moved;
  if (hashText(readFileSync(sessionFile, "utf8")) !== u.hash) return moved;
  if (files && u.dir && u.before && u.after) {
    if (!existsSync(u.dir) || !(await refExists(u.dir, u.before)) || !(await refExists(u.dir, u.after))) {
      return "The saved files from before the rewind are gone. Undo the chat only?";
    }
    const since = await changesSince(u.dir, u.after);
    if (!since) return "Couldn't compare the files with how the rewind left them.";
    if (since.length) return `${since.length === 1 ? "A file has" : `${since.length} files have`} changed since the rewind, and undo would overwrite ${since.length === 1 ? "it" : "them"}. Undo the chat only?`;
  }
  return null;
}

export interface UndoResult {
  /** Chat messages that came back. */
  messages: number;
  /** Files that went back to how they were before the rewind. */
  files: number;
  filesRestored: boolean;
  /** Why files didn't come back: the rewind didn't change any, it couldn't save them first, or undo was asked for the chat only. */
  filesReason: "unchanged" | "not-saved" | "skipped" | null;
}

/** Undoes the rewind (check undoBlocked first): files first, then the chat comes back from its `.before-rewind` copy. */
export async function applyUndo(u: RewindUndo, sessionFile: string, ticketId: string, files: boolean, still?: () => string | null): Promise<UndoResult> {
  const backup = `${sessionFile}.before-rewind`;
  const saved = readFileSync(backup, "utf8");
  let back = 0;
  const withFiles = files && !!u.dir && !!u.before && !!u.after;
  if (withFiles) back = (await restoreSnapshot(u.dir!, u.before!)).length;
  // Checked again right before the chat is written back: a message that started meanwhile must not be overwritten.
  const stop = still?.() ?? (hashText(readFileSync(sessionFile, "utf8")) !== u.hash ? "The chat has moved on since the rewind." : null);
  if (stop) {
    if (withFiles && u.after) await restoreSnapshot(u.dir!, u.after).catch(() => {});
    throw new RewindRefused(stop);
  }
  atomicWrite(sessionFile, saved);
  rmSync(backup, { force: true });
  if (u.dir && validId(ticketId) && existsSync(u.dir)) {
    // The removed messages' snapshots come back, so rewinding to them later still restores files.
    for (const ref of u.kept) {
      const m = ref.match(/\/kept\/(\d+-[0-9a-f]{12})$/);
      if (m && ref.startsWith(`${UNDO_REFS}/${ticketId}/`)) await moveRef(u.dir, ref, `${REWIND_REFS}/${ticketId}/${m[1]}`);
    }
    await dropUndoRefs(u.dir, ticketId);
  }
  const reason: UndoResult["filesReason"] = withFiles ? null : !files && u.before ? "skipped" : u.files ? "not-saved" : "unchanged";
  return { messages: u.messages, files: back, filesRestored: withFiles, filesReason: reason };
}

/** Chat messages (yours and Claude's replies) from the entry with `uuid` on: what a rewind to it takes away. */
export function messagesFrom(entries: { uuid: string; kind: string; role: string }[], uuid: string): number {
  const i = entries.findIndex((e) => e.uuid === uuid);
  return i < 0 ? 0 : entries.slice(i).filter((e) => e.kind === "text" && (e.role === "user" || e.role === "assistant")).length;
}
