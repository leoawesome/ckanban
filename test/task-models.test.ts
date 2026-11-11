import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindDefaults, parseTaskModels } from "../src/server/main-ticket";
import { learnedVersions, learnModel, useModelVersionsFile } from "../src/server/model-versions";
import { mainTicketRules } from "../src/server/prompts";
import { buildArgs } from "../src/server/runner";
import { aliasLabel, familyVersion, KIND_DEFAULTS, KNOWN_VERSIONS, MODELS, modelOptions, pickerLabel, setLearnedVersions, taskModelsText } from "../web/src/models";
import { modelName } from "../web/src/usage";

afterEach(() => {
  setLearnedVersions({});
  useModelVersionsFile(null);
});

test("every picker offers opus, fable, sonnet, haiku in that order", () => {
  expect(MODELS).toEqual(["opus", "fable", "sonnet", "haiku"]);
  expect(modelOptions("claude-sonnet-4-5").map((o) => o.value)).toEqual(["opus", "fable", "sonnet", "haiku", "claude-sonnet-4-5"]);
});

test("defaults are aliases per kind", () => {
  expect(KIND_DEFAULTS).toEqual({
    explore: { model: "sonnet", effort: "medium" }, build: { model: "opus", effort: "medium" }, fix: { model: "opus", effort: "medium" },
    test: { model: "opus", effort: "medium" }, review: { model: "fable", effort: "high" }, with_you: { model: "sonnet", effort: "medium" },
    group: { model: "sonnet", effort: "low" }, round: { model: "sonnet", effort: "low" },
  });
  expect(kindDefaults("review")).toEqual({ model: "fable", effort: "high" });
  expect(kindDefaults(null)).toBeNull();
  expect(kindDefaults("nope")).toBeNull();
});

test("a board's Task models override the default; an old board without the setting keeps the defaults", () => {
  const profile = { taskModels: { explore: { model: "fable", effort: "high" } } };
  expect(kindDefaults("explore", profile)).toEqual({ model: "fable", effort: "high" });
  expect(kindDefaults("build", profile)).toEqual({ model: "opus", effort: "medium" });
  expect(kindDefaults("explore", {})).toEqual(KIND_DEFAULTS.explore);
  // A pinned id saved before aliases still works as it is.
  expect(kindDefaults("test", { taskModels: { test: { model: "claude-sonnet-5-5", effort: "low" } } })).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
});

test("parseTaskModels keeps only overrides and refuses bad input", () => {
  expect(parseTaskModels({ explore: { model: "sonnet", effort: "medium" }, review: { model: "opus", effort: "max" } })).toEqual({ review: { model: "opus", effort: "max" } });
  expect(parseTaskModels({ explore: { model: "sonnet", effort: "medium" } })).toBeNull();
  expect(parseTaskModels(null)).toBeNull();
  expect(() => parseTaskModels({ dance: { model: "opus", effort: "low" } })).toThrow("not a task kind");
  expect(() => parseTaskModels({ build: { model: "gpt", effort: "low" } })).toThrow("not a model name");
  expect(() => parseTaskModels({ build: { model: "opus", effort: "huge" } })).toThrow("not an effort level");
  expect(() => parseTaskModels([])).toThrow();
});

test("the main ticket's rules list this board's table, not fixed text", () => {
  expect(taskModelsText()).toBe("explore, with_you: sonnet at medium; build, fix, test: opus at medium; review: fable at high; group, round: sonnet at low");
  const rules = mainTicketRules({ kind: "main", repo: "local", branch: null, inPlace: true, taskModels: { explore: { model: "haiku", effort: "low" } } });
  expect(rules).toContain("explore: haiku at low");
  expect(rules).not.toContain("Sonnet 5.5");
  expect(mainTicketRules({ kind: "main", repo: "local", branch: null, inPlace: true })).toContain("review: fable at high");
});

test("aliases reach claude --model as they are", () => {
  const args = buildArgs("s1", false, "fable");
  expect(args[args.indexOf("--model") + 1]).toBe("fable");
});

test("labels name the version an alias means: built-in table, then what runs report", () => {
  expect(pickerLabel("fable")).toBe("Fable (5.2)");
  expect(pickerLabel("claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(aliasLabel("opus[1m]")).toBe("Opus 5.5");
  expect(aliasLabel("fable")).toBe("Fable 5.2");
  expect(aliasLabel("claude-sonnet-5-5")).toBeNull(); // pinned ids keep their own label
  expect(modelName("haiku")).toBe("Haiku 5.5");
  expect(modelName("claude-sonnet-4-5")).toBe("Sonnet 4.5");
  setLearnedVersions({ fable: "5.3" });
  expect(pickerLabel("fable")).toBe("Fable (5.3)");
  expect(modelName("fable")).toBe("Fable 5.3");
});

test("the board learns versions from runs' init events, keeps the newest and saves them", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ck-mv-")), "model-versions.json");
  useModelVersionsFile(file);
  expect(familyVersion("claude-fable-5-2[1m]")).toEqual(["fable", "5.2"]);
  expect(familyVersion("claude-haiku-4-5-20251001")).toEqual(["haiku", "4.5"]);
  expect(familyVersion("sonnet")).toBeNull();
  learnModel({ type: "system", subtype: "init", model: "claude-fable-5-3" });
  learnModel({ type: "system", subtype: "init", model: "claude-sonnet-5-6" });
  learnModel({ type: "system", subtype: "init", model: "claude-sonnet-5-7" });
  learnModel({ type: "system", subtype: "init", model: "claude-sonnet-5-6" }); // an older pinned run doesn't go back
  learnModel({ type: "assistant", model: "claude-opus-9-9" }); // only init events count
  expect(learnedVersions()).toEqual({ fable: "5.3", sonnet: "5.7" });
  expect(JSON.parse(readFileSync(file, "utf8")).versions).toEqual({ fable: "5.3", sonnet: "5.7" });
  useModelVersionsFile(file); // after a restart
  expect(learnedVersions()).toEqual({ fable: "5.3", sonnet: "5.7" });
});

test("a run on an old pinned id never lowers a family's label below the built-in version", () => {
  useModelVersionsFile(join(mkdtempSync(join(tmpdir(), "ck-mv-")), "model-versions.json"));
  learnModel({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" });
  learnModel({ type: "system", subtype: "init", model: "claude-fable-5-2" }); // same as built in: nothing to learn
  expect(learnedVersions()).toEqual({});
  setLearnedVersions(learnedVersions()); // what the page gets from the board
  expect(pickerLabel("haiku")).toBe(`Haiku (${KNOWN_VERSIONS.haiku})`);
  expect(pickerLabel("haiku")).not.toContain("4.5");
});
