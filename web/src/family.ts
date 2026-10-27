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

/** What a card shows of its family: the ticket it is part of (partOf only) and its direct children of every kind. */
export interface CardFamily<T extends FamilyTicket = FamilyTicket> {
  /** undefined when partOf points at a deleted ticket. */
  partOf?: Pick<T, "id" | "title">;
  children: Pick<T, "id" | "title">[];
}

export function cardFamilies<T extends FamilyTicket>(tickets: T[]): Map<string, CardFamily<T>> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, CardFamily<T>>();
  for (const [id, kids] of childrenByParent(tickets)) out.set(id, { children: kids.map((k) => k.ticket) });
  for (const t of tickets) {
    if (!t.partOf) continue;
    const f = out.get(t.id) ?? out.set(t.id, { children: [] }).get(t.id)!;
    f.partOf = byId.get(t.partOf);
  }
  return out;
}
