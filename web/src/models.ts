// Models and efforts the pickers offer, the board's Task models table and how model names read to people.
// Shared by the server (main-ticket.ts, prompts.ts) and the UI: keep it free of browser or server imports.
import type { TicketKind } from "./family";

/** Model aliases in every picker. An alias always means Claude Code's newest version of that model. */
export const MODELS = ["opus", "fable", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ModelPick {
  model: string;
  effort: string;
}

/** Board setting "Task models": only the kinds the user changed (see taskModel). */
export type TaskModels = Partial<Record<TicketKind, ModelPick>>;

/** Model and effort a tool ticket gets from its kind when the board's table and create_ticket leave them out. */
export const KIND_DEFAULTS: Record<TicketKind, ModelPick> = {
  explore: { model: "sonnet", effort: "medium" },
  build: { model: "opus", effort: "medium" },
  fix: { model: "opus", effort: "medium" },
  test: { model: "opus", effort: "medium" },
  review: { model: "fable", effort: "high" },
  with_you: { model: "sonnet", effort: "medium" },
  group: { model: "sonnet", effort: "low" },
  round: { model: "sonnet", effort: "low" },
};

/** The rows of the Task models table; a row sets every kind it lists. */
export const TASK_ROWS: { label: string; what: string; kinds: TicketKind[] }[] = [
  { label: "Explore", what: "Finds files and facts", kinds: ["explore"] },
  { label: "Build and fix", what: "Writes code and tests", kinds: ["build", "fix"] },
  { label: "Test", what: "Tries it in the app or browser", kinds: ["test"] },
  { label: "Review", what: "Independent check, read only", kinds: ["review"] },
  { label: "Steps with you", what: "Phone tests, logins", kinds: ["with_you"] },
  { label: "Grouping", what: "Bookkeeping only", kinds: ["group", "round"] },
];

const validPick = (p: unknown): p is ModelPick =>
  !!p && typeof (p as ModelPick).model === "string" && !!(p as ModelPick).model && typeof (p as ModelPick).effort === "string" && !!(p as ModelPick).effort;

/** The model and effort a kind of tool ticket gets on a board: its Task models override, else the default. */
export function taskModel(kind: TicketKind, overrides?: TaskModels | null): ModelPick {
  const o = overrides?.[kind];
  return validPick(o) ? { model: o.model, effort: o.effort } : KIND_DEFAULTS[kind];
}

/** The kinds' models in a line for prompts: "explore, with_you: sonnet at medium; build, fix, test: opus at medium; …". */
export function taskModelsText(overrides?: TaskModels | null): string {
  const groups = new Map<string, TicketKind[]>();
  for (const kind of Object.keys(KIND_DEFAULTS) as TicketKind[]) {
    const p = taskModel(kind, overrides);
    const key = `${p.model} at ${p.effort}`;
    groups.set(key, [...(groups.get(key) ?? []), kind]);
  }
  return [...groups].map(([pick, kinds]) => `${kinds.join(", ")}: ${pick}`).join("; ");
}

/** Version each alias means in Claude Code 2.1.322, for labels until a run reports the real one. */
export const KNOWN_VERSIONS: Record<string, string> = { opus: "5.5", fable: "5.2", sonnet: "5.5", haiku: "5.5" };

/** "claude-fable-5-2[1m]" → ["fable", "5.2"]; "claude-haiku-4-5-20251001" → ["haiku", "4.5"]; null without a version. */
export function familyVersion(id: string | null | undefined): [string, string] | null {
  if (!id) return null;
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/i.exec(id.trim());
  return m ? [m[1].toLowerCase(), m[3] ? `${m[2]}.${m[3]}` : m[2]] : null;
}

/** Larger of two "5.2"-style versions. */
export function newerVersion(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Versions the board learned from real runs (family → "5.2"); the UI fills it from /api/claude/defaults. */
let learned: Record<string, string> = {};
export function setLearnedVersions(v: Record<string, string> | null | undefined): void {
  learned = v ?? {};
}

/** Which version an alias means today: learned from runs, else the built-in table, else null. */
export function aliasVersion(alias: string): string | null {
  const a = alias.toLowerCase();
  return learned[a] ?? KNOWN_VERSIONS[a] ?? null;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();

/** A bare alias ("fable", "opus[1m]") as its family name, or null for anything else. */
function aliasOf(m: string): string | null {
  const x = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(m.trim());
  return x ? x[1].toLowerCase() : null;
}

/** Picker label: "Fable (5.2)"; the bare name when the version is unknown; other ids as they are. */
export function pickerLabel(m: string): string {
  const a = aliasOf(m);
  if (!a) return m;
  const v = aliasVersion(a);
  return v ? `${cap(a)} (${v})` : cap(a);
}

/** An alias as people say it today ("Fable 5.2"), or null when m isn't a bare alias. */
export function aliasLabel(m: string | null | undefined): string | null {
  const a = m ? aliasOf(m) : null;
  if (!a) return null;
  const v = aliasVersion(a);
  return v ? `${cap(a)} ${v}` : cap(a);
}

/** Picker options for a model Select: the aliases, then a saved custom id so it stays shown. */
export function modelOptions(current?: string | null, skip?: string | null): { value: string; label: string }[] {
  return [
    ...MODELS.filter((m) => m !== skip).map((m) => ({ value: m, label: pickerLabel(m) })),
    ...(current && !MODELS.includes(current) ? [{ value: current, label: current }] : []),
  ];
}

/** What a ticket's runs use: its model, effort level (null: Claude Code's default) and whether ultracode is on. */
export interface RunPick {
  model: string | null;
  effort: string | null;
  ultracode: boolean;
}

/**
 * The model and effort a ticket runs on, in the order the server picks them (board.ts chatArgs, commands.ts runOptions):
 * the ticket's own; for a main ticket the board's Main ticket model; then the board's model and effort; then the model
 * and effort Claude Code itself defaults to (its settings.json, from /api/claude/defaults). A tool ticket's kind (Task models) is
 * written onto the ticket when it is made, so it shows as the ticket's own. "ultracode" saved as the effort reads as
 * xhigh with ultracode on.
 */
export function resolveRun(
  t: { model?: string | null; effort?: string | null; ultracode?: boolean | null; main?: boolean | null },
  p: { model?: string | null; mainModel?: string | null; effort?: string | null; ultracode?: boolean | null } | null | undefined,
  claude?: { model?: string | null; effort?: string | null } | null,
): RunPick {
  const level = (e: string | null | undefined) => (e === "ultracode" ? "xhigh" : e || null);
  const legacy = (e: string | null | undefined) => (e === "ultracode" ? true : undefined);
  return {
    model: t.model || (t.main ? p?.mainModel : null) || p?.model || claude?.model || null,
    effort: level(t.effort) ?? level(p?.effort) ?? level(claude?.effort),
    ultracode: t.ultracode ?? legacy(t.effort) ?? p?.ultracode ?? legacy(p?.effort) ?? false,
  };
}

/** "Opus", "Sonnet 5.5"…: the model as people say it. */
export function modelLabel(m: string | null | undefined): string {
  if (!m) return "Default model";
  // An alias ("fable") means the newest version: say which one it is today.
  const alias = aliasLabel(m);
  if (alias) return alias;
  const x = /(opus|sonnet|haiku|fable)(?:[-\s]?(\d+)[-.](\d+))?/i.exec(m);
  if (!x) return m;
  const name = x[1][0].toUpperCase() + x[1].slice(1).toLowerCase();
  return x[2] ? `${name} ${x[2]}.${x[3]}` : name;
}

/** "Opus 5.5 · medium", "Fable 5.2 · xhigh · ultracode": what a ticket runs on (see resolveRun). */
export function runText(r: RunPick): string {
  return [modelLabel(r.model), r.effort ?? "default effort", r.ultracode ? "ultracode" : null].filter(Boolean).join(" · ");
}
