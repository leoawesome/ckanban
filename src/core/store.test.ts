import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_FILES, readJsonlPage, Store, TICKET_RECHECK_MS } from "../src/server/store";
import type { Profile } from "../src/server/types";

let store: Store;
const profile: Profile = {
  name: "Demo", slug: "demo", path: "/tmp/demo", baseBranch: "main",
  maxParallel: 1, model: null, createdAt: "2026-09-29T00:00:00.000Z",
};

beforeEach(() => {
  store = new Store(mkdtempSync(join(tmpdir(), "ck-store-")));
  store.saveProfile(profile);
});

test("config defaults", () => {
  expect(store.config()).toEqual({ port: 7777, prPollMinutes: 5 });
});

test("profile CRUD", () => {
  expect(store.listProfiles().map((p) => p.slug)).toEqual(["demo"]);
  expect(store.getProfile("demo")?.name).toBe("Demo");
  store.saveProfile({ ...profile, maxParallel: 3 });
  expect(store.getProfile("demo")?.maxParallel).toBe(3);
  store.deleteProfile("demo");
  expect(store.getProfile("demo")).toBeNull();
});

test("ticket round-trip with tricky title", () => {
  const title = `He said: "hi" — ✨`;
  const t = store.createTicket("demo", { title, body: "line1\n---\nline2", status: "backlog" });
  const got = store.getTicket("demo", t.id)!;
  expect(got.title).toBe(title);
  expect(got.body).toBe("line1\n---\nline2");
  expect(got.status).toBe("backlog");
  expect(got.outcome).toBeNull();
  expect(store.listTickets("demo").length).toBe(1);
});

test("new tickets append in Ready and go on top elsewhere", () => {
  const a = store.createTicket("demo", { title: "a", body: "", status: "ready" });
  const b = store.createTicket("demo", { title: "b", body: "", status: "ready" });
  const c = store.createTicket("demo", { title: "c", body: "", status: "backlog" });
  const d = store.createTicket("demo", { title: "d", body: "", status: "backlog" });
  expect(b.order).toBe(a.order + 1);
  expect(c.order).toBe(1);
  expect(d.order).toBe(c.order - 1);
  expect(store.listTickets("demo").filter((t) => t.status === "backlog").map((t) => t.title)).toEqual(["d", "c"]);
});

test("changing column puts the ticket on top, except Ready which appends", () => {
  const r1 = store.createTicket("demo", { title: "r1", body: "", status: "ready" });
  const v1 = store.createTicket("demo", { title: "v1", body: "", status: "review" });
  const v2 = store.createTicket("demo", { title: "v2", body: "", status: "review" });
  const x = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  expect(store.updateTicket("demo", x.id, { status: "review" }).order).toBe(Math.min(v1.order, v2.order) - 1);
  expect(store.updateTicket("demo", x.id, { status: "ready" }).order).toBe(r1.order + 1);
});

test("explicit order wins and same-column updates keep the position", () => {
  store.createTicket("demo", { title: "v1", body: "", status: "review" });
  const x = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  expect(store.updateTicket("demo", x.id, { status: "review", order: 2.5 }).order).toBe(2.5);
  expect(store.updateTicket("demo", x.id, { status: "review", title: "renamed" }).order).toBe(2.5);
  expect(store.updateTicket("demo", x.id, { body: "edited", lastActivity: "working" }).order).toBe(2.5);
});

test("comments append in order", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.addComment("demo", t.id, "user", "first");
  store.addComment("demo", t.id, "ai", "second");
  expect(store.listComments("demo", t.id).map((c) => [c.author, c.text])).toEqual([
    ["user", "first"], ["ai", "second"],
  ]);
});

test("activity append/read", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  store.appendActivity("demo", t.id, 1, { type: "system" });
  store.appendActivity("demo", t.id, 1, { type: "result" });
  const a = store.readActivity("demo", t.id);
  expect(a.map((e) => e.event.type)).toEqual(["system", "result"]);
  expect(a[0].run).toBe(1);
});

test("corrupt ticket listed with error", () => {
  const dir = join(store.root, "profiles", "demo", "tickets", "t_bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), "garbage without frontmatter");
  const list = store.listTickets("demo");
  const bad = list.find((t) => t.id === "t_bad")!;
  expect(bad.error).toStartWith("corrupt");
});

test("parentId round-trips; tickets without it still load", () => {
  const planner = store.createTicket("demo", { title: "plan", body: "", status: "planning" });
  const child = store.createTicket("demo", { title: "child", body: "b", status: "backlog", parentId: planner.id });
  expect(store.getTicket("demo", child.id)!.parentId).toBe(planner.id);
  expect(store.getTicket("demo", planner.id)!.parentId).toBeUndefined();
  expect(readFileSync(store.ticketPath("demo", planner.id), "utf8")).not.toContain("parentId");
});

test("lastAiComment returns Claude's last comment and sees new ones", () => {
  const t = store.createTicket("demo", { title: "x", body: "", status: "backlog" });
  expect(store.lastAiComment("demo", t.id)).toBeNull();
  store.addComment("demo", t.id, "ai", "first result");
  store.addComment("demo", t.id, "user", "thanks");
  expect(store.lastAiComment("demo", t.id)).toBe("first result");
  store.addComment("demo", t.id, "ai", "second result");
  expect(store.lastAiComment("demo", t.id)).toBe("second result");
});

test("listOutputs skips dependency and build folders, ignores symlinks and caps the list", () => {
  const t = store.createTicket("demo", { title: "o", body: "", status: "backlog" });
  const dir = store.outputsDir("demo", t.id);
  mkdirSync(join(dir, "qa/app/node_modules/x"), { recursive: true });
  mkdirSync(join(dir, "qa/app/.next"), { recursive: true });
  writeFileSync(join(dir, "qa/report.md"), "r");
  writeFileSync(join(dir, "qa/app/page.tsx"), "p");
  writeFileSync(join(dir, "qa/app/node_modules/x/index.js"), "x");
  writeFileSync(join(dir, "qa/app/.next/build.js"), "b");
  symlinkSync(dir, join(dir, "qa/loop"));
  expect(store.listOutputs("demo", t.id).map((f) => f.name).sort()).toEqual(["qa/app/page.tsx", "qa/report.md"]);
  for (let i = 0; i < MAX_OUTPUT_FILES + 5; i++) writeFileSync(join(dir, `f${i}.txt`), "");
  expect(store.listOutputs("demo", t.id).length).toBe(MAX_OUTPUT_FILES);
});

test("ticket reads reuse the parse and hand out frozen tickets; listings follow Store writes at once", () => {
  const t = store.createTicket("demo", { title: "a", body: "", status: "backlog", needs: ["db"] });
  const got = store.getTicket("demo", t.id)!;
  expect(() => { got.title = "mutated"; }).toThrow();
  expect(() => got.needs!.push("other")).toThrow();
  expect(store.listTickets("demo")[0]).toBe(got);
  const v = store.ticketsVersion("demo");
  expect(store.ticketsVersion("demo")).toBe(v);
  store.updateTicket("demo", t.id, { title: "b" });
  expect(store.listTickets("demo")[0].title).toBe("b");
  expect(store.ticketsVersion("demo")).toBeGreaterThan(v);
  const u = store.createTicket("demo", { title: "u", body: "", status: "backlog" });
  expect(store.listTickets("demo").map((x) => x.id)).toEqual([u.id, t.id]);
  store.deleteTicket("demo", t.id);
  expect(store.getTicket("demo", t.id)).toBeNull();
  expect(store.listTickets("demo").map((x) => x.id)).toEqual([u.id]);
  // The caller's own array: sorting it doesn't touch the cache.
  store.listTickets("demo").reverse();
});

test("a ticket.md edited outside the Store shows in the listing by the slow re-check", () => {
  let now = 1_000_000;
  store = new Store(store.root, { now: () => now });
  const t = store.createTicket("demo", { title: "b", body: "", status: "backlog" });
  expect(store.listTickets("demo")[0].title).toBe("b");
  const v = store.ticketsVersion("demo");
  const file = store.ticketPath("demo", t.id);
  writeFileSync(file, readFileSync(file, "utf8").replace("title: b", "title: c"));
  expect(store.listTickets("demo")[0].title).toBe("b");
  now += TICKET_RECHECK_MS;
  expect(store.listTickets("demo")[0].title).toBe("c");
  expect(store.ticketsVersion("demo")).toBeGreaterThan(v);
  // Reading the one ticket sees the edit at once, and so does the listing after it.
  writeFileSync(file, readFileSync(file, "utf8").replace("title: c", "title: d"));
  expect(store.getTicket("demo", t.id)!.title).toBe("d");
  expect(store.listTickets("demo")[0].title).toBe("d");
});

test("with background rechecks a listing never re-stats on time alone; recheckTickets finds outside edits", async () => {
  let now = 1_000_000;
  store = new Store(store.root, { now: () => now });
  const t = store.createTicket("demo", { title: "b", body: "", status: "backlog" });
  await store.recheckTickets(0);
  expect(store.listTickets("demo").find((x) => x.id === t.id)!.title).toBe("b");
  const file = store.ticketPath("demo", t.id);
  writeFileSync(file, readFileSync(file, "utf8").replace("title: b", "title: c"));
  now += TICKET_RECHECK_MS * 3;
  expect(store.listTickets("demo").find((x) => x.id === t.id)!.title).toBe("b");
  const v = store.ticketsVersion("demo");
  await store.recheckTickets(0);
  expect(store.listTickets("demo").find((x) => x.id === t.id)!.title).toBe("c");
  expect(store.ticketsVersion("demo")).toBeGreaterThan(v);
});

test("activity pages: newest first page, older pages back to the first entry, a half-written last line left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-page-"));
  const file = join(dir, "activity.jsonl");
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ run: 1, at: `t${i}`, event: { type: "x", text: "a".repeat(i % 7 === 0 ? 300 : 20) } }));
  writeFileSync(file, lines.join("\n") + "\n" + '{"run":1,"at":"partial","ev');
  const pageOf = (before?: number) => readJsonlPage<{ at: string }>(file, { before, maxBytes: 200 });

  const first = pageOf();
  expect(first.entries.at(-1)!.at).toBe("t49");
  expect(first.before).not.toBeNull();
  const seen: string[] = [];
  let page = first;
  for (let guard = 0; ; guard++) {
    seen.unshift(...page.entries.map((e) => e.at));
    if (page.before === null || guard > 100) break;
    page = pageOf(page.before);
  }
  expect(seen).toEqual(lines.map((_, i) => `t${i}`));

  // The writer finishes the line: the next newest page has it.
  writeFileSync(file, lines.join("\n") + "\n" + '{"run":1,"at":"done","event":{}}\n');
  expect(pageOf().entries.at(-1)!.at).toBe("done");
  // A line longer than the page still comes back whole.
  expect(readJsonlPage<{ at: string }>(file, { maxBytes: 5 }).entries.map((e) => e.at)).toEqual(["done"]);
  // Same as reading the whole file when it fits in one page.
  expect(readJsonlPage(file).entries).toEqual(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  expect(readJsonlPage(file).before).toBeNull();
  expect(readJsonlPage(join(dir, "missing.jsonl"))).toEqual({ entries: [], before: null });
});

test("a ticket written or deleted while the first listing reads in slices shows as it is now", async () => {
  for (let i = 0; i < 20; i++) store.createTicket("demo", { title: `T${i}`, body: "", status: "backlog" });
  const names = readdirSync(join(store.root, "profiles", "demo", "tickets"));
  const midRead = async (write: (fresh: Store) => void) => {
    const fresh = new Store(store.root);
    // Pauses before every ticket: the write lands after the read passed the first few.
    const reading = fresh.listTicketsSliced("demo", -1);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    write(fresh);
    await reading;
    return fresh;
  };
  // Same column (a status change asks for the column's order, which lists the board and so already shows it).
  let fresh = await midRead((f) => f.updateTicket("demo", names[0], { title: "Renamed mid-read" }));
  expect(fresh.listTickets("demo").find((t) => t.id === names[0])?.title).toBe("Renamed mid-read");
  expect(fresh.listOpenTickets("demo").find((t) => t.id === names[0])?.title).toBe("Renamed mid-read");
  // Another write later doesn't bring the old copy back.
  fresh.updateTicket("demo", names[5], { title: "Other" });
  expect(fresh.listTickets("demo").find((t) => t.id === names[0])?.title).toBe("Renamed mid-read");
  fresh = await midRead((f) => f.deleteTicket("demo", names[1]));
  expect(fresh.listTickets("demo").some((t) => t.id === names[1])).toBe(false);
  expect(fresh.listTickets("demo")).toHaveLength(19);
});

test("the first listing after a start can be read in slices, with the same tickets in the same order", async () => {
  for (let i = 0; i < 30; i++) store.createTicket("demo", { title: `T${i}`, body: "", status: i % 3 ? "done" : "backlog" });
  // What a Store that just started on the same folder lists the normal way (tickets on the same spot keep folder order).
  const expected = new Store(store.root).listTickets("demo").map((t) => t.id);
  const fresh = new Store(store.root);
  const sliced = await fresh.listTicketsSliced("demo", 0);
  expect(sliced.map((t) => t.id)).toEqual(expected);
  // Later listings come from memory, and a write still shows at once.
  expect(fresh.listTickets("demo").map((t) => t.id)).toEqual(expected);
  const added = fresh.createTicket("demo", { title: "New", body: "", status: "backlog" });
  expect((await fresh.listTicketsSliced("demo")).some((t) => t.id === added.id)).toBe(true);
  // loadAllTickets warms every board the same way.
  const other = new Store(store.root);
  await other.loadAllTickets(0);
  expect(other.listTickets("demo").length).toBe(expected.length + 1);
});
