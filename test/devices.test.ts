import { expect, test } from "bun:test";
import { Devices, STALE_WAIT_MS } from "../src/server/devices";
import { tempDir } from "./helpers";

const fresh = (now?: () => number) => {
  const changed: string[][] = [];
  const d = new Devices(tempDir("ck-dev-"), (o) => changed.push(o), now);
  return { d, changed };
};

test("a device with capacity 1 goes to one ticket at a time; the next one gets it on release", async () => {
  const { d } = fresh();
  d.upsert({ name: "leo-phone", description: "Leo's iPhone" });
  expect(await d.take("p", "a", ["leo-phone"])).toEqual({ ok: true, names: ["leo-phone"] });
  const b = d.take("p", "b", ["leo-phone"], 5000);
  await Bun.sleep(5);
  expect(d.ticketState("p", "b")?.waiting?.names).toEqual(["leo-phone"]);
  expect(d.views()[0].using.map((u) => u.id)).toEqual(["a"]);
  expect(d.release("p", "a", ["leo-phone"])).toEqual(["leo-phone"]);
  expect(await b).toEqual({ ok: true, names: ["leo-phone"] });
  expect(d.ticketState("p", "b")).toMatchObject({ using: [{ name: "leo-phone" }], waiting: null });
  expect(d.ticketState("p", "a")).toBeNull();
});

test("capacity above 1 lets that many tickets use it at once", async () => {
  const { d } = fresh();
  d.upsert({ name: "ios-simulator", capacity: 2 });
  expect((await d.take("p", "a", ["ios-simulator"])).ok).toBe(true);
  expect((await d.take("q", "b", ["ios-simulator"])).ok).toBe(true);
  const c = await d.take("p", "c", ["ios-simulator"], 10);
  expect(c).toMatchObject({ ok: false, place: 1 });
  expect(c.ok ? [] : c.usedBy.map((u) => `${u.slug}/${u.id}`)).toEqual(["p/a", "q/b"]);
  // Raising the capacity lets the waiting ticket in.
  d.upsert({ name: "ios-simulator", capacity: 3 });
  expect(d.ticketState("p", "c")?.using.map((u) => u.name)).toEqual(["ios-simulator"]);
});

test("several devices are taken all at once, so tickets asking in opposite order never deadlock", async () => {
  const { d } = fresh();
  const one = d.take("p", "a", ["chrome-whatsapp", "leo-phone"]);
  const two = d.take("p", "b", ["leo-phone", "chrome-whatsapp"], 5000);
  expect(await one).toEqual({ ok: true, names: ["chrome-whatsapp", "leo-phone"] });
  await Bun.sleep(5);
  // b holds neither while it waits for both.
  expect(d.ticketState("p", "b")).toMatchObject({ using: [], waiting: { names: ["leo-phone", "chrome-whatsapp"] } });
  d.release("p", "a");
  expect((await two).ok).toBe(true);
  expect(d.ticketState("p", "b")?.using.map((u) => u.name).sort()).toEqual(["chrome-whatsapp", "leo-phone"]);
});

test("a ticket that already holds a device must let go before asking for more", async () => {
  const { d } = fresh();
  await d.take("p", "a", ["leo-phone"]);
  await expect(d.take("p", "a", ["chrome-whatsapp"])).rejects.toThrow(/let go of it first/i);
  // Asking again for what it already has is fine.
  expect(await d.take("p", "a", ["leo-phone"])).toEqual({ ok: true, names: ["leo-phone"] });
});

test("first come, first served: a waiting request keeps later ones off its device", async () => {
  const { d } = fresh();
  d.upsert({ name: "dev", capacity: 1 });
  await d.take("p", "a", ["dev", "other"]);
  // b waits for dev; c asks for dev only after b: when a lets go, b gets it, not c.
  const b = d.take("p", "b", ["dev"], 5000);
  const c = d.take("p", "c", ["dev"], 30);
  await Bun.sleep(5);
  d.release("p", "a", ["dev"]);
  expect((await b).ok).toBe(true);
  expect(await c).toMatchObject({ ok: false, place: 1 });
  // c keeps its place across calls and gets it next.
  d.release("p", "b");
  expect((await d.take("p", "c", ["dev"], 10)).ok).toBe(true);
});

test("a waiting request for a busy device doesn't let a later one overtake it on another device it also needs", async () => {
  const { d } = fresh();
  await d.take("p", "a", ["x"]);
  const b = d.take("p", "b", ["x", "y"], 5000);
  // y is free, but b asked for it first: c waits behind b.
  const c = await d.take("p", "c", ["y"], 10);
  expect(c.ok).toBe(false);
  d.release("p", "a");
  expect((await b).ok).toBe(true);
});

test("the run ending frees what it holds and drops its waiting request", async () => {
  const { d } = fresh();
  await d.take("p", "a", ["dev"]);
  const b = d.take("p", "b", ["dev"], 5000);
  await Bun.sleep(5);
  d.releaseAll("p", "b");
  await expect(b).rejects.toThrow(/cancelled/);
  const c = d.take("p", "c", ["dev"], 5000);
  d.releaseAll("p", "a");
  expect((await c).ok).toBe(true);
  expect(d.views()[0].waiting).toEqual([]);
});

test("Free it takes the device from one ticket and gives it to the next in line", async () => {
  const { d } = fresh();
  await d.take("p", "a", ["dev"]);
  const b = d.take("p", "b", ["dev"], 5000);
  d.free("dev", "p", "a");
  expect((await b).ok).toBe(true);
  expect(() => d.free("dev", "p", "a")).toThrow(/isn't using/);
  // a's next take waits in line like anyone else's.
  expect((await d.take("p", "a", ["dev"], 10)).ok).toBe(false);
});

test("a name not on the list is added as a one-at-a-time device marked as added by Claude, and survives a restart", async () => {
  const root = tempDir("ck-dev-");
  const d = new Devices(root);
  expect(await d.take("p", "a", [" Android-Emulator "])).toEqual({ ok: true, names: ["android-emulator"] });
  expect(d.devices()).toMatchObject([{ name: "android-emulator", capacity: 1, addedByClaude: true }]);
  const again = new Devices(root);
  expect(again.devices()).toMatchObject([{ name: "android-emulator", capacity: 1, addedByClaude: true }]);
  // Holds are not kept across restarts.
  expect(again.views()[0].using).toEqual([]);
  // The user describing it makes it theirs.
  expect(again.upsert({ name: "android-emulator", description: "Pixel 8 emulator" }).addedByClaude).toBeUndefined();
  await expect(d.take("p", "a", ["not a name!"])).rejects.toThrow(/isn't a device name/);
});

test("a waiting request nobody asks about again is dropped after a while", async () => {
  let now = 1_000_000;
  const { d } = fresh(() => now);
  await d.take("p", "a", ["dev"]);
  expect((await d.take("p", "b", ["dev"], 1)).ok).toBe(false);
  now += STALE_WAIT_MS + 1;
  const c = d.take("p", "c", ["dev"], 5000);
  d.release("p", "a");
  expect((await c).ok).toBe(true);
  expect(d.ticketState("p", "b")).toBeNull();
});

test("removing a device is refused while it is in use", async () => {
  const { d } = fresh();
  await d.take("p", "a", ["dev"]);
  expect(() => d.remove("dev")).toThrow(/in use/);
  d.release("p", "a");
  d.remove("dev");
  expect(d.devices()).toEqual([]);
});

test("take_devices and release_devices work from a ticket's own run, not outside runs or from a huddle", async () => {
  const { RUN_ENV } = await import("../src/client");
  const { callTool } = await import("../src/mcp-server");
  const calls: unknown[][] = [];
  const client = {
    listProfiles: async () => [{ name: "Kanban", slug: "kb", path: "/tmp/kb" }],
    takeDevices: async (...a: unknown[]) => (calls.push(["take", ...a]), calls.length === 1
      ? { ok: true, names: ["leo-phone"] }
      : { ok: false, names: ["leo-phone"], place: 1, usedBy: [{ slug: "kb", id: "t_2", since: "", title: "Call test" }] }),
    releaseDevices: async (...a: unknown[]) => (calls.push(["release", ...a]), { released: ["leo-phone"] }),
  };
  const ctx = (env: Record<string, string>) => ({ client, cwd: "/tmp", env }) as any;
  expect((await callTool("take_devices", { names: ["leo-phone"] }, ctx({}))).isError).toBe(true);
  expect((await callTool("take_devices", { names: ["leo-phone"] }, ctx({ [RUN_ENV]: "kb/t_1", CKANBAN_HUDDLE_AGENT: "h/x/y" }))).isError).toBe(true);
  const run = ctx({ [RUN_ENV]: "kb/t_1" });
  expect((await callTool("take_devices", { names: ["leo-phone"] }, run)).content[0].text).toContain("You have leo-phone now");
  const busy = (await callTool("take_devices", { names: ["leo-phone"] }, run)).content[0].text;
  expect(busy).toContain('"Call test" (kb) has it');
  expect(busy).toContain("#1 in line");
  expect((await callTool("release_devices", {}, run)).content[0].text).toBe("Let go of leo-phone.");
  expect(calls).toEqual([["take", "kb", "t_1", ["leo-phone"], "kb/t_1"], ["take", "kb", "t_1", ["leo-phone"], "kb/t_1"], ["release", "kb", "t_1", null, "kb/t_1"]]);
});

test("runs get the device list, the ticket's hint and how to take and let go", async () => {
  const { devicesNote } = await import("../src/server/prompts");
  expect(devicesNote([], [])).toBeNull();
  const note = devicesNote([
    { name: "chrome-whatsapp", description: "Chrome tab signed in to WhatsApp Web as Leo", capacity: 1 },
    { name: "ios-simulator", description: "", capacity: 4 },
  ], ["leo-phone"])!;
  expect(note).toContain("- chrome-whatsapp (one ticket at a time): Chrome tab signed in to WhatsApp Web as Leo");
  expect(note).toContain("- ios-simulator (4 tickets at once)");
  expect(note).toContain("This ticket expects to use: leo-phone (a hint; it holds nothing).");
  expect(note).toContain("`take_devices`");
  expect(note).toContain("`release_devices`");
  expect(devicesNote([], ["leo-phone"])).toContain("no shared devices listed yet");
});
