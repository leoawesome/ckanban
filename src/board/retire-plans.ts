// One-time data migration: planned tickets are retired. An old planner (a ticket that is neither a main ticket nor a tool
// ticket, with child tickets by parentId that aren't tool tickets either) becomes a main ticket, and its old children
// become its tool tickets, so the main-ticket engine runs them. Only the flags change: titles, bodies, chats, outputs,
// the plan's state, dependsOn and every field this version doesn't know stay as they were. Idempotent: a migrated
// board has no old planner left, so a second pass finds nothing.
import { pauser } from "../core/lag";
import type { Store } from "../core/store";
import type { Ticket } from "../core/types";
import type { TicketKind } from "../../web/src/features/family/family";

export interface RetirePatch {
  id: string;
  patch: Partial<Ticket>;
}

/** A child of an old plan: linked by parentId, and not a tool ticket or a main ticket (a sub-feature) already. */
const oldChild = (t: Ticket): boolean => !!t.parentId && !t.tool && !t.main;
/** The kind an old child gets from its title; build unless the title clearly says it explores or reviews. */
export function kindFromTitle(title: string): TicketKind {
  const s = title.trim().toLowerCase();
  if (/^(explore|investigate|research)\b/.test(s)) return "explore";
  if (/^review\b/.test(s)) return "review";
  return "build";
}

/** Plan states in which the plan still starts its children by itself (Resume starts a paused or stuck one again). */
const LIVE = new Set(["running", "finishing", "paused", "stuck"]);

/**
 * The patches that retire every old plan on a board (pure). An old planner that is itself someone's child (a plan inside
 * a plan) becomes a group tool ticket instead of a main ticket, so it still runs its own children. An open child in
 * Backlog of a plan that isn't under way waits to be started (waitsForStart): as a main ticket's task it would otherwise
 * start the moment the main ticket gets its first new task.
 */
export function retirePlanPatches(tickets: readonly Ticket[]): RetirePatch[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  // Old planners: not main, not tool, with at least one old child.
  const planners = new Set<string>();
  for (const t of tickets) {
    if (!oldChild(t)) continue;
    const p = byId.get(t.parentId!);
    if (p && !p.main && !p.tool) planners.add(p.id);
  }
  if (!planners.size) return [];
  const out: RetirePatch[] = [];
  for (const t of tickets) {
    const patch: Partial<Ticket> = {};
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    // A child of an old planner, or of any other ticket it already hangs under (a main ticket that adopted a planner).
    const childOfPlanner = oldChild(t) && !!parent && planners.has(parent.id);
    if (planners.has(t.id)) {
      if (t.parentId && parent) Object.assign(patch, { tool: true, kind: "group" as const });
      else patch.main = true;
    } else if (childOfPlanner) {
      patch.tool = true;
      patch.kind = t.kind ?? kindFromTitle(t.title);
      if (t.status === "backlog" && !LIVE.has(parent!.plan?.state ?? "") && !t.waitsForStart) patch.waitsForStart = true;
    }
    if (Object.keys(patch).length) out.push({ id: t.id, patch });
  }
  return out;
}

/**
 * Retires the old plans of every board on this data folder (daemon startup, before recover). Walks the tickets in
 * memory in slices, writes only the changed ones (keeping their updatedAt), and is a quick no-op once migrated.
 * Returns how many tickets changed per board.
 */
export async function retireOldPlans(store: Store, pause: () => Promise<void> = pauser()): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  for (const p of store.listProfiles()) {
    const tickets = store.listTickets(p.slug);
    // Quick skip: most boards have no old child at all (one cheap pass, sliced).
    let any = false;
    for (let i = 0; i < tickets.length; i++) {
      if (oldChild(tickets[i])) {
        any = true;
        break;
      }
      if (i % 500 === 499) await pause();
    }
    if (!any) continue;
    await pause();
    const patches = retirePlanPatches(tickets);
    const open = new Set(tickets.filter((t) => t.status !== "done").map((t) => t.id));
    for (const { id, patch } of patches) {
      try {
        store.updateTicket(p.slug, id, patch, { keepUpdatedAt: true });
        if (patch.main && open.has(id)) {
          store.addComment(p.slug, id, "ai", "Planned tickets were retired: this ticket is now a main ticket and its child tickets are its tasks (nothing else changed).");
        }
      } catch (e) {
        console.error(`retire old plans ${p.slug}/${id}:`, (e as Error).message);
      }
      await pause();
    }
    if (patches.length) {
      changed[p.slug] = patches.length;
      console.log(`profile ${p.slug}: planned tickets retired, ${patches.length} ticket${patches.length === 1 ? "" : "s"} now main or tool tickets`);
    }
  }
  return changed;
}
