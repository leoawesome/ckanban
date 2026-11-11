import { expect, test } from "bun:test";
import { modelLabel, resolveRun, runText } from "../web/src/models";

const board = { model: "opus", mainModel: "sonnet", effort: "medium", ultracode: false };

test("a ticket's own model and effort win", () => {
  expect(resolveRun({ model: "haiku", effort: "high", main: true }, board)).toEqual({ model: "haiku", effort: "high", ultracode: false });
});

test("a main ticket without its own model uses the board's Main ticket model", () => {
  expect(resolveRun({ main: true }, board)).toEqual({ model: "sonnet", effort: "medium", ultracode: false });
});

test("a tool ticket shows its kind's model (written on it when made), else the board's, never the Main ticket model", () => {
  expect(resolveRun({ model: "opus", effort: "medium" }, { ...board, model: "haiku" }).model).toBe("opus");
  expect(resolveRun({}, board)).toEqual({ model: "opus", effort: "medium", ultracode: false });
});

test("no board model or effort: Claude Code's own defaults, else null", () => {
  expect(resolveRun({ main: true }, {}, { model: "fable", effort: "xhigh" })).toEqual({ model: "fable", effort: "xhigh", ultracode: false });
  expect(resolveRun({ effort: "low" }, { model: "opus" }, { model: "fable", effort: "xhigh" })).toEqual({ model: "opus", effort: "low", ultracode: false });
  expect(resolveRun({}, null)).toEqual({ model: null, effort: null, ultracode: false });
  expect(modelLabel(null)).toBe("Default model");
});

test("ultracode saved as the effort reads as xhigh with ultracode on; the ticket's switch wins", () => {
  expect(resolveRun({ effort: "ultracode" }, board)).toEqual({ model: "opus", effort: "xhigh", ultracode: true });
  expect(resolveRun({}, { effort: "ultracode" })).toEqual({ model: null, effort: "xhigh", ultracode: true });
  expect(resolveRun({ effort: "ultracode", ultracode: false }, board).ultracode).toBe(false);
  expect(resolveRun({ effort: "low" }, { effort: "ultracode" })).toEqual({ model: null, effort: "low", ultracode: true });
});

test("row text", () => {
  expect(runText({ model: "sonnet", effort: "medium", ultracode: false })).toBe("Sonnet 5.5 · medium");
  expect(runText({ model: "fable", effort: "xhigh", ultracode: true })).toBe("Fable 5.2 · xhigh · ultracode");
  expect(runText({ model: null, effort: null, ultracode: false })).toBe("Default model · default effort");
});
