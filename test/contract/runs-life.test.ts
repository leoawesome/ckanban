// Outside-in contract: a ticket's run life cycle on a plain project folder (no version history), on the fake Claude
// (test/fixtures/fake-claude.ts, per-ticket scripts via FAKE_SCRIPT_DIR): which column moves start a run, the run log
// (activity.jsonl), the CKANBAN_RESULT line, resume after a message, stop, failed / blocked / questions runs, usage-limit
// waits, follow-ups and the run's outputs. Checks answers, files and event stream messages. See contracts/api.md
// ("Ticket chat, runs and conversation") and contracts/data-files.md (ticket.md, comments.jsonl, activity.jsonl).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { events, Scripts, scriptDir, running, settled, view } from "./runs";

let d: Daemon;
let s: Scripts;
let root: string;
let ev: Awaited<ReturnType<typeof events>>;
const SLUG = "runs";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ck-contract-runs-"));
  s = new Scripts(scriptDir(root));
  d = await startDaemon({ env: { FAKE_SCRIPT_DIR: s.dir } });
  expect((await d.api("POST", "/api/profiles", { name: "Runs", path: d.project })).status).toBe(201);
  ev = await events(d);
}, 60_000);

afterAll(async () => {
  ev?.close();
  await d?.stop();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

const T = `/api/profiles/${SLUG}/tickets`;
const dir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(dir(id), "ticket.md"), "utf8")).meta;
const comments = (id: string) => readJsonl(join(dir(id), "comments.jsonl"));
const activity = (id: string) => readJsonl(join(dir(id), "activity.jsonl"));
const claudeCalls = () => readJsonl(d.env.FAKE_ARGS_FILE);

async function create(title: string, body: string, status = "backlog", extra: Record<string, unknown> = {}): Promise<any> {
  const r = await d.api("POST", T, { title, body, status, mode: "auto", ...extra });
  expect(r.status).toBe(201);
  return r.data;
}

describe("starting runs from column moves", () => {
  test("Ready starts a work run in the project folder itself; it ends in Review with the result line's summary", async () => {
    const tag = s.set("ready", [{ summary: "Fixed it for you." }]);
    const before = ev.all.length;
    const t = await create("Ready work", `Do it. ${tag}`, "ready");
    const done = await settled(d, SLUG, t.id, (v) => v.status === "review");
    expect(done).toMatchObject({ status: "review", outcome: "done", running: false, worktree: null, branch: null, runCount: 1, error: null, prUrl: null });
    expect(typeof done.sessionId).toBe("string");

    // The fake ran once, in the plain project folder, in a new session with the ticket's session id.
    const runs = s.runs("ready");
    expect(runs).toHaveLength(1);
    expect(runs[0].cwd).toBe(realpathSync(d.project));
    expect(runs[0].ticket).toBe(`${SLUG}/${t.id}`);
    expect(runs[0].args).toContain("-p");
    expect(runs[0].args[runs[0].args.indexOf("--session-id") + 1]).toBe(done.sessionId);
    expect(runs[0].args).not.toContain("--resume");
    expect(runs[0].args[runs[0].args.indexOf("--output-format") + 1]).toBe("stream-json");

    // ticket.md and comments.jsonl: the result's summary is the AI comment.
    expect(meta(t.id)).toMatchObject({ status: "review", outcome: "done", runCount: 1, sessionId: done.sessionId, worktree: null });
    expect(comments(t.id).at(-1)).toMatchObject({ author: "ai", text: "Fixed it for you." });

    // activity.jsonl: the board's run marker first, then the stream-json events; the fake's "not json line" is dropped.
    const log = activity(t.id);
    expect(log[0]).toMatchObject({ run: 1, event: { type: "ckanban_run", kind: "work" } });
    expect(log.every((l) => l.run === 1 && typeof l.at === "string")).toBe(true);
    expect(log.map((l) => l.event.type)).toContain("system");
    const result = log.find((l) => l.event.type === "result")!.event;
    expect(result).toMatchObject({ subtype: "success", is_error: false, session_id: done.sessionId });
    expect(result.result).toContain('CKANBAN_RESULT: {"status":"done"');
    expect(log.some((l) => l.event.type === "text" || typeof l.event === "string")).toBe(false);

    // GET /activity pages the same log.
    const page = await d.api("GET", `${T}/${t.id}/activity`);
    expect(page.status).toBe(200);
    expect(page.data.entries.length).toBe(log.length);
    expect(page.data.entries[0].event).toEqual({ type: "ckanban_run", kind: "work" });

    // The event stream: ticket.updated with running true, then the final view; activity events of this ticket.
    const mine = ev.all.slice(before);
    const updates = mine.filter((e) => e.type === "ticket.updated" && e.ticket?.id === t.id);
    expect(updates.some((e) => e.ticket.running === true && e.ticket.status === "in_progress")).toBe(true);
    expect(updates.at(-1).ticket).toMatchObject({ status: "review", outcome: "done", running: false });
    const acts = mine.filter((e) => e.type === "activity" && e.id === t.id);
    expect(acts.length).toBeGreaterThan(0);
    expect(acts[0]).toMatchObject({ profile: SLUG, id: t.id, run: 1 });
    expect(acts.map((a) => a.event.type)).toContain("result");
  }, 60_000);

  test("Planning starts the interview (a planning run that can't edit files); Backlog, Review and Done start nothing", async () => {
    const tag = s.set("plan", [{ summary: "Questions asked." }]);
    const t = await create("Plan me", `Think. ${tag}`, "backlog");
    expect((await view(d, SLUG, t.id)).running).toBe(false);
    await Bun.sleep(300);
    expect(s.runs("plan")).toHaveLength(0);
    for (const st of ["review", "done", "backlog"]) {
      const r = await d.api("PATCH", `${T}/${t.id}`, { status: st });
      expect(r.status).toBe(200);
      expect(r.data.running).toBe(false);
    }
    await Bun.sleep(300);
    expect(s.runs("plan")).toHaveLength(0);

    expect((await d.api("PATCH", `${T}/${t.id}`, { status: "planning" })).status).toBe(200);
    const v = await until(async () => {
      const x = await view(d, SLUG, t.id);
      return s.runs("plan").length === 1 && !x.running ? x : null;
    }, 30_000, "planning run");
    expect(v.status).toBe("planning");
    const args = s.runs("plan")[0].args;
    expect(args[args.indexOf("--disallowedTools") + 1]).toStartWith("Edit,Write,NotebookEdit,");
    expect(activity(t.id)[0].event).toEqual({ type: "ckanban_run", kind: "planning" });
  }, 60_000);

  test("In Progress starts a work run too", async () => {
    const tag = s.set("inprog", [{}]);
    const t = await create("Straight in", `Go. ${tag}`, "backlog");
    expect((await d.api("PATCH", `${T}/${t.id}`, { status: "in_progress" })).status).toBe(200);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("done");
    expect(s.runs("inprog")).toHaveLength(1);
    expect(activity(t.id)[0].event).toEqual({ type: "ckanban_run", kind: "work" });
  }, 60_000);
});

describe("result line parsing", () => {
  test("blocked is kept as the outcome with its summary as the comment; questions becomes needs_input", async () => {
    const a = s.set("blocked", [{ status: "blocked", summary: "Need the API key." }]);
    const b = s.set("questions", [{ status: "questions", summary: "Which colour?" }]);
    const t1 = await create("Blocked one", `x ${a}`, "ready");
    const t2 = await create("Questions one", `x ${b}`, "ready");
    const v1 = await settled(d, SLUG, t1.id, (v) => v.status === "review");
    const v2 = await settled(d, SLUG, t2.id, (v) => v.status === "review");
    expect(v1.outcome).toBe("blocked");
    expect(comments(t1.id).at(-1)).toMatchObject({ author: "ai", text: "Need the API key." });
    expect(v2.outcome).toBe("needs_input");
    // A questions reply's comment is its final text without the result line (the form carries the questions).
    expect(comments(t2.id).at(-1)).toMatchObject({ author: "ai", text: "Work complete." });
    expect(meta(t2.id).outcome).toBe("needs_input");
  }, 60_000);

  test("no result line: done, and the final text is the comment", async () => {
    const tag = s.set("noresult", [{ mode: "noresult" }]);
    const t = await create("No line", `x ${tag}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("done");
    expect(comments(t.id).at(-1)).toMatchObject({ author: "ai", text: "All done, no result line." });
  }, 60_000);

  test("a run that fails: outcome failed with the error output", async () => {
    const tag = s.set("fail", [{ mode: "fail" }]);
    const t = await create("Fails", `x ${tag}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review" && x.outcome === "failed");
    expect(v.error).toContain("boom");
    expect(meta(t.id)).toMatchObject({ outcome: "failed" });
    expect(meta(t.id).error).toContain("boom");
  }, 60_000);

  test("a result's prUrl is saved on the ticket", async () => {
    const tag = s.set("pr", [{ prUrl: "https://github.com/x/y/pull/7" }]);
    const t = await create("With a PR", `x ${tag}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.prUrl).toBe("https://github.com/x/y/pull/7");
    expect(meta(t.id).prUrl).toBe("https://github.com/x/y/pull/7");
    // A run without one (the earlier tickets) keeps null.
  }, 60_000);
});

describe("resume, stop and messages", () => {
  test("a chat message after a run resumes the same session; the reply goes back to Review", async () => {
    const tag = s.set("resume", [{ summary: "First pass." }, { summary: "Used blue." }]);
    const t = await create("Resume me", `x ${tag}`, "ready");
    const first = await settled(d, SLUG, t.id, (v) => v.status === "review");
    const sent = await d.api("POST", `${T}/${t.id}/chat`, { text: "please use blue" });
    expect(sent.status).toBe(202);
    expect(sent.data.id).toBe(t.id);
    await until(() => s.runs("resume").length === 2, 30_000, "second run");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review" && x.runCount === 2);
    const runs = s.runs("resume");
    expect(runs[1].args[runs[1].args.indexOf("--resume") + 1]).toBe(first.sessionId);
    expect(runs[1].args).not.toContain("--session-id");
    expect(runs[1].cwd).toBe(runs[0].cwd);
    expect(v.sessionId).toBe(first.sessionId);
    // Chat messages are not comments (they live in the session); the second run's log entries carry run 2 and start
    // with a chat marker.
    expect(comments(t.id).some((c) => c.text === "please use blue")).toBe(false);
    const log = activity(t.id);
    const second = log.filter((l) => l.run === 2);
    expect(second[0].event.type).toBe("ckanban_run");
    expect(second[0].event.kind).toBe("chat");
    expect(v.runCount).toBe(2);
    // The message reached Claude (the fake replays what it heard into the run log as a user event).
    const prompt = claudeCalls().filter((c) => c.args.includes("--resume") && c.args.includes(first.sessionId)).at(-1).prompt;
    expect(prompt).toContain("please use blue");
  }, 60_000);

  test("chat validation: no text is 400, an unknown ticket 404", async () => {
    const t = await create("Chat checks", "x");
    const r = await d.api("POST", `${T}/${t.id}/chat`, { text: "" });
    expect(r.status).toBe(400);
    expect((await d.api("POST", `${T}/t_20000101_none/chat`, { text: "hi" })).status).toBe(404);
  });

  test("Stop ends a live run: Review with outcome stopped; a second Stop stops nothing", async () => {
    const gate = s.gate("stop");
    const tag = s.set("stop", [{ waitFile: gate.file }]);
    const t = await create("Stop me", `x ${tag}`, "ready");
    const live = await running(d, SLUG, t.id);
    expect(live.status).toBe("in_progress");
    const r = await d.api("POST", `${T}/${t.id}/stop`, {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ stopped: true });
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("stopped");
    expect(meta(t.id).outcome).toBe("stopped");
    const again = await d.api("POST", `${T}/${t.id}/stop`, {});
    expect(again.status).toBe(200);
    expect(again.data.stopped).toBe(false);
    gate.release();
  }, 60_000);

  test("moving a running ticket back to Backlog stops its run there", async () => {
    const gate = s.gate("back");
    const tag = s.set("back", [{ waitFile: gate.file }]);
    const t = await create("Back off", `x ${tag}`, "ready");
    await running(d, SLUG, t.id);
    expect((await d.api("PATCH", `${T}/${t.id}`, { status: "backlog" })).status).toBe(200);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "backlog" && x.outcome === "stopped");
    expect(v.running).toBe(false);
    gate.release();
  }, 60_000);

  test("a message sent while the run works reaches it (the fake lists it as steered)", async () => {
    const gate = s.gate("steer");
    const tag = s.set("steer", [{ waitFile: gate.file }]);
    const t = await create("Steer me", `x ${tag}`, "ready");
    await running(d, SLUG, t.id);
    expect((await d.api("POST", `${T}/${t.id}/chat`, { text: "also do the footer" })).status).toBe(202);
    await Bun.sleep(300);
    gate.release();
    await settled(d, SLUG, t.id, (x) => x.status === "review");
    const texts = activity(t.id).filter((l) => l.event.type === "result").map((l) => l.event.result).join("\n");
    expect(texts).toContain("also do the footer");
  }, 60_000);
});

describe("usage-limit waits", () => {
  test("a run stopped by the usage limit waits with outcome limit; continue resumes it", async () => {
    const tag = s.set("limit", [{ mode: "limit" }, { summary: "Carried on." }]);
    const t = await create("Hits the limit", `x ${tag}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.outcome === "limit");
    expect(v.limit).toBeTruthy();
    expect(typeof v.limit.resetAt).toBe("string");
    expect(typeof v.limit.message).toBe("string");
    expect(meta(t.id).outcome).toBe("limit");
    // Bad input, then continue now.
    expect((await d.api("POST", `${T}/${t.id}/limit`, { action: "bogus" })).status).toBe(400);
    const c = await d.api("POST", `${T}/${t.id}/limit`, { action: "continue" });
    expect(c.status).toBe(202);
    await until(() => s.runs("limit").length === 2, 30_000, "continued run");
    const after = await settled(d, SLUG, t.id, (x) => x.outcome === "done");
    expect(after.limit ?? null).toBeNull();
    const runs = s.runs("limit");
    expect(runs[1].args).toContain("--resume");
  }, 60_000);
});

describe("follow-ups", () => {
  test("a follow-up set on a ticket, run now, wakes it as a follow-up run and the card goes back where it was", async () => {
    const tag = s.set("follow", [{}, { summary: "Checked again." }]);
    const t = await create("Follow me", `x ${tag}`, "ready");
    await settled(d, SLUG, t.id, (x) => x.status === "review");
    const set = await d.api("POST", `${T}/${t.id}/follow-up`, { after: "2h", note: "Check the reply" });
    expect(set.status).toBe(201);
    expect(set.data.followUp).toMatchObject({ note: "Check the reply" });
    expect(typeof set.data.followUp.dueAt).toBe("string");
    expect(Date.parse(set.data.followUp.dueAt) - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(meta(t.id).followUp).toMatchObject({ note: "Check the reply" });
    const now = await d.api("POST", `${T}/${t.id}/follow-up/now`, {});
    expect(now.status).toBe(202);
    await until(() => s.runs("follow").length === 2, 30_000, "follow-up run");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review" && x.runCount === 2);
    expect(v.followUp ?? null).toBeNull();
    expect(activity(t.id).filter((l) => l.run === 2)[0].event).toEqual({ type: "ckanban_run", kind: "follow-up" });
    // Bad input.
    expect((await d.api("POST", `${T}/${t.id}/follow-up`, { after: "soon-ish" })).status).toBe(400);
    expect((await d.api("POST", `${T}/${t.id}/follow-up/now`, {})).status).toBe(400);
  }, 60_000);
});

describe("outputs", () => {
  test("files a run saves in CKANBAN_OUTPUT_DIR are listed and served", async () => {
    const tag = s.set("outputs", [{ outputs: { "report.md": "# Report\nAll good.\n", "data/rows.csv": "a,b\n1,2\n" } }]);
    const t = await create("Make files", `x ${tag}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outputDir).toBe(join(dir(t.id), "outputs"));
    expect(readFileSync(join(dir(t.id), "outputs", "report.md"), "utf8")).toBe("# Report\nAll good.\n");
    const list = await d.api("GET", `${T}/${t.id}/outputs`);
    expect(list.status).toBe(200);
    const names = list.data.map((f: any) => f.name).sort();
    expect(names).toEqual(["data/rows.csv", "report.md"]);
    expect(list.data.find((f: any) => f.name === "report.md")).toMatchObject({ size: 19 });
    expect(typeof list.data[0].updatedAt).toBe("string");
    const file = await fetch(`${d.url}${T}/${t.id}/outputs/report.md`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toStartWith("text/plain");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(await file.text()).toBe("# Report\nAll good.\n");
    expect((await fetch(`${d.url}${T}/${t.id}/outputs/nope.md`)).status).toBe(404);
    expect((await fetch(`${d.url}${T}/${t.id}/outputs/..%2F..%2Fprofile.json`)).status).toBe(404);
    // Only the user acts on outputs: a run's header is refused.
    const reveal = await d.api("POST", `${T}/${t.id}/outputs/report.md?action=reveal`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` });
    expect(reveal.status).toBe(403);
    expect(existsSync(join(dir(t.id), "outputs"))).toBe(true);
    expect(readdirSync(join(dir(t.id), "outputs")).sort()).toEqual(["data", "report.md"]);
  }, 60_000);
});

describe("landing on a plain folder", () => {
  test("land_milestone records the milestone: the work is already in the project folder", async () => {
    const t = await create("Plain main", `x ${s.set("plainland", [{ files: { "made.txt": "made\n" } }])}`, "ready");
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.main).toBe(true);
    expect(readFileSync(join(d.project, "made.txt"), "utf8")).toBe("made\n");
    const r = await d.api("POST", `${T}/${t.id}/land`, { summary: "Plain milestone" });
    expect(r.status).toBe(200);
    expect(r.data.message).toBe("Recorded the milestone: the tool tickets already edited the project folder itself, so there is nothing else to land.");
    const status = JSON.parse(readFileSync(join(dir(t.id), "outputs", "status.json"), "utf8"));
    expect(status.milestones.at(-1)).toMatchObject({ summary: "Plain milestone", landed: "already in the project folder" });
    // merge_into_main from a ticket with no copy: nothing to merge (a plain folder is edited in place).
    const m = await d.api("POST", `${T}/${t.id}/merge-into-main`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` });
    expect(m.status).toBe(409);
    expect(m.data.error).toBe("only a tool ticket merges into its main ticket's copy");
  }, 60_000);
});
