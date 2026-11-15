import { familyBelow, featureRoot, hideableCard, linkProblem, parentLink, wouldLoop } from "../../web/src/family";
import { run as runCmd } from "../runs/git";
import { type Ticket } from "../core/types";
import type { Board } from "./board";

/**
 * Makes id part of parent's family (null unlinks). via "chat": the parent's chat created it. A missing parent or a
 * loop (a ticket under its own descendant) is refused. Any parent suggestion is settled by it.
 * Moving it somewhere else also undoes the link that put it where it was: a plan ticket leaves its plan (refused
 * while siblings depend on it), and a ticket made from another's card stops building on that ticket's work if it
 * hasn't started, so the family shows where the user put it.
 */
export async function setPartOf(this: Board, slug: string, id: string, parent: string | null, via: "chat" | null = null, opts: { subtree?: boolean } = {}): Promise<Ticket> {
  let t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (parent !== null) {
    if (!this.store.getTicket(slug, parent)) throw new Error(`ticket ${parent} not found`);
    const without = this.store.listTickets(slug).map((o) => (o.id === id ? { ...o, parentId: null } : o));
    if (wouldLoop(without, id, parent)) {
      const p = this.store.getTicket(slug, parent)!;
      throw new Error(parent === id ? `"${t.title}" can't be part of itself` : `"${p.title}" is already inside "${t.title}", so "${t.title}" can't go under it.`);
    }
    // Depth (the whole part that moves) and one sub-feature level: never adjusted, refused with the reason.
    const problem = linkProblem(without, t, parent, opts);
    if (problem) throw new Error(problem);
  }
  if (t.parentId && t.parentId !== parent) t = await this.updateTicket(slug, id, { parentId: null });
  const patch: Partial<Ticket> = { partOf: parent, partOfVia: parent ? via : null, parentSuggestion: null, parentChecked: true };
  // A main ticket linked under another stays a main ticket: a sub-feature with its own card, chat, tasks and schedules.
  // A task unlinked from its feature never stays hidden without a main ticket: it becomes its own work on the board
  // (a main ticket when tasks of its own hang under it, so they keep reporting to it).
  if (!parent && t.tool) Object.assign(patch, this.ownWorkPatch(slug, t));
  // A ticket made from another's card that builds on its work in Review stops doing so once it moves away (not started yet).
  if (!t.tool && t.madeFrom && t.partOf === t.madeFrom && parent !== t.madeFrom && t.startFrom && !t.worktree) patch.startFrom = null;
  // Still in the same plan: that link already says it.
  if (parent && t.parentId === parent) Object.assign(patch, { partOf: null, partOfVia: null });
  return this.patch(slug, id, patch);
}

/** What a task becomes when it stops being one: its own work on the board (a main ticket when tasks hang under it, or always with main). */
export function ownWorkPatch(this: Board, slug: string, t: Ticket, main = false): Partial<Ticket> {
  const hasTasks = familyBelow(this.store.listTickets(slug), t.id).some((o) => o.id !== t.id && o.tool);
  return { tool: false, showOnBoard: null, ...(main || hasTasks ? { main: true } : {}) };
}

/**
 * "Make it its own work": a task (tool ticket) becomes a main ticket with its own card and chat. Linked, it stays where
 * it is as a sub-feature (refused with the reason when the family rules don't allow one there; unlinking always
 * works); its plan link becomes a plain "part of" link, so its parent's plan no longer runs it or hears its results.
 * Not while it runs.
 */
export async function makeOwnWork(this: Board, slug: string, id: string): Promise<Ticket> {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (!t.tool) throw new Error(`"${t.title}" is already its own work`);
  if (this.isRunning(slug, id)) throw new Error(`"${t.title}" is working right now: make it its own work once its run ends`);
  const all = this.store.listTickets(slug);
  const was = this.mainOf(slug, t);
  const link = parentLink(t);
  const parent = link ? all.find((o) => o.id === link.id) ?? null : null;
  if (parent) {
    const problem = linkProblem(all.map((o) => (o.id === id ? { ...o, parentId: null } : o)), { ...t, main: true }, parent.id);
    if (problem) {
      // Inside a sub-feature: say so about the task itself (linkProblem names the sub-feature).
      const sub = featureRoot(all, parent.id);
      if (sub?.main && parentLink(sub)) {
        throw new Error(`"${t.title}" can't become its own work here: it is inside the sub-feature "${sub.title}", and a sub-feature can't hold another sub-feature. Unlink it first to make it top-level work.`);
      }
      throw new Error(`${problem} Unlink it instead to make it its own work at the top of the board.`);
    }
    if (t.parentId) await this.updateTicket(slug, id, { parentId: null });
  }
  const out = this.patch(slug, id, { ...this.ownWorkPatch(slug, t, true), ...(parent ? { partOf: parent.id, partOfVia: null } : {}) });
  this.store.addComment(slug, id, "ai", parent
    ? `Made its own work: a sub-feature of "${parent.title}" with its own card and chat. Tasks under it report here.`
    : "Made its own work: its own card and chat on the board.");
  if (was && was.id !== id) this.store.addComment(slug, was.id, "ai", `"${t.title}" (${t.id}) is now its own work${parent ? `, a sub-feature of "${parent.title}"` : ""}: its results go to its own chat.`);
  return out;
}

/**
 * "Show on board": a task gets a card like any ticket (on) or goes back to living in its feature only (off). A card
 * gathered into a feature (hideableCard) can be hidden the same way (off) and shown again (on); it keeps its chat,
 * results and run history and stays in the feature's Tasks list. Main tickets, sub-features and groups keep their card.
 */
export function setShowOnBoard(this: Board, slug: string, id: string, on: boolean): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  if (t.tool) return this.patch(slug, id, { showOnBoard: on ? true : null });
  if (on) return t.showOnBoard === false ? this.patch(slug, id, { showOnBoard: null }) : t;
  const all = this.store.listTickets(slug);
  if (t.main) throw new Error(`"${t.title}" is a main ticket${parentLink(t) ? " (a sub-feature)" : ""}: it keeps its own card on the board`);
  if (t.kind === "group" || t.kind === "round") throw new Error(`"${t.title}" is a group of its feature: it keeps its own card on the board`);
  const top = featureRoot(all, t.id);
  if (!hideableCard(t) || !top || top.id === t.id) {
    throw new Error(`"${t.title}" isn't part of a feature: only a task or a card gathered into a feature can be hidden from the board`);
  }
  return this.patch(slug, id, { showOnBoard: false });
}

/** Not related: the suggestion goes and the board doesn't suggest a parent for this ticket again. */
export function dismissParentSuggestion(this: Board, slug: string, id: string): Ticket {
  if (!this.store.getTicket(slug, id)) throw new Error(`ticket ${id} not found`);
  return this.patch(slug, id, { parentSuggestion: null, parentChecked: true });
}

/** The board's parent suggestion (linker.ts), unless the ticket got a parent or was settled meanwhile. */
export function suggestParent(this: Board, slug: string, id: string, suggestion: { id: string; reason: string } | null): Ticket | null {
  const t = this.store.getTicket(slug, id);
  if (!t || t.parentChecked || t.partOf || t.parentId) return null;
  if (suggestion && !this.store.getTicket(slug, suggestion.id)) suggestion = null;
  return this.patch(slug, id, { parentSuggestion: suggestion, parentChecked: true });
}
