/**
 * Daemon speed bench. Builds the HTTP server (no watchers, no recovery, no worktree sweep) on a large generated data
 * set, times the endpoints a board page load hits and one session-watcher pass, and fails when one is over budget.
 *
 *   bun scripts/bench.ts                 generated data (default scale), with budgets
 *   bun scripts/bench.ts --scale 2       twice as many boards, tickets and transcripts
 *   bun scripts/bench.ts --real          the real ~/.claude-kanban and ~/.claude/projects, read-only, no budgets
 *   bun scripts/bench.ts --real --no-summaries   same, starting with no saved session summaries
 *   bun --cpu-prof-md --cpu-prof-dir=/tmp/prof scripts/bench.ts    with a CPU profile
 *
 * "first" is the very first load (no saved session summaries), "restart" a new server on the same data with the
 * summaries saved by the first one (what a daemon restart sees), "warm" the median of 5 more loads.
 * Never starts a daemon: nothing is swept, recovered or run. The data is only read: the store refuses every write
 * (the bench fails if anything tried one) and the session summaries file is copied to a temp folder. Port 7811 by default (7799 is the phone access port).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { startLagMonitor } from "../src/server/lag";
import { pollSessions, primeSessions, SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Status } from "../src/server/types";

const args = process.argv.slice(2);
const real = args.includes("--real");
const scale = Number(args[args.indexOf("--scale") + 1]) || 1;
const port = Number(args[args.indexOf("--port") + 1]) || 7811;
const keep = args.includes("--keep");
/** Open board tabs (SSE connections) during the watcher passes: every event is sent, and built, once per tab. */
const tabs = args.includes("--tabs") ? Number(args[args.indexOf("--tabs") + 1]) : 3;

/** Budgets in ms for generated data at scale 1 (generous: a busy Mac must not fail them; a regression of 2x+ should). The first request of a fresh server also warms it up. */
const BUDGETS: Record<string, { first: number; restart: number; warm: number }> = {
  "GET /api/health": { first: 200, restart: 50, warm: 20 },
  "GET /api/profiles": { first: 200, restart: 100, warm: 50 },
  "GET /api/profiles/:board/tickets": { first: 4000, restart: 600, warm: 300 },
  "GET /api/tickets": { first: 4000, restart: 1000, warm: 500 },
  "GET /api/inbox": { first: 4000, restart: 1000, warm: 500 },
  "GET /api/profiles/:board/tickets/:id": { first: 500, restart: 300, warm: 100 },
  "GET /api/profiles/:board/tickets/:id/conversation": { first: 1500, restart: 1500, warm: 300 },
  "GET /api/profiles/:board/tickets/:id/activity": { first: 2000, restart: 2000, warm: 1000 },
  "session watcher pass": { first: 4000, restart: 600, warm: 150 },
};

const rand = (() => {
  let s = 42;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
})();
const words = "the board runs tickets through claude sessions and lists what changed in plain words for the user".split(" ");
const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(" ");
const uuid = () => crypto.randomUUID();

/** One transcript in Claude Code's JSONL shape: user turns, assistant text and tool calls with results. */
function transcript(sessionId: string, turns: number, cwd: string): string {
  const lines: string[] = [];
  let parent: string | null = null;
  let at = Date.parse("2026-10-01T00:00:00Z");
  const push = (o: Record<string, unknown>) => {
    const id = uuid();
    at += 1000;
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, uuid: id, timestamp: new Date(at).toISOString(), sessionId, cwd, ...o }));
    parent = id;
  };
  push({ type: "user", message: { role: "user", content: `# Ticket: bench\n\n${text(400)}` } });
  for (let i = 0; i < turns; i++) {
    const tool = uuid();
    push({
      type: "assistant",
      message: {
        id: uuid(), role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: text(60) }, { type: "tool_use", id: tool, name: "Bash", input: { command: `grep -n foo src/${i}.ts`, description: "Search" } }],
        usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500 },
      },
    });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: text(300) }] } });
  }
  push({ type: "assistant", message: { id: uuid(), role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Done.\nCKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"${text(20)}"}` }], usage: { input_tokens: 10, output_tokens: 50 } } });
  return lines.join("\n") + "\n";
}

function generate(root: string): { kanbanRoot: string; claudeDir: string } {
  const kanbanRoot = join(root, "kanban");
  const claudeDir = join(root, "claude");
  const projects = join(claudeDir, "projects");
  // Many project folders, most of them not the board's: the session index scans them all.
  for (let i = 0; i < 1000 * scale; i++) mkdirSync(join(projects, `-Users-bench-other-${i}`), { recursive: true });
  const store = new Store(kanbanRoot);
  const statuses: Status[] = ["backlog", "planning", "ready", "in_progress", "review", "done", "done", "done", "done"];
  let sessions = 0;
  for (let b = 0; b < 5 * scale; b++) {
    const slug = `bench${b}`;
    const path = join(root, "boards", slug);
    mkdirSync(path, { recursive: true });
    store.saveProfile({ name: slug, slug, path, baseBranch: "main", maxParallel: 3, createdAt: new Date(2026, 8, b + 1).toISOString(), setupDetected: { at: "2026-10-01T00:00:00Z", copyFiles: [], setupCommand: "", setupFrom: [] } } as any);
    const proj = join(projects, path.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(proj, { recursive: true });
    for (let i = 0; i < 150; i++) {
      const status = statuses[Math.floor(rand() * statuses.length)];
      const t = store.createTicket(slug, { title: `Bench ticket ${b}-${i}: ${text(6)}`, body: `## Goal\n${text(150)}\n\n## Acceptance criteria\n- ${text(30)}`, status });
      const ran = status !== "backlog" || rand() < 0.2;
      const sessionId = ran ? uuid() : null;
      if (sessionId) {
        // Most transcripts are a few hundred KB, a few are several MB.
        const turns = rand() < 0.05 ? 1500 : 40 + Math.floor(rand() * 200);
        writeFileSync(join(proj, `${sessionId}.jsonl`), transcript(sessionId, turns, path));
        sessions++;
      }
      // A few tickets whose transcript is gone (the case that used to stat every project folder).
      const lost = ran && rand() < 0.05 ? uuid() : null;
      store.updateTicket(slug, t.id, { sessionId: lost ?? sessionId, runCount: ran ? 1 + Math.floor(rand() * 4) : 0, lastRunAt: ran ? "2026-10-02T00:00:00Z" : null });
      const big = rand() < 0.03;
      const activity: string[] = [];
      for (let k = 0, n = ran ? (big ? 40000 : 200 + Math.floor(rand() * 800)) : 0; k < n; k++) {
        activity.push(JSON.stringify({ run: 1, at: "2026-10-02T00:00:00Z", event: { type: "assistant", message: { content: [{ type: "text", text: text(40) }] } } }));
      }
      if (activity.length) writeFileSync(store.activityPath(slug, t.id), activity.join("\n") + "\n");
      for (let k = 0; k < (ran ? 3 : 0); k++) store.addComment(slug, t.id, k % 2 ? "ai" : "user", text(80));
    }
  }
  console.log(`generated ${5 * scale} boards, ${750 * scale} tickets, ${sessions} transcripts, ${1000 * scale} other project folders in ${root}`);
  return { kanbanRoot, claudeDir };
}

/** Every attempted write to the data, for the report (the bench must only read). */
const writes: string[] = [];
const WRITE = /^(save|update|create|delete|add|append|write|copy|move|set|remove|rename|clear|mark)/;

/** The store with every write method refused: the bench reads the data (real or generated) and never changes it. */
function readOnly(store: Store): Store {
  return new Proxy(store, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== "function" || typeof key !== "string" || !WRITE.test(key)) return typeof v === "function" ? v.bind(target) : v;
      return (...a: unknown[]) => {
        writes.push(`${key}(${a.slice(0, 2).map((x) => JSON.stringify(x)).join(", ")})`);
        throw new Error(`bench store is read-only: ${key}`);
      };
    },
  });
}

type Row = { name: string; first: number; restart: number; warm: number };

async function timeGet(base: string, path: string): Promise<number> {
  const t0 = performance.now();
  const r = await fetch(base + path);
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return performance.now() - t0;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "ck-bench-"));
  const { kanbanRoot, claudeDir } = real
    ? { kanbanRoot: join(homedir(), ".claude-kanban"), claudeDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") }
    : generate(tmp);
  const summaryFile = join(tmp, "session-summaries.json");
  if (real && existsSync(join(kanbanRoot, "session-summaries.json"))) copyFileSync(join(kanbanRoot, "session-summaries.json"), summaryFile);

  // The board with the most tickets, and its ticket with the biggest transcript, stand for "a board" and "a ticket".
  const probe = new Store(kanbanRoot);
  const probeSessions = new SessionCache({ configDir: claudeDir });
  const boards = probe.listProfiles().map((p) => ({ p, tickets: probe.listTickets(p.slug) })).sort((a, b) => b.tickets.length - a.tickets.length);
  const board = boards[0];
  if (!board) throw new Error(`no boards in ${kanbanRoot}`);
  const ticket = board.tickets.filter((t) => t.sessionId && probeSessions.file(t.sessionId))
    .map((t) => ({ t, size: Bun.file(probeSessions.file(t.sessionId!)!).size }))
    .sort((a, b) => b.size - a.size)[0]?.t ?? board.tickets[0];
  const busiest = board.tickets.map((t) => ({ t, size: Bun.file(probe.activityPath(board.p.slug, t.id)).size }))
    .sort((a, b) => b.size - a.size)[0]?.t ?? ticket;
  const slug = encodeURIComponent(board.p.slug);
  const id = encodeURIComponent(ticket.id);
  const actId = encodeURIComponent(busiest.id);
  const endpoints: [string, string][] = [
    ["GET /api/health", "/api/health"],
    ["GET /api/profiles", "/api/profiles"],
    ["GET /api/profiles/:board/tickets", `/api/profiles/${slug}/tickets`],
    ["GET /api/tickets", "/api/tickets"],
    ["GET /api/inbox", "/api/inbox"],
    ["GET /api/profiles/:board/tickets/:id", `/api/profiles/${slug}/tickets/${id}`],
    ["GET /api/profiles/:board/tickets/:id/conversation", `/api/profiles/${slug}/tickets/${id}/conversation`],
    ["GET /api/profiles/:board/tickets/:id/activity", `/api/profiles/${slug}/tickets/${actId}/activity`],
  ];
  console.log(`${tabs} board tabs open; board ${board.p.slug} (${board.tickets.length} tickets), ticket ${ticket.id} (biggest transcript), ${busiest.id} (biggest activity log)${real ? " [real data, read-only]" : ""}`);

  const rows = new Map<string, Row>();
  const note = (name: string, phase: "first" | "restart" | "warm", ms: number) => {
    const r = rows.get(name) ?? { name, first: 0, restart: 0, warm: 0 };
    r[phase] = ms;
    rows.set(name, r);
  };

  const live: string[] = [];
  /** One server "life": a fresh Store and SessionCache, like a daemon start. */
  const life = async (phase: "first" | "restart", warm: boolean) => {
    const store = readOnly(new Store(kanbanRoot));
    const bus = new Bus();
    const sessions = new SessionCache({ configDir: claudeDir }, Date.now, summaryFile);
    const b = new Board(store, bus, { claudeBin: "/bin/false", sessionSummary: (sid) => sessions.summary(sid) });
    // This board only answers page loads: it must never start a run or move a plan. Its first folder check calls
    // dispatch(), which on 2026-11-01 started a Ready ticket of the real board with /bin/false. A shutting-down
    // board starts nothing, and start() throws in case another path reaches it.
    Object.assign(b, { shuttingDown: true, start: () => { throw new Error("bench board must not start runs"); } });
    const server = createServer({ store, bus, board: b, port, webDir: join(tmp, "web"), sessions });
    const base = `http://127.0.0.1:${server.port}`;
    const streams = new AbortController();
    try {
      for (let i = 0; i < tabs; i++) {
        const r = await fetch(`${base}/api/events`, { signal: streams.signal });
        void r.body?.pipeTo(new WritableStream()).catch(() => {});
      }
      const state = new Map<string, string>();
      // The daemon's watcher: its first pass after a start only takes stock (older code ignores the flag and
      // announces every session to every open tab), later passes announce changes.
      const watch = (emit = true) => {
        const t0 = performance.now();
        (pollSessions as (...a: unknown[]) => void)(store, bus, sessions, state, emit);
        return performance.now() - t0;
      };
      // The daemon's first pass (primeSessions): reads in slices, so its time is spread out, not one block.
      const t0 = performance.now();
      await primeSessions(store, sessions, state);
      note("session watcher pass", phase, performance.now() - t0);
      for (const [name, path] of endpoints) note(name, phase, await timeGet(base, path));
      if (warm) {
        const runs = new Map<string, number[]>();
        for (let i = 0; i < 5; i++) {
          // A ticket file changes between passes in real life; here the watcher just re-checks.
          runs.set("session watcher pass", [...(runs.get("session watcher pass") ?? []), watch()]);
          for (const [name, path] of endpoints) runs.set(name, [...(runs.get(name) ?? []), await timeGet(base, path)]);
        }
        for (const [name, ms] of runs) note(name, "warm", ms.sort((a, c) => a - c)[2]);
      }
      // What a running daemon holds after these loads (garbage collected first).
      Bun.gc(true);
      const m = process.memoryUsage();
      live.push(`${phase}: rss ${Math.round(m.rss / 1048576)}MB heap ${Math.round(m.heapUsed / 1048576)}MB`);
    } finally {
      streams.abort();
      sessions.flushSummaries();
      server.stop(true);
    }
  };

  // The daemon's lag monitor: one [lag] line per synchronous step over 200ms (what the daemon logs), naming its cause.
  const lags: string[] = [];
  let worst = 0;
  const stopLag = startLagMonitor({ thresholdMs: 50, log: (line) => lags.push(line) });
  const lagOf = (line: string) => Number(/blocked (\d+)ms/.exec(line)?.[1] ?? 0);
  const phaseLags = (phase: string, from: number) => {
    for (const l of lags.slice(from)) {
      worst = Math.max(worst, lagOf(l));
      if (lagOf(l) > 200) console.log(`${phase}: ${l}`);
    }
    return lags.length;
  };
  // Real data: the summaries copy already holds what the daemon saved, so "first" is really a restart too, unless
  // --no-summaries drops the copy (as after a change to the code that makes them).
  if (args.includes("--no-summaries")) rmSync(summaryFile, { force: true });
  await life("first", true);
  let seen = phaseLags("first", 0);
  await life("restart", false);
  seen = phaseLags("restart", seen);
  stopLag();

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => `${Math.round(n)}`.padStart(8);
  const fails: string[] = [];
  console.log(`\n${pad("", 50)}${"first".padStart(8)}${"restart".padStart(8)}${"warm".padStart(8)}   (ms)`);
  for (const r of rows.values()) {
    const b = BUDGETS[r.name];
    const over = !real && b ? (["first", "restart", "warm"] as const).filter((k) => r[k] > b[k] * scale) : [];
    for (const k of over) fails.push(`${r.name} ${k} ${Math.round(r[k])}ms > ${b![k] * scale}ms`);
    console.log(`${pad(r.name, 50)}${num(r.first)}${num(r.restart)}${num(r.warm)}${over.length ? "   OVER: " + over.join(",") : ""}`);
  }
  console.log(`\nlongest event-loop block: ${worst ? `${worst}ms` : "under 50ms"} (${lags.filter((l) => lagOf(l) > 200).length} over 200ms)`);
  const mem = process.memoryUsage();
  console.log(`\nlive server after its loads (garbage collected), ${live.join(", ")}; at the end: rss ${Math.round(mem.rss / 1048576)}MB heap ${Math.round(mem.heapUsed / 1048576)}MB`);
  if (!keep) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
  if (writes.length) fails.push(`tried to change the data ${writes.length} time(s), refused: ${[...new Set(writes)].slice(0, 5).join("; ")}`);
  if (fails.length) {
    console.error(`\nover budget:\n  ${fails.join("\n  ")}`);
    process.exit(1);
  }
  if (!real) console.log("\nall within budget");
  process.exit(0);
}

await main();
