import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, type BusEvent } from "./events";
import { onFrontNotice, readFront, setNoticeLimit } from "./front";
import { isSatellite, RuntimeMirror, satelliteNotice } from "./satellite";
import { Store } from "./store";
import type { Profile } from "./types";

test("satellite mode only with CKANBAN_SATELLITE=1", () => {
  expect(isSatellite({})).toBe(false);
  expect(isSatellite({ CKANBAN_SATELLITE: "0" })).toBe(false);
  expect(isSatellite({ CKANBAN_SATELLITE: "1" })).toBe(true);
});

test("event lines reach the listeners but are marked for the event stream to skip; runtime lines fill the mirror", async () => {
  const bus = new Bus();
  const mirror = new RuntimeMirror();
  const got: BusEvent[] = [];
  bus.on((e) => void got.push(e));
  expect(satelliteNotice(`event ${JSON.stringify({ type: "ticket.deleted", profile: "b", id: "t1" })}`, bus, mirror)).toBe(true);
  expect(got).toEqual([{ type: "ticket.deleted", profile: "b", id: "t1" }]);
  expect(bus.isMirrored(got[0])).toBe(true);
  // The satellite's own events are not marked: they go out on its stream (and Rust re-emits them).
  bus.emit({ type: "helper.updated" });
  expect(bus.isMirrored(got[1])).toBe(false);

  let ready = false;
  void mirror.ready.then(() => (ready = true));
  expect(mirror.isRunning("b", "t1")).toBe(false);
  satelliteNotice(`runtime ${JSON.stringify({ running: ["b/t1"], hostHuddles: { b: { t2: { huddleId: "h1" } } }, sessions: { s1: { id: "s1" } } })}`, bus, mirror);
  await Bun.sleep(0);
  expect(ready).toBe(true);
  expect(mirror.isRunning("b", "t1")).toBe(true);
  expect(mirror.hostHuddles("b").get("t2")).toEqual({ huddleId: "h1" } as any);
  expect(mirror.sessionSummary("s1")).toEqual({ id: "s1" } as any);
  // Later lines change only the keys they carry.
  satelliteNotice(`runtime ${JSON.stringify({ sessions: { s1: null, s2: { id: "s2" } } })}`, bus, mirror);
  expect(mirror.isRunning("b", "t1")).toBe(true);
  expect(mirror.sessionSummary("s1")).toBeNull();
  expect(mirror.sessionSummary("s2")).toEqual({ id: "s2" } as any);
  satelliteNotice(`runtime ${JSON.stringify({ running: [], hostHuddles: { b: null } })}`, bus, mirror);
  expect(mirror.isRunning("b", "t1")).toBe(false);
  expect(mirror.hostHuddles("b").size).toBe(0);

  // Not ours, or broken: other notices pass on, a bad line is dropped.
  expect(satelliteNotice("changed automation-passes.json", bus, mirror)).toBe(false);
  expect(satelliteNotice("event {not json", bus, mirror)).toBe(true);
  expect(got).toHaveLength(2);
});

test("a long event line arrives whole once the notice limit allows it", async () => {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  const got: string[] = [];
  onFrontNotice((l) => void got.push(l));
  setNoticeLimit(1024 * 1024);
  try {
    const p = readFront({ CKANBAN_FRONT_PORT: "7777" }, stream, () => {}, 4242);
    ctl.enqueue(new TextEncoder().encode(`${"a".repeat(64)} 5151\n`));
    await p;
    const line = `event ${JSON.stringify({ type: "ticket.updated", profile: "b", ticket: { id: "t", body: "x".repeat(100_000) } })}`;
    // In pieces, as a pipe delivers it.
    for (let i = 0; i < line.length; i += 16_384) ctl.enqueue(new TextEncoder().encode(line.slice(i, i + 16_384)));
    ctl.enqueue(new TextEncoder().encode("\n"));
    await Bun.sleep(10);
    expect(got).toEqual([line]);
    ctl.close();
  } finally {
    onFrontNotice(null);
    setNoticeLimit(4096);
  }
});

test("the satellite's store refuses ticket writes and still reads", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-satellite-"));
  try {
    const store = new Store(root);
    const profile: Profile = { name: "B", slug: "b", path: "/tmp/b", baseBranch: "main", maxParallel: 1, model: null, createdAt: "2026-11-17T00:00:00.000Z" };
    store.saveProfile(profile);
    const t = store.createTicket("b", { title: "Mine", body: "", status: "backlog" });
    store.readOnlyTickets = true;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errors.push(String(m));
    try {
      expect(() => store.createTicket("b", { title: "New", body: "", status: "backlog" })).toThrow(/satellite mode: create of ticket b\/\(new\) refused/);
      expect(() => store.updateTicket("b", t.id, { title: "Changed" })).toThrow(/update of ticket b\/.+ refused/);
      expect(() => store.addComment("b", t.id, "ai", "hi")).toThrow(/comment/);
      expect(() => store.appendActivity("b", t.id, 1, {})).toThrow(/run log/);
      expect(() => store.deleteTicket("b", t.id)).toThrow(/delete/);
    } finally {
      console.error = orig;
    }
    // Each refusal is logged.
    expect(errors).toHaveLength(5);
    expect(store.getTicket("b", t.id)?.title).toBe("Mine");
    expect(store.listTickets("b").map((x) => x.id)).toEqual([t.id]);
    expect(readdirSync(join(root, "profiles", "b", "tickets", t.id))).toEqual(["ticket.md"]);
    // Profiles are not tickets: still written.
    store.saveProfile({ ...profile, name: "B2" });
    expect(store.getProfile("b")?.name).toBe("B2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mirror keeps the Rust board's word on MCP servers (the helper's check-in offer)", () => {
  const m = new RuntimeMirror();
  expect(m.mcpConnected()).toBe(false);
  m.apply({ running: [] });
  expect(m.mcpConnected()).toBe(false);
  m.apply({ mcpConnected: true });
  expect(m.mcpConnected()).toBe(true);
  m.apply({ running: ["b/x"] });
  expect(m.mcpConnected()).toBe(true);
  m.apply({ mcpConnected: false });
  expect(m.mcpConnected()).toBe(false);
});
