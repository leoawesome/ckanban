// Outside-in contract: what the user does around a ticket's run, on the fake Claude's per-ticket scripts: queued
// messages (send, edit, delete), fresh chat, fresh session, take-over, link-session, the spending cap (fake mode
// budget) and cap-continue, a stalled run (no output for the board's stall time) and the stall actions, devices let go
// at a run's end, activity paging and the ticket's /usage. See contracts/api.md ("Ticket chat, runs and conversation",
// "Ticket cards, family, plans and work", "Browsers and devices").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { Scripts, scriptDir, running, settled, view } from "./runs";

let d: Daemon;
let s: Scripts;
let root: string;
let anchor: string;
const SLUG = "control";
const T = `/api/profiles/${SLUG}/tickets`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ck-contract-control-"));
  s = new Scripts(scriptDir(root));
  d = await startDaemon({ env: { FAKE_SCRIPT_DIR: s.dir } });
  expect((await d.api("POST", "/api/profiles", { name: "Control", path: d.project })).status).toBe(201);
  anchor = (await d.api("POST", T, { title: "Anchor", body: "" })).data.id;
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

const dir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(dir(id), "ticket.md"), "utf8")).meta;
const comments = (id: string) => readJsonl(join(dir(id), "comments.jsonl"));

/** A ticket that isn't a main ticket (partOf), so its runs are plain work runs. */
async function create(title: string, body: string, status = "ready"): Promise<any> {
  const r = await d.api("POST", T, { title, body, status, mode: "auto", partOf: anchor });
  expect(r.status).toBe(201);
  return r.data;
}

describe("queued messages", () => {
  test("a message sent while the run works is queued; after a Stop it is unsent and can be edited, sent or discarded", async () => {
    const gate = s.gate("queue");
    const t = await create("Queue", `x ${s.set("queue", [{ waitFile: gate.file }, { summary: "Answered the edited one." }])}`);
    // Claude itself is going (not only the board's setup before it).
    await until(() => s.runs("queue").length === 1, 30_000, "the fake to start");
    const sent = await d.api("POST", `${T}/${t.id}/chat`, { text: "first note" });
    expect(sent.status).toBe(202);
    expect((await d.api("POST", `${T}/${t.id}/chat`, { text: "second note" })).status).toBe(202);
    expect((await d.api("POST", `${T}/${t.id}/stop`, {})).data.stopped).toBe(true);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("stopped");
    gate.release();
    // Messages the stopped run never read are kept as unsent (in ticket.md too).
    const queued = (v.queued ?? []) as any[];
    expect(queued.map((q) => q.text)).toEqual(["first note", "second note"]);
    expect(queued.every((q) => q.state === "unsent" && typeof q.id === "string" && typeof q.at === "string")).toBe(true);
    expect(meta(t.id).queued.map((q: any) => q.state)).toEqual(["unsent", "unsent"]);
    const [a, b] = queued;

    // Edit: empty text 400, unknown id 404.
    expect((await d.api("PATCH", `${T}/${t.id}/queued/${a.id}`, { text: " " })).status).toBe(400);
    expect((await d.api("PATCH", `${T}/${t.id}/queued/nope`, { text: "x" })).status).toBe(404);
    const edited = await d.api("PATCH", `${T}/${t.id}/queued/${a.id}`, { text: "first note, edited" });
    expect(edited.status).toBe(200);
    expect(edited.data.queued.find((q: any) => q.id === a.id).text).toBe("first note, edited");
    // Delete the second one.
    const del = await d.api("DELETE", `${T}/${t.id}/queued/${b.id}`);
    expect(del.status).toBe(200);
    expect(del.data.queued.map((q: any) => q.id)).toEqual([a.id]);
    expect((await d.api("DELETE", `${T}/${t.id}/queued/${b.id}`)).status).toBe(404);
    // Send the edited one: a run resumes the session with it.
    const go = await d.api("POST", `${T}/${t.id}/queued/${a.id}`, {});
    expect(go.status).toBe(202);
    await until(() => s.runs("queue").length === 2, 30_000, "run for the sent message");
    const after = await settled(d, SLUG, t.id, (x) => (x.queued ?? []).length === 0);
    expect(after.runCount).toBe(2);
    const second = s.runs("queue")[1];
    expect(second.args[second.args.indexOf("--resume") + 1]).toBe(v.sessionId);
    const prompt = second.prompt;
    expect(prompt).toContain("first note, edited");
    expect(prompt).not.toContain("second note");
  }, 60_000);
});

describe("sessions: fresh chat, fresh session, take-over, link-session", () => {
  test("fresh chat: the next message starts a new session; the old one is kept as an earlier session", async () => {
    const t = await create("Fresh chat", `x ${s.set("freshchat", [{}, {}])}`);
    const first = await settled(d, SLUG, t.id, (x) => x.status === "review");
    const r = await d.api("POST", `${T}/${t.id}/fresh-chat`, {});
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("review");
    expect(r.data.sessionId).not.toBe(first.sessionId);
    expect(r.data.freshSession).toBe(true);
    expect(meta(t.id).earlierSessions.map((e: any) => e.sessionId)).toContain(first.sessionId);
    expect(comments(t.id).at(-1).text).toStartWith("Started a fresh chat");
    expect((await d.api("POST", `${T}/${t.id}/fresh-chat`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    expect((await d.api("POST", `${T}/${t.id}/chat`, { text: "new start" })).status).toBe(202);
    await until(() => s.runs("freshchat").length === 2, 30_000, "fresh chat run");
    await settled(d, SLUG, t.id, (x) => x.runCount === 2);
    const args = s.runs("freshchat")[1].args;
    expect(args[args.indexOf("--session-id") + 1]).toBe(r.data.sessionId);
    expect(args).not.toContain("--resume");
  }, 60_000);

  test("fresh session: a new session and a work run at once; refused while running (409) and from a run (403)", async () => {
    const gate = s.gate("freshsess");
    const t = await create("Fresh session", `x ${s.set("freshsess", [{ waitFile: gate.file }, {}])}`);
    await running(d, SLUG, t.id);
    expect((await d.api("POST", `${T}/${t.id}/fresh-session`, {})).status).toBe(409);
    expect((await d.api("POST", `${T}/${t.id}/fresh-chat`, {})).status).toBe(409);
    gate.release();
    const first = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect((await d.api("POST", `${T}/${t.id}/fresh-session`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    const r = await d.api("POST", `${T}/${t.id}/fresh-session`, {});
    expect(r.status).toBe(200);
    expect(r.data.external).toBe(false);
    expect(r.data.ticket.sessionId).not.toBe(first.sessionId);
    await until(() => s.runs("freshsess").length === 2, 30_000, "fresh session run");
    const v = await settled(d, SLUG, t.id, (x) => x.runCount === 2);
    const args = s.runs("freshsess")[1].args;
    expect(args[args.indexOf("--session-id") + 1]).toBe(v.sessionId);
    expect(comments(t.id).some((c) => c.text.startsWith("Started a fresh session"))).toBe(true);
  }, 60_000);

  test("take-over with no terminal holding the session resumes the run here", async () => {
    const t = await create("Take over", `x ${s.set("takeover", [{}, {}])}`);
    const first = await settled(d, SLUG, t.id, (x) => x.status === "review");
    const r = await d.api("POST", `${T}/${t.id}/take-over`, {});
    expect(r.status).toBe(200);
    expect(r.data.external).toBe(false);
    await until(() => s.runs("takeover").length === 2, 30_000, "take-over run");
    await settled(d, SLUG, t.id, (x) => x.runCount === 2);
    const args = s.runs("takeover")[1].args;
    expect(args[args.indexOf("--resume") + 1]).toBe(first.sessionId);
    expect(comments(t.id).some((c) => c.text.startsWith("Took over the session"))).toBe(true);
    expect((await d.api("POST", `${T}/${t.id}/take-over`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
  }, 60_000);

  test("link-session links an existing Claude session (Review, run count 0) and unlinks it", async () => {
    const t = await create("Linked", "x", "backlog");
    expect((await d.api("POST", `${T}/${t.id}/link-session`, { sessionId: "not-a-uuid" })).status).toBe(400);
    const sid = crypto.randomUUID();
    const r = await d.api("POST", `${T}/${t.id}/link-session`, { sessionId: sid });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ sessionId: sid, status: "review", runCount: 0, worktree: null });
    expect(meta(t.id)).toMatchObject({ sessionId: sid, status: "review" });
    const un = await d.api("POST", `${T}/${t.id}/link-session`, { sessionId: null });
    expect(un.status).toBe(200);
    expect(un.data.sessionId).toBeNull();
  });
});

describe("spending cap", () => {
  test("a run that reaches the ticket's cap ends blocked; cap-continue goes on with more budget", async () => {
    const t = await create("Capped", `x ${s.set("cap", [{ mode: "budget" }, { summary: "Finished with more budget." }])}`, "backlog");
    expect((await d.api("PATCH", `${T}/${t.id}`, { runCapUsd: 0.05 })).status).toBe(200);
    expect((await d.api("PATCH", `${T}/${t.id}`, { status: "ready" })).status).toBe(200);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("blocked");
    expect(v.error).toBe("Stopped at $0.05 cap");
    expect(v.capHit).toMatchObject({ capUsd: 0.05 });
    expect(s.runs("cap")[0].args[s.runs("cap")[0].args.indexOf("--max-budget-usd") + 1]).toBe("0.05");
    expect(comments(t.id).some((c) => c.text.startsWith("Stopped at $0.05 cap"))).toBe(true);
    expect((await d.api("POST", `${T}/${t.id}/cap-continue`, { addUsd: 1 }, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    expect((await d.api("POST", `${T}/${t.id}/cap-continue`, { addUsd: -1 })).status).toBe(400);
    const c = await d.api("POST", `${T}/${t.id}/cap-continue`, { addUsd: 1 });
    expect(c.status).toBe(202);
    await until(() => s.runs("cap").length === 2, 30_000, "continued run");
    const after = await settled(d, SLUG, t.id, (x) => x.outcome === "done");
    expect(after.capHit ?? null).toBeNull();
    expect(s.runs("cap")[1].args).toContain("--resume");
  }, 60_000);
});

describe("devices", () => {
  test("a device a run takes is let go when the run ends", async () => {
    expect((await d.api("POST", "/api/devices", { name: "test-phone", description: "A phone" })).status).toBe(200);
    const t = await create("Uses the phone", `x ${s.set("device", [{
      calls: [{ method: "POST", path: `${T}/{ticket}/devices`, body: { action: "take", names: ["test-phone"] } }],
    }])}`);
    await settled(d, SLUG, t.id, (x) => x.status === "review");
    const [take] = s.out("device");
    expect(take.status).toBe(200);
    expect(take.data.ok).toBe(true);
    const list = await d.api("GET", "/api/devices");
    const phone = list.data.find((x: any) => x.name === "test-phone");
    expect(phone.using ?? []).toEqual([]);
    // devices.json keeps the time of the last grant.
    expect(readFileSync(join(d.home, "devices.json"), "utf8")).toContain("lastUsedAt");
  }, 60_000);
});

describe("activity paging and usage", () => {
  test("GET /activity pages the run log by byte offset; GET /usage lists the runs", async () => {
    // The page is 512 KB: the second run writes about 700 KB.
    const t = await create("Many runs", `x ${s.set("pages", [{}, { noiseKb: 700 }, {}])}`);
    await settled(d, SLUG, t.id, (x) => x.status === "review");
    for (const text of ["two", "three"]) {
      expect((await d.api("POST", `${T}/${t.id}/chat`, { text })).status).toBe(202);
      await settled(d, SLUG, t.id, (x) => x.runCount === (text === "two" ? 2 : 3));
    }
    const all = readJsonl(join(dir(t.id), "activity.jsonl"));
    const first = await d.api("GET", `${T}/${t.id}/activity`);
    expect(first.status).toBe(200);
    expect(typeof first.data.before).toBe("number");
    expect(first.data.entries.length).toBeLessThan(readJsonl(join(dir(t.id), "activity.jsonl")).length);
    let entries = [...first.data.entries];
    // before: the byte offset to ask for the earlier page with, null on the first page of the file.
    let before: number | null = first.data.before;
    let pages = 1;
    while (before !== null) {
      const page = await d.api("GET", `${T}/${t.id}/activity?before=${before}`);
      expect(page.status).toBe(200);
      if (page.data.before !== null) expect(page.data.before).toBeLessThan(before);
      entries = [...page.data.entries, ...entries];
      before = page.data.before;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(entries.length).toBe(all.length);
    expect(entries).toEqual(all);
    expect([...new Set(entries.map((e) => e.run))]).toEqual([1, 2, 3]);
    expect((await d.api("GET", `${T}/${t.id}/activity?before=-1`)).status).toBe(400);
    expect((await d.api("GET", `${T}/${t.id}/activity?before=x`)).status).toBe(400);

    const usage = await d.api("GET", `${T}/${t.id}/usage`);
    expect(usage.status).toBe(200);
    expect(Array.isArray(usage.data.runs)).toBe(true);
    expect(usage.data.runs.length).toBe(3);
  }, 60_000);
});

describe("a stalled run", () => {
  test("no output for the board's stall time marks it stalled; restart resumes the same session", async () => {
    expect((await d.api("PATCH", `/api/profiles/${SLUG}`, { stallMinutes: 0.5 })).status).toBe(400);
    expect((await d.api("PATCH", `/api/profiles/${SLUG}`, { stallMinutes: 1 })).status).toBe(200);
    const t = await create("Goes quiet", `x ${s.set("stall", [{ waitFile: join(s.dir, "never") }, { summary: "Back again." }])}`);
    await running(d, SLUG, t.id);
    expect((await d.api("POST", `${T}/${t.id}/stall`, { action: "restart" })).status).toBe(409);
    expect((await d.api("POST", `${T}/${t.id}/stall`, { action: "bogus" })).status).toBe(400);
    expect((await d.api("POST", `${T}/${t.id}/stall`, { action: "wait" }, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    const stalled = await until(async () => {
      const x = await view(d, SLUG, t.id);
      return x.stalled ? x : null;
    }, 150_000, "the stall flag");
    expect(stalled.running).toBe(true);
    expect(meta(t.id).stalled).toBeTruthy();
    const session = stalled.sessionId;
    const r = await d.api("POST", `${T}/${t.id}/stall`, { action: "restart" });
    expect(r.status).toBe(200);
    await until(() => s.runs("stall").length === 2, 30_000, "restarted run");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("done");
    expect(v.stalled ?? null).toBeNull();
    const args = s.runs("stall")[1].args;
    expect(args[args.indexOf("--resume") + 1]).toBe(session);
    expect((await d.api("PATCH", `/api/profiles/${SLUG}`, { stallMinutes: 0 })).status).toBe(200);
  }, 240_000);
});
