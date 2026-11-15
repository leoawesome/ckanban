import { expect, test } from "bun:test";
import {
  closePanel, loadPanels, MIGRATED_KEY, migrateOldPanels, movePanel, NO_PANELS, openPanel, panelsKey, parsePanels, resizePair,
  toggleColumn, toggleFold, togglePanel, whereHint, type PanelsState,
} from "../web/src/panelState";

const mem = (o: Record<string, string> = {}) => {
  const data = new Map(Object.entries(o));
  return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v), remove: (k: string) => void data.delete(k) };
};

test("openPanel adds at the bottom, unfolds and shows the column; closePanel hides it with the last panel", () => {
  let s = openPanel(NO_PANELS, "terminal");
  s = openPanel(s, "changes");
  expect(s.open).toEqual(["terminal", "changes"]);
  expect(s.shown).toBe(true);
  s = toggleFold(s, "terminal");
  expect(s.folded).toEqual(["terminal"]);
  s = openPanel(s, "terminal");
  expect(s.open).toEqual(["terminal", "changes"]);
  expect(s.folded).toEqual([]);
  s = closePanel(s, "terminal");
  expect(s.open).toEqual(["changes"]);
  expect(s.shown).toBe(true);
  s = togglePanel(s, "changes");
  expect(s).toMatchObject({ open: [], shown: false });
});

test("toggleColumn hides and shows the column, never an empty one", () => {
  const s = openPanel(NO_PANELS, "files");
  expect(toggleColumn(s).shown).toBe(false);
  expect(toggleColumn(toggleColumn(s)).shown).toBe(true);
  expect(toggleColumn(NO_PANELS).shown).toBe(false);
});

test("movePanel swaps with its neighbour and stops at the ends", () => {
  const s: PanelsState = { ...NO_PANELS, open: ["terminal", "files", "team"], shown: true };
  expect(movePanel(s, "files", -1).open).toEqual(["files", "terminal", "team"]);
  expect(movePanel(s, "files", 1).open).toEqual(["terminal", "team", "files"]);
  expect(movePanel(s, "terminal", -1)).toBe(s);
  expect(movePanel(s, "team", 1)).toBe(s);
});

test("resizePair shares the two panels' height and keeps both above the minimum", () => {
  // Two equal panels, 200px each: dragging 100px down gives the upper one 300px.
  const [a, b] = resizePair(1, 1, 200, 200, 100, 80);
  expect(a).toBeCloseTo(1.5);
  expect(b).toBeCloseTo(0.5);
  expect(a + b).toBeCloseTo(2);
  // Dragging past the minimum stops there.
  const [c, d] = resizePair(1, 1, 200, 200, 1000, 80);
  expect(d * 200).toBeCloseTo(80);
  expect(c + d).toBeCloseTo(2);
  expect(resizePair(1, 1, 0, 0, 10, 80)).toEqual([1, 1]);
});

test("parsePanels keeps known panels once and drops broken values", () => {
  expect(parsePanels(null)).toBeNull();
  expect(parsePanels("{oops")).toBeNull();
  expect(parsePanels(JSON.stringify({ open: ["terminal", "browser", "terminal", "team"], shown: true, folded: ["team", "files"], shares: { terminal: 2, team: -1, x: 3 }, width: 500 })))
    .toEqual({ open: ["terminal", "team"], shown: true, folded: ["team"], shares: { terminal: 2 }, width: 500 });
  expect(parsePanels(JSON.stringify({ open: [], shown: true, width: "wide" }))).toEqual({ ...NO_PANELS });
});

test("migrateOldPanels: a bottom panel open on an item and an open side chat open those panels", () => {
  expect(migrateOldPanels(mem().get)).toBeNull();
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "1", "ckanban.dock.tab": "files" }).get)).toMatchObject({ open: ["files"], shown: true });
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "1", "ckanban.dock.tab": "huddles" }).get)?.open).toEqual(["team"]);
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "1", "ckanban.dock.tab": "claude" }).get)?.open).toEqual(["claude"]);
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "1" }).get)?.open).toEqual(["terminal"]);
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "0", "ckanban.dock.tab": "files" }).get)).toBeNull();
  expect(migrateOldPanels(mem({ "ckanban.dock.open": "1", "ckanban.dock.tab": "team", "ckanban.sideChat.open": "1", "ckanban.sideChat.width": "520" }).get))
    .toEqual({ ...NO_PANELS, open: ["team", "claude"], shown: true, width: 520 });
  // A closed chat's width still carries over.
  expect(migrateOldPanels(mem({ "ckanban.sideChat.open": "0", "ckanban.sideChat.width": "500" }).get)).toEqual({ ...NO_PANELS, width: 500 });
});

test("loadPanels moves the old state over once, to the first board, and removes the old keys", () => {
  const s = mem({ "ckanban.dock.open": "1", "ckanban.dock.tab": "terminal", "ckanban.dock.height.terminal": "300", "ckanban.sideChat.open": "1" });
  expect(loadPanels(s, "a")).toMatchObject({ open: ["terminal", "claude"], shown: true });
  expect(s.get(MIGRATED_KEY)).toBe("1");
  expect([...s.data.keys()].filter((k) => k.startsWith("ckanban.dock") || k.startsWith("ckanban.sideChat"))).toEqual([]);
  expect(parsePanels(s.get(panelsKey("a")))?.open).toEqual(["terminal", "claude"]);
  // Other boards start empty; the first keeps its own.
  expect(loadPanels(s, "b")).toEqual(NO_PANELS);
  expect(loadPanels(s, "a").open).toEqual(["terminal", "claude"]);
  // A board that already has panels keeps them over the old state.
  const t = mem({ [panelsKey("a")]: JSON.stringify({ open: ["files"], shown: true }), "ckanban.sideChat.open": "1" });
  expect(loadPanels(t, "a").open).toEqual(["files"]);
  expect(t.get("ckanban.sideChat.open")).toBeNull();
});

test("whereHint names the folder a panel works in", () => {
  expect(whereHint("terminal", null)).toBe("board folder");
  expect(whereHint("files", { worktree: "/w" })).toBe("ticket copy");
  expect(whereHint("files", { worktree: null })).toBe("board folder");
  expect(whereHint("changes", null)).toBe("");
  expect(whereHint("team", { worktree: "/w" })).toBe("");
});
