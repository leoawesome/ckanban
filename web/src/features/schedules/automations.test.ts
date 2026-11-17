import { expect, test } from "bun:test";
import type { Pass } from "./automationTypes";
import { boardCell, everyLabel, groupLastItems, loopStatus, loopSubtitle, resolveProposedPass, saveBlocker } from "./automations";

const pass = (p: Partial<Pass>): Pass => ({
  id: "p1", kind: "mcp", name: "linear", claudeName: null, url: null, envName: null, status: "connected", error: null, createdAt: "", usedBy: 0, ...p,
});

test("the Board column: ✓ for a linked pass, Connect for your own servers, a dash for claude.ai and project servers", () => {
  const server = (name: string, scope: any, transport: any = "http") => ({ name, scope, transport });
  expect(boardCell(server("linear", "user"), [pass({ claudeName: "linear" })])).toMatchObject({ kind: "ok" });
  expect(boardCell(server("linear", "user"), [])).toEqual({ kind: "connect", pass: null, how: "mcp" });
  expect(boardCell(server("cloudwatch", "local", "stdio"), [])).toEqual({ kind: "connect", pass: null, how: "local" });
  expect(boardCell(server("linear", "user"), [pass({ claudeName: "linear", status: "needs_reconnect" })])).toMatchObject({ kind: "connect", how: "mcp" });
  expect(boardCell(server("claude.ai Gmail", "claude.ai"), [])).toMatchObject({ kind: "none" });
  expect(boardCell(server("planted", "project", "stdio"), [])).toMatchObject({ kind: "none" });
  // No name matching: a pass named like a server isn't its board pass unless it was made from that row.
  expect(boardCell(server("linear", "user"), [pass({ name: "linear", claudeName: null })])).toMatchObject({ kind: "connect", pass: null });
});

test("a proposed connection is matched to a pass, or says what the card must still do", () => {
  const passes = [pass({ id: "a", claudeName: "linear" }), pass({ id: "b", kind: "key", name: "Jira", envName: "JIRA_KEY", status: "connected" })];
  expect(resolveProposedPass({ name: "Linear", from: "linear" }, passes)).toMatchObject({ pass: { id: "a" }, need: null });
  expect(resolveProposedPass({ name: "Jira", envName: "JIRA_KEY" }, passes)).toMatchObject({ pass: { id: "b" }, need: null });
  expect(resolveProposedPass({ name: "Sentry", from: "sentry" }, passes)).toEqual({ pass: null, need: "connect" });
  expect(resolveProposedPass({ name: "Tracker", url: "https://mcp.tracker/mcp" }, passes)).toEqual({ pass: null, need: "connect" });
  expect(resolveProposedPass({ name: "Shop", envName: "SHOP_KEY" }, passes)).toEqual({ pass: null, need: "key" });
  expect(resolveProposedPass({ name: "Mystery" }, passes)).toEqual({ pass: null, need: "missing" });
});

test("list labels say whether it runs, and why not", () => {
  const base = { enabled: true, state: "ok" as const, lastError: null, lastCheckedAt: null, everyMinutes: 15, problems: [] };
  expect(loopStatus(base)).toEqual({ label: "On", tone: "ok" });
  expect(loopStatus({ ...base, enabled: false })).toEqual({ label: "Off", tone: "stopped" });
  expect(loopStatus({ ...base, state: "script_changed" })).toEqual({ label: "Review script", tone: "blocked" });
  expect(loopSubtitle(base, () => "x")).toBe("every 15 min · not checked yet");
  expect(loopSubtitle({ ...base, state: "needs_connection", problems: ["Linear needs to be connected again (Connections)."] }, () => "x")).toBe("Linear needs to be connected again (Connections).");
  expect(everyLabel(60)).toBe("hour");
  expect(everyLabel(120)).toBe("2 hours");
});

test("Save says why it is greyed out: a name, a script, and the start-by-itself box for Planning and Ready", () => {
  const ok = { name: "Linear", script: "echo", column: "backlog" as const, autoStart: false };
  expect(saveBlocker(ok)).toBeNull();
  expect(saveBlocker({ ...ok, name: "  " })).toContain("name");
  expect(saveBlocker({ ...ok, script: "" })).toContain("check script");
  expect(saveBlocker({ ...ok, column: "ready" })).toContain("Let Claude start by itself");
  expect(saveBlocker({ ...ok, column: "planning", autoStart: true })).toBeNull();
});

test("the Last check tab lists new and skipped items and folds the ones that were already there", () => {
  const item = (id: string, state: "new" | "skipped" | "seen" | "first") => ({ id, title: id, state });
  const g = groupLastItems([item("a", "first"), item("b", "new"), item("c", "seen"), item("d", "skipped"), item("e", "first")]);
  expect(g.shown.map((i) => i.id)).toEqual(["b", "d"]);
  expect(g.first.map((i) => i.id)).toEqual(["a", "e"]);
  expect(g.seen.map((i) => i.id)).toEqual(["c"]);
});
