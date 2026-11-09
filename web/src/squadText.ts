// Plain helpers for squads (saved huddles: the Team tab, squad cards, the topic box), kept apart from the components
// so tests can import them. No import from api.ts: the server's typecheck (no DOM types) reaches this file through its tests.

type Level = "global" | "board";

/** A roster entry as a squad holds it (RosterEntry in api.ts). */
export interface SquadPerson {
  preset?: string;
  role?: string;
  handle?: string;
  count?: number;
  focus?: string;
  model?: string | null;
  mode?: "tagged" | "monitor";
  host?: boolean;
}

/** Longest topic the daemon takes (TOPIC_MAX in src/server/huddle-templates.ts). */
export const TOPIC_MAX = 2000;
/** How much of the ticket's description the topic box starts with (TICKET_TOPIC_MAX in src/server/squad.ts). */
const TICKET_TOPIC_MAX = 600;

/** The topic box's starting text: the ticket's title, then the start of its description. */
export function ticketTopicText(t: { title: string; body?: string | null }): string {
  const body = (t.body ?? "").trim();
  const cut = body.length > TICKET_TOPIC_MAX ? `${body.slice(0, TICKET_TOPIC_MAX).trimEnd()}…` : body;
  return [t.title.trim(), cut].filter(Boolean).join("\n\n").slice(0, TOPIC_MAX);
}

/** A person's @handle in a squad: its handle, its teammate, else its role as a name ("Accessibility tester" → accessibility-tester). */
export function personHandle(e: SquadPerson): string {
  return e.handle?.trim() || e.preset || (e.role ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "helper";
}

export interface PersonChip {
  key: string;
  handle: string;
  host: boolean;
  /** Saved as a new teammate when the squad is saved. */
  isNew: boolean;
  /** "×2", mode and model, when they are set. */
  extra: string;
  /** Everything in one line, for the chip's tooltip. */
  title: string;
}

/**
 * The people of a squad as chips. A person is a new teammate when it has no preset and no teammate of its name
 * exists yet (`teammates`: the board's teammate names; null while loading: then the card's own list decides).
 */
export function personChips(roster: SquadPerson[], newTeammates: { index: number; name: string }[] = [], teammates: Set<string> | null = null): PersonChip[] {
  const proposed = new Map(newTeammates.map((n) => [n.index, n.name]));
  return roster.map((e, i) => {
    const name = proposed.get(i);
    const handle = e.preset ? personHandle(e) : name ?? personHandle(e);
    const isNew = !e.preset && (teammates ? !teammates.has(name ?? handle) : proposed.has(i));
    const count = e.count && e.count > 1 ? `×${e.count}` : "";
    const extra = [count, e.mode === "monitor" ? "reads everything" : "", e.model ?? ""].filter(Boolean).join(" · ");
    const title = [
      `@${handle}${e.host ? " hosts the huddle" : ""}`,
      e.role && !e.preset ? e.role : e.preset ? `teammate ${e.preset}` : "",
      isNew ? "saved as a new teammate" : "",
      e.mode === "monitor" ? "reads every message" : "wakes when @mentioned",
      e.model ? `model ${e.model}` : "board's model",
      e.focus ? `focus: ${e.focus}` : "",
    ].filter(Boolean).join(" · ");
    return { key: `${i}-${handle}`, handle, host: !!e.host, isNew, extra, title };
  });
}

/** "What it's for. Budget $60 · 2 rounds." */
export function squadSummary(s: { description: string; maxCostUsd: number | null; rounds: number | null }): string {
  const rules = [s.maxCostUsd != null && `Budget $${Math.round(s.maxCostUsd * 100) / 100}`, s.rounds && `${s.rounds} round${s.rounds === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const what = s.description.trim();
  return [what && (/[.!?]$/.test(what) ? what : `${what}.`), rules && `${rules}.`].filter(Boolean).join(" ");
}

/** The saved state's line: "Product debate · this board · new teammates @visionary, @journey". */
export function squadSavedText(label: string, scope: Level | undefined, teammates?: { created: string[]; reused: string[] }): string {
  return [
    label,
    scope ? (scope === "global" ? "all boards" : "this board") : "",
    teammates?.created.length ? `new teammate${teammates.created.length === 1 ? "" : "s"} ${teammates.created.map((n) => `@${n}`).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
}

/** The daemon refused because a squad of that name exists (409): the card offers to replace it. */
export const isNameTaken = (message: string) => /^a squad named ".*" already exists/.test(message);
