// Ticket families: every ticket has at most one parent, so related tickets (one flight of work) form a tree. Three
// links make a parent: "part of" (partOf, a plain link the user or a chat made), an add-on (addOnOf) and a plan
// (parentId). The ticket panel's family tree, the cards' chips and the get_family tool all read it from here.
// No imports: the server (get_family) and its tests import this file too.

export type LinkHow = "linked" | "chat" | "add-on" | "plan";

export interface FamilyTicket {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  partOf?: string | null;
  partOfVia?: "chat" | null;
  addOnOf?: string | null;
  parentId?: string | null;
}

/** How a ticket hangs on its parent; partOf wins over an add-on, an add-on over a plan. null: no parent link. */
export function parentLink(t: Pick<FamilyTicket, "partOf" | "partOfVia" | "addOnOf" | "parentId">): { id: string; how: LinkHow } | null {
  if (t.partOf) return { id: t.partOf, how: t.partOfVia === "chat" ? "chat" : "linked" };
  if (t.addOnOf) return { id: t.addOnOf, how: "add-on" };
  if (t.parentId) return { id: t.parentId, how: "plan" };
  return null;
}

/** Words a family row uses for how it is linked. */
export const LINK_WORDS: Record<LinkHow, string> = { linked: "linked", chat: "from chat", "add-on": "add-on", plan: "plan" };

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

/** Direct children of every ticket (oldest first), with how each is linked. */
export function childrenByParent<T extends FamilyTicket>(tickets: T[]): Map<string, { ticket: T; how: LinkHow }[]> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, { ticket: T; how: LinkHow }[]>();
  for (const t of [...tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
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
 * The tickets of a main ticket's family working now: running, or Ready / In progress (queued or about to run). Tool
 * tickets and tickets the user added count; the main ticket itself never does. One rule for the server's card
 * (main-ticket.ts familyCard, board.familyWorking) and the main ticket's chat (its "Working:" line).
 */
export function workingInFamily<T extends { id: string; status: string }>(family: T[], mainId: string, running: (t: T) => boolean): T[] {
  return family.filter((t) => t.id !== mainId && (running(t) || t.status === "ready" || t.status === "in_progress"));
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
 * A tool ticket the board hides: no card, no column count, no Your turn; it lives in its main ticket's Family tab and
 * reports there. "With you" tool tickets are hidden too: their messages and questions show in the main ticket's chat
 * and their "needs you" on its card. Old plan children have no tool flag.
 */
export const hiddenTool = (t: { tool?: boolean; kind?: string | null } | null | undefined): boolean => !!t?.tool;

/** A "with you" tool ticket: a step that needs the user live; it may ask and notify the user (in its main ticket's chat). */
export const withYouTool = (t: { tool?: boolean; kind?: string | null } | null | undefined): boolean => !!t?.tool && t?.kind === "with_you";

/** The ticket a tool ticket works for: its nearest main ancestor, else its family's top ticket. */
export function mainTicketOf<T extends FamilyTicket & { main?: boolean }>(tickets: T[], id: string): T | undefined {
  const byId = new Map(tickets.map((t) => [t.id, t]));
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
  /** When the feature's status ("Where we are") last changed; set only on a top ticket that has one. */
  statusAt?: string | null;
  updatedAt?: string;
  running?: boolean;
}

/** id's level in its family: 0 for the top ticket (or a ticket that isn't on the board). */
export function levelOf<T extends FamilyTicket>(tickets: T[], id: string): number {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let n = 0;
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); n++) {
    seen.add(cur.id);
    const p = parentIn(byId, cur);
    if (!p) return n;
    cur = p.parent;
  }
  return n;
}

/**
 * Where a new ticket linked under id may hang so its family stays at most MAX_LEVEL deep: id itself, or its nearest
 * ancestor that leaves room. A run's partOf too deep in its own feature moves up instead of failing.
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

/** A family's top ticket is a feature: not Done, and 2 or more other tickets in its family or a status already. */
export function isFeature<T extends FeatureTicket>(tickets: T[], top: T): boolean {
  if (top.status === "done" || familyRoot(tickets, top.id)?.id !== top.id) return false;
  return !!top.statusAt || familyOf(tickets, top.id).length >= 3;
}

/** The open feature id belongs to (its family's top ticket), or null. */
export function featureOf<T extends FeatureTicket>(tickets: T[], id: string): T | null {
  const top = familyRoot(tickets, id);
  return top && isFeature(tickets, top) ? top : null;
}

/** Every open feature with its family (familyOf order), working out the families once. */
export function openFeatures<T extends FeatureTicket>(tickets: T[]): { top: T; rows: FamilyRow<T>[] }[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const kids = childrenByParent(tickets);
  const out: { top: T; rows: FamilyRow<T>[] }[] = [];
  for (const top of tickets) {
    if (top.status === "done" || parentIn(byId, top)) continue;
    const rows: FamilyRow<T>[] = [];
    const seen = new Set<string>();
    const walk = (t: T, depth: number, how: LinkHow | null) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      rows.push({ ticket: t, depth, how });
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
  const rows = topId ? familyOf(tickets, topId) : [];
  const n = rows.reduce((m, r) => Math.max(m, Number(ROUND_RE.exec(r.ticket.title)?.[1] ?? 0)), 0);
  return `Testing round ${n + 1}`;
}

/** The refusal for a link that would go below MAX_LEVEL: where to put the ticket instead. */
export function tooDeepMessage<T extends FeatureTicket>(tickets: T[], parentId: string): string {
  const top = familyRoot(tickets, parentId);
  const groups = top ? groupsOf(tickets, top.id) : [];
  const where = top
    ? `under the feature "${top.title}" (${top.id})${groups.length ? ` or one of its groups: ${groups.map((g) => `"${g.title}" (${g.id})`).join(", ")}` : ""}`
    : "under the feature's top ticket or one of its groups";
  return `That would put the ticket ${levelOf(tickets, parentId) + 1} levels deep; a feature keeps its tickets at most ${MAX_LEVEL} levels deep. Put it ${where}.`;
}

/** How a family row reads: the words the Family tab and the status counts use. */
export type FamilyState = "waiting" | "working" | "done" | "passed" | "problem" | "failed" | "needs_you" | "paused";
export const STATE_WORDS: Record<FamilyState, string> = {
  waiting: "Waiting", working: "Working", done: "Done", passed: "Passed", problem: "Found a problem", failed: "Failed", needs_you: "Needs you", paused: "Paused",
};

/** needsYou: the board's attention shows the ticket as Your turn. */
export function familyState(t: FeatureTicket, needsYou = false): FamilyState {
  const finished = (): FamilyState => (t.kind === "test" ? (t.verdict === "problem" ? "problem" : "passed") : "done");
  if (t.status === "done") return finished();
  if (t.running || t.status === "ready" || t.status === "in_progress") return t.outcome === "limit" ? "paused" : "working";
  if (t.outcome === "limit") return "paused";
  if (t.status === "review" && t.outcome === "done") return finished();
  if (t.outcome === "failed" || t.outcome === "blocked") return "failed";
  if (needsYou) return "needs_you";
  if (t.status === "backlog" || t.status === "planning") return "waiting";
  return "needs_you";
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

// ---- New ticket: "Just a question? Ask in Chat first" (no AI call) ----

const QUESTION_START = /^(why|how|what|where|when|who|which|is|are|was|were|can|could|should|would|does|do|did|has|have)\b/i;

/**
 * The title or description reads like a question: the title starts with why, how, what, is, can, does… or either ends
 * with "?". A word check, no AI call.
 */
export function looksLikeQuestion(title: string, body = ""): boolean {
  const t = title.trim();
  const b = body.trim();
  return QUESTION_START.test(t) || t.endsWith("?") || b.endsWith("?") || (!t && QUESTION_START.test(b));
}

/**
 * The feature a new ticket joins (undefined: its own). Only an explicit pick counts: "add" keeps the id tapped
 * (not today's suggestion), "other" needs a pick, and a pick whose feature has since closed falls back to its own.
 */
export function partOfFor(choice: "add" | "own" | "other", added: string, other: string, openIds: readonly string[]): string | undefined {
  const id = choice === "add" ? added : choice === "other" ? other : "";
  return id && openIds.includes(id) ? id : undefined;
}
