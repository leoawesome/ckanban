// The team's fixture table for the Rust port (rust/board/tests/fixtures/team.json) and the built-in teammates and
// squads the Rust board ships (rust/board/src/team/builtins.json): every pure helper of src/huddle/ that R11b ports
// (presets, templates, layers, roster checks, role notes, teammate and squad proposals, the squad save plan, the
// "Save as squad…" prompt and the plan review file) over many inputs, with Bun's answer (JSON, or the error text).
// This test checks Bun still gives those answers and still ships those built-ins; `cargo test -p ckanban-board --test
// team` checks Rust gives the same.
//
// After a deliberate change: `UPDATE_RUST_FIXTURES=1 bun test test/rust-team-fixtures.test.ts`, then make `cargo test`
// pass again.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Pr from "../src/huddle/huddle-presets";
import * as T from "../src/huddle/huddle-templates";
import * as R from "../src/huddle/huddle-roster";
import * as N from "../src/huddle/huddle-notes";
import * as S from "../src/huddle/squad";
import * as TP from "../src/huddle/teammate-proposal";
import { planProposal } from "../src/huddle/plan-review-file";
import { lowerLevels, mergeLayers } from "../src/core/layers";

const DIR = resolve(import.meta.dir, "..", "rust", "board");
const FILE = resolve(DIR, "tests", "fixtures", "team.json");
const BUILTINS = resolve(DIR, "src", "team", "builtins.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

interface Case {
  fn: string;
  args: unknown[];
  json?: unknown;
  error?: string;
}

const FNS: Record<string, (...a: any[]) => unknown> = {
  presetName: Pr.presetName,
  presetFromInput: Pr.presetFromInput,
  savePreset: Pr.savePreset,
  deletePreset: Pr.deletePreset,
  cleanPresets: Pr.cleanPresets,
  mergePresets: Pr.mergePresets,
  presetLine: Pr.presetLine,
  templateFromInput: T.templateFromInput,
  saveTemplate: T.saveTemplate,
  deleteTemplate: T.deleteTemplate,
  cleanTemplates: T.cleanTemplates,
  mergeTemplates: T.mergeTemplates,
  templateBrief: T.templateBrief,
  topicInput: T.topicInput,
  customReviewBrief: T.customReviewBrief,
  templateLine: T.templateLine,
  lowerLevels: (b: any[], g: any[], l: any) => lowerLevels(b, g, l),
  mergeLayers: (b: any[], g: any[], o: any[]) => mergeLayers(b, g, o),
  rosterError: R.rosterError,
  handleBase: R.handleBase,
  noteRole: N.noteRole,
  noteText: N.noteText,
  parseNotes: N.parseNotes,
  serializeNotes: N.serializeNotes,
  cleanNotes: N.cleanNotes,
  lessonsSection: N.lessonsSection,
  cleanLessons: N.cleanLessons,
  teammateProposal: TP.teammateProposal,
  parseTeammateProposal: TP.parseTeammateProposal,
  proposalPreset: TP.proposalPreset,
  teammateNameFor: S.teammateNameFor,
  squadProposal: S.squadProposal,
  parseSquadProposal: S.parseSquadProposal,
  withNewTeammates: S.withNewTeammates,
  // presets: the names every board the squad reaches has; taken: every name at any level (defaults to presets).
  squadSavePlan: (input: unknown, presets: string[], taken?: string[] | null) =>
    S.squadSavePlan(input, new Map(presets.map((n) => [n, { name: n }])), taken ?? undefined),
  squadSetup: (h: any, presets: any[], template: any) => S.squadSetup(h, new Map(presets.map((p) => [p.name, p])), template),
  chatTail: S.chatTail,
  genericSquadPrompt: S.genericSquadPrompt,
  parseGenericSquad: S.parseGenericSquad,
  planProposal,
};

function run(fn: string, args: unknown[]): Case {
  // Arguments go through JSON, as they do for Rust.
  const a = JSON.parse(JSON.stringify(args));
  try {
    const v = FNS[fn](...a);
    return { fn, args, json: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
  } catch (e) {
    return { fn, args, error: (e as Error).message };
  }
}

// ---- Inputs ----

const presetInputs: unknown[] = [
  null, 5, "x", [], {}, { name: "" }, { name: "!!!" }, { name: "you", prompt: "p" }, { name: "Main", prompt: "p" },
  { name: "QA Lead", prompt: "Lead QA." }, { name: "  Walker  ", role: "  Walker ", prompt: "  Walk the app.  " },
  { name: "x", prompt: "   " }, { name: "x", prompt: 5 }, { name: "x", prompt: null }, { name: "x", prompt: "p".repeat(8000) },
  { name: "x", prompt: "p".repeat(8001) }, { name: "x", prompt: "é".repeat(8000) }, { name: "x", prompt: "📦".repeat(4001) },
  { name: "x", prompt: "p", lead: "yes" }, { name: "x", prompt: "p", lead: null }, { name: "x", prompt: "p", lead: true },
  { name: "x", prompt: "p", lead: true, mode: "tagged" }, { name: "x", prompt: "p", mode: "loud" }, { name: "x", prompt: "p", mode: null },
  { name: "x", prompt: "p", mode: 5 }, { name: "x", prompt: "p", workspace: "own" }, { name: "x", prompt: "p", workspace: "mine" },
  { name: "x", prompt: "p", workspace: null }, { name: "x", prompt: "p", canEdit: true }, { name: "x", prompt: "p", canEdit: "no" },
  { name: "x", prompt: "p", canEdit: false, workspace: "own" }, { name: "main", prompt: "p", canEdit: true },
  { name: "x", prompt: "p", model: "" }, { name: "x", prompt: "p", model: "  sonnet " }, { name: "x", prompt: "p", model: 4 },
  { name: "x", prompt: "p", model: null }, { name: "x", prompt: "p", role: 3 }, { name: "x", prompt: "p", role: "" },
  { name: "fixer-lead", prompt: "Fix and lead.", lead: true, canEdit: true }, { name: "9lives", prompt: "p" },
  { name: "a-very-long-name-that-goes-past-the-limit-of-24", prompt: "p" }, { name: "aaaaaaaaaaaaaaaaaaaaaaa-b", prompt: "p" },
  { name: "Ünïcödé Ⅻ ＡＢ", prompt: "p" }, { name: "Kelvin", prompt: "p" }, { name: "x", prompt: "p", extra: 1, lead: false },
  { name: "x", prompt: "﻿ p  " }, { name: "--a--b--", prompt: "p" },
];
const base = { name: "reviewer", role: "Code reviewer", prompt: "Review.", model: "opus", mode: "monitor", workspace: "own", lead: true, canEdit: true };
const baseInputs: unknown[] = [
  { name: "reviewer" }, { name: "reviewer", prompt: "" }, { name: "reviewer", workspace: null }, { name: "reviewer", workspace: "shared" },
  { name: "reviewer", lead: false }, { name: "reviewer", model: null }, { name: "reviewer", model: "haiku" }, { name: "reviewer", mode: null },
  { name: "reviewer", role: "  " }, { name: "reviewer", canEdit: false },
];
const baseNoLead = { ...base, lead: false, mode: "tagged", canEdit: false, workspace: "shared", model: null };

const roster = (...e: unknown[]) => e;
const rosters: unknown[] = [
  undefined, null, [], "x", [null], [5], [[]], [{}], [{ preset: "" }], [{ preset: 5 }], [{ preset: " main " }], [{ preset: "reviewer" }],
  [{ preset: "nope" }], [{ role: "  " }], [{ role: "Walker" }], [{ preset: "qa", role: 3 }], [{ preset: "qa", count: 0 }],
  [{ preset: "qa", count: 9 }], [{ preset: "qa", count: 2.5 }], [{ preset: "qa", count: null }], [{ preset: "qa", count: 8 }],
  [{ preset: "qa", mode: "x" }], [{ preset: "qa", workspace: "x" }], [{ preset: "qa", focus: 3 }], [{ preset: "qa", model: null, handle: null }],
  [{ preset: "qa", lead: "y" }], [{ preset: "qa", canEdit: null }], [{ preset: "qa", host: 1 }], [{ preset: "qa", handle: "You" }],
  [{ preset: "qa", handle: "!!main!!" }], [{ preset: "qa", host: true, count: 2 }], roster({ preset: "qa", host: true }, { preset: "reviewer", host: true }),
  roster({ preset: "qa", count: 4 }, { preset: "reviewer", count: 3 }), roster({ preset: "qa", count: 4 }, { preset: "reviewer", count: 4 }),
];
const presetNames = ["main", "reviewer", "qa", "qa-lead", "breaker"];

const tplInputs: unknown[] = [
  null, 3, [], {}, { name: "Pair" }, { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: 5 },
  { name: "Pair", roster: [{ preset: "reviewer" }], rounds: 0 }, { name: "Pair", roster: [{ preset: "reviewer" }], rounds: 20 },
  { name: "Pair", roster: [{ preset: "reviewer" }], rounds: 21 }, { name: "Pair", roster: [{ preset: "reviewer" }], rounds: 2.5 },
  { name: "Pair", roster: [{ preset: "reviewer" }], rounds: "2" }, { name: "Pair", roster: [{ preset: "reviewer" }], rounds: null },
  { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: 0 }, { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: -1 },
  { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: 2.75 }, { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: "5" },
  { name: "Pair", roster: [{ preset: "reviewer" }], label: 5 }, { name: "Pair", roster: [{ preset: "reviewer" }], label: "x".repeat(4001) },
  { name: "Pair", roster: [{ preset: "reviewer" }], label: "  Two  ", description: "  ", report: " R ", hostRules: "1. a\n2. b " },
  { name: "Pair", roster: [{ preset: "reviewer" }], description: null, report: 3 }, { name: "x", roster: [{ preset: "no-such-teammate" }] },
  { name: "big", roster: [{ role: "A", count: 8 }, { role: "B", count: 8 }, { role: "C", count: 8 }, { role: "D", count: 7 }] },
  { name: "big", roster: [{ role: "A", count: 8 }, { role: "B", count: 8 }, { role: "C", count: 8 }, { role: "D", count: 8 }] },
  { name: "keys", roster: [{ zeta: 1, preset: "qa", alpha: [1, { b: 2 }], focus: "f" }], rounds: 1e0, maxCostUsd: 1.5e1 },
];
const tplBase = { name: "pair", label: "Pair", description: "Two eyes.", roster: [{ preset: "qa" }], rounds: 3, maxCostUsd: 9, report: "r", hostRules: "h" };

const NOTES_MD = [
  "# Huddle notes: role reviewer, all repos\n<!-- Newest first. -->\n\n- Read the tests first. <!-- by you -->\n- Name the file. <!-- from @qa-1, 2026-11-10, huddle h_abc -->\n",
  "- a\n-  \n- b <!-- -->\n- c <!--from @x-->\n-d\n - e\n- f <!-- from @Bad Name, 2026-1-1, huddle h_ -->\n- g\r\n- h <!-- 2026-01-02, huddle H_X1, from @y -->  \n",
  "- one\r two <!-- by you -->\n- three four\n- tab\there <!-- from @a_b -->\n- dangling <!-- unclosed\n- x <!-- a --> trailing\n",
  "", "no list\n* star\n-- dash\n", "- emoji 📦 <!-- from @e, 2026-12-31 -->\n-  nbsp  <!-- by you -->\n",
];
const notesBodies: unknown[] = [
  undefined, null, "x", {}, [], [{ text: " " }], [{}], [null], [{ text: "ok" }], [{ text: "a <!-- b --> c\n\n d  " }],
  [{ text: "x".repeat(400) }], [{ text: "x".repeat(401) }], [{ text: "📦".repeat(201) }],
  [{ text: "t", by: "qa-1", date: "2026-11-10", huddle: "h_abc" }], [{ text: "t", by: "bad name", date: "2026-1-10", huddle: "x_abc" }],
  [{ text: "t", by: 5, date: 5, huddle: 5 }], [{ text: "first" }, { text: "" }], [{ text: "Read the tests first." }, { text: "Name the file.", by: "qa-1", date: "2026-11-10", huddle: "h_abc" }],
];
const lessonInputs: unknown[] = [
  undefined, null, "x", [], [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }], [{ text: "" }], [{ text: "x".repeat(201) }],
  [{ text: "Rule.", scope: "repo", evidence: "  it  broke " }], [{ text: "Rule.", scope: "everywhere" }], [{ text: "Rule.", evidence: "e".repeat(300) }],
  [{ text: "Rule.", scope: null }],
];

const teammateInputs: unknown[] = [
  null, {}, { name: "Phone Walker", role: "Phone walker", prompt: "Walk the app on a phone.", why: "Nobody checks phones." },
  { name: "x", prompt: "p" }, { name: "x", prompt: "p", why: "  " }, { name: "x", prompt: "p", why: "w".repeat(401) },
  { name: "x", prompt: " p ", why: " w ", role: "  ", model: "", mode: "monitor", workspace: "own", canEdit: true, lead: false },
  { name: "x", prompt: "p", why: "w", model: " opus ", role: " R " }, { name: "x", prompt: "p", why: "w", model: null },
  { name: "you", prompt: "p", why: "w" }, { name: "x", prompt: "p", why: 5 },
];

const squadInputs: unknown[] = [
  null, {}, { name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] },
  { name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }], why: "Walks.", profile: "p", scope: "board" },
  { name: "s", roster: [{ preset: "qa" }, { role: "Main" }, { role: "Journey walker", prompt: "Walk." }, { handle: "  ", role: "You" }], why: "w" },
  { name: "s", roster: [{ preset: "nope" }], why: "w" }, { name: "s", roster: [{ preset: "qa" }], why: "x".repeat(401) },
];
const planInputs: [unknown, string[], string[]?][] = [
  [{ name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] }, presetNames],
  [{ name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] }, [...presetNames, "walker"]],
  [{ name: "s", roster: [{ role: "Walker", prompt: "Walk." }, { role: "Walker", prompt: "Walk." }, { role: "Walker", prompt: "Other." }, { handle: "walker", role: "Talker" }] }, presetNames, [...presetNames, "walker-2"]],
  [{ name: "s", roster: [{ zeta: 1, role: "Main", focus: "f", mode: "monitor", workspace: "own", canEdit: false, lead: true, model: "sonnet", host: true }] }, presetNames],
  [{ name: "s", roster: [{ preset: "qa", handle: "q" }, { role: "  Spaced  ", handle: null, prompt: null }] }, presetNames],
  [{ name: "s", roster: [{ role: "!!!" }] }, presetNames], [{ name: "s", roster: [{ preset: "walker" }] }, presetNames],
  [null, presetNames], [{ name: "s", roster: [{ role: "Walker", prompt: "p".repeat(8001) }] }, presetNames],
];

const view = (o: Record<string, unknown>) => ({ ...o, source: "builtin", base: null, builtin: true });
const huddle = {
  id: "h_abc", host: "skeptic", maxCostUsd: 12, brief: { text: "Brief." },
  participants: [
    { handle: "you", kind: "user", role: "You", prompt: "", mode: "tagged" },
    { handle: "main", kind: "ticket-main", role: "Coordinator", prompt: "x", mode: "tagged" },
    { handle: "reviewer", kind: "agent", preset: "reviewer", role: "Code reviewer", prompt: `${Pr.BUILTIN_PRESETS[1].prompt}\n\nAlso check docs.`, mode: "tagged", model: null },
    { handle: "skeptic", kind: "agent", role: "Skeptic", prompt: "  Doubt it.  ", focus: " the plan ", mode: "monitor", model: "sonnet", lead: true, canEdit: true },
    { handle: "qa", kind: "agent", preset: "qa", role: "Tester", prompt: Pr.BUILTIN_PRESETS[2].prompt, mode: "monitor" },
    { handle: "gone", kind: "agent", preset: "deleted", role: "Gone", prompt: "p", mode: "tagged" },
    { handle: "api-main", kind: "ticket-main", role: "Ticket", prompt: "", mode: "tagged" },
  ],
};
const msgs = [
  { seq: 1, from: "you", kind: "message", text: "Hi" },
  { seq: 2, from: "system", kind: "system", text: "x".repeat(2000) },
  { seq: 3, from: "qa", kind: "finding", text: "Bug 📦" },
];

function cases(): Case[] {
  const out: Case[] = [];
  const add = (fn: string, ...args: unknown[]) => out.push(run(fn, args));
  for (const s of ["QA Lead", "  --A__b  ", "", "ÄÖ", "a".repeat(30), "Kelvin K", "İstanbul", "x-", "123 456"]) add("presetName", s);
  for (const i of presetInputs) add("presetFromInput", i);
  for (const i of baseInputs) {
    add("presetFromInput", i, base);
    add("presetFromInput", i, baseNoLead);
  }
  add("presetFromInput", { name: "x", lead: true }, { ...baseNoLead, name: "x" });
  // A level's list: replace, override a lower one, add.
  const mine = [{ ...baseNoLead, name: "walker", role: "Walker", prompt: "Walk." }];
  add("savePreset", mine, { name: "walker", prompt: "Again." });
  add("savePreset", mine, { name: "reviewer", prompt: "Mine." });
  add("savePreset", mine, { name: "new-one", prompt: "New." });
  add("savePreset", mine, { name: "qa" }, Pr.BUILTIN_PRESETS);
  add("savePreset", [], { name: "nothing" });
  for (const n of ["walker", "Walker", "reviewer", "nope", "built-in"]) add("deletePreset", mine, n);
  add("deletePreset", [{ ...baseNoLead, name: "reviewer" }], "reviewer");
  add("cleanPresets", [...presetInputs, ...presetInputs, { name: "zz", prompt: "p", lead: false, extra: true }]);
  add("cleanPresets", { not: "a list" });
  add("mergePresets", [{ ...baseNoLead, name: "zeta" }, { ...baseNoLead, name: "qa", role: "Global QA" }, { ...baseNoLead, name: "alpha" }],
    [{ ...baseNoLead, name: "qa", role: "Board QA" }, { ...baseNoLead, name: "beta" }, { ...baseNoLead, name: "zeta", role: "Z" }]);
  add("mergePresets", []);
  for (const p of Pr.mergePresets([], [])) add("presetLine", p);
  add("presetLine", { ...baseNoLead, name: "w", workspace: "own", canEdit: false, model: "opus", source: "board", base: "global", builtin: false });
  add("presetLine", { ...baseNoLead, name: "w", source: "global", base: "builtin", builtin: true });
  add("presetLine", { ...baseNoLead, name: "w", source: "global", base: null, builtin: false });
  add("presetLine", { ...baseNoLead, name: "w", source: "board", base: null, builtin: false });

  for (const r of rosters) {
    add("rosterError", r);
    add("rosterError", r, 8, presetNames);
  }
  add("rosterError", [{ preset: "qa" }], 1);
  for (const s of ["You", "  ", "Q&A lead!!", "a".repeat(40), "main"]) add("handleBase", s);

  for (const i of tplInputs) {
    add("templateFromInput", i);
    add("templateFromInput", i, undefined, presetNames);
  }
  add("templateFromInput", { name: "pair" }, tplBase);
  add("templateFromInput", { name: "pair", label: "", description: "", rounds: null, maxCostUsd: null, report: "", hostRules: "" }, tplBase);
  add("saveTemplate", [tplBase], { name: "pair", description: "New." });
  add("saveTemplate", [tplBase], { name: "design-review", report: "Mine." });
  add("saveTemplate", [], { name: "x", roster: [{ preset: "nope" }] }, presetNames);
  for (const n of ["pair", "design-review", "nope", "plan-review"]) add("deleteTemplate", [tplBase], n);
  add("cleanTemplates", [...tplInputs, tplBase, tplBase]);
  add("mergeTemplates", [{ ...tplBase, name: "zz" }, { ...tplBase, name: "plan-review" }], [{ ...tplBase, name: "aa" }]);
  for (const t of T.mergeTemplates([], [])) add("templateLine", t);
  add("templateLine", { ...tplBase, roster: [{ preset: "qa", count: 2 }, { handle: "h", preset: "x" }, { role: "R" }], source: "board", base: null, builtin: false });
  add("templateLine", { ...tplBase, rounds: null, maxCostUsd: null, hostRules: " ", description: "", source: "global", base: null, builtin: false });
  for (const [b, topic] of [[20, "  The login page  "], [5.5, null], [0, ""], [100, undefined]] as [number, any][]) {
    add("templateBrief", T.BUILTIN_TEMPLATES[0], b, topic);
    add("templateBrief", tplBase, b, topic);
  }
  add("templateBrief", { ...tplBase, description: "", hostRules: "", rounds: null, report: "" }, 1);
  for (const v of [undefined, null, 5, "  ", " topic ", "x".repeat(2001), "x".repeat(2000)]) add("topicInput", v);
  for (const b of [100, 2.5, 0.1]) add("customReviewBrief", b);
  add("lowerLevels", Pr.BUILTIN_PRESETS.slice(0, 3), [{ ...baseNoLead, name: "qa", role: "G" }, { ...baseNoLead, name: "g1" }], "board");
  add("lowerLevels", Pr.BUILTIN_PRESETS.slice(0, 3), [{ ...baseNoLead, name: "qa", role: "G" }], "global");
  add("mergeLayers", [{ name: "b1" }, { name: "a1" }], [{ name: "z", v: 1 }, { name: "a1", v: 2 }, { name: "m-1" }, { name: "m0" }], [{ name: "z", v: 3 }, { name: "10" }, { name: "9" }]);

  for (const s of [null, 5, "_all", "reviewer", "Reviewer", "qa lead", "a-b", "-a", ""]) add("noteRole", s);
  for (const s of ["  a <!-- b --> c \n\n d ", "<!<!---->-->", " x y﻿"]) add("noteText", s);
  for (const md of NOTES_MD) add("parseNotes", md);
  const someNotes = N.parseNotes(NOTES_MD[0]).concat(N.parseNotes(NOTES_MD[1]));
  for (const [role, scope] of [["reviewer", "general"], ["_all", "repo"], ["qa", "repo"]]) add("serializeNotes", role, scope, someNotes);
  add("serializeNotes", "x", "general", []);
  add("serializeNotes", "x", "general", [{ text: "a --> b\nc", by: "you", date: null, huddle: null }]);
  for (const b of notesBodies) add("cleanNotes", b);
  const many = Array.from({ length: 35 }, (_, i) => ({ text: `n${i}`, by: "you", date: null, huddle: null }));
  add("lessonsSection", { general: [], repo: [] }, null, null);
  add("lessonsSection", { general: many, repo: [{ text: "r <!-- x -->", by: "you", date: null, huddle: null }] }, { general: [], repo: [] }, "qa");
  add("lessonsSection", { general: [], repo: [] }, { general: [{ text: "g", by: "you", date: null, huddle: null }], repo: many }, "qa");
  for (const l of lessonInputs) add("cleanLessons", l);

  for (const t of teammateInputs) {
    add("teammateProposal", t);
    add("parseTeammateProposal", t);
  }
  add("proposalPreset", { name: "x", prompt: "p", why: "w", role: "R", model: null });
  for (const e of [{ handle: "Walker", role: "W" }, { handle: "  ", role: "Main" }, { role: "you" }, { role: "" }, { handle: null, role: "A B" }]) add("teammateNameFor", e);
  for (const s of squadInputs) {
    add("squadProposal", s);
    add("squadProposal", s, presetNames);
    add("parseSquadProposal", s);
  }
  add("withNewTeammates", tplBase, "why");
  add("withNewTeammates", { ...tplBase, roster: [{ preset: " " }, { preset: "qa" }, { handle: "h" }, { role: " R " }] }, "why");
  for (const [i, p, t] of planInputs) add("squadSavePlan", i, p, t);
  add("squadSetup", huddle, Pr.BUILTIN_PRESETS, null);
  add("squadSetup", { ...huddle, maxCostUsd: undefined, host: null }, Pr.BUILTIN_PRESETS, tplBase);
  add("squadSetup", { ...huddle, maxCostUsd: null }, [], { ...tplBase, maxCostUsd: null });
  add("chatTail", msgs);
  add("chatTail", msgs, 1600);
  add("chatTail", msgs, 10);
  add("chatTail", [], 10);
  const setup = S.squadSetup(huddle as any, new Map(Pr.BUILTIN_PRESETS.map((p) => [p.name, p])), null);
  add("genericSquadPrompt", { setup, brief: "  Brief  ", learnings: ["one", "x".repeat(600)], source: { kind: "summary", text: " # Sum " } });
  add("genericSquadPrompt", { setup: { ...setup, report: "r".repeat(3100), hostRules: "" }, brief: null, learnings: [], source: null });
  add("genericSquadPrompt", { setup: { ...setup, roster: [{ handle: "a", prompt: "p".repeat(3100), focus: 5 }] }, brief: " ", learnings: [], source: { kind: "chat", text: "c".repeat(16_100) } });
  for (const text of [
    "no json", "{bad json}", "```json\n{\"name\":\"plan-critique\",\"roster\":[{\"preset\":\"qa\"}]}\n```", "Here: {\"name\":\"x\",\"roster\":[{\"role\":\"R\"}]} done",
    "{\"name\":\"x\",\"roster\":[{\"preset\":\"nope\"}]}", "}{",
  ]) {
    add("parseGenericSquad", text);
    add("parseGenericSquad", text, presetNames);
  }
  const t = { id: "t_20261101_ab12", title: "Fix login", body: "  Make it work.  \n" };
  add("planProposal", t, []);
  add("planProposal", { ...t, body: "  " }, [{ role: "user", text: "x" }]);
  add("planProposal", t, [{ role: "assistant", proposal: { title: "First", description: "One" } }, { role: "assistant", proposal: { title: "", description: "" } }, { role: "user", proposal: { title: "U" } }]);
  add("planProposal", t, [{ role: "assistant", proposal: { title: "Only", description: "Desc." } }, { role: "assistant", proposal: null }]);
  return out;
}

// The texts Rust ships as they are (long prompts, so they are read from here rather than copied by hand).
const builtins = () => ({
  presets: Pr.BUILTIN_PRESETS,
  templates: T.BUILTIN_TEMPLATES,
  texts: {
    genericSquadSystem: S.GENERIC_SQUAD_SYSTEM, genericSquadModel: S.GENERIC_SQUAD_MODEL, genericSquadTimeoutMs: S.GENERIC_SQUAD_TIMEOUT_MS,
    autoReviewFindings: T.AUTO_REVIEW_FINDINGS, autoReviewReadOnly: T.AUTO_REVIEW_READ_ONLY,
  },
});

test("the team fixture table and built-ins match Bun", () => {
  const table = cases();
  const text = `[\n${table.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`;
  const shipped = `${JSON.stringify(builtins(), null, 2)}\n`;
  if (UPDATE) {
    writeFileSync(FILE, text);
    writeFileSync(BUILTINS, shipped);
  }
  expect(readFileSync(BUILTINS, "utf8")).toBe(shipped);
  const saved = JSON.parse(readFileSync(FILE, "utf8")) as Case[];
  expect(saved.length).toBe(table.length);
  for (let i = 0; i < table.length; i++) expect({ i, ...saved[i] }).toEqual({ i, ...JSON.parse(JSON.stringify(table[i])) });
});
