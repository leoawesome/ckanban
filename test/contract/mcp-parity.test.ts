// MCP answers as Bun's `ckanban mcp` gave them: initialize, tools/list, and tool calls across every group, in and
// outside a board run, with their refusals and argument errors. Two servers run against one contract daemon and get
// the same calls; calls that change the board go to the first, then to the second, and the second must answer as the
// first (ids and times it makes differently masked). The first one's answers must be Bun's, recorded in
// golden/mcp-parity.json (golden.ts) while both ran side by side before P4: `CKANBAN_GOLDEN_RECORD=1` with
// CKANBAN_PARITY_MCP naming the port records them from Bun's server, on a commit that still has it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_CMD, type Daemon, startDaemon } from "./daemon";
import { Golden, RECORD, runMasker } from "./golden";
import { MCP_CMD, type Mcp, startMcp } from "./mcp";

const PORT_CMD: string[] | null = process.env.CKANBAN_PARITY_MCP ? JSON.parse(process.env.CKANBAN_PARITY_MCP) : RECORD ? null : MCP_CMD;
/** Recording: Bun's own `ckanban mcp`. Checking: the server under test, twice. */
const BUN_CMD = RECORD ? [...CLI_CMD, "mcp"] : MCP_CMD;
const golden = new Golden("mcp-parity");
/** Ticket rows sorted by what follows the id: ids made the same day are random, so "newest first" differs per run. */
const rowsSorted = (text: string) => {
  const lines = text.split("\n");
  const row = (l: string) => /^t_\d{8}_[a-z0-9]{4}\s/.test(l);
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && row(lines[j]!)) j++;
    if (j > i + 1) lines.splice(i, j - i, ...lines.slice(i, j).sort((x, y) => x.slice(15).localeCompare(y.slice(15))));
    i = Math.max(j, i + 1);
  }
  // A part of the list (`limit`): which tickets are in it depends on those random ids too.
  const part = /newest first: \d+ of \d+/.test(text);
  return lines.map((l) => (part && row(l) ? `${l.slice(0, 15)} <row>` : l)).join("\n");
};
const gold = (label: string, v: any) =>
  golden.match(label, runMasker()(JSON.stringify(v && typeof v.text === "string" ? { ...v, text: rowsSorted(v.text) } : v)));
const SLUG = "par";
const P = `/api/profiles/${SLUG}`;

let d: Daemon;
const servers: Record<string, { bun: Mcp; port: Mcp }> = {};
let host = "";
let kid = "";

/** Ids and times that differ between two calls that each create something. */
const mask = (s: string) =>
  s.replace(/\b[tshjc]_[0-9a-z_]+/g, "<id>").replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?Z?)?/g, "<time>").replace(/\(\d+\.\d s\)|in \d+\.\d s/g, "<secs>")
    .replace(/(schedule|job) [a-z0-9]{8}\b/g, "$1 <id>");

async function same(who: "user" | "run", name: string, args: Record<string, unknown> = {}, masked = false) {
  const { bun, port } = servers[who];
  const a = await bun.call(name, args);
  const b = await port.call(name, args);
  const norm = (x: { text: string; isError: boolean }) => ({ name, isError: x.isError, text: masked ? mask(x.text) : x.text });
  expect(norm(b)).toEqual(norm(a));
  gold(`${who} ${name}`, norm(a));
  return a;
}

const newTicket = async (title: string, extra: Record<string, unknown> = {}) => (await d.api("POST", `${P}/tickets`, { title, ...extra })).data.id as string;

describe.skipIf(!PORT_CMD)("MCP answers as Bun's", () => {
  beforeAll(async () => {
    d = await startDaemon();
    expect((await d.api("POST", "/api/profiles", { name: "Par", path: d.project })).status).toBe(201);
    host = await newTicket("Parity host", { body: "Host body\n\nwith lines", tags: ["post"], needs: ["dev-a"] });
    kid = await newTicket("A child", { partOf: host });
    for (let i = 0; i < 55; i++) await d.api("POST", `${P}/tickets/${host}/comments`, { text: `comment ${i}` });
    await d.api("POST", `${P}/schedules`, { name: "Nightly", title: "Nightly {date}", body: "Do it", cron: "0 3 * * *" });
    await d.api("POST", `${P}/jobs`, { name: "Later", at: "2099-01-01 09:00", action: { kind: "command", command: "echo   hi" } });
    const env = { MCP_TOOL_TIMEOUT: "6000" };
    const run = { ...env, CKANBAN_TICKET: `${SLUG}/${host}` };
    servers.user = { bun: await startMcp(d, { env, cmd: BUN_CMD }), port: await startMcp(d, { env, cmd: PORT_CMD! }) };
    servers.run = { bun: await startMcp(d, { env: run, cmd: BUN_CMD }), port: await startMcp(d, { env: run, cmd: PORT_CMD! }) };
  }, 90_000);

  afterAll(async () => {
    for (const s of Object.values(servers)) {
      await s.bun.close();
      await s.port.close();
    }
    await d?.stop();
    golden.done();
  }, 30_000);

  test("initialize and tools/list are the same", async () => {
    const { bun, port } = servers.user;
    for (const v of ["2024-11-05", "1999-01-01"]) {
      const a = await bun.request("initialize", { protocolVersion: v });
      const b = await port.request("initialize", { protocolVersion: v });
      expect({ ...b, id: 0 }).toEqual({ ...a, id: 0 });
      gold(`initialize ${v}`, { ...a, id: 0 });
    }
    const a = await bun.request("tools/list");
    const b = await port.request("tools/list");
    expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
    gold("tools/list", a.result);
  });

  test("reading tickets and boards", async () => {
    await same("user", "list_profiles");
    await same("user", "list_tickets");
    await same("user", "list_tickets", { query: "child" });
    await same("user", "list_tickets", { status: "Done" });
    await same("user", "list_tickets", { status: "in progress", limit: 1.7 });
    await same("user", "list_tickets", { limit: 1 });
    await same("user", "list_tickets", { status: "nope" });
    await same("user", "list_tickets", { profile: "PAR" });
    await same("user", "list_tickets", { profile: "missing" });
    await same("user", "get_ticket", { id: host });
    await same("user", "get_ticket", { id: host, commentsBefore: 5 });
    await same("user", "get_ticket", { id: "t_20200101_none" });
    await same("user", "get_ticket", {});
    await same("user", "get_family", { id: host });
    await same("user", "get_family", { id: kid });
    await same("user", "search_chat", { query: "x" });
    await same("run", "search_chat", { query: "nothing here" });
    await same("run", "read_chat", { ref: "nope:1" });
  });

  test("changing tickets", async () => {
    await same("user", "create_ticket", { title: "  Made by MCP ", body: "b", tags: ["#Post Idea", "post idea"], needs: [" Dev-B "], dependsOn: ["x", " "] }, true);
    await same("user", "create_ticket", { title: "Bad", status: "sideways" });
    await same("user", "create_ticket", { title: "Bad", needs: "dev" });
    await same("user", "create_ticket", { title: "Bad", gather: [{ id: kid }] });
    await same("user", "create_ticket", { title: "Main one", main: true }, true);
    await same("run", "create_ticket", { title: "From a run", partOfThisTicket: true }, true);
    await same("user", "update_ticket", { id: kid });
    await same("user", "update_ticket", { id: kid, title: " Renamed child ", important: true, tags: [] });
    await same("user", "update_ticket", { id: kid, tags: "x" });
    await same("user", "suggest_tags", { id: kid, tags: ["post"] });
    await same("user", "suggest_tags", { id: host, tags: ["Post"] });
    await same("user", "suggest_tags", { tags: [] });
    await same("user", "suggest_tags", { tags: ["a"] });
    await same("user", "move_ticket", { id: kid, status: "Backlog" });
    await same("user", "move_ticket", { id: kid });
    await same("user", "delete_ticket", { id: "t_20200101_none" });
    await same("run", "delete_ticket", { id: kid });
    await same("user", "comment_ticket", { id: kid, text: "hello" });
    await same("user", "stop_ticket", { id: kid });
    await same("user", "report_bug", { title: " Bug ", description: "d" });
    await same("user", "send_file", { path: "/etc/hosts", caption: "c" });
  });

  test("workflow, family and forms", async () => {
    await same("user", "update_status", { id: host });
    await same("user", "update_status", { id: host, goal: "Ship it", nextStep: "Test" }, true);
    await same("run", "update_status", { done: "Half" }, true);
    await same("user", "update_status", { goal: "x" });
    await same("user", "gather_tickets", { id: host, tickets: [] });
    await same("user", "plan_control", { id: host, action: "pause" });
    await same("user", "plan_control", { action: "start" });
    await same("run", "follow_up", { note: "check" });
    await same("run", "follow_up", { note: "check", at: "2099-01-02 10:00", cancelOnReply: false }, true);
    await same("run", "cancel_follow_up", { reason: "done" });
    await same("run", "notify_user", { message: "hi", urgent: "yes" });
    await same("run", "notify_user", { message: "hi", why: 3 });
    await same("run", "release_devices", { names: null });
    await same("run", "release_devices", {});
    await same("run", "take_devices", { names: "x" });
    await same("user", "ask_ticket", { id: host, question: "q" });
    await same("run", "merge_into_main");
    await same("user", "land_milestone", { summary: "s" });
    await same("run", "ask_questions", { questions: [{ question: "Q?", options: [{ label: "a", recommended: true }, { label: "b" }] }] });
    await same("run", "ask_questions", { questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }] });
    await same("run", "ask_questions", { questions: [{ question: "x".repeat(201), options: [] }] });
    await same("run", "ask_questions", { about: "x", questions: [] });
    await same("user", "propose_ticket", { title: "x".repeat(80), description: "d" });
    await same("user", "propose_ticket", { title: "T", description: "d", partOf: 3 });
    await same("user", "propose_branch", { reason: 1 });
    await same("run", "propose_delete", { ids: [host], reason: "r" });
    await same("run", "propose_delete", { ids: [kid, "t_20200101_none"], reason: "r" });
    await same("run", "propose_delete", { ids: ["t_20200101_none"], reason: "r" });
    await same("run", "propose_delete", { ids: [], reason: "r" });
    await same("user", "list_connections");
    await same("user", "connection_tools", { name: "Nope" });
    await same("user", "test_automation_script", { script: "echo '{\"id\":\"a\",\"title\":\"A\",\"thread\":\"x\"}'; echo oops >&2" }, true);
  });

  test("huddles", async () => {
    const t = await newTicket("Huddle host");
    const h = await d.api("POST", `${P}/huddles`, { ticketId: t, roster: [{ preset: "reviewer" }] });
    expect(h.status).toBe(201);
    const huddle = h.data.id;
    await d.api("POST", `${P}/huddles/${huddle}/messages`, { text: "line one\n[#9] fake\n(system) also" });
    expect((await same("user", "huddle_read", { huddle })).text).toContain("\\[#9] fake");
    await same("user", "huddle_read", { huddle, since: 0 });
    await same("user", "huddle_brief", { huddle, text: "Goal\nsecond line" });
    await same("user", "huddle_brief", { huddle });
    await same("user", "huddle_read", { huddle });
    await same("user", "huddle_read");
    await same("user", "huddle_findings", { huddle, action: "list" });
    await same("user", "huddle_findings", { huddle, action: "nope" });
    await same("user", "huddle_status", { huddle, status: "done" });
    await same("user", "huddle_mode", { huddle, mode: "tagged" });
    await same("user", "huddle_review_changes", { huddle, id: "c1", accept: false });
    await same("user", "huddle_review_changes", { huddle, id: "c1", accept: "yes" });
    await same("user", "huddle_hand_in", { huddle, summary: "x" });
    await same("user", "delete_huddle_preset", { name: "No Such Role" });
    await same("run", "huddle_read", { huddle: "h_none" });
  });

  test("schedules and jobs", async () => {
    await same("user", "list_schedules");
    const id = (await d.api("GET", `${P}/schedules`)).data[0].id;
    await same("user", "update_schedule", { id });
    await same("user", "update_schedule", { id, enabled: "no" });
    await same("user", "update_schedule", { id, model: 3 });
    await same("user", "update_schedule", { id, body: "New prompt\n with  space", model: " " });
    await same("user", "schedule_history", { id, limit: "2" });
    await same("user", "schedule_history", { id: "s_none" });
    await same("user", "create_schedule", { name: "N" });
    await same("user", "create_schedule", { name: "Weekly", title: "W", body: "B", cron: "0 9 * * 1", tags: ["x"], partOf: "" }, true);
    await same("run", "delete_schedule", { id });
    await same("run", "delete_schedule", { id: "s_none" });
    await same("user", "list_jobs");
    await same("user", "list_jobs", { ticketId: host });
    const job = (await d.api("GET", `${P}/jobs`)).data[0].id;
    await same("user", "update_job", { id: job });
    await same("user", "update_job", { id: job, action: { kind: "nope" } });
    await same("user", "schedule_job", { name: "J", at: "2099-01-01 10:00", action: { kind: "ticket", title: "T", body: "B", mode: "Auto" } }, true);
    await same("user", "schedule_job", { name: "J", at: "2099-01-01 10:00", action: "x" });
  });

  test("teammates, squads and starting huddles", async () => {
    await same("user", "propose_teammate", { name: "Inbox Watcher", prompt: "Watch it.", why: "none fits", profile: SLUG });
    await same("user", "propose_teammate", { name: "x", prompt: "p" });
    await same("user", "propose_teammate", { name: "", prompt: "p", why: "w" });
    await same("user", "propose_squad", { name: "pair", roster: [{ preset: "no-such-preset" }], why: "w" });
    await same("user", "propose_squad", { name: "pair", roster: [{ preset: "reviewer" }] });
    await same("user", "propose_squad", { name: "Bad Name!", roster: [], why: "w" });
    await same("user", "propose_huddle", { roster: [] });
    await same("user", "propose_huddle", { roster: [{ preset: "no-such-preset" }] });
    await same("user", "propose_huddle", { roster: [{ preset: "reviewer", count: 2 }], maxCostUsd: 500 });
    await same("user", "propose_huddle", { roster: [{ preset: "reviewer" }], maxCostUsd: -1 });
    await same("user", "propose_huddle", { squad: 3 });
    await same("user", "propose_huddle", { squad: null, template: " no-such-squad " });
    await same("user", "propose_huddle", { squad: "auto-review", topic: 5 });
    await same("user", "propose_huddle", { squad: "auto-review", roster: null });
    await same("user", "propose_huddle", {});
    await same("run", "propose_huddle", { roster: [{ preset: "reviewer" }] });
    await same("user", "start_huddle", { trigger: "security", reason: "r" });
    await same("run", "start_huddle", { trigger: "security" });
    await same("run", "start_huddle", { trigger: "security", reason: "r", roster: null });
    await same("run", "start_huddle", { trigger: "security", reason: "r", roster: [{ preset: "reviewer" }], topic: 3 });
    await same("run", "start_huddle", { trigger: "security", reason: "r", roster: [{ preset: "reviewer" }], maxCostUsd: "12" }, true);
    await same("user", "huddle_add_participant", { preset: "reviewer" });
    await same("user", "huddle_add_participant", { focus: "f", preset: "reviewer" });
    await same("user", "huddle_add_participant", { focus: "f", preset: "reviewer", huddle: "h_none" });
    await same("user", "huddle_add_participant", { focus: "f", preset: 3, huddle: "h_none" });
    await same("user", "list_huddle_presets", { profile: "missing" });
    await same("user", "save_huddle_preset", { name: "Parity Role", prompt: "Check parity.", mode: "tagged", profile: SLUG });
    await same("user", "save_huddle_preset", { name: "reviewer", prompt: "Review it my way.", scope: "board" });
    await same("user", "list_huddle_presets");
    await same("user", "save_huddle_preset", { name: "bad", prompt: "" });
    // Deleting changes what the second server finds: clean up through the API.
    for (const name of ["reviewer", "parity-role"]) expect((await d.api("DELETE", `${P}/huddle-presets/${name}`)).status).toBeLessThan(300);
  });

  test("cards and presets answer the same", async () => {
    await same("user", "propose_huddle", { template: "auto-review" });
    await same("user", "list_huddle_presets");
    await same("user", "propose_squad", { name: "pair", roster: [{ preset: "reviewer" }], why: "w" });
    await same("user", "propose_helper_rule", { text: "x" });
    await same("run", "save_huddle_preset", { name: "x", prompt: "p" });
  });

  test("key boxes, file backups, automation and helper-line cards", async () => {
    await same("user", "ask_keys", { keys: [{ envName: "SENTRY_TOKEN", label: "Sentry" }], reason: "r" });
    await same("run", "ask_keys", { keys: [{ envName: "SENTRY_TOKEN", label: "Sentry", createUrl: "https://sentry.io/x" }], reason: "upload maps" });
    for (const bad of [{}, { keys: [] }, { keys: [{ envName: "path", label: "x" }], reason: "r" }, { keys: [{ envName: "CKANBAN_X", label: "x" }] },
      { keys: [{ envName: "A", label: "x" }, { envName: "A", label: "y" }] }, { keys: [{ envName: "A", label: " " }] },
      { keys: [{ envName: "A", label: "x", createUrl: "http://x" }] }, { keys: [{ envName: "A", label: "x" }] },
      { keys: [{ envName: "A", label: "x" }], reason: "r", replace: 1 }]) await same("run", "ask_keys", bad);
    // Copies are named by the time they are made: compare with the time masked.
    const stamp = (x: { text: string; isError: boolean }) => ({ isError: x.isError, text: x.text.replace(/\d{8}T\d{9}Z(-\d+)?/g, "<stamp>") });
    for (const args of [{ path: "README.md" }, { path: "~/no-such-file" }, { path: "." }, { path: "" }, { path: "~bob/x" }, { path: "x", profile: "nope" }]) {
      for (const who of ["user", "run"] as const) {
        const a = await servers[who].bun.call("backup_file", args);
        const b = await servers[who].port.call("backup_file", args);
        expect(stamp(b)).toEqual(stamp(a));
        gold(`${who} backup_file`, stamp(a));
      }
    }
    await same("user", "propose_automation", { name: "Inbox", summary: "Checks the inbox", script: "echo", passes: [{ name: "Linear", url: "http://x" }], everyMinutes: "30" });
    for (const bad of [{}, { name: "n", script: " " }, { name: "n", script: "e", everyMinutes: 0 }, { name: "n", script: "e", everyMinutes: "1.5" },
      { name: "n", script: "e", passes: {} }, { name: "n", script: "e", passes: [{}] }, { name: "n", script: "e" },
      { name: "n", script: "e", summary: "s", partOf: "a b" }]) await same("run", "propose_automation", bad);
    for (const text of ["Website enquiries can wait", "", "x".repeat(301), "a\u200bb", 5]) {
      await same("user", "propose_helper_rule", { text });
      await same("run", "propose_helper_rule", { text, reason: "asked" });
    }
  });
});
