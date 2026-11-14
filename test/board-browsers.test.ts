import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardBrowsers, chromeArgs, hasDataDir, nameFromId, parseListeners, LOOPBACK } from "../src/server/board-browsers";
import { parsePortFile, portMatches } from "../src/server/cdp";
import { FakeChrome, fakes, harness } from "./fake-chrome";
import { tempDir } from "./helpers";

afterEach(() => {
  for (const f of fakes.splice(0)) if (!f.closed) f.quit();
});


test("startup adopts existing folders as board browsers, keeps their contents, and makes them private", async () => {
  const root = tempDir("ck-bb-");
  const dir = join(root, "browsers", "fatt-interior-whatsapp");
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cookies"), "logins");
  mkdirSync(join(root, "browsers", "personal-whatsapp"), { recursive: true });
  mkdirSync(join(root, "browsers", "Bad Name"), { recursive: true });
  const bb = new BoardBrowsers(root, () => {}, harness(root).deps);
  await bb.init();
  const v = bb.view().browsers;
  expect(v.map((b) => [b.id, b.name, b.signIn, b.state, b.startUrl])).toEqual([
    ["fatt-interior-whatsapp", "Fatt Interior WhatsApp", "Signed in", "stopped", "https://web.whatsapp.com/"],
    ["personal-whatsapp", "Personal WhatsApp", "Needs sign-in", "stopped", "https://web.whatsapp.com/"],
  ]);
  expect(readFileSync(join(dir, "Default", "Cookies"), "utf8")).toBe("logins");
  expect(statSync(join(root, "browsers")).mode & 0o777).toBe(0o700);
  // Saved: a new instance reads the same list.
  expect(new BoardBrowsers(root).view().browsers.map((b) => b.id)).toEqual(["fatt-interior-whatsapp", "personal-whatsapp"]);
});

test("ensure starts Chrome hidden with its own folder and a normal user agent, after dropping a stale port file", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const b = await bb.add("Shop WhatsApp");
  expect(b.id).toBe("shop-whatsapp");
  expect(statSync(bb.folder(b.id)).mode & 0o777).toBe(0o700);
  writeFileSync(join(bb.folder(b.id), "DevToolsActivePort"), "9\n/devtools/browser/old-old-old-old");
  const port = await bb.ensure(b.id);
  const argv = h.spawned[0];
  expect(argv).toContain(`--user-data-dir=${bb.folder(b.id)}`);
  expect(argv).toContain("--remote-debugging-port=0");
  expect(argv).toContain("--headless=new");
  expect(argv.some((a) => a.includes("enable-automation"))).toBe(false);
  const ua = argv.find((a) => a.startsWith("--user-agent="))!;
  expect(ua).toContain("Chrome/157.0.0.0");
  expect(ua).not.toContain("Headless");
  expect(port).toBe(h.byPid.get(1001)!.port);
  expect(bb.view().browsers[0].state).toBe("hidden");
  // Already running: no second Chrome.
  expect(await bb.ensure(b.id)).toBe(port);
  expect(h.spawned.length).toBe(1);
});

test("a stale or foreign port is never trusted: a dead port, another Chrome's path, or a port not bound to this Mac", async () => {
  const other = new FakeChrome(5);
  fakes.push(other);
  // Port file whose port answers, but as another Chrome (different uuid).
  expect(await portMatches({ port: other.port, path: "/devtools/browser/aaaaaaaa-0000" })).toBe(false);
  expect(await portMatches({ port: other.port, path: other.path })).toBe(true);
  other.quit();
  expect(await portMatches({ port: other.port, path: other.path })).toBe(false);
  expect(parsePortFile("0\n/devtools/browser/x")).toBeNull();
  expect(parsePortFile("9222\n/devtools/browser/0b1c2d3e-aaaa")).toEqual({ port: 9222, path: "/devtools/browser/0b1c2d3e-aaaa" });
  // lsof: listeners must be loopback only, and the process must be Chrome on this exact folder.
  const l = parseListeners("p123\nf5\nn127.0.0.1:9222\n", 9222);
  expect(l).toEqual({ pids: [123], addrs: ["127.0.0.1:9222"] });
  expect(l.addrs.every(LOOPBACK)).toBe(true);
  expect(["*:9222", "192.168.1.5:9222"].some(LOOPBACK)).toBe(false);
  expect(hasDataDir("Google Chrome --user-data-dir=/u/.claude-kanban/browsers/a --no-first-run", "/u/.claude-kanban/browsers/a")).toBe(true);
  expect(hasDataDir("Google Chrome --user-data-dir=/u/.claude-kanban/browsers/ab", "/u/.claude-kanban/browsers/a")).toBe(false);

  // Startup: a port file left by a Chrome that is gone, or answered by something else, is not adopted or closed.
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const foreign = new FakeChrome(77);
  fakes.push(foreign);
  mkdirSync(join(root, "browsers", "work"), { recursive: true });
  writeFileSync(join(root, "browsers", "work", "DevToolsActivePort"), `${foreign.port}\n${foreign.path}`);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  await bb.init();
  expect(bb.view().browsers[0].state).toBe("stopped");
  expect(bb.view().browsers[0].error).toContain("can't use it");
  expect(await bb.close("work")).toBe(false);
  expect(foreign.closeCalls).toBe(0);
});

test("close asks Chrome to quit over its port and waits; a site was open so the logins count as saved", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const b = await bb.add("Mail");
  await bb.ensure(b.id);
  const f = h.byPid.get(1001)!;
  f.pages = [{ id: "p1", type: "page", title: "Inbox", url: "https://www.mail.example.com/inbox" }];
  await bb.tick();
  expect(bb.view().browsers[0].lastSite?.site).toBe("mail.example.com");
  expect(bb.view().browsers[0].signIn).toBe("Needs sign-in");
  expect(await bb.close(b.id)).toBe(true);
  expect(f.closeCalls).toBe(1);
  expect(f.closed).toBe(true);
  const v = bb.view().browsers[0];
  expect([v.state, v.signIn]).toEqual(["stopped", "Signed in"]);
});

test("a Chrome that won't quit is never killed: close reports it and leaves it running", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root, { quit: false, closeTimeoutMs: 50 });
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const b = await bb.add("Slow");
  await bb.ensure(b.id);
  expect(await bb.close(b.id)).toBe(false);
  expect(h.byPid.get(1001)!.closed).toBe(false);
  expect(bb.view().browsers[0].error).toContain("taking long to close");
});

test("a run's lease keeps a hidden browser open; once released it closes after the idle time, unless keep running", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, { ...h.deps, idleMs: 60_000 });
  const a = await bb.add("A");
  const got = await bb.acquire("kanban/t_1", [a.id, "missing"]);
  expect(got.get(a.id)?.ok).toBe(true);
  expect(got.get("missing")).toEqual({ ok: false, why: "it was removed from More, Browsers" });
  expect(bb.view().browsers[0].inUse).toBe(1);
  h.advance(120_000);
  await bb.tick();
  expect(bb.view().browsers[0].state).toBe("hidden");
  bb.release("kanban/t_1");
  h.advance(30_000);
  await bb.tick();
  expect(bb.view().browsers[0].state).toBe("hidden");
  h.advance(40_000);
  await bb.tick();
  await bb.close(a.id); // waits for the tick's close
  expect(bb.view().browsers[0].state).toBe("stopped");
  expect(h.byPid.get(1001)!.closeCalls).toBe(1);

  // Keep running: started now, never closed when idle, started again when it dies.
  bb.update(a.id, { keepRunning: true });
  await bb.ensure(a.id);
  h.advance(10 * 60_000);
  await bb.tick();
  expect(bb.view().browsers[0].state).toBe("hidden");
  const second = h.byPid.get(1002)!;
  second.quit(); // crashed
  await bb.tick();
  await bb.ensure(a.id);
  expect(h.spawned.length).toBe(3);
  expect(h.spawned[2]).toContain("about:blank");
});

test("Open window while a run uses the hidden browser waits for the run, then restarts it visible", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const a = await bb.add("Shop");
  await bb.acquire("kanban/t_1", [a.id]);
  const r = await bb.openWindow(a.id, "web.whatsapp.com");
  expect(r.opened).toBe(false);
  expect(r.message).toContain("once the task is done");
  expect(bb.view().browsers[0].windowPending).toBe(true);
  expect(h.byPid.get(1001)!.closeCalls).toBe(0);
  bb.release("kanban/t_1");
  await bb.ensure(a.id); // after the queued switch
  expect(h.byPid.get(1001)!.closeCalls).toBe(1);
  const argv = h.spawned[1];
  expect(argv).not.toContain("--headless=new");
  expect(bb.view().browsers[0].state).toBe("visible");
  expect(bb.view().browsers[0].windowPending).toBe(false);
});

test("a visible browser whose window was closed goes back to hidden when it keeps running", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const a = await bb.add("Desk");
  bb.update(a.id, { keepRunning: true, startUrl: "web.whatsapp.com" });
  await bb.ensure(a.id);
  expect(h.spawned[0]).toContain("https://web.whatsapp.com/");
  expect((await bb.openWindow(a.id)).opened).toBe(true);
  expect(bb.view().browsers[0].state).toBe("visible");
  h.byPid.get(1002)!.pages = [];
  await bb.tick();
  await bb.tick();
  await bb.ensure(a.id);
  expect(bb.view().browsers[0].state).toBe("hidden");
  expect(h.byPid.get(1002)!.closeCalls).toBe(1);
});

test("remove refuses while in use and deletes only the browser's own folder", async () => {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const bb = new BoardBrowsers(root, () => {}, h.deps);
  const a = await bb.add("Old");
  writeFileSync(join(root, "keep.txt"), "x");
  await bb.acquire("kanban/t_1", [a.id]);
  await expect(bb.remove(a.id)).rejects.toThrow("using this browser");
  bb.release("kanban/t_1");
  expect(() => bb.folder("../keep.txt")).toThrow();
  expect(() => bb.folder("..")).toThrow();
  await expect(bb.remove("../x")).rejects.toThrow();
  await bb.remove(a.id);
  expect(h.byPid.get(1001)!.closeCalls).toBe(1);
  expect(existsSync(join(root, "browsers", a.id))).toBe(false);
  expect(existsSync(join(root, "keep.txt"))).toBe(true);
  expect(bb.view().browsers).toEqual([]);

  // A browser folder that is a link: only the link goes, never what it points at.
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "x"), "1");
  symlinkSync(outside, join(root, "browsers", "linked"));
  const bb2 = new BoardBrowsers(root, () => {}, h.deps);
  await bb2.init();
  // A link is not a folder: never adopted.
  expect(bb2.view().browsers).toEqual([]);
  expect(existsSync(join(outside, "x"))).toBe(true);
});

test("without Google Chrome, adding or starting says so in plain words and nothing else breaks", async () => {
  const root = tempDir("ck-bb-");
  mkdirSync(join(root, "browsers", "personal-whatsapp"), { recursive: true });
  const bb = new BoardBrowsers(root, () => {}, { ...harness(root).deps, chromeBin: () => null });
  await bb.init();
  expect(bb.view().chrome.installed).toBe(false);
  expect(bb.view().chrome.message).toContain("google.com/chrome");
  await expect(bb.add("New")).rejects.toThrow("Google Chrome");
  const got = await bb.acquire("kanban/t_1", ["personal-whatsapp"]);
  expect(got.get("personal-whatsapp")).toEqual({ ok: false, why: expect.stringContaining("Google Chrome isn't installed") });
});

test("names and argv helpers", () => {
  expect(nameFromId("fatt-interior-whatsapp")).toBe("Fatt Interior WhatsApp");
  expect(chromeArgs("/c", "/d", "visible", "157", null)).toEqual(["/c", "--user-data-dir=/d", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"]);
});
