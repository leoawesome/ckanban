// Outside-in contract: after a mix of actions, every file the daemon wrote in its data folder is one that
// contracts/data-files.md lists (its "paths" block), and the profile, ticket and schedule files hold the fields their
// JSON Schemas in contracts/schemas/ require, with the right types.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";

const CONTRACTS = resolve(import.meta.dir, "..", "..", "contracts");
let d: Daemon;
const SLUG = "files";
let ticketId = "";
let scheduleId = "";

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Files", path: d.project })).status).toBe(201);
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Has a chat", body: "b" })).data;
  ticketId = t.id;
  await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/comments`, { text: "note" });
  await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/chat`, { text: "hi" });
  await until(async () => {
    const r = (await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}`)).data;
    return r.runEndedAt && !r.running;
  }, 20_000, "the chat run to end");
  scheduleId = (await d.api("POST", `/api/profiles/${SLUG}/schedules`, { name: "S", title: "T", cron: "0 9 * * 1" })).data.id;
  await d.api("PATCH", `/api/profiles/${SLUG}/schedules/${scheduleId}`, { enabled: false });
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

/** The path patterns in data-files.md's ```paths block: `<slug>`-style parts match one path segment, `**` any. */
function documentedPaths(): RegExp[] {
  const md = readFileSync(join(CONTRACTS, "data-files.md"), "utf8");
  const block = md.match(/```paths\n([\s\S]*?)\n```/);
  if (!block) throw new Error("contracts/data-files.md has no ```paths block");
  return block[1].split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((p) => {
    const re = p.split("/").map((seg) => seg === "**" ? "(?:.+)" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>/g, "[^/]+").replace(/\*/g, "[^/]*")).join("/");
    return new RegExp(`^${re}$`);
  });
}

function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as any[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)));
}

test("every file in the data folder is one data-files.md lists", () => {
  const patterns = documentedPaths();
  const files = filesUnder(d.home);
  expect(files).toContain(`profiles/${SLUG}/profile.json`);
  expect(files).toContain(`profiles/${SLUG}/tickets/${ticketId}/ticket.md`);
  const unlisted = files.filter((f) => !patterns.some((re) => re.test(f)));
  expect(unlisted).toEqual([]);
});

/** Checks `value` against a schema's top level: required fields present, and each known field's JSON type. */
function schemaProblems(schemaFile: string, value: Record<string, unknown>): string[] {
  const schema = JSON.parse(readFileSync(join(CONTRACTS, "schemas", schemaFile), "utf8"));
  const out: string[] = [];
  for (const k of schema.required ?? []) if (!(k in value)) out.push(`missing ${k}`);
  const typeOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  for (const [k, v] of Object.entries(value)) {
    const want = schema.properties?.[k]?.type;
    if (!want) continue;
    const types: string[] = Array.isArray(want) ? want : [want];
    const got = typeOf(v);
    if (!types.includes(got) && !(got === "integer" && types.includes("number"))) out.push(`${k}: ${got}, schema says ${types.join("|")}`);
  }
  return out;
}

test("profile.json, ticket.md, activity.jsonl and the schedule file match their schemas", () => {
  const profile = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "profile.json"), "utf8"));
  expect(schemaProblems("profile.schema.json", profile)).toEqual([]);
  const t = parseTicketFile(readFileSync(join(d.home, "profiles", SLUG, "tickets", ticketId, "ticket.md"), "utf8"));
  expect(schemaProblems("ticket.schema.json", { ...t.meta, body: t.body })).toEqual([]);
  const log = readJsonl(join(d.home, "profiles", SLUG, "tickets", ticketId, "activity.jsonl"));
  expect(log.length).toBeGreaterThan(0);
  for (const line of log) expect(schemaProblems("activity-entry.schema.json", line)).toEqual([]);
  const s = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "schedules", `${scheduleId}.json`), "utf8"));
  expect(schemaProblems("schedule.schema.json", s)).toEqual([]);
});
