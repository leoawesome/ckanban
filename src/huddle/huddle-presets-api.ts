// Huddles: role presets (teammates) and role notes (methods of the Huddles class in huddle.ts, split by topic).
import { type HuddlePreset, type HuddlePresetView, MAIN_PRESET, mergePresets, presetName } from "./huddle-presets";
import { ALL_ROLES, cleanNotes, type HuddleNote, lessonsSection, type LessonInput, NOTE_MAX, noteRole, noteText, type NoteScope, type RoleNotes } from "./huddle-notes";
import { isLevel, type Level } from "../core/layers";
import { proposalPreset, teammateProposal, type TeammateProposal } from "./teammate-proposal";
import type { Huddle, HuddleLearning, HuddleParticipant } from "../core/types";
import { nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, MAX_PENDING_TEAMMATES, pendingLearnings } from "./huddle-types";

export function presets(this: Huddles, slug: string): HuddlePresetView[] {
  return mergePresets(this.store.listHuddlePresets(null), this.store.listHuddlePresets(slug));
}

export function presetMap(this: Huddles, slug: string): Map<string, HuddlePreset> {
  return new Map(this.presets(slug).map((p) => [p.name, p]));
}

/** The level a delete goes to: the one asked for, else the one in effect (a built-in: the board, which then says no). */
export function levelOf(this: Huddles, level: unknown, source: string | undefined): Level {
  if (level !== undefined && level !== null && level !== "") {
    if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
    return level;
  }
  return source === "global" ? "global" : "board";
}

/** Every role's notes that exist on disk, general and this board's repo notes. */
export function notes(this: Huddles, slug: string): Record<string, RoleNotes> {
  if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
  const out: Record<string, RoleNotes> = {};
  for (const role of this.store.huddleNoteRoles(slug)) {
    if (noteRole(role) !== role) continue;
    out[role] = { general: this.store.readHuddleNotes(slug, role, "general"), repo: this.store.readHuddleNotes(slug, role, "repo") };
  }
  return out;
}

/** Replace a role's notes in one scope (the user added, edited or deleted lines in the Team tab). */
export function setNotes(this: Huddles, slug: string, role: string, scope: string, notes: unknown): HuddleNote[] {
  if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
  const r = noteRole(role);
  if (!r) throw new HuddleError(400, `"${role}" is not a role name`);
  if (scope !== "general" && scope !== "repo") throw new HuddleError(400, "scope must be general or repo");
  let ns: HuddleNote[];
  try {
    ns = cleanNotes(notes);
  } catch (e) {
    throw new HuddleError(400, (e as Error).message);
  }
  this.store.writeHuddleNotes(slug, r, scope, ns);
  return this.store.readHuddleNotes(slug, r, scope);
}

/** The "Lessons from past huddles" section for a new agent of `preset` (or an ad-hoc one: All-roles notes only). */
export function lessonsFor(this: Huddles, slug: string, preset: string | null): string {
  const read = (role: string): RoleNotes => ({ general: this.store.readHuddleNotes(slug, role, "general"), repo: this.store.readHuddleNotes(slug, role, "repo") });
  const role = preset && noteRole(preset) && preset !== ALL_ROLES ? preset : null;
  return lessonsSection(read(ALL_ROLES), role ? read(role) : null, role);
}

/** Lessons go to the board's pile (opts.learn), aimed at the agent's own role when it has one, else every role. */
export function addLearnings(this: Huddles, slug: string, hid: string, p: HuddleParticipant, lessons: LessonInput[]) {
  const presets = this.presetMap(slug);
  const target = p.preset && p.preset !== MAIN_PRESET && presets.has(p.preset) ? p.preset : ALL_ROLES;
  this.opts.learn?.(slug, this.get(slug, hid), p, target, lessons);
}

/** anyState: also one already saved or discarded. */
export function learning(this: Huddles, h: Huddle, id: string, anyState = false): HuddleLearning {
  const l = (h.learnings ?? []).find((x) => x.id === id);
  if (!l) throw new HuddleError(404, `no learning ${id} in huddle ${h.id}`);
  if (!anyState && l.status !== "pending") throw new HuddleError(409, `learning ${id} was already ${l.status}`);
  return l;
}

/** A pending learning with the user's changes (text, scope, target) applied and checked. */
export function patched(this: Huddles, slug: string, l: HuddleLearning, patch: { text?: unknown; scope?: unknown; target?: unknown }): HuddleLearning {
  const out = { ...l };
  if (patch.text !== undefined) {
    const t = noteText(String(patch.text ?? ""));
    if (!t) throw new HuddleError(400, "the lesson's text is empty");
    if (t.length > NOTE_MAX) throw new HuddleError(400, `the lesson is ${t.length} characters, over the limit of ${NOTE_MAX}`);
    out.text = t;
  }
  if (patch.scope !== undefined) {
    if (patch.scope !== "general" && patch.scope !== "repo") throw new HuddleError(400, "scope must be general or repo");
    out.scope = patch.scope;
  }
  if (patch.target !== undefined && (l.teammate || l.squad)) throw new HuddleError(400, `a proposed ${l.squad ? "squad" : "teammate"} is saved as itself; pick all boards or this board with scope`);
  if (patch.target !== undefined) {
    const t = String(patch.target);
    if (t !== ALL_ROLES && t !== "new" && (t === MAIN_PRESET || !this.presetMap(slug).has(t))) {
      throw new HuddleError(400, `save to must be ${ALL_ROLES} (all roles), a role preset of this board, or new`);
    }
    if (t === "new" && l.preset) throw new HuddleError(400, `@${l.from} already has a role preset (${l.preset}); save to it instead`);
    out.target = t;
  }
  return out;
}

/** The user changes a pending learning before saving it: its text, scope or where it goes. */
export function editLearning(this: Huddles, slug: string, hid: string, id: string, patch: { text?: unknown; scope?: unknown; target?: unknown }): HuddleLearning {
  const next = this.patched(slug, this.learning(this.get(slug, hid), id), patch);
  this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), next));
  return next;
}

/**
 * The user saves a learning as a role note: at the top of the target's notes file (general: every repo; repo: this
 * board), with where it came from. Target "new" first makes a board preset from the agent's ad-hoc role (its label
 * and prompt). Only the user gets here (the HTTP route refuses runs and huddle agents).
 */
export function saveLearning(this: Huddles, slug: string, hid: string, id: string, patch: { text?: unknown; scope?: unknown; target?: unknown; replace?: unknown } = {}): HuddleLearning {
  const h = this.get(slug, hid);
  const l = this.patched(slug, this.learning(h, id), patch);
  if (l.squad) {
    // A proposed squad: saved as proposed for all boards (scope general) or this board (repo), its new teammates with it.
    this.saveSquad(slug, l.squad.squad, l.scope === "general" ? "global" : "board", { huddleId: hid, learningId: id }, patch.replace === true);
    return this.learning(this.get(slug, hid), id, true);
  }
  if (l.teammate) {
    // A proposed teammate: saved (or an existing one changed) for all boards (scope general) or this board (repo).
    const p = this.savePreset(slug, proposalPreset(l.teammate), l.scope === "general" ? "global" : "board");
    const saved: HuddleLearning = { ...l, status: "saved", target: p.name };
    this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), saved));
    return saved;
  }
  let role = l.target;
  if (role === "new") {
    const p = h.participants.find((x) => x.handle === l.from);
    const name = presetName(l.role);
    if (!p || !name) throw new HuddleError(400, `can't make a role from "${l.role}"`);
    if (this.presetMap(slug).has(name)) throw new HuddleError(409, `a role "${name}" already exists; save the lesson to it instead`);
    this.savePreset(slug, { name, role: l.role, prompt: p.prompt, model: p.model, mode: p.mode, workspace: p.workspace, lead: false, canEdit: p.canEdit });
    role = name;
  }
  const scope: NoteScope = l.scope;
  const note: HuddleNote = { text: l.text, by: l.from, date: nowIso().slice(0, 10), huddle: h.id };
  this.store.writeHuddleNotes(slug, role, scope, [note, ...this.store.readHuddleNotes(slug, role, scope)]);
  const saved: HuddleLearning = { ...l, status: "saved", target: role, ...(l.target === "new" ? { newRole: true } : {}) };
  this.update(slug, hid, (x) => void Object.assign(this.learning(x, id), saved));
  return saved;
}

/**
 * A huddle agent proposes a teammate (propose_teammate): it waits under Learnings (scope general: all boards) until
 * the user saves or discards it. Nothing is saved here.
 */
export function proposeTeammate(this: Huddles, slug: string, hid: string, by: HuddleParticipant, input: unknown): HuddleLearning {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (by.kind !== "agent") throw new HuddleError(400, "only huddle agents propose teammates to the huddle; a ticket chat's propose_teammate shows a card in its chat");
  let t: TeammateProposal;
  try {
    t = teammateProposal(input);
  } catch (e) {
    throw new HuddleError(400, `${(e as Error).message}. Nothing was changed.`);
  }
  const waiting = pendingLearnings(h).filter((l) => l.from === by.handle && l.teammate).length;
  if (waiting >= MAX_PENDING_TEAMMATES) {
    throw new HuddleError(400, `you already have ${waiting} proposed teammates waiting for the user; at most ${MAX_PENDING_TEAMMATES} can wait at once. Nothing was changed.`);
  }
  let out!: HuddleLearning;
  this.update(slug, hid, (x) => {
    x.learnings ??= [];
    out = {
      id: `l${x.learnings.length + 1}`, from: by.handle, role: by.role, preset: by.preset ?? null, text: t.why, evidence: "", scope: "general",
      status: "pending", target: "new", at: nowIso(), teammate: t,
    };
    x.learnings.push(out);
  });
  const known = this.presets(slug).some((p) => p.name === t.name);
  this.system(slug, hid, `@${by.handle} proposed ${known ? `a change to teammate @${t.name}` : `a new teammate @${t.name}`}; the user reviews it under Learnings.`);
  return out;
}
