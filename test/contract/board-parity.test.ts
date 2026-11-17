// The board answers and writes as Bun's did (docs/rust-port-board-plan.md, F1): one script of requests that crosses
// the areas (ticket writes, runs on the fake Claude with a chat follow-up, a question, a feature with a task,
// comments, schedules and one-time jobs, the reads of the board, the Inbox, a ticket's views) on a fresh data folder.
// The answers and the files it leaves, ids, times, session ids and temp paths masked, must be Bun's: recorded in
// golden/board-parity.json (golden.ts) from Bun's full mode before P4 removed it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DAEMON_CMD, type Daemon, startDaemon, until } from "./daemon";
import { Golden } from "./golden";
import { Scripts, scriptDir, settled } from "./runs";

const SLUG = "parity";
const P = `/api/profiles/${SLUG}`;
const T = `${P}/tickets`;

interface Step {
  what: string;
  status: number;
  data: unknown;
}

/** The script; each run is waited for before the next request, so both servers see the same order. */
async function script(d: Daemon, s: Scripts): Promise<Step[]> {
  const steps: Step[] = [];
  const call = async (what: string, method: string, path: string, body?: unknown) => {
    const r = await d.api(method, path, body);
    steps.push({ what, status: r.status, data: r.data });
    return r;
  };
  const wait = async (what: string, id: string, ok: (t: any) => boolean) => {
    const v = await settled(d, SLUG, id, ok);
    steps.push({ what, status: 200, data: v });
    return v;
  };

  await call("board", "POST", "/api/profiles", { name: "Parity", path: d.project });

  // A work run from Ready, then a chat message that resumes it, then Done.
  const a = (await call("create ready", "POST", T, {
    title: "Ready work", body: `Do it. ${s.set("a", [{ summary: "Wrote the file.", files: { "a.txt": "a\n" }, outputs: { "notes.md": "# Notes\n" } }, { summary: "Changed it again." }])}`, status: "ready", mode: "auto",
  })).data;
  await wait("a after its run", a.id, (v) => v.status === "review" && v.runCount === 1);
  await call("a chat", "POST", `${T}/${a.id}/chat`, { text: "One more thing please." });
  await wait("a after the chat", a.id, (v) => v.runCount === 2);
  await call("a comment", "POST", `${T}/${a.id}/comments`, { text: "Looks good." });
  await call("a done", "PATCH", `${T}/${a.id}`, { status: "done" });

  // A run that ends with questions, and one that ends blocked.
  const q = (await call("create questions", "POST", T, { title: "Asks", body: `Ask. ${s.set("q", [{ status: "questions", summary: "Which colour?" }])}`, status: "ready", mode: "auto" })).data;
  await wait("q settled", q.id, (v) => v.runCount === 1);
  const b = (await call("create blocked", "POST", T, { title: "Stuck", body: `Stuck. ${s.set("b", [{ status: "blocked", summary: "No access to the folder." }])}`, status: "ready", mode: "auto" })).data;
  await wait("b settled", b.id, (v) => v.runCount === 1);

  // A feature with one task that runs.
  const m = (await call("create main", "POST", T, { title: "Feature", body: "The goal.", status: "backlog", mode: "auto" })).data;
  // folderFiles counts the files changed in the plain folder from 1 s before the task's run: earlier runs' files stay
  // out only if they are older than that (Rust gets here sooner than Bun).
  await Bun.sleep(1500);
  const task = (await call("create task", "POST", T, { title: "Task one", body: `Part one. ${s.set("t", [{ summary: "Part one is in.", files: { "t.txt": "t\n" } }])}`, status: "ready", mode: "auto", partOf: m.id })).data;
  await wait("task settled", task.id, (v) => v.runCount === 1);
  await call("family", "GET", `${T}/${task.id}/family`);
  await call("family view", "GET", `${T}/${m.id}/family-view`);

  // Schedules and one-time jobs (no firing: the clock differs between the two runs).
  const sch = (await call("schedule", "POST", `${P}/schedules`, { name: "Daily check", cron: "0 9 * * *", title: "Check the build", body: "Look at it.", enabled: true })).data;
  await call("schedule pause", "PATCH", `${P}/schedules/${sch?.id}`, { enabled: false });
  await call("schedules", "GET", `${P}/schedules`);
  const job = (await call("job", "POST", `${P}/jobs`, { name: "Echo", at: "2099-01-02 09:30", action: { kind: "command", command: "echo hi" } })).data;
  await call("job run", "POST", `${P}/jobs/${job?.id}/run`, {});
  await until(async () => ((await d.api("GET", `${P}/jobs`)).data as any[])?.find((j) => j.id === job?.id && j.state !== "pending" && j.state !== "running") ?? null, 15_000, "job to end");
  await call("jobs", "GET", `${P}/jobs`);

  // The reads.
  for (const scope of ["board", "done", "ids", "list", "count"]) await call(`tickets ${scope}`, "GET", `${T}?scope=${scope}`);
  // The list is newest id first, and ids made the same day are random: sorted by title to compare.
  const list = steps.find((x) => x.what === "tickets list")!.data as { tickets: { title: string }[] };
  list.tickets?.sort((x, y) => x.title.localeCompare(y.title));
  await call("search", "GET", `${T}?scope=search&q=Ready`);
  await call("all tickets", "GET", "/api/tickets");
  await call("inbox", "GET", "/api/inbox");
  await call("profiles", "GET", "/api/profiles");
  for (const t of [a, q, b, m, task]) {
    await call(`view ${t.title}`, "GET", `${T}/${t.id}`);
    await call(`activity ${t.title}`, "GET", `${T}/${t.id}/activity`);
    await call(`outputs ${t.title}`, "GET", `${T}/${t.id}/outputs`);
    await call(`usage ${t.title}`, "GET", `${T}/${t.id}/usage`);
  }
  await call("conversation a", "GET", `${T}/${a.id}/conversation`);
  return steps;
}

/** The board's files after the script, by path under the data folder. */
function files(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(home, f)] = readFileSync(f, "utf8");
    }
  };
  if (existsSync(join(home, "profiles"))) walk(join(home, "profiles"));
  return out;
}

/**
 * Masks what differs between two runs of the script: ticket ids, uuids (sessions), other ids (schedules, jobs,
 * comments), times, durations, temp paths and the command the prompts give for the `ckanban` CLI (Bun's
 * `bun src/cli.ts` or the ckanban-rs binary, both the CLI). One masker per server: ids get names in the order they
 * first appear, answers first and files after, so the same object has the same name on both sides.
 */
function masker(): (text: string) => string {
  const seen = new Map<string, string>();
  const name = (kind: string) => (m: string) => {
    if (!seen.has(m)) seen.set(m, `<${kind}${seen.size}>`);
    return seen.get(m)!;
  };
  return (text) => text
    .replace(/'[^'\n]*\/bun' '[^'\n]*\/src\/cli\.ts'|'[^'\n]*\/ckanban-rs'/g, "<ckanban>")
    .replace(/t_\d{8}_[a-z0-9]{4}/g, name("ticket"))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, name("uuid"))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, (m) => (m.startsWith("2099") ? m : "<time>"))
    .replace(/(?<="(?:id|jobId|scheduleId)": ?")[0-9a-z]{8}(?=")/g, name("id"))
    .replace(/(?<=\/(?:schedules|jobs)\/)[0-9a-z]{8}(?=[./"])/g, name("id"))
    .replace(/^id: [0-9a-z]{8}$/gm, name("id"))
    .replace(/(?<=^|[{,\s])"id": ?\d{10,}/g, '"id":<n>')
    .replace(/"(durationMs|duration_ms|elapsedMs|pid)": ?\d+/g, '"$1":0')
    .replace(/\/tmp\/[^"\n\\]*|\/private\/var\/[^"\n\\]*|\/var\/folders\/[^"\n\\]*/g, "<path>")
    // Bun's linker settles each new ticket in the background; when it does is a race.
    .replace(/^parentChecked: true\n/gm, "")
    .replace(/^parentSuggestion: null\n/gm, "");
}

/** Keys sorted (key order isn't part of the API), the linker's racy marks dropped. */
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "parentChecked" && k !== "parentSuggestion").sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)])) : v;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function runOn(cmd: string[], env: Record<string, string>): Promise<{ steps: Step[]; files: Record<string, string>; log: string }> {
  const root = mkdtempSync(join(tmpdir(), "ck-board-parity-"));
  roots.push(root);
  const s = new Scripts(scriptDir(root));
  const d = await startDaemon({ cmd, env: { ...env, FAKE_SCRIPT_DIR: s.dir } });
  try {
    const steps = await script(d, s);
    return { steps, files: files(d.home), log: d.log() };
  } finally {
    await d.stop();
  }
}

describe("the board answers and writes as Bun's did", () => {
  test("one script, compared with Bun's recorded answers and files", async () => {
    const golden = new Golden("board-parity");
    const side = await runOn(DAEMON_CMD, {});
    const m = masker();
    const steps = side.steps.map((x) => ({ what: x.what, status: x.status, data: m(JSON.stringify(sorted(x.data), null, 1)) }));
    // Paths first (their ids are known from the answers), then each file's text in the order of the masked paths.
    const paths = Object.keys(side.files).map((k) => [m(k), k] as const).sort(([x], [y]) => x.localeCompare(y));
    const fs = Object.fromEntries(paths.map(([masked, k]) => [masked, m(side.files[k]!)]));
    // CKANBAN_PARITY_OUT=<dir>: this side written there (server.txt) to read the differences with `diff`.
    if (process.env.CKANBAN_PARITY_OUT) {
      mkdirSync(process.env.CKANBAN_PARITY_OUT, { recursive: true });
      writeFileSync(join(process.env.CKANBAN_PARITY_OUT, "server.txt"),
        [...steps.map((x) => `=== ${x.what} ${x.status}\n${x.data}`), ...Object.entries(fs).map(([k, v]) => `=== file ${k}\n${v}`)].join("\n"));
    }
    golden.match("steps", steps.map((x) => x.what));
    // Every step and file, so one run lists every difference.
    for (const x of steps) golden.match(`step ${x.what}`, x);
    golden.match("files", Object.keys(fs));
    for (const [k, v] of Object.entries(fs)) golden.match(`file ${k}`, v);
    golden.done();
  }, 240_000);
});
