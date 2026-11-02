import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionFeed, type SessionChange, type SessionChanges } from "../src/server/changefeed";
import { Bus, type BusEvent } from "../src/server/events";
import { startHuddleSessionWatcher } from "../src/server/huddle-session";
import { SessionCache, startSessionWatcher } from "../src/server/session";
import { Store, type StoreChange } from "../src/server/store";
import { TerminalWatcher } from "../src/server/terminals";
import { tempDir, until } from "./helpers";

const line = (text: string, at: string) =>
  JSON.stringify({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

/** A feed that is "watching" but only reports what the test sends: stands for a watch that misses changes. */
class FakeFeed implements SessionChanges {
  live = true;
  fns = new Set<(c: SessionChange) => void>();
  subscribe(fn: (c: SessionChange) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  send(c: SessionChange) {
    for (const fn of this.fns) fn(c);
  }
}

function setup() {
  const configDir = tempDir();
  const proj = join(configDir, "projects", "-f");
  mkdirSync(proj, { recursive: true });
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const updates = () => seen.filter((e) => e.type === "session.updated");
  return { configDir, proj, store, bus, seen, updates, cache: new SessionCache({ configDir }) };
}

test("Store.onChange reports the Store's own ticket, huddle, schedule and job writes", () => {
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const got: StoreChange[] = [];
  const stop = store.onChange((c) => got.push(c));
  const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { title: "y" });
  store.saveHuddle("p", { id: "h_1" } as any);
  store.saveSchedule("p", { id: "s_1" } as any);
  store.deleteSchedule("p", "s_1");
  store.saveJob("p", { id: "j_1" } as any);
  store.deleteTicket("p", t.id);
  expect(got).toEqual([
    { kind: "ticket", slug: "p", id: t.id },
    { kind: "ticket", slug: "p", id: t.id },
    { kind: "huddle", slug: "p", id: "h_1" },
    { kind: "schedule", slug: "p", id: "s_1" },
    { kind: "schedule", slug: "p", id: "s_1" },
    { kind: "job", slug: "p", id: "j_1" },
    { kind: "ticket", slug: "p", id: t.id },
  ]);
  stop();
  store.saveJob("p", { id: "j_2" } as any);
  expect(got.length).toBe(7);
});

test("SessionFeed names the session of each path it is told about", () => {
  const feed = new SessionFeed("/c/projects");
  const got: SessionChange[] = [];
  feed.subscribe((c) => got.push(c));
  feed.path("-proj");
  feed.path("-proj/abc.jsonl");
  feed.path("-proj/abc/subagents/agent-1.jsonl");
  feed.path(null);
  expect(got).toEqual([{ sessionId: "abc", file: "/c/projects/-proj/abc.jsonl" }, { sessionId: "abc", file: null }, null]);
});

test("a ticket write reaches the session watcher without a full pass", async () => {
  const { proj, store, bus, updates, cache } = setup();
  const sid = "11111111-2222-3333-4444-555555555555";
  writeFileSync(join(proj, `${sid}.jsonl`), line("hello", "2026-09-29T01:00:00Z"));
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  const feed = new FakeFeed();
  const stop = startSessionWatcher(store, bus, cache, 20, { feed, safetyMs: 1e9 });
  try {
    await Bun.sleep(100); // first pass: takes stock, sends nothing
    expect(updates().length).toBe(0);
    store.updateTicket("p", t.id, { sessionId: sid });
    await until(() => updates().length === 1, 2000);
    expect(updates()[0]).toMatchObject({ profile: "p", id: t.id });
  } finally {
    stop();
  }
});

test("a transcript append reaches the session watcher through the real feed", async () => {
  const { configDir, proj, store, bus, updates, cache } = setup();
  const sid = "11111111-2222-3333-4444-666666666666";
  const file = join(proj, `${sid}.jsonl`);
  writeFileSync(file, line("hello", "2026-09-29T01:00:00Z"));
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const feed = new SessionFeed(join(configDir, "projects"));
  expect(feed.start()).toBe(true);
  const stopFollow = cache.follow(feed);
  const stop = startSessionWatcher(store, bus, cache, 20, { feed, safetyMs: 1e9 });
  try {
    await Bun.sleep(150);
    expect(updates().length).toBe(0);
    appendFileSync(file, line("reply", "2026-09-29T01:00:01Z"));
    await until(() => updates().length === 1, 3000);
    expect((updates()[0] as any).session.lastMessage.text).toBe("reply");
  } finally {
    stop();
    stopFollow();
    feed.stop();
  }
});

test("with the watch missing a change, the safety pass still catches it", async () => {
  const { proj, store, bus, updates, cache } = setup();
  const sid = "11111111-2222-3333-4444-777777777777";
  const file = join(proj, `${sid}.jsonl`);
  writeFileSync(file, line("hello", "2026-09-29T01:00:00Z"));
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  let now = 1_000_000;
  const feed = new FakeFeed(); // never reports the append
  const stop = startSessionWatcher(store, bus, cache, 20, { feed, safetyMs: 60_000, now: () => now });
  try {
    await Bun.sleep(100);
    appendFileSync(file, line("reply", "2026-09-29T01:00:01Z"));
    await Bun.sleep(150);
    expect(updates().length).toBe(0); // the feed said nothing: no pass looked
    now += 60_000;
    await until(() => updates().length === 1, 2000);
    expect(updates()[0]).toMatchObject({ profile: "p", id: t.id });
    // A feed that stops watching: every pass is a full one again.
    feed.live = false;
    appendFileSync(file, line("again", "2026-09-29T01:00:02Z"));
    await until(() => updates().length === 2, 2000);
  } finally {
    stop();
  }
});

test("huddle session watcher passes only after a huddle write or a change to a watched session", async () => {
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const huddle = { id: "h_1", status: "open", participants: [{ kind: "agent", handle: "qa", sessionId: "s1" }] } as any;
  store.saveHuddle("p", huddle);
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const versions: Record<string, string> = { s1: "1" };
  let calls = 0;
  const feed = new FakeFeed();
  const stop = startHuddleSessionWatcher(store, bus, (id) => (calls++, versions[id] ?? null), 20, { feed, safetyMs: 1e9 });
  try {
    await Bun.sleep(80);
    const after = calls;
    expect(after).toBe(1); // first pass only
    versions.s1 = "2";
    feed.send({ sessionId: "other", file: null });
    await Bun.sleep(80);
    expect(calls).toBe(after);
    feed.send({ sessionId: "s1", file: null });
    await until(() => seen.length === 1, 2000);
    expect(seen[0]).toMatchObject({ type: "huddle.session", huddleId: "h_1", handle: "qa" });
  } finally {
    stop();
  }
});

test("terminal watcher reads a session's title once until the feed reports it changed", async () => {
  const store = new Store(tempDir());
  const path = tempDir();
  store.saveProfile({ name: "P", slug: "p", path, baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: "s1", workdir: path });
  let reads = 0;
  const title: Record<string, string> = { s1: "old name" };
  const sessions = { summary: (id: string) => (reads++, { title: title[id] }) } as unknown as SessionCache;
  const feed = new FakeFeed();
  let cmds = ["claude --resume 'new name'"];
  const w = new TerminalWatcher(store, new Bus(), sessions, async () => cmds, feed, () => 0);
  await w.poll();
  await w.poll();
  expect(reads).toBe(1);
  expect(w.isOpen("p", t.id)).toBe(false);
  title.s1 = "new name";
  feed.send({ sessionId: "s1", file: null });
  await w.poll();
  expect(reads).toBe(2);
  expect(w.isOpen("p", t.id)).toBe(true);
  // No claude running: no title is read at all.
  cmds = ["vim"];
  feed.send(null);
  await w.poll();
  expect(reads).toBe(2);
  expect(w.isOpen("p", t.id)).toBe(false);
});
