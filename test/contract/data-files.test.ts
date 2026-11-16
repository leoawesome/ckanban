// Outside-in contract: after a mix of actions, every file the daemon wrote in its data folder is one that
// contracts/data-files.md lists (its "paths" block), and every saved file with a JSON Schema in contracts/schemas/
// matches it and is written in the style data-files.md gives (pretty or compact, final newline or not).
//
// User-only actions (automations, quick chats, settings) are sent through the phone access listener: remote.json is
// seeded as switched on, and requests carry the Tailscale host, login and origin it allows. Plan usage is asked of a
// local fake of Anthropic's endpoint. FAKE_SIDE_JSON lets the fake Claude answer side calls ("help me understand",
// simplify) and FAKE_TRANSCRIPT gives the chat an answer to explain.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { documentedPaths, filesUnder, parseTicketFile, pathRegex, readJsonl } from "./files";
import { schemaProblems } from "./schema";

const SLUG = "files";
const HOST = "box.tail0000.ts.net";
const LOGIN = "tester@example.com";
const SCRIPT = "echo '[]'\n";
// A 1x1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const LONG_REPLY = "\nThis reply is long enough for the board to offer a plain words version of it to a reader who is not technical at all.".repeat(2);

const usageFake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({
    five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3 * 3600_000).toISOString() },
    seven_day: { utilization: 17.5, resets_at: null },
  }),
});

let d: Daemon;
let ticketId = "";
let scheduleId = "";
let attachmentName = "";
const p = (path: string) => `/api/profiles/${SLUG}${path}`;

/** A request as the user's phone sends it through `tailscale serve` (passes the user-only check). */
async function asUser(method: string, path: string, body: unknown = {}): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`http://127.0.0.1:${d.env.CKANBAN_REMOTE_PORT}${path}`, {
    method,
    headers: { host: HOST, "tailscale-user-login": LOGIN, origin: `https://${HOST}`, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
}

/** Fails with the answer's text when the status is not the expected one. */
function ok(r: { status: number; text: string }, status: number, what: string) {
  if (r.status !== status) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`);
}

beforeAll(async () => {
  d = await startDaemon({
    env: {
      FAKE_SIDE_JSON: "1",
      FAKE_TRANSCRIPT: "1",
      FAKE_EXTRA: LONG_REPLY,
      CKANBAN_USAGE_URL: `http://127.0.0.1:${usageFake.port}/api/oauth/usage`,
    },
    before: ({ home, claudeDir }) => {
      // config.json is never written by the daemon: the user makes it.
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777, prPollMinutes: 5 }, null, 2) + "\n");
      writeFileSync(join(home, "remote.json"), JSON.stringify({ enabled: true, host: HOST, allowedLogin: LOGIN, updatedAt: new Date().toISOString() }, null, 2) + "\n");
      writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3600_000 } }));
    },
  });
  const home = d.home;
  ok(await d.api("POST", "/api/profiles", { name: "Files", path: d.project }), 201, "board");

  // A ticket with a comment, a chat run, help and simplify side calls, a feature status and a huddle.
  const t = (await d.api("POST", p("/tickets"), { title: "Has a chat", body: "b", tags: ["ui"] })).data;
  ticketId = t.id;
  ok(await d.api("POST", p(`/tickets/${t.id}/comments`), { text: "note" }), 201, "comment");
  await d.api("POST", p(`/tickets/${t.id}/chat`), { text: "hi" });
  await until(async () => {
    const r = (await d.api("GET", p(`/tickets/${t.id}`))).data;
    return r.runEndedAt && !r.running;
  }, 20_000, "the chat run to end");
  ok(await d.api("POST", p(`/tickets/${t.id}/help`), { kind: "recap" }), 200, "help");
  const conv = (await d.api("GET", p(`/tickets/${t.id}/conversation`))).data;
  const reply = conv.entries.filter((e: any) => e.role === "assistant" && e.kind === "text").at(-1);
  ok(await d.api("POST", p(`/tickets/${t.id}/simplify`), { uuid: reply.uuid }), 200, "simplify");
  ok(await d.api("POST", p(`/tickets/${t.id}/status`), { goal: "Ship it", done: "Checked the files", next: null }), 200, "status");
  ok(await d.api("POST", p("/huddles"), { ticketId: t.id, roster: [{ role: "reviewer", prompt: "look" }], maxCostUsd: 1 }), 201, "huddle");

  // Schedules (one run now, then paused), jobs (a ticket job and a command job that ran), an automation.
  scheduleId = (await d.api("POST", p("/schedules"), { name: "S", title: "T", cron: "0 9 * * 1" })).data.id;
  ok(await d.api("POST", p(`/schedules/${scheduleId}/run`), {}), 200, "schedule run");
  ok(await d.api("PATCH", p(`/schedules/${scheduleId}`), { enabled: false }), 200, "schedule pause");
  const later = new Date(Date.now() + 86_400_000).toISOString();
  ok(await d.api("POST", p("/jobs"), { name: "Later", at: later, action: { kind: "ticket", title: "Later", body: "x", mode: "auto" } }), 201, "ticket job");
  const cmd = (await d.api("POST", p("/jobs"), { name: "Echo", at: later, action: { kind: "command", command: "echo hi", timeoutSec: 30 } })).data;
  ok(await d.api("POST", p(`/jobs/${cmd.id}/run`), {}), 200, "job run");
  const loop = await asUser("POST", p("/loops"), { name: "L", script: SCRIPT, everyMinutes: 60, passes: [] });
  ok(loop, 201, "automation");

  // A quick chat with a simplified answer.
  const chat = await asUser("POST", p("/chats"), { text: "quick q" });
  ok(chat, 201, "quick chat");
  await until(() => existsSync(join(home, "profiles", SLUG, "chats", `${chat.data.id}.activity.jsonl`)), 20_000, "the quick chat run");
  await until(async () => !(await d.api("GET", p(`/chats/${chat.data.id}`))).data?.running, 20_000, "the quick chat to stop");
  const cconv = (await d.api("GET", p(`/chats/${chat.data.id}/conversation`))).data;
  const creply = cconv.entries.filter((e: any) => e.role === "assistant" && e.kind === "text").at(-1);
  ok(await asUser("POST", p(`/chats/${chat.data.id}/simplify`), { uuid: creply.uuid }), 200, "quick chat simplify");

  // Board knowledge, connections and settings.
  ok(await d.api("POST", "/api/snippets", { name: "greet", text: "hello", scope: "global" }), 201, "snippet");
  ok(await d.api("PUT", "/api/avatars/qa", { face: "round", color: "#336699" }), 200, "avatar");
  for (const scope of ["board", "global"]) {
    ok(await d.api("POST", p("/huddle-presets"), { name: `checker-${scope}`, role: "checker", prompt: "check it", scope }), 201, `${scope} preset`);
    ok(await d.api("POST", p("/huddle-templates"), { name: `pair-${scope}`, label: "Pair", roster: [{ role: "reviewer" }], scope }), 201, `${scope} template`);
  }
  for (const scope of ["general", "repo"]) ok(await d.api("PUT", p(`/huddle-notes/_all/${scope}`), { notes: [{ text: "Keep it short" }] }), 200, `${scope} notes`);
  const att = await fetch(`${d.url}/api/attachments`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "a.png" }, body: PNG });
  ok({ status: att.status, text: "" }, 201, "attachment");
  attachmentName = ((await att.json()) as any).url.split("/").pop();
  ok(await d.api("POST", "/api/devices", { name: "phone", description: "test phone", capacity: 1 }), 200, "device");
  ok(await d.api("POST", "/api/mcp", { name: "docs", transport: "http", url: "https://mcp.example.com/mcp", board: SLUG }), 201, "board tool");
  ok(await d.api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example.com/x", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } }, label: "Phone" }), 200, "push");
  ok(await asUser("POST", "/api/notify", { mac: false }), 200, "notify");
  ok(await asUser("POST", "/api/helper/settings", { model: "haiku" }), 200, "helper");
  ok(await asUser("POST", "/api/passes", { kind: "key", name: "Jira", secret: "sekret-123456", board: SLUG }), 201, "pass");
  ok(await d.api("GET", "/api/usage?fresh=1"), 200, "usage");

  // The huddle agent's run ends and its cost lands in spend-days.json; the automation's first check saves its state.
  await until(() => existsSync(join(home, "spend-days.json")), 20_000, "the huddle agent's spend");
  await until(() => readdirSync(join(home, "profiles", SLUG, "loops")).some((f) => f.endsWith(".state.json")), 20_000, "the automation's first check");
  await until(() => existsSync(join(home, "usage-windows.json")), 10_000, "usage-windows.json");
  // Last: phone access off (remote.json rewritten by the daemon).
  ok(await d.api("POST", "/api/remote", { enabled: false }), 200, "remote off");
}, 90_000);

afterAll(async () => {
  await d?.stop();
  usageFake.stop(true);
}, 30_000);

test("every file in the data folder is one data-files.md lists", () => {
  const patterns = documentedPaths();
  const files = filesUnder(d.home);
  expect(files).toContain(`profiles/${SLUG}/profile.json`);
  expect(files).toContain(`profiles/${SLUG}/tickets/${ticketId}/ticket.md`);
  const unlisted = files.filter((f) => !patterns.some((re) => re.test(f)));
  expect(unlisted).toEqual([]);
});

/**
 * How a JSON file is written (data-files.md, "JSON serialisation"): pretty = 2-space indent, indent1 = 1-space,
 * compact = no spaces; +nl = a final newline. jsonl: one compact object per line, each ending in a newline.
 */
type Style = "pretty+nl" | "pretty" | "indent1+nl" | "compact+nl" | "compact" | "jsonl" | "ticket";

interface Check {
  path: string;
  schema: string;
  style: Style;
  /** Set when the action mix above can't make the file; it is still checked when it is there. */
  notMade?: string;
}

/** Every saved file with a schema. The order follows data-files.md. */
const CHECKS: Check[] = [
  { path: "config.json", schema: "config.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/profile.json", schema: "profile.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/board-tools.json", schema: "board-tools.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/tickets/<id>/ticket.md", schema: "ticket.schema.json", style: "ticket" },
  { path: "profiles/<slug>/tickets/<id>/comments.jsonl", schema: "comment.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/tickets/<id>/activity.jsonl", schema: "activity-entry.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/tickets/<id>/side-spend.jsonl", schema: "side-spend-entry.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/tickets/<id>/help.json", schema: "help-cards.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/tickets/<id>/outputs/status.json", schema: "feature-status.schema.json", style: "pretty" },
  { path: "profiles/<slug>/chats/<id>.json", schema: "quick-chat.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/chats/<id>.activity.jsonl", schema: "activity-entry.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/chats/<id>.side-spend.jsonl", schema: "side-spend-entry.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/schedules/<id>.json", schema: "schedule.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/schedules/<id>.history.jsonl", schema: "schedule-history-entry.schema.json", style: "jsonl" },
  { path: "profiles/<slug>/jobs/<id>.json", schema: "job.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/loops/<id>.json", schema: "loop.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/loops/<id>.state.json", schema: "loop-state.schema.json", style: "compact+nl" },
  { path: "profiles/<slug>/huddles/<id>.json", schema: "huddle.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/huddles/<id>.messages.jsonl", schema: "huddle-message.schema.json", style: "jsonl" },
  { path: "huddle-presets.json", schema: "huddle-presets.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/huddle-presets.json", schema: "huddle-presets.schema.json", style: "pretty+nl" },
  { path: "huddle-templates.json", schema: "huddle-templates.schema.json", style: "pretty+nl" },
  { path: "profiles/<slug>/huddle-templates.json", schema: "huddle-templates.schema.json", style: "pretty+nl" },
  { path: "learned/pile.json", schema: "learned-pile.schema.json", style: "pretty+nl" },
  { path: "avatars.json", schema: "avatars.schema.json", style: "pretty+nl" },
  { path: "snippets.json", schema: "snippets.schema.json", style: "pretty+nl" },
  { path: "notify.json", schema: "notify.schema.json", style: "pretty+nl" },
  { path: "push.json", schema: "push.schema.json", style: "pretty+nl" },
  { path: "remote.json", schema: "remote.schema.json", style: "pretty+nl" },
  { path: "automation-passes.json", schema: "automation-passes.schema.json", style: "pretty+nl" },
  { path: "helper.json", schema: "helper-settings.schema.json", style: "pretty+nl" },
  { path: "devices.json", schema: "devices.schema.json", style: "pretty" },
  { path: "spend-days.json", schema: "spend-days.schema.json", style: "compact+nl" },
  { path: "telegram-spend.json", schema: "spend-by-day.schema.json", style: "compact+nl", notMade: "needs a Telegram bot" },
  { path: "telegram-desk-spend.json", schema: "spend-by-day.schema.json", style: "compact+nl", notMade: "needs a Telegram bot" },
  { path: "helper-spend.jsonl", schema: "side-spend-entry.schema.json", style: "jsonl", notMade: "the helper's first check waits a minute and needs a real Claude answer" },
  { path: "usage-windows.json", schema: "usage-windows.schema.json", style: "compact" },
  { path: "usage-last.json", schema: "usage-last.schema.json", style: "compact" },
  { path: "waits.json", schema: "waits.schema.json", style: "indent1+nl" },
];

/** What `raw` should be, given its parsed value and the file's style; null for styles checked line by line. */
function written(value: unknown, style: Style): string | null {
  switch (style) {
    case "pretty+nl": return JSON.stringify(value, null, 2) + "\n";
    case "pretty": return JSON.stringify(value, null, 2);
    case "indent1+nl": return JSON.stringify(value, null, 1) + "\n";
    case "compact+nl": return JSON.stringify(value) + "\n";
    case "compact": return JSON.stringify(value);
    default: return null;
  }
}

/** Every schema and style problem in one data file, as `file: problem` lines. */
function fileProblems(file: string, c: Check): string[] {
  const raw = readFileSync(join(d.home, file), "utf8");
  if (c.style === "ticket") {
    if (!raw.startsWith("---\n")) return [`${file}: does not start with ---`];
    const t = parseTicketFile(raw);
    return schemaProblems(c.schema, { ...t.meta, body: t.body }, file);
  }
  if (c.style === "jsonl") {
    if (raw && !raw.endsWith("\n")) return [`${file}: last line has no newline`];
    const lines = raw.split("\n").slice(0, -1);
    const out: string[] = [];
    if (!lines.length) out.push(`${file}: empty`);
    lines.forEach((l, i) => {
      const v = JSON.parse(l);
      if (JSON.stringify(v) !== l) out.push(`${file}:${i + 1}: not compact JSON`);
      out.push(...schemaProblems(c.schema, v, `${file}:${i + 1}`));
    });
    return out;
  }
  const v = JSON.parse(raw);
  const out = schemaProblems(c.schema, v, file);
  if (written(v, c.style) !== raw) out.push(`${file}: not written as ${c.style}`);
  return out;
}

test("the action mix made every saved file that has a schema", () => {
  const files = filesUnder(d.home);
  const missing = CHECKS.filter((c) => !c.notMade && !files.some((f) => pathRegex(c.path, true).test(f))).map((c) => c.path);
  expect(missing).toEqual([]);
});

test("every saved file matches its schema and is written in its documented style", () => {
  const files = filesUnder(d.home);
  const problems: string[] = [];
  let checked = 0;
  for (const c of CHECKS) {
    for (const f of files.filter((f) => pathRegex(c.path, true).test(f))) {
      problems.push(...fileProblems(f, c));
      checked++;
    }
  }
  expect(problems).toEqual([]);
  expect(checked).toBeGreaterThanOrEqual(CHECKS.filter((c) => !c.notMade).length);
});

test("files without a JSON schema: attachment, automation script, huddle notes", () => {
  // attachments/<32 hex>.<ext>: the uploaded bytes as they were.
  expect(attachmentName).toMatch(/^[0-9a-f]{32}\.png$/);
  expect(Buffer.from(readFileSync(join(d.home, "attachments", attachmentName))).equals(PNG)).toBe(true);
  // loops/<id>.sh: the script as sent.
  const scripts = readdirSync(join(d.home, "profiles", SLUG, "loops")).filter((f) => f.endsWith(".sh"));
  expect(scripts.length).toBe(1);
  expect(readFileSync(join(d.home, "profiles", SLUG, "loops", scripts[0]), "utf8")).toBe(SCRIPT);
  // huddle-notes/<role>.md, general and this repo.
  const notes = (file: string) => readFileSync(join(d.home, file), "utf8");
  expect(notes("huddle-notes/_all.md")).toMatch(/^# Huddle notes: all roles, all repos\n<!-- [^\n]* -->\n\n- Keep it short <!-- by you -->\n$/);
  expect(notes(`profiles/${SLUG}/huddle-notes/_all.md`)).toMatch(/^# Huddle notes: all roles, this repo\n<!-- [^\n]* -->\n\n- Keep it short <!-- by you -->\n$/);
});

test("the schedule's run log has the lines its run and pause made", () => {
  const kinds = readJsonl(join(d.home, "profiles", SLUG, "schedules", `${scheduleId}.history.jsonl`)).map((l) => l.action ?? l.kind);
  expect(kinds).toEqual(["created", "fired", "paused"]);
});
