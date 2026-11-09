// Squads: what the user and Claude call huddle templates (huddle-templates.ts). A user saves a huddle that worked as a
// generic squad and starts it again on any ticket with that ticket's topic.
//   - propose_squad: Claude proposes one; the board shows a squad card (in a ticket chat from the tool call in its
//     transcript, session.ts; from a huddle agent under the huddle's Learnings). Nothing is saved until the user clicks.
//   - "Save as squad…": one side call turns a huddle's setup into a generic squad (genericSquadPrompt), returned as
//     the same card shape, saving nothing.
//   - Saving a card (the user only, http.ts) saves the squad, and each person with no preset as a teammate at the same
//     scope; a teammate of that name that already exists is used as is, never overwritten (squadSavePlan).
// Plain helpers (no file access here).
import { type HuddlePreset, presetFromInput, presetName } from "./huddle-presets";
import { MAIN_HANDLE, USER_HANDLE, type RosterEntry } from "./huddle-roster";
import { type HuddleTemplate, templateFromInput } from "./huddle-templates";
import type { Level } from "./layers";
import type { Huddle, HuddleMessage, Ticket } from "./types";

/** A squad Claude proposed (propose_squad) or wrote from a huddle ("Save as squad…"): the card's data. */
export interface SquadProposal {
  squad: HuddleTemplate;
  /** One line: why this squad (propose_squad), or where it came from. */
  why: string;
  /**
   * The people with no preset (a role with its own prompt, e.g. "User journey walker"), by roster index: saving the
   * squad saves each as a teammate called `name` at the same scope, unless a teammate of that name exists (then that
   * one is used as is). The UI marks the ones whose name isn't taken yet as new teammates.
   */
  newTeammates: { index: number; name: string; role: string }[];
}

/** What the user did with a squad card: saved it (as `name`, for all boards or this board) or dismissed it. */
export interface SquadCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: Level;
  /** Teammates the save made, and existing ones it used as they are. */
  teammates?: { created: string[]; reused: string[] };
  at: string;
}

export const SQUAD_WHY_MAX = 400;
/** Characters of the host ticket's description a fallback topic carries. */
const TICKET_TOPIC_MAX = 600;

/** The topic when a squad starts without one: the host ticket's title and the start of its description. */
export function ticketTopic(t: Pick<Ticket, "title" | "body">): string {
  const body = t.body.trim().replace(/\s+/g, " ");
  return `${t.title.trim()}${body ? ` (from the ticket: ${body.length > TICKET_TOPIC_MAX ? `${body.slice(0, TICKET_TOPIC_MAX)}…` : body})` : ""}`;
}
/** Names a teammate made from a squad can't take (a preset may not be called these). */
const TAKEN = new Set(["you", "all", "system", "current", "main"]);

/** The teammate name a person with no preset is saved as: its handle, else its role. */
export function teammateNameFor(e: Pick<RosterEntry, "handle" | "role">): string {
  const n = presetName(e.handle?.trim() || e.role?.trim() || "");
  return n && TAKEN.has(n) ? `${n}-role` : n;
}

/** The proposal from propose_squad's input (the squad's fields plus `why`; `template`-shaped); throws a readable message. */
export function squadProposal(input: any, presets?: string[]): SquadProposal {
  if (!input || typeof input !== "object") throw new Error("the squad must be an object");
  const { why: w, profile: _p, scope: _s, ...fields } = input;
  const squad = templateFromInput(fields, undefined, presets);
  const why = typeof w === "string" ? w.trim() : "";
  if (!why) throw new Error("why is required: one line on why this squad (what it is good for)");
  if (why.length > SQUAD_WHY_MAX) throw new Error(`why is too long (max ${SQUAD_WHY_MAX} characters)`);
  return withNewTeammates(squad, why);
}

/** Like squadProposal, but null for input that can't be read (an old or broken tool call in a transcript). */
export function parseSquadProposal(input: unknown): SquadProposal | null {
  try {
    return squadProposal(input);
  } catch {
    return null;
  }
}

/** The card for a checked squad: marks the people with no preset. */
export function withNewTeammates(squad: HuddleTemplate, why: string): SquadProposal {
  const newTeammates = squad.roster.flatMap((e, index) => (e.preset?.trim() ? [] : [{ index, name: teammateNameFor(e), role: e.role?.trim() ?? "" }]));
  return { squad, why, newTeammates };
}

/**
 * How saving a squad goes, worked out before anything is written: the teammates to make (people with no preset whose
 * name isn't taken), the existing ones used as they are, and the squad with every such person pointed at its
 * teammate. `presets`: the teammates every board the squad reaches has (for a squad for all boards: built-in and
 * global ones only; for this board: every level). `taken`: every teammate name at any level, so a new teammate never
 * takes (and so never replaces) the name of one this board has. Throws a readable message when invalid.
 */
export function squadSavePlan(input: unknown, presets: Map<string, Pick<HuddlePreset, "name">>, taken: Iterable<string> = presets.keys()): {
  squad: HuddleTemplate; create: HuddlePreset[]; reused: string[];
} {
  const draft = templateFromInput(input, undefined, [...presets.keys()]);
  const create: HuddlePreset[] = [];
  const reused: string[] = [];
  const used = new Set(taken);
  const roster = draft.roster.map((e): RosterEntry => {
    if (e.preset?.trim()) return e;
    const base = teammateNameFor(e);
    if (!base) throw new Error(`can't make a teammate name from "${e.role ?? ""}"; give the person a handle`);
    const { role, prompt, ...rest } = e;
    const label = role?.trim() || base;
    const job = prompt?.trim() || `Help with the ticket as ${label}.`;
    let name = base;
    if (presets.has(name)) {
      // An existing teammate is used as is: its own prompt and label, never this person's.
      if (!reused.includes(name)) reused.push(name);
    } else {
      // The same person twice (same role and prompt) shares one new teammate; anyone else gets a free name.
      const same = create.find((p) => p.name === name && p.prompt === job && p.role === label);
      if (!same) {
        for (let n = 2; used.has(name) || create.some((p) => p.name === name); n++) name = `${base}-${n}`;
        create.push(presetFromInput({
          name, role: label, prompt: job,
          model: e.model ?? null, ...(e.mode ? { mode: e.mode } : {}), ...(e.workspace ? { workspace: e.workspace } : {}),
          ...(e.canEdit !== undefined ? { canEdit: e.canEdit } : {}), lead: !!e.lead,
        }));
      }
    }
    // The handle stays, so the squad's people keep the names its host rules and focus use.
    return { ...rest, preset: name, handle: rest.handle?.trim() || name };
  });
  const squad = templateFromInput({ ...draft, roster }, undefined, [...presets.keys(), ...create.map((p) => p.name)]);
  return { squad, create, reused };
}

// ---------- "Save as squad…": a generic squad from a huddle (one side call) ----------

/** Model and limits of the generic-squad call. */
export const GENERIC_SQUAD_MODEL = "sonnet";
export const GENERIC_SQUAD_TIMEOUT_MS = 240_000;
/** Most text of the summary file, or of the end of the chat, the call reads. */
export const GENERIC_SQUAD_SOURCE_MAX = 16_000;
const FIELD_MAX = 3_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** A participant's own prompt, without its preset's (the preset is kept by name). */
function ownPrompt(prompt: string, preset: Pick<HuddlePreset, "prompt"> | undefined): string {
  const p = prompt.trim();
  if (!preset?.prompt.trim()) return p;
  const base = preset.prompt.trim();
  return p === base ? "" : p.startsWith(base) ? p.slice(base.length).trim() : p;
}

/**
 * The huddle's setup as a squad (the roster as it was, nothing made generic): the helpers only, without @main, @you
 * and invited tickets. The UI opens it in the filled-in editor when the generic call fails.
 */
export function squadSetup(h: Huddle, presets: Map<string, HuddlePreset>, template?: HuddleTemplate | null): HuddleTemplate {
  const roster: RosterEntry[] = h.participants
    .filter((p) => p.kind === "agent" && p.handle !== MAIN_HANDLE && p.handle !== USER_HANDLE)
    .map((p) => {
      const preset = p.preset ? presets.get(p.preset) : undefined;
      const prompt = preset ? ownPrompt(p.prompt, preset) : p.prompt.trim();
      return {
        handle: p.handle,
        ...(preset ? { preset: preset.name } : {}),
        ...(!preset || p.role !== preset.role ? { role: p.role } : {}),
        ...(prompt ? { prompt } : {}),
        ...(p.focus?.trim() ? { focus: p.focus.trim() } : {}),
        mode: p.mode,
        ...(p.model ? { model: p.model } : {}),
        ...(p.lead ? { lead: true } : {}),
        ...(h.host === p.handle ? { host: true } : {}),
        ...(p.canEdit ? { canEdit: true } : {}),
      };
    });
  return {
    name: template?.name ?? "new-squad", label: template?.label ?? "New squad", description: template?.description ?? "",
    roster, rounds: template?.rounds ?? null, maxCostUsd: h.maxCostUsd ?? template?.maxCostUsd ?? null, report: template?.report ?? "",
    hostRules: template?.hostRules ?? "",
  };
}

/** The end of the chat for the call: the newest messages that fit, oldest first. */
export function chatTail(msgs: HuddleMessage[], max = GENERIC_SQUAD_SOURCE_MAX): string {
  const out: string[] = [];
  let len = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const line = `[#${m.seq}] ${m.kind === "system" ? "(system)" : `@${m.from}`}: ${clip(m.text, 1500)}`;
    if (len + line.length > max) break;
    out.push(line);
    len += line.length + 1;
  }
  return out.reverse().join("\n");
}

export const GENERIC_SQUAD_SYSTEM = `You turn one huddle that worked into a reusable squad: a saved huddle setup the user starts again later on any other ticket, about another topic. You get the huddle's setup (its people), its pinned brief, its lessons and its summary or the end of its chat. Answer with one JSON object and nothing else: no prose, no code fence.

Rules:
1. Make it generic. The squad will run on other tickets about other topics. Remove everything that only fits this huddle's ticket: point lists and numbered items, file names, paths, ticket and huddle ids, product, feature, company and tool names, and its findings and decisions. Where a rule needs the thing, name its general kind ("the topic's open points", "the code the topic touches").
2. Keep how the huddle ran: the steps and their order, each role's angle and how it reports, each person's handle, preset, mode, model, lead and host flags, and the budget.
3. hostRules: the host's process rules, written to the host as numbered steps: how the huddle runs, who posts when, when people may mark themselves done, how the final call is made. Move process rules found in the host's focus or prompt into hostRules, and keep the host's focus to its angle. Lessons about how the huddle ran go into hostRules as rules (e.g. "people marked themselves done too early, so nobody marks done before the host's final call"). Leave out lessons about one role only. Facts about the project never go in.
4. Each person: keep "preset" when it has one and don't repeat that preset's job. A person with no preset keeps "role" and gets a "prompt": its job in general terms. "focus": the person's angle in general terms, one or two sentences, or leave it out.
5. name: a short lowercase name with dashes for the kind of huddle (e.g. "plan-critique"), never a product or ticket name. label: the same in plain words. description: one line, what the squad is for and when to use it.
6. maxCostUsd: the huddle's budget. rounds: a whole number only when the huddle ran a fixed number of rounds, else null. report: how people report findings, in general terms, or "".

JSON shape:
{"name": "plan-critique", "label": "Plan critique", "description": "...", "hostRules": "1. ...\\n2. ...", "roster": [{"handle": "facilitator", "preset": "facilitator", "focus": "...", "mode": "monitor", "lead": true, "host": true}, {"handle": "walker", "role": "User journey walker", "prompt": "...", "focus": "...", "mode": "monitor"}, {"handle": "research", "preset": "researcher", "mode": "tagged", "model": "sonnet"}], "rounds": null, "maxCostUsd": 60, "report": ""}
Exactly one person has "host": true when the huddle had a host. Leave out fields you have nothing for.`;

/** The call's prompt: the huddle's setup and what it learned. `source`: the summary file, else the end of the chat. */
export function genericSquadPrompt(i: {
  setup: HuddleTemplate; brief: string | null; learnings: string[]; source: { kind: "summary" | "chat"; text: string } | null;
}): string {
  const people = i.setup.roster.map((e) => {
    const x: Record<string, unknown> = { ...e };
    for (const k of ["prompt", "focus"] as const) if (typeof x[k] === "string") x[k] = clip(x[k] as string, FIELD_MAX);
    return x;
  });
  return [
    "# The huddle's setup",
    JSON.stringify({ people, maxCostUsd: i.setup.maxCostUsd, rounds: i.setup.rounds, report: clip(i.setup.report, FIELD_MAX), hostRules: clip(i.setup.hostRules, FIELD_MAX) }, null, 2),
    "",
    "# Pinned brief at the end",
    i.brief?.trim() ? clip(i.brief.trim(), FIELD_MAX) : "(none)",
    "",
    "# Lessons the huddle's people proposed",
    i.learnings.length ? i.learnings.map((l) => `- ${clip(l, 500)}`).join("\n") : "(none)",
    "",
    i.source?.kind === "summary" ? "# The huddle's summary" : "# The end of the huddle's chat",
    i.source?.text.trim() ? clip(i.source.text.trim(), GENERIC_SQUAD_SOURCE_MAX) : "(none)",
    "",
    "Write the generic squad now, as one JSON object.",
  ].join("\n");
}

/** The squad in the call's answer, checked like a saved one (templateFromInput); throws a readable message. */
export function parseGenericSquad(text: string, presets?: string[]): HuddleTemplate {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the answer had no JSON object");
  let v: unknown;
  try {
    v = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new Error(`the answer wasn't valid JSON (${(e as Error).message})`);
  }
  return templateFromInput(v, undefined, presets);
}
