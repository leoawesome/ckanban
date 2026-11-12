// Shapes of the automations API (src/server/loops.ts, src/server/integrations/passes.ts), kept apart from api.ts.

export type LoopColumn = "backlog" | "planning" | "ready";

/** A board pass: how automations reach a service without Claude (no secrets). */
export interface Pass {
  id: string;
  kind: "mcp" | "key" | "local";
  name: string;
  /** The Connections (Claude) server it was made from: that row shows both. */
  claudeName: string | null;
  url: string | null;
  envName: string | null;
  status: "pending" | "connected" | "needs_reconnect";
  error: string | null;
  createdAt: string;
  /** When the key was last saved (replaced keys keep their createdAt). */
  savedAt?: string;
  /** A key saved for one board only (its Claude runs get it as $envName); null: a pass for automations on any board. */
  board?: string | null;
  /** That board's name. */
  boardName?: string | null;
  /** Automations (all boards) that use it. */
  usedBy: number;
  /** Their names. */
  usedByNames?: string[];
}

export interface LoopSeenItem {
  id: string;
  title: string;
  link?: string;
  /**
   * added: a later item of a thread, sent to the ticket its thread's first item made. waiting: that ticket can't take
   * it now; it goes in at a later check.
   */
  state: "new" | "added" | "waiting" | "skipped" | "seen" | "first";
  ticketId?: string;
  note?: string;
}

export interface Loop {
  version: number;
  id: string;
  name: string;
  enabled: boolean;
  service: string;
  passes: string[];
  scriptHash: string;
  everyMinutes: number;
  column: LoopColumn;
  autoStart: boolean;
  askClaude: { on: boolean; prompt: string };
  instructions: string;
  allowedTools: string[] | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  /** The feature each new ticket goes into as a task (a main ticket's or group's id), and its title; null: its own card. */
  partOf?: string | null;
  partOfTitle?: string | null;
  state: "ok" | "unsupported" | "needs_connection" | "script_changed";
  problems: string[];
  script: string | null;
  passViews: { id: string; name: string; status: string }[];
  seenCount: number;
  lastFound: number;
  lastItems: LoopSeenItem[];
}

export interface LoopInput {
  name: string;
  enabled: boolean;
  service: string;
  passes: string[];
  script: string;
  everyMinutes: number;
  column: LoopColumn;
  autoStart: boolean;
  askClaude: { on: boolean; prompt: string };
  instructions: string;
  partOf?: string | null;
}

export interface LoopTest {
  items: { id: string; title: string; text?: string; link?: string; thread?: string }[];
  found: number;
  error: string | null;
  stderr: string;
  toolsUsed: string[];
  durationMs: number;
}

/** An automation the setup chat proposed (src/server/automation-proposal.ts). */
export interface AutomationProposal {
  name: string;
  service: string;
  passes: { name: string; from?: string; url?: string; envName?: string; keyHelp?: string }[];
  script: string;
  everyMinutes: number;
  instructions?: string;
  askClaude?: { on: boolean; prompt: string };
  /** The feature each new ticket goes into as a task (a main ticket's or group's id). */
  partOf?: string;
  summary: string;
}
