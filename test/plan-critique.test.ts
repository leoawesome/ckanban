// The built-in "Plan critique debate" squad and the built-in teammates it needs.
import { expect, test } from "bun:test";
import { BUILTIN_PRESETS, isBuiltinPreset, mergePresets, type HuddlePreset } from "../src/server/huddle-presets";
import { rosterError } from "../src/server/huddle-roster";
import { BUILTIN_TEMPLATES, MAX_TEXT, mergeTemplates, PLAN_CRITIQUE, templateFromInput } from "../src/server/huddle-templates";

const squad = BUILTIN_TEMPLATES.find((t) => t.name === PLAN_CRITIQUE)!;

test("plan critique debate: built in with six people, the right modes, a Sonnet researcher, a host and $60", () => {
  expect(squad.label).toBe("Plan critique debate");
  expect(squad.maxCostUsd).toBe(60);
  expect(squad.roster).toHaveLength(6);
  const by = Object.fromEntries(squad.roster.map((e) => [e.handle, e]));
  expect(Object.fromEntries(squad.roster.map((e) => [e.handle, [e.preset, e.mode]]))).toEqual({
    facilitator: ["facilitator", "monitor"], skeptic: ["breaker", "monitor"], visionary: ["visionary", "monitor"],
    journey: ["journey", "monitor"], research: ["researcher", "tagged"], builder: ["engineer", "tagged"],
  });
  expect(by.research.model).toBe("sonnet");
  expect(squad.roster.filter((e) => e.host)).toEqual([by.facilitator]);
  expect(by.facilitator.lead).toBe(true);
  for (const e of squad.roster) expect(isBuiltinPreset(e.preset!)).toBe(true);
  expect(rosterError(squad.roster, 32, BUILTIN_PRESETS.map((p) => p.name))).toBeNull();
  // It saves and reloads as is (text limits, roster shape).
  for (const k of ["description", "report", "hostRules"] as const) expect(squad[k].length).toBeLessThanOrEqual(MAX_TEXT);
  expect(templateFromInput(squad)).toEqual({ ...squad, roster: squad.roster.map((e) => ({ ...e })) });
  // Generic wording, and the four-step process.
  expect(JSON.stringify(squad)).not.toMatch(/point list|ckanban|channel/i);
  expect(squad.hostRules).toContain("anything still missing?");
  expect(squad.hostRules).toContain("Nobody marks themselves done before your final call");
  expect(mergeTemplates([]).find((t) => t.name === PLAN_CRITIQUE)?.source).toBe("builtin");
});

test("plan critique debate: the user's own visionary and journey teammates win over the built-ins", () => {
  const mine: HuddlePreset = { ...BUILTIN_PRESETS.find((p) => p.name === "visionary")!, prompt: "my own visionary" };
  const merged = mergePresets([mine], []);
  expect(merged.find((p) => p.name === "visionary")).toMatchObject({ prompt: "my own visionary", source: "global", base: "builtin" });
  expect(merged.find((p) => p.name === "journey")).toMatchObject({ source: "builtin" });
  // A board copy of the squad still wins over the built-in.
  expect(mergeTemplates([], [{ ...squad, maxCostUsd: 10 }]).find((t) => t.name === PLAN_CRITIQUE)).toMatchObject({ maxCostUsd: 10, source: "board" });
});
