// Outside-in contract, the rest of the huddle room and the team: brief, a participant's status (and lessons), adding
// participants, mode, stop and restart one, close-request, seen, learnings (a helper's proposed teammate: edit, save,
// discard), inviting another ticket, an auto huddle started by the host ticket's own work run, what the board learned
// (`/learned`), role notes (`/huddle-notes`) and `/api/team-usage`. huddle.test.ts covers presets, squads, start,
// posts, findings, hand-ins, close and the budget stop. See contracts/api.md ("Team", "Huddles", "System and misc").
//
// The auto huddle needs a real work run of its host, so it gets its own daemon whose fake Claude runs in `call` mode:
// the run calls POST /huddles/auto with its own run header (FAKE_CALLS_FILE) and the answer lands in FAKE_CALL_OUT.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { readJsonl } from "./files";

let d: Daemon;
const SLUG = "team";
const base = `/api/profiles/${SLUG}`;
const RUN = "x-ckanban-run";
const AGENT = "x-ckanban-huddle-agent";

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Team", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const huddleFile = (dm: Daemon, slug: string, hid: string) => join(dm.home, "profiles", slug, "huddles", `${hid}.json`);
const messages = (hid: string) => readJsonl(join(d.home, "profiles", SLUG, "huddles", `${hid}.messages.jsonl`));
const token = (hid: string, handle: string) => readJson(huddleFile(d, SLUG, hid)).participants.find((p: any) => p.handle === handle).token;
const agentHeaders = (hid: string, host: string, handle: string) => ({ [RUN]: `${SLUG}/${host}`, [AGENT]: `${hid}/${handle}/${token(hid, handle)}` });
const newTicket = async (title: string) => (await d.api("POST", `${base}/tickets`, { title, body: "Work." })).data;
const view = async (hid: string) => (await d.api("GET", `${base}/huddles/${hid}`)).data.huddle;
const part = (h: any, handle: string) => h.participants.find((p: any) => p.handle === handle);
/** Waits until no helper of the huddle is in a turn. */
const settled = (hid: string) => until(async () => (await view(hid)).participants.every((p: any) => !p.running), 20_000, "the helpers' turns to end");

describe("huddle room", () => {
  test("brief, status, add participants, mode, stop and restart one, invite, seen, close-request", async () => {
    const t = await newTicket("Room host");
    const other = await newTicket("Api side");
    const h = (await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }], maxParticipants: 4 })).data;
    expect(h.maxParticipants).toBe(4);
    await settled(h.id);
    const reviewer = agentHeaders(h.id, t.id, "reviewer");
    const mainRun = { [RUN]: `${SLUG}/${t.id}` };

    // The brief: leads, @main and the user; "" clears it.
    const set = await d.api("PUT", `${base}/huddles/${h.id}/brief`, { text: "Goal: one login page." }, mainRun);
    expect(set.status).toBe(200);
    expect(set.data.brief).toMatchObject({ text: "Goal: one login page.", by: "main" });
    expect(readJson(huddleFile(d, SLUG, h.id)).brief.text).toBe("Goal: one login page.");
    expect((await d.api("PUT", `${base}/huddles/${h.id}/brief`, { text: "x".repeat(8001) })).status).toBe(400);

    // A participant's own status: done, blocked (needs a reason) or active again; the user has none.
    expect((await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "done" })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "blocked" }, reviewer)).status).toBe(400);
    expect((await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "sleeping" }, reviewer)).status).toBe(400);
    const blocked = await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "blocked", reason: "needs the API" }, reviewer);
    expect(blocked.status).toBe(200);
    expect(blocked.data).toMatchObject({ handle: "reviewer", status: "blocked", statusReason: "needs the API" });
    expect("token" in blocked.data).toBe(false);
    expect(messages(h.id).at(-1)).toMatchObject({ kind: "system", text: "@reviewer is blocked: needs the API", mentions: ["main"] });
    const active = await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "active" }, reviewer);
    expect(["idle", "working"]).toContain(active.data.status);
    expect(active.data.statusReason).toBeNull();
    // Lessons go with done, from helpers only; they wait in the board's pile (Team, Learned).
    expect((await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "active", lessons: [{ text: "x" }] }, reviewer)).status).toBe(400);
    const lesson = "Check the login page on a phone before saying done.";
    const done = await d.api("POST", `${base}/huddles/${h.id}/status`, { status: "done", reason: "reviewed", lessons: [{ text: lesson, evidence: "it broke" }] }, reviewer);
    expect(done.data).toMatchObject({ status: "done", statusReason: "reviewed" });
    expect(messages(h.id).at(-1).text).toStartWith("@reviewer is done: reviewed. It noted 1 lesson for future huddles");
    await until(async () => JSON.stringify((await d.api("GET", `${base}/learned`)).data.watching).includes(lesson), 20_000, "the lesson in the pile");
    expect(existsSync(join(d.home, "learned", "pile.json"))).toBe(true);

    // Adding participants: the user, @main or a lead; a helper can't.
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants`, { preset: "qa" }, reviewer)).status).toBe(403);
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants`, { preset: "no-such" })).status).toBe(400);
    const added = await d.api("POST", `${base}/huddles/${h.id}/participants`, { preset: "qa", focus: "the form" });
    expect(added.status).toBe(201);
    expect(added.data.added).toEqual([expect.objectContaining({ handle: "qa", role: "QA tester", focus: "the form", kind: "agent", mode: "monitor" })]);
    expect(added.text).not.toContain("token");
    expect(added.data.huddle.participants.map((p: any) => p.handle)).toEqual(["you", "main", "reviewer", "qa"]);
    expect(messages(h.id).some((m: any) => m.text === "@you added @qa (QA tester: the form).")).toBe(true);
    // Room for 4 non-human participants: main, reviewer, qa and one more.
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants`, { preset: "security", count: 2 })).status).toBe(409);

    // Mode: the user sets anyone's, a helper only its own.
    const mode = await d.api("PATCH", `${base}/huddles/${h.id}/participants/qa`, { mode: "tagged" });
    expect(mode.status).toBe(200);
    expect(part(mode.data, "qa").mode).toBe("tagged");
    expect(messages(h.id).at(-1).text).toBe("@qa switched to tagged mode (by @you).");
    expect((await d.api("PATCH", `${base}/huddles/${h.id}/participants/qa`, { mode: "loud" })).status).toBe(400);
    expect((await d.api("PATCH", `${base}/huddles/${h.id}/participants/qa`, { mode: "monitor" }, reviewer)).status).toBe(403);
    expect((await d.api("PATCH", `${base}/huddles/${h.id}/participants/nobody`, { mode: "monitor" })).status).toBe(404);
    expect(part((await d.api("PATCH", `${base}/huddles/${h.id}/participants/reviewer`, { mode: "monitor" }, reviewer)).data, "reviewer").mode).toBe("monitor");

    // Stop and restart one participant: the user's alone.
    await settled(h.id);
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants/qa/stop`, {}, reviewer)).status).toBe(403);
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants/qa/restart`, {})).status).toBe(409);
    const stopped = await d.api("POST", `${base}/huddles/${h.id}/participants/qa/stop`, {});
    expect(stopped.status).toBe(200);
    expect(part(stopped.data, "qa").status).toBe("stopped");
    expect(messages(h.id).at(-1).text).toBe("@qa was stopped by @you.");
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants/nobody/stop`, {})).status).toBe(404);
    expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "still here" }, agentHeaders(h.id, t.id, "qa"))).status).toBe(409);
    const restarted = await d.api("POST", `${base}/huddles/${h.id}/participants/qa/restart`, {});
    expect(restarted.status).toBe(200);
    expect(["idle", "working"]).toContain(part(restarted.data, "qa").status);
    expect(messages(h.id).some((m: any) => m.text === "@qa was restarted by @you." && m.mentions.includes("qa"))).toBe(true);

    // Invite another ticket's own session (the user or @main).
    expect((await d.api("POST", `${base}/huddles/${h.id}/invite`, {})).status).toBe(400);
    expect((await d.api("POST", `${base}/huddles/${h.id}/invite`, { ticketId: other.id }, reviewer)).status).toBe(403);
    expect((await d.api("POST", `${base}/huddles/${h.id}/invite`, { ticketId: "t_missing" })).status).toBe(404);
    const inv = await d.api("POST", `${base}/huddles/${h.id}/invite`, { ticketId: other.id });
    expect(inv.status).toBe(201);
    expect(inv.data).toMatchObject({ handle: "api-main", kind: "ticket-main", ticketId: other.id, role: `Ticket ${other.id} "Api side"`, mode: "tagged" });
    expect("token" in inv.data).toBe(false);
    expect(readJson(huddleFile(d, SLUG, h.id)).invited).toEqual([other.id]);
    expect((await d.api("POST", `${base}/huddles/${h.id}/invite`, { ticketId: other.id })).status).toBe(409);
    // The invited ticket's run is that participant.
    expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "hi from the API" }, { [RUN]: `${SLUG}/${other.id}` })).data.from).toBe("api-main");

    // Seen: the user's cursor moves up to seq (never past the last message).
    const tag = await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "@you have a look" }, mainRun);
    expect((await view(h.id)).forYou).toBeGreaterThan(0);
    expect((await d.api("POST", `${base}/huddles/${h.id}/seen`, { seq: "x" })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddles/${h.id}/seen`, { seq: tag.data.seq }, mainRun)).status).toBe(403);
    const seen = await d.api("POST", `${base}/huddles/${h.id}/seen`, { seq: 1e9 });
    expect(seen.status).toBe(200);
    expect(seen.data.forYou).toBe(0);
    expect(part(readJson(huddleFile(d, SLUG, h.id)), "you").cursor).toBe(seen.data.seq);

    // Close request: @main or a lead, once the summary file is in the host's outputs; only the user closes.
    expect((await d.api("POST", `${base}/huddles/${h.id}/close-request`, { reason: "done" }, reviewer)).status).toBe(403);
    const early = await d.api("POST", `${base}/huddles/${h.id}/close-request`, { reason: "done" }, mainRun);
    expect(early.status).toBe(409);
    expect(early.data.error).toStartWith("write the huddle summary first:");
    const summary = join(d.home, "profiles", SLUG, "tickets", t.id, "outputs", "huddles", h.id, "summary.md");
    mkdirSync(dirname(summary), { recursive: true });
    writeFileSync(summary, "# Summary\n\nAll good.\n");
    const req = await d.api("POST", `${base}/huddles/${h.id}/close-request`, { reason: "the review is done." }, mainRun);
    expect(req.status).toBe(200);
    expect(req.data.status).toBe("live");
    expect(req.data.closeRequest).toMatchObject({ by: "main", reason: "the review is done" });
    expect(messages(h.id).at(-1)).toMatchObject({ kind: "system", mentions: ["you"] });
    expect(messages(h.id).at(-1).text).toStartWith("@main asks to close the huddle: the review is done.");
    const closed = await d.api("POST", `${base}/huddles/${h.id}/close`, {});
    expect(closed.data).toMatchObject({ status: "closed", summary: `huddles/${h.id}/summary.md` });
    // The summary @main wrote is kept as it is.
    expect(readFileSync(summary, "utf8")).toBe("# Summary\n\nAll good.\n");
    expect((await d.api("POST", `${base}/huddles/${h.id}/participants/qa/restart`, {})).status).toBe(409);
  }, 90_000);

  test("learnings: a helper's proposed teammate waits for the user, who edits, saves or discards it", async () => {
    const t = await newTicket("Learning host");
    const h = (await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }] })).data;
    await settled(h.id);
    const reviewer = agentHeaders(h.id, t.id, "reviewer");
    const proposal = { name: "Phone Walker", role: "Phone walker", prompt: "Walk the app on a phone.", why: "Nobody checks phones." };
    // Only helpers propose to the huddle; the proposal is checked.
    expect((await d.api("POST", `${base}/huddles/${h.id}/teammates`, proposal)).status).toBe(400);
    expect((await d.api("POST", `${base}/huddles/${h.id}/teammates`, { ...proposal, why: "" }, reviewer)).status).toBe(400);
    const l1 = await d.api("POST", `${base}/huddles/${h.id}/teammates`, proposal, reviewer);
    expect(l1.status).toBe(201);
    expect(l1.data).toMatchObject({
      id: "l1", from: "reviewer", status: "pending", scope: "general", text: "Nobody checks phones.",
      teammate: { name: "phone-walker", role: "Phone walker", prompt: "Walk the app on a phone.", why: "Nobody checks phones." },
    });
    expect(messages(h.id).at(-1).text).toBe("@reviewer proposed a new teammate @phone-walker; the user reviews it under Learnings.");
    expect((await view(h.id)).learningsPending).toBe(1);
    const l2 = await d.api("POST", `${base}/huddles/${h.id}/teammates`, { ...proposal, name: "tablet-walker" }, reviewer);
    expect(l2.data.id).toBe("l2");
    // A third waiting one from the same helper is refused.
    expect((await d.api("POST", `${base}/huddles/${h.id}/teammates`, { ...proposal, name: "watch-walker" }, reviewer)).status).toBe(400);

    // Only the user edits, saves or discards.
    expect((await d.api("POST", `${base}/huddles/${h.id}/learnings/l1/save`, {}, reviewer)).status).toBe(403);
    expect((await d.api("PATCH", `${base}/huddles/${h.id}/learnings/l1`, { scope: "everywhere" })).status).toBe(400);
    expect((await d.api("PATCH", `${base}/huddles/${h.id}/learnings/l1`, { target: "qa" })).status).toBe(400);
    const edited = await d.api("PATCH", `${base}/huddles/${h.id}/learnings/l1`, { scope: "repo" });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ id: "l1", scope: "repo", status: "pending" });
    // The body is parsed by hand: an empty one is allowed.
    const bare = await fetch(`${d.url}${base}/huddles/${h.id}/learnings/l1`, { method: "PATCH", headers: { "content-type": "application/json" } });
    expect(bare.status).toBe(200);
    const badJson = await fetch(`${d.url}${base}/huddles/${h.id}/learnings/l1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{" });
    expect(badJson.status).toBe(400);
    // Saved with scope repo: a teammate of this board.
    const saved = await d.api("POST", `${base}/huddles/${h.id}/learnings/l1/save`, {});
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ id: "l1", status: "saved", target: "phone-walker" });
    expect(readJson(join(d.home, "profiles", SLUG, "huddle-presets.json"))).toEqual([
      { name: "phone-walker", role: "Phone walker", prompt: "Walk the app on a phone.", model: null, mode: "tagged", workspace: "shared", lead: false, canEdit: false },
    ]);
    expect((await d.api("POST", `${base}/huddles/${h.id}/learnings/l1/save`, {})).status).toBe(409);
    const dropped = await d.api("POST", `${base}/huddles/${h.id}/learnings/l2/discard`, {});
    expect(dropped.status).toBe(200);
    expect(dropped.data).toMatchObject({ id: "l2", status: "discarded" });
    expect((await d.api("POST", `${base}/huddles/${h.id}/learnings/l9/discard`, {})).status).toBe(404);
    expect(readJson(huddleFile(d, SLUG, h.id)).learnings.map((l: any) => [l.id, l.status])).toEqual([["l1", "saved"], ["l2", "discarded"]]);
    expect((await view(h.id)).learningsPending).toBe(0);
    await d.api("POST", `${base}/huddles/${h.id}/close`, {});
  }, 60_000);
});

describe("team", () => {
  test("learned: the view, ?count=1 and seen; only the user changes it", async () => {
    const v = await d.api("GET", `${base}/learned`);
    expect(v.status).toBe(200);
    expect(v.data).toMatchObject({ saved: expect.any(Array), cleaned: expect.any(Array), watching: expect.any(Array), newCount: expect.any(Number) });
    expect("tidyAt" in v.data).toBe(true);
    const count = await d.api("GET", `${base}/learned?count=1`);
    expect(count.data).toEqual({ newCount: v.data.newCount });
    expect((await d.api("POST", `${base}/learned/seen`, {}, { [RUN]: `${SLUG}/t_1` })).status).toBe(403);
    const seen = await d.api("POST", `${base}/learned/seen`, {});
    expect(seen.status).toBe(200);
    expect(seen.data.newCount).toBe(0);
    expect(readJson(join(d.home, "learned", "pile.json")).seen[SLUG]).toEqual(expect.any(String));
    expect((await d.api("POST", `${base}/learned/changes/nope/undo`, {})).status).toBe(404);
    expect((await d.api("GET", `${base}/learned/whatever`)).status).toBe(404);
  });

  test("role notes: GET /huddle-notes and PUT one role's notes in one scope, written as Markdown", async () => {
    const empty = await d.api("GET", `${base}/huddle-notes`);
    expect(empty.status).toBe(200);
    expect(typeof empty.data.cap).toBe("number");
    expect(typeof empty.data.notes).toBe("object");

    const put = await d.api("PUT", `${base}/huddle-notes/reviewer/general`, { notes: [{ text: "Read the tests first." }, { text: "Name the file.", by: "qa-1", date: "2026-11-10", huddle: "h_abc" }] });
    expect(put.status).toBe(200);
    expect(put.data).toEqual([
      { text: "Read the tests first.", by: "you", date: null, huddle: null },
      { text: "Name the file.", by: "qa-1", date: "2026-11-10", huddle: "h_abc" },
    ]);
    const general = readFileSync(join(d.home, "huddle-notes", "reviewer.md"), "utf8");
    expect(general).toStartWith("# Huddle notes: role reviewer, all repos\n<!-- ");
    expect(general).toContain("\n\n- Read the tests first. <!-- by you -->\n- Name the file. <!-- from @qa-1, 2026-11-10, huddle h_abc -->\n");
    expect(general.endsWith("-->\n")).toBe(true);
    const repo = await d.api("PUT", `${base}/huddle-notes/_all/repo`, { notes: [{ text: "This repo has no git." }] });
    expect(repo.status).toBe(200);
    expect(readFileSync(join(d.home, "profiles", SLUG, "huddle-notes", "_all.md"), "utf8")).toStartWith("# Huddle notes: all roles, this repo\n");

    const all = (await d.api("GET", `${base}/huddle-notes`)).data.notes;
    expect(all.reviewer.general.map((n: any) => n.text)).toEqual(["Read the tests first.", "Name the file."]);
    expect(all._all.repo.map((n: any) => n.text)).toEqual(["This repo has no git."]);

    expect((await d.api("PUT", `${base}/huddle-notes/reviewer/everywhere`, { notes: [] })).status).toBe(400);
    expect((await d.api("PUT", `${base}/huddle-notes/Bad Role!/general`, { notes: [] })).status).toBe(400);
    expect((await d.api("PUT", `${base}/huddle-notes/reviewer/general`, { notes: [{ text: " " }] })).status).toBe(400);
    expect((await d.api("PUT", `${base}/huddle-notes/reviewer/general`, { notes: "x" })).status).toBe(400);
    expect((await d.api("PUT", `${base}/huddle-notes/reviewer/general`, { notes: [] }, { [AGENT]: "h_x/qa/tok" })).status).toBe(403);
  });

  test("GET /api/team-usage counts each teammate's and squad's huddles", async () => {
    const t = await newTicket("Usage host");
    expect((await d.api("POST", `${base}/huddle-templates`, { name: "usage-squad", roster: [{ preset: "breaker" }] })).status).toBe(201);
    const h = (await d.api("POST", `${base}/huddles`, { ticketId: t.id, squad: "usage-squad" })).data;
    await settled(h.id);
    const r = await d.api("GET", "/api/team-usage");
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["teammates", "templates"]);
    const breaker = r.data.teammates.breaker;
    expect(breaker).toMatchObject({ huddles: 1, lastUsed: expect.any(String) });
    expect(breaker.recent[0]).toMatchObject({ board: SLUG, huddle: h.id, ticket: t.id, title: "Usage host" });
    expect(r.data.templates["usage-squad"]).toMatchObject({ huddles: 1 });
    expect(r.data.templates["usage-squad"].recent[0]).toMatchObject({ huddle: h.id, ticket: t.id });
    // Reviewer took part in the room and learning huddles above.
    expect(r.data.teammates.reviewer.huddles).toBeGreaterThanOrEqual(2);
    await d.api("POST", `${base}/huddles/${h.id}/close`, {});
  }, 60_000);
});

describe("auto huddle", () => {
  let a: Daemon;
  let dir: string;
  const A = "auto";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ck-contract-auto-"));
    writeFileSync(join(dir, "calls.json"), "[]");
    a = await startDaemon({ fakeMode: "call", env: { FAKE_CALLS_FILE: join(dir, "calls.json"), FAKE_CALL_OUT: join(dir, "out.jsonl") } });
    expect((await a.api("POST", "/api/profiles", { name: "Auto", path: a.project })).status).toBe(201);
  }, 60_000);
  afterAll(async () => {
    await a?.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("the host ticket's work run starts it with POST /huddles/auto; anyone else is refused", async () => {
    const t = (await a.api("POST", `/api/profiles/${A}/tickets`, { title: "Add login", body: "Build it." })).data;
    const roster = [{ role: "Checker", prompt: "Check the login form." }];
    // Not from the user, a helper, another board, or the ticket's chat.
    expect((await a.api("POST", `/api/profiles/${A}/huddles/auto`, { reason: "r", trigger: "security", roster })).status).toBe(403);
    expect((await a.api("POST", `/api/profiles/${A}/huddles/auto`, { reason: "r", trigger: "security", roster }, { [RUN]: `other/${t.id}` })).status).toBe(403);
    expect((await a.api("POST", `/api/profiles/${A}/huddles/auto`, { reason: "r", trigger: "security", roster }, { [RUN]: `${A}/${t.id}`, [AGENT]: "h_x/qa/tok" })).status).toBe(403);
    const idle = await a.api("POST", `/api/profiles/${A}/huddles/auto`, { reason: "r", trigger: "security", roster }, { [RUN]: `${A}/${t.id}` });
    expect(idle.status).toBe(403);
    expect(idle.data.error).toStartWith("start_huddle only works in an unattended run of the ticket");

    const run = { [RUN]: `${A}/${t.id}` };
    const path = `/api/profiles/${A}/huddles/auto`;
    writeFileSync(join(dir, "calls.json"), JSON.stringify([
      { method: "POST", path, headers: run, body: { reason: "", trigger: "security", roster } },
      { method: "POST", path, headers: run, body: { reason: "New login form", trigger: "nope", roster } },
      { method: "POST", path, headers: run, body: { reason: "New login form", trigger: "security" } },
      { method: "POST", path, headers: run, body: { reason: "New login form", trigger: "security", roster, maxCostUsd: 500 } },
      { method: "POST", path, headers: run, body: { reason: "Again", trigger: "security", roster } },
    ]));
    expect((await a.api("PATCH", `/api/profiles/${A}/tickets/${t.id}`, { status: "ready" })).status).toBe(200);
    const out = await until(() => {
      try {
        const lines = readJsonl(join(dir, "out.jsonl"));
        return lines.length >= 5 ? lines.slice(0, 5) : null;
      } catch {
        return null;
      }
    }, 30_000, "the run's calls");
    // Later runs (the huddle's helpers) also make the calls; only the work run's five count, in order.
    writeFileSync(join(dir, "calls.json"), "[]");
    expect(out.map((o: any) => o.status)).toEqual([400, 400, 400, 201, 409]);
    expect(JSON.parse(out[0].text).error).toStartWith("reason is required");
    expect(JSON.parse(out[1].text).error).toStartWith("trigger is required: one of security, data, payments, important, asked");
    expect(JSON.parse(out[2].text).error).toStartWith("pass a roster built for this change (trigger security)");
    expect(JSON.parse(out[4].text).error).toStartWith(`ticket ${t.id} already has an open huddle`);
    const started = JSON.parse(out[3].text);
    expect(started).toMatchObject({ waiting: false, template: "custom" });
    const h = started.huddle;
    // An auto huddle's budget is capped at $100; it runs with a host (its first lead, none here: @main).
    expect(h).toMatchObject({ hostTicket: t.id, status: "live", maxCostUsd: 100, auto: { reason: "New login form" } });
    expect(h.participants.map((p: any) => p.handle)).toEqual(["you", "main", "checker"]);
    expect(h.brief.by).toBe("you");
    expect(JSON.stringify(started)).not.toContain("token");
    const first = readJsonl(join(a.home, "profiles", A, "huddles", `${h.id}.messages.jsonl`))[0];
    expect(first.text).toStartWith(`Auto huddle started on ticket ${t.id} "Add login" by its own run (security: New login form) with @checker (Checker).`);
    expect(first.text).toContain("Budget $100.00 (asked $500.00, capped at $100.00).");

    // The ticket says so: autoHuddle and a comment.
    const ticket = (await a.api("GET", `/api/profiles/${A}/tickets/${t.id}`)).data;
    expect(ticket.autoHuddle).toMatchObject({ state: "live", reason: "New login form", trigger: "security", template: "custom", huddleId: h.id });
    const comments = (await a.api("GET", `/api/profiles/${A}/tickets/${t.id}/comments`)).data;
    expect(comments.some((c: any) => c.author === "ai" && c.text === "Auto huddle started (custom roster, security): New login form")).toBe(true);
    expect((await a.api("POST", `/api/profiles/${A}/huddles/${h.id}/close`, {})).data.status).toBe("closed");
  }, 90_000);
});
