// Huddles: stop, resume, close, summaries, cleanup, shutdown and recover (methods of the Huddles class in huddle.ts, split by topic).
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run as git } from "../runs/git";
import { projectNames, removeOutputCopies } from "./output-copies";
import { LEGACY_SUMMARY_FILE, summaryFile, USER_HANDLE } from "./huddle-roster";
import { keptDir, removeCopy, unhanded } from "./huddle-copies";
import { huddleAgentPrompt } from "../runs/prompts";
import type { Huddle } from "../core/types";
import { nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, DEFAULT_MAX_COST_USD, BUDGET_WARN, huddleCost, money, fallbackSummary, endedByDone, DELETED, summaryAsk, agentDir, removeOwnWorktree } from "./huddle-types";

/** The user stops one participant: its huddle run ends and nothing wakes it until the huddle is resumed. */
export function stopParticipant(this: Huddles, slug: string, hid: string, handle: string): void {
  const h = this.get(slug, hid);
  const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
  if (!p) throw new HuddleError(404, `no participant @${handle}`);
  this.stopParticipantRun(slug, h, p);
  this.updateP(slug, hid, handle, { status: "stopped" });
  if (h.status !== "closed") this.system(slug, hid, `@${handle} was stopped by @you.`);
  this.userActed(slug, hid);
}

/**
 * The user restarts a failed or stopped participant: it is idle again and, while the huddle is live, wakes now
 * with what it has not read yet. On a stopped huddle it wakes when the huddle resumes.
 */
export function restartParticipant(this: Huddles, slug: string, hid: string, handle: string): void {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
  if (!p) throw new HuddleError(404, `no participant @${handle}`);
  if (p.status !== "failed" && p.status !== "stopped") throw new HuddleError(409, `@${handle} is ${p.status}, not failed or stopped`);
  this.updateP(slug, hid, handle, { status: "idle", error: null });
  const live = h.status === "live";
  this.system(slug, hid, `@${handle} was restarted by @you${live ? "" : "; it wakes when the huddle resumes"}.`, live ? [handle] : []);
  this.userActed(slug, hid);
}

/** The user viewed the huddle up to message `seq` (the Huddle tab, scrolled to the latest): the "for you" count clears up to there. */
export function markSeen(this: Huddles, slug: string, hid: string, seq: number): Huddle {
  const h = this.get(slug, hid);
  const me = h.participants.find((p) => p.handle === USER_HANDLE);
  if (!Number.isFinite(seq)) throw new HuddleError(400, "seq must be a number");
  const to = Math.min(Math.floor(seq), h.seq);
  if (!me || me.cursor >= to) return h;
  return this.update(slug, hid, (x) => {
    const m = x.participants.find((p) => p.handle === USER_HANDLE)!;
    m.cursor = Math.max(m.cursor, to);
  });
}

/** The user acted on the huddle: what tagged them so far counts as seen (the "for you" count starts over). */
export function userActed(this: Huddles, slug: string, hid: string) {
  if (!this.store.getHuddle(slug, hid)) return;
  this.update(slug, hid, (x) => {
    const me = x.participants.find((p) => p.handle === USER_HANDLE);
    if (me) me.cursor = x.seq;
  });
}

/**
 * Stop agents: every huddle agent's run and the huddle's reply runs end, and the huddle stops routing until resumed.
 * The tickets' own sessions keep working (only their huddle replies stop).
 */
export function stopAll(this: Huddles, slug: string, hid: string): Huddle {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
  this.update(slug, hid, (x) => {
    x.status = "stopped";
    x.stopReason = null;
    for (const p of x.participants) if (p.kind === "agent") p.status = "stopped";
  });
  this.system(slug, hid, "Huddle agents stopped by @you. The tickets' own runs keep going.");
  this.userActed(slug, hid);
  if (h.auto) this.autoEnded(slug, hid, "user", "the user stopped it");
  return this.get(slug, hid);
}

/**
 * Resume routing; stopped participants wake again when tagged (or, in monitor mode, on new messages), and whoever
 * was tagged while the huddle was stopped wakes now. addBudgetUsd raises the budget (needed when it was spent);
 * the agent-only count starts over.
 */
export function resume(this: Huddles, slug: string, hid: string, addBudgetUsd = 0): Huddle {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!Number.isFinite(addBudgetUsd) || addBudgetUsd < 0) throw new HuddleError(400, "addBudgetUsd must be a positive amount");
  const max = (h.maxCostUsd ?? DEFAULT_MAX_COST_USD) + addBudgetUsd;
  const spent = huddleCost(h);
  if (spent >= max) throw new HuddleError(409, `the huddle spent ${money(spent)} of its ${money(max)} budget: add budget to resume it`);
  this.update(slug, hid, (x) => {
    x.status = "live";
    x.stopReason = null;
    x.maxCostUsd = max;
    x.sinceUser = 0;
    x.held = null;
    x.finishedAtStop = false;
    if (spent < max * BUDGET_WARN) x.budgetWarned = false;
    for (const p of x.participants) if (p.status === "stopped") p.status = "idle";
  });
  if (h.status !== "live" || addBudgetUsd) this.system(slug, hid, `Huddle resumed by @you${addBudgetUsd ? ` with ${money(addBudgetUsd)} more budget (now ${money(max)})` : ""}.`);
  this.userActed(slug, hid);
  let tagged = false;
  for (const p of this.get(slug, hid).participants) if (p.kind !== "human" && this.wakeIfOwed(slug, hid, p.handle) === "mention") tagged = true;
  // Resume only delivers tags that were owed: without one, no agent has new work and the huddle would look stuck.
  if (!tagged) this.system(slug, hid, "Nobody was tagged while the huddle was stopped, so no agent has new work. @you: tag an agent to give it work, or close the huddle.");
  return this.get(slug, hid);
}

/**
 * The user closes a huddle (or the host ticket is done or deleted: `why`): the huddle's runs stop, the history
 * stays read-only, and the agents' own worktrees are removed when clean. The tickets' own work is untouched.
 */
export function close(this: Huddles, slug: string, hid: string, why?: string, summarize = true): Huddle {
  const h = this.get(slug, hid);
  if (h.status === "closed") return h;
  for (const p of h.participants) if (p.kind !== "human") this.stopParticipantRun(slug, h, p);
  this.system(slug, hid, why ? `Huddle closed: ${why}. The history stays, read-only.` : "Huddle closed by @you. The history stays, read-only.");
  const out = this.update(slug, hid, (x) => {
    x.status = "closed";
    x.closedAt = nowIso();
    for (const p of x.participants) if (p.kind === "agent" && p.status === "working") p.status = "stopped";
  });
  if (h.participants.some((p) => p.kind === "agent" && (p.worktree || p.copy))) this.chore(this.removeWorktrees(slug, hid));
  this.chore(this.cleanOutputs(slug, h.hostTicket, hid));
  if (h.auto) this.autoEnded(slug, hid, why ? "closed" : "user", why ?? "the user closed it");
  if (summarize) this.ensureSummary(slug, hid);
  return out;
}

/** The host ticket was deleted or moved to Done: its huddles close (a deleted one's without a summary). */
export function closeForTicket(this: Huddles, slug: string, ticketId: string, why = DELETED): void {
  const t = why === DELETED ? null : this.store.getTicket(slug, ticketId);
  for (const h of this.store.openHuddles(slug)) {
    if (h.hostTicket === ticketId && (!t || endedByDone(h, t))) this.close(slug, h.id, why, why !== DELETED);
  }
}

/**
 * A huddle just closed: make sure it has a summary. @main writes it when the host ticket can run (a queued chat
 * message); otherwise, or when that run ends without it, the board writes fallbackSummary. An older huddle's summary
 * in the single legacy file, written during this huddle, becomes this huddle's.
 */
export function ensureSummary(this: Huddles, slug: string, hid: string): void {
  const h = this.load(slug, hid);
  const t = h && this.store.getTicket(slug, h.hostTicket);
  if (!h || !t) return;
  const dir = this.store.outputsDir(slug, t.id);
  const file = join(dir, summaryFile(hid));
  if (existsSync(file)) return;
  const legacy = join(dir, LEGACY_SUMMARY_FILE);
  if (existsSync(legacy) && statSync(legacy).mtime.toISOString() >= h.createdAt) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(legacy, file);
    return this.touch(slug, hid);
  }
  const canRun = t.status !== "done" && !!t.sessionId && !!t.sessionStarted && this.sessionExists(t.sessionId);
  if (!canRun) return this.writeFallbackSummary(slug, hid);
  this.summaryOwed.add(`${slug}/${hid}`);
  this.board.chat(slug, t.id, summaryAsk(h, file), { peer: true }).catch(() => {
    this.summaryOwed.delete(`${slug}/${hid}`);
    this.writeFallbackSummary(slug, hid);
  });
}

/** The board's own summary (fallbackSummary), unless one exists by now. */
export function writeFallbackSummary(this: Huddles, slug: string, hid: string): void {
  const h = this.load(slug, hid);
  if (!h || !this.store.getTicket(slug, h.hostTicket)) return;
  const file = join(this.store.outputsDir(slug, h.hostTicket), summaryFile(hid));
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const outputs = this.store.listOutputs(slug, h.hostTicket).map((o) => o.name);
  writeFileSync(file, fallbackSummary(h, this.store.readHuddleMessages(slug, hid), outputs));
  this.touch(slug, hid);
}

/** Tell the UI the huddle changed (its summary appeared) without changing it. */
export function touch(this: Huddles, slug: string, hid: string) {
  const h = this.load(slug, hid);
  if (h) this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
}

export function chore(this: Huddles, p: Promise<void>) {
  const tracked = p.catch((e) => console.error("huddle cleanup failed", e)).finally(() => this.chores.delete(tracked));
  this.chores.add(tracked);
}

/**
 * After a close: remove the read-only snapshots, and each helper's copy of the folder when nothing would be lost
 * (every change in it was handed in and none still waits for a decision); a system note lists the ones kept.
 * Older huddles' own worktrees go when they have no uncommitted changes or commits the host's branch lacks.
 */
export async function removeWorktrees(this: Huddles, slug: string, hid: string): Promise<void> {
  // The agents' runs were just stopped: let them end first.
  await Promise.all([...this.runs.entries()].filter(([k]) => k.startsWith(`${slug}/${hid}/`)).flatMap(([, r]) => [r.promise, r.refreshing ?? undefined]));
  const h = this.load(slug, hid);
  const profile = this.store.getProfile(slug);
  if (!h || !profile) return;
  const base = this.store.getTicket(slug, h.hostTicket)?.branch ?? profile.baseBranch;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const p of h.participants) {
    if (p.kind !== "agent") continue;
    if (p.copy) {
      const c = p.copy;
      // Only the folder the board made for it: a stored path elsewhere is never removed.
      if (c.dir !== agentDir(profile, h, p)) {
        kept.push(`@${p.handle}: ${c.dir} (not where the board keeps copies, so it was left alone)`);
        continue;
      }
      const mine = (h.handIns ?? []).filter((x) => x.from === p.handle);
      const waiting = mine.some((x) => x.status === "waiting");
      // Its last hand-in hit a conflict and was never redone: what it handed in stays saved.
      const redo = mine.at(-1)?.status === "conflict";
      let keep: string | null = waiting ? "changes it handed in still wait for a decision" : null;
      try {
        if (!keep && (await unhanded(c.dir, c.kind))) keep = "it has changes that were never handed in";
        if (!keep) await removeCopy(c.dir, c.kind === "git" ? c.repo ?? profile.path : undefined, c.branch, redo);
        if (!keep && redo) kept.push(`@${p.handle}: ${c.dir}.handins (changes that weren't brought in because of a conflict)`);
      } catch (e) {
        keep = `couldn't remove it: ${(e as Error).message}`;
      }
      if (existsSync(keptDir(c.dir))) kept.push(`@${p.handle}: ${keptDir(c.dir)} (changes saved before a fresh copy was made)`);
      if (keep) kept.push(`@${p.handle}: ${c.dir} (${keep})`);
      else {
        removed.push(`@${p.handle}`);
        this.updateP(slug, hid, p.handle, { copy: null });
      }
      continue;
    }
    if (!p.worktree) continue;
    if (!p.branch) {
      // A read-only snapshot: nothing in it is anyone's work, so it goes without a note.
      const r = existsSync(p.worktree) ? await git(["git", "worktree", "remove", "--force", p.worktree], profile.path) : null;
      if (r && r.code !== 0) kept.push(`@${p.handle}: ${p.worktree}: ${r.stderr.trim() || "couldn't remove it"}`);
      else this.updateP(slug, hid, p.handle, { worktree: null });
      continue;
    }
    const why = await removeOwnWorktree(profile.path, p.worktree, p.branch ?? null, base);
    if (why) kept.push(`@${p.handle}: ${p.worktree}${p.branch ? ` (branch ${p.branch})` : ""}: ${why}`);
    else {
      removed.push(`@${p.handle}`);
      this.updateP(slug, hid, p.handle, { worktree: null, branch: null });
    }
  }
  const lines = [
    ...(removed.length ? [`Removed the copies of the folder of ${removed.join(", ")} (all their changes were handed in).`] : []),
    ...(kept.length ? ["Kept these copies of the folder, so nothing is lost; take what you need from them, then delete them yourself:", ...kept.map((k) => `- ${k}`)] : []),
  ];
  if (lines.length) this.system(slug, hid, lines.join("\n"));
}

/**
 * Removes project copies and dependency folders helpers left in their folders of the ticket's outputs
 * (output-copies.ts), for one huddle (`hid`, just closed) or every closed huddle of a ticket that moved to Done.
 * Helpers of a huddle still open on the ticket keep their folders. Runs after the helpers' runs have ended.
 */
export function cleanOutputs(this: Huddles, slug: string, ticketId: string, hid?: string): Promise<void> {
  const key = `${slug}/${ticketId}`;
  const next = (this.cleaning.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.cleanOutputsNow(slug, ticketId, hid));
  const mine = next.finally(() => {
    if (this.cleaning.get(key) === mine) this.cleaning.delete(key);
  });
  this.cleaning.set(key, mine);
  return mine;
}

export async function cleanOutputsNow(this: Huddles, slug: string, ticketId: string, hid?: string): Promise<void> {
  // The board's huddles are cached in memory (huddleIndex); filtering them is no file read.
  let mine = this.store.huddleIndex(slug).filter((x) => x.hostTicket === ticketId && (!hid || x.id === hid || x.status !== "closed"));
  if (!mine.some((x) => x.status === "closed")) return;
  const profile = this.store.getProfile(slug);
  if (!profile || !this.store.getTicket(slug, ticketId)) return;
  // Their runs were just stopped: let them end first, so nothing writes while the copies go.
  const ids = new Set(mine.filter((x) => x.status === "closed").map((x) => `${slug}/${x.id}/`));
  await Promise.all([...this.runs.entries()].filter(([k]) => ids.has(k.slice(0, k.lastIndexOf("/") + 1))).map(([, r]) => r.promise));
  mine = this.store.huddleIndex(slug).filter((x) => x.hostTicket === ticketId && (!hid || x.id === hid || x.status !== "closed"));
  const busy = new Set(mine.filter((x) => x.status !== "closed").flatMap((x) => x.participants.map((p) => p.handle)));
  const handles = mine.filter((x) => x.status === "closed" && (!hid || x.id === hid))
    .flatMap((x) => x.participants.filter((p) => p.kind === "agent" && !busy.has(p.handle)).map((p) => p.handle));
  if (!handles.length) return;
  const { removed, failed, worktree } = await removeOutputCopies(this.store.outputsPath(slug, ticketId), handles, await projectNames(profile.path), profile.path);
  // Only entries whose folder is gone are pruned; run in the project, never inside the helper-made folder.
  if (worktree) await git(["git", "worktree", "prune"], profile.path).catch(() => null);
  if (failed.length) console.warn(`[huddle] couldn't remove these from ${ticketId}'s outputs: ${failed.join(", ")}`);
  if (removed.length) console.log(`[huddle] removed ${removed.length} copied or installed folders from ${ticketId}'s outputs: ${removed.join(", ")}`);
  // The huddle may have been deleted during a long removal.
  if (!hid || (!removed.length && !failed.length) || !this.load(slug, hid)) return;
  const lines = [
    ...(removed.length ? [`Removed copies of the project the helpers left in the ticket's outputs (${removed.join(", ")}). Reports and other results stay.`] : []),
    ...(failed.length ? [`Couldn't fully remove: ${failed.join(", ")}. Delete what's left yourself if you don't need it.`] : []),
  ];
  this.system(slug, hid, lines.join("\n"));
}

/** Daemon exiting: agents mid-turn are marked so recover() resumes them; every agent run is killed. */
export async function shutdown(this: Huddles): Promise<void> {
  this.shuttingDown = true;
  if (this.sweeper) clearInterval(this.sweeper);
  this.sweeper = null;
  const runs = [...this.runs.entries()];
  for (const [key, run] of runs) {
    const [slug, hid, handle] = key.split("/");
    if (!run.idle && !run.stopRequested) this.updateP(slug, hid, handle, { interrupted: true });
    run.stopRequested = true;
    run.handle?.stop();
  }
  await Promise.race([Promise.all(runs.map(([, r]) => r.promise)), Bun.sleep(6000)]);
}

/**
 * After a daemon restart: huddles whose host is done close; agents cut off mid-turn carry on, ones held back by a
 * pending restart start; then everyone (ticket sessions included) gets the wakes it was owed.
 */
export function recover(this: Huddles): void {
  for (const profile of this.store.listProfiles()) {
    const slug = profile.slug;
    for (const h of this.store.openHuddles(slug)) {
      const host = this.store.getTicket(slug, h.hostTicket);
      if (host?.status === "done" && endedByDone(h, host)) {
        this.close(slug, h.id, "the host ticket moved to Done");
        continue;
      }
      for (const p of h.participants) {
        if (p.kind !== "agent") continue;
        // working: cut off mid-turn. interrupted while idle: a wake held back by the pending restart.
        const cut = p.status === "working" || (p.interrupted && !p.sessionStarted);
        if (h.status === "live" && p.status !== "stopped" && (cut || p.interrupted)) {
          if (cut) {
            const digest = this.takeUnread(slug, h.id, p.handle, true)?.digest ?? "";
            this.runAgent(slug, h.id, p.handle, huddleAgentPrompt(p.sessionStarted ? "interrupted" : "start", p, digest));
            continue;
          }
          this.updateP(slug, h.id, p.handle, { interrupted: false });
        } else if (p.status === "working" || p.interrupted) this.updateP(slug, h.id, p.handle, { status: "idle", interrupted: false });
      }
      for (const p of h.participants) if (p.kind !== "human") this.wakeIfOwed(slug, h.id, p.handle);
    }
    // A ticket that waits for an auto huddle that is gone (closed while the daemon was down): back to Review.
    for (const t of this.store.listTickets(slug)) {
      const a = t.autoHuddle;
      if (a?.state !== "live") continue;
      const h = a.huddleId ? this.store.getHuddle(slug, a.huddleId) : null;
      if (h && h.status === "live") continue;
      if (h && h.status === "stopped") continue;
      this.store.addComment(slug, t.id, "ai", "Its auto huddle is no longer open; the work was not landed.");
      this.board.setAutoHuddle(slug, t.id, null, this.board.isRunning(slug, t.id) ? {} : { status: "review", outcome: "stopped", lastActivity: null });
    }
    this.freeSlot(slug);
  }
}

export async function whenIdle(this: Huddles): Promise<void> {
  while (this.runs.size || this.chores.size) await Promise.all([...this.runs.values()].map((r) => r.promise).concat([...this.chores]));
}
