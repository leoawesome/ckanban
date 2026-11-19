// Outside-in contract for board browsers (/api/board-browsers), named Chromes (/api/browsers) and shared devices
// (/api/devices, a ticket's /devices take and release). See contracts/api.md "Browsers and devices" and
// contracts/data-files.md (devices.json, browsers.json, board-browsers.json).
// No real Chrome ever starts: the daemon's Chrome is the stub from daemon.ts (it notes its arguments and exits), and
// "user only" requests come from user-browser.ts. The fake Claude runs in slow mode, so a run stays active until the
// test stops it (a run holds its devices while it runs, and a board browser from its tools' first call).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { asUser } from "./user-browser";

let d: Daemon;
const SLUG = "browsers";
const RUN = "x-ckanban-run";
const HUDDLE = "x-ckanban-huddle-agent";

// Two Chromes a run listed earlier (browsers.json, as data-files.md describes it). One id needs percent-encoding.
const SEEN = "2026-11-01T10:00:00.000Z";
const CHROMES = {
  browsers: [
    { deviceId: "dev-work-1", name: "Work", label: "Browser 1", osPlatform: "mac", firstSeenAt: SEEN, lastSeenAt: SEEN, hint: null },
    { deviceId: "dev:home.2", name: "", label: "Browser 2", firstSeenAt: SEEN, lastSeenAt: SEEN, hint: { site: "mail.google.com", at: SEEN } },
  ],
  listedAt: SEEN,
  connected: ["dev-work-1"],
};

beforeAll(async () => {
  d = await startDaemon({
    fakeMode: "slow",
    before: ({ home }) => writeFileSync(join(home, "browsers.json"), JSON.stringify(CHROMES, null, 2)),
  });
  expect((await d.api("POST", "/api/profiles", { name: "Browsers", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const user = (method: string, path: string, body?: unknown) => asUser(d.url, method, path, body);
const origin = () => ({ origin: d.url });
const readJson = (name: string) => JSON.parse(readFileSync(join(d.home, name), "utf8"));
const ticket = async (title: string) => (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title, body: "x" })).data.id as string;
const getTicket = async (id: string) => (await d.api("GET", `/api/profiles/${SLUG}/tickets/${id}`)).data;

/** Starts a run on the ticket (the fake Claude then sleeps) and waits until the board shows it running. */
async function startRun(id: string) {
  expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${id}/chat`, { text: "go" })).status).toBe(202);
  await until(async () => (await getTicket(id)).running === true, 15_000, "the run to start");
}
async function stopRun(id: string) {
  expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${id}/stop`, {})).status).toBe(200);
  await until(async () => (await getTicket(id)).running === false, 15_000, "the run to end");
}

function expectBrowsersView(v: any) {
  expect(Array.isArray(v.browsers)).toBe(true);
  expect(Array.isArray(v.connected)).toBe(true);
  expect(Array.isArray(v.boardBrowsers)).toBe(true);
  expect(v.chrome).toEqual({ installed: true, message: null });
  expect(v.boards).toContainEqual({ slug: SLUG, name: "Browsers", chrome: null, browsers: null });
}

describe("browsers view", () => {
  test("GET /api/board-browsers and GET /api/browsers answer the same view, with the Chromes runs listed", async () => {
    const a = await d.api("GET", "/api/board-browsers");
    const b = await d.api("GET", "/api/browsers");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.data).toEqual(b.data);
    expectBrowsersView(a.data);
    expect(a.data.browsers).toEqual(CHROMES.browsers);
    expect(a.data.listedAt).toBe(SEEN);
    expect(a.data.connected).toEqual(["dev-work-1"]);
    expect(a.data.boardBrowsers).toEqual([]);
    // Runs read it too.
    expect((await d.api("GET", "/api/board-browsers", undefined, { [RUN]: `${SLUG}/t_20260101_aaaa` })).status).toBe(200);
  });
});

describe("named Chromes (/api/browsers)", () => {
  test("rename saves the name in browsers.json; the id is percent-decoded", async () => {
    const r = await d.api("PATCH", `/api/browsers/${encodeURIComponent("dev:home.2")}`, { name: "  Home   one " });
    expect(r.status).toBe(200);
    expectBrowsersView(r.data);
    expect(r.data.browsers.find((x: any) => x.deviceId === "dev:home.2").name).toBe("Home one");
    expect(readJson("browsers.json").browsers.find((x: any) => x.deviceId === "dev:home.2").name).toBe("Home one");
  });

  test("bad names, duplicates, unknown Chromes and callers that aren't the user", async () => {
    const path = "/api/browsers/dev-work-1";
    expect((await d.api("PATCH", path, { name: 5 })).status).toBe(400);
    expect((await d.api("PATCH", path, {})).status).toBe(400);
    const dup = await d.api("PATCH", path, { name: "home ONE" });
    expect(dup.status).toBe(409);
    expect(typeof dup.data.error).toBe("string");
    expect((await d.api("PATCH", "/api/browsers/nope", { name: "X" })).status).toBe(404);
    expect((await d.api("DELETE", "/api/browsers/nope")).status).toBe(404);
    for (const h of [{ [RUN]: `${SLUG}/t_20260101_aaaa` }, { [HUDDLE]: "token" }] as Record<string, string>[]) {
      expect((await d.api("PATCH", path, { name: "Run" }, h)).status).toBe(403);
      expect((await d.api("DELETE", path, undefined, h)).status).toBe(403);
    }
    expect(readJson("browsers.json").browsers.find((x: any) => x.deviceId === "dev-work-1").name).toBe("Work");
  });

  test("DELETE forgets the Chrome", async () => {
    const r = await d.api("DELETE", `/api/browsers/${encodeURIComponent("dev:home.2")}`);
    expect(r.status).toBe(200);
    expectBrowsersView(r.data);
    expect(r.data.browsers.map((x: any) => x.deviceId)).toEqual(["dev-work-1"]);
    expect(readJson("browsers.json").browsers.map((x: any) => x.deviceId)).toEqual(["dev-work-1"]);
  });
});

describe("board browsers (/api/board-browsers)", () => {
  let id = "";

  test("changes are the user's only: no Origin, a plain program or a run gets 403", async () => {
    expect((await d.api("POST", "/api/board-browsers", { name: "Nope" })).status).toBe(403);
    const r = await d.api("POST", "/api/board-browsers", { name: "Nope" }, origin());
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/user/);
    expect((await d.api("POST", "/api/board-browsers", { name: "Nope" }, { ...origin(), [RUN]: `${SLUG}/t_20260101_aaaa` })).status).toBe(403);
    // Quirk: the check runs before the route is matched, so even a path that doesn't exist is 403 for a run.
    expect((await d.api("POST", "/api/board-browsers/x/no-such-action", {}, { [RUN]: `${SLUG}/t_20260101_aaaa` })).status).toBe(403);
    // Nothing was added, so nothing was saved.
    expect(existsSync(join(d.home, "board-browsers.json"))).toBe(false);
  });

  test("POST adds a browser with its own folder and saves board-browsers.json", async () => {
    const r = await user("POST", "/api/board-browsers", { name: "  Work   WhatsApp " });
    expect(r.status).toBe(200);
    expectBrowsersView(r.data);
    id = r.data.added;
    expect(id).toBe("work-whatsapp");
    const b = r.data.boardBrowsers.find((x: any) => x.id === id);
    expect(b).toMatchObject({
      id, name: "Work WhatsApp", lastUsedAt: null, lastSite: null, keepRunning: false, signedIn: false, startUrl: null, check: null,
      state: "stopped", signIn: "Not checked", signInSite: null, checkedAt: null, inUse: 0, windowPending: false, error: null,
      folder: join(d.home, "browsers", id),
    });
    expect(typeof b.createdAt).toBe("string");
    expect(statSync(b.folder).isDirectory()).toBe(true);
    expect(statSync(b.folder).mode & 0o777).toBe(0o700);
    const file = readJson("board-browsers.json");
    expect(file.browsers.map((x: any) => x.id)).toEqual([id]);
    expect(file.running).toEqual({});
    // Adding never starts Chrome.
    expect(d.chromeStarts()).toEqual([]);
  });

  test("names must be given and differ (case aside); a second one with a clashing slug gets its own id", async () => {
    expect((await user("POST", "/api/board-browsers", { name: "   " })).status).toBe(400);
    expect((await user("POST", "/api/board-browsers", {})).status).toBe(400);
    expect((await user("POST", "/api/board-browsers", { name: "work whatsapp" })).status).toBe(409);
    const r = await user("POST", "/api/board-browsers", { name: "Work: WhatsApp!" });
    expect(r.status).toBe(200);
    expect(r.data.added).toBe("work-whatsapp-2");
    expect((await user("DELETE", "/api/board-browsers/work-whatsapp-2")).status).toBe(200);
  });

  test("PATCH renames, sets the start page and keep running, and checks each", async () => {
    const r = await user("PATCH", `/api/board-browsers/${id}`, { name: "Business WhatsApp", startUrl: "web.whatsapp.com" });
    expect(r.status).toBe(200);
    expect(r.data.boardBrowsers.find((x: any) => x.id === id)).toMatchObject({ id, name: "Business WhatsApp", startUrl: "https://web.whatsapp.com/" });
    expect(readJson("board-browsers.json").browsers[0]).toMatchObject({ id, name: "Business WhatsApp", startUrl: "https://web.whatsapp.com/" });
    expect((await user("PATCH", `/api/board-browsers/${id}`, { startUrl: "ftp://example.com" })).status).toBe(400);
    expect((await user("PATCH", `/api/board-browsers/${id}`, { keepRunning: "yes" })).status).toBe(400);
    expect((await user("PATCH", `/api/board-browsers/${id}`, { name: "" })).status).toBe(400);
    expect((await user("PATCH", "/api/board-browsers/nope", { name: "X" })).status).toBe(404);
    // The id stays; null clears the start page.
    const cleared = await user("PATCH", `/api/board-browsers/${id}`, { startUrl: null });
    expect(cleared.data.boardBrowsers.find((x: any) => x.id === id).startUrl).toBe(null);
  });

  test("ensure is only for a browser a run is using now", async () => {
    expect((await d.api("POST", "/api/board-browsers/nope/ensure", {})).status).toBe(404);
    const r = await d.api("POST", `/api/board-browsers/${id}/ensure`, {}, { [RUN]: `${SLUG}/t_20260101_aaaa` });
    expect(r.status).toBe(409);
    expect(typeof r.data.error).toBe("string");
    expect(d.chromeStarts()).toEqual([]);
  });

  test("open starts Chrome with a window on the browser's own folder (the stub closes at once: 502)", async () => {
    const r = await user("POST", `/api/board-browsers/${id}/open`, { url: "example.com/login" });
    expect(r.status).toBe(502);
    expect(typeof r.data.error).toBe("string");
    const starts = d.chromeStarts();
    expect(starts.length).toBe(1);
    expect(starts[0]).toContain(`--user-data-dir=${join(d.home, "browsers", id)}`);
    expect(starts[0].some((a) => a.startsWith("--headless"))).toBe(false);
    expect(starts[0].at(-1)).toBe("https://example.com/login");
    // The failure shows on the browser, in plain words.
    const v = (await d.api("GET", "/api/board-browsers")).data.boardBrowsers.find((x: any) => x.id === id);
    expect(v).toMatchObject({ state: "stopped", error: r.data.error });
    expect((await user("POST", `/api/board-browsers/${id}/sign-in`, { url: "not a url at all://" })).status).toBe(400);
    expect((await user("POST", "/api/board-browsers/nope/open", {})).status).toBe(404);
  });

  test("the sign-in screen and its input need a running browser that needs sign-in", async () => {
    expect((await user("POST", `/api/board-browsers/${id}/screen`, {})).status).toBe(409);
    expect((await user("POST", "/api/board-browsers/nope/screen", {})).status).toBe(404);
    // The input's shape is checked first.
    expect((await user("POST", `/api/board-browsers/${id}/input`, { type: "click", x: 2, y: 0 })).status).toBe(400);
    expect((await user("POST", `/api/board-browsers/${id}/input`, { type: "key", key: "Escape" })).status).toBe(400);
    expect((await user("POST", `/api/board-browsers/${id}/input`, { type: "scroll" })).status).toBe(400);
    expect((await user("POST", `/api/board-browsers/${id}/input`, { type: "text", text: "hi" })).status).toBe(409);
  });

  test("close on a browser that isn't running says it is closed", async () => {
    const r = await user("POST", `/api/board-browsers/${id}/close`, {});
    expect(r.status).toBe(200);
    expectBrowsersView(r.data);
    expect(r.data.closed).toBe(true);
    expect(typeof r.data.message).toBe("string");
  });

  test("a run holds it only from its tools' first call (claim): then close and remove are refused; after the run, the secret and ensure are 409/403", async () => {
    const t = await ticket("Uses the browser");
    // Choosing a board browser for a ticket is the user's too.
    expect((await d.api("PATCH", `/api/profiles/${SLUG}/tickets/${t}`, { browsers: [{ kind: "board", id }] }, origin())).status).toBe(403);
    const set = await user("PATCH", `/api/profiles/${SLUG}/tickets/${t}`, { browsers: [{ kind: "board", id, note: "for customers" }] });
    expect(set.status).toBe(200);
    expect(set.data.browsers).toEqual([{ kind: "board", id, note: "for customers" }]);
    const before = d.chromeStarts().length;
    const calls = () => readFileSync(d.env.FAKE_ARGS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sent = existsSync(d.env.FAKE_ARGS_FILE) ? calls().length : 0;
    await startRun(t);
    // The run gets the browser's tool server with its secret, but holds nothing and starts nothing yet.
    // The run's Claude (not any other Claude call the board makes): the one given this browser's tool server.
    const browserTool = (c: any): string[] | null => {
      const i = c.args.indexOf("--mcp-config");
      return i < 0 ? null : JSON.parse(c.args[i + 1]).mcpServers?.[`browser-${id}`]?.args ?? null;
    };
    const tool: string[] = await until(() => (existsSync(d.env.FAKE_ARGS_FILE) ? calls().slice(sent).map(browserTool).find(Boolean) ?? null : null), 10_000, "the run's Claude");
    expect(tool).toContain("browser-mcp");
    const secret = tool[tool.indexOf("--claim") + 1];
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    const idle = (await d.api("GET", "/api/board-browsers")).data.boardBrowsers.find((x: any) => x.id === id);
    expect(idle).toMatchObject({ inUse: 0, holders: [] });
    expect(d.chromeStarts().length).toBe(before);

    // Nobody else can hold it: no secret, a wrong one, the user, a run header.
    expect((await d.api("POST", `/api/board-browsers/${id}/claim`, {}, { [RUN]: `${SLUG}/${t}` })).status).toBe(403);
    expect((await d.api("POST", `/api/board-browsers/${id}/claim`, { token: "0".repeat(48) })).status).toBe(403);
    expect((await user("POST", `/api/board-browsers/${id}/claim`, { token: "nope" })).status).toBe(403);

    // The tools' first call holds it and starts it hidden (the stub then closes: 502, and the hold is dropped).
    const claim = await d.api("POST", `/api/board-browsers/${id}/claim`, { token: secret });
    expect(claim.status).toBe(502);
    await until(() => d.chromeStarts().length > before, 10_000, "a Chrome start for the run");
    const hidden = d.chromeStarts()[before];
    expect(hidden).toContain(`--user-data-dir=${join(d.home, "browsers", id)}`);
    expect(hidden.some((a) => a.startsWith("--headless"))).toBe(true);
    const after = (await d.api("GET", "/api/board-browsers")).data.boardBrowsers.find((x: any) => x.id === id);
    expect(after.inUse).toBe(0);
    expect(typeof after.lastUsedAt).toBe("string");

    await stopRun(t);
    // The run is over: its secret no longer works.
    expect((await d.api("POST", `/api/board-browsers/${id}/claim`, { token: secret })).status).toBe(403);
    expect((await d.api("POST", `/api/board-browsers/${id}/ensure`, {})).status).toBe(409);
  }, 60_000);

  test("DELETE removes it and its folder", async () => {
    const folder = join(d.home, "browsers", id);
    expect((await d.api("DELETE", `/api/board-browsers/${id}`, undefined, origin())).status).toBe(403);
    const r = await user("DELETE", `/api/board-browsers/${id}`);
    expect(r.status).toBe(200);
    expectBrowsersView(r.data);
    expect(r.data.boardBrowsers).toEqual([]);
    expect(readJson("board-browsers.json").browsers).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    expect((await user("DELETE", `/api/board-browsers/${id}`)).status).toBe(404);
  });
});

describe("shared devices", () => {
  const take = (slug: string, id: string, names: unknown, waitMs = 0, caller = `${slug}/${id}`) =>
    d.api("POST", `/api/profiles/${slug}/tickets/${id}/devices`, { action: "take", names, waitMs }, { [RUN]: caller });
  const release = (slug: string, id: string, names?: unknown) =>
    d.api("POST", `/api/profiles/${slug}/tickets/${id}/devices`, { action: "release", ...(names === undefined ? {} : { names }) }, { [RUN]: `${slug}/${id}` });
  const devices = async () => (await d.api("GET", "/api/devices")).data as any[];
  const device = async (name: string) => (await devices()).find((x) => x.name === name);
  const file = () => JSON.parse(readFileSync(join(d.home, "devices.json"), "utf8")) as any[];

  test("an empty list at first", async () => {
    const r = await d.api("GET", "/api/devices");
    expect(r.status).toBe(200);
    expect(r.data).toEqual([]);
  });

  test("POST adds or changes a device (lowercase name, capacity 1..50) and writes devices.json", async () => {
    const r = await d.api("POST", "/api/devices", { name: " Leo-Phone ", description: "  The test phone ", capacity: 99 });
    expect(r.status).toBe(200);
    expect(r.data).toEqual([{ name: "leo-phone", description: "The test phone", capacity: 50, lastUsedAt: null, using: [], waiting: [] }]);
    const raw = readFileSync(join(d.home, "devices.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(false);
    expect(JSON.parse(raw)).toEqual([{ name: "leo-phone", description: "The test phone", capacity: 50, lastUsedAt: null }]);
    const again = await d.api("POST", "/api/devices", { name: "leo-phone", capacity: 0 });
    expect(again.data[0]).toMatchObject({ name: "leo-phone", description: "The test phone", capacity: 1 });
  });

  test("bad names and callers that aren't the user", async () => {
    expect((await d.api("POST", "/api/devices", { name: "Two words" })).status).toBe(400);
    expect((await d.api("POST", "/api/devices", {})).status).toBe(400);
    for (const h of [{ [RUN]: `${SLUG}/t_20260101_aaaa` }, { [HUDDLE]: "token" }] as Record<string, string>[]) {
      expect((await d.api("POST", "/api/devices", { name: "x" }, h)).status).toBe(403);
      expect((await d.api("DELETE", "/api/devices/leo-phone", undefined, h)).status).toBe(403);
      expect((await d.api("POST", "/api/devices/leo-phone/free", { profile: SLUG, id: "t" }, h)).status).toBe(403);
      // Reading is for runs too.
      expect((await d.api("GET", "/api/devices", undefined, h)).status).toBe(200);
    }
  });

  test("take: one ticket holds it, a second waits in line and is told who has it; release hands it on", async () => {
    const a = await ticket("Holder");
    const b = await ticket("Waiter");
    const got = await take(SLUG, a, ["LEO-PHONE"]);
    expect(got.status).toBe(200);
    expect(got.data).toEqual({ ok: true, names: ["leo-phone"] });
    const held = await device("leo-phone");
    expect(held.using).toEqual([{ slug: SLUG, id: a, since: expect.any(String), title: "Holder", board: "Browsers" }]);
    expect(held.waiting).toEqual([]);
    expect(file().find((x) => x.name === "leo-phone").lastUsedAt).toBe(held.using[0].since);
    expect((await getTicket(a)).devices).toEqual({ using: [{ name: "leo-phone", since: held.using[0].since }], waiting: null });
    // Asking again for what it has is fine.
    expect((await take(SLUG, a, "leo-phone")).data).toEqual({ ok: true, names: ["leo-phone"] });

    const refused = await take(SLUG, b, ["leo-phone"], 0);
    expect(refused.status).toBe(200);
    expect(refused.data).toEqual({ ok: false, names: ["leo-phone"], place: 1, usedBy: [{ slug: SLUG, id: a, since: held.using[0].since, title: "Holder" }] });
    expect((await device("leo-phone")).waiting).toEqual([{ slug: SLUG, id: b, since: expect.any(String), title: "Waiter", board: "Browsers" }]);
    expect((await getTicket(b)).devices).toMatchObject({ using: [], waiting: { names: ["leo-phone"] } });

    // A holder can't ask for more until it lets go (all at once, so two tickets never wait on each other).
    expect((await take(SLUG, a, ["other-device"])).status).toBe(409);

    const rel = await release(SLUG, a, ["leo-phone"]);
    expect(rel.status).toBe(200);
    expect(rel.data).toEqual({ released: ["leo-phone"] });
    // The ticket in line gets it at once.
    expect((await device("leo-phone")).using.map((u: any) => u.id)).toEqual([b]);
    expect((await take(SLUG, b, ["leo-phone"])).data).toEqual({ ok: true, names: ["leo-phone"] });

    // The user's "Free it".
    const freed = await d.api("POST", "/api/devices/leo-phone/free", { profile: SLUG, id: b });
    expect(freed.status).toBe(200);
    expect(freed.data.find((x: any) => x.name === "leo-phone").using).toEqual([]);
    expect((await d.api("POST", "/api/devices/leo-phone/free", { profile: SLUG, id: b })).status).toBe(404);
    expect((await release(SLUG, b)).data).toEqual({ released: [] });
  });

  test("a waiting take returns as soon as the device is let go", async () => {
    const a = await ticket("First");
    const b = await ticket("Second");
    expect((await take(SLUG, a, ["leo-phone"])).data.ok).toBe(true);
    const waiting = take(SLUG, b, ["leo-phone"], 20_000);
    await until(async () => (await device("leo-phone")).waiting.length === 1, 5_000, "the second ticket to wait");
    const t0 = Date.now();
    await release(SLUG, a);
    const r = await waiting;
    expect(r.data).toEqual({ ok: true, names: ["leo-phone"] });
    expect(Date.now() - t0).toBeLessThan(5_000);
    await release(SLUG, b);
  });

  test("a name not on the list is added for one ticket at a time", async () => {
    const a = await ticket("Adds");
    expect((await take(SLUG, a, ["new-tablet"])).data).toEqual({ ok: true, names: ["new-tablet"] });
    expect(file().find((x) => x.name === "new-tablet")).toMatchObject({ name: "new-tablet", description: "", capacity: 1, addedByClaude: true });
    expect((await device("new-tablet")).addedByClaude).toBe(true);
    await release(SLUG, a);
    // The user looking at it makes it theirs.
    await d.api("POST", "/api/devices", { name: "new-tablet", description: "A tablet" });
    expect(file().find((x) => x.name === "new-tablet").addedByClaude).toBeUndefined();
  });

  test("take and release are only for the ticket's own run, with a known action and real names", async () => {
    const a = await ticket("Own run");
    const b = await ticket("Other");
    expect((await take(SLUG, a, ["leo-phone"], 0, `${SLUG}/${b}`)).status).toBe(403);
    expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${a}/devices`, { action: "take", names: ["leo-phone"] })).status).toBe(403);
    expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${a}/devices`, { action: "take", names: ["leo-phone"] }, { [RUN]: `${SLUG}/${a}`, [HUDDLE]: "t" })).status).toBe(403);
    expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${a}/devices`, { action: "grab", names: ["leo-phone"] }, { [RUN]: `${SLUG}/${a}` })).status).toBe(400);
    expect((await take(SLUG, a, [])).status).toBe(400);
    expect((await take(SLUG, a, ["Not A Name"])).status).toBe(400);
    expect((await device("leo-phone")).using).toEqual([]);
  });

  test("capacity: two tickets may hold a device with room for two", async () => {
    await d.api("POST", "/api/devices", { name: "emulators", capacity: 2 });
    const [a, b, c] = [await ticket("E1"), await ticket("E2"), await ticket("E3")];
    expect((await take(SLUG, a, ["emulators"])).data.ok).toBe(true);
    expect((await take(SLUG, b, ["emulators"])).data.ok).toBe(true);
    expect((await take(SLUG, c, ["emulators"])).data).toMatchObject({ ok: false, place: 1 });
    expect((await device("emulators")).using.map((u: any) => u.id).sort()).toEqual([a, b].sort());
    for (const t of [a, b, c]) await release(SLUG, t);
    expect(await device("emulators")).toMatchObject({ using: [], waiting: [] });
  });

  test("quirk: the place in line counts every waiting request, also those for other devices", async () => {
    await d.api("POST", "/api/devices", { name: "dev-a" });
    await d.api("POST", "/api/devices", { name: "dev-b" });
    const [ha, hb, wa, wb] = [await ticket("Holds A"), await ticket("Holds B"), await ticket("Waits A"), await ticket("Waits B")];
    expect((await take(SLUG, ha, ["dev-a"])).data.ok).toBe(true);
    expect((await take(SLUG, hb, ["dev-b"])).data.ok).toBe(true);
    expect((await take(SLUG, wa, ["dev-a"])).data).toMatchObject({ ok: false, place: 1 });
    expect((await take(SLUG, wb, ["dev-b"])).data).toMatchObject({ ok: false, place: 2 });
    for (const t of [ha, hb, wa, wb]) await release(SLUG, t);
  });

  test("the board lets go of a ticket's devices when its run ends, and the next in line gets them", async () => {
    const r = await ticket("Runs with the phone");
    const next = await ticket("Next in line");
    await startRun(r);
    expect((await take(SLUG, r, ["leo-phone"])).data.ok).toBe(true);
    expect((await take(SLUG, next, ["leo-phone"], 0)).data.ok).toBe(false);
    await stopRun(r);
    await until(async () => (await device("leo-phone")).using.map((u: any) => u.id).join() === next, 10_000, "the device to pass on");
    expect((await getTicket(r)).devices).toBe(null);
    await release(SLUG, next);
  }, 60_000);

  test("DELETE removes a device nobody uses; refused while used or waited for", async () => {
    const a = await ticket("Blocks delete");
    await take(SLUG, a, ["leo-phone"]);
    expect((await d.api("DELETE", "/api/devices/leo-phone")).status).toBe(409);
    await release(SLUG, a);
    const r = await d.api("DELETE", "/api/devices/leo-phone");
    expect(r.status).toBe(200);
    expect(r.data.map((x: any) => x.name)).not.toContain("leo-phone");
    expect(file().map((x) => x.name)).not.toContain("leo-phone");
    expect((await d.api("DELETE", "/api/devices/leo-phone")).status).toBe(404);
  });
});

describe("terminal (WebSocket)", () => {
  /** A terminal socket that collects text output and JSON control messages. */
  async function openShell(query: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/api/profiles/${SLUG}/shell?${query}`, { headers: { origin: d.url } } as any);
    ws.binaryType = "arraybuffer";
    const s = { ws, out: "", control: [] as any[] };
    const dec = new TextDecoder();
    ws.onmessage = (e) => {
      if (typeof e.data === "string") s.control.push(JSON.parse(e.data));
      else s.out += dec.decode(new Uint8Array(e.data as ArrayBuffer));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    return s;
  }
  const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

  test("errors before the upgrade: no upgrade 400, bad ticket id 400, unknown ticket 404", async () => {
    const base = `/api/profiles/${SLUG}/shell`;
    expect((await d.api("GET", base, undefined, origin())).status).toBe(400);
    const bad = await d.api("GET", `${base}?ticket=${encodeURIComponent("../x")}`, undefined, origin());
    expect(bad.status).toBe(400);
    const unknown = await d.api("GET", `${base}?ticket=t_20990101_zzzz`, undefined, origin());
    expect(unknown.status).toBe(404);
    expect(typeof unknown.data.error).toBe("string");
  });

  test("a ticket without a copy of the folder gets a shell in the board folder; resize, exit and restart", async () => {
    const t = await ticket("Terminal");
    const s = await openShell(`ticket=${t}&cols=5000&rows=0`);
    send(s.ws, { type: "input", data: "printf 'dir=%s\\n' \"$(pwd -P)\"; stty size\n" });
    await until(() => s.out.includes(`dir=${realpathSync(d.project)}`), 10_000, "pwd in the board folder");
    // cols clamped to 1000; rows 0 is "not given", so 24.
    await until(() => /\b24 1000\b/.test(s.out), 10_000, "the clamped size");
    send(s.ws, { type: "resize", cols: 100, rows: 30 });
    send(s.ws, "not json");
    send(s.ws, { type: "unknown" });
    send(s.ws, { type: "input", data: "stty size\n" });
    await until(() => /\b30 100\b/.test(s.out), 10_000, "the new size");
    send(s.ws, { type: "input", data: "exit 3\n" });
    await until(() => s.control.find((m) => m.type === "exit"), 10_000, "the exit message");
    expect(s.control.find((m) => m.type === "exit")).toEqual({ type: "exit", code: 3 });
    send(s.ws, { type: "restart" });
    await until(() => s.control.some((m) => m.type === "reset"), 10_000, "the reset message");
    send(s.ws, { type: "input", data: "echo again-$((1+1))\n" });
    await until(() => s.out.includes("again-2"), 10_000, "the new shell's echo");
    s.ws.close();
  }, 40_000);

  test("one shell per folder is shared between tabs, scrollback first", async () => {
    const a = await openShell("cols=80&rows=24");
    send(a.ws, { type: "input", data: "echo shared-$((6*7))\n" });
    await until(() => a.out.includes("shared-42"), 10_000, "the first tab's echo");
    const b = await openShell("cols=80&rows=24");
    await until(() => b.out.includes("shared-42"), 10_000, "the scrollback in the second tab");
    send(b.ws, { type: "input", data: "echo from-b-$((2*2))\n" });
    await until(() => a.out.includes("from-b-4"), 10_000, "the second tab's input in the first tab");
    a.ws.close();
    b.ws.close();
  }, 30_000);
});
