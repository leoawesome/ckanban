// Huddles: whole-huddle templates and squads (methods of the Huddles class in huddle.ts, split by topic).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_PRESETS, presetName } from "./huddle-presets";
import { type HuddleTemplateView, mergeTemplates } from "./huddle-templates";
import { huddleUsage, type Usage } from "./huddle-usage";
import { isLevel, lowerLevels } from "../core/layers";
import { addSideSpend, type SideCaller } from "../runs/side-call";
import { chatTail, GENERIC_SQUAD_MODEL, GENERIC_SQUAD_SYSTEM, GENERIC_SQUAD_TIMEOUT_MS, genericSquadPrompt, parseGenericSquad, squadProposal, type SquadProposal, squadSavePlan, squadSetup, withNewTeammates } from "./squad";
import type { Huddle, HuddleLearning, HuddleParticipant } from "../core/types";
import { nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, pendingLearnings, GenericSquadResult } from "./huddle-types";

export function templates(this: Huddles, slug: string): HuddleTemplateView[] {
  return mergeTemplates(this.store.listHuddleTemplates(null), this.store.listHuddleTemplates(slug));
}

/** How every teammate and template has been used, from the huddles on every board (closed ones included). */
export function usage(this: Huddles): { teammates: Record<string, Usage>; templates: Record<string, Usage> } {
  return huddleUsage(this.store.listProfiles().flatMap((p) =>
    // The shared frozen index (only read here): no copy of every huddle on every board.
    this.store.huddleIndex(p.slug).map((h) => ({ board: p.slug, huddle: h as Huddle, title: this.store.getTicket(p.slug, h.hostTicket)?.title ?? null }))));
}

/**
 * A huddle agent proposes a squad (propose_squad): it waits under Learnings (scope general: all boards) until the
 * user saves or discards it. Nothing is saved here.
 */
export function proposeSquad(this: Huddles, slug: string, hid: string, by: HuddleParticipant, input: unknown): HuddleLearning {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (by.kind !== "agent") throw new HuddleError(400, "only huddle agents propose squads to the huddle; a ticket chat's propose_squad shows a card in its chat");
  let s: SquadProposal;
  try {
    s = squadProposal(input, this.presets(slug).map((p) => p.name));
  } catch (e) {
    throw new HuddleError(400, `${(e as Error).message}. Nothing was changed.`);
  }
  if (pendingLearnings(h).some((l) => l.from === by.handle && l.squad)) {
    throw new HuddleError(400, "you already have a proposed squad waiting for the user; one can wait at once. Nothing was changed.");
  }
  let out!: HuddleLearning;
  this.update(slug, hid, (x) => {
    x.learnings ??= [];
    out = {
      id: `l${x.learnings.length + 1}`, from: by.handle, role: by.role, preset: by.preset ?? null, text: s.why, evidence: "", scope: "general",
      status: "pending", target: s.squad.name, at: nowIso(), squad: s,
    };
    x.learnings.push(out);
  });
  this.system(slug, hid, `@${by.handle} proposed a squad "${s.squad.label}"; the user reviews it under Learnings.`);
  return out;
}

/**
 * The user saves a squad (a squad card, or a huddle's proposed squad): first each person with no preset as a
 * teammate at the same level (an existing teammate of that name is used as is, never changed), then the squad with
 * those people pointed at their teammates. Everything is checked before anything is written. `learning`: the
 * huddle's proposed squad this saves, marked saved. Only the user gets here (the HTTP routes refuse runs and agents).
 */
export function saveSquad(this: Huddles, slug: string, input: unknown, level: unknown = "board", learning?: { huddleId: string; learningId: string }, replace = false): {
  squad: HuddleTemplateView; teammates: { created: string[]; reused: string[] };
} {
  if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
  if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
  if (learning) this.learning(this.get(slug, learning.huddleId), learning.learningId);
  // A card never replaces a squad by surprise: the user renames it, or confirms (replace).
  const name = presetName(typeof (input as any)?.name === "string" ? (input as any).name : "");
  const existing = this.templates(slug).find((t) => t.name === name);
  if (existing && !replace) throw new HuddleError(409, `a squad named "${name}" already exists (${existing.label}); rename this one, or save with replace to change that one`);
  let plan: ReturnType<typeof squadSavePlan>;
  try {
    // A squad for all boards may only point at teammates every board has (built-in and global); a new one never takes a name this board has.
    const reach = level === "global" ? new Map(lowerLevels(BUILTIN_PRESETS, this.store.listHuddlePresets(null), "board").map((p) => [p.name, p])) : this.presetMap(slug);
    plan = squadSavePlan(input, reach, this.presetMap(slug).keys());
  } catch (e) {
    throw new HuddleError(400, (e as Error).message);
  }
  for (const p of plan.create) this.savePreset(slug, p, level);
  const squad = this.saveTemplate(slug, plan.squad, level);
  const teammates = { created: plan.create.map((p) => p.name), reused: plan.reused };
  if (learning) {
    this.update(slug, learning.huddleId, (x) => void Object.assign(this.learning(x, learning.learningId), {
      status: "saved" as const, target: squad.name, scope: level === "global" ? "general" as const : "repo" as const,
    }));
  }
  return { squad, teammates };
}

/**
 * "Save as squad…": one side call writes a generic squad from a huddle (running or closed) and returns it as a squad
 * card, saving nothing. Its cost goes on the host ticket's side ledger. On a bad answer it asks once more, then
 * returns the error with the huddle's setup as it was (for the filled-in editor).
 */
export async function genericSquad(this: Huddles, slug: string, hid: string, call: SideCaller): Promise<GenericSquadResult> {
  const h = this.get(slug, hid);
  const presets = this.presetMap(slug);
  const tpl = h.template ? this.templates(slug).find((t) => t.name === h.template) : undefined;
  const setup = squadSetup(h, presets, tpl);
  if (!setup.roster.length) throw new HuddleError(400, "this huddle has no helpers to make a squad from");
  const summary = this.summaryOf(slug, h);
  let source: { kind: "summary" | "chat"; text: string } | null = null;
  if (summary) {
    try {
      source = { kind: "summary", text: readFileSync(join(this.store.outputsPath(slug, h.hostTicket), summary), "utf8") };
    } catch {}
  }
  source ??= { kind: "chat", text: chatTail(this.store.readHuddleMessages(slug, hid)) };
  const learnings = (h.learnings ?? []).map((l) => `${l.teammate ? "Proposed teammate: " : l.squad ? "Proposed squad: " : ""}${l.text} (from @${l.from}, ${l.role})`);
  // Process lessons often come back as a participant's reason for its status ("not done until the host's call").
  for (const p of h.participants) if (p.kind === "agent" && p.statusReason?.trim()) learnings.push(`@${p.handle} (${p.role}) ended ${p.status}: ${p.statusReason.trim()}`);
  const prompt = genericSquadPrompt({ setup, brief: h.brief?.text ?? null, learnings, source });
  const names = [...presets.keys()];
  let costUsd = 0;
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call({
      system: GENERIC_SQUAD_SYSTEM, model: GENERIC_SQUAD_MODEL, timeoutMs: GENERIC_SQUAD_TIMEOUT_MS,
      prompt: attempt ? `${prompt}\n\nYour last answer couldn't be used: ${error}. Answer with the JSON object only.` : prompt,
    });
    const cost = r.costUsd ?? 0;
    costUsd += cost;
    addSideSpend(this.store.sideSpendPath(slug, h.hostTicket), "squad", cost);
    if (!r.ok) return { proposal: null, error: `Claude couldn't write the squad: ${r.error}`, setup, costUsd };
    try {
      const squad = parseGenericSquad(r.text, names);
      return { proposal: withNewTeammates(squad, `Made from huddle ${h.id}.`), error: null, setup, costUsd };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return { proposal: null, error: `Claude's squad couldn't be read twice (${error}); open the filled-in editor instead.`, setup, costUsd };
}

/** The user discards a learning: it is never saved. */
export function discardLearning(this: Huddles, slug: string, hid: string, id: string): HuddleLearning {
  this.learning(this.get(slug, hid), id);
  let out!: HuddleLearning;
  this.update(slug, hid, (x) => {
    out = Object.assign(this.learning(x, id), { status: "discarded" as const });
  });
  return out;
}
