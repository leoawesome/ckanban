// Outside-in contract: schedules (create, list, pause, resume, run history, delete) over HTTP, and the files under
// profiles/<slug>/schedules/. See contracts/api.md and contracts/data-files.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";
import { readJsonl } from "./files";

let d: Daemon;
const SLUG = "sched";
const base = `/api/profiles/${SLUG}/schedules`;

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Sched", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const dir = () => join(d.home, "profiles", SLUG, "schedules");

test("create, list, pause, resume and delete a schedule", async () => {
  const created = await d.api("POST", base, { name: "Nightly", title: "Nightly check {date}", body: "Check things.", cron: "0 3 * * *" });
  expect(created.status).toBe(201);
  const s = created.data;
  expect(s).toMatchObject({
    name: "Nightly", title: "Nightly check {date}", body: "Check things.", cron: "0 3 * * *",
    mode: "auto", enabled: true, skipIfRunning: true, quiet: false, model: null, tags: [], partOf: null,
    lastFiredAt: null, lastError: null,
  });
  expect(typeof s.id).toBe("string");
  expect(Date.parse(s.nextRunAt)).toBeGreaterThan(Date.now());

  // <id>.json holds the schedule; <id>.history.jsonl its edits and fires.
  const file = join(dir(), `${s.id}.json`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved).toMatchObject({ id: s.id, name: "Nightly", cron: "0 3 * * *", enabled: true, createdAt: s.createdAt, updatedAt: s.updatedAt });
  const hist = readJsonl(join(dir(), `${s.id}.history.jsonl`));
  expect(hist.at(-1)).toMatchObject({ kind: "edited", action: "created", fields: [], by: "user" });

  const list = await d.api("GET", base);
  expect(list.status).toBe(200);
  const row = list.data.find((x: any) => x.id === s.id);
  expect(row).toMatchObject({ id: s.id, name: "Nightly", enabled: true, spend7dUsd: 0 });
  expect(Array.isArray(row.quietPerDay)).toBe(true);

  const paused = await d.api("PATCH", `${base}/${s.id}`, { enabled: false });
  expect(paused.status).toBe(200);
  expect(paused.data).toMatchObject({ enabled: false, nextRunAt: null });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ enabled: false, nextRunAt: null });
  const pausedRow = (await d.api("GET", base)).data.find((x: any) => x.id === s.id);
  expect(pausedRow).toMatchObject({ enabled: false, pausedBy: "user" });
  expect(typeof pausedRow.pausedAt).toBe("string");

  const resumed = await d.api("PATCH", `${base}/${s.id}`, { enabled: true });
  expect(resumed.data.enabled).toBe(true);
  expect(typeof resumed.data.nextRunAt).toBe("string");

  const history = await d.api("GET", `${base}/${s.id}/history`);
  expect(history.status).toBe(200);
  expect(history.data.map((e: any) => e.action).filter(Boolean)).toEqual(expect.arrayContaining(["created", "paused", "resumed"]));

  const del = await d.api("DELETE", `${base}/${s.id}`);
  expect(del.status).toBe(204);
  expect(existsSync(file)).toBe(false);
  expect((await d.api("GET", base)).data.find((x: any) => x.id === s.id)).toBeUndefined();
  expect((await d.api("PATCH", `${base}/${s.id}`, { enabled: false })).status).toBe(404);
});

test("validation errors", async () => {
  const noName = await d.api("POST", base, { title: "t", cron: "0 3 * * *" });
  expect(noName.status).toBe(400);
  expect(noName.data.error).toBe("name is required");
  const badCron = await d.api("POST", base, { name: "n", title: "t", cron: "every day" });
  expect(badCron.status).toBe(400);
  expect(badCron.data.error).toStartWith("invalid cron expression");
  expect((await d.api("GET", "/api/profiles/nope/schedules")).status).toBe(404);
});
