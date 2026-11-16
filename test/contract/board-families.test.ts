// Outside-in contract: families (main tickets, tool tickets, groups, gather, partOf, sub-features), plans and
// dependsOn, and the feature status (status.json, status.md, POST .../status). Checks the answers, the files the
// daemon writes (contracts/data-files.md and its schemas) and the errors. See contracts/api.md.
//
// A main ticket's own run adds its tool tickets: the fake Claude's "call" mode makes those API calls with the run
// header, only in runs whose prompt carries CALL_MARK (FAKE_CALL_MATCH), so the tool tickets' own runs make none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { schemaProblems } from "./schema";

let d: Daemon;
const SLUG = "families";
const P = `/api/profiles/${SLUG}`;
const CALL_MARK = "CONTRACT-MAKE-THE-PLAN";
const dir = mkdtempSync(join(tmpdir(), "ck-contract-families-"));
const calls = join(dir, "calls.json");
const out = join(dir, "call-out.jsonl");

beforeAll(async () => {
  writeFileSync(calls, "[]");
  d = await startDaemon({ env: { FAKE_CALLS_FILE: calls, FAKE_CALL_OUT: out, FAKE_CALL_MATCH: CALL_MARK } });
  expect((await d.api("POST", "/api/profiles", { name: "Families", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

const ticketDir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(ticketDir(id), "ticket.md"), "utf8")).meta;
const ticket = async (id: string) => (await d.api("GET", `${P}/tickets/${id}`)).data;
const create = async (body: Record<string, unknown>, headers?: Record<string, string>) => d.api("POST", `${P}/tickets`, body, headers);
const newTicket = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await create({ title, ...extra });
  expect(r.status).toBe(201);
  return r.data;
};
const comments = (id: string) => readJsonl(join(ticketDir(id), "comments.jsonl"));
/** The ticket file checked against contracts/schemas/ticket.schema.json. */
const schemaOk = (id: string) => {
  const { meta: m, body } = parseTicketFile(readFileSync(join(ticketDir(id), "ticket.md"), "utf8"));
  expect(schemaProblems("ticket.schema.json", { ...m, body }, id)).toEqual([]);
};

describe("plans: a main ticket's run adds tool tickets, and a ticket starts when its dependencies are done", () => {
  let main: any;
  let family: any[];
  const step = (title: string) => family.find((r) => r.title === title);

  beforeAll(async () => {
    main = await newTicket("The feature", { body: "Split it in two steps." });
    const run = { "x-ckanban-run": `${SLUG}/${main.id}` };
    writeFileSync(calls, JSON.stringify([
      { method: "POST", path: `${P}/tickets`, headers: run, body: { title: "Step A", body: "do a", planKey: "a" } },
      { method: "POST", path: `${P}/tickets`, headers: run, body: { title: "Step B", body: "do b", planKey: "b", dependsOn: ["a"] } },
      { method: "POST", path: `${P}/tickets`, headers: run, body: { title: "Step C", body: "x", dependsOn: ["no-such-step"] } },
      // A run may not pause its own plan (that is the user's).
      { method: "POST", path: `${P}/tickets/${main.id}/plan`, headers: run, body: { action: "pause" } },
    ]));
    const sent = await d.api("POST", `${P}/tickets/${main.id}/chat`, { text: `${CALL_MARK}: make the plan` });
    expect(sent.status).toBe(202);
    await until(() => readJsonl(out).length >= 4, 30_000, "the main ticket's run to make its calls");
    family = await until(async () => {
      const rows = (await d.api("GET", `${P}/tickets/${main.id}/family`)).data;
      return rows.length === 3 && rows.slice(1).every((r: any) => r.status === "done") ? rows : null;
    }, 45_000, "both tool tickets to finish");
    // Then the plan wakes the main ticket with the results, and finishes.
    await until(async () => {
      const m = await ticket(main.id);
      return m.plan?.state === "done" && !m.running;
    }, 30_000, "the main ticket's plan to finish");
    family = (await d.api("GET", `${P}/tickets/${main.id}/family`)).data;
  }, 120_000);

  test("the run's create calls: 201 tool tickets, 400 for an unknown dependency, 403 for pausing its own plan", () => {
    const answers = readJsonl(out).slice(0, 4);
    expect(answers.map((a) => a.status)).toEqual([201, 201, 400, 403]);
    const a = JSON.parse(answers[0].text);
    const b = JSON.parse(answers[1].text);
    // Tool tickets: under the main ticket by parentId, unattended, never interviewing; the first starts at once.
    expect(a).toMatchObject({ title: "Step A", tool: true, parentId: main.id, planKey: "a", mode: "auto", mainTicket: { id: main.id, title: "The feature" } });
    expect(["in_progress", "backlog"]).toContain(a.status);
    // B waits for A.
    expect(b).toMatchObject({ title: "Step B", tool: true, parentId: main.id, planKey: "b", dependsOn: ["a"], status: "backlog", mode: "auto" });
    expect(JSON.parse(answers[2].text)).toEqual({ error: "unknown dependency no-such-step: use a sibling's ticket id or key" });
    expect(JSON.parse(answers[3].text).error).toBe("a board run may only start or resume its own ticket's plan; pausing and finishing are the user's");
  });

  test("B's run starts only after A's run ended", async () => {
    const a = await ticket(step("Step A").id);
    const b = await ticket(step("Step B").id);
    expect(a).toMatchObject({ status: "done", runCount: 1, outcome: "done" });
    expect(b).toMatchObject({ status: "done", runCount: 1, outcome: "done" });
    expect(Date.parse(b.lastRunAt)).toBeGreaterThanOrEqual(Date.parse(a.runEndedAt));
  });

  test("the files: tool ticket.md fields, its comment, and the main ticket's plan and results", () => {
    const a = step("Step A");
    const b = step("Step B");
    expect(meta(a.id)).toMatchObject({ id: a.id, title: "Step A", status: "done", mode: "auto", parentId: main.id, planKey: "a", tool: true });
    expect(meta(b.id)).toMatchObject({ parentId: main.id, planKey: "b", dependsOn: ["a"], tool: true });
    expect(typeof meta(a.id).doneAt).toBe("string");
    for (const id of [main.id, a.id, b.id]) schemaOk(id);
    expect(comments(a.id)[0]).toMatchObject({ author: "ai", text: `Tool ticket of ${main.id} ("The feature").` });
    const m = meta(main.id);
    expect(m.main).toBe(true);
    expect(m.plan.state).toBe("done");
    expect(Object.keys(m.plan.seen).sort()).toEqual([a.id, b.id].sort());
    expect(m.results.map((r: any) => r.ticketId)).toEqual([a.id, b.id]);
    expect(m.results[0]).toMatchObject({ title: "Step A", outcome: "done", summary: "fake done" });
  });

  test("GET /family and /family-view list the family from the top", async () => {
    expect(family.map((r) => [r.title, r.depth, r.parent, r.how])).toEqual([
      ["The feature", 0, null, null],
      ["Step A", 1, main.id, "plan"],
      ["Step B", 1, main.id, "plan"],
    ]);
    expect(family[1]).toMatchObject({ task: true, prUrl: null, result: "fake done" });
    expect(Object.keys(family[0]).sort()).toEqual(["depth", "how", "id", "parent", "prUrl", "result", "resumeCommand", "sessionId", "status", "title", "updatedAt"]);
    // Any member answers with the same family.
    expect((await d.api("GET", `${P}/tickets/${step("Step B").id}/family`)).data.map((r: any) => r.id)).toEqual(family.map((r) => r.id));
    const view = (await d.api("GET", `${P}/tickets/${main.id}/family-view`)).data;
    expect(view.map((r: any) => [r.id, r.depth, r.parent])).toEqual(family.map((r) => [r.id, r.depth, r.parent]));
    for (const r of view) {
      expect(Object.keys(r).sort()).toEqual(["costUsd", "depth", "effort", "finishedAt", "id", "model", "needsYou", "parent", "report", "summary"]);
      expect(r).toMatchObject({ needsYou: false, report: false, summary: "fake done" });
    }
  });

  test("the main ticket's view carries its family card; tool tickets carry mainTicket and stay off the list", async () => {
    const m = await ticket(main.id);
    expect(m.familyCard).toMatchObject({ tools: 2, open: 0, toolsDone: 2, tasks: 2, tasksDone: 2, running: [], subFeatures: [] });
    expect(typeof m.familyWorking).toBe("number");
    expect(typeof m.stepsRunning).toBe("number");
    expect((await ticket(step("Step A").id)).mainTicket).toEqual({ id: main.id, title: "The feature" });
    // scope=list leaves tool tickets out unless tool=1.
    const plain = (await d.api("GET", `${P}/tickets?scope=list&status=done`)).data.tickets.map((t: any) => t.id);
    expect(plain).not.toContain(step("Step A").id);
    const tools = (await d.api("GET", `${P}/tickets?scope=list&status=done&tool=1`)).data.tickets.map((t: any) => t.id);
    expect(tools).toEqual(expect.arrayContaining([step("Step A").id, step("Step B").id]));
    // Board listings mark open features.
    const board = (await d.api("GET", `${P}/tickets?scope=board`)).data.tickets;
    expect(board.find((t: any) => t.id === main.id)?.feature).toBe(true);
  });

  test("POST .../plan: actions, a ticket that runs no plan, and the user's pause", async () => {
    const bad = await d.api("POST", `${P}/tickets/${main.id}/plan`, { action: "bogus" });
    expect(bad).toMatchObject({ status: 400, data: { error: "action must be start, pause, resume or done" } });
    const tool = await d.api("POST", `${P}/tickets/${step("Step A").id}/plan`, { action: "start" });
    expect(tool).toMatchObject({ status: 400, data: { error: "only a main ticket runs tickets of its own: turn this ticket into a main ticket first" } });
    const lone = await newTicket("No steps");
    const empty = await d.api("POST", `${P}/tickets/${lone.id}/plan`, { action: "start" });
    expect(empty).toMatchObject({ status: 400, data: { error: "can't start the plan: this ticket has no tool tickets to run" } });
    const paused = await d.api("POST", `${P}/tickets/${main.id}/plan`, { action: "pause" });
    expect(paused.status).toBe(200);
    expect(paused.data.id).toBe(main.id);
    // A run of a ticket outside the family may not touch the plan.
    const other = await d.api("POST", `${P}/tickets/${main.id}/plan`, { action: "start" }, { "x-ckanban-run": `${SLUG}/${lone.id}` });
    expect(other.status).toBe(403);
  });

  test("tickets can't be created under another one from outside a main ticket's run", async () => {
    const r = await create({ title: "Planned", parentId: main.id });
    expect(r.status).toBe(400);
    expect(r.data.error).toStartWith("a ticket can't be created under another one: planned tickets are retired.");
    const clear = await d.api("PATCH", `${P}/tickets/${step("Step A").id}`, { parentId: main.id });
    expect(clear).toMatchObject({ status: 400, data: { error: "parentId can only be cleared (null); use adopt to add a ticket to a plan" } });
  });
});

describe("feature status", () => {
  let top: any;
  let member: any;
  const outputs = () => join(ticketDir(top.id), "outputs");

  beforeAll(async () => {
    top = await newTicket("Status feature");
    member = await newTicket("Status member", { partOf: top.id });
  });

  test("the user's POST writes status.json (schema, pretty, no final newline) and status.md (the markdown)", async () => {
    const r = await d.api("POST", `${P}/tickets/${top.id}/status`, { goal: "Ship it", done: "Wrote the tests", waiting: null });
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["facts", "feature", "markdown", "path", "saved", "sections", "title", "topId"]);
    expect(r.data).toMatchObject({ topId: top.id, title: "Status feature", feature: true, saved: { goal: "Ship it", done: "Wrote the tests" } });
    expect(r.data.path).toBe(join(outputs(), "status.md"));
    expect(r.data.sections.find((s: any) => s.key === "goal")).toEqual({ key: "goal", label: "Goal", text: "Ship it" });

    const raw = readFileSync(join(outputs(), "status.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(false);
    const saved = JSON.parse(raw);
    expect(raw).toBe(JSON.stringify(saved, null, 2));
    expect(schemaProblems("feature-status.schema.json", saved, "status.json")).toEqual([]);
    expect(saved).toMatchObject({ goal: "Ship it", done: "Wrote the tests" });
    expect("waiting" in saved).toBe(false);

    const md = readFileSync(join(outputs(), "status.md"), "utf8");
    expect(md).toBe(r.data.markdown);
    expect(md).toStartWith(`# Where we are: Status feature\n\nFeature ticket ${top.id}, 2 tickets.`);
    expect(md).toContain("\n## Goal\n\nShip it\n");

    // GET reads it back, without the markdown.
    const got = await d.api("GET", `${P}/tickets/${top.id}/status`);
    expect(got.status).toBe(200);
    expect(Object.keys(got.data).sort()).toEqual(["facts", "feature", "path", "saved", "sections", "title", "topId"]);
    expect(got.data.saved).toEqual(saved);
  });

  test("null clears a section (removed from the file); a member's id updates the top ticket's status", async () => {
    const r = await d.api("POST", `${P}/tickets/${member.id}/status`, { done: null, next: "Land it" });
    expect(r.status).toBe(200);
    expect(r.data.topId).toBe(top.id);
    const saved = JSON.parse(readFileSync(join(outputs(), "status.json"), "utf8"));
    expect("done" in saved).toBe(false);
    expect(saved).toMatchObject({ goal: "Ship it", next: "Land it" });
    expect(existsSync(join(ticketDir(member.id), "outputs", "status.json"))).toBe(false);
  });

  test("who may update it: a run in the family yes; another ticket's run, a huddle helper no", async () => {
    const inFamily = await d.api("POST", `${P}/tickets/${top.id}/status`, { broken: "Nothing" }, { "x-ckanban-run": `${SLUG}/${member.id}` });
    expect(inFamily.status).toBe(200);
    const stranger = await newTicket("Stranger");
    const out = await d.api("POST", `${P}/tickets/${top.id}/status`, { broken: "x" }, { "x-ckanban-run": `${SLUG}/${stranger.id}` });
    expect(out.status).toBe(403);
    expect(out.data.error).toBe(`only runs of tickets in this feature may update its status (${stranger.id} is not in ${top.id}'s family), or a chat replying to a message the user typed there`);
    const helper = await d.api("POST", `${P}/tickets/${top.id}/status`, { broken: "x" }, { "x-ckanban-huddle-agent": "tok" });
    expect(helper).toMatchObject({ status: 403, data: { error: "huddle helpers can't change the feature's status; tell @main what to put there" } });
  });

  test("bad bodies", async () => {
    expect(await d.api("POST", `${P}/tickets/${top.id}/status`, {})).toMatchObject({ status: 400, data: { error: "nothing to update: pass goal, done, broken, waiting, next, prNotes or prs" } });
    expect(await d.api("POST", `${P}/tickets/${top.id}/status`, { goal: 3 })).toMatchObject({ status: 400, data: { error: "goal must be text or null" } });
    const prs = await d.api("POST", `${P}/tickets/${top.id}/status`, { prs: ["https://example.com/x"] });
    expect(prs).toMatchObject({ status: 400, data: { error: "prs must be a list of GitHub pull request URLs, e.g. https://github.com/owner/repo/pull/12" } });
    expect((await d.api("POST", `${P}/tickets/${top.id}/status`, { prNotes: [] })).status).toBe(400);
    expect((await d.api("POST", `${P}/tickets/t_20000101_none/status`, { goal: "x" })).status).toBe(404);
  });

  test("status notes: the user's only, saved in status.json", async () => {
    const r = await d.api("POST", `${P}/tickets/${top.id}/status/notes`, { text: "Remember the phone" });
    expect(r.status).toBe(200);
    expect(r.data.saved.notes.at(-1)).toMatchObject({ text: "Remember the phone", delivered: false });
    const saved = JSON.parse(readFileSync(join(outputs(), "status.json"), "utf8"));
    expect(saved.notes.at(-1)).toMatchObject({ text: "Remember the phone", delivered: false });
    expect(schemaProblems("feature-status.schema.json", saved, "status.json")).toEqual([]);
    const run = await d.api("POST", `${P}/tickets/${top.id}/status/notes`, { text: "x" }, { "x-ckanban-run": `${SLUG}/${member.id}` });
    expect(run).toMatchObject({ status: 403, data: { error: "only the user adds notes to the status (Add a note)" } });
    expect((await d.api("POST", `${P}/tickets/${top.id}/status/notes`, { text: "" })).status).toBe(400);
  });
});

describe("partOf, sub-features, groups and gather", () => {
  test("the user's new ticket is a main ticket; with partOf it joins the family; main + partOf is a sub-feature", async () => {
    const top = await newTicket("Top");
    expect(top.main).toBe(true);
    expect(meta(top.id).main).toBe(true);
    const part = await newTicket("Part", { partOf: top.id });
    expect(part.partOf).toBe(top.id);
    expect(part.main).toBeUndefined();
    expect(meta(part.id)).toMatchObject({ partOf: top.id });
    expect(meta(part.id).main).toBeUndefined();
    const sub = await newTicket("Sub", { main: true, partOf: top.id });
    expect(sub).toMatchObject({ main: true, partOf: top.id, subFeatureOf: { id: top.id, title: "Top" } });
    schemaOk(sub.id);

    const fam = (await d.api("GET", `${P}/tickets/${top.id}/family`)).data;
    expect(fam.map((r: any) => [r.id, r.depth, r.parent, r.how])).toEqual(expect.arrayContaining([
      [top.id, 0, null, null], [part.id, 1, top.id, "linked"], [sub.id, 1, top.id, "linked"],
    ]));
    expect(fam.find((r: any) => r.id === sub.id).subFeature).toBe(true);
    expect((await ticket(top.id)).familyCard.subFeatures).toEqual([{ id: sub.id, title: "Sub", working: false }]);
  });

  test("create errors: unknown partOf, gather without main, main with parentId or sessionId, bad main or kind", async () => {
    expect(await create({ title: "X", partOf: "t_20000101_none" })).toMatchObject({ status: 400, data: { error: "ticket t_20000101_none not found (partOf)" } });
    expect(await create({ title: "X", gather: [] })).toMatchObject({ status: 400, data: { error: "gather only works with main: true (use gather_tickets to add tickets to an existing feature)" } });
    expect((await create({ title: "X", main: true, parentId: "t_1" })).status).toBe(400);
    expect(await create({ title: "X", main: true, sessionId: "abc" })).toMatchObject({ status: 400, data: { error: "a main ticket can't be made from a linked session: leave out sessionId" } });
    expect(await create({ title: "X", main: "yes" })).toMatchObject({ status: 400, data: { error: "main must be true or false" } });
    const kind = await create({ title: "X", kind: "nonsense" });
    expect(kind.status).toBe(400);
    expect(kind.data.error).toStartWith("kind must be one of ");
  });

  test("PATCH partOf links, unlinks and refuses bad values", async () => {
    const top = await newTicket("Link top");
    const t = await newTicket("Loose");
    const linked = await d.api("PATCH", `${P}/tickets/${t.id}`, { partOf: top.id });
    expect(linked.status).toBe(200);
    expect(linked.data.partOf).toBe(top.id);
    expect(meta(t.id).partOf).toBe(top.id);
    const unlinked = await d.api("PATCH", `${P}/tickets/${t.id}`, { partOf: null });
    expect(unlinked.data.partOf).toBeNull();
    expect(meta(t.id).partOf).toBeNull();
    expect(await d.api("PATCH", `${P}/tickets/${t.id}`, { partOf: 3 })).toMatchObject({ status: 400, data: { error: "partOf must be a ticket id or null" } });
    expect(await d.api("PATCH", `${P}/tickets/${t.id}`, { partOf: t.id })).toMatchObject({ status: 400, data: { error: "\"Loose\" can't be part of itself" } });
    expect(await d.api("PATCH", `${P}/tickets/${t.id}`, { showOnBoard: "yes" })).toMatchObject({ status: 400, data: { error: "showOnBoard must be true or false" } });
    expect(await d.api("PATCH", `${P}/tickets/${t.id}`, { parentSuggestion: { id: top.id } })).toMatchObject({ status: 400, data: { error: "parentSuggestion can only be cleared (null)" } });
  });

  test("gather: into the feature, into a new group, skipped entries, and its errors", async () => {
    const top = await newTicket("Gather top");
    const g1 = await newTicket("G1");
    const g2 = await newTicket("G2");
    const r = await d.api("POST", `${P}/tickets/${top.id}/gather`, {
      tickets: [{ id: g1.id, group: "new" }, { id: g2.id }, { id: "t_20000101_none" }, { id: top.id }], newGroup: "Phase one",
    });
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["gathered", "group", "kept", "movedUp", "skipped"]);
    const group = r.data.group;
    expect(group).toMatchObject({ title: "Phase one", kind: "group", partOf: top.id, status: "backlog", mode: "auto" });
    expect(meta(group.id)).toMatchObject({ kind: "group", partOf: top.id });
    expect(r.data.gathered.map((t: any) => [t.id, t.partOf])).toEqual([[g1.id, group.id], [g2.id, top.id]]);
    expect(r.data.skipped).toEqual([{ id: "t_20000101_none", reason: "not found" }, { id: top.id, reason: "that is the feature itself" }]);
    expect(meta(g1.id).partOf).toBe(group.id);
    expect(meta(g2.id).partOf).toBe(top.id);

    // A group that isn't one of this feature's is skipped.
    const g3 = await newTicket("G3");
    const wrong = await d.api("POST", `${P}/tickets/${top.id}/gather`, { tickets: [{ id: g3.id, group: g2.id }] });
    expect(wrong.data.skipped).toEqual([{ id: g3.id, reason: `${g2.id} is not a group of this feature` }]);
    // Into an existing group by id.
    const into = await d.api("POST", `${P}/tickets/${top.id}/gather`, { tickets: [{ id: g3.id, group: group.id }] });
    expect(into.data.gathered.map((t: any) => t.partOf)).toEqual([group.id]);

    const fam = (await d.api("GET", `${P}/tickets/${top.id}/family`)).data;
    expect(fam.find((x: any) => x.id === g1.id)).toMatchObject({ depth: 2, parent: group.id });

    expect(await d.api("POST", `${P}/tickets/${top.id}/gather`, { tickets: [] })).toMatchObject({ status: 400, data: { error: "tickets must list { id, group } entries" } });
    expect(await d.api("POST", `${P}/tickets/${top.id}/gather`, { tickets: [{ id: g3.id }], hide: "yes" })).toMatchObject({ status: 400, data: { error: "hide must be true or false" } });
    // A work run (not answering the user's message) may not gather.
    const run = await d.api("POST", `${P}/tickets/${top.id}/gather`, { tickets: [{ id: g3.id }] }, { "x-ckanban-run": `${SLUG}/${g2.id}` });
    expect(run).toMatchObject({ status: 403, data: { error: "gathering tickets works from a chat, in a reply to a message the user typed there" } });
  });

  test("create with main: true and gather moves tickets into the new feature", async () => {
    const t = await newTicket("To be gathered");
    const r = await create({ title: "New feature", main: true, gather: [{ id: t.id, group: null }] });
    expect(r.status).toBe(201);
    expect(r.data.main).toBe(true);
    expect(r.data.gather.gathered.map((x: any) => [x.id, x.partOf])).toEqual([[t.id, r.data.id]]);
    expect(r.data.gather.skipped).toEqual([]);
    expect(meta(t.id).partOf).toBe(r.data.id);
  });

  test("deleting the top ticket unlinks its family (files too) and sends ticket.deleted", async () => {
    const top = await newTicket("Doomed top");
    const kid = await newTicket("Survivor", { partOf: top.id });
    const ctl = new AbortController();
    const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const pump = (async () => {
      try {
        for (;;) {
          const c = await reader.read();
          if (c.done) break;
          seen += dec.decode(c.value, { stream: true });
        }
      } catch {}
    })();
    await until(() => seen.includes(": connected"), 5_000, "the event stream");
    expect((await d.api("DELETE", `${P}/tickets/${top.id}`)).status).toBe(204);
    expect(existsSync(ticketDir(top.id))).toBe(false);
    await until(() => seen.includes(JSON.stringify({ type: "ticket.deleted", profile: SLUG, id: top.id })), 5_000, "ticket.deleted");
    // The unlinked member is sent as an updated ticket.
    await until(() => seen.split("\n").some((l) => l.startsWith("data: ") && (() => {
      const e = JSON.parse(l.slice(6));
      return e.type === "ticket.updated" && e.profile === SLUG && e.ticket?.id === kid.id && e.ticket.partOf === null;
    })()), 5_000, "ticket.updated for the unlinked member");
    ctl.abort();
    await pump;
    expect(meta(kid.id).partOf).toBeNull();
    expect((await ticket(kid.id)).partOf).toBeNull();
  });
});
