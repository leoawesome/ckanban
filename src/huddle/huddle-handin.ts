// Huddles: changes helpers hand in from their own copies (methods of the Huddles class in huddle.ts, split by topic).
import { existsSync } from "node:fs";
import { hasCommits } from "../runs/git";
import { activeHost, MAIN_HANDLE } from "./huddle-roster";
import { accept as acceptHandIn, handIn as saveHandIn, handInDir as handInSaved } from "./huddle-copies";
import type { HandIn, HuddleParticipant } from "../core/types";
import { nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, canManage, HANDIN_SUMMARY_MAX, handInFiles } from "./huddle-types";

/**
 * A lead, @main or the user lets a helper change files: from its next run it works in its own copy of the folder
 * (made then) with the edit tools, and hands its changes in. Not in Planning, which never changes the project.
 */
export function allowChanges(this: Huddles, slug: string, hid: string, by: HuddleParticipant, handle: string): HuddleParticipant {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, "only a lead, @main or the user can let a helper change files; ask them in the huddle");
  const p = h.participants.find((x) => x.handle === handle.replace(/^@/, "").trim());
  if (!p || p.kind !== "agent") throw new HuddleError(404, `no helper @${handle} (only helpers the huddle runs get a copy of the folder)`);
  if (this.store.getTicket(slug, h.hostTicket)?.status === "planning") throw new HuddleError(409, "the ticket is in Planning, which never changes files; nobody in this huddle changes them");
  if (by.kind === "agent" && by.handle === p.handle) throw new HuddleError(403, "you can't give yourself the right to change files; ask @main or another lead");
  if (p.canEdit) return p;
  // Its session worked in the host's folder (no snapshot there): a new one starts in the copy, reading the huddle again.
  const moved = !p.worktree && !!p.sessionStarted;
  this.updateP(slug, hid, p.handle, { canEdit: true, workspace: "own", ...(moved ? { sessionId: null, sessionStarted: false, cursor: 0 } : {}) });
  // Its edit tools and copy come with a new run: a session kept open between turns ends at its next pause.
  this.runs.get(this.key(slug, hid, p.handle))?.handle?.endWhenIdle();
  this.system(slug, hid, `@${by.handle} let @${p.handle} change files. @${p.handle}: you now work in your own copy of the folder; do the work there and hand it in with huddle_hand_in.`, [p.handle]);
  return this.get(slug, hid).participants.find((x) => x.handle === p.handle)!;
}

/**
 * A helper hands in what it changed in its copy, with a one-line summary: the files are saved aside as they are
 * now, a card goes in the chat and @main is tagged to accept or reject them. One waits at a time per helper.
 */
export async function handIn(this: Huddles, slug: string, hid: string, by: HuddleParticipant, summary: string): Promise<HandIn> {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (by.kind !== "agent") throw new HuddleError(400, "only helpers hand in changes; yours are in the ticket's folder already");
  const p = h.participants.find((x) => x.handle === by.handle)!;
  if (!p.canEdit) throw new HuddleError(403, "you can't change files in this huddle; ask @main or a lead to let you (huddle_allow_changes)");
  if (!p.copy || !existsSync(p.copy.dir)) throw new HuddleError(409, "you have no copy of the folder yet; it is made when your next run starts");
  if (p.copy.fresh) throw new HuddleError(409, "your copy is out of date after a conflict; finish this turn without changing files: your fresh copy comes at your next turn");
  const text = summary.trim().replace(/\s+/g, " ");
  if (!text) throw new HuddleError(400, "summary is required: one line on what you changed");
  if (text.length > HANDIN_SUMMARY_MAX) throw new HuddleError(400, `the summary is ${text.length} characters, over the limit of ${HANDIN_SUMMARY_MAX}; keep it to one line`);
  const waiting = (h.handIns ?? []).find((x) => x.from === p.handle && x.status === "waiting");
  if (waiting) throw new HuddleError(409, `your hand-in ${waiting.id} still waits for a decision; wait for it (you are tagged), then hand in again`);
  const id = `c${(h.handIns?.length ?? 0) + 1}`;
  const files = await saveHandIn(p.copy.dir, p.copy.kind, id);
  if (!files.length) throw new HuddleError(409, "nothing changed in your copy since your last hand-in (or since it was made); nothing was handed in");
  // Another hand-in may have been recorded while the files were saved.
  if (this.get(slug, hid).handIns?.some((x) => x.id === id)) throw new HuddleError(409, "another hand-in came in at the same moment; hand in again");
  const hi: HandIn = { id, from: p.handle, summary: text, files, status: "waiting", at: nowIso() };
  this.update(slug, hid, (x) => void (x.handIns ??= []).push(hi));
  // The host decides (unless it handed this in itself), else @main.
  const host = activeHost(h);
  const decider = host === p.handle ? MAIN_HANDLE : host;
  const m = this.append(slug, hid, p.handle,
    `${text}\n\nHand-in ${id}: ${handInFiles(files)}. @${decider}: accept or reject it with huddle_review_changes.`,
    "handin", h.participants.map((x) => x.handle), false, undefined, id);
  if (this.get(slug, hid).status === "live" && this.brakes(slug, hid, p, m)) this.route(slug, hid, m);
  return hi;
}

/**
 * A lead, @main or the user accepts a hand-in (its files go into the host ticket's folder) or rejects it (the
 * helper is told why). When the host's folder changed some of the same files since the helper's copy was made,
 * nothing is applied: the hand-in is a conflict, the helper gets a fresh copy and is asked to redo the work.
 */
export async function reviewHandIn(this: Huddles, slug: string, hid: string, by: HuddleParticipant, id: string, accept: boolean, reason = ""): Promise<HandIn> {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, "only a lead, @main or the user accepts or rejects changes");
  const pending = () => {
    const x = (this.get(slug, hid).handIns ?? []).find((y) => y.id === id.trim());
    if (!x) throw new HuddleError(404, `no hand-in ${id} in huddle ${hid}`);
    if (x.status !== "waiting") throw new HuddleError(409, `hand-in ${x.id} was already ${x.status}`);
    return x;
  };
  const hi = pending();
  if (by.kind === "agent" && by.handle === hi.from) throw new HuddleError(403, "you can't accept or reject your own hand-in; @main or another lead decides");
  const why = reason.trim().replace(/\s+/g, " ").slice(0, 500);
  const decided = { by: by.handle, decidedAt: nowIso(), reason: why || null };
  const set = (patch: Partial<HandIn>) => this.update(slug, hid, (x) => void Object.assign(x.handIns!.find((y) => y.id === hi.id)!, patch));
  if (!accept) {
    set({ status: "rejected", ...decided });
    this.system(slug, hid, `@${by.handle} rejected @${hi.from}'s changes (${hi.id})${why ? `: ${why}` : "."} Nothing was changed in the ticket's folder.`, [hi.from]);
    return this.get(slug, hid).handIns!.find((y) => y.id === hi.id)!;
  }
  if (this.store.getTicket(slug, h.hostTicket)?.status === "planning") throw new HuddleError(409, "the ticket is in Planning, which never changes files");
  const helper = h.participants.find((x) => x.handle === hi.from);
  if (!helper?.copy) throw new HuddleError(409, `@${hi.from}'s copy of the folder is gone, so its changes can't be brought in`);
  const host = await this.board.ensureSession(slug, h.hostTicket);
  pending();
  let conflicts: string[];
  try {
    conflicts = acceptHandIn(host.dir, helper.copy.dir, hi.id, hi.files).conflicts;
  } catch (e) {
    throw new HuddleError(500, `couldn't bring in the changes, so nothing was changed: ${(e as Error).message}`);
  }
  if (!conflicts.length) {
    set({ status: "accepted", ...decided });
    const n = hi.files.length;
    // With a host running the room, @main hears about them in the host's final report.
    const tell = by.handle === MAIN_HANDLE || activeHost(this.get(slug, hid)) !== MAIN_HANDLE ? "" : ` @${MAIN_HANDLE}: they are in your folder now.`;
    this.system(slug, hid, `@${by.handle} accepted @${hi.from}'s changes (${hi.id}): ${n} file${n === 1 ? "" : "s"} now in the ticket's folder.${tell}`, tell ? [MAIN_HANDLE] : []);
    return this.get(slug, hid).handIns!.find((y) => y.id === hi.id)!;
  }
  set({ status: "conflict", conflicts, ...decided, reason: null });
  // A fresh copy from the host's folder as it is now; failing that, the helper's next run makes one.
  // Mid-turn, the helper may still be changing its copy: the fresh copy comes with its next run instead.
  const run = this.runs.get(this.key(slug, hid, helper.handle));
  run?.handle?.endWhenIdle();
  let fresh = !run || run.idle;
  if (fresh) {
    try {
      await this.copyFor(slug, this.get(slug, hid), helper, host.dir, host.isGit && (await hasCommits(host.dir)));
    } catch (e) {
      fresh = false;
      console.error(`couldn't make a fresh copy for @${helper.handle}`, e);
    }
  }
  if (!fresh) this.updateP(slug, hid, helper.handle, { copy: { ...helper.copy, fresh: true } });
  const files = conflicts.length > 8 ? `${conflicts.slice(0, 8).join(", ")} and ${conflicts.length - 8} more` : conflicts.join(", ");
  this.system(slug, hid,
    `@${hi.from}'s changes (${hi.id}) weren't brought in: the ticket's folder also changed ${files} since @${hi.from}'s copy was made. Nothing was changed. ` +
    `@${hi.from}: your copy ${fresh ? "is now a fresh copy of the ticket's folder" : "becomes a fresh copy of the ticket's folder at your next turn, so finish this turn without changing files"}; redo your change there and hand it in again (what you handed in is saved in ${handInSaved(helper.copy.dir, hi.id)}).`,
    [hi.from]);
  return this.get(slug, hid).handIns!.find((y) => y.id === hi.id)!;
}
