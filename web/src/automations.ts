// Pure helpers for the Automations dialog and the For automations tab of Connections (tested in test/automations.test.ts).
import type { AutomationProposal, Loop, LoopColumn, LoopSeenItem, Pass } from "./automationTypes";

/** What boardCell needs of a Connections server (api.ts McpServer; not imported, so tests can load this file). */
type ClaudeServer = { name: string; scope: "user" | "local" | "project" | "claude.ai" | "board" | "other"; transport: "stdio" | "http" | "sse" | null };

export const COLUMN_LABEL: Record<LoopColumn, string> = { backlog: "Backlog", planning: "Planning", ready: "Ready" };

/** One line under each "New tickets go to" choice. */
export const COLUMN_MEANING: Record<LoopColumn, string> = {
  backlog: "You look at them and start the ones you want.",
  planning: "Claude opens a chat on each one and waits for you.",
  ready: "Claude starts working on each one right away.",
};

export const EVERY_CHOICES = [5, 15, 60];

/** Why Save is greyed out, in plain words (null: it can be saved). */
export function saveBlocker(f: { name: string; script: string; column: LoopColumn; autoStart: boolean }): string | null {
  if (!f.name.trim()) return "Give it a name to save it.";
  if (!f.script.trim()) return "Add a check script under How it checks to save it.";
  if (f.column !== "backlog" && !f.autoStart) return `Tick "Let Claude start by itself" in Settings, or pick Backlog, to save it.`;
  return null;
}

/** The last check's items in the groups the Last check tab shows: new and skipped in full, the rest folded. */
export function groupLastItems(items: LoopSeenItem[]): { shown: LoopSeenItem[]; first: LoopSeenItem[]; seen: LoopSeenItem[] } {
  return {
    shown: items.filter((i) => i.state === "new" || i.state === "skipped"),
    first: items.filter((i) => i.state === "first"),
    seen: items.filter((i) => i.state === "seen"),
  };
}

export function everyLabel(min: number): string {
  if (min % 60 === 0) return min === 60 ? "hour" : `${min / 60} hours`;
  return `${min} min`;
}

/** The badge in the list: whether it runs, and if not, the short reason. */
export function loopStatus(l: Pick<Loop, "enabled" | "state" | "lastError">): { label: string; tone: string } {
  if (l.state === "unsupported") return { label: "Not supported", tone: "stopped" };
  if (l.state === "needs_connection") return { label: "Needs connecting", tone: "blocked" };
  if (l.state === "script_changed") return { label: "Review script", tone: "blocked" };
  if (!l.enabled) return { label: "Off", tone: "stopped" };
  if (l.lastError) return { label: "Waiting", tone: "blocked" };
  return { label: "On", tone: "ok" };
}

/** The line under the name in the list. */
export function loopSubtitle(l: Pick<Loop, "everyMinutes" | "enabled" | "lastError" | "lastCheckedAt" | "state" | "problems">, ago: (iso: string) => string): string {
  if (l.state !== "ok") return l.problems[0] ?? "";
  if (!l.enabled) return "off";
  if (l.lastError) return l.lastError;
  return `every ${everyLabel(l.everyMinutes)}${l.lastCheckedAt ? ` · checked ${ago(l.lastCheckedAt)}` : " · not checked yet"}`;
}

/** What a server's card shows on the For automations tab of Connections. */
export type BoardCell =
  | { kind: "ok"; pass: Pass }
  | { kind: "connect"; pass: Pass | null; how: "local" | "mcp" }
  | { kind: "none"; why: string };

/** The For automations card for a Claude server: its linked pass, a Connect button, or a dash with the reason. */
export function boardCell(s: ClaudeServer, passes: Pass[]): BoardCell {
  const pass = passes.find((p) => p.claudeName === s.name) ?? null;
  if (pass?.status === "connected") return { kind: "ok", pass };
  if (s.scope === "claude.ai") return { kind: "none", why: "The board can't use Claude's claude.ai sign-in. Add the service for automations with its own sign-in or a key (+ Add a key or address)." };
  if (s.scope !== "user" && s.scope !== "local") return { kind: "none", why: "Only servers from your own Claude settings can be used by automations." };
  if (pass) return { kind: "connect", pass, how: pass.kind === "local" ? "local" : "mcp" };
  return { kind: "connect", pass: null, how: s.transport === "stdio" ? "local" : "mcp" };
}

/** A proposed connection resolved against the board's passes: the pass it is, or what the card must still do. */
export function resolveProposedPass(p: AutomationProposal["passes"][number], all: Pass[], board?: string): { pass: Pass | null; need: "connect" | "key" | "missing" | null } {
  const name = p.name.toLowerCase();
  // A key saved for this board serves its automations; another board's keys never do.
  const passes = board === undefined ? all : all.filter((x) => !x.board || x.board === board);
  const pass = passes.find((x) => (p.from && x.claudeName === p.from) || (p.envName && x.envName === p.envName) || (p.url && x.url === p.url))
    ?? passes.find((x) => x.name.toLowerCase() === name || x.claudeName?.toLowerCase() === name) ?? null;
  if (pass?.status === "connected") return { pass, need: null };
  if (pass) return { pass, need: pass.kind === "key" ? "key" : "connect" };
  if (p.from || p.url) return { pass: null, need: "connect" };
  if (p.envName) return { pass: null, need: "key" };
  return { pass: null, need: "missing" };
}
