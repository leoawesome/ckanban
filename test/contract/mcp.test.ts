// Outside-in contract: `ckanban mcp`, the stdio MCP server (contracts/cli.md section 6). It starts the server as its
// own program against a contract-test daemon, does the MCP handshake, checks tools/list against the "Tool arguments"
// table in cli.md, and calls tools from every group, checking each answer and its effect on the daemon over HTTP.
// "In a run" calls set CKANBAN_TICKET the way the board does for a run's MCP server, to reach the run-only tools and
// the refusals a run gets. The command is MCP_CMD in mcp.ts (CKANBAN_CONTRACT_MCP overrides it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { type Mcp, startMcp } from "./mcp";

const SLUG = "mcp";
const P = `/api/profiles/${SLUG}`;
let d: Daemon;
/** The user's own Claude: no board run. */
let user: Mcp;
/** A board run of `host`. */
let run: Mcp;
let host: string;
let outDir: string;

const newTicket = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await d.api("POST", `${P}/tickets`, { title, ...extra });
  expect(r.status).toBe(201);
  return r.data.id;
};
const ticket = async (id: string) => (await d.api("GET", `${P}/tickets/${id}`)).data;

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Mcp", path: d.project })).status).toBe(201);
  host = await newTicket("Host ticket");
  outDir = join(d.home, "..", "artifact-out");
  // MCP_TOOL_TIMEOUT keeps the artifact helper's wait short; CKANBAN_OUTPUT_DIR is where publish_artifact saves pages.
  const env = { MCP_TOOL_TIMEOUT: "6000", CKANBAN_OUTPUT_DIR: outDir };
  user = await startMcp(d, { env });
  run = await startMcp(d, { env: { ...env, CKANBAN_TICKET: `${SLUG}/${host}` } });
}, 60_000);

afterAll(async () => {
  await user?.close();
  await run?.close();
  await d?.stop();
}, 30_000);

describe("protocol", () => {
  test("initialize echoes a known protocol version, else answers the newest", async () => {
    const m = await startMcp(d, { init: false });
    try {
      const old = await m.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      expect(old.jsonrpc).toBe("2.0");
      expect(old.result).toMatchObject({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ckanban" } });
      expect(typeof old.result.serverInfo.version).toBe("string");
      expect(old.result.instructions).toContain("ckanban board");
      const odd = await m.request("initialize", { protocolVersion: "1999-01-01" });
      expect(odd.result.protocolVersion).toBe("2025-06-18");
    } finally {
      await m.close();
    }
  });

  test("ping, unknown methods, notifications, bad JSON and batches", async () => {
    expect((await user.request("ping")).result).toEqual({});
    const unknown = await user.request("nope/method");
    expect(unknown.error).toEqual({ code: -32601, message: "method not found: nope/method" });
    // A notification gets no reply: the next line out is the ping's.
    user.send(JSON.stringify({ jsonrpc: "2.0", method: "nope/notification" }));
    user.send(JSON.stringify({ jsonrpc: "2.0", id: "after-note", method: "ping" }));
    expect((await user.reply("after-note")).result).toEqual({});
    user.send("{not json");
    expect(await user.reply(null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    user.send(JSON.stringify([{ jsonrpc: "2.0", id: "b1", method: "ping" }, { jsonrpc: "2.0", id: "b2", method: "ping" }]));
    expect((await user.reply("b1")).result).toEqual({});
    expect((await user.reply("b2")).result).toEqual({});
  });

  test("an unknown tool is an error result, not a JSON-RPC error", async () => {
    const r = await user.call("no_such_tool");
    expect(r).toMatchObject({ isError: true, text: "unknown tool no_such_tool" });
    expect(r.raw.content).toEqual([{ type: "text", text: "unknown tool no_such_tool" }]);
  });
});

/** The "Tool arguments" table in contracts/cli.md: [tool, arguments cell, read-only]. */
function docTools(): { name: string; args: string; readOnly: boolean }[] {
  const doc = readFileSync(resolve(import.meta.dir, "..", "..", "contracts", "cli.md"), "utf8");
  const start = doc.indexOf("### Tool arguments");
  expect(start).toBeGreaterThan(0);
  const section = doc.slice(start, doc.indexOf("\n## ", start));
  return [...section.matchAll(/^\| `([a-z_]+)` \| (.*) \| (yes)? \|$/gm)].map((m) => ({ name: m[1], args: m[2], readOnly: m[3] === "yes" }));
}

/** One schema property in the table's words: `name`* type (enum). */
function argText(name: string, v: any, required: boolean): string {
  const type = Array.isArray(v.type) ? v.type.join("\\|") : v.type === "array" ? `${v.items?.type ?? "any"}[]` : v.type;
  return `\`${name}\`${required ? "*" : ""} ${type}${v.enum ? ` (${v.enum.join("\\|")})` : ""}`;
}

describe("tools/list", () => {
  test("names, argument schemas and read-only hints match contracts/cli.md", async () => {
    const r = await user.request("tools/list");
    const tools: any[] = r.result.tools;
    const doc = docTools();
    expect(tools.map((t) => t.name)).toEqual(doc.map((t) => t.name));
    const count = readFileSync(resolve(import.meta.dir, "..", "..", "contracts", "cli.md"), "utf8").match(/(\d+) tools in total/)?.[1];
    expect(Number(count)).toBe(tools.length);
    for (const t of tools) {
      const row = doc.find((x) => x.name === t.name)!;
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
      const req: string[] = t.inputSchema.required ?? [];
      if (t.inputSchema.required !== undefined) expect(req.length).toBeGreaterThan(0);
      for (const k of req) expect(Object.keys(t.inputSchema.properties)).toContain(k);
      const args = Object.entries(t.inputSchema.properties).map(([k, v]) => argText(k, v, req.includes(k))).join(", ") || "none";
      expect({ tool: t.name, args }).toEqual({ tool: t.name, args: row.args });
      if (row.readOnly) expect({ tool: t.name, annotations: t.annotations }).toEqual({ tool: t.name, annotations: { readOnlyHint: true } });
      else expect({ tool: t.name, annotations: t.annotations }).toEqual({ tool: t.name, annotations: undefined });
    }
  });
});

describe("tickets group", () => {
  test("list_profiles, list_tickets, get_ticket, get_family", async () => {
    const profiles = await user.call("list_profiles");
    expect(profiles.isError).toBe(false);
    expect(profiles.text).toContain(`${SLUG}  (Mcp, ${d.project})`);

    const id = await newTicket("Listed one", { body: "Some words" });
    const list = await user.call("list_tickets", { query: "Listed" });
    expect(list.isError).toBe(false);
    expect(list.text).toContain(`${id}  [backlog]  Listed one`);
    const all = await user.call("list_tickets");
    expect(all.text).toContain(`${host}  [backlog]  Host ticket`);

    const shown = await user.call("get_ticket", { id });
    expect(shown.text).toStartWith(`Listed one\nid: ${id}\nstatus: backlog\nmode: interview`);
    expect(shown.text).toContain("Some words");
    expect((await user.call("get_ticket", { id: "t_20200101_none" })).isError).toBe(true);
    // The board is found from the working folder; elsewhere `profile` names it.
    const elsewhere = await startMcp(d, { cwd: d.home });
    try {
      expect((await elsewhere.call("get_ticket", { id, profile: SLUG })).text).toStartWith("Listed one");
    } finally {
      await elsewhere.close();
    }

    expect((await user.call("get_family", { id })).text).toBe(`${id} has no linked tickets yet: it is not part of a family.`);
  });

  test("create_ticket, update_ticket and suggest_tags change the ticket", async () => {
    const created = await user.call("create_ticket", { title: "Made by MCP", body: "## Goal\nTest it.", tags: ["Post"], mode: "auto" });
    expect(created.isError).toBe(false);
    const id = created.text.match(/(t_\d{8}_\w+)/)![1];
    expect(created.text).toBe(`Created main ticket ${id} on board ${SLUG} in backlog (auto mode): Made by MCP`);
    expect(await ticket(id)).toMatchObject({ id, title: "Made by MCP", body: "## Goal\nTest it.", status: "backlog", mode: "auto", tags: ["post"] });

    const updated = await user.call("update_ticket", { id, title: "Renamed by MCP", tags: [] });
    expect(updated.text).toBe(`Updated ${id}: ${id}  [backlog]  Renamed by MCP`);
    expect(await ticket(id)).toMatchObject({ title: "Renamed by MCP", tags: [] });

    const suggested = await user.call("suggest_tags", { id, tags: ["later"] });
    expect(suggested.text).toBe(`Suggested #later on ${id}: the user keeps or drops them on the board.`);
    expect((await ticket(id)).suggestedTags).toEqual(["later"]);

    expect((await user.call("create_ticket", { title: "" })).text).toBe("title is required");
  });

  test("search_chat and read_chat find a chat message", async () => {
    const id = await newTicket("Chatty");
    expect((await d.api("POST", `${P}/tickets/${id}/chat`, { text: "the staging password lives in the vault" })).status).toBeLessThan(300);
    const found = await until(async () => {
      const r = await user.call("search_chat", { query: "staging vault", ticket: id });
      return r.text.startsWith("1 message") ? r : null;
    }, 15_000, "the chat message to be searchable");
    expect(found.text).toContain("the staging password lives in the vault");
    const ref = found.text.match(/\[([^\]]+:\d+)\]/)![1];
    const read = await user.call("read_chat", { ref });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("the staging password lives in the vault");

    const noTicket = await user.call("search_chat", { query: "x" });
    expect(noTicket).toMatchObject({ isError: true, text: "outside a board run, say which ticket's chat to search (ticket)" });
    // In a run it searches the run's own ticket.
    expect((await run.call("search_chat", { query: "nothing-like-this" })).text).toStartWith(`No messages in ${host}'s chat have all of: nothing-like-this.`);
  });
});

describe("workflow group", () => {
  test("move_ticket, update_status, gather_tickets and plan_control", async () => {
    const id = await newTicket("To move");
    expect((await user.call("move_ticket", { id, status: "done" })).text).toBe(`Moved ${id} to done.`);
    expect((await ticket(id)).status).toBe("done");

    const top = await newTicket("A feature");
    const status = await user.call("update_status", { id: top, goal: "Ship the thing." });
    expect(status.text).toStartWith(`Updated the status of "A feature" (${top}). The whole status now:`);
    expect(status.text).toContain("## Goal\n\nShip the thing.");
    const saved = await d.api("GET", `${P}/tickets/${top}/status`);
    expect(saved.status).toBe(200);
    expect(saved.data.topId).toBe(top);
    expect(JSON.stringify(saved.data.sections)).toContain("Ship the thing.");
    expect((await user.call("update_status", { id: top })).text).toBe("nothing to update: pass goal, done, broken, waitingOnYou, nextStep, prNotes or prs");

    const part = await newTicket("A part");
    const gathered = await user.call("gather_tickets", { id: top, tickets: [{ id: part }] });
    expect(gathered.text).toBe(`Gathered 1:\n- ${part}  [backlog]  A part`);
    expect((await ticket(part)).partOf).toBe(top);

    const plan = await user.call("plan_control", { id: top, action: "start" });
    expect(plan).toMatchObject({ isError: true, text: "can't start the plan: this ticket has no tool tickets to run" });
    expect((await user.call("plan_control", { id: top, action: "pause" })).text).toBe("action must be start or resume");
  });

  test("follow_up, cancel_follow_up, notify_user and devices work on the run's own ticket", async () => {
    const set = await run.call("follow_up", { note: "Check for a reply", after: "2h", cancelOnReply: false });
    expect(set.text).toStartWith("Follow-up set: the board wakes this conversation at ");
    const t = await ticket(host);
    expect(t.followUp).toMatchObject({ note: "Check for a reply", cancelOnReply: false });
    expect(Date.parse(t.followUp.dueAt) - Date.now()).toBeGreaterThan(110 * 60_000);

    expect((await run.call("cancel_follow_up", { reason: "Got the reply" })).text).toBe("Stopped following up. The card says so with your reason.");
    expect((await ticket(host)).followUp ?? null).toBeNull();

    const note = await run.call("notify_user", { message: "Pick A or B so I can go on." });
    // Default notification settings: a run's message goes to the helper.
    expect(note.text).toBe("Passed to the helper: it tells the user (at once when it is urgent, else in its next summary). It is logged on the ticket.");

    const took = await run.call("take_devices", { names: ["contract-dev"] });
    expect(took.text).toStartWith("You have contract-dev now.");
    const dev = (await d.api("GET", "/api/devices")).data.find((x: any) => x.name === "contract-dev");
    expect(JSON.stringify(dev.using)).toContain(host);
    expect((await run.call("release_devices", {})).text).toBe("Let go of contract-dev.");
    const after = (await d.api("GET", "/api/devices")).data.find((x: any) => x.name === "contract-dev");
    expect(after?.using ?? []).toEqual([]);
  });

  test("own-ticket tools are refused outside a board run", async () => {
    expect((await user.call("follow_up", { note: "x", after: "1h" })).text).toBe("follow_up works inside a board run or ticket chat, on its own ticket");
    expect((await user.call("cancel_follow_up", { reason: "x" })).text).toBe("cancel_follow_up works inside a board run or ticket chat, on its own ticket");
    expect((await user.call("notify_user", { message: "x" })).text).toBe("notify_user works inside a board run or ticket chat, on its own ticket");
    const take = await user.call("take_devices", { names: ["contract-dev"] });
    expect(take).toMatchObject({ isError: true, text: "take_devices works inside a board run or ticket chat, for its own ticket (not from a huddle)" });
  });
});

describe("family group", () => {
  test("comment_ticket, chat_ticket, stop_ticket and delete_ticket", async () => {
    const id = await newTicket("Family member");
    expect((await user.call("comment_ticket", { id, text: "A note from MCP" })).text).toBe(`Commented on ${id}.`);
    const comments = await d.api("GET", `${P}/tickets/${id}/comments`);
    expect(comments.data.map((c: any) => c.text)).toContain("A note from MCP");

    const chat = await user.call("chat_ticket", { id, message: "please start" });
    expect(chat.text).toStartWith(`Sent to ${id}. `);
    await until(async () => (await ticket(id)).status !== "backlog", 15_000, "the chat to start a run");

    const stop = await user.call("stop_ticket", { id });
    expect([`Stopped the run on ${id}.`, `${id} had no run to stop.`]).toContain(stop.text);

    const gone = await newTicket("To delete");
    expect((await user.call("delete_ticket", { id: gone })).text).toBe(`Deleted ${gone}.`);
    expect((await d.api("GET", `${P}/tickets/${gone}`)).status).toBe(404);
  });

  test("report_bug falls back to a prefilled link when gh can't file it", async () => {
    const r = await user.call("report_bug", { title: "Contract bug", description: "It broke.", includeLogs: false });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("GitHub CLI (gh) is not logged in.");
    expect(r.text).toMatch(/https:\/\/github\.com\/\S+\/issues\/new\?title=Contract\+bug/);
  });

  test("run-only and front-desk-only tools refuse elsewhere", async () => {
    expect((await user.call("ask_ticket", { id: host, question: "q" })).text).toBe("ask_ticket works inside a board run (the answer comes back to that run's ticket)");
    expect((await user.call("merge_into_main")).text).toBe("merge_into_main works inside a tool ticket's board run");
    expect((await user.call("land_milestone", { summary: "s" })).text).toBe("land_milestone works inside the main ticket's board run");
    expect((await user.call("send_file", { path: "/etc/hosts" })).text).toBe("send_file only works in the Telegram front desk's chat");
    // A main ticket's run has no main ticket to merge into.
    expect((await run.call("merge_into_main")).text).toBe("only a tool ticket merges into its main ticket's copy");
  });

  test("a board run can't change other tickets", async () => {
    const other = await newTicket("Not yours");
    // delete_ticket is refused by the MCP server itself, before any HTTP.
    const del = await run.call("delete_ticket", { id: other });
    expect(del).toMatchObject({ isError: true, text: `changing the board is disabled inside a board run (CKANBAN_TICKET=${SLUG}/${host}), so runs can't create or start other runs. Reading tickets still works; ask the user to make this change on the board.` });
    // create_ticket and comment_ticket are left to the daemon, which refuses a run that isn't working right now.
    for (const [tool, args] of [["create_ticket", { title: "From a run" }], ["comment_ticket", { id: other, text: "x" }]] as const) {
      const r = await run.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toStartWith("changing the board is disabled inside a board run that isn't working right now");
    }
    expect((await ticket(other)).title).toBe("Not yours");
    expect((await d.api("GET", `${P}/tickets/${other}/comments`)).data).toEqual([]);
    // Reading still works.
    expect((await run.call("get_ticket", { id: other })).text).toStartWith("Not yours");
  });
});

describe("forms group", () => {
  test("card tools validate and answer with the card text", async () => {
    const SHOWN = "Shown to the user as a card. End your turn and wait for their reply.";
    expect((await user.call("propose_ticket", { title: "Better title", description: "Better words" })).text).toBe(SHOWN);
    expect((await user.call("propose_ticket", { title: "", description: "x" })).text).toBe("title is required. Fix it and call propose_ticket again.");
    expect((await user.call("propose_branch", {})).text).toBe(SHOWN);
    const other = await newTicket("Maybe delete");
    expect((await user.call("propose_delete", { ids: [other], reason: "duplicate" })).text).toBe(SHOWN);
    expect((await user.call("propose_delete", { ids: ["t_20200101_none"], reason: "x" })).text).toBe(`no such ticket on board ${SLUG}: t_20200101_none. Check list_tickets.`);
    expect((await run.call("propose_delete", { ids: [host], reason: "x" })).text).toBe(`${host} is this chat's own ticket and can't be proposed for deletion; ask the user to delete it from the board.`);
    // Nothing was deleted.
    expect((await d.api("GET", `${P}/tickets/${other}`)).status).toBe(200);
    expect((await user.call("propose_teammate", { name: "checker", prompt: "Check it.", why: "needed" })).text).toBe(SHOWN);

    const q = { questions: [{ question: "A or B?", options: [{ label: "A", recommended: true }, { label: "B" }] }] };
    expect((await run.call("ask_questions", q)).text).toBe("Shown to the user as a form. End your turn and wait for their reply.");
    expect((await run.call("ask_questions", { questions: [] })).text).toBe("questions must be a non-empty list. Fix it and call ask_questions again.");
    const keys = await user.call("ask_keys", { keys: [{ name: "SENTRY_TOKEN" }], reason: "r" });
    expect(keys.text).toStartWith("ask_keys works only in a board ticket's chat");
  });

  test("backup_file copies a file into the board's private folder", async () => {
    const r = await user.call("backup_file", { path: "README.md" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith("Saved a private copy of ");
    const file = r.text.match(/ to (\S+) \(/)![1];
    expect(file.startsWith(join(d.home, "profiles", SLUG, ".key-backups") + "/")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("# Contract test project\n");
    const missing = await user.call("backup_file", { path: "no-such-file.txt" });
    expect(missing.text).toContain("no-such-file.txt doesn't exist: nothing to back up.");
  });
});

describe("connections group", () => {
  test("list_connections, connection_tools, test_automation_script, propose_automation", async () => {
    const list = await user.call("list_connections");
    expect(list.text).toStartWith("Connected for automations:\n(none yet)");
    const tools = await user.call("connection_tools", { name: "gmail" });
    expect(tools).toMatchObject({ isError: true });
    expect(tools.text).toStartWith('"gmail" isn\'t connected for automations yet');

    const trial = await user.call("test_automation_script", { script: `echo '{"id":"a1","title":"First item"}'` });
    expect(trial.isError).toBe(false);
    expect(trial.text).toStartWith("Found 1 item in ");
    expect(trial.text).toContain("- [a1] First item");

    const card = await user.call("propose_automation", { name: "Inbox", summary: "Checks the inbox", script: "echo" });
    expect(card.text).toBe("Shown to the user as a card. End your turn and wait for their reply.");
  });
});

describe("huddles group", () => {
  test("presets: list, save, delete; a run is told to propose instead", async () => {
    const list = await user.call("list_huddle_presets");
    expect(list.text).toStartWith(`Teammates (huddle presets) on board ${SLUG}:`);
    expect(list.text).toContain("- reviewer: Code reviewer");

    const saved = await user.call("save_huddle_preset", { name: "contract-role", prompt: "Check the contract." });
    expect(saved.text).toStartWith(`Saved preset "contract-role" on board ${SLUG}:`);
    const presets = (await d.api("GET", `${P}/huddle-presets`)).data;
    expect(JSON.stringify(presets)).toContain("Check the contract.");

    const inRun = await run.call("save_huddle_preset", { name: "run-role", prompt: "x" });
    expect(inRun.text).toStartWith("Nothing was saved: inside a board or huddle run only the user saves teammates.");
    expect(JSON.stringify((await d.api("GET", `${P}/huddle-presets`)).data)).not.toContain("run-role");

    expect((await user.call("delete_huddle_preset", { name: "contract-role" })).text).toBe('Deleted preset "contract-role".');
    expect(JSON.stringify((await d.api("GET", `${P}/huddle-presets`)).data)).not.toContain("Check the contract.");
  });

  test("read, post, findings and brief in a huddle the user started", async () => {
    const t = await newTicket("Huddle host");
    const h = await d.api("POST", `${P}/huddles`, { ticketId: t, roster: [{ preset: "reviewer" }] });
    expect(h.status).toBe(201);
    const huddle = h.data.id;

    const read = await user.call("huddle_read", { huddle });
    expect(read.text).toStartWith(`Huddle ${huddle} on ticket ${t} "Huddle host": live. You are @you.`);
    expect((await user.call("huddle_post", { huddle, text: "hello team" })).text).toMatch(/^Posted #\d+ as @you\.$/);
    expect((await user.call("huddle_findings", { huddle, action: "add", text: "a finding" })).text).toBe("- f1 [open] a finding (by @you)");
    expect((await user.call("huddle_brief", { huddle, text: "the brief" })).text).toBe("Pinned brief updated (9 characters).");

    const view = await d.api("GET", `${P}/huddles/${huddle}?limit=60`);
    expect(view.status).toBe(200);
    expect(view.data.huddle.brief.text).toBe("the brief");
    expect(view.data.huddle.findings).toMatchObject([{ id: "f1", text: "a finding", status: "open", by: "you" }]);
    expect(view.data.messages.map((m: any) => m.text)).toContain("hello team");

    expect((await user.call("huddle_status", { huddle, status: "done" })).text).toBe("the user has no huddle status");
    expect((await user.call("huddle_mode", { huddle, mode: "tagged" })).text).toBe("outside a board run you are the user; change a participant's mode on the board");
    expect((await user.call("huddle_hand_in", { huddle, summary: "x" })).text).toBe("only helpers hand in changes; yours are in the ticket's folder already");
    expect((await user.call("huddle_review_changes", { huddle, id: "reviewer", accept: true })).text).toBe(`no hand-in reviewer in huddle ${huddle}`);

    const added = await user.call("huddle_add_participant", { huddle, preset: "reviewer", focus: "a second look" });
    expect(added.text).toBe("Added @reviewer-1 (Code reviewer, tagged); they start now. 3/8 participants.");
    expect((await user.call("huddle_allow_changes", { huddle, handle: "reviewer-1" })).text).toBe("@reviewer-1 can change files now; it was tagged and works in its own copy of the folder from its next turn.");
    const people = (await d.api("GET", `${P}/huddles/${huddle}?limit=1`)).data.huddle.participants;
    expect(people.find((p: any) => p.handle === "reviewer-1")).toMatchObject({ mode: "tagged", canEdit: true });

    // Closing needs the summary file first (its path is in the answer).
    const early = await user.call("huddle_close", { huddle, reason: "done" });
    expect(early.isError).toBe(true);
    const summary = early.text.match(/^write the huddle summary first: (\S+summary\.md) /)![1];
    expect(summary).toBe(join(d.home, "profiles", SLUG, "tickets", t, "outputs", "huddles", huddle, "summary.md"));
    mkdirSync(dirname(summary), { recursive: true });
    writeFileSync(summary, "# Summary\n\nAll checked.\n");
    const closed = await user.call("huddle_close", { huddle, reason: "done" });
    // Only an auto huddle's host run closes it; anyone else asks the user.
    expect(closed.text).toBe("Asked the user to close the huddle. Only they close it; until then the huddle stays open.");
    expect((await d.api("GET", `${P}/huddles/${huddle}?limit=1`)).data.huddle.status).toBe("live");
  });

  test("huddle tools need a huddle; start_huddle and propose_huddle", async () => {
    expect((await user.call("huddle_read")).text).toBe("huddle is required outside a board run");
    expect((await run.call("huddle_read")).text).toBe(`ticket ${host} is in no open huddle`);
    const start = await user.call("start_huddle", { trigger: "security", reason: "r" });
    expect(start.text).toStartWith("start_huddle only works inside an unattended board run");
    expect((await user.call("propose_huddle", { template: "auto-review" })).text).toBe("Shown to the user as a card. End your turn and wait for their reply.");
    expect((await user.call("propose_squad", { name: "pair", roster: [{ preset: "reviewer" }], why: "w" })).text).toBe("Shown to the user as a card. End your turn and wait for their reply.");
  });
});

describe("artifacts group", () => {
  test("read_artifact needs a url; publish_artifact saves the page before the helper runs", async () => {
    expect((await user.call("read_artifact", { url: "" })).text).toBe("url is required");
    // The fake Claude can't publish, so the helper fails; the page is already saved under CKANBAN_OUTPUT_DIR.
    const r = await user.call("publish_artifact", { html: "<html><body>hi</body></html>", title: "Contract Page" });
    expect(r.isError).toBe(true);
    expect(r.text).toStartWith("artifact publish failed: ");
    expect(readFileSync(join(outDir, "artifacts", "contract-page.html"), "utf8")).toBe("<html><body>hi</body></html>");
  }, 30_000);
});

describe("helper group", () => {
  test("propose_helper_rule shows a card only in a board run", async () => {
    const out = await user.call("propose_helper_rule", { text: "Website enquiries can wait until morning" });
    expect(out.isError).toBe(true);
    expect(out.text).toStartWith("Nothing was saved and no card was shown: only a board ticket's chat can show the user a card for this");
    const inRun = await run.call("propose_helper_rule", { text: "Website enquiries can wait until morning" });
    expect(inRun.isError).toBe(false);
    expect(inRun.text).toStartWith("Nothing is saved yet: the board shows the user a card");
  });
});

describe("schedules group", () => {
  test("create, update, history, run now and delete a schedule", async () => {
    const created = await user.call("create_schedule", { name: "Nightly", title: "Nightly {date}", body: "Check.", cron: "0 3 * * *" });
    expect(created.isError).toBe(false);
    const id = created.text.match(/^Created schedule (\w+) on board mcp: Nightly, Every day at 03:00 \(0 3 \* \* \*\), auto mode\./)![1];
    expect(created.text).toContain("Next runs: ");
    const listed = (await d.api("GET", `${P}/schedules`)).data.find((s: any) => s.id === id);
    expect(listed).toMatchObject({ name: "Nightly", title: "Nightly {date}", body: "Check.", cron: "0 3 * * *", enabled: true });
    expect((await user.call("list_schedules")).text).toContain(id);

    expect((await user.call("update_schedule", { id, enabled: false })).text).toBe(`Updated: ${id}  [paused]  Nightly: Every day at 03:00 (0 3 * * *)`);
    expect((await d.api("GET", `${P}/schedules`)).data.find((s: any) => s.id === id).enabled).toBe(false);

    const hist = await user.call("schedule_history", { id });
    expect(hist.text).toContain("paused enabled by the user");
    expect(hist.text).toContain("created by the user");

    const ran = await user.call("run_schedule", { id });
    const made = ran.text.match(/created ticket (t_\d{8}_\w+)/)![1];
    expect((await ticket(made)).title).toStartWith("Nightly ");

    // In a board run, delete_schedule only shows the user a card: nothing is deleted.
    const asked = await run.call("delete_schedule", { id, reason: "not needed" });
    expect(asked.text).toStartWith('Nothing is deleted yet: the board shows the user a card in this ticket\'s chat for schedule "Nightly" (Every day at 03:00)');
    expect((await d.api("GET", `${P}/schedules`)).data.some((s: any) => s.id === id)).toBe(true);
    expect((await run.call("delete_schedule", { id: "nope" })).text).toBe(`no schedule nope on board ${SLUG}. Check list_schedules.`);

    const del = await user.call("delete_schedule", { id });
    expect(del.text).toBe(`Deleted schedule ${id}.`);
    expect((await d.api("GET", `${P}/schedules`)).data.some((s: any) => s.id === id)).toBe(false);
  });

  test("one-time jobs: schedule, list, update, run now, cancel", async () => {
    const made = await user.call("schedule_job", { name: "Later", at: "2030-01-01 09:00", action: { kind: "command", command: "echo hi" } });
    const id = made.text.match(/^Scheduled job (\w+) on board mcp: Later runs /)![1];
    expect((await d.api("GET", `${P}/jobs/${id}`)).data).toMatchObject({ id, name: "Later", state: "scheduled", action: { kind: "command", command: "echo hi" } });
    expect((await user.call("list_jobs")).text).toContain(`${id}  [scheduled]  Later: `);

    expect((await user.call("update_job", { id, name: "Later on" })).text).toStartWith(`Updated: ${id}  [scheduled]  Later on: `);
    expect((await d.api("GET", `${P}/jobs/${id}`)).data.name).toBe("Later on");

    expect((await user.call("run_job_now", { id })).text).toStartWith(`Started: ${id}  [`);
    await until(async () => (await d.api("GET", `${P}/jobs/${id}`)).data.state !== "scheduled", 15_000, "the job to run");

    const other = (await user.call("schedule_job", { name: "Never", at: "2030-01-02 09:00", action: { kind: "command", command: "echo no" } })).text.match(/job (\w+)/)![1];
    expect((await user.call("cancel_job", { id: other })).text).toStartWith(`Cancelled: ${other}  [cancelled]  Never: `);
    expect((await d.api("GET", `${P}/jobs/${other}`)).data.state).toBe("cancelled");
  });
});
