import { existsSync, readFileSync } from "node:fs";
import { copyAttachments, deleteAttachments, referencedAttachments } from "./attachments";
import { addWorktree, isGitRepo, removeWorktree, resolveBaseBranch, worktreeDir } from "../runs/git";
import { forkSessionBefore, forkSessionFile, forkTitle } from "../chat/fork";
import { type TicketKind } from "../../web/src/family";
import { followUpFor, followUpPlace } from "../../web/src/followUp";
import { quietContext } from "../server/quiet";
import { addHuddleSpend } from "../usage/spend";
import { kindDefaults } from "./main-ticket";
import { type PromptContext } from "../runs/prompts";
import { childrenOf, findCycle, normalizeNeeds, resolveDeps } from "./plan";
import { run as runCmd } from "../runs/git";
import { cutSession } from "../chat/rewind";
import { normalizeTags } from "./tags";
import { type Status, type Ticket, type TicketMode, type TicketSource } from "../core/types";
import { nowIso, slugify, starredTitle } from "../core/util";
import type { Board } from "./board";
import { reopenable, claudeSessionFile, ConflictError } from "./board-types";

export async function createTicket(this: Board,
  slug: string,
  input: {
    title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; jobId?: string; source?: TicketSource; parentId?: string; planKey?: string; dependsOn?: string[];
    needs?: string[]; tags?: string[]; important?: boolean; partOf?: string; partOfVia?: "chat";
    model?: string | null; raisedBy?: { scheduleId: string; ticketId: string } | null; proposedAs?: string; madeFrom?: string; kind?: TicketKind | null;
    effort?: string | null; main?: boolean; tool?: boolean; startFrom?: string | null; waitsForStart?: boolean;
  },
): Promise<Ticket> {
  const status = input.status === "in_progress" ? "ready" : input.status;
  input = this.placeInFeature(slug, input);
  const star = starredTitle(input.title);
  const t = this.store.createTicket(slug, {
    ...input, status, needs: normalizeNeeds(input.needs), tags: normalizeTags(input.tags),
    ...(star.important && star.title.trim() ? { title: star.title, important: true } : {}),
  });
  this.emitTicket(slug, t);
  // The planner's "Review proposal" badge depends on which of its proposed tickets exist.
  const parent = input.parentId ? this.store.getTicket(slug, input.parentId) : null;
  if (parent) this.emitTicket(slug, parent);
  if (status === "ready") this.dispatch(slug);
  if (status === "planning") this.autoRefine(slug, t.id);
  if (parent) this.advancePlans(slug);
  return this.store.getTicket(slug, t.id)!;
}

export async function updateTicket(this: Board,
  slug: string,
  id: string,
  patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "dependsOn" | "needs" | "tags" | "suggestedTags" | "important" | "runCapUsd" | "model" | "effort" | "ultracode" | "chrome" | "browsers">> & {
    expectedBody?: string;
    /** null: take the ticket out of its plan (only clearing is allowed here; adoptTickets sets it). */
    parentId?: null;
    /** true pins the card to the top of its column (pinnedAt now), false unpins it. */
    pinned?: boolean;
  },
  /** byUser: the user's own move (on the board, or asked for in the ticket's chat), not a run's or a planner's. */
  opts: { byUser?: boolean } = {},
): Promise<Ticket> {
  let current = this.store.getTicket(slug, id);
  if (!current) throw new Error(`ticket ${id} not found`);
  if (patch.body !== undefined && patch.expectedBody !== undefined && patch.expectedBody !== current.body) {
    throw new ConflictError("description changed since you started editing (Claude may have updated it); reload and retry");
  }
  const clean: Partial<Ticket> = {};
  if (patch.title !== undefined) {
    const star = starredTitle(patch.title);
    clean.title = star.important && star.title.trim() ? star.title : patch.title;
    if (clean.title !== patch.title) clean.important = true;
  }
  if (patch.body !== undefined) clean.body = patch.body;
  if (patch.order !== undefined) clean.order = patch.order;
  if (patch.mode !== undefined) clean.mode = patch.mode;
  if (patch.notice !== undefined) clean.notice = patch.notice;
  if (patch.runCapUsd !== undefined) clean.runCapUsd = patch.runCapUsd;
  if (patch.model !== undefined) clean.model = patch.model;
  if (patch.effort !== undefined) clean.effort = patch.effort;
  if (patch.ultracode !== undefined) clean.ultracode = patch.ultracode;
  if (patch.chrome !== undefined) clean.chrome = patch.chrome;
  if (patch.browsers !== undefined) clean.browsers = patch.browsers;
  if (patch.needs !== undefined) clean.needs = normalizeNeeds(patch.needs);
  if (patch.tags !== undefined) clean.tags = normalizeTags(patch.tags);
  if (patch.suggestedTags !== undefined || patch.tags !== undefined) {
    // A suggestion that is now a tag is no longer a suggestion.
    const tags = clean.tags ?? current.tags ?? [];
    clean.suggestedTags = normalizeTags(patch.suggestedTags ?? current.suggestedTags).filter((s) => !tags.includes(s));
  }
  if (patch.important !== undefined) clean.important = !!patch.important;
  if (patch.pinned !== undefined) clean.pinnedAt = patch.pinned ? nowIso() : null;
  if (patch.parentId === null && current.parentId) {
    const plannerId = current.parentId;
    const me = current;
    const users = childrenOf(this.store.listTickets(slug), plannerId).filter((s) => s.id !== id && resolveDeps(s, [s, me]).deps.length);
    if (users.length) {
      throw new Error(`${users.map((u) => `"${u.title}"`).join(", ")} ${users.length === 1 ? "depends" : "depend"} on this ticket; change their dependsOn first`);
    }
    // Its dependencies and key named siblings of the plan it leaves.
    Object.assign(clean, { parentId: null, planKey: null, dependsOn: [] });
  }
  if (patch.dependsOn !== undefined && clean.parentId !== null) {
    clean.dependsOn = patch.dependsOn;
    if (current.parentId) {
      const siblings = childrenOf(this.store.listTickets(slug), current.parentId).map((s) => (s.id === id ? { ...s, dependsOn: patch.dependsOn } : s));
      const me = siblings.find((s) => s.id === id)!;
      const { missing } = resolveDeps(me, siblings);
      if (missing.length) throw new Error(`unknown dependency ${missing.map((m) => `"${m}"`).join(", ")}: use a sibling's ticket id or key`);
      const cycle = findCycle(siblings);
      if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}`);
    }
  }
  let status = patch.status;
  // A reply waiting for a slot stays put when reordered; moved elsewhere, it stops waiting.
  if (current.slotWait && status === "in_progress") status = undefined;
  if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";
  if (current.slotWait && status) current = this.cancelSlotWait(slug, id);

  const active = this.runs.get(this.key(slug, id));
  if (active && status && status !== "in_progress") {
    active.targetStatus = status;
    this.stopRun(active);
    await active.promise;
    current = this.store.getTicket(slug, id)!;
  }
  // The store places the ticket in its new column unless the patch carries a drop position.
  if (status && status !== current.status) clean.status = status;
  // Moved by hand: the user takes it from here, no automatic continue, and the card no longer waits for an auto huddle.
  if (clean.status && current.limit) clean.limit = null;
  if (clean.status && current.autoHuddle) clean.autoHuddle = null;
  if (clean.status && current.snooze) clean.snooze = null;
  // A task waiting to be started (waitsForStart): once moved, the plan runs it as usual.
  if (clean.status && current.waitsForStart) clean.waitsForStart = false;
  // Back to Planning/Backlog from Review/Done: remember where it was, so a follow-up card can put it back there.
  const shaping = clean.status === "planning" || clean.status === "backlog";
  if (shaping && reopenable(current.status)) clean.reopenedFrom = { status: current.status, outcome: current.outcome };
  else if (clean.status && !shaping && current.reopenedFrom) clean.reopenedFrom = null;
  let t = this.patch(slug, id, clean);

  if (clean.status === "done") t = await this.cleanupWorktree(slug, t);
  if (clean.status === "planning") this.autoRefine(slug, id);
  // The user moving a stopped main ticket back to work resumes its paused plan (before its run starts and reads it).
  if (opts.byUser && t.main && (clean.status === "ready" || clean.status === "in_progress")) this.resumeStoppedPlan(slug, id, "you moved it to " + clean.status.replace("_", " "));
  if (active || clean.status === "ready" || (clean.order !== undefined && t.status === "ready")) this.dispatch(slug);
  this.advancePlans(slug);
  return this.store.getTicket(slug, id)!;
}

/** Prompt context of a schedule's ticket: which schedule, and for a quiet one what it raised that is still open. */
export function scheduleContext(this: Board, slug: string, t: Ticket): PromptContext["schedule"] {
  const s = this.store.getSchedule(slug, t.scheduleId!);
  if (!s) return { id: t.scheduleId!, name: null, board: slug };
  return {
    id: s.id, name: s.name, board: slug,
    ...(s.quiet ? { quiet: quietContext(this.store.listOpenTickets(slug), this.store.scheduleHistoryDigest(slug, s.id).lastFired, s.id, t.id) } : {}),
  };
}

/**
 * Remove a quiet schedule's ticket whose run found nothing for the user, and note it in the schedule's history (with
 * its cost, which also counts in today's spend). Not when something came up meanwhile (a message, a new run, a move).
 */
export async function endQuietly(this: Board, slug: string, id: string, end: { summary: string; costUsd: number }): Promise<boolean> {
  const t = this.store.getTicket(slug, id);
  if (!t?.scheduleId || t.status !== "done" || this.isRunning(slug, id) || this.waiting(slug, id).length) return false;
  try {
    const scheduleId = t.scheduleId;
    await this.deleteTicket(slug, id);
    addHuddleSpend(this.store.root, slug, end.costUsd);
    const s = this.store.getSchedule(slug, scheduleId);
    if (s) {
      this.store.appendScheduleHistory(slug, scheduleId, { at: nowIso(), kind: "quiet", ticketId: id, summary: end.summary.slice(0, 500), costUsd: Math.round(end.costUsd * 10000) / 10000 });
      this.bus.emit({ type: "schedule.updated", profile: slug, id: scheduleId, schedule: s });
    }
    return true;
  } catch (e) {
    console.error(`ticket ${slug}/${id}: could not remove the quiet schedule run`, e);
    return false;
  }
}

/**
 * Delete a ticket. A main ticket takes its tool tickets with it (their runs stop and their copies go, as for any
 * deleted ticket); the rest of its family stays, unlinked. Refused while a merge into its copy runs.
 */
export async function deleteTicket(this: Board, slug: string, id: string): Promise<void> {
  const t0 = this.store.getTicket(slug, id);
  if (t0?.main) {
    if (this.merging(slug, id)) throw new Error("Wait a moment: a merge is running");
    // Deepest first, so a group never outlives its children.
    for (const o of this.toolTickets(slug, id).reverse()) {
      if (this.store.getTicket(slug, o.id)) await this.deleteOne(slug, o.id);
    }
  } else if (t0?.tool) {
    const main = this.mainOf(slug, t0);
    if (main && this.merging(slug, main.id)) throw new Error("Wait a moment: a merge is running");
  }
  await this.deleteOne(slug, id);
}

export async function deleteOne(this: Board, slug: string, id: string): Promise<void> {
  const active = this.runs.get(this.key(slug, id));
  if (active) {
    this.stopRun(active);
    await active.promise;
  }
  const t = this.store.getTicket(slug, id);
  const profile = this.store.getProfile(slug);
  if (t?.worktree && profile) await this.removeTicketWorktree(profile, t.worktree).catch(() => {});
  if (t) await this.dropRewindCopies(slug, t);
  if (t) deleteAttachments(this.store.attachmentsDir, this.attachmentsOf(slug, t));
  this.store.deleteTicket(slug, id);
  this.bus.emit({ type: "ticket.deleted", profile: slug, id });
  // Its family stays, unlinked from it; a suggestion to link under it goes too.
  for (const o of this.store.listTickets(slug)) {
    if (o.partOf === id) this.patch(slug, o.id, { partOf: null, partOfVia: null });
    if (o.parentSuggestion?.id === id) this.patch(slug, o.id, { parentSuggestion: null });
  }
}

/**
 * Move a Backlog ticket to another board: a fresh Backlog ticket there with the same title, description and tags
 * (chat, comments and runs stay behind), then the original goes. Refused while it is linked to other tickets.
 */
export async function moveTicket(this: Board, slug: string, id: string, target: string): Promise<Ticket> {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (!this.store.getProfile(target)) throw new Error(`board ${target} not found`);
  if (target === slug) throw new Error("The ticket is already on that board.");
  if (t.status !== "backlog") throw new Error("Only tickets in Backlog can move to another board.");
  if (this.runs.has(this.key(slug, id))) throw new Error("Claude is working on this ticket. Stop it first.");
  if (t.worktree || t.branch) throw new Error("This ticket has work in a copy of the folder. Delete the ticket or finish it instead of moving it.");
  const linked = t.parentId || t.dependsOn?.length || t.branchedFrom || t.madeFrom || t.plan
    || this.store.listTickets(slug).some((o) => o.id !== id && (o.parentId === id || o.branchedFrom === id || o.madeFrom === id
      || o.dependsOn?.some((d) => d === id || (!!t.planKey && d === t.planKey))));
  if (linked) throw new Error("Can't move: this ticket is linked to other tickets. Remove the links first.");
  // Create first, delete second: a failure in between leaves the original in place.
  const copy = await this.createTicket(target, { title: t.title, body: t.body, status: "backlog", tags: t.tags, important: t.important });
  try {
    this.store.deleteTicket(slug, id);
  } catch (e) {
    this.store.deleteTicket(target, copy.id);
    this.bus.emit({ type: "ticket.deleted", profile: target, id: copy.id });
    throw e;
  }
  this.bus.emit({ type: "ticket.deleted", profile: slug, id });
  return copy;
}

/** Images pasted into the ticket: its description, comments and chat (the Claude session transcript). */
export function attachmentsOf(this: Board, slug: string, t: Ticket): string[] {
  const texts = [t.body, ...this.store.listComments(slug, t.id).map((c) => c.text), ...(t.queued ?? []).map((m) => m.text)];
  const file = t.sessionId ? claudeSessionFile(t.sessionId) : null;
  if (file) {
    try {
      texts.push(readFileSync(file, "utf8"));
    } catch {}
  }
  return referencedAttachments(...texts);
}

/** Attach a Claude session the user already started in the profile folder (null unlinks). */
export async function linkSession(this: Board, slug: string, id: string, sessionId: string | null): Promise<Ticket> {
  const profile = this.store.getProfile(slug);
  const t = this.store.getTicket(slug, id);
  if (!profile || !t) throw new Error("ticket not found");
  if (this.isRunning(slug, id)) throw new Error("ticket is running; stop it before linking a session");
  if (sessionId !== null && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("invalid session id");
  if (t.worktree && sessionId !== null) {
    const r = await this.removeTicketWorktree(profile, t.worktree);
    if (!r.removed) throw new Error(`ticket already has a worktree with changes (${t.worktree}); cannot switch session`);
  }
  return this.patch(slug, id, sessionId === null
    ? { sessionId: null, workdir: null }
    // Linked work already exists and the next step is the user's: land in Review ("Your turn").
    : { sessionId, workdir: profile.path, worktree: null, runCount: 0, lastRunAt: new Date().toISOString(), status: "review" });
}

/**
 * Branch a ticket, like Claude Code's --fork-session: a new "Branch: <title>" ticket in Planning with a copy of
 * the conversation (new session id) and its own git branch off the source's branch. The source is untouched.
 * warning: something the user should know (uncommitted changes weren't copied, the source branch was gone).
 */
export async function branchTicket(this: Board, slug: string, id: string): Promise<{ ticket: Ticket; warning: string | null }> {
  const src = this.store.getTicket(slug, id);
  if (src && this.isRunning(slug, id)) throw new ConflictError("Claude is working on this ticket; branch it once Claude is done");
  return this.copyTicket(slug, id, { title: `Branch: ${src?.title ?? ""}`, before: null });
}

/**
 * Fork from here: like Branch, but the copied conversation ends just before the user message `uuid` (the UI puts
 * its text back in the new chat's box). Titled "<title> (fork)", "(fork 2)"… (forkTitle). Refused while Rewind
 * would be (a run, a waiting message). The first message forks to an empty chat that starts a new session.
 */
export async function forkTicket(this: Board, slug: string, id: string, uuid: string): Promise<{ ticket: Ticket; warning: string | null }> {
  const src = this.store.getTicket(slug, id);
  if (!src) throw new Error(`ticket ${id} not found`);
  return this.withRewind(slug, id, async () => {
    const title = forkTitle(src.title, this.store.listTickets(slug).map((t) => t.title));
    return this.copyTicket(slug, id, { title, before: uuid });
  });
}

export async function copyTicket(this: Board, slug: string, id: string, o: { title: string; before: string | null }): Promise<{ ticket: Ticket; warning: string | null }> {
  const profile = this.store.getProfile(slug);
  const src = this.store.getTicket(slug, id);
  if (!profile || !src) throw new Error(`ticket ${id} not found`);
  if (src.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
  const srcFile = src.sessionId ? claudeSessionFile(src.sessionId) : null;
  if (!src.sessionId || !srcFile) throw new Error(`this ticket has no Claude conversation to ${o.before ? "fork" : "branch"} yet`);
  if (src.workdir && !existsSync(src.workdir)) throw new Error(`linked session folder no longer exists: ${src.workdir}`);
  // Checked before anything is made: a message the chat can't be cut at is refused.
  if (o.before && !cutSession(readFileSync(srcFile, "utf8"), o.before)) throw new Error("The chat can't be forked from this message.");

  const title = o.title;
  const t = this.store.createTicket(slug, { title, body: src.body, status: "planning", mode: src.mode });
  const warnings: string[] = [];
  let worktree: string | null = null;
  try {
    const patch: Partial<Ticket> = {
      sessionId: crypto.randomUUID(), sessionStarted: true, refineStarted: true, interviewed: src.interviewed,
      branchedFrom: src.id, branchPoint: { at: nowIso(), sourceTitle: src.title },
    };
    // Same folder setup as the source: its linked folder, its own worktree branch, or the project folder.
    if (src.workdir) patch.workdir = src.workdir;
    else if (src.branch && (await isGitRepo(profile.path))) {
      const dir = worktreeDir(profile, t.id);
      const branch = `ck/${t.id}-${slugify(title)}`;
      const hasBranch = (await runCmd(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${src.branch}`], profile.path)).code === 0;
      let base: string | null = src.branch;
      if (!hasBranch) {
        base = await resolveBaseBranch(profile.path, profile.baseBranch);
        if (base === null) throw new Error(`branch ${src.branch} no longer exists and the repo has nothing to branch from`);
        warnings.push(`The source branch ${src.branch} no longer exists, so the branch starts from ${base}.`);
      } else if (src.worktree && existsSync(src.worktree)) {
        const st = await runCmd(["git", "status", "--porcelain"], src.worktree);
        if (st.code === 0 && st.stdout.trim()) warnings.push("Uncommitted changes in the source were not copied.");
      }
      await addWorktree(profile.path, dir, branch, base);
      worktree = dir;
      this.copyWorktreeFiles(slug, t.id, profile, dir);
      Object.assign(patch, { worktree: dir, branch, setupPending: true });
    } else {
      // The source works in the project folder itself: so does the branch, with the same Changes base.
      if (src.baseSha) patch.baseSha = src.baseSha;
      warnings.push((await isGitRepo(profile.path))
        ? "The original works in the project folder, so the branch edits the same files; they run one at a time."
        : "This folder has no version history, so the branch edits the same files as the original; they run one at a time.");
    }
    const fromCwd = src.workdir ?? src.worktree ?? (src.branch ? worktreeDir(profile, src.id) : profile.path);
    const toCwd = patch.workdir ?? worktree ?? profile.path;
    // The branch gets its own copies of pasted images, so deleting either ticket can't break the other.
    const rename = copyAttachments(this.store.attachmentsDir, referencedAttachments(src.body, readFileSync(srcFile, "utf8")));
    for (const [from, to] of Object.entries(rename)) patch.body = (patch.body ?? src.body).split(from).join(to);
    const fo = { fromId: src.sessionId, toId: patch.sessionId!, fromCwd, toCwd, rename };
    if (!o.before) forkSessionFile(srcFile, fo);
    else if (!forkSessionBefore(srcFile, o.before, fo)) {
      // Forked from the first message: nothing to copy, the first message starts a new session.
      Object.assign(patch, { sessionStarted: false, freshSession: true });
    }
    this.store.copyOutputs(slug, src.id, t.id);
    const out = this.patch(slug, t.id, patch);
    return { ticket: out, warning: warnings.join(" ") || null };
  } catch (e) {
    if (worktree) await removeWorktree(profile.path, worktree).catch(() => {});
    this.store.deleteTicket(slug, t.id);
    throw e;
  }
}

/**
 * Follow-up work the user asked for in the chat of a ticket that already ran, made by its proposal card (where it goes:
 * web/src/followUp.ts followUpPlace). In a feature it becomes a step (a tool ticket) run by the feature's main ticket
 * or a group above the ticket, shown under the ticket, so its result reaches the main ticket. A ticket on its own
 * becomes a main ticket and the work its first step, so the user keeps talking to it. An old ticket under others
 * without a main ticket gets a new ticket beside it (start: Ready, else Backlog). The ticket keeps its title and
 * description, and goes back to Review/Done when a chat or the user had moved it to Planning/Backlog for this.
 */
export async function followUpWork(this: Board, slug: string, id: string, input: { title: string; body: string; start?: boolean; important?: boolean }): Promise<Ticket> {
  const src = this.store.getTicket(slug, id);
  if (!src) throw new Error(`ticket ${id} not found`);
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  // Clicked again (another tab, a slow reply): what this card already made, even renamed or started since, also
  // once the first click made this ticket a main ticket.
  const all = this.store.listTickets(slug);
  const made = followUpFor(all, src.id, title);
  if (made) return made;
  if (src.main) throw new Error("A main ticket's card updates its own plan: it adds new work as steps itself.");
  if (src.tool) throw new Error("A step's follow-up work goes through its main ticket.");
  const place = followUpPlace(all, src.id)!;
  const shaping = src.status === "planning" || src.status === "backlog";
  const was = shaping && src.reopenedFrom ? src.reopenedFrom : src;
  const important = src.important || input.important ? { important: true } : {};
  const tags = src.tags?.length ? { tags: src.tags } : {};
  let t: Ticket;
  let manager: Ticket | null = null;
  if (place.as === "ticket") {
    // No main ticket to report to: a plain ticket beside it, building on its work while that waits in Review.
    t = await this.createTicket(slug, {
      title, body: input.body, status: "backlog", mode: "auto", proposedAs: title, madeFrom: src.id, partOf: place.partOf, ...tags, ...important,
      ...(was.status === "review" && src.branch && !src.workdir ? { startFrom: src.branch } : {}),
    });
  } else {
    if (place.as === "main") {
      this.patch(slug, src.id, { main: true });
      this.store.addComment(slug, src.id, "ai", `Became a main ticket: follow-up work "${title}" runs as its first step, and you keep talking here.`);
    }
    manager = place.as === "main" ? this.store.getTicket(slug, src.id)! : this.store.getTicket(slug, place.manager)!;
    const top = this.mainOf(slug, manager) ?? manager;
    // A step that changes files starts from the main ticket's copy, so its work merges back there.
    const startFrom = top.branch && top.worktree ? top.branch : null;
    const d = kindDefaults("build", this.store.getProfile(slug))!;
    t = await this.createTicket(slug, {
      title, body: input.body, status: "backlog", mode: "auto", proposedAs: title, madeFrom: src.id, parentId: manager.id, kind: "build", tool: true,
      model: d.model, effort: d.effort, ...(place.as === "step" && place.partOf ? { partOf: place.partOf } : {}), ...tags, ...important,
      ...(startFrom ? { startFrom } : {}),
    });
    this.store.addComment(slug, t.id, "ai", `Tool ticket of ${manager.id} ("${manager.title}"): follow-up work the user asked for in the chat of ${src.id} ("${src.title}").`);
    if (place.as === "step") this.store.addComment(slug, src.id, "ai", `Follow-up work "${title}" runs as a step of "${top.title}"; its result goes there.`);
  }
  if (shaping && src.reopenedFrom && !this.isRunning(slug, id)) {
    // Like a move by hand (Done cleans up its worktree); then its old outcome badge comes back too.
    await this.updateTicket(slug, id, { status: src.reopenedFrom.status });
    this.patch(slug, id, { outcome: src.reopenedFrom.outcome });
  }
  if (manager) {
    // Its manager's plan runs it in any column; a main ticket parked in Done or Backlog comes back to Review.
    if (this.store.getTicket(slug, manager.id)?.main) this.unparkForNewStep(slug, manager.id);
    this.ensurePlan(slug, manager.id);
    this.advancePlans(slug);
    return this.store.getTicket(slug, t.id)!;
  }
  return input.start ? this.updateTicket(slug, t.id, { status: "ready" }) : this.store.getTicket(slug, t.id)!;
}
