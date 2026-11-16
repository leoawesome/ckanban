// Outside-in contract: the daemon restart and runs. POST /api/restart holds new runs until the active ones finish, then
// the daemon exits (launchd starts it again; here the test does, on the same data folder). A daemon stopped (SIGTERM)
// while runs are going resumes them after its next start: a work run in the same session, a follow-up wake as a
// follow-up, a main ticket woken again from its saved events. See contracts/api.md (System: /api/restart) and
// contracts/data-files.md (ticket.md, comments.jsonl).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { events, Scripts, scriptDir, running, settled, view } from "./runs";

let d: Daemon;
let s: Scripts;
let root: string;
let anchor: string;
const SLUG = "restart";
const T = `/api/profiles/${SLUG}/tickets`;
// Waits are long: this file starts, stops and starts the daemon again, which is slow when the whole suite runs at once.
const WAIT = 60_000;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ck-contract-restart-"));
  s = new Scripts(scriptDir(root));
  d = await startDaemon({ env: { FAKE_SCRIPT_DIR: s.dir } });
  expect((await d.api("POST", "/api/profiles", { name: "Restart", path: d.project })).status).toBe(201);
  // Tickets made with partOf are not main tickets: their cut-off work runs resume as work runs.
  anchor = (await d.api("POST", T, { title: "Anchor", body: "" })).data.id;
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

// The follow-up ticket lives on a second board with its own folder: on one plain folder, runs that edit wait for
// each other (folderWait), and the cut-off work run holds the first one.
const FU = "restart-fu";
const slugOf = new Map<string, string>();
const dir = (id: string) => join(d.home, "profiles", slugOf.get(id) ?? SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(dir(id), "ticket.md"), "utf8")).meta;
const comments = (id: string) => readJsonl(join(dir(id), "comments.jsonl"));

async function create(title: string, body: string, status = "ready", main = false, slug = SLUG): Promise<any> {
  const partOf = main ? {} : { partOf: slug === SLUG ? anchor : (await d.api("POST", `/api/profiles/${slug}/tickets`, { title: "Anchor", body: "" })).data.id };
  const r = await d.api("POST", `/api/profiles/${slug}/tickets`, { title, body, status, mode: "auto", ...partOf });
  slugOf.set(r.data.id, slug);
  expect(r.status).toBe(201);
  expect(r.data.main ?? false).toBe(main);
  return r.data;
}

describe("POST /api/restart", () => {
  test("waits for the active run, holds new runs meanwhile, then exits; the next start runs what was held", async () => {
    const ev = await events(d);
    const gate = s.gate("busy");
    const busy = await create("Busy", `x ${s.set("busy", [{ waitFile: gate.file, summary: "Busy done." }])}`);
    await running(d, SLUG, busy.id, WAIT);
    expect((await d.api("GET", "/api/restart")).data).toEqual({ pending: false, waiting: 1 });

    const r = await d.api("POST", "/api/restart", {});
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ running: 1, alreadyPending: false });
    expect((await d.api("GET", "/api/restart")).data).toEqual({ pending: true, waiting: 1 });
    expect((await d.api("POST", "/api/restart", {})).data).toEqual({ running: 1, alreadyPending: true });
    await until(() => ev.all.some((e) => e.type === "restart.updated" && e.pending === true && e.waiting === 1), 5_000, "restart.updated");

    // A ticket moved to Ready now waits for the restart.
    const held = await create("Held", `x ${s.set("held", [{ summary: "Held done." }])}`);
    await Bun.sleep(1_000);
    expect(s.runs("held")).toHaveLength(0);
    expect((await view(d, SLUG, held.id)).running).toBe(false);

    // The active run finishes; then the daemon exits by itself.
    gate.release();
    const code = await Promise.race([d.exited(), Bun.sleep(WAIT).then(() => "still running")]);
    expect(code).toBe(0);
    ev.close();
    expect(meta(busy.id)).toMatchObject({ status: "review", outcome: "done" });

    await d.respawn();
    expect((await d.api("GET", "/api/restart")).data).toEqual({ pending: false, waiting: expect.any(Number) });
    const v = await settled(d, SLUG, held.id, (x) => x.status === "review", WAIT);
    expect(v.outcome).toBe("done");
    expect(s.runs("held")).toHaveLength(1);
  }, 240_000);
});

describe("runs cut off by a daemon stop resume after the next start", () => {
  test("a work run, a follow-up wake and a main ticket", async () => {
    // A work run (not a main ticket), cut while it works: resumed in the same session.
    const work = await create("Cut work", `x ${s.set("cut", [{ waitFile: join(s.dir, "never") }, { summary: "Finished after restart." }])}`);
    // A follow-up wake cut while it works: continued as a follow-up, the card goes back to Review.
    const fuDir = join(root, "fu-project");
    mkdirSync(fuDir);
    expect((await d.api("POST", "/api/profiles", { name: FU, path: fuDir })).status).toBe(201);
    const fu = await create("Cut follow-up", `x ${s.set("fu", [{}, { waitFile: join(s.dir, "never") }, { summary: "Followed up." }])}`, "ready", false, FU);
    // A main ticket cut while it works: woken again from its saved events, never a fresh work run.
    const main = await create("Cut main", `x ${s.set("main", [{ waitFile: join(s.dir, "never") }])}`, "ready", true);

    await settled(d, FU, fu.id, (x) => x.status === "review", WAIT);
    expect((await d.api("POST", `/api/profiles/${FU}/tickets/${fu.id}/follow-up`, { after: "2h", note: "Look again" })).status).toBe(201);
    expect((await d.api("POST", `/api/profiles/${FU}/tickets/${fu.id}/follow-up/now`, {})).status).toBe(202);
    await until(() => s.runs("fu").length === 2, WAIT, "follow-up run");
    await running(d, SLUG, work.id, WAIT);
    await running(d, SLUG, main.id, WAIT);
    await running(d, FU, fu.id, WAIT);
    const session = (await view(d, SLUG, work.id)).sessionId;

    d.kill("SIGTERM");
    expect(await Promise.race([d.exited(), Bun.sleep(WAIT).then(() => "still running")])).toBe(0);
    // What the stop left: the work run and the main ticket still in progress, the follow-up marked as such.
    expect(meta(work.id).status).toBe("in_progress");
    expect(meta(main.id).status).toBe("in_progress");
    expect(meta(fu.id).followUpRun).toMatchObject({ returnTo: "review" });

    await d.respawn();
    const w = await settled(d, SLUG, work.id, (x) => x.status === "review", WAIT);
    expect(w.outcome).toBe("done");
    expect(w.sessionId).toBe(session);
    expect(comments(work.id).some((c) => c.text === "Interrupted by daemon restart; resuming.")).toBe(true);
    const workRuns = s.runs("cut");
    expect(workRuns).toHaveLength(2);
    expect(workRuns[1].args[workRuns[1].args.indexOf("--resume") + 1]).toBe(session);

    const f = await settled(d, FU, fu.id, (x) => x.status === "review" && s.runs("fu").length === 3, WAIT);
    expect(f.followUpRun ?? null).toBeNull();
    expect(comments(fu.id).some((c) => c.text === "Follow-up interrupted by daemon restart; resuming.")).toBe(true);

    const m = await until(async () => {
      const x = await view(d, SLUG, main.id);
      return x.status !== "in_progress" ? x : null;
    }, WAIT, "main ticket out of In Progress");
    expect(comments(main.id).some((c) => c.text === "Interrupted by daemon restart; waking it again from its saved events.")).toBe(true);
    expect(m.status).toBe("review");
    expect(JSON.stringify(meta(main.id).plan ?? {})).toContain("The board restarted while your last run was going");
  }, 300_000);
});
