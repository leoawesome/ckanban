// Squad helpers in the web UI: the topic box's text, the people chips, the card's lines.
import { expect, test } from "bun:test";
import { isNameTaken, personChips, squadSavedText, squadSummary, ticketTopicText, TOPIC_MAX } from "../web/src/squadText";

test("the topic box starts with the ticket's title and the start of its description", () => {
  expect(ticketTopicText({ title: " Fix login ", body: "" })).toBe("Fix login");
  expect(ticketTopicText({ title: "Fix login", body: "Users get logged out.\n" })).toBe("Fix login\n\nUsers get logged out.");
  const long = ticketTopicText({ title: "T", body: "x".repeat(900) });
  expect(long).toBe(`T\n\n${"x".repeat(600)}…`);
  expect(ticketTopicText({ title: "y".repeat(3000) }).length).toBe(TOPIC_MAX);
});

test("people chips mark the host and the people saved as new teammates", () => {
  const roster = [
    { preset: "facilitator", host: true },
    { role: "Visionary", handle: "visionary", mode: "monitor" as const, model: "opus" },
    { role: "Skeptic", count: 2 },
  ];
  const fresh = [{ index: 1, name: "visionary" }, { index: 2, name: "skeptic" }];
  const chips = personChips(roster, fresh, null);
  expect(chips.map((c) => [c.handle, c.host, c.isNew, c.extra])).toEqual([
    ["facilitator", true, false, ""],
    ["visionary", false, true, "reads everything · opus"],
    ["skeptic", false, true, "×2"],
  ]);
  // The board already has a skeptic: it is used as is, not new.
  expect(personChips(roster, fresh, new Set(["facilitator", "skeptic"])).map((c) => c.isNew)).toEqual([false, true, false]);
});

test("card lines", () => {
  expect(squadSummary({ description: "Voices debate a plan", maxCostUsd: 60, rounds: null })).toBe("Voices debate a plan. Budget $60.");
  expect(squadSummary({ description: "", maxCostUsd: null, rounds: 2 })).toBe("2 rounds.");
  expect(squadSavedText("Product debate", "board", { created: ["visionary"], reused: [] })).toBe("Product debate · this board · new teammate @visionary");
  expect(squadSavedText("Product debate", "global")).toBe("Product debate · all boards");
  expect(isNameTaken('a squad named "x" already exists (X); rename this one, or save with replace to change that one')).toBe(true);
  expect(isNameTaken("roster is empty")).toBe(false);
});
