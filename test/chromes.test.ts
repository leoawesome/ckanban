import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ASK_CHROME, ChromeWatch, Chromes, chromeSetting, resolveChromeSetting } from "../src/server/chromes";
import { chromeChoiceNote } from "../src/server/prompts";
import { tempDir } from "./helpers";

const WORK = "d4a71199-fd4a-427d-a310-bee508a721c5";
const PERSONAL = "8e20160c-5cb5-4f7e-b037-33523d4791f8";

/** A real list_connected_browsers result, as Claude in Chrome returns it in the stream. */
const listResult = (inUse: string) => [
  { type: "text", text: JSON.stringify([
    { deviceId: WORK, name: "Browser 1", osPlatform: "macOS", connectedAt: 1, isLocal: true, ...(inUse === WORK ? { inUse: true } : {}) },
    { deviceId: PERSONAL, name: "Browser 2", osPlatform: "macOS", connectedAt: 2, isLocal: true, ...(inUse === PERSONAL ? { inUse: true } : {}) },
    { deviceId: "remote-1", name: "Browser 3", osPlatform: "Windows", connectedAt: 3, isLocal: false },
  ]) },
  { type: "text", text: "2 browsers are connected; ..." },
];
const use = (id: string, name: string, input: unknown = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__claude-in-chrome__${name}`, input }] } });
const result = (id: string, content: unknown) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

test("a run's list_connected_browsers result records the local Chromes; navigate gives the Chrome in use a hint", () => {
  const root = tempDir("ck-chrome-");
  const c = new Chromes(root);
  const w = new ChromeWatch(c);
  w.feed(use("1", "list_connected_browsers"));
  w.feed(result("1", listResult(PERSONAL)));
  expect(c.view().browsers.map((b) => [b.deviceId, b.label])).toEqual([[WORK, "Browser 1"], [PERSONAL, "Browser 2"]]);
  expect(c.view().connected).toEqual([WORK, PERSONAL]);
  w.feed(use("2", "navigate", { url: "https://www.x.com/home", tabId: 1 }));
  w.feed(result("2", [{ type: "text", text: "Navigated" }]));
  expect(c.get(PERSONAL)!.hint?.site).toBe("x.com");
  w.feed(use("3", "select_browser", { deviceId: WORK }));
  w.feed(result("3", [{ type: "text", text: 'Selected browser "Browser 1".' }]));
  w.feed(use("4", "navigate", { url: "mail.google.com" }));
  w.feed(result("4", [{ type: "text", text: "ok" }]));
  expect(c.get(WORK)!.hint?.site).toBe("mail.google.com");
  expect(existsSync(join(root, "browsers.json"))).toBe(true);
  // Names survive a reload and a reconnect that swaps the display names.
  c.rename(WORK, " Work ");
  const again = new Chromes(root);
  expect(again.get(WORK)!.name).toBe("Work");
  again.listed([{ deviceId: WORK, name: "Browser 2", isLocal: true }]);
  expect(again.get(WORK)).toMatchObject({ name: "Work", label: "Browser 2" });
  expect(again.view().connected).toEqual([WORK]);
});

test("names are unique and a setting must be a known Chrome or ask", () => {
  const c = new Chromes(tempDir("ck-chrome-"));
  c.listed([{ deviceId: WORK, name: "Browser 1" }, { deviceId: PERSONAL, name: "Browser 2" }]);
  c.rename(WORK, "Work");
  expect(() => c.rename(PERSONAL, "work")).toThrow("already named");
  const known = (id: string) => !!c.get(id);
  expect(chromeSetting(WORK, known)).toBe(WORK);
  expect(chromeSetting("ask", known)).toBe(ASK_CHROME);
  expect(chromeSetting(null, known)).toBeNull();
  expect(() => chromeSetting("nope", known)).toThrow();
});

test("a ticket's Chrome: its own, else the nearest ticket above it, else the board's", () => {
  const all = [
    { id: "main", chrome: WORK, parentId: null },
    { id: "tool", chrome: null, parentId: "main" },
    { id: "own", chrome: PERSONAL, parentId: "main" },
    { id: "plain", parentId: null },
  ];
  expect(resolveChromeSetting(all[1], all, PERSONAL)).toBe(WORK);
  expect(resolveChromeSetting(all[2], all, WORK)).toBe(PERSONAL);
  expect(resolveChromeSetting(all[3], all, PERSONAL)).toBe(PERSONAL);
  expect(resolveChromeSetting(all[3], all, null)).toBeNull();
  // A loop in the links never hangs.
  const loop = [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }];
  expect(resolveChromeSetting(loop[0], loop, "ask")).toBe("ask");
});

test("the prompt names the deviceId and the stop-and-ask rule; nothing chosen adds nothing", () => {
  const c = new Chromes(tempDir("ck-chrome-"));
  c.listed([{ deviceId: WORK, name: "Browser 1" }, { deviceId: PERSONAL, name: "Browser 2" }]);
  c.rename(WORK, "Work");
  c.rename(PERSONAL, "Personal");
  const note = chromeChoiceNote(c.choice(WORK))!;
  expect(note).toContain(`select_browser\` with deviceId \`${WORK}\` (named "Work")`);
  expect(note).toContain("list_connected_browsers");
  expect(note).toContain("Never use another Chrome");
  expect(note).toContain("once more");
  expect(note).toContain('stop and ask the user (end with status "questions"): say the Chrome named "Work" isn\'t connected');
  expect(note).toContain("Don't fall back to another Chrome");
  const ask = chromeChoiceNote(c.choice("ask"))!;
  expect(ask).toContain(`"Work" (deviceId \`${WORK}\`)`);
  expect(ask).toContain("If more than one is connected");
  expect(chromeChoiceNote(c.choice(null))).toBeNull();
  // A removed Chrome, or "ask" with nothing named: the old rule alone.
  expect(c.choice("gone")).toBeNull();
  expect(new Chromes(tempDir("ck-chrome-")).choice("ask")).toBeNull();
});
