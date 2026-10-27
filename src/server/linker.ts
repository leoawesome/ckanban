// Parent suggestions: a side call picks the ticket a new one is part of (shown in its panel as Link / Not related),
// and the one-off Find links goes through the board once for tickets without a parent. Nothing links by itself here:
// the user confirms every link (Board.setPartOf).
import type { Board } from "./board";
import { jsonObject } from "./learn";
import { addSideSpend, type SideCaller } from "./side-call";
import type { Store } from "./store";
import type { Ticket } from "./types";
import { parentLink, wouldLoop } from "../../web/src/family";

/** Tickets a suggestion may point at: every open one, plus Done ones touched in the last RECENT_DAYS days. */
export const RECENT_DAYS = 30;
/** At most this many candidates go into one call (most recently touched first). */
export const MAX_CANDIDATES = 120;
/** A per-ticket suggestion is cheap and quick; Find links reads the whole board once, so it gets a stronger model. */
export const SUGGEST_MODEL = "haiku";
export const FIND_MODEL = "sonnet";
const BODY_CHARS = 200;
const REASON_CHARS = 160;

export interface LinkSuggestion {
  id: string;
  parent: string;
  reason: string;
}

/** The tickets a suggestion may name, newest first (see RECENT_DAYS). */
export function candidates(tickets: Ticket[], now = Date.now()): Ticket[] {
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString();
  return tickets
    .filter((t) => t.status !== "done" || (t.updatedAt ?? "") >= since)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_CANDIDATES);
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
};

function ticketLine(t: Ticket): string {
  const p = parentLink(t);
  const body = oneLine(t.body, BODY_CHARS);
  return `- ${t.id} [${t.status}] "${oneLine(t.title, 200)}"${p ? ` (part of ${p.id})` : ""}${body ? `: ${body}` : ""}`;
}

export const SUGGEST_SYSTEM = `You sort tickets on a kanban board into families: a ticket can be part of one earlier ticket, so all the tickets of one piece of work (a project, a feature, a "flight") hang together.
You get a new ticket and a list of other tickets. Pick the ticket the new one is part of: the same piece of work, a next step, a fix or a follow-up of it. When a family already exists, pick its top ticket or the member the new one belongs under most closely. Same tool, area or tag alone is not enough. When nothing clearly fits, answer null: a wrong link is worse than none.
Answer with JSON only: {"parent": "<ticket id from the list>" or null, "reason": "<one short plain sentence why, under 20 words, naming no ticket ids>"}`;

export function suggestPrompt(t: Ticket, list: Ticket[]): string {
  return `NEW TICKET\n${t.id} "${t.title}"\n${oneLine(t.body, 1200) || "(no description)"}\n\nOTHER TICKETS\n${list.map(ticketLine).join("\n")}`;
}

/** The suggestion in a side call's answer, or null for none, an unknown ticket or an answer that isn't the JSON asked for. */
export function parseSuggestion(text: string, ids: string[]): { id: string; reason: string } | null {
  const v = jsonObject(text);
  const parent = typeof v?.parent === "string" ? v.parent.trim() : "";
  if (!parent || !ids.includes(parent)) return null;
  return { id: parent, reason: oneLine(typeof v?.reason === "string" ? v.reason : "", REASON_CHARS) };
}

export const FIND_SYSTEM = `You sort tickets on a kanban board into families: a ticket can be part of one other ticket, so all the tickets of one piece of work (a project, a feature, a "flight") hang together under a top ticket.
You get the board's tickets; "(part of X)" marks links that already exist. For tickets without a parent that clearly belong to the same piece of work as another ticket, say which ticket they are part of. Group a family under one top ticket (usually its first or main ticket); a member may also go under a closer member. Same tool, area or tag alone is not enough. Leave out everything that doesn't clearly fit: a wrong link is worse than none.
Answer with JSON only: {"links": [{"id": "<ticket without a parent>", "parent": "<ticket id>", "reason": "<one short plain sentence, under 20 words, naming no ticket ids>"}]}`;

export function findPrompt(list: Ticket[]): string {
  return `TICKETS\n${list.map(ticketLine).join("\n")}`;
}

/**
 * Links in a Find links answer that can be made: both tickets in the list, the child without a parent yet, each child
 * once, and no loop (checked as if the earlier links were made). Null when the answer isn't the JSON asked for.
 */
export function parseFound(text: string, list: Ticket[]): LinkSuggestion[] | null {
  const v = jsonObject(text);
  if (!v || !Array.isArray(v.links)) return null;
  const sim = list.map((t) => ({ ...t }));
  const byId = new Map(sim.map((t) => [t.id, t]));
  const out: LinkSuggestion[] = [];
  for (const l of v.links as Record<string, unknown>[]) {
    const id = typeof l?.id === "string" ? l.id.trim() : "";
    const parent = typeof l?.parent === "string" ? l.parent.trim() : "";
    const child = byId.get(id);
    if (!child || !byId.has(parent) || parentLink(child) || wouldLoop(sim, id, parent)) continue;
    child.partOf = parent;
    out.push({ id, parent, reason: oneLine(typeof l?.reason === "string" ? l.reason : "", REASON_CHARS) });
  }
  return out;
}

export class Linker {
  constructor(private store: Store, private board: Board, private sideCall: SideCaller, private now: () => number = Date.now) {}

  /**
   * Looks for a parent for a ticket the user just created and puts it on the ticket (Board.suggestParent). Runs in the
   * background: a failing call or no fit leaves nothing to show. Tickets that already have a parent are skipped.
   */
  async suggest(slug: string, id: string): Promise<void> {
    const t = this.store.getTicket(slug, id);
    if (!t || t.parentChecked || parentLink(t) || t.branchedFrom) return;
    const list = candidates(this.store.listTickets(slug).filter((o) => o.id !== id), this.now());
    if (!list.length) {
      this.board.suggestParent(slug, id, null);
      return;
    }
    const r = await this.sideCall({ system: SUGGEST_SYSTEM, prompt: suggestPrompt(t, list), model: SUGGEST_MODEL, timeoutMs: 90_000 });
    if (!this.store.getTicket(slug, id)) return;
    if (!r.ok) {
      console.error(`suggesting a parent for ${slug}/${id}: ${r.error}`);
      return;
    }
    addSideSpend(this.store.sideSpendPath(slug, id), "link", r.costUsd);
    this.board.suggestParent(slug, id, parseSuggestion(r.text, list.map((o) => o.id)));
  }

  /** Find links: suggested parents for the board's open and recent tickets that have none. Changes nothing. */
  async find(slug: string): Promise<{ links: LinkSuggestion[]; checked: number }> {
    const list = candidates(this.store.listTickets(slug), this.now());
    if (list.length < 2) return { links: [], checked: list.length };
    const r = await this.sideCall({ system: FIND_SYSTEM, prompt: findPrompt(list), model: FIND_MODEL, timeoutMs: 240_000 });
    if (!r.ok) throw new Error(r.error);
    const links = parseFound(r.text, list);
    if (!links) throw new Error("Claude's answer wasn't in the expected form; try again");
    return { links, checked: list.length };
  }
}
