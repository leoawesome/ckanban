// Ticket families: every ticket has at most one parent, so related tickets (one flight of work) form a tree. Two
// links make a parent: "part of" (partOf, a plain link the user or a chat made) and a plan (parentId). Old add-on
// links (addOnOf) load as partOf (store.ts). The ticket panel's family tree, the cards' chips and the get_family tool all read it from here.
// No imports: the server (get_family) and its tests import this file too.

export type LinkHow = "linked" | "chat" | "plan";

export interface FamilyTicket {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  partOf?: string | null;
  partOfVia?: "chat" | null;
  parentId?: string | null;
  /** A main ticket: linked under another ticket, it is a sub-feature (its own card, chat and tasks). */
  main?: boolean;
}

/** How a ticket hangs on its parent; partOf wins over a plan. null: no parent link. */
export function parentLink(t: Pick<FamilyTicket, "partOf" | "partOfVia" | "parentId">): { id: string; how: LinkHow } | null {
  if (t.partOf) return { id: t.partOf, how: t.partOfVia === "chat" ? "chat" : "linked" };
  if (t.parentId) return { id: t.parentId, how: "plan" };
  return null;
}

/** Words a family row uses for how it is linked. */
export const LINK_WORDS: Record<LinkHow, string> = { linked: "linked", chat: "from chat", plan: "plan" };

export interface FamilyRow<T extends FamilyTicket> {
  ticket: T;
  /** 0 for the top ticket. */
  depth: number;
  /** null for the top ticket. */
  how: LinkHow | null;
}

/** A ticket's parent when it is still on the board (a deleted parent leaves the ticket at the top). */
function parentIn<T extends FamilyTicket>(byId: Map<string, T>, t: T): { parent: T; how: LinkHow } | null {
  const l = parentLink(t);
  const parent = l && l.id !== t.id ? byId.get(l.id) : undefined;
  return parent && l ? { parent, how: l.how } : null;
}

/** The last answer of childrenByParent, with what it was made from (see there). */
let lastKids: { tickets: FamilyTicket[]; links: unknown[]; out: Map<string, { ticket: FamilyTicket; how: LinkHow }[]> } | null = null;

/** What childrenByParent reads of a ticket besides the ticket itself, which may be changed in place (in the UI). */
const LINK_FIELDS = ["id", "createdAt", "partOf", "partOfVia", "parentId"] as const;

function sameKidsInput(last: NonNullable<typeof lastKids>, tickets: FamilyTicket[]): boolean {
  if (last.tickets.length !== tickets.length) return false;
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (t !== last.tickets[i]) return false;
    // The server's tickets are frozen: the same object has the same links.
    if (Object.isFrozen(t)) continue;
    for (let k = 0; k < LINK_FIELDS.length; k++) if (t[LINK_FIELDS[k]] !== last.links[i * LINK_FIELDS.length + k]) return false;
  }
  return true;
}

/**
 * Direct children of every ticket (oldest first), with how each is linked. The board's view of every main ticket asks
 * for this of the same tickets (sorting a big board's tickets each time was seconds per listing), so the last answer
 * is kept while the same tickets with the same links are asked about. Callers only read it.
 */
export function childrenByParent<T extends FamilyTicket>(tickets: T[]): Map<string, { ticket: T; how: LinkHow }[]> {
  if (lastKids && sameKidsInput(lastKids, tickets)) return lastKids.out as Map<string, { ticket: T; how: LinkHow }[]>;
  const out = kidsOf(tickets);
  lastKids = { tickets: [...tickets], links: tickets.flatMap((t) => LINK_FIELDS.map((f) => t[f])), out: out as Map<string, { ticket: FamilyTicket; how: LinkHow }[]> };
  return out;
}

function kidsOf<T extends FamilyTicket>(tickets: T[]): Map<string, { ticket: T; how: LinkHow }[]> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, { ticket: T; how: LinkHow }[]>();
  // ISO times sort as plain strings (localeCompare is many times slower).
  for (const t of [...tickets].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))) {
    const p = parentIn(byId, t);
    if (!p) continue;
    const list = out.get(p.parent.id) ?? out.set(p.parent.id, []).get(p.parent.id)!;
    list.push({ ticket: t, how: p.how });
  }
  return out;
}

/** The top ticket of id's family (id itself when it has no parent). A loop in old data stops the walk. */
export function familyRoot<T extends FamilyTicket>(tickets: T[], id: string): T | undefined {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = parentIn(byId, cur);
    if (!p || seen.has(p.parent.id)) break;
    cur = p.parent;
  }
  return cur;
}

/** id's whole family, from the top ticket down (children oldest first, depth first). [] when id is not on the board. */
export function familyOf<T extends FamilyTicket>(tickets: T[], id: string): FamilyRow<T>[] {
  const root = familyRoot(tickets, id);
  if (!root) return [];
  const kids = childrenByParent(tickets);
  const out: FamilyRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (t: T, depth: number, how: LinkHow | null) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ ticket: t, depth, how });
    for (const c of kids.get(t.id) ?? []) walk(c.ticket, depth + 1, c.how);
  };
  walk(root, 0, null);
  return out;
}

/** The rows near id in its family (familyOf order): its parents up to the top ticket, itself and its own children. */
export function familyNearby<T extends FamilyTicket>(rows: FamilyRow<T>[], id: string): FamilyRow<T>[] {
  const at = rows.findIndex((r) => r.ticket.id === id);
  if (at < 0) return rows;
  const me = rows[at];
  // Depth first: the last row seen at each shallower depth is an ancestor.
  const path: FamilyRow<T>[] = [];
  for (const r of rows.slice(0, at)) path[r.depth] = r;
  const kids: FamilyRow<T>[] = [];
  for (const r of rows.slice(at + 1)) {
    if (r.depth <= me.depth) break;
    if (r.depth === me.depth + 1) kids.push(r);
  }
  return [...path.slice(0, me.depth), me, ...kids];
}

/**
 * The items of a main ticket's family working now: running, or Ready / In progress (queued or about to run). Tool
 * tickets and tickets the user added count; the main ticket itself never does. A sub-feature (a main ticket below it)
 * counts as one item while it or anything under it works; its own tasks never count apart. family: tickets of the
 * family with their links (familyOf or familyBelow rows; tickets not under mainId are left out). One rule for the
 * server's card (main-ticket.ts familyCard, board.familyWorking) and the main ticket's chat (its "Working:" line).
 */
export function workingInFamily<T extends FamilyTicket & { status: string }>(family: T[], mainId: string, running: (t: T) => boolean): T[] {
  const byId = new Map(family.map((t) => [t.id, t]));
  // What t counts as under mainId: itself, or the outermost sub-feature it sits in; undefined when it isn't under mainId.
  const itemOf = (t: T): T | undefined => {
    let sub: T | undefined;
    const seen = new Set<string>();
    for (let cur: T | undefined = t; cur && !seen.has(cur.id);) {
      seen.add(cur.id);
      if (cur.main) sub = cur;
      const up = parentLink(cur)?.id;
      if (!up) return undefined;
      if (up === mainId) return sub ?? t;
      cur = byId.get(up);
    }
    return undefined;
  };
  const out = new Map<string, T>();
  for (const t of family) {
    if (t.id === mainId || !(running(t) || t.status === "ready" || t.status === "in_progress")) continue;
    const item = itemOf(t);
    if (item && !out.has(item.id)) out.set(item.id, item);
  }
  return [...out.values()];
}

/** The sub-features of mainId working now (workingInFamily's sub-feature items): the card's "· 1 sub-feature running". */
export function subFeaturesWorking<T extends FamilyTicket & { status: string }>(family: T[], mainId: string, running: (t: T) => boolean): T[] {
  return workingInFamily(family, mainId, running).filter((t) => t.main);
}

/**
 * A sub-feature's row in its parent's Tasks tab: Working while it or anything of its own works (its tasks too, like
 * the parent's status says), else its own state.
 */
export function subFeatureState<T extends FamilyTicket & { status: string; running?: boolean | null }>(tickets: T[], subId: string, own: FamilyState): FamilyState {
  return workingInFamily(familyBelow(tickets, subId), subId, (t) => !!t.running).length ? "working" : own;
}

/** Linking id under parent would make a ticket its own ancestor. */
export function wouldLoop(tickets: FamilyTicket[], id: string, parent: string): boolean {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (let cur = byId.get(parent); cur && !seen.has(cur.id); cur = parentIn(byId, cur)?.parent) {
    if (cur.id === id) return true;
    seen.add(cur.id);
  }
  return parent === id;
}

// ---- Features (a big piece of work followed from its top ticket; see feature.ts on the server) ----

/**
 * What a ticket is for, set when it is created. group: holds other tickets; round: a testing round; with_you: a tool
 * ticket that needs the user live (a phone test, an approval): it talks to the user in its main ticket's chat. Old
 * tickets have none.
 */
export type TicketKind = "explore" | "build" | "test" | "review" | "fix" | "group" | "round" | "with_you";
export const TICKET_KINDS: TicketKind[] = ["explore", "build", "test", "review", "fix", "group", "round", "with_you"];

/**
 * A tool ticket ("task"): no Your turn of its own; it lives in its main ticket's Family tab and reports there. "With
 * you" tool tickets too: their messages and questions show in the main ticket's chat and their "needs you" on its card.
 * Old plan children have no tool flag. A task shown on the board (showOnBoard) is still one: its Your turn and needs-you
 * go to its main ticket's chat; only its card shows (onBoard).
 */
export const hiddenTool = (t: { tool?: boolean; kind?: string | null } | null | undefined): boolean => !!t?.tool;

/** A task the user gave a card ("Show on board"). Old tickets have no flag: hidden as before. */
export const shownTool = (t: { tool?: boolean; showOnBoard?: boolean | null } | null | undefined): boolean => !!t?.tool && !!t?.showOnBoard;

/** What onBoard and hiddenCard read of a ticket. */
type BoardFlags = {
  tool?: boolean; showOnBoard?: boolean | null; main?: boolean; kind?: string | null; partOf?: string | null; parentId?: string | null;
  status?: string; running?: boolean;
};

/**
 * A card gathered into a feature (not a task, main ticket or group) can be hidden from the board too (showOnBoard
 * false): it lives in its feature's Tasks list like a task, but keeps its own chat and Your turn. It is one while it
 * is still part of a feature (unlinked or made a main ticket, its card comes back).
 */
export const hideableCard = (t: BoardFlags | null | undefined): boolean =>
  !!t && !t.tool && !t.main && t.kind !== "group" && t.kind !== "round" && !!(t.partOf || t.parentId);

/** A gathered card the user hid; it shows again while it works or waits for the user (In progress, Review). */
export const hiddenCard = (t: BoardFlags | null | undefined): boolean =>
  !!t && t.showOnBoard === false && hideableCard(t) && !t.running && t.status !== "in_progress" && t.status !== "review";

/**
 * The board shows a card for t (columns, counts, search, filters): any ticket but a task that isn't shown on the board
 * and a gathered card the user hid (hiddenCard).
 */
export const onBoard = (t: BoardFlags | null | undefined): boolean => !!t && (t.tool ? !!t.showOnBoard : !hiddenCard(t));

/** A "with you" tool ticket: a step that needs the user live; it may ask and notify the user (in its main ticket's chat). */
export const withYouTool = (t: { tool?: boolean; kind?: string | null } | null | undefined): boolean => !!t?.tool && t?.kind === "with_you";

/** byIdOf's maps, one per tickets list (a list is a new array whenever the board's tickets change). */
const byIdCache = new WeakMap<readonly FamilyTicket[], { n: number; map: Map<string, FamilyTicket> }>();

/**
 * The tickets by id, built once per tickets list and shared by every caller (search runs mainTicketOf once per
 * hidden task, a chat looks up a title per message). A list changed in place to another length is rebuilt.
 */
export function byIdOf<T extends FamilyTicket>(tickets: readonly T[]): Map<string, T> {
  const hit = byIdCache.get(tickets);
  if (hit && hit.n === tickets.length) return hit.map as Map<string, T>;
  const map = new Map(tickets.map((t) => [t.id, t]));
  byIdCache.set(tickets, { n: tickets.length, map });
  return map;
}

/** The ticket a tool ticket works for: its nearest main ancestor, else its family's top ticket. */
export function mainTicketOf<T extends FamilyTicket & { main?: boolean }>(tickets: T[], id: string): T | undefined {
  const byId = byIdOf(tickets);
  const seen = new Set<string>();
  let cur = byId.get(id);
  let top = cur;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.main && cur.id !== id) return cur;
    top = cur;
    const p = parentIn(byId, cur);
    cur = p?.parent;
  }
  return top && top.id !== id ? top : undefined;
}

/** Deepest level a new link may make (the feature's top ticket is level 0). */
export const MAX_LEVEL = 2;

export interface FeatureTicket extends FamilyTicket {
  kind?: TicketKind | null;
  outcome?: string | null;
  verdict?: "passed" | "problem" | null;
  closedForms?: ClosedForms | null;
  runEndedAt?: string | null;
  /** When the feature's status ("Where we are") last changed; set only on a top ticket that has one. */
  statusAt?: string | null;
  updatedAt?: string;
  running?: boolean;
}

/**
 * id's level in its own feature: 0 for the top ticket and for any main ticket (a sub-feature starts its own count), 1
 * for a ticket right under one, and so on. 0 for a ticket that isn't on the board.
 */
export function levelOf<T extends FamilyTicket>(tickets: T[], id: string): number {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let n = 0;
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); n++) {
    seen.add(cur.id);
    if (cur.main) return n;
    const p = parentIn(byId, cur);
    if (!p) return n;
    cur = p.parent;
  }
  return n;
}

/**
 * Where a new ticket linked under id may hang so its feature stays at most MAX_LEVEL deep: id itself, or its nearest
 * ancestor that leaves room. A run's partOf too deep in its own feature moves up instead of failing; it never climbs
 * past a main ticket (a sub-feature's tickets stay in it).
 */
export function fitParent<T extends FamilyTicket>(tickets: T[], id: string): string {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id) && levelOf(tickets, cur.id) + 1 > MAX_LEVEL) {
    seen.add(cur.id);
    const p = parentIn(byId, cur);
    if (!p) break;
    cur = p.parent;
  }
  return cur?.id ?? id;
}

/**
 * A feature's top ticket (a family's top ticket, or a sub-feature) is a feature: not Done, and 2 or more other tickets
 * in its own feature (featureRows) or a status already.
 */
export function isFeature<T extends FeatureTicket>(tickets: T[], top: T): boolean {
  if (top.status === "done" || featureRoot(tickets, top.id)?.id !== top.id) return false;
  return !!top.statusAt || featureRows(tickets, top.id).length >= 3;
}

/**
 * Why a main ticket counts as already planned, or null: any other ticket in its family (steps, gathered or added
 * tickets), or a written "Where we are" status (statusAt). Its Planning chat updates the ticket instead of rewriting
 * it; its card's plain Apply never starts work, "Apply & start work" is the go-ahead (prompts.ts mainPlannedRule, Chat.tsx).
 */
export function plannedMain<T extends FeatureTicket & { main?: boolean }>(tickets: T[], t: T): "family" | "status" | null {
  if (!t.main) return null;
  if (featureRows(tickets, t.id).length > 1) return "family";
  return t.statusAt ? "status" : null;
}

/** The open feature id belongs to (its own feature's top: featureRoot), or null. */
export function featureOf<T extends FeatureTicket>(tickets: T[], id: string): T | null {
  const top = featureRoot(tickets, id);
  return top && isFeature(tickets, top) ? top : null;
}

/** Every open feature (sub-features too) with its own rows (featureRows order), working out the families once. */
export function openFeatures<T extends FeatureTicket>(tickets: T[]): { top: T; rows: FamilyRow<T>[] }[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const kids = childrenByParent(tickets);
  const out: { top: T; rows: FamilyRow<T>[] }[] = [];
  for (const top of tickets) {
    if (top.status === "done" || (parentIn(byId, top) && !top.main)) continue;
    const rows: FamilyRow<T>[] = [];
    const seen = new Set<string>();
    const walk = (t: T, depth: number, how: LinkHow | null) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      rows.push({ ticket: t, depth, how });
      if (depth > 0 && t.main) return;
      for (const c of kids.get(t.id) ?? []) walk(c.ticket, depth + 1, c.how);
    };
    walk(top, 0, null);
    if (top.statusAt || rows.length >= 3) out.push({ top, rows });
  }
  return out;
}

/** A feature's groups: its level-1 tickets of kind group or round. */
export function groupsOf<T extends FeatureTicket>(tickets: T[], topId: string): T[] {
  return (childrenByParent(tickets).get(topId) ?? []).map((c) => c.ticket).filter((t) => t.kind === "group" || t.kind === "round");
}

const ROUND_RE = /^testing round (\d+)\b/i;

/** "Testing round N" for a new round in the family of topId: one more than the highest round number there. */
export function nextRoundTitle<T extends FeatureTicket>(tickets: T[], topId: string | null): string {
  const rows = topId ? featureRows(tickets, topId) : [];
  const n = rows.reduce((m, r) => Math.max(m, Number(ROUND_RE.exec(r.ticket.title)?.[1] ?? 0)), 0);
  return `Testing round ${n + 1}`;
}

/** Where a ticket fits instead: its feature's top ticket or one of its groups. */
function whereInstead<T extends FeatureTicket>(tickets: T[], parentId: string): string {
  const top = featureRoot(tickets, parentId);
  const groups = top ? groupsOf(tickets, top.id) : [];
  return top
    ? `under the feature "${top.title}" (${top.id})${groups.length ? ` or one of its groups: ${groups.map((g) => `"${g.title}" (${g.id})`).join(", ")}` : ""}`
    : "under the feature's top ticket or one of its groups";
}

/** The refusal for a link that would go below MAX_LEVEL: where to put the ticket instead. */
export function tooDeepMessage<T extends FeatureTicket>(tickets: T[], parentId: string): string {
  return `That would put the ticket ${levelOf(tickets, parentId) + 1} levels deep; a feature keeps its tickets at most ${MAX_LEVEL} levels deep. Put it ${whereInstead(tickets, parentId)}.`;
}

// ---- Sub-features: a main ticket linked under another ticket ----

/** A sub-feature: a main ticket linked under another ticket on the board. It keeps its card, chat, tasks and status. */
export function isSubFeature<T extends FamilyTicket>(tickets: T[], t: T): boolean {
  return !!t.main && !!parentIn(new Map(tickets.map((o) => [o.id, o])), t);
}

/**
 * The top of id's own feature: up its links to the nearest main ticket (a sub-feature, for its own tickets), else the
 * family's top ticket. A family walk for a main ticket starts and stops here.
 */
export function featureRoot<T extends FamilyTicket>(tickets: T[], id: string): T | undefined {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.main) return cur;
    const p = parentIn(byId, cur);
    if (!p || seen.has(p.parent.id)) break;
    cur = p.parent;
  }
  return cur;
}

/**
 * id's own feature from its top (featureRoot) down, in familyOf order with depth counted from that top. A sub-feature
 * inside it is one row, without the tickets under it (those are the sub-feature's). Every walk for a main ticket uses
 * this (its status, card, needs-you, Stop, Delete), so a parent never answers for a sub-feature's tasks.
 */
export function featureRows<T extends FamilyTicket>(tickets: T[], id: string): FamilyRow<T>[] {
  const root = featureRoot(tickets, id);
  if (!root) return [];
  const kids = childrenByParent(tickets);
  const out: FamilyRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (t: T, depth: number, how: LinkHow | null) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ ticket: t, depth, how });
    if (depth > 0 && t.main) return;
    for (const c of kids.get(t.id) ?? []) walk(c.ticket, depth + 1, c.how);
  };
  walk(root, 0, null);
  return out;
}

/** The sub-features in id's own feature, at any level of it (familyOrder). */
export function subFeaturesOf<T extends FamilyTicket>(tickets: T[], id: string): T[] {
  return featureRows(tickets, id).filter((r) => r.depth > 0 && r.ticket.main).map((r) => r.ticket);
}

/** id and every ticket below it at any depth (sub-features and their tickets too), in familyOf order. */
export function familyBelow<T extends FamilyTicket>(tickets: T[], id: string): T[] {
  const kids = childrenByParent(tickets);
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (t: T | undefined) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const c of kids.get(t.id) ?? []) walk(c.ticket);
  };
  walk(tickets.find((t) => t.id === id));
  return out;
}

/**
 * Why linking `moved` (with every ticket under it) under parentId breaks the family rules, in plain words, or null when
 * it may go there. moved: the ticket as it would be (a new ticket isn't on the board yet; main: true for a main ticket).
 * The rules: one sub-feature level only (no main ticket under a sub-feature or anything inside one, and a main ticket
 * that holds a sub-feature can't become one); a sub-feature sits at most MAX_LEVEL deep in its parent's feature; every
 * other ticket at most MAX_LEVEL deep in its own feature (a sub-feature's tickets count from it, levelOf). subtree
 * false: only the moved ticket's own depth (gather moves deeper ones up itself, and says so). One helper for every
 * path: link, create, gather, plans and the "Moved up" fix. Loops are wouldLoop's.
 */
export function linkProblem<T extends FeatureTicket>(tickets: T[], moved: Pick<T, "id" | "title"> & { main?: boolean }, parentId: string, opts: { subtree?: boolean } = {}): string | null {
  const known = tickets.some((t) => t.id === moved.id);
  const sim: T[] = tickets.map((t) => (t.id === moved.id ? { ...t, ...moved, partOf: parentId, parentId: null } : t));
  if (!known) sim.push({ status: "backlog", createdAt: "9999", ...moved, partOf: parentId, parentId: null } as unknown as T);
  const byId = new Map(sim.map((t) => [t.id, t]));
  if (!byId.has(parentId) || parentId === moved.id) return null;
  const below = familyBelow(sim, moved.id);
  const top = familyRoot(sim, moved.id);
  // One sub-feature level: a main ticket in the moved part has no main ticket above it but its family's top one.
  for (const m of below.filter((t) => t.main)) {
    const seen = new Set<string>([m.id]);
    for (let cur = parentIn(byId, m)?.parent; cur && !seen.has(cur.id); cur = parentIn(byId, cur)?.parent) {
      seen.add(cur.id);
      if (!cur.main || cur.id === top?.id) continue;
      const holder = familyRoot(sim, cur.id) ?? cur;
      return cur.id === moved.id
        ? `"${moved.title}" has its own sub-feature "${m.title}", so it can't become part of "${holder.title}"; a sub-feature can't hold another sub-feature.`
        : `"${cur.title}" is already part of "${holder.title}"; a sub-feature can't hold another sub-feature.`;
    }
  }
  // Depth: a sub-feature's own place counts in its parent's feature, every other ticket in its own feature (levelOf).
  const levelIn = (t: T) => {
    const p = t.main ? parentIn(byId, t) : null;
    return p ? levelOf(sim, p.parent.id) + 1 : levelOf(sim, t.id);
  };
  let deepest: { t: T; level: number } | null = null;
  for (const t of opts.subtree === false ? below.slice(0, 1) : below) {
    const level = levelIn(t);
    if (level > MAX_LEVEL && (!deepest || level > deepest.level)) deepest = { t, level };
  }
  if (!deepest) return null;
  if (deepest.t.id === moved.id) {
    return `That would put "${moved.title}" ${deepest.level} levels deep; a feature keeps its tickets at most ${MAX_LEVEL} levels deep. Put it ${whereInstead(sim, parentId)}.`;
  }
  return `That would put "${deepest.t.title}" (under "${moved.title}") ${deepest.level} levels deep; a feature keeps its tickets at most ${MAX_LEVEL} levels deep. ` +
    `Put "${moved.title}" higher up, ${whereInstead(sim, parentId)}, or move its deepest tickets up first.`;
}

/** How a family row reads: the words the Family tab and the status counts use. */
/** in_review: in the Review column (the user may have moved it back from Done to follow up): still open, waits on them. */
export type FamilyState = "waiting" | "working" | "done" | "passed" | "problem" | "failed" | "needs_you" | "in_review" | "paused";
export const STATE_WORDS: Record<FamilyState, string> = {
  waiting: "Waiting", working: "Working", done: "Done", passed: "Passed", problem: "Found a problem", failed: "Failed", needs_you: "Needs you", in_review: "In review", paused: "Paused",
};

/** needsYou: the board's attention shows the ticket as Your turn. */
export function familyState(t: FeatureTicket, needsYou = false): FamilyState {
  const finished = (): FamilyState => (t.kind === "test" ? (t.verdict === "problem" ? "problem" : "passed") : "done");
  if (t.status === "done") return finished();
  if (t.running || t.status === "ready" || t.status === "in_progress") return t.outcome === "limit" ? "paused" : "working";
  if (t.outcome === "limit") return "paused";
  if (t.outcome === "failed" || t.outcome === "blocked") return "failed";
  if (needsYou) return "needs_you";
  // Its question was closed without an answer (Close question): it waits, but not on the user.
  if (t.outcome === "needs_input" && askClosed(t)) return "waiting";
  // Only the Done column counts as finished: a ticket in Review is still open, however its last run ended.
  if (t.status === "review") return "in_review";
  if (t.status === "backlog" || t.status === "planning") return "waiting";
  return "needs_you";
}

/**
 * Ticket.closedForms: forms closed without an answer, by entry uuid. run: the ticket's runEndedAt when it closed (the
 * run that asked it); older closes without it fall back to their time.
 */
export type ClosedForms = Record<string, { at: string; by?: "user" | "task"; taskId?: string; run?: string }>;

/**
 * Whether the user closed what the ticket's last run asked (Close question, or answered in its task's chat): a close
 * made for that run. The ticket then no longer waits on the user for it, until a new run asks again; a close never
 * hides a newer run's question.
 */
export function askClosed(t: { closedForms?: ClosedForms | null; runEndedAt?: string | null }): boolean {
  const ended = t.runEndedAt ?? "";
  return Object.values(t.closedForms ?? {}).some((c) =>
    typeof c?.run === "string" ? c.run === ended : typeof c?.at === "string" && c.at >= ended);
}

/** A group is finished (folds) once every child is Done, Passed or Found a problem. */
export const settled = (s: FamilyState) => s === "done" || s === "passed" || s === "problem";

/** A group's short summary: "5 of 6 passed" for tests, else "4 of 6 done". */
export function groupSummary(states: { kind?: TicketKind | null; state: FamilyState }[]): string {
  if (!states.length) return "empty";
  const tests = states.filter((s) => s.kind === "test");
  if (tests.length && tests.length === states.length) return `${states.filter((s) => s.state === "passed").length} of ${states.length} passed`;
  return `${states.filter((s) => settled(s.state)).length} of ${states.length} done`;
}

// ---- New ticket: "This looks like part of X" (no AI call) ----

const COMMON = new Set(("about after again also because been before being both could does doing done each from have here into just like make more most much need only other over should some such than that their them then there these they this those very want were what when where which while will with would your " +
  "ticket tickets sure using").split(" "));

/** The words a match counts: lower case, 4 letters or more, not a common word. */
export function matchWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !COMMON.has(w)));
}

/**
 * The open feature a new ticket most likely belongs to: the one whose title or family titles share the most words (2 at
 * least) with the ticket's title and description; ties go to the most recently touched. null when none does.
 */
export function suggestFeature<T extends FeatureTicket>(tickets: T[], title: string, body: string): { feature: T; words: string[] } | null {
  const mine = matchWords(`${title} ${body}`);
  if (mine.size < 2) return null;
  let best: { feature: T; words: string[]; touched: string } | null = null;
  for (const { top, rows } of openFeatures(tickets)) {
    const theirs = new Set(rows.flatMap((r) => [...matchWords(r.ticket.title)]));
    const shared = [...mine].filter((w) => theirs.has(w));
    if (shared.length < 2) continue;
    const touched = rows.reduce((m, r) => ((r.ticket.updatedAt ?? r.ticket.createdAt) > m ? r.ticket.updatedAt ?? r.ticket.createdAt : m), "");
    if (!best || shared.length > best.words.length || (shared.length === best.words.length && touched > best.touched)) best = { feature: top, words: shared, touched };
  }
  return best && { feature: best.feature, words: best.words };
}

/**
 * The feature a new ticket joins (undefined: its own). Only an explicit pick counts: "add" keeps the id tapped
 * (not today's suggestion), "other" needs a pick, and a pick whose feature has since closed falls back to its own.
 */
export function partOfFor(choice: "add" | "own" | "other", added: string, other: string, openIds: readonly string[]): string | undefined {
  const id = choice === "add" ? added : choice === "other" ? other : "";
  return id && openIds.includes(id) ? id : undefined;
}

/** Depth-first rows with each ticket's children newest first (the top ticket stays first), so recent work shows without scrolling. */
export function newestFirst<T extends FamilyTicket>(rows: FamilyRow<T>[]): FamilyRow<T>[] {
  const out: FamilyRow<T>[] = [];
  const place = (from: number, to: number) => {
    // rows[from..to) are the subtrees of one parent's children, oldest first: emit them in reverse.
    const starts: number[] = [];
    for (let i = from; i < to; i++) if (rows[i].depth === rows[from].depth) starts.push(i);
    for (let k = starts.length - 1; k >= 0; k--) {
      const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : to;
      out.push(rows[s]);
      if (s + 1 < e) place(s + 1, e);
    }
  };
  if (rows.length) {
    out.push(rows[0]);
    if (rows.length > 1) place(1, rows.length);
  }
  return out;
}
