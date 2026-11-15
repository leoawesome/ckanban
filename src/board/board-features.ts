import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoKind } from "../runs/git";
import { pauser } from "../core/lag";
import { featureRoot, featureRows, groupsOf, isFeature, MAX_LEVEL, parentLink } from "../../web/src/features/family/family";
import { applyPatch, CHANGES_SHOWN, FEATURE_TRAILER, familySig, readStatus, SAVED_CHANGES_FILE, savedChangesMarkdown, statusFacts, statusFiles, statusSections, STATUS_NOTE_MAX, writeStatus, type SavedChanges, type SavedStatus, type StatusFacts, type StatusPatch } from "./feature";
import { featureMainNote, featureMemberNote, statusNotesBlock, statusNudgePrompt } from "../runs/prompts";
import { run as runCmd } from "../runs/git";
import { type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { ActiveRun, CHANGES_TTL_MS, subtreeIds, sigChanges } from "./board-types";

/** The board's facts for a feature's status, its saved changes included (from the cache). */
export function facts(this: Board, slug: string, tickets: Ticket[], topId: string, prNotes?: Record<string, string>): StatusFacts {
  // A sub-feature is one line: working while it or anything under it works, with its own status's next step.
  const sub = (t: Ticket) => ({
    working: this.isRunning(slug, t.id) || t.status === "ready" || t.status === "in_progress" || this.familyWorking(slug, t.id, tickets) > 0,
    headline: (() => {
      try {
        return readStatus(this.store.outputsPath(slug, t.id))?.next ?? null;
      } catch {
        return null;
      }
    })(),
  });
  return { ...statusFacts(tickets, topId, (t) => this.waitsOnUser(slug, t.id), prNotes, sub), changes: this.savedChanges(slug, tickets, topId) };
}

/**
 * A feature's saved changes from the cache (null until first built). The list is rebuilt in the background when the
 * family changed (a ticket finished or merged) or after CHANGES_TTL_MS; a changed list rewrites status.md and
 * reloads the status block. Never throws: no version history, no commits or a failing git just give no list.
 */
export function savedChanges(this: Board, slug: string, tickets: Ticket[], topId: string): SavedChanges | null {
  const top = tickets.find((t) => t.id === topId);
  if (!top || !(isFeature(tickets, top) || top.statusAt)) return null;
  const key = `${slug}\u0000${topId}`;
  const sig = familySig(featureRows(tickets, topId).map((r) => r.ticket));
  const c = this.changesCache.get(key);
  if (!c || c.sig !== sig || Date.now() - c.at > CHANGES_TTL_MS) void this.buildChanges(slug, topId, key, sig);
  return c?.value ?? null;
}

export async function buildChanges(this: Board, slug: string, topId: string, key: string, sig: string): Promise<void> {
  if (this.changesChecks.has(key) || this.shuttingDown) return;
  this.changesChecks.add(key);
  try {
    const prev = this.changesCache.get(key);
    const value = await this.readChanges(slug, topId).catch(() => prev?.value ?? null);
    this.changesCache.set(key, { at: Date.now(), sig, value });
    if (JSON.stringify(value) === JSON.stringify(prev?.value ?? null)) return;
    const top = this.store.getTicket(slug, topId);
    if (!top || !value || this.shuttingDown) return;
    if (value.file) {
      try {
        writeFileSync(value.file, savedChangesMarkdown(top, value));
      } catch {}
    }
    // status.md and the open status block show the new list.
    this.refreshStatusFile(slug, topId);
    this.patch(slug, topId, { statusAt: nowIso() });
  } finally {
    this.changesChecks.delete(key);
  }
}

/**
 * The feature's saved changes now: with version history, every entry on the base branch (and its remote copy) and
 * on the main ticket's copy whose message carries "Ckanban-Feature: <topId>", newest first; in a folder without
 * history, the files the family's tickets edited. Null when there is nothing to show.
 */
export async function readChanges(this: Board, slug: string, topId: string): Promise<SavedChanges | null> {
  const profile = this.store.getProfile(slug);
  const tickets = this.store.listTickets(slug);
  const top = tickets.find((t) => t.id === topId);
  if (!profile || !top) return null;
  // The cached kind without re-checking it (a re-check may start runs); else asked once here.
  const repo = this.repos.get(profile.path)?.kind ?? await repoKind(profile.path);
  const full = join(this.store.outputsDir(slug, topId), SAVED_CHANGES_FILE);
  const withFile = (c: SavedChanges): SavedChanges => (c.items.length > CHANGES_SHOWN ? { ...c, file: full } : c);
  if (repo === "local" || repo === "remote") {
    const base = profile.baseBranch || "main";
    const baseRefs = [base, ...(repo === "remote" ? [`origin/${base}`] : [])];
    const grep = `--grep=^${FEATURE_TRAILER}: ${topId}$`;
    const r = await runCmd(["git", "log", "--ignore-missing", "--format=%H%x09%h%x09%s", grep, ...baseRefs, ...(top.branch ? [top.branch] : []), "--"], profile.path, undefined, 20_000);
    if (r.code !== 0) return null;
    const all = r.stdout.split("\n").filter((l) => l.trim()).map((l) => {
      const [full, id, ...rest] = l.split("\t");
      return { full: full!, id: id!, text: rest.join("\t").trim() };
    });
    const dropped = top.branch ? await this.copyDuplicates(profile.path, grep, baseRefs, top.branch, all) : new Set<string>();
    const items = all.filter((c) => !dropped.has(c.full)).map(({ id, text }) => ({ id, text }));
    return items.length ? withFile({ kind: "history", items }) : null;
  }
  const files = new Set<string>();
  const pause = pauser();
  for (const r of featureRows(tickets, topId)) if (r.depth === 0 || !r.ticket.main) for (const f of (await this.store.activityDigest(slug, r.ticket.id, pause)).edited) files.add(f);
  const root = profile.path.endsWith("/") ? profile.path : `${profile.path}/`;
  const items = [...files].map((f) => (f.startsWith(root) ? f.slice(root.length) : f)).sort().map((text) => ({ text }));
  return items.length ? withFile({ kind: "files", items }) : null;
}

/**
 * Entries only on the main ticket's copy whose change is already on the base branch as another entry (re-applied or
 * squashed when it landed): same patch, or same subject line when the patch differs (e.g. after a clash was sorted
 * out). Only the feature's own entries are compared, so it stays cheap. Empty when unsure.
 */
export async function copyDuplicates(this: Board, cwd: string, grep: string, baseRefs: string[], branch: string, all: { full: string; text: string }[]): Promise<Set<string>> {
  const dropped = new Set<string>();
  const r = await runCmd(["git", "log", "--ignore-missing", "--format=%H", grep, branch, "--not", ...baseRefs, "--"], cwd, undefined, 20_000);
  if (r.code !== 0) return dropped;
  const copyOnly = new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const onBase = all.filter((c) => !copyOnly.has(c.full));
  if (!copyOnly.size || !onBase.length) return dropped;
  const subjects = new Set(onBase.map((c) => c.text));
  for (const c of all) if (copyOnly.has(c.full) && subjects.has(c.text)) dropped.add(c.full);
  const rest = all.filter((c) => copyOnly.has(c.full) && !dropped.has(c.full)).map((c) => c.full);
  if (!rest.length) return dropped;
  // git patch-id prints "<patch id> <commit>" per commit; commits are passed as arguments, never through the shell text.
  const ids = await runCmd(["sh", "-c", 'git log --no-walk=unsorted -p --no-color --format="commit %H" "$@" | git patch-id --stable', "sh", ...onBase.map((c) => c.full), ...rest], cwd, undefined, 20_000);
  if (ids.code !== 0) return dropped;
  const byCommit = new Map(ids.stdout.split("\n").map((l) => l.trim().split(" ")).filter((p) => p.length === 2).map(([pid, sha]) => [sha!, pid!]));
  const basePatches = new Set(onBase.map((c) => byCommit.get(c.full)).filter(Boolean));
  for (const sha of rest) if (basePatches.has(byCommit.get(sha))) dropped.add(sha);
  return dropped;
}

/** The top ticket of id's own feature (featureRoot: a sub-feature for its tickets), its saved status and the board's facts. */
export function featureStatus(this: Board, slug: string, id: string): { top: Ticket; feature: boolean; saved: SavedStatus | null; facts: StatusFacts; sections: ReturnType<typeof statusSections>; path: string } {
  const tickets = this.store.listTickets(slug);
  const top = featureRoot(tickets, id);
  if (!top) throw new Error(`ticket ${id} not found`);
  const dir = this.store.outputsDir(slug, top.id);
  const saved = readStatus(dir);
  const facts = this.facts(slug, tickets, top.id, saved?.prNotes);
  return { top, feature: isFeature(tickets, top), saved, facts, sections: statusSections(saved, facts), path: statusFiles(dir).md };
}

/** Rewrites status.md from the saved status and the board's facts now (a feature or a ticket with a status only). */
export function refreshStatusFile(this: Board, slug: string, id: string): string | null {
  const f = this.featureStatus(slug, id);
  if (!f.saved && !f.feature) return null;
  writeStatus(this.store.outputsDir(slug, f.top.id), f.top, f.saved, f.facts, false);
  return f.path;
}

/** update_status: replaces only the sections the patch names, on the top ticket of id's family (making it a feature). */
export function updateStatus(this: Board, slug: string, id: string, patch: StatusPatch): ReturnType<Board["featureStatus"]> & { markdown: string } {
  const tickets = this.store.listTickets(slug);
  const top = featureRoot(tickets, id);
  if (!top) throw new Error(`ticket ${id} not found`);
  const dir = this.store.outputsDir(slug, top.id);
  const now = nowIso();
  const saved = applyPatch(readStatus(dir), patch, now, familySig(featureRows(tickets, top.id).slice(1).map((r) => r.ticket)));
  const facts = this.facts(slug, tickets, top.id, saved.prNotes);
  const markdown = writeStatus(dir, top, saved, facts, true);
  this.patch(slug, top.id, { statusAt: now });
  return { ...this.featureStatus(slug, top.id), markdown };
}

/** "Add a note": saved in the status under its date; the main chat gets it at its next turn without a run starting. */
export function addStatusNote(this: Board, slug: string, id: string, text: string): ReturnType<Board["featureStatus"]> {
  const note = text.trim().slice(0, STATUS_NOTE_MAX);
  if (!note) throw new Error("the note is empty");
  const tickets = this.store.listTickets(slug);
  const top = featureRoot(tickets, id);
  if (!top) throw new Error(`ticket ${id} not found`);
  const dir = this.store.outputsDir(slug, top.id);
  const now = nowIso();
  const old = readStatus(dir);
  const saved: SavedStatus = { ...(old ?? {}), updatedAt: now, notes: [...(old?.notes ?? []), { at: now, text: note, delivered: false }] };
  writeStatus(dir, top, saved, this.facts(slug, tickets, top.id, saved.prNotes), true);
  this.patch(slug, top.id, { statusAt: now });
  return this.featureStatus(slug, top.id);
}

/** The user's status notes the top ticket's Claude hasn't had yet, as a prompt block (marked delivered); null for none. */
export function takeStatusNotes(this: Board, slug: string, id: string): string | null {
  const dir = this.store.outputsPath(slug, id);
  const saved = existsSync(dir) ? readStatus(dir) : null;
  const fresh = saved?.notes?.filter((n) => !n.delivered) ?? [];
  if (!saved || !fresh.length) return null;
  const t = this.store.getTicket(slug, id)!;
  const next = { ...saved, notes: saved.notes!.map((n) => ({ ...n, delivered: true })) };
  const f = this.facts(slug, this.store.listTickets(slug), id, next.prNotes);
  writeStatus(dir, t, next, f, true);
  return statusNotesBlock(fresh);
}

/** What a run in a feature is told about the status: the main chat reads and keeps it; family runs may update it. */
export function featureNote(this: Board, slug: string, t: Ticket): string | null {
  const tickets = this.store.listTickets(slug);
  const top = featureRoot(tickets, t.id);
  if (!top || !isFeature(tickets, top)) return null;
  const path = this.refreshStatusFile(slug, top.id);
  if (!path) return null;
  return top.id === t.id ? featureMainNote(path) : featureMemberNote(top, path);
}

/**
 * After a chat reply or plan wake of a feature's top ticket that didn't call update_status while the family changed
 * since the status was last updated: one short quiet turn asking Claude to update it. At most once per run.
 */
export async function nudgeStatus(this: Board, run: ActiveRun, startedAt: string): Promise<boolean> {
  if (run.nudged || !run.statusEligible || run.stopRequested || this.shuttingDown || this.restartPending) return false;
  if (this.waiting(run.slug, run.id).length) return false;
  const tickets = this.store.listTickets(run.slug);
  const top = featureRoot(tickets, run.id);
  if (!top || top.id !== run.id || !isFeature(tickets, top)) return false;
  const saved = readStatus(this.store.outputsPath(run.slug, run.id));
  if (!saved || (saved.claudeAt && saved.claudeAt >= startedAt)) return false;
  const rows = featureRows(tickets, top.id).slice(1).map((r) => r.ticket);
  const sig = familySig(rows);
  if (saved.familySig === sig) return false;
  run.nudged = true;
  const path = this.refreshStatusFile(run.slug, run.id)!;
  // Same mode as the reply it follows: a Planning chat's nudge can't change files either.
  const mode = run.chat?.mode ?? "act";
  const t = this.store.getTicket(run.slug, run.id);
  run.chat = { text: statusNudgePrompt(path, sigChanges(saved.familySig ?? "", sig, rows), t ? this.openForm(t) : []), mode, raw: true, quiet: true, nudge: true };
  run.promptMsgId = undefined;
  run.inFlight = new Map();
  run.handle = null;
  run.retried = false;
  run.restartRequested = false;
  this.begin(run);
  await this.executeOnce(run);
  return true;
}

/**
 * Gather tickets into the feature: each picked one links under its group (an existing group of the feature, "new" for
 * a new group named newGroup, or none: under the feature itself). Chats, work and pull requests stay; running tickets
 * keep running. A ticket in another family moves (setPartOf rules). Its own tickets that would sit deeper than level 2
 * move up beside it (still in their plan, if any). by: who to credit, for a chat outside the feature ("by the chat of ...").
 */
export async function gather(this: Board, slug: string, featureId: string, items: { id: string; group?: string | null }[], newGroup?: string | null, by?: string | null, opts: { hide?: boolean } = {}): Promise<{
  gathered: Ticket[]; movedUp: { id: string; title: string; to: string }[]; skipped: { id: string; reason: string }[]; group: Ticket | null;
  /** hide: what kept its card and why (main tickets, sub-features, groups); hidden cards are the rest of gathered. */
  kept: { id: string; reason: string }[];
}> {
  const top = featureRoot(this.store.listTickets(slug), featureId);
  if (!top) throw new Error(`ticket ${featureId} not found`);
  let group: Ticket | null = null;
  if (items.some((i) => i.group === "new")) {
    group = await this.createTicket(slug, { title: newGroup?.trim() || "New group", body: "", status: "backlog", mode: "auto", kind: "group", partOf: top.id });
  }
  const groups = new Set(groupsOf(this.store.listTickets(slug), top.id).map((g) => g.id));
  const gathered: Ticket[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const movedUp: { id: string; title: string; to: string }[] = [];
  const kept: { id: string; reason: string }[] = [];
  for (const item of items) {
    const target = item.group === "new" ? group!.id : item.group || top.id;
    const t = this.store.getTicket(slug, item.id);
    if (!t) {
      skipped.push({ id: item.id, reason: "not found" });
      continue;
    }
    if (t.id === top.id) {
      skipped.push({ id: t.id, reason: "that is the feature itself" });
      continue;
    }
    if (target !== top.id && !groups.has(target)) {
      skipped.push({ id: t.id, reason: `${target} is not a group of this feature` });
      continue;
    }
    // Its own tickets (all levels), to keep within the depth limit once it has moved.
    const own = new Set(subtreeIds(this.store.listTickets(slug), t.id));
    try {
      // Its own depth and the sub-feature rule are checked; deeper tickets of its own move up below (and say so).
      if (parentLink(t)?.id !== target) await this.setPartOf(slug, t.id, target, null, { subtree: false });
      // hide: off the board like the feature's tasks (setShowOnBoard); a task, main ticket or group keeps what it has.
      const now = this.store.getTicket(slug, t.id)!;
      if (opts.hide && !now.tool) {
        try {
          this.setShowOnBoard(slug, t.id, false);
        } catch (e) {
          kept.push({ id: t.id, reason: (e as Error).message });
        }
      }
      gathered.push(this.store.getTicket(slug, t.id)!);
      this.store.addComment(slug, t.id, "ai", `Gathered into the feature "${top.title}" (${top.id})${target !== top.id ? `, under "${this.store.getTicket(slug, target)?.title}"` : ""}${by ? ` ${by}` : ""}.`);
    } catch (e) {
      skipped.push({ id: t.id, reason: (e as Error).message });
      continue;
    }
    // Its own tickets deeper than level 2 move up beside it: linked to its ancestor at level 1. Only inside this
    // feature (featureRows): a sub-feature's tickets count from it and never move across its edge.
    for (let guard = 0; guard < 500; guard++) {
      const rows = featureRows(this.store.listTickets(slug), top.id);
      const deep = rows.findIndex((r) => own.has(r.ticket.id) && r.depth > MAX_LEVEL);
      if (deep < 0) break;
      const anc = rows.slice(0, deep).findLast((r) => r.depth === 1)!;
      const d = rows[deep].ticket;
      this.patch(slug, d.id, { partOf: anc.ticket.id, partOfVia: null });
      movedUp.push({ id: d.id, title: d.title, to: anc.ticket.id });
      this.store.addComment(slug, d.id, "ai", `Moved up under "${anc.ticket.title}" so the feature "${top.title}" stays at most ${MAX_LEVEL} levels deep.`);
    }
  }
  if (gathered.length) this.store.addComment(slug, top.id, "ai", `Gathered ${gathered.length} ticket${gathered.length === 1 ? "" : "s"} into this feature${by ? ` ${by}` : ""}: ${gathered.map((t) => `"${t.title}"`).join(", ")}.`);
  this.emitTicket(slug, this.store.getTicket(slug, top.id)!);
  return { gathered, movedUp, skipped, group, kept };
}
