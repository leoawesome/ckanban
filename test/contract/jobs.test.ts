// Outside-in contract: one-time jobs (create, change, cancel, run now, firing at their time, late firing) over HTTP,
// and profiles/<slug>/jobs/<id>.json. See contracts/api.md (Jobs) and contracts/data-files.md (one-time jobs).
//
// Firing at a set time: the daemon has no test clock. It checks for due jobs once at start and then every 30 s, so a
// job set a few seconds ahead fires within about 30 s. A late job (due over 10 minutes ago) can't be made over HTTP
// (`at` must be in the future), so the test writes its file straight into the jobs folder, as an outside edit; the
// next check sees it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";

let d: Daemon;
const SLUG = "jobs";
const P = `/api/profiles/${SLUG}`;
const RUN = "x-ckanban-run";
const HUDDLE = "x-ckanban-huddle-agent";

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Jobs", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const jobFile = (id: string) => join(d.home, "profiles", SLUG, "jobs", `${id}.json`);
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const getJob = async (id: string) => (await d.api("GET", `${P}/jobs/${id}`)).data;
const ticketJob = (title = "Do it", body = "Do the thing.") => ({ kind: "ticket", title, body });

/** A ticket's run on the fake Claude has started and ended. */
async function ranOnce(ticketId: string) {
  return until(async () => {
    const t = (await d.api("GET", `${P}/tickets/${ticketId}`)).data;
    return t?.sessionId && t.runEndedAt && !t.running ? t : null;
  }, 30_000, `ticket ${ticketId}'s run to end`);
}

describe("create, change, cancel", () => {
  test("a ticket job and a command job are saved as scheduled; GET one, list", async () => {
    const at = inAnHour();
    const created = await d.api("POST", `${P}/jobs`, { name: " Later ", at, action: { ...ticketJob(), mode: "interview" } });
    expect(created.status).toBe(201);
    const j = created.data;
    expect(j).toMatchObject({
      name: "Later", at, action: { kind: "ticket", title: "Do it", body: "Do the thing.", mode: "interview" },
      state: "scheduled", sourceTicketId: null, firedAt: null, result: null,
    });
    expect(j.id).toMatch(/^[0-9a-z]{8}$/);
    expect(j.when).toMatch(/\(in (60 minutes|1 hour)\)$/);
    // The file: the job without the view's `when`, in the documented key order.
    const saved = JSON.parse(readFileSync(jobFile(j.id), "utf8"));
    expect(Object.keys(saved)).toEqual(["id", "name", "at", "action", "state", "sourceTicketId", "createdAt", "updatedAt", "firedAt", "result"]);
    expect(readFileSync(jobFile(j.id), "utf8")).toBe(`${JSON.stringify(saved, null, 2)}\n`);

    const cmd = (await d.api("POST", `${P}/jobs`, { name: "Cmd", at, action: { kind: "command", command: " echo hi ", timeoutSec: 30.4, ifLate: "run" } })).data;
    expect(cmd.action).toEqual({ kind: "command", command: "echo hi", timeoutSec: 30, ifLate: "run" });
    // ifLate "skip" is the default and is not written.
    const skip = (await d.api("POST", `${P}/jobs`, { name: "Cmd2", at, action: { kind: "command", command: "true", ifLate: "skip" } })).data;
    expect(skip.action).toEqual({ kind: "command", command: "true" });

    expect(await getJob(j.id)).toMatchObject({ id: j.id, name: "Later", state: "scheduled" });
    const list = await d.api("GET", `${P}/jobs`);
    expect(list.status).toBe(200);
    expect(list.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([j.id, cmd.id, skip.id]));
    expect(list.data.every((x: any) => typeof x.when === "string")).toBe(true);
    // A local time without a zone is this computer's time.
    const local = (await d.api("POST", `${P}/jobs`, { name: "Local", at: "2099-01-02 09:30", action: ticketJob() })).data;
    expect(local.at).toBe(new Date(2099, 0, 2, 9, 30).toISOString());
  });

  test("validation errors", async () => {
    const at = inAnHour();
    const err = async (body: unknown, status = 400) => {
      const r = await d.api("POST", `${P}/jobs`, body);
      expect(r.status).toBe(status);
      return r.data.error as string;
    };
    expect(await err({ at, action: ticketJob() })).toBe("name is required");
    expect(await err({ name: "x", at: "tomorrow", action: ticketJob() })).toStartWith("at must be a date and time like");
    expect(await err({ name: "x", at: "2026-02-31 10:00", action: ticketJob() })).toStartWith("at must be a date and time like");
    expect(await err({ name: "x", at: "2020-01-01 10:00", action: ticketJob() })).toEndWith("is in the past: pick a time from now on");
    expect(await err({ name: "x", at })).toStartWith("action is required");
    expect(await err({ name: "x", at, action: { kind: "email" } })).toBe('action.kind must be "ticket" or "command"');
    expect(await err({ name: "x", at, action: { kind: "ticket", body: "b" } })).toBe("a ticket job needs a title");
    expect(await err({ name: "x", at, action: { kind: "ticket", title: "t", body: "  " } })).toStartWith("a ticket job needs a body");
    expect(await err({ name: "x", at, action: { kind: "command", command: " " } })).toBe("a command job needs a command");
    expect(await err({ name: "x", at, action: { kind: "command", command: "true", ifLate: "later" } })).toBe('ifLate must be "skip" (default) or "run"');
    expect(await err({ name: "x", at, action: { kind: "command", command: "true", timeoutSec: 0 } })).toBe("timeoutSec must be between 1 and 86400");
    expect((await d.api("POST", "/api/profiles/nope/jobs", { name: "x", at, action: ticketJob() })).status).toBe(404);
    expect((await d.api("GET", `${P}/jobs/zzzzzzzz`)).status).toBe(404);
    expect((await d.api("GET", `${P}/jobs/zzzzzzzz`)).data.error).toBe("job zzzzzzzz not found");
  });

  test("change: name, time, a whole new action; an incomplete action is refused", async () => {
    const j = (await d.api("POST", `${P}/jobs`, { name: "Edit me", at: inAnHour(), action: ticketJob() })).data;
    const at = new Date(Date.now() + 7_200_000).toISOString();
    const changed = await d.api("PATCH", `${P}/jobs/${j.id}`, { name: "Edited", at, action: { kind: "command", command: "echo changed" } });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ name: "Edited", at, action: { kind: "command", command: "echo changed" }, state: "scheduled" });
    // The user's change: no changedBy.
    expect(changed.data.changedBy).toBeUndefined();
    expect(JSON.parse(readFileSync(jobFile(j.id), "utf8"))).toMatchObject({ name: "Edited", at });

    const partial = await d.api("PATCH", `${P}/jobs/${j.id}`, { action: { kind: "ticket", title: "only a title" } });
    expect(partial.status).toBe(400);
    expect(partial.data.error).toBe("a ticket job needs a body: the prompt the new ticket's run gets: send the whole action (kind and all its fields), not only the part you change");
    expect((await d.api("PATCH", `${P}/jobs/${j.id}`, { name: " " })).data.error).toBe("name can't be empty");
    expect((await d.api("PATCH", `${P}/jobs/${j.id}`, { at: "2020-01-01 10:00" })).status).toBe(400);
  });

  test("cancel; a cancelled job can't be changed, cancelled or run again (409)", async () => {
    const j = (await d.api("POST", `${P}/jobs`, { name: "Cancel me", at: inAnHour(), action: ticketJob() })).data;
    const c = await d.api("POST", `${P}/jobs/${j.id}/cancel`, {});
    expect(c.status).toBe(200);
    expect(c.data).toMatchObject({ id: j.id, state: "cancelled", firedAt: null });
    expect(JSON.parse(readFileSync(jobFile(j.id), "utf8")).state).toBe("cancelled");
    for (const [m, path, body] of [["PATCH", "", { name: "x" }], ["POST", "/cancel", {}], ["POST", "/run", {}]] as const) {
      const r = await d.api(m, `${P}/jobs/${j.id}${path}`, body);
      expect(r.status).toBe(409);
      expect(r.data.error).toBe(`job ${j.id} is cancelled: only a scheduled job can be changed`);
    }
    // Finished jobs still show in the list (the recent ones).
    expect((await d.api("GET", `${P}/jobs`)).data.find((x: any) => x.id === j.id)?.state).toBe("cancelled");
  });

  test("a board run's changes are credited to its ticket; huddle helpers and unknown tickets are refused", async () => {
    const src = (await d.api("POST", `${P}/tickets`, { title: "Source", body: "s" })).data;
    const h = { [RUN]: `${SLUG}/${src.id}` };
    const j = (await d.api("POST", `${P}/jobs`, { name: "From a run", at: inAnHour(), action: ticketJob() }, h)).data;
    expect(j.sourceTicketId).toBe(src.id);
    const ch = (await d.api("PATCH", `${P}/jobs/${j.id}`, { name: "Changed by run" }, h)).data;
    expect(ch.changedBy).toMatchObject({ ticketId: src.id, action: "changed" });
    expect(typeof ch.changedBy.at).toBe("string");
    // ?ticketId= lists only that ticket's jobs.
    const mine = (await d.api("GET", `${P}/jobs?ticketId=${src.id}`)).data;
    expect(mine.map((x: any) => x.id)).toEqual([j.id]);
    // The user's next change drops changedBy.
    expect((await d.api("PATCH", `${P}/jobs/${j.id}`, { name: "Mine" })).data.changedBy).toBeUndefined();
    const cancelled = (await d.api("POST", `${P}/jobs/${j.id}/cancel`, {}, h)).data;
    expect(cancelled.changedBy).toMatchObject({ ticketId: src.id, action: "cancelled" });

    const huddle = await d.api("POST", `${P}/jobs`, { name: "x", at: inAnHour(), action: ticketJob() }, { [HUDDLE]: "1", ...h });
    expect(huddle.status).toBe(403);
    expect(huddle.data.error).toBe("huddle participants can't schedule or change jobs; ask @main");
    const gone = await d.api("POST", `${P}/jobs`, { name: "x", at: inAnHour(), action: ticketJob() }, { [RUN]: `${SLUG}/t_gone` });
    expect(gone.status).toBe(404);
    expect(gone.data.error).toBe("ticket t_gone not found");
  });
});

describe("run now", () => {
  test("a ticket job makes a ticket that runs on the fake Claude", async () => {
    const j = (await d.api("POST", `${P}/jobs`, { name: "Now", at: inAnHour(), action: ticketJob("Made by a job", "Job body.") })).data;
    const r = await d.api("POST", `${P}/jobs/${j.id}/run`, {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id: j.id, state: "done" });
    expect(typeof r.data.firedAt).toBe("string");
    const tid = r.data.result.ticketId as string;
    expect(tid).toMatch(/^t_/);
    const t = await ranOnce(tid);
    // Started by the user ahead of time: no "late" or chain lines before the prompt.
    expect(t).toMatchObject({ title: "Made by a job", body: "Job body.", jobId: j.id });
  }, 40_000);

  test("a command job runs in the board folder with its env; a failing one is failed with its output", async () => {
    const ok = (await d.api("POST", `${P}/jobs`, { name: "Echo", at: inAnHour(), action: { kind: "command", command: 'echo "$CKANBAN_BOARD $CKANBAN_JOB $(basename "$PWD")"' } })).data;
    const started = await d.api("POST", `${P}/jobs/${ok.id}/run`, {});
    expect(started.status).toBe(200);
    // Answered once it started; the command may still be running.
    expect(["running", "done"]).toContain(started.data.state);
    const done = await until(async () => { const x = await getJob(ok.id); return x.state === "done" ? x : null; }, 15_000, "the command job");
    expect(done.result).toMatchObject({ exitCode: 0, timedOut: false, output: `${SLUG} ${ok.id} project\n` });
    expect(typeof done.result.durationMs).toBe("number");

    const bad = (await d.api("POST", `${P}/jobs`, { name: "Fails", at: inAnHour(), action: { kind: "command", command: "echo oops; exit 3" } })).data;
    await d.api("POST", `${P}/jobs/${bad.id}/run`, {});
    const failed = await until(async () => { const x = await getJob(bad.id); return x.state === "failed" ? x : null; }, 15_000, "the failing job");
    expect(failed.result).toMatchObject({ exitCode: 3, output: "oops\n", timedOut: false, message: "exited with code 3" });

    const slow = (await d.api("POST", `${P}/jobs`, { name: "Slow", at: inAnHour(), action: { kind: "command", command: "sleep 30", timeoutSec: 1 } })).data;
    await d.api("POST", `${P}/jobs/${slow.id}/run`, {});
    const stopped = await until(async () => { const x = await getJob(slow.id); return x.state === "failed" ? x : null; }, 15_000, "the slow job to be stopped");
    expect(stopped.result).toMatchObject({ exitCode: null, timedOut: true, message: "stopped after 1 s (time limit)" });
  }, 40_000);
});

describe("firing at their time", () => {
  test("a job due in 2 s fires on the next check; late jobs: a ticket job still runs, a command job is skipped", async () => {
    const at = new Date(Date.now() + 2_000).toISOString();
    const soon = (await d.api("POST", `${P}/jobs`, { name: "Soon", at, action: ticketJob("Due soon", "Soon body.") })).data;
    const soonCmd = (await d.api("POST", `${P}/jobs`, { name: "Soon cmd", at, action: { kind: "command", command: "echo fired" } })).data;

    // Due 20 minutes ago (written as an outside edit; see the top of this file).
    const due = new Date(Date.now() - 20 * 60_000).toISOString();
    const now = new Date().toISOString();
    const seed = (id: string, name: string, action: unknown) => writeFileSync(jobFile(id), `${JSON.stringify({
      id, name, at: due, action, state: "scheduled", sourceTicketId: null, createdAt: now, updatedAt: now, firedAt: null, result: null,
    }, null, 2)}\n`);
    seed("late0tkt", "Late ticket", { kind: "ticket", title: "Late one", body: "Late body.", mode: "auto" });
    seed("late0cmd", "Late cmd", { kind: "command", command: "echo should-not-run" });
    seed("late0run", "Late cmd run", { kind: "command", command: "echo ran-late", ifLate: "run" });

    const ids = [soon.id, soonCmd.id, "late0tkt", "late0cmd", "late0run"];
    // The daemon checks every 30 s.
    const jobs = await until(async () => {
      const all = await Promise.all(ids.map(getJob));
      return all.every((j) => j.state === "done" || j.state === "skipped" || j.state === "failed") ? all : null;
    }, 45_000, "every job to fire");
    const [s, sc, lt, lc, lr] = jobs;

    expect(s).toMatchObject({ state: "done" });
    expect(Date.parse(s.firedAt)).toBeGreaterThanOrEqual(Date.parse(at));
    const st = await ranOnce(s.result.ticketId);
    expect(st).toMatchObject({ title: "Due soon", body: "Soon body.", jobId: soon.id });
    expect(sc).toMatchObject({ state: "done", result: { exitCode: 0, output: "fired\n" } });

    // Late ticket job: it runs, and its prompt starts with why it is late.
    expect(lt.state).toBe("done");
    const ltt = await ranOnce(lt.result.ticketId);
    expect(ltt.body).toMatch(/^This was due .+ but is running .+ because the computer was off\. Decide if it still makes sense: do it, adapt it, or stop and say why\.\n\nLate body\.$/);
    // Late command job: skipped unless ifLate is "run".
    expect(lc).toMatchObject({ state: "skipped", firedAt: null });
    expect(lc.result.message).toMatch(/^skipped: the computer was off at \w{3} \d{1,2} \w{3} \d{2}:\d{2}$/);
    expect(lr).toMatchObject({ state: "done", result: { exitCode: 0, output: "ran-late\n" } });
    expect(JSON.parse(readFileSync(jobFile("late0cmd"), "utf8")).state).toBe("skipped");
  }, 90_000);
});
