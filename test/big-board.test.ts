// The board stays responsive on a big board. The daemon is one event loop: a job that goes through every ticket or
// chat in one go freezes the whole board (pages, sends, run starts) once a user has thousands of tickets, while tests
// on small boards still pass. This builds a board with BIG tickets (most of them Done, as on a real board) and measures
// the longest freeze while the daemon does each of its usual jobs. Work done in short slices freezes for about one
// slice however big the board is; work that goes through everything at once grows with the board and fails here.
// Tickets and chats are tiny, so the temp folders stay small; they are deleted afterwards.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { pollSessionsSliced, primeSessions, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
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
    .replace("sessionId: null", `sessionId: ${sessionId(i)}`));
  writeFileSync(join(projects, `${sessionId(i)}.jsonl`), transcript(i));
}
rmSync(join(store.root, "profiles", "big", "tickets", first.id), { recursive: true, force: true });
// A fresh Store and cache, like a daemon that just started on this board: nothing read yet.
const fresh = new Store(store.root);
const bus = new Bus();
const sessions = new SessionCache({ configDir });
const board = new Board(fresh, bus, { claudeBin: "/bin/false", sessionSummary: (id) => sessions.summary(id) });
const server = createServer({ store: fresh, bus, board, sessions, port: 0, webDir: tempDir("ck-web-") });
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
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

const jobs: [string, () => Promise<unknown>][] = [
  ["the ticket list", page("/api/profiles/big/tickets")],
  ["spend", page("/api/spend")],
  ["needs you (inbox)", page("/api/inbox")],
  ["boards", page("/api/profiles")],
  // The session watcher: its first pass after a start (reads every chat), then a full pass over every ticket.
  ["the session watcher's first pass", () => primeSessions(fresh, sessions, new Map())],
  ["a session watcher full pass", () => pollSessionsSliced(fresh, bus, sessions, new Map(), false)],
];

for (const [name, work] of jobs) {
  test(`${name} doesn't freeze the daemon on a board with ${BIG} tickets`, async () => {
    const ms = await longestFreeze(work);
    console.log(`big-board: ${name}: longest freeze ${Math.round(ms)}ms`);
    expect(ms).toBeLessThan(MAX_FREEZE_MS);
  }, 60_000);
}
