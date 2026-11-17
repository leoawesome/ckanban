// Outside-in contract: the board's read routes on a board written straight into the data folder (no API writes), so
// the same file runs against any server, the Rust board in board mode included (Rust port R1, see
// docs/rust-port-board-plan.md): GET /api/profiles, /api/profiles/:p, the ticket list scopes, one ticket, the command
// bar's /api/tickets and /api/inbox. Under a Rust server (CKANBAN_CONTRACT_DAEMON set) it also starts Bun alone on the
// same files and wants the very same answers, and checks shadow mode (CKANBAN_RUST_SHADOW=1) logs no difference.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_DAEMON_CMD, type Daemon, startDaemon, until } from "./daemon";
import { Golden, RECORD } from "./golden";

const SLUG = "reads";
const OTHER = "other";
const T0 = Date.parse("2026-11-01T08:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

type Fields = Record<string, unknown>;

/** Block-style YAML for a ticket's front matter (what Bun's YAML.stringify writes, near enough for a reader). */
function yaml(m: Fields, indent = ""): string {
  let out = "";
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    if (v === null || typeof v !== "object") out += `${indent}${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}\n`;
    else if (Array.isArray(v)) {
      out += `${indent}${k}:\n`;
      for (const x of v) {
        if (x && typeof x === "object") {
          const inner = yaml(x as Fields, `${indent}    `).replace(/^ {4}/, "");
          out += `${indent}  - ${inner.slice(indent.length)}`;
        } else out += `${indent}  - ${typeof x === "string" ? JSON.stringify(x) : String(x)}\n`;
      }
    } else out += `${indent}${k}:\n${yaml(v as Fields, `${indent}  `)}`;
  }
  return out;
}

let order = 0;
function ticket(home: string, slug: string, id: string, f: Fields, body = "", comments: Fields[] = []): void {
  const dir = join(home, "profiles", slug, "tickets", id);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id, title: `Ticket ${id}`, status: "backlog", mode: "interview", order: ++order, sessionId: null, worktree: null, branch: null,
    prUrl: null, outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null,
    createdAt: at(order), updatedAt: at(order + 1), ...f,
  };
  writeFileSync(join(dir, "ticket.md"), `---\n${yaml(meta)}---\n${body}`);
  if (comments.length) writeFileSync(join(dir, "comments.jsonl"), comments.map((c) => JSON.stringify(c) + "\n").join(""));
}

/**
 * One board with families, features, every waiting reason, Done pages, pins, tags, links and a broken file. Its
 * folder doesn't exist, so neither server starts a run of its Ready tickets (dispatch skips a board without its
 * folder) and both answer from the files as written.
 */
function seed(home: string, project: string): void {
  order = 0;
  for (const [slug, name, created] of [[SLUG, "Reads", "2026-10-01T00:00:00.000Z"], [OTHER, "Other", "2026-10-02T00:00:00.000Z"]]) {
    mkdirSync(join(home, "profiles", slug, "tickets"), { recursive: true });
    writeFileSync(join(home, "profiles", slug, "profile.json"), JSON.stringify({ name, slug, path: join(project, "gone"), baseBranch: "", model: null, createdAt: created, runCapUsd: 3 }, null, 2) + "\n");
  }
  const ai = (text: string, min: number) => ({ id: `c${min}`, author: "ai", text, at: at(min) });
  // A main ticket with its tasks: a group of two, a failed step, a "with you" step that asks, a sub-feature.
  ticket(home, SLUG, "t_20261101_main", { title: "Launch kit", status: "review", main: true, statusAt: at(5), browsers: [{ kind: "ask" }], runEndedAt: at(3), outcome: "done" }, "The plan\n");
  ticket(home, SLUG, "t_20261101_grp1", { title: "Testing round 1", status: "review", tool: true, kind: "round", parentId: "t_20261101_main" });
  ticket(home, SLUG, "t_20261101_tst1", { title: "checkout", kind: "test", status: "done", tool: true, parentId: "t_20261101_grp1", verdict: "passed" });
  ticket(home, SLUG, "t_20261101_tst2", { title: "Test: sign in", kind: "test", status: "ready", tool: true, parentId: "t_20261101_grp1", runStartedAt: at(40) });
  ticket(home, SLUG, "t_20261101_fail", { title: "Fix the build", kind: "fix", status: "review", tool: true, parentId: "t_20261101_main", outcome: "failed", error: "first line\nlast line of it\n", runEndedAt: at(30) });
  ticket(home, SLUG, "t_20261101_ywou", { title: "Phone check", kind: "with_you", status: "review", tool: true, parentId: "t_20261101_main", outcome: "needs_input", runEndedAt: at(31) });
  ticket(home, SLUG, "t_20261101_subf", { title: "Sub feature", status: "planning", main: true, partOf: "t_20261101_main" });
  ticket(home, SLUG, "t_20261101_sub1", { title: "Sub task", status: "ready", partOf: "t_20261101_subf", tags: ["ui"] });
  // Every reason a ticket waits on the user, and a few that don't.
  ticket(home, SLUG, "t_20261101_revw", { status: "review", tags: ["ui", "api"], prUrl: "https://github.com/x/y/pull/42" }, "Body mentions the quick brown fox\n",
    [ai("Made [The page](https://claude.ai/artifact/abc-1) and https://claude.ai/code/artifact/x2", 50), { id: "u1", author: "user", text: "thanks", at: at(51) }]);
  ticket(home, SLUG, "t_20261101_fald", { status: "review", outcome: "failed", error: "No conversation found with session ID 123", sessionId: "11111111-2222-3333-4444-555555555555", worktree: "/tmp/it's here" });
  ticket(home, SLUG, "t_20261101_capd", { status: "review", outcome: "blocked", capHit: { capUsd: 2.5, at: at(9) }, capNextUsd: 7, runCapUsd: 0 });
  ticket(home, SLUG, "t_20261101_limt", { status: "review", outcome: "limit", limit: { auto: false, resetAt: at(300) } });
  ticket(home, SLUG, "t_20261101_ask1", { status: "review", outcome: "needs_input", runEndedAt: at(12) });
  ticket(home, SLUG, "t_20261101_askc", { status: "review", outcome: "needs_input", runEndedAt: at(12), closedForms: { u1: { at: at(13), by: "user", run: at(12) } } });
  ticket(home, SLUG, "t_20261101_stuk", { status: "review", plan: { state: "stuck", reason: "no   progress\nat all" } });
  ticket(home, SLUG, "t_20261101_snoz", { status: "review", snooze: { until: "9999-12-31T23:59:59.000Z", key: "review|Ready for review||||" } });
  ticket(home, SLUG, "t_20261101_snox", { status: "review", snooze: { until: "2000-01-01T00:00:00.000Z", key: "review|Ready for review||||" } });
  ticket(home, SLUG, "t_20261101_miss", { status: "done", followUp: { at: at(20), missedAt: at(21), note: "check" }, doneAt: at(22) });
  ticket(home, SLUG, "t_20261101_plan", { status: "planning", runCapUsd: 4 });
  ticket(home, SLUG, "t_20261101_rdy1", { status: "ready", slotWait: { at: at(2) } });
  ticket(home, SLUG, "t_20261101_ipr1", { status: "ready", slotWait: { at: at(1) }, stalled: { minutes: 25, at: at(60) } });
  ticket(home, SLUG, "t_20261101_kid1", { status: "backlog", parentId: "t_20261101_main", showOnBoard: false, partOf: "t_20261101_main" });
  ticket(home, SLUG, "t_20261101_shar", { status: "review", shareLinks: [{ file: "out/report.html", url: "https://claude.ai/artifact/abc-1", at: at(49) }] });
  // Done: 45 cards in order, one pinned, a hidden task, a hidden gathered card, a test with a problem.
  for (let i = 0; i < 45; i++) {
    ticket(home, SLUG, `t_20261102_d${String(i).padStart(3, "0")}`, { title: `Done ${i} ${i % 3 ? "alpha" : "beta"}`, status: "done", doneAt: at(100 + i), tags: i % 5 ? [] : ["ship"] },
      i === 7 ? "the fox was here\n" : "");
  }
  ticket(home, SLUG, "t_20261102_pin1", { status: "done", pinnedAt: at(500), title: "Pinned fox" });
  ticket(home, SLUG, "t_20261102_htol", { status: "done", tool: true, parentId: "t_20261101_main", title: "Hidden fox task" });
  ticket(home, SLUG, "t_20261102_hcrd", { status: "done", partOf: "t_20261101_revw", showOnBoard: false, title: "Hidden card" });
  // A file that doesn't parse.
  mkdirSync(join(home, "profiles", SLUG, "tickets", "t_20261103_brkn"), { recursive: true });
  writeFileSync(join(home, "profiles", SLUG, "tickets", "t_20261103_brkn", "ticket.md"), "not a ticket\n");
  ticket(home, OTHER, "t_20261104_oth1", { status: "review", title: "Other board fox" });
  ticket(home, OTHER, "t_20261104_oth2", { status: "done", title: "Other done fox" });
}

const BOARD = `/api/profiles/${SLUG}`;
const T = `${BOARD}/tickets`;
/** Every read the routes answer, with what they are checked against. */
const READS = [
  "/api/profiles", BOARD, "/api/profiles/nope", "/api/profiles/nope/tickets?scope=board",
  `${T}?scope=board`, `${T}?scope=board&done=5&ids=t_20261102_d040,t_20261101_tst1`, `${T}?scope=board&done=20&after=t_20261102_d003`,
  `${T}?scope=board&after=t_20261101_revw`, `${T}?scope=done&offset=0&limit=20`, `${T}?scope=done&after=t_20261102_d019`, `${T}?scope=done&offset=40`,
  `${T}?scope=done&limit=500`, `${T}?scope=search&q=fox`, `${T}?scope=search&tags=ship`, `${T}?scope=search&q=`, `${T}?scope=ids&ids=t_20261102_htol`,
  `${T}?scope=list`, `${T}?scope=list&status=done&limit=10`, `${T}?scope=list&status=done&limit=10&after=t_20261102_d037`, `${T}?scope=list&tool=1`,
  `${T}?scope=list&q=fox`, `${T}?scope=list&tags=ui,api`, `${T}?scope=list&status=bogus`, `${T}?scope=count`, `${T}?scope=nope`, T,
  `${T}/t_20261101_main`, `${T}/t_20261101_fald`, `${T}/t_20261101_tst2`, `${T}/t_20261101_subf`, `${T}/t_20261101_kid1`, `${T}/t_nope`,
  "/api/tickets?scope=open", "/api/tickets?scope=done&q=fox", "/api/tickets?scope=done&q=fox&board=other&limit=3", "/api/tickets?scope=done&q=%2342",
  "/api/tickets?scope=done&q=", "/api/tickets?scope=bad", "/api/tickets", "/api/inbox",
];

let d: Daemon;

beforeAll(async () => {
  d = await startDaemon({ before: ({ home, project }) => seed(home, project) });
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const ids = (r: { data: any }) => (r.data.tickets ?? r.data).map((t: any) => t.id);

describe("read routes on a board written as files", () => {
  test("boards", async () => {
    const list = await d.api("GET", "/api/profiles");
    expect(list.data.map((p: any) => p.slug)).toEqual([SLUG, OTHER]);
    expect(list.data[0]).toMatchObject({ name: "Reads", pathExists: false, running: 0, runCapUsd: 3 });
    expect((await d.api("GET", BOARD)).data).toMatchObject({ slug: SLUG, name: "Reads" });
    expect(await d.api("GET", "/api/profiles/nope")).toMatchObject({ status: 404, data: { error: "board nope not found" } });
  });

  test("the board's first load: open work with whole families, Done counted", async () => {
    const r = await d.api("GET", `${T}?scope=board`);
    expect(r.status).toBe(200);
    expect(r.data.doneTotal).toBe(47);
    const got: string[] = ids(r);
    // The main ticket's whole family comes along (its Done tasks too); Done cards on their own don't.
    for (const id of ["t_20261101_main", "t_20261101_tst1", "t_20261102_htol", "t_20261101_sub1", "t_20261103_brkn"]) expect(got).toContain(id);
    expect(got).not.toContain("t_20261102_d000");
    expect(got).not.toContain("t_20261101_miss");
    const main = r.data.tickets.find((t: any) => t.id === "t_20261101_main");
    expect(main).toMatchObject({ feature: true, running: false, familyWorking: 2, stepsRunning: 0, attention: { kind: "questions", label: "Phone check needs you", stepId: "t_20261101_ywou" } });
    expect(main.familyCard).toMatchObject({ tools: 6, toolsDone: 2, tasks: 6, tasksDone: 2, running: ["Test: sign in"], working: ["Test: sign in", "Sub feature"], line: { text: "Phone check needs you", tone: "warn" } });
    const kid = r.data.tickets.find((t: any) => t.id === "t_20261101_tst2");
    expect(kid).toMatchObject({ mainTicket: { id: "t_20261101_main", title: "Launch kit" }, browsersAbove: [{ kind: "ask" }], chromeAbove: "ask", attention: null });
    const broken = r.data.tickets.find((t: any) => t.id === "t_20261103_brkn");
    expect(broken).toMatchObject({ title: "t_20261103_brkn", status: "backlog" });
    expect(broken.error).toStartWith("corrupt ticket file:");
    // With Done cards, the ids asked for and a cursor.
    const more = await d.api("GET", `${T}?scope=board&done=5&ids=t_20261102_d040&after=t_20261102_d003`);
    expect(ids(more)).toContain("t_20261102_d040");
    expect(ids(more)).toContain("t_20261102_pin1");
    expect(more.data.doneHead).toMatch(/^6:/);
    expect((await d.api("GET", `${T}?scope=board&after=t_20261101_revw`)).data.doneHead).toBeNull();
  });

  test("Done pages, search, ids, list pages and the count", async () => {
    const p1 = await d.api("GET", `${T}?scope=done&offset=0&limit=20`);
    expect(ids(p1)[0]).toBe("t_20261102_pin1");
    expect(ids(p1)).toHaveLength(20);
    const p2 = await d.api("GET", `${T}?scope=done&after=${ids(p1)[19]}`);
    expect(ids(p1).slice(0, 3)).toEqual(["t_20261102_pin1", "t_20261101_miss", "t_20261102_d000"]);
    expect(ids(p2)[0]).toBe("t_20261102_d018");
    const s = await d.api("GET", `${T}?scope=search&q=fox`);
    expect(ids(s)).toEqual(expect.arrayContaining(["t_20261102_d007", "t_20261102_pin1", "t_20261101_main", "t_20261102_htol"]));
    expect(ids(await d.api("GET", `${T}?scope=ids&ids=t_20261102_htol`))).toContain("t_20261101_main");
    const l = await d.api("GET", `${T}?scope=list&status=done&limit=10`);
    expect(l.data).toMatchObject({ total: 48, matched: 48, doneLeft: 0, next: "t_20261102_d037" });
    expect(ids(await d.api("GET", `${T}?scope=list&q=fox`))).toContain("t_20261102_pin1");
    expect((await d.api("GET", `${T}?scope=list&status=bogus`)).status).toBe(400);
    expect((await d.api("GET", `${T}?scope=count`)).data).toEqual({ total: 72, open: 22, doneTotal: 47 });
    expect((await d.api("GET", `${T}?scope=nope`)).data).toEqual({ error: "scope must be board, done, search, ids, list or count" });
  });

  test("one ticket, the command bar and the Inbox", async () => {
    const f = await d.api("GET", `${T}/t_20261101_fald`);
    expect(f.data).toMatchObject({ recovery: "session_missing", attention: { kind: "failed", label: "Run failed" }, runCap: 3 });
    expect(f.data.resumeCommand).toBe("cd '/tmp/it'\\''s here' && claude --resume 11111111-2222-3333-4444-555555555555");
    expect((await d.api("GET", `${T}/t_20261101_revw`)).data.links.map((l: any) => l.source)).toEqual(["result", "result"]);
    expect(await d.api("GET", `${T}/t_nope`)).toMatchObject({ status: 404, data: { error: "ticket t_nope not found" } });
    const open = await d.api("GET", "/api/tickets?scope=open");
    expect(open.data.find((r: any) => r.id === "t_20261101_tst2")).toMatchObject({ mainTicket: { id: "t_20261101_main" }, profileName: "Reads" });
    const done = await d.api("GET", "/api/tickets?scope=done&q=fox&board=other&limit=3");
    expect(done.data.map((r: any) => r.id)).toEqual(["t_20261104_oth2", "t_20261102_htol", "t_20261102_pin1"]);
    expect((await d.api("GET", "/api/tickets?scope=done&q=%2342")).data).toEqual([]);
    const inbox = await d.api("GET", "/api/inbox");
    const kinds = Object.fromEntries(inbox.data.map((r: any) => [r.id, r.attention.label]));
    expect(kinds).toMatchObject({
      t_20261101_main: "Phone check needs you", t_20261101_revw: "Ready for review", t_20261101_fald: "Run failed", t_20261101_capd: "Stopped at $2.50 cap",
      t_20261101_limt: "Limit hit", t_20261101_ask1: "Answer Claude", t_20261101_stuk: "Plan stuck", t_20261101_miss: "Missed follow-up",
    });
    expect(inbox.data.find((r: any) => r.id === "t_20261101_snoz")).toMatchObject({ snoozedUntil: "9999-12-31T23:59:59.000Z" });
    expect(kinds.t_20261101_askc).toBe("Ready for review");
    expect(kinds.t_20261101_ywou).toBeUndefined();
  });
});

/** An answer's text with the daemon's own folders named the same way on both sides. */
async function answer(x: Daemon, path: string): Promise<{ status: number; data: unknown }> {
  const r = await x.api("GET", path);
  const text = r.text.split(x.home).join("<home>").split(x.project).join("<project>");
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  // A broken file's placeholder is dated when it is read.
  const scrub = (v: any): any => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = scrub(val);
      if ((typeof out.error === "string" && out.error.startsWith("corrupt ticket file")) || (out.id === "t_20261103_brkn" && "updatedAt" in out)) {
        out.updatedAt = "<now>";
        if ("createdAt" in out) out.createdAt = "<now>";
        if ("error" in out) out.error = "corrupt ticket file";
      }
      return out;
    }
    return v;
  };
  return { status: r.status, data: scrub(data) };
}

describe("the answers are Bun's", () => {
  test("every read route, against Bun's answers on the same files (golden/board-reads.json)", async () => {
    const golden = new Golden("board-reads");
    // Recording (golden.ts): Bun alone on the same files.
    const bun = RECORD ? await startDaemon({ cmd: BUN_DAEMON_CMD, env: { CKANBAN_RUST_BOARD: "0" }, before: ({ home, project }) => seed(home, project) }) : null;
    try {
      for (const path of READS) {
        const mine = await answer(bun ?? d, path);
        golden.match(path, { path, ...mine });
      }
      golden.done();
    } finally {
      await bun?.stop();
    }
  }, 120_000);
});
