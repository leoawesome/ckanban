// Satellite mode (docs/rust-port-board-plan.md 3.3): with the Rust board on (`ckanban-rs dev` in board mode), this
// daemon runs behind it as a "satellite" for the helper (notifications, push, Telegram) and the outside services of
// integrations/, with CKANBAN_SATELLITE=1. Rust owns the board then: this daemon builds no run loop, scheduler, jobs,
// loops, huddles, quick chats or session watcher, and its Store refuses every ticket write (Store.readOnlyTickets).
//
// What it knows of the board comes from Rust on stdin, after the front server's secret line (core/front.ts):
// - `event <json>`: a board event (ticket.updated with its view, ticket.deleted, activity, session.updated,
//   profile.updated). It reaches this daemon's own listeners (notifier, helper) but not its event stream: Rust already
//   sent it to the pages, and Rust re-emits this daemon's stream into its own.
// - `runtime <json>`: live state the helper asks synchronously. A snapshot at start, then one line per change; each
//   key present replaces what the mirror had: `running` (["<slug>/<id>"...]), `hostHuddles` ({slug: {ticketId:
//   HostHuddle}}, per board), `sessions` ({sessionId: SessionSummary | null}, per session).
// Unset, none of this applies and the daemon behaves exactly as before.
import type { HostHuddle } from "../helper/attention";
import type { SessionSummary } from "../runs/session";
import type { Bus, BusEvent } from "./events";

export const SATELLITE_ENV = "CKANBAN_SATELLITE";

export function isSatellite(env: Record<string, string | undefined> = process.env): boolean {
  return env[SATELLITE_ENV] === "1";
}

/** What the satellite knows of the Rust board's live state (the `runtime` lines). */
export class RuntimeMirror {
  private running = new Set<string>();
  private huddles = new Map<string, Map<string, HostHuddle>>();
  private sessions = new Map<string, SessionSummary>();
  private gotSnapshot!: () => void;
  /** Resolves at the first `runtime` line (the snapshot). */
  readonly ready = new Promise<void>((r) => (this.gotSnapshot = r));

  apply(state: unknown): void {
    if (!state || typeof state !== "object") return;
    const s = state as Record<string, unknown>;
    if (Array.isArray(s.running)) this.running = new Set(s.running.filter((x): x is string => typeof x === "string"));
    if (s.hostHuddles && typeof s.hostHuddles === "object") {
      for (const [slug, byId] of Object.entries(s.hostHuddles as Record<string, unknown>)) {
        if (byId && typeof byId === "object") this.huddles.set(slug, new Map(Object.entries(byId as Record<string, HostHuddle>)));
        else this.huddles.delete(slug);
      }
    }
    if (s.sessions && typeof s.sessions === "object") {
      for (const [id, sum] of Object.entries(s.sessions as Record<string, SessionSummary | null>)) {
        if (sum) this.sessions.set(id, sum);
        else this.sessions.delete(id);
      }
    }
    this.gotSnapshot();
  }

  isRunning(slug: string, id: string): boolean {
    return this.running.has(`${slug}/${id}`);
  }

  hostHuddles(slug: string): Map<string, HostHuddle> {
    return this.huddles.get(slug) ?? new Map();
  }

  sessionSummary(id: string): SessionSummary | null {
    return this.sessions.get(id) ?? null;
  }
}

/** Handles one stdin notice line from the Rust board; false when it isn't an `event` or `runtime` line. */
export function satelliteNotice(line: string, bus: Bus, mirror: RuntimeMirror): boolean {
  const sp = line.indexOf(" ");
  const kind = sp < 0 ? line : line.slice(0, sp);
  if (kind !== "event" && kind !== "runtime") return false;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(sp + 1));
  } catch (e) {
    console.error(`satellite: bad ${kind} line from the Rust board: ${(e as Error).message}`);
    return true;
  }
  if (kind === "runtime") mirror.apply(v);
  else if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") bus.emitMirrored(v as BusEvent);
  return true;
}
