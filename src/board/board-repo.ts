import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, branchesWithPrefix, branchExists, latestBase, removeWorktree, repoKind, resolveBaseBranch, worktreeDir, type RepoKind } from "../runs/git";
import { setupNote } from "../runs/prompts";
import { planActive } from "./plan";
import { run as runCmd } from "../runs/git";
import { workspaceOf, type Profile, type Ticket } from "../core/types";
import { CLEANUP_TIMEOUT_MS, copySetupFiles, prepareWorktree, runShell, SETUP_TIMEOUT_MS, withBoardText, type SetupOutcome, type SetupResult } from "../runs/worktree-setup";
import { slugify } from "../core/util";
import type { Board } from "./board";
import { INSTALLING, ActiveRun, REPO_TTL_MS, Session } from "./board-types";

/**
 * The board folder's version history, from the cache (undefined until first checked). A stale or missing entry is
 * re-checked in the background; a change re-runs dispatch, so tickets held back by an unknown state start then.
 */
export function repoState(this: Board, slug: string): RepoKind | undefined {
  const c = this.repos.get(this.store.getProfile(slug)?.path ?? "");
  if (!c || Date.now() - c.at > REPO_TTL_MS) void this.checkRepo(slug);
  return c?.kind;
}

/** Before the first check (just after a restart): guessed from the folder's .git (config names an origin or not). */
export function guessRepo(this: Board, slug: string): RepoKind {
  const path = this.store.getProfile(slug)?.path;
  if (!path || !existsSync(join(path, ".git"))) return "plain";
  try {
    return readFileSync(join(path, ".git", "config"), "utf8").includes('[remote "origin"]') ? "remote" : "local";
  } catch {
    return "remote";
  }
}

/** The board folder has commits (so huddle reviewers get snapshots of committed code); true until known. */
export function committed(this: Board, slug: string): boolean {
  const k = this.repoState(slug);
  return k === undefined || k === "local" || k === "remote";
}

export async function checkRepo(this: Board, slug: string): Promise<void> {
  const profile = this.store.getProfile(slug);
  if (!profile || this.repoChecks.has(profile.path)) return;
  this.repoChecks.add(profile.path);
  try {
    this.noteRepo(slug, await repoKind(profile.path));
  } finally {
    this.repoChecks.delete(profile.path);
  }
}

/** Records what the folder is now (e.g. version history was just turned on); a change re-runs dispatch. */
export function noteRepo(this: Board, slug: string, kind: RepoKind): void {
  const path = this.store.getProfile(slug)?.path;
  if (!path) return;
  const prev = this.repos.get(path)?.kind;
  this.repos.set(path, { kind, at: Date.now() });
  if (prev !== kind && !this.shuttingDown) this.dispatch(slug);
}

/**
 * The ticket's runs edit the board's folder itself rather than a copy of their own: a plain folder or a repo with
 * no commits (no worktree can be made), or a ticket that already ran there. Null: not known yet (the folder's
 * version history is still being checked). Linked sessions (workdir) are the user's own and don't count.
 * Such tickets run one at a time per board (see folderBusy), as do new tickets on a board set to work in the folder.
 */
export function runsInFolder(this: Board, slug: string, t: Ticket): boolean | null {
  if (t.workdir || t.worktree || t.branch) return false;
  if (t.sessionStarted || t.runCount > 0) return true;
  if (workspaceOf(this.store.getProfile(slug)) === "folder") return true;
  const kind = this.repoState(slug);
  return kind === undefined ? null : kind === "plain" || kind === "empty";
}

/**
 * Another ticket on the board is editing the folder `t` would edit in place: its run (not a read-only Planning
 * chat) is going, or its auto huddle reviews the work there. An unknown side counts as in place, so nothing starts
 * on a guess; the version-history check re-runs dispatch.
 */
export function folderBusy(this: Board, slug: string, t: Ticket): boolean {
  // A main ticket never edits, so it never waits for the folder.
  if (t.main) return false;
  if (this.runsInFolder(slug, t) === false) return false;
  for (const r of this.runs.values()) {
    if (r.slug !== slug || r.id === t.id || !this.runMayEdit(r)) continue;
    const o = this.store.getTicket(slug, r.id);
    if (o && this.runsInFolder(slug, o) !== false) return true;
  }
  // Only boards whose tickets edit the folder get here, so listing them stays rare.
  return this.store.listTickets(slug).some((o) => o.id !== t.id && !!o.autoHuddle && !this.isRunning(slug, o.id) && this.runsInFolder(slug, o) !== false);
}

/**
 * The run may edit files: not a main ticket's (its edit tools are off), and not a Planning chat's (same), except a
 * tool ticket's, whose runs always work.
 */
export function runMayEdit(this: Board, r: ActiveRun): boolean {
  if (r.noEdit) return false;
  if (r.chat?.mode !== "refine") return true;
  return !!this.store.getTicket(r.slug, r.id)?.tool;
}

/** For the card: it would start now (Ready, a reply waiting for a slot, a running plan's next child) but the folder is in use. */
export function folderWait(this: Board, slug: string, t: Ticket): boolean {
  if (this.isRunning(slug, t.id)) return false;
  const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
  const next = t.status === "ready" || !!t.slotWait || (t.status === "backlog" && !t.waitsForStart && planActive(parent?.plan));
  return next && this.folderBusy(slug, t);
}

/** Serialized per ticket: a run and a "copy command" click must not both create the worktree. */
export function ensureSession(this: Board, slug: string, id: string): Promise<Session> {
  const key = this.key(slug, id);
  const prev = this.sessionLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => this.ensureSessionNow(slug, id));
  this.sessionLocks.set(key, next);
  next.finally(() => {
    if (this.sessionLocks.get(key) === next) this.sessionLocks.delete(key);
  }).catch(() => {});
  return next;
}

export async function ensureSessionNow(this: Board, slug: string, id: string): Promise<Session> {
  const profile = this.store.getProfile(slug);
  if (!profile) throw new Error(`board ${slug} not found`);
  if (!existsSync(profile.path)) throw new Error(`board folder does not exist: ${profile.path}`);
  let t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const repo = await repoKind(profile.path);
  this.noteRepo(slug, repo);
  const isGit = repo !== "plain";
  const patch: Partial<Ticket> = {};
  if (t.workdir && !existsSync(t.workdir)) throw new Error(`linked session folder no longer exists: ${t.workdir}`);
  // A ticket that already ran in the folder itself stays there: its Claude session belongs to that folder.
  // One with a branch had a worktree (removed on Done): it gets it back at the same path, so its session resumes.
  const ranInPlace = !t.worktree && !t.branch && (!!t.sessionStarted || t.runCount > 0);
  // Board set to "Work in the project folder": new tickets run there; one that already has a worktree keeps it.
  const folderMode = workspaceOf(profile) === "folder" && !t.worktree && !t.branch;
  if (isGit && !t.workdir && !ranInPlace && !folderMode && (!t.worktree || !existsSync(t.worktree))) {
    const dir = worktreeDir(profile, id);
    let branch = t.branch ?? `ck/${id}-${slugify(t.title)}`;
    if (t.branch && !existsSync(dir) && !(await branchExists(profile.path, t.branch))) {
      // Claude may have renamed the branch in its worktree: take the ticket's newest one, else start over from base.
      const renamed = (await branchesWithPrefix(profile.path, `ck/${id}-`))[0];
      if (renamed) branch = renamed;
      else patch.notice = `Branch "${t.branch}" was not found, so this ticket's worktree starts again from the base branch.`;
    }
    const base = existsSync(dir) ? profile.baseBranch : await resolveBaseBranch(profile.path, profile.baseBranch);
    if (base === null) {
      // Fresh `git init` with no commits: nothing to branch from, so run in the folder rather than fail.
      patch.notice = "This repo has no commits yet, so Claude works directly in your folder instead of an isolated worktree. Make a first commit to give new tickets their own worktree.";
    } else {
      if (base !== profile.baseBranch) {
        console.log(`profile ${slug}: base branch "${profile.baseBranch}" not found, using "${base}"`);
        const fixed = { ...profile, baseBranch: base };
        this.store.saveProfile(fixed);
        this.bus.emit({ type: "profile.updated", slug, profile: fixed });
        if (profile.baseBranch) patch.notice = `Base branch "${profile.baseBranch}" was not found in this repo, so the board now uses "${base}".`;
      }
      const fresh = !existsSync(dir);
      if (fresh) {
        // A new branch starts from the remote's latest base (other tickets push there); an existing one keeps its history.
        // A step builds on its main ticket's copy (a follow-up ticket on its ticket's work in Review), while it exists.
        const from = t.startFrom && (await branchExists(profile.path, t.startFrom)) ? t.startFrom
          : repo === "remote" && !(await branchExists(profile.path, branch)) ? await latestBase(profile.path, base) : base;
        await addWorktree(profile.path, dir, branch, from);
        // Only the cheap part now; the setup command runs when Claude asks for it (runSetup).
        this.copyWorktreeFiles(slug, id, profile, dir);
        patch.setupPending = true;
        // A main ticket's Changes tab shows its whole family's work since here, landed milestones included.
        if (t.main && !t.startSha) {
          const head = await runCmd(["git", "rev-parse", "HEAD"], dir);
          if (head.code === 0 && head.stdout.trim()) patch.startSha = head.stdout.trim();
        }
      }
      if (t.startFrom) patch.startFrom = null;
      patch.worktree = dir;
      patch.branch = branch;
    }
  }
  // In place on a repo with commits: the folder's HEAD at the first run is what the Changes tab diffs against.
  if (!t.workdir && !t.worktree && !patch.worktree && !t.baseSha && (repo === "local" || repo === "remote")) {
    const head = await runCmd(["git", "rev-parse", "HEAD"], profile.path);
    if (head.code === 0 && head.stdout.trim()) patch.baseSha = head.stdout.trim();
  }
  if (!t.sessionId) patch.sessionId = crypto.randomUUID();
  if (Object.keys(patch).length) t = this.patch(slug, id, patch);
  const sessionId = t.sessionId!;
  return {
    dir: t.workdir ?? t.worktree ?? profile.path,
    sessionId,
    // Only a saved session can be resumed (a run stopped in its first second leaves none); a linked one is the user's.
    existed: (!!t.workdir && !t.freshSession) || this.sessionExists(sessionId),
    isGit,
    repo,
    inPlace: !t.workdir && !t.worktree,
  };
}

/** Work runs in a worktree whose setup command hasn't run yet learn how to run it; planning chats never do. */
export function withSetupNote(this: Board, slug: string, t: Ticket, profile: Profile, session: Session, refine: boolean, prompt: string): string {
  if (refine || !t.setupPending || !t.worktree || session.dir !== t.worktree || !profile.setupCommand?.trim()) return prompt;
  return withBoardText(prompt, setupNote(slug, t.id), "Setup");
}

/** Copies the board's git-ignored files (.env) into a new worktree. Quiet: missing ones are only logged. */
export function copyWorktreeFiles(this: Board, slug: string, id: string, profile: Profile, dir: string): void {
  if (!profile.copyFiles?.length) return;
  try {
    const { missing } = copySetupFiles(profile.path, dir, profile.copyFiles);
    if (missing.length) console.log(`ticket ${slug}/${id}: files to copy not found: ${missing.join(", ")}`);
  } catch (e) {
    console.error(`ticket ${slug}/${id}: copying files into the worktree failed: ${(e as Error).message}`);
  }
}

/**
 * Runs the board's setup command in the ticket's worktree, when its Claude asks (`ckanban ticket setup`). Calls while
 * one runs share it; after a success it isn't run again for this worktree. Never throws for a failed command: the
 * result carries its output, and Claude decides what to do.
 */
export function runSetup(this: Board, slug: string, id: string): Promise<SetupOutcome> {
  const profile = this.store.getProfile(slug);
  const t = this.store.getTicket(slug, id);
  if (!profile || !t) return Promise.reject(new Error(`ticket ${id} not found`));
  const key = this.key(slug, id);
  const running = this.setups.get(key);
  if (running) return running.done;
  const command = profile.setupCommand?.trim() ?? "";
  if (!t.worktree || !existsSync(t.worktree)) return Promise.resolve({ status: "no-worktree" });
  if (!command) return Promise.resolve({ status: "no-command" });
  if (!t.setupPending) return Promise.resolve({ status: "already-done" });
  const dir = t.worktree;
  const abort = new AbortController();
  const done = (async (): Promise<SetupOutcome> => {
    this.patch(slug, id, { lastActivity: INSTALLING });
    let r: SetupResult | null = null;
    try {
      r = (await prepareWorktree(profile.path, dir, { setupCommand: command }, {
        signal: abort.signal, timeoutMs: SETUP_TIMEOUT_MS, env: { CKANBAN_TICKET: `${slug}/${id}` },
      }))!;
    } finally {
      // The worktree may have been removed or replaced meanwhile: only mark the one it ran in.
      const now = this.store.getTicket(slug, id);
      if (now) {
        this.patch(slug, id, {
          ...(r?.ok && now.worktree === dir ? { setupPending: false } : {}),
          ...(now.lastActivity === INSTALLING ? { lastActivity: null } : {}),
        });
      }
    }
    if (!r.ok) console.log(`ticket ${slug}/${id}: setup failed (${r.command}): ${r.output.split("\n").slice(-3).join(" | ")}`);
    return { status: "ran", result: r };
  })();
  this.setups.set(key, { done, abort });
  done.finally(() => {
    if (this.setups.get(key)?.done === done) this.setups.delete(key);
  }).catch(() => {});
  return done;
}

/** Removes a ticket's worktree, running the board's cleanup command in it first (its failure never blocks). */
export function removeTicketWorktree(this: Board, profile: Profile, dir: string): ReturnType<typeof removeWorktree> {
  const cleanup = profile.cleanupCommand?.trim();
  return removeWorktree(profile.path, dir, cleanup ? async () => {
    const r = await runShell(dir, cleanup, { timeoutMs: CLEANUP_TIMEOUT_MS });
    if (!r.ok) console.error(`worktree cleanup failed in ${dir} (${cleanup}): ${r.output.split("\n").slice(-5).join(" | ")}`);
  } : undefined);
}
