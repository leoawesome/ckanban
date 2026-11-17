// Outside-in contract: schedules firing by themselves, on the fake Claude: a due schedule creates a ticket that runs,
// writes a "fired" line in <id>.history.jsonl and moves nextRunAt on; one due long ago fires once as "missed"; a paused
// one doesn't fire; "Run now" respects skipIfRunning; a follow-up wakes its ticket at its time. See contracts/api.md
// (Schedules, Follow-ups, "Work the board starts by itself") and data-files.md.
//
// How firing is tested without a test clock (the daemon has none): CKANBAN_TICK_MS makes its timers look every half
// second. Schedules already due are written into the data folder before the daemon starts, so its first look fires
// them at once. One schedule is also made over HTTP with cron "* * * * *" and the test waits for it to fire by itself
// at the next minute (up to 60 s); a follow-up can't be sooner than 1 minute, so it waits about that long too. Both
// are set up first and checked last, so the waits overlap the other tests.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { readJsonl } from "./files";

let d: Daemon;
const SLUG = "fire";
const P = `/api/profiles/${SLUG}`;
const started = new Date();
let everyMinute: any;
let followed: any;

/** A schedule file as the daemon writes it (data-files.md), with a chosen nextRunAt. */
function schedule(id: string, name: string, nextRunAt: string, extra: Record<string, unknown> = {}) {
  const at = new Date(started.getTime() - 86_400_000).toISOString();
  return {
    id, name, title: `${name} {date}`, cron: "0 3 * * *", mode: "auto", body: `${name} body.`, enabled: true, skipIfRunning: true,
    tags: ["nightly"], quiet: false, model: null, partOf: null, createdAt: at, updatedAt: at, lastFiredAt: null, lastError: null, nextRunAt,
    ...extra,
  };
}

beforeAll(async () => {
  d = await startDaemon({
    env: { CKANBAN_TICK_MS: "500" },
    before: ({ home, project }) => {
      const dir = join(home, "profiles", SLUG);
      mkdirSync(join(dir, "schedules"), { recursive: true });
      writeFileSync(join(dir, "profile.json"), `${JSON.stringify({ name: "Fire", slug: SLUG, path: project, baseBranch: "", model: null, createdAt: started.toISOString() }, null, 2)}\n`);
      const ago = (ms: number) => new Date(started.getTime() - ms).toISOString();
      for (const s of [
        schedule("due00one", "Due", ago(5_000)),
        schedule("miss0one", "Missed", ago(2 * 3_600_000)),
        schedule("off00one", "Paused", ago(5_000), { enabled: false }),
      ]) writeFileSync(join(dir, "schedules", `${s.id}.json`), `${JSON.stringify(s, null, 2)}\n`);
    },
  });
  // Fires by itself at the next minute; checked in the last test, so the wait overlaps the others.
  everyMinute = (await d.api("POST", `${P}/schedules`, { name: "Every minute", title: "Minute {time}", body: "Tick.", cron: "* * * * *" })).data;
  // Comes back in 1 minute (the shortest follow-up); checked in the last test too.
  const t = (await d.api("POST", `${P}/tickets`, { title: "Follow me", body: "f" })).data;
  const set = await d.api("POST", `${P}/tickets/${t.id}/follow-up`, { after: "1m", note: "check the deploy" });
  expect(set.status).toBe(201);
  followed = set.data;
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const histFile = (id: string) => join(d.home, "profiles", SLUG, "schedules", `${id}.history.jsonl`);
const fired = (id: string) => readJsonl(histFile(id)).filter((e) => e.kind === "fired");
const today = (d0: Date) => `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;

/** A ticket's run on the fake Claude has started and ended. */
async function ranOnce(ticketId: string) {
  return until(async () => {
    const t = (await d.api("GET", `${P}/tickets/${ticketId}`)).data;
    return t?.sessionId && t.runEndedAt && !t.running ? t : null;
  }, 30_000, `ticket ${ticketId}'s run to end`);
}

describe("due at start", () => {
  test("a due schedule fires: a ticket that runs, a history line, nextRunAt moved on", async () => {
    const [entry] = await until(() => (fired("due00one").length ? fired("due00one") : null), 20_000, "the due schedule to fire");
    expect(entry).toMatchObject({ kind: "fired", trigger: "schedule" });
    expect(Object.keys(entry)).toEqual(["at", "kind", "trigger", "ticketId"]);
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(started.getTime());

    const t = await ranOnce(entry.ticketId);
    expect(t).toMatchObject({ title: `Due ${today(new Date(entry.at))}`, body: "Due body.", scheduleId: "due00one", tags: ["nightly"] });
    expect(t.runCount).toBeGreaterThanOrEqual(1);

    const saved = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "schedules", "due00one.json"), "utf8"));
    expect(saved).toMatchObject({ lastFiredAt: entry.at, lastError: null });
    expect(Date.parse(saved.nextRunAt)).toBeGreaterThan(Date.now());
    // 03:00 local, the cron's next slot.
    expect(new Date(saved.nextRunAt).getHours()).toBe(3);

    // The history route: newest first, with the ticket's current state.
    const h = await d.api("GET", `${P}/schedules/due00one/history`);
    expect(h.status).toBe(200);
    expect(h.data[0]).toMatchObject({ kind: "fired", trigger: "schedule", ticketId: t.id, ticket: { id: t.id, title: t.title, running: false } });
    expect(typeof h.data[0].ticket.status).toBe("string");
    // The list: the view says when it fired.
    const row = (await d.api("GET", `${P}/schedules`)).data.find((x: any) => x.id === "due00one");
    expect(row).toMatchObject({ lastFiredAt: entry.at, active: false, enabled: true });
  }, 60_000);

  test("one due long ago fires once, as missed; a paused one doesn't fire", async () => {
    const [entry] = await until(() => (fired("miss0one").length ? fired("miss0one") : null), 20_000, "the missed schedule to fire");
    expect(entry.trigger).toBe("missed");
    await ranOnce(entry.ticketId);
    expect(fired("miss0one")).toHaveLength(1);
    expect(Date.parse(JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "schedules", "miss0one.json"), "utf8")).nextRunAt)).toBeGreaterThan(Date.now());

    expect(readJsonl(histFile("off00one"))).toEqual([]);
    expect((await d.api("GET", `${P}/tickets`)).data.filter((t: any) => t.scheduleId === "off00one")).toEqual([]);
  }, 60_000);
});

describe("run now", () => {
  test("a manual fire while its ticket is still going is skipped; with skipIfRunning off it fires again", async () => {
    const s = (await d.api("POST", `${P}/schedules`, { name: "Manual", title: "Manual run", body: "Go.", cron: "0 3 1 1 *" })).data;
    const both = await Promise.all([
      d.api("POST", `${P}/schedules/${s.id}/run`, {}),
      d.api("POST", `${P}/schedules/${s.id}/run`, {}),
    ]);
    // Either request may reach the server first: `a` is the one that fired.
    const [a, b] = both[1].data?.entry?.kind === "fired" ? [both[1], both[0]] : both;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.data.entry).toMatchObject({ kind: "fired", trigger: "manual" });
    expect(a.data.schedule).toMatchObject({ id: s.id, lastFiredAt: a.data.entry.at, active: true });
    // The second waits for the first and finds its ticket still in progress.
    expect(b.data.entry).toEqual({ at: b.data.entry.at, kind: "skipped", trigger: "manual", ticketId: a.data.entry.ticketId });
    await ranOnce(a.data.entry.ticketId);

    // A board run's "run now" is noted with its ticket.
    const caller = (await d.api("POST", `${P}/tickets`, { title: "Caller", body: "c" })).data;
    expect((await d.api("PATCH", `${P}/schedules/${s.id}`, { skipIfRunning: false })).data.skipIfRunning).toBe(false);
    const [c, e] = await Promise.all([
      d.api("POST", `${P}/schedules/${s.id}/run`, {}, { "x-ckanban-run": `${SLUG}/${caller.id}` }),
      d.api("POST", `${P}/schedules/${s.id}/run`, {}),
    ]);
    expect(c.data.entry).toMatchObject({ kind: "fired", trigger: "manual", by: { ticketId: caller.id } });
    expect(e.data.entry).toMatchObject({ kind: "fired", trigger: "manual" });
    expect(e.data.entry.by).toBeUndefined();
    expect(c.data.entry.ticketId).not.toBe(e.data.entry.ticketId);
    const lines = readJsonl(histFile(s.id)).map((x) => x.kind);
    expect(lines).toEqual(["edited", "fired", "skipped", "edited", "fired", "fired"]);
    await Promise.all([ranOnce(c.data.entry.ticketId), ranOnce(e.data.entry.ticketId)]);

    // A huddle helper can't; nor a run whose ticket isn't on this board.
    expect((await d.api("POST", `${P}/schedules/${s.id}/run`, {}, { "x-ckanban-huddle-agent": "1" })).status).toBe(403);
    expect((await d.api("POST", `${P}/schedules/${s.id}/run`, {}, { "x-ckanban-run": `${SLUG}/t_gone` })).status).toBe(404);
    expect((await d.api("POST", `${P}/schedules/nope/run`, {})).status).toBe(404);
  }, 60_000);
});

describe("on time", () => {
  test("a schedule made with cron \"* * * * *\" fires by itself at the next minute", async () => {
    const [entry] = await until(() => (fired(everyMinute.id).length ? fired(everyMinute.id) : null), 75_000, "the every-minute schedule to fire");
    expect(entry.trigger).toBe("schedule");
    // Not before the minute it was due.
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(Date.parse(everyMinute.nextRunAt));
    expect(Date.parse(entry.at) - Date.parse(everyMinute.nextRunAt)).toBeLessThan(5_000);
    const t = await ranOnce(entry.ticketId);
    expect(t).toMatchObject({ body: "Tick.", scheduleId: everyMinute.id });
    expect(t.title).toMatch(/^Minute \d{2}:\d{2}$/);
    const saved = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "schedules", `${everyMinute.id}.json`), "utf8"));
    expect(saved.lastFiredAt).toBe(entry.at);
    expect(Date.parse(saved.nextRunAt)).toBeGreaterThan(Date.parse(everyMinute.nextRunAt));
  }, 100_000);
});

describe("follow-ups", () => {
  test("set, refused when too soon, and woken at its time: the ticket's conversation runs again", async () => {
    expect(followed.followUp).toMatchObject({ note: "check the deploy", cancelOnReply: true });
    const due = Date.parse(followed.followUp.dueAt);
    expect(due - Date.parse(followed.followUp.setAt)).toBe(60_000);
    expect(followed.followUpLog.at(-1)).toMatchObject({ kind: "set", dueAt: followed.followUp.dueAt, note: "check the deploy" });

    const other = (await d.api("POST", `${P}/tickets`, { title: "Too soon", body: "x" })).data;
    const soon = await d.api("POST", `${P}/tickets/${other.id}/follow-up`, { after: "30s", note: "n" });
    expect(soon.status).toBe(400);
    const tooSoon = await d.api("POST", `${P}/tickets/${other.id}/follow-up`, { at: new Date(Date.now() + 10_000).toISOString(), note: "n" });
    expect(tooSoon.data.error).toBe("a follow-up must be at least 1 minute away");
    expect((await d.api("POST", `${P}/tickets/${other.id}/follow-up`, { after: "1h" })).data.error).toBe("note is required: why you come back, and what to check then");
    // Another ticket's run can't set it.
    const byOther = await d.api("POST", `${P}/tickets/${other.id}/follow-up`, { after: "1h", note: "n" }, { "x-ckanban-run": `${SLUG}/${followed.id}` });
    expect(byOther.status).toBe(403);

    const woke = await until(async () => {
      const t = (await d.api("GET", `${P}/tickets/${followed.id}`)).data;
      return t.followUpLog?.some((e: any) => e.kind === "woke") ? t : null;
    }, 90_000, "the follow-up to wake its ticket");
    const entry = woke.followUpLog.find((e: any) => e.kind === "woke");
    expect(entry).toMatchObject({ dueAt: followed.followUp.dueAt, note: "check the deploy" });
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(due);
    expect(Date.parse(entry.at) - due).toBeLessThan(5_000);
    // Cleared before its run starts, so it can't wake twice.
    expect(woke.followUp ?? null).toBeNull();
    await ranOnce(followed.id);
  }, 120_000);
});
