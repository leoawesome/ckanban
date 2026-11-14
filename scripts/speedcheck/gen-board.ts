/**
 * Fills a temp data folder with a big board for the speed check (scripts/speedcheck/run.ts runs it inside the /tmp copy).
 *
 *   bun scripts/speedcheck/gen-board.ts --home <data folder> --claude <claude config folder> --folder <project folder> [--tickets 10000]
 *
 * At --tickets 10000 (the default): about 9,250 Done tickets (6 of them Done over 30 days with run logs, one 22 MB),
 * 300 Backlog, 150 Review, a feature with 300 tasks (280 Done), a ticket chat and a quick chat of 6,250 entries each,
 * two chats of 1,000, 3,000 quick chats, 2,000 closed huddles, 3,000 finished one-time jobs and a schedule with 5,000
 * lines of history. Counts that grow with the board scale with --tickets; the feature and the long chats stay fixed.
 * Writes ticket files directly (one Store call makes the template), so 10,000 tickets take seconds.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectDir } from "../../src/server/claude";
import { Store } from "../../src/server/store";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const HOME = arg("--home");
const CLAUDE = arg("--claude");
const FOLDER = arg("--folder");
if (!HOME || !CLAUDE || !FOLDER) {
  console.error("usage: gen-board.ts --home <dir> --claude <dir> --folder <dir> [--tickets N]");
  process.exit(2);
}
const TICKETS = Math.max(500, Number(arg("--tickets")) || 10_000);
const scale = TICKETS / 10_000;
const n = (x: number) => Math.max(1, Math.round(x * scale));

const SLUG = "big";
const PROJ = join(CLAUDE, "projects", encodeProjectDir(FOLDER));
mkdirSync(FOLDER, { recursive: true });
writeFileSync(join(FOLDER, "README.md"), "Speed check project folder.\n");
mkdirSync(PROJ, { recursive: true });

const store = new Store(HOME);
store.saveProfile({ name: "Big", slug: SLUG, path: FOLDER, baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() } as any);
const first = store.createTicket(SLUG, { title: "T0", body: "", status: "done" } as any);
const TD = join(HOME, "profiles", SLUG, "tickets");
const tpl = readFileSync(join(TD, first.id, "ticket.md"), "utf8");
rmSync(join(TD, first.id), { recursive: true, force: true });

const L = (o: unknown) => JSON.stringify(o);
const VOCAB = "board ticket recall summary freeze daemon slice index token search chat phone layout cache run log spend inbox huddle schedule automation feature review button modal theme sync upload".split(" ");
const said = (i: number, k: number) => Array.from({ length: k }, (_, j) => VOCAB[(i * 7 + j * 13 + (j * j) % 5) % VOCAB.length]).join(" ");
/** Ticket id suffixes: 3 base-36 characters (46,656 per prefix). */
const b36 = (i: number) => i.toString(36).padStart(3, "0");
let order = 0;

function mk(id: string, title: string, status: string, extra: Record<string, unknown> = {}, at = "2026-11-01T00:00:00.000Z") {
  const dir = join(TD, id);
  mkdirSync(dir, { recursive: true });
  let t = tpl.replace(`id: ${first.id}`, `id: ${id}`).replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`).replace(/^status: .*$/m, `status: ${status}`)
    .replace(/^order: .*$/m, `order: ${order++}`).replace(/^createdAt: .*$/m, `createdAt: ${at}`).replace(/^updatedAt: .*$/m, `updatedAt: ${at}`);
  const add: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    const re = new RegExp(`^${k}: .*$`, "m");
    const line = `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
    if (re.test(t)) t = t.replace(re, line);
    else add.push(line);
  }
  if (add.length) t = t.replace(/\n---\n/, `\n${add.join("\n")}\n---\n`);
  writeFileSync(join(dir, "ticket.md"), t);
  return dir;
}

function runLog(dir: string, runs: number, linesPerRun: number, fat: boolean) {
  const lines: string[] = [];
  const out = fat ? Array.from({ length: 30 }, (_, k) => ({ type: "text", text: `${k}: const "a" = b;\n\tcall(x, "y");\n`.repeat(3) })) : "ok";
  for (let r = 1; r <= runs; r++) {
    const at = "2026-09-01T00:00:00.000Z";
    lines.push(L({ run: r, at, event: { type: "ckanban_run", kind: r === 1 ? "run" : "follow-up" } }));
    lines.push(L({ run: r, at, event: { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5" } }));
    for (let k = 0; k < linesPerRun; k++) {
      lines.push(k % 50 === 0
        ? L({ run: r, at, event: { type: "assistant", message: { content: [{ type: "tool_use", id: `tu${r}-${k}`, name: "Edit", input: { file_path: `/x/src/file${k}.ts` } }], usage: { input_tokens: 100, output_tokens: 50 } } } })
        : L({ run: r, at, event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tu${r}-${k}`, content: out }] } } }));
    }
    lines.push(L({ run: r, at, event: { type: "result", subtype: "success", is_error: false, result: `Run ${r} finished: ${said(r, 10)}`, session_id: "s", total_cost_usd: 0.5 * r, usage: { input_tokens: 1000, output_tokens: 500 }, num_turns: 10, duration_ms: 60000 } }));
  }
  writeFileSync(join(dir, "activity.jsonl"), lines.join("\n") + "\n");
}

const BACKLOG = n(300);
const REVIEW = n(150);
// Done tickets fill the rest of --tickets (the feature and the chat tickets are 304 more), 10 minutes apart, newest
// first ("Done 0" is the newest). The 6 oldest are Done over 30 days with run logs (the daemon compresses those); the
// very oldest has a 22 MB log.
const DONE = Math.max(100, TICKETS - BACKLOG - REVIEW - 304);
for (let i = 0; i < DONE; i++) {
  const doneAt = new Date(Date.UTC(2026, 10, 13) - i * 600_000).toISOString();
  const old = i >= DONE - 6;
  const at = old ? "2026-09-01T00:00:00.000Z" : doneAt;
  const dir = mk(`t_20261001_d${b36(i)}`, `Done ${i} ${said(i, 3)}`, "done", { outcome: "done", doneAt: at, runCount: old ? 3 : 1 }, at);
  if (i === DONE - 1) runLog(dir, 10, 500, true);
  else if (old) runLog(dir, 3, 60, false);
  else if (i % 100 === 0) runLog(dir, 1, 20, false);
}
// Open tickets. None in Ready: those would start (fake) runs on their own and change what is measured.
for (let i = 0; i < BACKLOG; i++) mk(`t_20261101_b${b36(i)}`, `Backlog ${i} ${said(i, 2)}`, "backlog");
for (let i = 0; i < REVIEW; i++) mk(`t_20261101_r${b36(i)}`, `Review ${i} ${said(i + 5, 2)}`, "review", { outcome: "done", runCount: 1, lastRunAt: "2026-11-13T10:00:00.000Z" });
// A feature with 300 tasks (280 Done, 20 Backlog): the Tasks tab.
const MAIN = "t_20261101_feat";
mk(MAIN, "Big feature with 300 tasks", "review", { main: true, kind: "feature", outcome: "done", runCount: 1 });
for (let i = 0; i < 300; i++) {
  const done = i < 280;
  mk(`t_20261101_k${b36(i)}`, `Task ${i} of the big feature`, done ? "done" : "backlog",
    { tool: true, partOf: MAIN, parentId: MAIN, kind: "build", planKey: `task${i}`, ...(done ? { outcome: "done", doneAt: new Date(Date.UTC(2026, 10, 12) - i * 60_000).toISOString(), runCount: 1 } : {}) });
}

// Claude transcripts: 5 entries per round (+3 for a question form at the end).
function session(sid: string, rounds: number, ask = false) {
  const lines: string[] = [];
  let t = Date.UTC(2026, 9, 1, 8, 0);
  const at = () => new Date((t += 37_000)).toISOString();
  for (let r = 0; r < rounds; r++) {
    lines.push(L({ type: "user", uuid: `${sid}-u${r}`, sessionId: sid, cwd: FOLDER, timestamp: at(), message: { role: "user", content: `Question ${r}: can you look at **item ${r}** and tell me what changed in \`src/file${r % 40}.ts\`?` } }));
    lines.push(L({ type: "assistant", uuid: `${sid}-a${r}`, sessionId: sid, timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: `Looking at item ${r}. ${said(r, 30)}` }] } }));
    lines.push(L({ type: "assistant", uuid: `${sid}-t${r}`, sessionId: sid, timestamp: at(), message: { role: "assistant", content: [{ type: "tool_use", id: `${sid}-tu${r}`, name: "Bash", input: { command: `grep -n thing src/file${r % 40}.ts` } }] } }));
    lines.push(L({ type: "user", uuid: `${sid}-r${r}`, sessionId: sid, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${sid}-tu${r}`, content: `12: thing ${r}\n40: other thing` }] } }));
    lines.push(L({ type: "assistant", uuid: `${sid}-b${r}`, sessionId: sid, timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: `Done with item ${r}: the change is on line 12.` }] } }));
  }
  if (ask) {
    lines.push(L({ type: "user", uuid: `${sid}-uq`, sessionId: sid, cwd: FOLDER, timestamp: at(), message: { role: "user", content: "Which colour should the button be?" } }));
    lines.push(L({ type: "assistant", uuid: `${sid}-aq`, sessionId: sid, timestamp: at(), message: { role: "assistant", content: [{ type: "tool_use", id: `${sid}-q`, name: "mcp__ckanban__ask_questions", input: { questions: [{ question: "Which colour should the button be?", multiSelect: false, options: [{ label: "Blue", description: "Matches the header", recommended: true }, { label: "Green" }] }] } }] } }));
    lines.push(L({ type: "user", uuid: `${sid}-rq`, sessionId: sid, timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${sid}-q`, content: "Questions shown to the user." }] } }));
  }
  writeFileSync(join(PROJ, `${sid}.jsonl`), lines.join("\n") + "\n");
}
const S1 = "11111111-1111-4111-8111-111111111111";
session(S1, 1250, true);
mk("t_20261101_long", "Long chat ticket", "review", { sessionId: S1, worktree: FOLDER, outcome: "questions", runCount: 1, lastRunAt: "2026-11-13T10:00:00.000Z" });
for (const [k, sid] of [["c1", "44444444-4444-4444-8444-444444444441"], ["c2", "44444444-4444-4444-8444-444444444442"]]) {
  session(sid, 200);
  mk(`t_20261101_${k}aa`, `Medium chat ${k}`, "review", { sessionId: sid, worktree: FOLDER, outcome: "done", runCount: 1 });
}
const S2 = "22222222-2222-4222-8222-222222222222";
session(S2, 1250);
const chats = join(HOME, "profiles", SLUG, "chats");
mkdirSync(chats, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(chats, "clong.json"), JSON.stringify({ id: "clong", sessionId: S2, title: "Long quick chat", firstMessage: "Question 0", createdAt: now, updatedAt: now, started: true, ticketId: null, error: null }));
for (let i = 0; i < n(3000); i++) {
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  writeFileSync(join(chats, `q${i}.json`), JSON.stringify({ id: `q${i}`, sessionId: `55555555-0000-4000-8000-${String(i).padStart(12, "0")}`, title: null, firstMessage: `Question ${i}: ${said(i, 8)}`, createdAt: at, updatedAt: at, started: true, ticketId: null, error: null }));
}
// Closed huddles hosted by Done tickets.
{
  const dir = join(HOME, "profiles", SLUG, "huddles");
  mkdirSync(dir, { recursive: true });
  const brief = "Check the change and report what you find. ".repeat(40);
  for (let i = 0; i < n(2000); i++) {
    const id = `h_big${String(i).padStart(5, "0")}`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, hostTicket: `t_20261001_d${b36((i * 4) % DONE)}`, status: "closed", maxParticipants: 6,
      participants: [], findings: [], invited: [], seq: 5, topic: `Review ${i}`, brief, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), closedAt: "2026-10-02T00:00:00.000Z",
    }));
  }
}
// Finished one-time jobs + 3 far in the future; one paused schedule with 5,000 lines of history.
{
  const dir = join(HOME, "profiles", SLUG, "jobs");
  mkdirSync(dir, { recursive: true });
  const JOBS = n(3000);
  for (let i = 0; i < JOBS + 3; i++) {
    const done = i < JOBS;
    const at = new Date(Date.UTC(done ? 2026 : 2030, 0, 1, 0, 0, i)).toISOString();
    writeFileSync(join(dir, `j${i}.json`), JSON.stringify({ id: `j${i}`, name: `Job ${i}`, at, state: done ? "done" : "scheduled", action: { kind: "ticket", title: `Job ${i}`, body: "Do it.", mode: "auto" }, sourceTicketId: null, createdAt: at, updatedAt: at, firedAt: done ? at : null, result: done ? { ticketId: "t_gone" } : null }));
  }
  const sd = join(HOME, "profiles", SLUG, "schedules");
  mkdirSync(sd, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  writeFileSync(join(sd, "sbig.json"), JSON.stringify({ id: "sbig", name: "Check the inbox", title: "Check the inbox", body: "Look for new mail.", mode: "auto", cron: "0 3 * * *", enabled: false, skipIfRunning: true, quiet: true, createdAt: at, updatedAt: at, lastFiredAt: null, nextRunAt: "2030-01-01T00:00:00.000Z", lastError: null }));
  const lines: string[] = [];
  for (let k = 0; k < 5000; k++) lines.push(L({ at: new Date(Date.UTC(2026, 0, 1) + k * 3600_000).toISOString(), kind: "quiet", ticketId: `t_q${k}`, summary: `Nothing new ${k}`, costUsd: 0.01 }));
  writeFileSync(join(sd, "sbig.history.jsonl"), lines.join("\n") + "\n");
}
const total = DONE + BACKLOG + REVIEW + 301 + 3;
console.log(JSON.stringify({ tickets: total, done: DONE + 280, backlog: BACKLOG + 20, review: REVIEW + 4 }));
