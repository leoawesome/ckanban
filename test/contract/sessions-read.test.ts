// Outside-in contract: reading a ticket's Claude session from transcripts already on disk. Tickets and transcripts are
// written as files before the daemon starts (no runs). Covers the conversation (with an earlier chat left behind by
// "Send in a fresh chat"), tool, agent and workflow details, search_chat and read_chat with their reach rules, the
// board folder's Claude sessions, `session.updated` when a transcript grows, and the summaries file. See
// contracts/api.md "Ticket chat, runs and conversation" and contracts/data-files.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";

let d: Daemon;
const SLUG = "reading";
const TICKET = "t_20261101_rd01";
const OTHER = "t_20261101_rd02";
const OLD = "11111111-1111-4111-8111-111111111111";
const NOW = "22222222-2222-4222-8222-222222222222";
const LOOSE = "33333333-3333-4333-8333-333333333333";
const SCRIPT = "export const meta = { name: 'review', description: 'Review it', phases: [{ title: 'Read' }] }";

const line = (o: unknown) => JSON.stringify(o) + "\n";
let n = 0;
const at = () => `2026-11-01T10:${String(n++).padStart(2, "0")}:00.000Z`;
const user = (uuid: string, content: unknown) => line({ type: "user", uuid, timestamp: at(), message: { role: "user", content } });
const reply = (uuid: string, content: unknown[]) => line({ type: "assistant", uuid, timestamp: at(), message: { role: "assistant", model: "claude-opus-5-5", content } });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });

/** The project folder's transcripts folder, as Claude names it. */
const projectDir = (claudeDir: string, project: string) => join(claudeDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
let transcripts = "";

function ticketFile(home: string, id: string, fields: string) {
  const dir = join(home, "profiles", SLUG, "tickets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), `---\nid: ${id}\n${fields}createdAt: 2026-11-01T09:00:00.000Z\nupdatedAt: 2026-11-01T09:00:00.000Z\n---\nAbout it.\n`);
}

beforeAll(async () => {
  d = await startDaemon({
    before: ({ home, claudeDir, project }) => {
      mkdirSync(join(home, "profiles", SLUG), { recursive: true });
      writeFileSync(join(home, "profiles", SLUG, "profile.json"), JSON.stringify({ name: "Reading", slug: SLUG, path: project, createdAt: "2026-11-01T09:00:00.000Z" }, null, 2) + "\n");
      ticketFile(home, TICKET, `title: Read me\nstatus: review\norder: 1\nsessionId: ${NOW}\nearlierSessions:\n  - sessionId: ${OLD}\n    endedAt: 2026-11-01T09:30:00.000Z\n`);
      ticketFile(home, OTHER, "title: Someone else\nstatus: backlog\norder: 2\n");
      transcripts = projectDir(claudeDir, project);
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, `${OLD}.jsonl`), [
        user("o1", "the zebra crossing is broken"),
        reply("o2", [toolUse("tu_old", "Bash", { command: "ls old" })]),
        user("o3", [toolResult("tu_old", "old.txt")]),
        reply("o4", [{ type: "text", text: "Looked at the old files." }]),
      ].join(""));
      writeFileSync(join(transcripts, `${NOW}.jsonl`), [
        line({ type: "custom-title", customTitle: "Reading session" }),
        user("n1", "fix the login"),
        reply("n2", [toolUse("tu_ls", "Bash", { command: "ls src" }), toolUse("ag1", "Agent", { description: "Look around", prompt: "List", subagent_type: "Explore" })]),
        user("n3", [toolResult("tu_ls", "app.ts\nlib.ts")]),
        user("n4", [toolResult("ag1", "Found two files.")]),
        reply("n5", [toolUse("wf1", "Workflow", { script: SCRIPT })]),
        reply("n6", [{ type: "text", text: "Done with the login." }]),
      ].join(""));
      // A session nobody linked, started in the same folder.
      writeFileSync(join(transcripts, `${LOOSE}.jsonl`), user("l1", "just  a\nquestion"));
    },
  });
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const tp = (id: string, rest: string) => `/api/profiles/${SLUG}/tickets/${id}${rest}`;

describe("a ticket's conversation from its transcripts", () => {
  test("earlier chat first, then a fresh-chat note, then the current chat; paging by limit and before", async () => {
    const r = await d.api("GET", tp(TICKET, "/conversation"));
    expect(r.status).toBe(200);
    const all = r.data;
    expect(all).toMatchObject({ start: 0, title: "Reading session" });
    const texts = all.entries.map((e: any) => `${e.role}:${e.kind}:${e.text}`);
    expect(texts).toEqual([
      "user:text:the zebra crossing is broken", "assistant:tool:Bash: ls old", "assistant:text:Looked at the old files.",
      "assistant:board:Fresh chat from here: Claude no longer reads the messages above, but can look them up.",
      "user:text:fix the login", "assistant:tool:Bash: ls src", "assistant:agent:Agent: Look around", "assistant:workflow:review",
      "assistant:text:Done with the login.",
    ]);
    expect(all.total).toBe(9);
    // Only the current chat's messages can be rewound to.
    expect(all.entries[0].rewind).toBeUndefined();
    expect(all.entries[4]).toMatchObject({ uuid: "n1", rewind: true });
    expect(all.entries[3]).toMatchObject({ uuid: `fresh-chat-${OLD}`, at: "2026-11-01T09:30:00.000Z" });
    // The agent row: done with its result; the workflow row: no script in the conversation.
    expect(all.entries[6].agent).toMatchObject({ toolUseId: "ag1", status: "done", result: "Found two files.", type: "Explore" });
    expect(all.entries[7].workflow).toMatchObject({ toolUseId: "wf1", name: "review" });
    expect(all.entries[7].workflow.script).toBeUndefined();
    const page = (await d.api("GET", tp(TICKET, "/conversation?limit=3"))).data;
    expect(page).toMatchObject({ start: 6, total: 9 });
    expect(page.entries).toEqual(all.entries.slice(6));
    const earlier = (await d.api("GET", tp(TICKET, "/conversation?limit=3&before=6"))).data;
    expect(earlier.entries).toEqual(all.entries.slice(3, 6));
    // A ticket with no session has an empty conversation.
    expect((await d.api("GET", tp(OTHER, "/conversation"))).data).toEqual({ entries: [], start: 0, total: 0, title: null });
  });

  test("tool, agent and workflow details; unknown ones answer 404", async () => {
    expect((await d.api("GET", tp(TICKET, "/tool/tu_ls"))).data).toEqual({ id: "tu_ls", name: "Bash", input: { command: "ls src" }, output: "app.ts\nlib.ts", isError: false, truncated: false });
    // A tool call of the chat left behind is found too.
    expect((await d.api("GET", tp(TICKET, "/tool/tu_old"))).data).toMatchObject({ id: "tu_old", output: "old.txt" });
    const tool404 = await d.api("GET", tp(TICKET, "/tool/nope"));
    expect(tool404).toMatchObject({ status: 404, data: { error: "no such tool call in this ticket's conversation" } });
    expect((await d.api("GET", tp(TICKET, "/agent/ag1"))).data).toMatchObject({ toolUseId: "ag1", description: "Look around", status: "done" });
    expect(await d.api("GET", tp(TICKET, "/agent/nope"))).toMatchObject({ status: 404, data: { error: "no such subagent in this ticket's conversation" } });
    expect((await d.api("GET", tp(TICKET, "/workflow/wf1/script"))).data).toEqual({ script: SCRIPT });
    expect(await d.api("GET", tp(TICKET, "/workflow/wf1/agent/ag9"))).toMatchObject({ status: 404, data: { error: "no such helper agent in this workflow" } });
    expect(await d.api("GET", tp(TICKET, "/workflow/nope/script"))).toMatchObject({ status: 404, data: { error: "no such workflow in this ticket's conversation" } });
    expect(await d.api("GET", tp("t_20261101_none", "/conversation"))).toMatchObject({ status: 404, data: { error: "ticket t_20261101_none not found" } });
    expect(await d.api("GET", "/api/profiles/nope/tickets/x/conversation")).toMatchObject({ status: 404, data: { error: "board nope not found" } });
  });
});

describe("search_chat and read_chat over transcripts", () => {
  test("search finds a message of the earlier chat; read gives it by its ref; reach rules hold", async () => {
    const s = await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${TICKET}&q=zebra`);
    expect(s.status).toBe(200);
    expect(s.data.text).toContain("zebra crossing");
    const ref = s.data.text.match(new RegExp(`${OLD}:\\d+`))![0];
    const read = await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}&before=1&after=1`);
    expect(read.status).toBe(200);
    expect(read.data.text).toContain("zebra crossing");
    // The ticket's own run may search its chat (the ticket comes from the run's header).
    const own = { "x-ckanban-run": `${SLUG}/${TICKET}` };
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?q=login`, undefined, own)).data.text).toContain("fix the login");
    expect(await d.api("GET", `/api/profiles/${SLUG}/chat/search?q=x`)).toMatchObject({ status: 400, data: { error: "say which ticket's chat to search (ticket)" } });
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=t_20261101_none&q=x`)).status).toBe(404);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${TICKET}&q=zebra`, undefined, { ...own, "x-ckanban-huddle-agent": "h/x/y" })).status).toBe(403);
    // Another ticket's run can't read this chat.
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}`, undefined, { "x-ckanban-run": `${SLUG}/${OTHER}` })).status).toBe(403);
    expect(await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=bad`)).toMatchObject({ status: 400, data: { error: "ref must look like <sessionId>:<message number>, as search_chat gives it" } });
    expect(await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${LOOSE}:1`)).toMatchObject({ status: 404, data: { error: `no ticket on this board has the chat ${LOOSE}` } });
  });
});

test("the board folder's Claude sessions, newest first, with the linked ticket", async () => {
  const r = await d.api("GET", `/api/profiles/${SLUG}/sessions`);
  expect(r.status).toBe(200);
  const byId = new Map(r.data.map((s: any) => [s.id, s]));
  expect(byId.get(NOW)).toMatchObject({ title: "Reading session", firstPrompt: "fix the login", live: false, ticket: { id: TICKET, title: "Read me" } });
  expect(byId.get(LOOSE)).toMatchObject({ title: null, firstPrompt: "just a question", ticket: null });
  for (const s of r.data) expect(Number.isNaN(Date.parse(s.lastActive))).toBe(false);
});

test("a transcript that grows is announced as session.updated, and summaries are kept in session-summaries.json", async () => {
  const ctl = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const want = new RegExp(`"type":"session\\.updated","profile":"${SLUG}","id":"${TICKET}"[^\\n]*"text":"Fixed it, really\\."`);
  // The watcher takes stock first; keep appending until a change is announced (a pass every 2 s).
  await until(async () => {
    appendFileSync(join(transcripts, `${NOW}.jsonl`), reply(`n${n}`, [{ type: "text", text: "Fixed it, really." }]));
    const end = Date.now() + 3_000;
    while (!want.test(seen) && Date.now() < end) {
      const r = await Promise.race([reader.read(), Bun.sleep(end - Date.now()).then(() => null)]);
      if (r && !r.done) seen += dec.decode(r.value, { stream: true });
    }
    return want.test(seen) || null;
  }, 30_000, "session.updated for the grown transcript");
  ctl.abort();
  const file = join(d.home, "session-summaries.json");
  // Written at most every 30 s, and when the daemon stops: stop it (its folders stay until d.stop()).
  process.kill(d.pid, "SIGTERM");
  await until(() => {
    try {
      process.kill(d.pid, 0);
      return null;
    } catch {
      return true;
    }
  }, 15_000, "the daemon to stop");
  expect(existsSync(file)).toBe(true);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.tag).toMatch(/^2:/);
  // With the board in Rust, the Rust watcher made them (Bun as its satellite neither watches nor writes this file).
  expect(saved.tag).toMatch(/^2:rust:/);
  expect(saved.items[NOW].s).toMatchObject({ title: "Reading session", lastMessage: { role: "assistant", text: "Fixed it, really." } });
}, 60_000);
