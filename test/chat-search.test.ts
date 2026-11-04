// search_chat / read_chat (chat-search.ts, the /chat routes and the MCP tools) and the automatic fresh start of a cold,
// large main or feature chat (Board.autoFresh).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { AUTO_FRESH_NOTE, Board } from "../src/server/board";
import { chatIsCold } from "../src/server/chat-cache";
import { READ_MAX_MESSAGES, readChat, searchChat, type ChatSource } from "../src/server/chat-search";
import { createServer } from "../src/server/http";
import type { SessionEntry, SessionSummary } from "../src/server/session";
import type { Ticket } from "../src/server/types";
import { board, bus, FAKE, readArgs, setBoard, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

const entry = (i: number, text: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  uuid: `u${i}`, at: `2026-11-0${1 + (i % 5)}T10:00:00Z`, role: i % 2 ? "assistant" : "user", kind: "text", text, ...extra,
});

test("searchChat: needs every word, any case, whole words only, newest first, capped at 10", () => {
  const src: ChatSource = { sessionId: "s1", entries: Array.from({ length: 30 }, (_, i) => entry(i, `Note ${i}: the Staging port is ${8000 + i}`)) };
  const r = searchChat([src], "staging PORT");
  expect(r.total).toBe(30);
  expect(r.matches).toHaveLength(10);
  expect(r.matches[0].ref).toBe("s1:29");
  expect(r.matches[9].ref).toBe("s1:20");
  expect(r.matches[0].who).toBe("Claude");
  expect(searchChat([src], "stag port").total).toBe(0); // no stemming or partial words
  expect(searchChat([src], "staging 8007").matches.map((m) => m.ref)).toEqual(["s1:7"]);
  expect(() => searchChat([src], "  ")).toThrow("empty");
});

test("searchChat: tool rows and their output only with includeTools; later sessions come first", () => {
  const old: ChatSource = {
    sessionId: "old", entries: [entry(0, "the password is swordfish"), entry(1, "Bash: cat secrets.txt", { kind: "tool", toolUseId: "tu1" })],
    toolOutput: new Map([["tu1", "swordfish appears here too"]]),
  };
  const cur: ChatSource = { sessionId: "new", entries: [entry(0, "remember swordfish?")] };
  expect(searchChat([old, cur], "swordfish").matches.map((m) => m.ref)).toEqual(["new:0", "old:0"]);
  const withTools = searchChat([old, cur], "swordfish", { includeTools: true });
  expect(withTools.matches.map((m) => m.ref)).toEqual(["new:0", "old:1", "old:0"]);
  expect(withTools.matches[1].who).toBe("Tool");
});

test("readChat: the stretch around a ref, capped at 40 messages and about 8,000 tokens", () => {
  const src: ChatSource = { sessionId: "s", entries: Array.from({ length: 100 }, (_, i) => entry(i, `message ${i}`)) };
  const r = readChat(src, 50, { before: 2, after: 3 });
  expect(r.lines.map((l) => l.text)).toEqual(["message 48", "message 49", "message 50", "message 51", "message 52", "message 53"]);
  expect(r.capped).toBe(false);
  const big = readChat(src, 50, { before: 100, after: 100 });
  expect(big.lines).toHaveLength(READ_MAX_MESSAGES);
  expect(big.capped).toBe(true);
  expect(big.lines.some((l) => l.ref === "s:50")).toBe(true);
  const long: ChatSource = { sessionId: "l", entries: Array.from({ length: 20 }, (_, i) => entry(i, "x".repeat(8000))) };
  const t = readChat(long, 10, { before: 10, after: 10 });
  expect(t.capped).toBe(true);
  expect(t.lines.reduce((n, l) => n + l.text.length, 0) / 4).toBeLessThanOrEqual(8000);
  expect(() => readChat(src, 500)).toThrow("no message 500");
});

test("chatIsCold: cold once Claude's last reply is older than the cache time", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(chatIsCold({ at: "2026-11-05T10:00:00Z", ttl: "1h" }, now)).toBe(true);
  expect(chatIsCold({ at: "2026-11-05T11:30:00Z", ttl: "1h" }, now)).toBe(false);
  expect(chatIsCold({ at: "2026-11-05T11:50:00Z", ttl: "5m" }, now)).toBe(true);
});

/** A transcript file the session parser reads, with the given user/assistant texts (and tool calls). */
function writeSession(sessionId: string, turns: ({ user: string } | { claude: string } | { tool: string; output: string })[]): void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-tmp-project");
  mkdirSync(dir, { recursive: true });
  const lines = turns.map((t, i) => {
    const timestamp = new Date(Date.parse("2026-11-01T10:00:00Z") + i * 60_000).toISOString();
    const base = { uuid: `${sessionId}-${i}`, timestamp, sessionId };
    if ("user" in t) return [{ ...base, type: "user", message: { role: "user", content: t.user } }];
    if ("claude" in t) return [{ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t.claude }] } }];
    return [
      { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${i}`, name: "Bash", input: { command: t.tool } }] } },
      { ...base, uuid: `${base.uuid}r`, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: t.output }] } },
    ];
  }).flat();
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("search_chat finds a message from before Send in a fresh chat; read_chat loads around it; tickets out of reach are refused", async () => {
  const p = await setup();
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const main = await board.createTicket("p", { title: "Outreach", body: "", status: "review", main: true });
    const tool = await board.createTicket("p", { title: "Look", body: "", status: "backlog", parentId: main.id, tool: true, kind: "explore" });
    const other = await board.createTicket("p", { title: "Other", body: "", status: "review" });
    const [old, cur, toolS, otherS] = ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000003", "aaaaaaaa-0000-0000-0000-000000000004"];
    writeSession(old, [
      { user: "Use the blue logo on the landing page" }, { claude: "Noted: blue logo." },
      { tool: "grep -r giraffe .", output: "src/zoo.ts: giraffe count 7" }, { claude: "Done." },
    ]);
    writeSession(cur, [{ user: "What next?" }, { claude: "Let's ship." }]);
    writeSession(toolS, [{ user: "check the replies" }, { claude: "Found 12 replies from Acme" }]);
    writeSession(otherS, [{ claude: "secret plan for Acme" }]);
    store.updateTicket("p", main.id, { sessionId: cur, sessionStarted: true, earlierSessions: [{ sessionId: old, endedAt: "2026-11-02T00:00:00Z" }] });
    store.updateTicket("p", tool.id, { sessionId: toolS, sessionStarted: true });
    store.updateTicket("p", other.id, { sessionId: otherS, sessionStarted: true });
    const ctx: ToolContext = { client: new BoardClient(server.port!), cwd: p.path, env: { CKANBAN_TICKET: `p/${main.id}` } };

    const found = await callTool("search_chat", { query: "BLUE logo" }, ctx);
    expect(found.isError).toBeUndefined();
    expect(found.content[0].text).toContain(`[${old}:0]`);
    expect(found.content[0].text).toContain("User:\nUse the blue logo on the landing page");
    expect(found.content[0].text).toContain(`[${old}:1]`);
    // Tool output is left out unless asked for.
    expect((await callTool("search_chat", { query: "giraffe" }, ctx)).content[0].text).toStartWith("No messages");
    expect((await callTool("search_chat", { query: "giraffe", includeTools: true }, ctx)).content[0].text).toContain("giraffe count 7");
    // A main ticket may search its tool tickets; not other tickets.
    expect((await callTool("search_chat", { query: "acme", ticket: tool.id }, ctx)).content[0].text).toContain("Found 12 replies from Acme");
    const refused = await callTool("search_chat", { query: "acme", ticket: other.id }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(`your own ticket (${main.id}) and of its tool tickets`);
    // A tool ticket can't search its main ticket's chat, or read it by ref.
    const toolCtx: ToolContext = { ...ctx, env: { CKANBAN_TICKET: `p/${tool.id}` } };
    expect((await callTool("search_chat", { query: "blue", ticket: main.id }, toolCtx)).isError).toBe(true);
    expect((await callTool("read_chat", { ref: `${old}:0` }, toolCtx)).isError).toBe(true);

    const read = await callTool("read_chat", { ref: `${old}:1`, before: 1, after: 1 }, ctx);
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toContain("Use the blue logo");
    expect(read.content[0].text).toContain("Noted: blue logo.");
    expect(read.content[0].text).toContain("Bash");
    expect(read.content[0].text).not.toContain("Done.");
    expect((await callTool("read_chat", { ref: "nonsense" }, ctx)).isError).toBe(true);
  } finally {
    server.stop(true);
  }
}, 30_000);

// ---- Automatic fresh start of a cold, large main chat ----

function boardWithCache(cache: () => SessionSummary["cache"]): Board {
  return setBoard(new Board(store, bus, {
    claudeBin: FAKE, isSessionLive: async () => false, planWakeDelayMs: 30,
    sessionSummary: () => ({ title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: cache() }),
  }));
}
const cacheOf = (minutesAgo: number, tokens: number): SessionSummary["cache"] => ({
  tokens, coldTokens: tokens, at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ttl: "1h", hourTokens: 0, hourAt: null, model: "claude-opus-5-5", costUsd: 1,
});

async function mainWithChat(): Promise<Ticket> {
  const main = await board.createTicket("p", { title: "Widget", body: "Goal: ship it.", status: "review", mode: "auto", main: true });
  board.updateStatus("p", main.id, { goal: "Ship the widget by Friday", next: "Pick a colour" });
  await board.chat("p", main.id, "first message");
  await untilSpawned(1);
  await board.whenIdle();
  return store.getTicket("p", main.id)!;
}

test("a cold, large main chat starts its next turn fresh, with the status in its first prompt, and shows the note", async () => {
  await setup();
  let cache = cacheOf(1, 10);
  boardWithCache(() => cache);
  const before = await mainWithChat();
  cache = cacheOf(120, 200_000);
  await board.chat("p", before.id, "what colour did we pick?");
  await untilSpawned(2);
  await board.whenIdle();
  const got = store.getTicket("p", before.id)!;
  expect(got.sessionId).not.toBe(before.sessionId);
  expect(got.earlierSessions?.map((s) => s.sessionId)).toEqual([before.sessionId!]);
  expect(got.freshSession).toBe(false);
  const call = readArgs().at(-1)!;
  expect(call.args).toContain("--session-id");
  expect(call.prompt).toStartWith("what colour did we pick?");
  expect(call.prompt).toContain("Ship the widget by Friday");
  expect(call.prompt).toContain("# Family (tool tickets)");
  expect(call.prompt).toContain("search_chat");
  expect(store.listComments("p", before.id).some((c) => c.author === "ai" && c.text === AUTO_FRESH_NOTE)).toBe(true);
}, 30_000);

test("a warm or small main chat continues as usual", async () => {
  await setup();
  let cache = cacheOf(1, 10);
  boardWithCache(() => cache);
  const before = await mainWithChat();
  cache = cacheOf(5, 400_000); // big but warm
  await board.chat("p", before.id, "two");
  await untilSpawned(2);
  await board.whenIdle();
  cache = cacheOf(300, 20_000); // cold but small
  await board.chat("p", before.id, "three");
  await untilSpawned(3);
  await board.whenIdle();
  const got = store.getTicket("p", before.id)!;
  expect(got.sessionId).toBe(before.sessionId);
  expect(got.earlierSessions ?? []).toEqual([]);
  expect(readArgs().slice(1).every((a) => a.args.includes("--resume") && !a.prompt.includes("search_chat"))).toBe(true);
  expect(store.listComments("p", before.id).some((c) => c.text === AUTO_FRESH_NOTE)).toBe(false);
}, 30_000);

test("the board setting freshChatTokens raises the size a cold chat must pass; plain tickets never start fresh by themselves", async () => {
  const p = await setup();
  store.saveProfile({ ...p, freshChatTokens: 500_000 });
  let cache = cacheOf(1, 10);
  boardWithCache(() => cache);
  const main = await mainWithChat();
  cache = cacheOf(120, 200_000);
  await board.chat("p", main.id, "two");
  await untilSpawned(2);
  await board.whenIdle();
  expect(store.getTicket("p", main.id)!.sessionId).toBe(main.sessionId);
  const plain = await board.createTicket("p", { title: "Plain", body: "", status: "review", mode: "auto" });
  await board.chat("p", plain.id, "one");
  await untilSpawned(3);
  await board.whenIdle();
  const s = store.getTicket("p", plain.id)!.sessionId;
  cache = cacheOf(120, 900_000);
  await board.chat("p", plain.id, "two");
  await untilSpawned(4);
  await board.whenIdle();
  expect(store.getTicket("p", plain.id)!.sessionId).toBe(s);
}, 30_000);
