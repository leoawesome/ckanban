// The board stays responsive on a big board. The daemon is one event loop: a job that goes through every ticket or
// chat in one go freezes the whole board (pages, sends, run starts) once a user has thousands of tickets, while tests
// on small boards still pass. This builds a board with BIG tickets (most of them Done, as on a real board) and measures
// the longest freeze while the daemon does each of its usual jobs. Work done in short slices freezes for about one
// slice however big the board is; work that goes through everything at once grows with the board and fails here.
// Tickets and chats are tiny, so the temp folders stay small; they are deleted afterwards.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Huddles } from "../src/server/huddle";
import { pollHuddleSessions } from "../src/server/huddle-session";
import { JobRunner } from "../src/server/jobs";
import { pollSessionsSliced, primeSessions, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { BoardBrowsers } from "../src/server/board-browsers";
import { fakes, harness } from "./fake-chrome";
import { RunLogCompressor } from "../src/server/run-log-compress";
import { resetLogCache } from "../src/server/run-log";
import { TerminalWatcher } from "../src/server/terminals";
import { ClaudeLogIndex } from "../src/server/ticket-usage";
import { tempDir } from "./helpers";

const BIG = 10_000;
const DONE_SHARE = 0.97;
/** The longest freeze allowed for one job. Sliced work stays near its ~30ms slices even on a busy machine. */
const MAX_FREEZE_MS = 250;

const L = (o: unknown) => JSON.stringify(o);
const sessionId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A chat transcript: one turn, and a long one now and then (long logs were one of the slow paths). */
function transcript(i: number): string {
  const turns = i % 2000 === 0 ? 300 : 1;
  const lines: string[] = [];
  for (let n = 0; n < turns; n++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
    lines.push(L({ type: "user", uuid: `u${i}-${n}`, timestamp: at, message: { role: "user", content: `Question ${n}` } }));
    lines.push(L({
      type: "assistant", uuid: `a${i}-${n}`, timestamp: at,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Answer ${n}` }], usage: { input_tokens: 10, output_tokens: 5 } },
    }));
  }
  return lines.join("\n") + "\n";
}

const configDir = tempDir("ck-claude-");
const projects = join(configDir, "projects", "-big-board");
mkdirSync(projects, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const store = new Store(tempDir("ck-home-"));
store.saveProfile({ name: "Big", slug: "big", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
// One open feature (ticket FEATURE_AT) with 300 Done tasks under it, as a long-running feature has.
const FEATURE_AT = BIG - 100;
const FEATURE_ID = `t_20261001_${FEATURE_AT.toString(36).padStart(4, "0")}`;
const familyLines = (i: number) =>
  i === FEATURE_AT ? "\nmain: true" : i >= 1000 && i < 1300 ? `\nparentId: ${FEATURE_ID}\ntool: true` : "";
// One ticket through the Store, then copies of its file (much faster than BIG Store writes).
const first = store.createTicket("big", { title: "Ticket 0", body: "", status: "done" });
const template = readFileSync(join(store.root, "profiles", "big", "tickets", first.id, "ticket.md"), "utf8");
for (let i = 0; i < BIG; i++) {
  const id = `t_20261001_${i.toString(36).padStart(4, "0")}`;
  const dir = join(store.root, "profiles", "big", "tickets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), template
    .replace(`id: ${first.id}`, `id: ${id}`)
    .replace("title: Ticket 0", `title: Ticket ${i}`)
    .replace("status: done", `status: ${i < BIG * DONE_SHARE ? "done" : "backlog"}`)
    .replace("sessionId: null", `sessionId: ${sessionId(i)}\nworkdir: /tmp${familyLines(i)}`));
  writeFileSync(join(projects, `${sessionId(i)}.jsonl`), transcript(i));
}
rmSync(join(store.root, "profiles", "big", "tickets", first.id), { recursive: true, force: true });

// Every ticket has result summaries (Claude comments, as on a real board), from a small vocabulary so tickets share words.
const VOCAB = "board ticket recall summary freeze daemon slice index token search chat phone layout cache run log spend inbox huddle schedule automation feature review button modal theme sync upload".split(" ");
const said = (i: number, n: number) => Array.from({ length: n }, (_, k) => VOCAB[(i * 7 + k * 13 + (k * k) % 5) % VOCAB.length]).join(" ");
for (let i = 0; i < BIG; i++) {
  const id = `t_20261001_${i.toString(36).padStart(4, "0")}`;
  const c = (n: number) => L({ id: `c${i}-${n}`, author: "ai", text: `Run ${n}: ${said(i + n, 200)}`, at: "2026-10-01T00:00:00.000Z" });
  writeFileSync(join(store.root, "profiles", "big", "tickets", id, "comments.jsonl"), `${c(1)}\n${c(2)}\n${c(3)}\n`);
}
// One ticket with a 22 MB run log (the real board has logs up to 53 MB): edits now and then, long tool output between.
const LOG_ID = "t_20261001_0000";
{
  const lines: string[] = [];
  // Tool output as Claude Code logs it: many small parts with quotes and line breaks (slow to parse, like real logs).
  const out = Array.from({ length: 30 }, (_, k) => ({ type: "text", text: `${k}: const "a" = b;\n\tcall(x, "y");\n`.repeat(3) }));
  for (let n = 0; n < 5000; n++) {
    const at = "2026-10-01T00:00:00.000Z";
    const run = 1 + Math.floor(n / 500);
    if (n % 500 === 0) lines.push(L({ run, at, event: { type: "ckanban_run", kind: n === 4500 ? "follow-up" : "run" } }));
    lines.push(n % 50 === 0
      ? L({ run, at, event: { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `/big/src/file${n}.ts` } }] } } })
      : L({ run, at, event: { type: "user", message: { content: [{ type: "tool_result", content: out }] } } }));
    if (n % 500 === 499) lines.push(L({ run, at, event: { type: "result", session_id: sessionId(0), total_cost_usd: run } }));
  }
  writeFileSync(join(store.root, "profiles", "big", "tickets", LOG_ID, "activity.jsonl"), lines.join("\n") + "\n");
}
// 2,000 huddles of about 8 KB (a big board keeps every closed one), 10 still live; one live huddle has 5,000 messages.
const HUDDLES = 2000;
const hid = (i: number) => `h_big${String(i).padStart(5, "0")}`;
{
  const dir = join(store.root, "profiles", "big", "huddles");
  mkdirSync(dir, { recursive: true });
  const brief = "Check the change and report what you find. ".repeat(170);
  for (let i = 0; i < HUDDLES; i++) {
    const live = i >= HUDDLES - 10;
    writeFileSync(join(dir, `${hid(i)}.json`), JSON.stringify({
      id: hid(i), hostTicket: `t_20261001_${i.toString(36).padStart(4, "0")}`, status: live ? "live" : "closed", maxParticipants: 6,
      participants: [], findings: [], invited: [], seq: 5, topic: `Review ${i}`, brief, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      ...(live ? {} : { closedAt: "2026-10-02T00:00:00.000Z" }),
    }, null, 2) + "\n");
  }
  const msgs: string[] = [];
  for (let n = 1; n <= 5000; n++) msgs.push(L({ seq: n, from: n % 2 ? "main" : "reviewer", kind: "message", text: `Message ${n}: ${said(n, 30)}`, mentions: ["main"], at: "2026-10-01T00:00:00.000Z" }));
  writeFileSync(join(dir, `${hid(HUDDLES - 1)}.messages.jsonl`), msgs.join("\n") + "\n");
}
// 5,000 finished one-time jobs (nothing deletes them) and 3 still to come.
{
  const dir = join(store.root, "profiles", "big", "jobs");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5003; i++) {
    const done = i < 5000;
    const at = new Date(Date.UTC(done ? 2026 : 2030, 0, 1, 0, 0, i)).toISOString();
    writeFileSync(join(dir, `j${i}.json`), JSON.stringify({
      id: `j${i}`, name: `Job ${i}`, at, state: done ? "done" : "scheduled", action: { kind: "ticket", title: `Job ${i}`, body: "Do it.", mode: "auto" },
      sourceTicketId: null, createdAt: at, updatedAt: at, firedAt: done ? at : null, result: done ? { ticketId: "t_gone" } : null,
    }, null, 2) + "\n");
  }
}
// One quiet schedule with 50,000 lines of history (about 7 MB; a schedule that fires every few minutes for a year).
const SCHEDULE = "sbig";
{
  const dir = join(store.root, "profiles", "big", "schedules");
  mkdirSync(dir, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  writeFileSync(join(dir, `${SCHEDULE}.json`), JSON.stringify({
    id: SCHEDULE, name: "Check the inbox", title: "Check the inbox", body: "Look for new mail.", mode: "auto", cron: "*/10 * * * *", enabled: true,
    skipIfRunning: true, quiet: true, createdAt: at, updatedAt: at, lastFiredAt: null, nextRunAt: "2030-01-01T00:00:00.000Z", lastError: null,
  }, null, 2) + "\n");
  const lines: string[] = [];
  const start = Date.now() - 50_000 * 10 * 60_000;
  for (let n = 0; n < 50_000; n++) {
    const when = new Date(start + n * 10 * 60_000).toISOString();
    lines.push(n % 2 === 0
      ? L({ at: when, kind: "fired", trigger: "schedule", ticketId: `t_q${n}` })
      : L({ at: when, kind: "quiet", ticketId: `t_q${n - 1}`, summary: `Nothing new in run ${n}: ${said(n, 12)}`, costUsd: 0.01 }));
  }
  writeFileSync(join(dir, `${SCHEDULE}.history.jsonl`), lines.join("\n") + "\n");
}
// One ticket whose outputs folder holds 20,000 files (a run that copied a project into it).
const OUT_ID = "t_20261001_0003";
{
  const dir = join(store.root, "profiles", "big", "tickets", OUT_ID, "outputs");
  for (let d = 0; d < 20; d++) {
    mkdirSync(join(dir, `part${d}`), { recursive: true });
    for (let f = 0; f < 1000; f++) writeFileSync(join(dir, `part${d}`, `file${f}.txt`), "x");
  }
}
// 3,000 quick chats (the Ask tab), a few hundred bytes each.
const CHATS = 3000;
{
  const dir = join(store.root, "profiles", "big", "chats");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < CHATS; i++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    writeFileSync(join(dir, `q${i}.json`), JSON.stringify({
      id: `q${i}`, sessionId: sessionId(BIG + i), title: null, firstMessage: `Question ${i}: ${said(i, 20)}`, createdAt: at, updatedAt: at,
      started: true, ticketId: null, error: null,
    }, null, 2) + "\n");
  }
}
// One Done ticket's chat with a 40 MB transcript (the real board has them up to 78 MB): opened from its card.
const BIG_CHAT_ID = "t_20261001_0007";
{
  const parts: string[] = [];
  const text = "Here is what I found in the code and what I changed. ".repeat(60);
  for (let n = 0, size = 0; size < 40 * 1024 * 1024; n++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, n % 86_400)).toISOString();
    const line = n % 2
      ? L({ type: "assistant", uuid: `ba${n}`, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `${n}: ${text}` }], usage: { input_tokens: 10, output_tokens: 5 } } })
      : L({ type: "user", uuid: `bu${n}`, timestamp: at, message: { role: "user", content: `Question ${n}` } });
    parts.push(line);
    size += line.length + 1;
  }
  writeFileSync(join(projects, `${sessionId(7)}.jsonl`), parts.join("\n") + "\n");
}
// The saved summaries of 10,000 sessions (session-summaries.json; the real file holds 2,000 in 5.8 MB).
const summaries = new SessionCache({ configDir }, Date.now, join(tempDir("ck-sum-"), "session-summaries.json"));
{
  const items: Record<string, unknown> = {};
  const s = { title: "A ticket's chat", lastMessage: { role: "assistant", text: "Done: the change is in and tested. ".repeat(60), at: "2026-10-01T00:00:00.000Z" }, artifacts: [], cache: null };
  for (let i = 0; i < BIG; i++) items[sessionId(i)] = { v: `${i}:1`, s: { ...s, title: `Chat ${i}` }, u: Math.floor(Date.now() / 86_400_000) };
  (summaries as any).summaries = { tag: "test", items };
  (summaries as any).summariesDirty = true;
}
// A fresh Store and cache, like a daemon that just started on this board: nothing read yet.
const fresh = new Store(store.root);
const bus = new Bus();
const sessions = new SessionCache({ configDir });
const board = new Board(fresh, bus, { claudeBin: "/bin/false", sessionSummary: (id) => sessions.summary(id) });
const server = createServer({ store: fresh, bus, board, sessions, port: 0, webDir: tempDir("ck-web-") });
const base = `http://127.0.0.1:${server.port}`;

// Board browsers: 6 running, each with WhatsApp and two other tabs (the tick looks inside the WhatsApp ones).
const browsers = new BoardBrowsers(store.root, () => {}, harness(store.root).deps);
for (let i = 0; i < 6; i++) {
  const b = await browsers.add(`Desk ${i}`);
  await browsers.ensure(b.id);
}
for (const f of fakes) {
  f.pages = [
    { id: "wa", type: "page", title: "WhatsApp", url: "https://web.whatsapp.com/" },
    { id: "a", type: "page", title: "Inbox", url: "https://mail.example.com/inbox" },
    { id: "b", type: "page", title: "", url: "about:blank" },
  ];
  f.answers.set("wa", "in");
}

afterAll(() => {
  server.stop(true);
  for (const f of fakes.splice(0)) if (!f.closed) f.quit();
  delete process.env.CLAUDE_CONFIG_DIR;
});

/** The longest time the event loop was stuck while `work` ran (a 5ms ticker that should fire on time). */
async function longestFreeze(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  try {
    await work();
    await Bun.sleep(20);
  } finally {
    clearInterval(timer);
  }
  return worst;
}

const page = (path: string) => async () => {
  const r = await fetch(base + path);
  expect(r.status).toBe(200);
  await r.arrayBuffer();
};

// The terminal watcher with one `claude` running (almost always true): its first poll, then a steady one 3s later.
const terminals = new TerminalWatcher(fresh, bus, sessions, async () => ["claude --resume 'Ticket 9999'"]);
// Every chat's message costs (the Usage tab's denominator), then a lookup per 5h window.
const usageIndex = new ClaudeLogIndex(join(configDir, "projects"));
const OCT = Date.UTC(2026, 9, 1);
const huddles = new Huddles(fresh, board, bus, { claudeBin: "/bin/false", sessionExists: () => false });
const jobRunner = new JobRunner(board, fresh, bus);
const LIVE_HUDDLE = hid(HUDDLES - 1);

const jobs: [string, () => Promise<unknown>][] = [
  // Opening a Done ticket's chat whose 40 MB transcript nothing has read yet: read in slices before it is shown.
  ["opening a chat with a 40 MB transcript", async () => {
    const r = await fetch(`${base}/api/profiles/big/tickets/${BIG_CHAT_ID}/conversation?limit=100`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { total: number }).total).toBeGreaterThan(10_000);
  }],
  // The board's first load on a daemon that just started (open work with families, the first Done cards): the page
  // the board really asks for first. Huddles and transcripts aren't read yet here.
  ["the board's first load", page("/api/profiles/big/tickets?scope=board&done=20")],
  ["spend", page("/api/spend")],
  ["needs you (inbox)", page("/api/inbox")],
  // The Inbox again, as every few seconds per tab while runs work: unchanged tickets reuse their attention.
  ["needs you (inbox) again", page("/api/inbox")],
  // A reload of the board: cached views and index.
  ["the board's load again", page("/api/profiles/big/tickets?scope=board&done=20")],
  // list_tickets and `ticket list`: a page of open work, a page of Done, a search; board settings' count.
  ["list_tickets' first page", page("/api/profiles/big/tickets?scope=list")],
  ["list_tickets' Done page", page("/api/profiles/big/tickets?scope=list&status=done&after=t_20261001_3000")],
  ["list_tickets' search", page("/api/profiles/big/tickets?scope=list&status=done&q=ticket%2099")],
  ["the board's ticket count", page("/api/profiles/big/tickets?scope=count")],
  // Every ticket with no scope (about 13 MB): only older clients (an old CLI or MCP server) ask for it now.
  ["the whole ticket list (older clients)", page("/api/profiles/big/tickets")],
  ["boards", page("/api/profiles")],
  // ⌘K: every board's open tickets, then a search of the Done ones (the first reads their results, later ones don't).
  ["⌘K's open tickets", page("/api/tickets?scope=open")],
  ["⌘K's first Done search", page("/api/tickets?scope=done&q=ticket%2099&board=big")],
  ["⌘K's next Done search", page("/api/tickets?scope=done&q=search%20freeze&board=big")],
  // The Ask tab: the first 50 of 3,000 chats on a cold daemon, again, then "Load older".
  ["the Ask tab's first page of 3,000 chats", page("/api/profiles/big/chats?limit=50")],
  ["the Ask tab's first page again", page("/api/profiles/big/chats?limit=50")],
  ["the Ask tab's Load older", page(`/api/profiles/big/chats?limit=50&before=${encodeURIComponent(`${new Date(Date.UTC(2026, 9, 1, 0, 0, CHATS - 51)).toISOString()}|${new Date(Date.UTC(2026, 9, 1, 0, 0, CHATS - 51)).toISOString()}|q${CHATS - 51}`)}`)],
  // The session watcher: its first pass after a start (reads every chat), then a full pass over every ticket.
  ["the session watcher's first pass", () => primeSessions(fresh, sessions, new Map())],
  ["a session watcher full pass", () => pollSessionsSliced(fresh, bus, sessions, new Map(), false)],
  // The board browsers' tick with its sign-in check, on 6 running browsers.
  ["the board browsers' tick", () => browsers.tick()],
  // Its pass every minute while the feed is live: Done tickets wait for their own pass every 10 minutes.
  ["a session watcher pass without Done tickets", () => pollSessionsSliced(fresh, bus, sessions, new Map(), false, undefined, 30, true)],
  ["the terminal watcher's first poll", () => terminals.poll()],
  ["a terminal watcher poll", () => terminals.poll()],
  // The saved summaries written whole (every 30s at most while runs make new ones): 10,000 sessions.
  ["the session summaries write with 10,000 sessions", async () => summaries.flushSummaries()],
  ["the usage index's first refresh", () => usageIndex.refresh(OCT - 3600_000)],
  ["usage cost lookups", async () => {
    for (let h = 0; h < 100; h++) usageIndex.costBetween(OCT + (h - 50) * 3600_000, OCT + (h - 45) * 3600_000);
  }],
  // "What we did before" at a run start: the first one after a start reads every ticket's summary, later ones only changes.
  ["recall at the first run start", () => recallFor("t_20261001_0001")],
  ["recall at a later run start", () => recallFor("t_20261001_0002")],
  // The changed-files count of a feature in a folder without version history: reads its tickets' run logs.
  // The user drags an open ticket to In progress (the ticket route, then its run starts and fails at once: no Claude here).
  ["move a ticket to In progress", async () => {
    const r = await fetch(`${base}/api/profiles/big/tickets/t_20261001_${(BIG - 3).toString(36).padStart(4, "0")}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "in_progress" }),
    });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    await Bun.sleep(500);
  }],
  ["the changed files of a feature with a 22 MB run log", async () => expect((await (board as any).readChanges("big", LOG_ID))?.items).toHaveLength(100)],
  // The board's first load asks for the open huddles, the Huddles window for all 2,000: on a daemon that hasn't read
  // them yet, then again.
  ["the open huddles on a cold daemon", page("/api/profiles/big/huddles?open=1")],
  ["the huddles list of 2,000 huddles", page("/api/profiles/big/huddles")],
  ["the huddles list again", page("/api/profiles/big/huddles")],
  // The Tasks tab of a feature with 300 tasks.
  ["the family view of a 300-task feature", async () => {
    const r = await fetch(`${base}/api/profiles/big/tickets/${FEATURE_ID}/family-view`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as unknown[]).length).toBe(301);
  }],
  // Huddles, jobs, schedules and automations: their first read after a start (in slices), then the steady jobs.
  ["the first read of 2,000 huddles and 5,000 jobs", () => fresh.loadAllLists()],
  ["the huddle list after a huddle save", async () => {
    const h = fresh.huddleIndex("big").find((x) => x.id === LIVE_HUDDLE)!;
    fresh.saveHuddle("big", { ...structuredClone(h), seq: h.seq + 1 });
    expect(fresh.huddleIndex("big")).toHaveLength(HUDDLES);
    expect(fresh.openHuddles("big")).toHaveLength(10);
  }],
  // A huddle's first message makes its log file next to the huddle files: the next list read doesn't stat them all.
  ["the huddle list after a huddle's first message", async () => {
    fresh.appendHuddleMessage("big", hid(HUDDLES - 2), { seq: 1, from: "main", kind: "message", text: "Hello", mentions: [], at: "2026-10-02T00:00:00.000Z" } as any);
    expect(fresh.huddleIndex("big")).toHaveLength(HUDDLES);
  }],
  // Every 5 minutes: huddle, job, schedule and automation files stat'ed again in slices, for edits from outside.
  ["the list recheck of 2,000 huddles and 5,000 jobs", () => fresh.recheckLists()],
  ["the huddle idle sweep", async () => huddles.idleSweep()],
  ["the huddle session watcher", async () => pollHuddleSessions(fresh, bus, () => null, new Map(), false)],
  ["a 5,000-message huddle log, read twice with a message between", async () => {
    // 5,000 messages, plus any the idle sweep posted.
    const had = fresh.readHuddleMessages("big", LIVE_HUDDLE).length;
    expect(had).toBeGreaterThanOrEqual(5000);
    fresh.appendHuddleMessage("big", LIVE_HUDDLE, { seq: 9999, from: "main", kind: "message", text: "One more", mentions: [], at: "2026-10-02T00:00:00.000Z" } as any);
    for (let n = 0; n < 50; n++) expect(fresh.readHuddleMessages("big", LIVE_HUDDLE)).toHaveLength(had + 1);
  }],
  ["the ticket list after 20 ticket writes", async () => {
    for (let n = 0; n < 20; n++) {
      fresh.updateTicket("big", "t_20261001_0005", { title: `Renamed ${n}`, ...(n === 10 ? { status: "review" as const } : {}) });
      expect(fresh.listTickets("big")).toHaveLength(BIG);
      fresh.listOpenTickets("big");
    }
  }],
  ["the one-time jobs list with 5,000 finished jobs", page("/api/profiles/big/jobs")],
  ["the job tick with 5,000 finished jobs", () => jobRunner.tick()],
  ["the schedules list with a 50,000-line history", page("/api/profiles/big/schedules")],
  ["a schedule's history view with 50,000 lines", page(`/api/profiles/big/schedules/${SCHEDULE}/history`)],
  ["the outputs list of a ticket with 20,000 files", async () => {
    const r = await fetch(`${base}/api/profiles/big/tickets/${OUT_ID}/outputs`);
    expect(((await r.json()) as unknown[]).length).toBe(2000);
  }],
  // Run logs of tickets Done long ago are compressed: a scan of the board, a pass, then the 22 MB log. Last: it changes the log.
  ["the run log compression job (a scan, a pass, a 22 MB log)", async () => {
    const c = new RunLogCompressor(fresh, () => false, { ageMs: 0 });
    expect(await c.scan()).toBeGreaterThan(BIG / 2);
    await c.pass();
    expect(["compressed", "not-eligible"]).toContain(await c.compress("big", LOG_ID));
    expect(existsSync(fresh.activityPath("big", LOG_ID) + ".gz")).toBe(true);
    resetLogCache();
  }],
  // Opening that ticket afterwards: its newest page, then its Usage tab (the whole log, decompressed off the event loop).
  ["opening a ticket whose 22 MB run log is compressed", page(`/api/profiles/big/tickets/${LOG_ID}/activity`)],
  ["the Usage tab of a ticket whose 22 MB run log is compressed", page(`/api/profiles/big/tickets/${LOG_ID}/usage`)],
];

async function recallFor(id: string) {
  const text: string = await (board as any).recall("big", fresh.getTicket("big", id)!);
  expect(text).toContain("What we did before");
}

for (const [name, work] of jobs) {
  test(`${name} doesn't freeze the daemon on a board with ${BIG} tickets`, async () => {
    const start = performance.now();
    const ms = await longestFreeze(work);
    console.log(`big-board: ${name}: longest freeze ${Math.round(ms)}ms (${Math.round(performance.now() - start - 20)}ms in all)`);
    expect(ms).toBeLessThan(MAX_FREEZE_MS);
  }, 60_000);
}
