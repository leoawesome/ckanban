// The Store's cached lists (huddles, jobs, schedules, automations, tickets, schedule history, outputs) give the same
// result as reading every file, and never serve stale data after another process changes a file.
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { JsonDir, JSON_DIR_RECHECK_MS } from "../src/server/json-dir";
import { lastPause, quietContext, quietDays, quietPerDay, scheduleSpend } from "../src/server/quiet";
import { ScheduleHistoryDigests } from "../src/server/schedule-history";
import { Scheduler } from "../src/server/scheduler";
import { Store } from "../src/server/store";
import type { Huddle, Job, ScheduleHistoryEntry, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const board = () => {
  const store = new Store(tempDir("ck-home-"));
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" });
  return store;
};
/** The same data folder as another daemon or the command line would see it: its own Store. */
const other = (s: Store) => new Store(s.root);

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, name: id, at: "2030-01-01T00:00:00.000Z", state: "scheduled", action: { kind: "command", command: "true" },
  sourceTicketId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", firedAt: null, result: null, ...extra,
} as Job);

const huddle = (id: string, extra: Partial<Huddle> = {}): Huddle => ({
  id, hostTicket: "t_1", status: "live", maxParticipants: 4, participants: [], findings: [], invited: [], seq: 0,
  createdAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`, ...extra,
} as Huddle);

test("jobs: own writes, another process's writes (renamed or in place) and deletes all show", () => {
  const s = board();
  s.saveJob("p", job("a"));
  s.saveJob("p", job("b", { at: "2029-01-01T00:00:00.000Z" }));
  expect(s.listJobs("p").map((j) => j.id)).toEqual(["b", "a"]);
  // Shared and frozen.
  expect(s.listJobs("p")).toBe(s.listJobs("p"));
  expect(() => ((s.listJobs("p")[0] as Job).name = "x")).toThrow();
  // Another process saves a new job and changes one: both show at once.
  const o = other(s);
  o.saveJob("p", job("c", { state: "done" }));
  o.saveJob("p", { ...job("a"), name: "renamed" });
  expect(s.listJobs("p").map((j) => [j.id, j.name])).toEqual([["b", "b"], ["a", "renamed"], ["c", "c"]]);
  expect(s.openJobs("p").map((j) => j.id)).toEqual(["b", "a"]);
  // A scheduled job's file rewritten in place (no rename: the folder's mtime stays) shows too.
  const file = join(s.root, "profiles", "p", "jobs", "b.json");
  const dirMtime = new Date(Date.now() - 60_000);
  utimesSync(join(s.root, "profiles", "p", "jobs"), dirMtime, dirMtime);
  s.listJobs("p");
  writeFileSync(file, JSON.stringify({ ...job("b", { at: "2029-01-01T00:00:00.000Z" }), name: "edited in place, longer" }));
  utimesSync(join(s.root, "profiles", "p", "jobs"), dirMtime, dirMtime);
  expect(s.listJobs("p").find((j) => j.id === "b")!.name).toBe("edited in place, longer");
  // An old "missed" job reads as skipped, as getJob does.
  o.saveJob("p", job("d", { state: "missed" as never }));
  expect(s.listJobs("p").find((j) => j.id === "d")?.state).toBe("skipped");
  expect(s.openJobs("p").map((j) => j.id)).toEqual(["b", "a"]);
});

test("JsonDir: a finished entry edited in place shows at the next full recheck; a broken file is left out", () => {
  const dir = tempDir("ck-jd-");
  let now = 1_000_000;
  const jd = new JsonDir<{ id: string; done: boolean }>({ match: (f) => f.endsWith(".json"), parse: JSON.parse, sort: (a, b) => a.id.localeCompare(b.id), live: (v) => !v.done, now: () => now });
  writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a", done: true }));
  writeFileSync(join(dir, "b.json"), "{ not json");
  expect(jd.list(dir).map((v) => v.id)).toEqual(["a"]);
  const v1 = jd.version(dir);
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old);
  jd.list(dir);
  writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a2", done: true }));
  utimesSync(dir, old, old);
  expect(jd.list(dir).map((v) => v.id)).toEqual(["a"]); // finished, folder unchanged: not stat'ed every read
  now += JSON_DIR_RECHECK_MS;
  expect(jd.list(dir).map((v) => v.id)).toEqual(["a2"]);
  expect(jd.version(dir)).toBeGreaterThan(v1);
  // The broken file fixed (renamed into place, as every writer does).
  writeFileSync(join(dir, "b.tmp"), JSON.stringify({ id: "b", done: false }));
  renameSync(join(dir, "b.tmp"), join(dir, "b.json"));
  expect(jd.list(dir).map((v) => v.id)).toEqual(["a2", "b"]);
  expect(jd.liveList(dir).map((v) => v.id)).toEqual(["b"]);
});

test("JsonDir: with the daemon's background recheck, reads never stat every file; the recheck finds an in-place edit", async () => {
  const dir = tempDir("ck-jd-");
  let now = 1_000_000;
  const jd = new JsonDir<{ id: string; done: boolean }>({ match: (f) => f.endsWith(".json"), parse: JSON.parse, sort: (a, b) => a.id.localeCompare(b.id), live: (v) => !v.done, now: () => now });
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `${i}.json`), JSON.stringify({ id: String(i).padStart(2, "0"), done: true }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old);
  let pauses = 0;
  await jd.recheck(dir, async () => void pauses++); // not read yet: nothing to recheck, but reads leave it to this now
  expect(pauses).toBe(0);
  expect(jd.list(dir)).toHaveLength(20);
  writeFileSync(join(dir, "3.json"), JSON.stringify({ id: "03-edited", done: true }));
  utimesSync(dir, old, old);
  now += JSON_DIR_RECHECK_MS;
  expect(jd.list(dir).map((v) => v.id)).toContain("03"); // the read itself didn't stat every file
  await jd.recheck(dir, async () => void pauses++);
  expect(pauses).toBe(20);
  expect(jd.list(dir).map((v) => v.id)).toContain("03-edited");
  // A new file still shows at once: the folder's mtime changed.
  writeFileSync(join(dir, "x.json"), JSON.stringify({ id: "x", done: true }));
  expect(jd.list(dir).map((v) => v.id)).toContain("x");
});

test("JsonDir: load() of a folder already read and unchanged doesn't read its names", async () => {
  const dir = tempDir("ck-jd-");
  writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a" }));
  const jd = new JsonDir<{ id: string }>({ match: (f) => f.endsWith(".json"), parse: JSON.parse, sort: (a, b) => a.id.localeCompare(b.id) });
  await jd.load(dir, async () => {});
  let matched = 0;
  (jd as any).o.match = (f: string) => (matched++, f.endsWith(".json"));
  await jd.load(dir, async () => {});
  expect(matched).toBe(0);
});

test("a huddle's first message and a schedule's first history line don't make the next list read stat every file", () => {
  const s = board();
  s.saveHuddle("p", huddle("h_a"));
  s.saveHuddle("p", huddle("h_b", { status: "closed" }));
  expect(s.huddleIndex("p")).toHaveLength(2);
  const v = s.huddlesVersion("p");
  const reads: string[] = [];
  const jd = (s as any).huddleFiles;
  const rescan = jd.rescan.bind(jd);
  jd.rescan = (...a: unknown[]) => (reads.push("rescan"), rescan(...a));
  s.appendHuddleMessage("p", "h_b", { seq: 1, from: "main", kind: "message", text: "Hi", mentions: [], at: "2026-01-01T00:00:00.000Z" } as any);
  expect(s.huddleIndex("p")).toHaveLength(2);
  expect(s.huddlesVersion("p")).toBe(v);
  expect(reads).toEqual([]);
  // Another process's new huddle still shows (the folder changed under the cache too).
  other(s).saveHuddle("p", huddle("h_c"));
  expect(s.huddleIndex("p").map((h) => h.id)).toEqual(["h_a", "h_b", "h_c"]);
  expect(reads).toEqual(["rescan"]);
});

test("JsonDir: a slow first read (load) gives the same list", async () => {
  const dir = tempDir("ck-jd-");
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, `${i}.json`), JSON.stringify({ id: String(i).padStart(2, "0") }));
  const jd = new JsonDir<{ id: string }>({ match: (f) => f.endsWith(".json"), parse: JSON.parse, sort: (a, b) => a.id.localeCompare(b.id) });
  let pauses = 0;
  await jd.load(dir, async () => void pauses++);
  expect(pauses).toBe(50);
  expect(jd.list(dir)).toHaveLength(50);
  expect(jd.list(dir)[0].id).toBe("00");
});

test("huddles: a save replaces one entry; another process's save and an in-place edit of an open huddle show", () => {
  const s = board();
  s.saveHuddle("p", huddle("h_1"));
  s.saveHuddle("p", huddle("h_2", { status: "closed" }));
  const v = s.huddlesVersion("p");
  expect(s.huddleIndex("p").map((h) => h.id)).toEqual(["h_1", "h_2"]);
  expect(s.openHuddles("p").map((h) => h.id)).toEqual(["h_1"]);
  // The saved huddle is a copy: changing the caller's object later doesn't change the index.
  const mine = huddle("h_3");
  s.saveHuddle("p", mine);
  mine.seq = 99;
  expect(s.huddleIndex("p").find((h) => h.id === "h_3")!.seq).toBe(0);
  expect(s.huddlesVersion("p")).not.toBe(v);
  // listHuddles still gives copies to change.
  s.listHuddles("p")[0].seq = 42;
  expect(s.huddleIndex("p")[0].seq).toBe(0);
  // Another process.
  other(s).saveHuddle("p", { ...huddle("h_1"), seq: 7 });
  expect(s.huddleIndex("p")[0].seq).toBe(7);
  // An open huddle's file rewritten in place from outside.
  const dir = join(s.root, "profiles", "p", "huddles");
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old);
  s.huddleIndex("p");
  writeFileSync(join(dir, "h_1.json"), JSON.stringify({ ...huddle("h_1"), seq: 1234 }));
  utimesSync(dir, old, old);
  expect(s.huddleIndex("p")[0].seq).toBe(1234);
  expect(s.getHuddle("p", "h_1")!.seq).toBe(1234);
});

test("huddle message logs: shared frozen arrays, only the last 20 huddles kept, a log replaced from outside read again", () => {
  const s = board();
  const msg = (seq: number) => ({ seq, from: "main", kind: "message", text: `m${seq}`, at: "2026-01-01T00:00:00.000Z" } as never);
  for (let h = 0; h < 25; h++) for (let n = 1; n <= 3; n++) s.appendHuddleMessage("p", `h_${h}`, msg(n));
  for (let h = 0; h < 25; h++) expect(s.readHuddleMessages("p", `h_${h}`).map((m) => m.seq)).toEqual([1, 2, 3]);
  expect((s as any).huddleLogs.size).toBe(20);
  // A missing mentions list reads as empty, as before.
  expect(s.readHuddleMessages("p", "h_0")[0].mentions).toEqual([]);
  const a = s.readHuddleMessages("p", "h_1");
  s.appendHuddleMessage("p", "h_1", msg(4));
  const b = s.readHuddleMessages("p", "h_1");
  expect(a).toHaveLength(3); // the old snapshot stays as it was
  expect(b.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  const file = join(s.root, "profiles", "p", "huddles", "h_1.messages.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
  expect(s.readHuddleMessages("p", "h_1").map((m) => m.seq)).toEqual([1, 2]);
});

/** The listing as a fresh Store builds it from the files (what the patched list must equal; tickets with the same order may come in any order). */
const byOrder = (ts: Ticket[]) => {
  ts.forEach((t, i) => i && expect(ts[i - 1].order).toBeLessThanOrEqual(t.order));
  return ts.map((t) => [t.id, t.status, t.order, t.title]).sort((a, b) => (a[2] as number) - (b[2] as number) || String(a[0]).localeCompare(String(b[0])));
};
const rebuilt = (s: Store) => byOrder(other(s).listTickets("p"));

test("tickets: writes patch the list in place, it stays equal to a full rebuild, and the open list follows", () => {
  const s = board();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(s.createTicket("p", { title: `T${i}`, body: "", status: i % 3 === 0 ? "done" : i % 3 === 1 ? "backlog" : "ready" }).id);
  const listed = () => byOrder(s.listTickets("p"));
  expect(listed()).toEqual(rebuilt(s));
  let v = s.ticketsVersion("p");
  const steps: (() => unknown)[] = [
    () => s.updateTicket("p", ids[1], { title: "renamed" }),
    () => s.updateTicket("p", ids[2], { status: "in_progress" }),
    () => s.updateTicket("p", ids[4], { status: "done" }),
    () => s.updateTicket("p", ids[0], { status: "backlog" }),
    () => s.updateTicket("p", ids[5], { order: -100 }),
    () => s.updateTicket("p", ids[7], { order: 1000 }),
    () => s.deleteTicket("p", ids[8]),
    () => s.createTicket("p", { title: "new", body: "", status: "ready" }),
  ];
  for (const step of steps) {
    step();
    expect(listed()).toEqual(rebuilt(s));
    expect(s.listOpenTickets("p").map((t) => t.id)).toEqual(s.listTickets("p").filter((t) => t.status !== "done").map((t) => t.id));
    const next = s.ticketsVersion("p");
    expect(next).toBeGreaterThan(v);
    v = next;
  }
  // The caller's own array.
  s.listOpenTickets("p").pop();
  expect(s.listOpenTickets("p")).toHaveLength(s.listTickets("p").filter((t) => t.status !== "done").length);
  // Entry order still works from the open list.
  const readyMax = Math.max(...s.listTickets("p").filter((t) => t.status === "ready").map((t) => t.order));
  expect(s.nextOrder("p", "ready")).toBe(readyMax + 1);
  const doneMin = Math.min(...s.listTickets("p").filter((t) => t.status === "done").map((t) => t.order));
  expect(s.topOrder("p", "done")).toBe(doneMin - 1);
  expect(s.nextOrder("p", "review")).toBe(1);
});

test("tickets: a ticket edited by another process shows in the open list too", () => {
  const s = board();
  const t = s.createTicket("p", { title: "A", body: "", status: "backlog" });
  expect(s.listOpenTickets("p").map((x) => x.id)).toEqual([t.id]);
  other(s).updateTicket("p", t.id, { status: "done" });
  // Seen once the ticket is read (a listing re-check or a get): then both lists follow.
  s.getTicket("p", t.id);
  expect(s.listOpenTickets("p")).toEqual([]);
  expect(s.listTickets("p").map((x: Ticket) => x.status)).toEqual(["done"]);
});

const entries = (n: number, start: number): ScheduleHistoryEntry[] => {
  const out: ScheduleHistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(start + i * 3600_000).toISOString();
    if (i % 7 === 3) out.push({ at, kind: "edited", action: i % 14 === 3 ? "paused" : "resumed", fields: [], by: i % 2 ? "user" : { ticketId: "t_x" } } as ScheduleHistoryEntry);
    else if (i % 2) out.push({ at, kind: "quiet", ticketId: `t_${i - 1}`, summary: "nothing", costUsd: 0.5 });
    else out.push({ at, kind: "fired", trigger: "schedule", ticketId: `t_${i}` });
  }
  return out;
};

test("schedule history digest: same figures as reading the whole file, after appends and rewrites", () => {
  const dir = tempDir("ck-sh-");
  const file = join(dir, "s.history.jsonl");
  const digests = new ScheduleHistoryDigests();
  const all = entries(400, Date.now() - 300 * 3600_000);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const check = (written: ScheduleHistoryEntry[]) => {
    const d = digests.get(file);
    expect(quietDays(d.quietPerDay)).toEqual(quietPerDay(written));
    expect(d.lastPause).toEqual(lastPause(written));
    expect(scheduleSpend(d.recent, since, () => 1)).toBe(scheduleSpend(written, since, () => 1));
    for (const run of ["t_398", "t_396", "t_nope"]) expect(quietContext([], d.lastFired, "s", run)).toEqual(quietContext([], written, "s", run));
  };
  writeFileSync(file, all.slice(0, 200).map((e) => JSON.stringify(e)).join("\n") + "\n");
  check(all.slice(0, 200));
  appendFileSync(file, all.slice(200, 399).map((e) => JSON.stringify(e)).join("\n") + "\n" + JSON.stringify(all[399]).slice(0, 10));
  check(all.slice(0, 399)); // a half-written last line waits
  appendFileSync(file, JSON.stringify(all[399]).slice(10) + "\n");
  check(all);
  // Replaced by a shorter file (from outside): read again from the start.
  writeFileSync(file, all.slice(0, 50).map((e) => JSON.stringify(e)).join("\n") + "\n");
  check(all.slice(0, 50));
  // Rewritten with the same size but other content.
  // The last fire an hour later: same length, another "last check".
  const lastFire = all.slice(0, 50).findLastIndex((e) => e.kind === "fired");
  const swapped = all.slice(0, 50).map((e, i) => (i === lastFire ? { ...e, at: new Date(Date.parse(e.at) + 3600_000).toISOString() } : e));
  expect(quietContext([], swapped, "s", "t_nope").lastCheckAt).not.toBe(quietContext([], all.slice(0, 50), "s", "t_nope").lastCheckAt);
  const text = swapped.map((e) => JSON.stringify(e)).join("\n") + "\n";
  expect(text.length).toBe(readFileSync(file, "utf8").length);
  const later = new Date(Date.now() + 5000);
  writeFileSync(file, text);
  utimesSync(file, later, later);
  check(swapped);
});

test("schedule history view reads only the file's end and shows the same 100 entries", () => {
  const store = board();
  const bus = new Bus();
  const b = new Board(store, bus, { claudeBin: "/bin/false" });
  const scheduler = new Scheduler(b, store, bus);
  const s = scheduler.create("p", { name: "Audit", title: "Audit", body: "check", cron: "0 9 * * *" });
  const file = join(store.root, "profiles", "p", "schedules", `${s.id}.history.jsonl`);
  // Many quiet runs (each hides its fire), so the newest 200 lines hold fewer than 100 shown entries.
  appendFileSync(file, entries(3000, Date.UTC(2025, 0, 1)).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const full = store.readScheduleHistory("p", s.id);
  const quiet = new Set(full.flatMap((e) => (e.kind === "quiet" ? [e.ticketId] : [])));
  const expected = full.filter((e) => !(e.kind === "fired" && quiet.has(e.ticketId))).slice(-100).reverse();
  expect(scheduler.history("p", s.id).map(({ ticket: _, ...e }) => e)).toEqual(expected);
  const tail = store.scheduleHistoryTail("p", s.id, 10);
  expect(tail.complete).toBe(false);
  expect(tail.entries.length).toBeLessThan(full.length);
  expect(tail.entries).toEqual(full.slice(-tail.entries.length));
  expect(store.scheduleHistoryTail("p", s.id, 1e9)).toEqual({ entries: full, complete: true });
});

test("outputs: the async list equals the sync one (newest first, skipped folders, capped)", async () => {
  const s = board();
  const t = s.createTicket("p", { title: "A", body: "", status: "backlog" });
  expect(await s.listOutputsAsync("p", t.id)).toEqual([]);
  const dir = s.outputsDir("p", t.id);
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x.js"), "x");
  for (let i = 0; i < 2100; i++) {
    const f = join(dir, i % 3 === 0 ? "sub" : i % 3 === 1 ? "sub/deep" : "", `f${i}.txt`);
    writeFileSync(f, "x".repeat(i % 5));
    const at = new Date(Date.UTC(2026, 0, 1) + (i % 700) * 1000);
    utimesSync(f, at, at);
  }
  const sync = s.listOutputs("p", t.id);
  expect(sync).toHaveLength(2000);
  expect(sync.some((f) => f.name.startsWith("node_modules"))).toBe(false);
  expect(await s.listOutputsAsync("p", t.id)).toEqual(sync);
});
