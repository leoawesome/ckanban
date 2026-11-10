// The board's side of sub-features and "Show on board": which cards show (onBoard via searchBoard), the card's
// "Part of" / "Task of" chips, the working line's "· N sub-features running", and the Part of hover texts.
import { expect, test } from "bun:test";
import { familyLineText, partChip } from "../web/src/cardState";
import { linkHints } from "../web/src/linkHints";
import { groupByColumn } from "../web/src/columns";
import { searchBoard } from "../web/src/toolTickets";

const tk = (id: string, x: Record<string, unknown> = {}) => ({ id, title: id, body: "", status: "review", createdAt: `2026-11-10T10:0${id.length}:00Z`, updatedAt: "2026-11-10T10:00:00Z", ...x });

const board = () => [
  tk("M", { title: "AI Outreach", main: true }),
  tk("S", { title: "Review my Linear mentions", main: true, partOf: "M" }),
  tk("ST", { title: "Linear task", tool: true, partOf: "S" }),
  tk("T1", { title: "Draft follow-up emails", tool: true, partOf: "M", showOnBoard: true }),
  tk("T2", { title: "Check reply rates", tool: true, partOf: "M" }),
];

test("a task shown on the board is a card like any other; hidden tasks are not", () => {
  const { shown, via } = searchBoard(board() as any[], () => true);
  expect(shown.map((t) => t.id).sort()).toEqual(["M", "S", "T1"]);
  expect(via.size).toBe(0);
  expect(groupByColumn(shown as any).get("review")!.length).toBe(3);
});

test("search: a shown task matches as itself, a hidden one through its main card", () => {
  const all = board() as any[];
  const r = searchBoard(all, (t) => t.title.includes("Draft"), () => true, true);
  expect(r.shown.map((t) => t.id)).toEqual(["T1"]);
  expect(r.via.size).toBe(0);
  const r2 = searchBoard(all, (t) => t.title.includes("reply rates"), () => true, true);
  expect(r2.shown.map((t) => t.id)).toEqual(["M"]);
  expect(r2.via.get("M")).toBe("Check reply rates");
  // A sub-feature's hidden task leads to the sub-feature's card, not the parent's.
  const r3 = searchBoard(all, (t) => t.title === "Linear task", () => true, true);
  expect(r3.shown.map((t) => t.id)).toEqual(["S"]);
  // Filters treat a shown task like any card.
  const r4 = searchBoard(all, () => true, (t) => !!t.tool);
  expect(r4.shown.map((t) => t.id)).toEqual(["T1"]);
});

test("turning Show on board off hides the card again", () => {
  const all = board().map((t) => (t.id === "T1" ? { ...t, showOnBoard: false } : t)) as any[];
  expect(searchBoard(all, () => true).shown.map((t) => t.id).sort()).toEqual(["M", "S"]);
});

test("card chips: Part of on a sub-feature, Task of with its note on a shown task", () => {
  expect(partChip({ main: true, subFeatureOf: { id: "M", title: "AI Outreach" } })).toEqual({ kind: "sub", text: "Part of AI Outreach", parent: { id: "M", title: "AI Outreach" } });
  expect(partChip({ tool: true, showOnBoard: true, mainTicket: { id: "M", title: "AI Outreach" } })).toEqual({
    kind: "task", text: "Task of AI Outreach", parent: { id: "M", title: "AI Outreach" }, note: "Shown on board · questions go to AI Outreach",
  });
  expect(partChip({ tool: true, mainTicket: { id: "M", title: "AI Outreach" } })).toBeNull();
  expect(partChip({ main: true })).toBeNull();
});

test("working line adds the sub-features running", () => {
  const line = { text: "Draft follow-up emails", tone: "work" };
  expect(familyLineText(line, { running: ["a"], working: ["a", "b"] })).toBe("Draft follow-up emails");
  expect(familyLineText(line, { running: ["a"], working: ["a", "S"], subFeaturesRunning: 1 })).toBe("Draft follow-up emails · 1 sub-feature running");
  // Only sub-features work: the line says so instead of naming one.
  expect(familyLineText({ text: "S", tone: "work" }, { running: [], working: ["S", "S2"], subFeaturesRunning: 2 })).toBe("2 sub-features running");
  // A step waiting on the user keeps its words.
  expect(familyLineText({ text: "Login test needs you", tone: "warn" }, { running: [], working: ["S"], subFeaturesRunning: 1 })).toBe("Login test needs you · 1 sub-feature running");
});

test("Part of hover texts say what will happen, in plain words", () => {
  expect(linkHints({ main: true }, "linked", 13).unlink).toBe("Stays its own work on the board, with its 13 tasks");
  expect(linkHints({ tool: true }, "linked", 0).unlink).toBe("Becomes its own work on the board");
  expect(linkHints({ tool: true }, "plan", 0).unlink).toContain("out of that ticket's plan");
  expect(linkHints({ main: true }, null, 1).link).toContain("sub-feature");
  for (const h of [linkHints({ main: true }, "linked", 2), linkHints({ tool: true }, "chat", 0), linkHints({}, null, 0)]) {
    for (const s of Object.values(h)) expect(s).not.toMatch(/tool ticket|main ticket|\btree\b|worktree/i);
  }
});
