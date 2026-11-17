/**
 * Rust board dry run (docs/rust-port-board-plan.md, F1): the Rust board and Bun, each started on the same copy of the
 * real data folder, must show the same pages, write the same files at start-up and decide the same deletes.
 *
 *   bun scripts/rust-board-dryrun.ts prepare           copy the data folder and transcripts to /tmp, made safe (below)
 *   bun scripts/rust-board-dryrun.ts run bun           Bun in full mode on a fresh copy; results in <root>/out/bun
 *   bun scripts/rust-board-dryrun.ts run rust          ckanban-rs in board mode (background deletes report-only)
 *   bun scripts/rust-board-dryrun.ts run rust-delete   the same with CKANBAN_RUST_DELETE=1
 *   bun scripts/rust-board-dryrun.ts compare bun rust  the differences, grouped by route and file
 *   bun scripts/rust-board-dryrun.ts run rust --serve   a fresh copy with the server left running, to look at by hand
 *   bun scripts/rust-board-dryrun.ts clean             removes <root> (the copy holds private data)
 *
 * Options: --root <dir> (default /private/tmp/ckanban-f1), --data <dir> (default ~/.claude-kanban), --settle <s>
 * (how long the server runs before the pages are read, default 150), --server <ckanban-rs path>.
 *
 * The copy never reaches anything real. Every "/Users/<you>" path in the data folder's text files is rewritten to
 * <root>/live/home, the boards' folders are git clones there (objects shared read-only with the real repo, no
 * remote, only the top-level files checked out) with each real ticket copy re-created as a worktree, and HOME,
 * CLAUDE_CONFIG_DIR (a copy of ~/.claude/projects) and CKANBAN_HOME all point inside <root>. Phone access is off,
 * push endpoints, the webhook and Telegram point at a closed local port, saved keys are dummies, board browsers'
 * running Chromes are dropped and Chrome, claude (the fake), gh, tailscale, open, osascript and caffeinate are stubs.
 * Automation check scripts are replaced by one that finds nothing. Each run starts from a fresh APFS clone of the
 * prepared copy (`cp -cp`, file times kept), so every server sees the same files.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const REPO = resolve(import.meta.dir, "..");
const ROOT = opt("--root") ?? "/private/tmp/ckanban-f1";
const REAL_DATA = opt("--data") ?? join(homedir(), ".claude-kanban");
const REAL_HOME = homedir();
const LIVE = join(ROOT, "live");
const MASTER = join(ROOT, "master");
const HOME = join(LIVE, "home");
const DATA = join(HOME, ".claude-kanban");
const CLAUDE = join(HOME, ".claude");
const BIN = join(ROOT, "bin");
const OUT = join(ROOT, "out");
const SETTLE_S = Number(opt("--settle") ?? 150);
const RS = opt("--server") ?? join(REPO, "rust", "target", "release", "ckanban-rs");
const DEAD = "http://127.0.0.1:9";
const BUN = process.execPath;

function sh(cmd: string[], cwd = ROOT, ok = true): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (ok && r.exitCode !== 0) throw new Error(`${cmd.join(" ")} (in ${cwd}): ${r.stderr.toString()}${r.stdout.toString()}`);
  return r.stdout.toString();
}

/** Every file under `dir` (relative paths); symlinks are listed, not followed. */
function walk(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(d, n);
      const rel = relative(dir, f);
      if (skip(rel)) continue;
      const st = lstatSync(f);
      if (st.isDirectory()) go(f);
      else out.push(rel);
    }
  };
  go(dir);
  return out;
}

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f: string, v: unknown) => writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
/** Claude's project folder name for a path: every character that isn't a letter or digit becomes "-". */
const claudeDirName = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------------------------------------------------------- prepare

function prepare(): void {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  console.log(`copying ${REAL_DATA} (APFS clones; browsers' Chrome profiles only as empty folders)`);
  mkdirSync(DATA);
  for (const n of readdirSync(REAL_DATA)) {
    if (n === "browsers") continue;
    sh(["cp", "-cpR", join(REAL_DATA, n), join(DATA, n)]);
  }
  // Board browsers' Chrome profiles: the folders only (what the browser jobs look at), not their 1.4 GB.
  if (existsSync(join(REAL_DATA, "browsers"))) {
    for (const n of readdirSync(join(REAL_DATA, "browsers"))) {
      mkdirSync(join(DATA, "browsers", n, "Default"), { recursive: true });
      writeFileSync(join(DATA, "browsers", n, "Default", "Preferences"), "{}\n");
    }
  }

  console.log("rewriting paths in the data folder's text files");
  let rewritten = 0;
  const from = Buffer.from(REAL_HOME + "/");
  for (const rel of walk(DATA)) {
    const f = join(DATA, rel);
    if (lstatSync(f).isSymbolicLink()) continue;
    const buf = readFileSync(f);
    if (buf.indexOf(from) < 0) continue;
    const st = lstatSync(f);
    writeFileSync(f, buf.toString("utf8").replaceAll(REAL_HOME + "/", HOME + "/"));
    // Same times as the real file: caches keyed on size and mtime (session summaries, spend) see what they would.
    utimesSync(f, st.atime, st.mtime);
    rewritten++;
  }
  console.log(`  ${rewritten} files rewritten`);

  console.log("making the copy safe");
  const f = (n: string) => join(DATA, n);
  if (existsSync(f("remote.json"))) writeJson(f("remote.json"), { ...json(f("remote.json")), enabled: false });
  if (existsSync(f("push.json"))) {
    const p = json(f("push.json"));
    p.devices = (p.devices ?? []).map((d: any) => ({ ...d, endpoint: `${DEAD}/push/${d.id}` }));
    writeJson(f("push.json"), p);
  }
  if (existsSync(f("notify.json"))) {
    const n = json(f("notify.json"));
    if (n.webhookUrl) n.webhookUrl = `${DEAD}/hook`;
    if (n.telegram?.token) n.telegram.token = "0:dummy";
    writeJson(f("notify.json"), n);
  }
  if (existsSync(f("automation-passes.json"))) {
    const p = json(f("automation-passes.json"));
    for (const x of p.passes ?? []) {
      for (const k of Object.keys(x)) if (/secret|token|refresh|access/i.test(k) && typeof x[k] === "string") x[k] = `dummy-${x.id}-${k}`;
    }
    writeJson(f("automation-passes.json"), p);
  }
  if (existsSync(f("board-browsers.json"))) writeJson(f("board-browsers.json"), { ...json(f("board-browsers.json")), running: {} });
  // Automation check scripts: one that finds nothing, with its hash, so the checks run without reaching any service.
  for (const rel of walk(join(DATA, "profiles")).filter((r) => /\/loops\/[^/]+\.sh$/.test(r))) {
    const script = "#!/bin/sh\necho '[]'\n";
    writeFileSync(join(DATA, "profiles", rel), script);
    const def = join(DATA, "profiles", rel.replace(/\.sh$/, ".json"));
    if (existsSync(def)) writeJson(def, { ...json(def), scriptHash: createHash("sha256").update(script).digest("hex") });
  }

  console.log("copying transcripts (~/.claude/projects) with the folder names moved to the copy's paths");
  mkdirSync(join(CLAUDE, "projects"), { recursive: true });
  const realProjects = join(REAL_HOME, ".claude", "projects");
  const fromName = claudeDirName(REAL_HOME + "/");
  const toName = claudeDirName(HOME + "/");
  for (const n of existsSync(realProjects) ? readdirSync(realProjects) : []) {
    sh(["cp", "-cpR", join(realProjects, n), join(CLAUDE, "projects", n.startsWith(fromName) ? toName + n.slice(fromName.length) : n)]);
  }

  console.log("the boards' folders");
  for (const slug of readdirSync(join(DATA, "profiles"))) {
    const pf = join(DATA, "profiles", slug, "profile.json");
    if (!existsSync(pf)) continue;
    const copy: string = json(pf).path;
    if (!copy?.startsWith(HOME + "/") || existsSync(copy)) continue;
    const real = REAL_HOME + copy.slice(HOME.length);
    // macOS asks the user before a program reads Desktop, Documents or Downloads (and the read hangs until they
    // answer): boards there get an empty folder instead.
    if (/^(Desktop|Documents|Downloads)(\/|$)/.test(relative(REAL_HOME, real))) {
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, "README.md"), "Stand-in for a folder the dry run doesn't read.\n");
      console.log(`  ${slug}: in a protected folder; an empty stand-in`);
      continue;
    }
    if (!existsSync(real)) {
      console.log(`  ${slug}: ${real} is missing; left missing`);
      continue;
    }
    mkdirSync(dirname(copy), { recursive: true });
    if (!existsSync(join(real, ".git"))) {
      sh(["cp", "-cpR", real, copy]);
      console.log(`  ${slug}: plain folder copied`);
      continue;
    }
    // Shared objects (read only), every local branch, no remote, only the top-level files checked out.
    sh(["git", "clone", "-q", "--shared", "--no-checkout", real, copy]);
    sh(["git", "fetch", "-q", "--update-head-ok", real, "+refs/heads/*:refs/heads/*"], copy);
    sh(["git", "remote", "remove", "origin"], copy);
    sh(["git", "sparse-checkout", "set", "--cone"], copy);
    const head = sh(["git", "symbolic-ref", "-q", "--short", "HEAD"], real, false).trim();
    sh(["git", "checkout", "-q", head || "HEAD"], copy);
    // The real ticket copies, re-created as worktrees of the clone (top-level files only, like the clone); every
    // third one gets an untracked file, so the sweep sees copies with changes too.
    let n = 0;
    const list = sh(["git", "worktree", "list", "--porcelain"], real).split("\n\n");
    for (const block of list) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || !path.includes("/.ckanban-worktrees/") || !existsSync(path)) continue;
      const target = HOME + path.slice(REAL_HOME.length);
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      const sha = /^HEAD (\w+)$/m.exec(block)?.[1];
      mkdirSync(dirname(target), { recursive: true });
      const r = Bun.spawnSync(["git", "worktree", "add", "-q", ...(branch ? [target, branch] : ["--detach", target, sha ?? "HEAD"])], { cwd: copy, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) continue;
      if (++n % 3 === 0) writeFileSync(join(target, "dryrun-untracked.txt"), "left by the dry run\n");
    }
    console.log(`  ${slug}: git clone, ${n} ticket copies`);
  }

  console.log("stand-in commands");
  mkdirSync(BIN, { recursive: true });
  const stubs: Record<string, string> = {
    osascript: "#!/bin/sh\nexit 0\n", caffeinate: "#!/bin/sh\nexit 0\n", open: "#!/bin/sh\nexit 0\n", tailscale: "#!/bin/sh\nexit 1\n",
    "terminal-notifier": "#!/bin/sh\nexit 0\n", security: "#!/bin/sh\nexit 44\n", tmux: "#!/bin/sh\nexit 1\n",
    gh: "#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n",
    "google-chrome": `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(ROOT, "chrome-starts.log"))}\nexit 1\n`,
    claude: `#!/bin/sh\nexec "${BUN}" "${join(REPO, "test", "fixtures", "fake-claude.ts")}" "$@"\n`,
  };
  for (const [n, text] of Object.entries(stubs)) {
    writeFileSync(join(BIN, n), text);
    chmodSync(join(BIN, n), 0o755);
  }

  console.log("saving the template (APFS clone)");
  sh(["cp", "-cpR", LIVE, MASTER]);
  console.log(`ready: ${MASTER}`);
}

// ---------------------------------------------------------------------------------------------------------------- run

interface Stat {
  size: number;
  mtimeMs: number;
}

/** Size and mtime of every file of the live copy (the data folder, the boards' folders, the transcripts). */
function snapshot(base: string): Map<string, Stat> {
  const m = new Map<string, Stat>();
  for (const rel of walk(base, (r) => r.endsWith("/.git/objects") || r.includes("/node_modules"))) {
    try {
      const st = lstatSync(join(base, rel));
      m.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return m;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

async function run(name: string): Promise<void> {
  if (!existsSync(MASTER)) throw new Error("run `prepare` first");
  const out = join(OUT, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  rmSync(LIVE, { recursive: true, force: true });
  sh(["cp", "-cpR", MASTER, LIVE]);
  const before = snapshot(LIVE);

  const port = await freePort();
  let remotePort = await freePort();
  while (remotePort === port) remotePort = await freePort();
  const rust = name.startsWith("rust");
  const env: Record<string, string> = {
    PATH: `${BIN}:${dirname(BUN)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME, CKANBAN_HOME: DATA, CLAUDE_CONFIG_DIR: CLAUDE, CKANBAN_PORT: String(port), CKANBAN_REMOTE_PORT: String(remotePort),
    CKANBAN_CLAUDE_BIN: join(BIN, "claude"), CKANBAN_CHROME_BIN: join(BIN, "google-chrome"), CKANBAN_OSASCRIPT_BIN: join(BIN, "osascript"),
    CKANBAN_OPEN_BIN: join(BIN, "open"), CKANBAN_TAILSCALE: "/usr/bin/false", CKANBAN_USAGE_URL: `${DEAD}/api/oauth/usage`, CKANBAN_NO_KEYCHAIN: "1",
    CKANBAN_TELEGRAM_URL: DEAD, CKANBAN_RELEASES_URL: `${DEAD}/releases`, FAKE_MODE: "ok", FAKE_ARGS_FILE: join(out, "claude-args.jsonl"),
    TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    CKANBAN_RUST_BOARD: rust ? "1" : "0",
    ...(rust ? { CKANBAN_BUN: BUN, CKANBAN_REPO: REPO } : {}),
    ...(name === "rust-delete" ? { CKANBAN_RUST_DELETE: "1" } : {}),
  };
  const cmd = rust ? [RS, "dev"] : [BUN, join(REPO, "src", "cli.ts"), "dev"];
  const log = Bun.file(join(out, "server.log"));
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { cwd: HOME, env, stdout: log, stderr: Bun.file(join(out, "server.err.log")), stdin: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  let firstMs = 0;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${name} exited with ${proc.exitCode}; see ${out}/server*.log`);
    try {
      if ((await fetch(`${url}/api/profiles`)).ok) break;
    } catch {}
    if (performance.now() - t0 > 180_000) throw new Error(`${name} didn't answer in 3 minutes`);
    await Bun.sleep(50);
  }
  firstMs = performance.now() - t0;
  if (args.includes("--serve")) {
    // Left running on the fresh copy to look at by hand (stop it with Ctrl-C or a kill).
    writeFileSync(join(out, "url.txt"), url + "\n");
    console.log(`${name}: serving the copy on ${url} (logs in ${out})`);
    process.on("SIGTERM", () => proc.kill("SIGTERM"));
    process.on("SIGINT", () => proc.kill("SIGTERM"));
    await proc.exited;
    return;
  }
  console.log(`${name}: answering after ${Math.round(firstMs)} ms; running ${SETTLE_S} s before reading the pages`);
  // Longest wait for a cheap answer while the start-up jobs run.
  let worst = 0;
  const until = performance.now() + SETTLE_S * 1000;
  while (performance.now() < until) {
    const s = performance.now();
    try {
      await fetch(`${url}/api/awake`);
    } catch {}
    worst = Math.max(worst, performance.now() - s);
    await Bun.sleep(100);
  }

  const answers: { path: string; status: number; body: string }[] = [];
  const get = async (path: string) => {
    const r = await fetch(url + path);
    const body = await r.text();
    answers.push({ path, status: r.status, body });
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  };
  const crawlStart = performance.now();
  const profiles: any[] = (await get("/api/profiles")) ?? [];
  for (const p of ["/api/tickets", "/api/inbox", "/api/usage", "/api/spend", "/api/devices", "/api/browsers", "/api/board-browsers", "/api/passes",
    "/api/huddle-presets", "/api/snippets", "/api/health", "/api/claude/defaults", "/api/notify", "/api/messages", "/api/helper"]) await get(p);
  for (const prof of profiles) {
    const P = `/api/profiles/${encodeURIComponent(prof.slug)}`;
    const T = `${P}/tickets`;
    for (const sub of ["", "/chats", "/sessions", "/squads", "/huddles", "/huddle-notes", "/huddle-presets", "/huddle-templates", "/jobs", "/schedules",
      "/loops", "/learned", "/learned?count=1", "/commands", "/detect-setup"]) {
      const v = await get(P + sub);
      if (Array.isArray(v) && ["/huddles", "/jobs", "/schedules", "/loops", "/chats"].includes(sub)) {
        for (const x of v) if (x?.id) await get(`${P}${sub}/${encodeURIComponent(x.id)}`);
      }
    }
    for (const scope of ["board", "count"]) await get(`${T}?scope=${scope}`);
    for (let after: string | null = null, n = 0; n < 200; n++) {
      const page = await get(`${T}?scope=list&limit=200${after ? `&after=${after}` : ""}`);
      if (!page?.next) break;
      after = page.next;
    }
    for (let offset = 0, n = 0; n < 200; n++, offset += 50) {
      const page = await get(`${T}?scope=done&offset=${offset}&limit=50`);
      if (!page?.tickets?.length || page.tickets.length < 50) break;
    }
    // Every ticket from the files, done ones too: its view and the tabs the ticket window opens.
    const ids = readdirSync(join(DATA, "profiles", prof.slug, "tickets")).filter((x) => /^t_\d{8}_\w{4}$/.test(x)).sort();
    for (const id of ids) {
      const v = await get(`${T}/${id}`);
      for (const sub of ["/comments", "/activity", "/conversation", "/outputs", "/usage", "/status"]) await get(`${T}/${id}${sub}`);
      if (v?.main) await get(`${T}/${id}/family-view`);
      if (v?.status !== "done") for (const sub of ["/diff", "/context", "/simplified", "/rewind-undo?files=0"]) await get(`${T}/${id}${sub}`);
    }
  }
  const crawlMs = performance.now() - crawlStart;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(20_000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  await proc.exited;

  // What the run wrote and removed, against the template.
  const after = snapshot(LIVE);
  const changes: { file: string; kind: string; text?: string }[] = [];
  for (const [rel, st] of after) {
    const b = before.get(rel);
    if (b && b.size === st.size && b.mtimeMs === st.mtimeMs) continue;
    const kind = b ? "changed" : "added";
    let text: string | undefined;
    if (st.size < 2_000_000 && !rel.includes("/.git/")) {
      const now = readFileSync(join(LIVE, rel), "utf8");
      const old = b && b.size < 4_000_000 ? readFileSync(join(MASTER, rel), "utf8") : "";
      text = old && now.startsWith(old) ? `[appended]\n${now.slice(old.length)}` : now;
    }
    changes.push({ file: rel, kind, text });
  }
  const removed = [...before.keys()].filter((k) => !after.has(k));
  writeFileSync(join(out, "answers.jsonl"), answers.map((a) => JSON.stringify(a)).join("\n") + "\n");
  writeFileSync(join(out, "changes.jsonl"), changes.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(out, "removed.txt"), removed.sort().join("\n") + "\n");
  const dry = join(DATA, "rust-board-dryrun.log");
  if (existsSync(dry)) writeFileSync(join(out, "rust-board-dryrun.log"), readFileSync(dry));
  writeFileSync(join(out, "daemon.log"), existsSync(join(DATA, "daemon.log")) ? readFileSync(join(DATA, "daemon.log"), "utf8").slice(readFileSync(join(MASTER, "home", ".claude-kanban", "daemon.log"), "utf8").length) : "");
  const summary = { name, firstAnswerMs: Math.round(firstMs), longestWaitWhileStartingMs: Math.round(worst), crawlMs: Math.round(crawlMs), requests: answers.length, non200: answers.filter((a) => a.status !== 200).length, changed: changes.length, removed: removed.length };
  writeJson(join(out, "summary.json"), summary);
  console.log(JSON.stringify(summary));
}

// ---------------------------------------------------------------------------------------------------------------- compare

/** Times, durations, the ids of comments made during the run and random suggestions masked; numbers to 9 digits. */
function masked(text: string): string {
  return text
    // Transcripts keep their real paths (only the data folder's files are rewritten): a summary read again from a
    // transcript names the real home folder where one from the copied cache names the copy's.
    .replaceAll(REAL_HOME + "/", HOME + "/")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/(?<=[:,[]|: )-?\d+\.\d{10,}/g, (m) => String(Number(Number(m).toPrecision(9))))
    .replace(/"id": ?"[0-9a-z]{8}"/g, '"id":"<id>"')
    .replace(/"ntfyTopicSuggestion": ?"[^"]*"/g, '"ntfyTopicSuggestion":""')
    .replace(/"(durationMs|ms|pid|port|elapsedMs|ageMs|uptimeMs|uptime)": ?\d+(\.\d+)?/g, '"$1":0');
}

function compare(a: string, b: string): void {
  const read = (n: string) => readFileSync(join(OUT, n, "answers.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { path: string; status: number; body: string });
  const [x, y] = [read(a), read(b)];
  const by = new Map(y.map((r) => [r.path, r]));
  const groups = new Map<string, string[]>();
  const route = (p: string) => p.replace(/t_\d{8}_\w{4}/g, ":id").replace(/\/(huddles|jobs|schedules|loops|chats)\/[^/?]+/, "/$1/:id").replace(/profiles\/[^/]+/, "profiles/:slug").replace(/(after|offset)=[^&]*/, "$1=*");
  let same = 0;
  for (const r of x) {
    const o = by.get(r.path);
    const key = route(r.path);
    if (!o) {
      groups.set(key, [...(groups.get(key) ?? []), `${r.path}: only in ${a}`]);
      continue;
    }
    if (r.status === o.status && masked(r.body) === masked(o.body)) {
      same++;
      continue;
    }
    let what = `${r.path}: ${a} ${r.status}, ${b} ${o.status}`;
    try {
      const [p, q] = [JSON.parse(masked(r.body)), JSON.parse(masked(o.body))];
      what += `: ${fieldDiffs(p, q).slice(0, 6).join("; ")}`;
    } catch {
      what += `: ${r.body.slice(0, 120)} | ${o.body.slice(0, 120)}`;
    }
    groups.set(key, [...(groups.get(key) ?? []), what]);
  }
  console.log(`answers: ${same} of ${x.length} the same`);
  for (const [k, v] of [...groups].sort((p, q) => q[1].length - p[1].length)) {
    console.log(`\n## ${k} (${v.length})`);
    for (const line of v.slice(0, 5)) console.log(`  ${line.slice(0, 600)}`);
  }

  // Start-up writes: which files each server added or changed, and whether the masked text is the same.
  const changes = (n: string) => new Map(readFileSync(join(OUT, n, "changes.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { file: string; kind: string; text?: string }).map((c) => [c.file, c] as const));
  const [ca, cb] = [changes(a), changes(b)];
  const kind = (f: string) => f.replace(/t_\d{8}_\w{4}/g, ":id").replace(/\/[0-9a-z]{8}(\.[a-z.]+)$/, "/:x$1");
  const fileGroups = new Map<string, string[]>();
  const note = (f: string, what: string) => fileGroups.set(kind(f), [...(fileGroups.get(kind(f)) ?? []), `${f}: ${what}`]);
  let sameFiles = 0;
  for (const f of new Set([...ca.keys(), ...cb.keys()])) {
    const [p, q] = [ca.get(f), cb.get(f)];
    if (!p || !q) note(f, `${p ? `${p.kind} by ${a} only` : `${q!.kind} by ${b} only`}`);
    else if (masked(p.text ?? "") !== masked(q.text ?? "")) note(f, `${a} ${p.kind} ${(p.text ?? "").slice(0, 200).replace(/\n/g, "⏎")} | ${b} ${q.kind} ${(q.text ?? "").slice(0, 200).replace(/\n/g, "⏎")}`);
    else sameFiles++;
  }
  console.log(`\nstart-up writes: ${sameFiles} files written the same by both`);
  for (const [k, v] of [...fileGroups].sort((p, q) => q[1].length - p[1].length)) {
    console.log(`\n## file ${k} (${v.length})`);
    for (const line of v.slice(0, 4)) console.log(`  ${line.slice(0, 500)}`);
  }

  // Deletes: the files each removed (Bun's own decisions), and the Rust board's report-only list.
  const removed = (n: string) => new Set(readFileSync(join(OUT, n, "removed.txt"), "utf8").split("\n").filter(Boolean));
  const [ra, rb] = [removed(a), removed(b)];
  const top = (s: Set<string>) => [...new Set([...s].map((f) => f.split("/").slice(0, 7).join("/")))];
  console.log(`\nremoved: ${a} ${ra.size} files, ${b} ${rb.size} files`);
  console.log(`  only ${a}: ${top(new Set([...ra].filter((f) => !rb.has(f)))).slice(0, 30).join("\n    ")}`);
  console.log(`  only ${b}: ${top(new Set([...rb].filter((f) => !ra.has(f)))).slice(0, 30).join("\n    ")}`);
  for (const n of [a, b]) {
    const f = join(OUT, n, "rust-board-dryrun.log");
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const jobs = new Map<string, number>();
    for (const l of lines) jobs.set(l.job, (jobs.get(l.job) ?? 0) + 1);
    console.log(`\n${n}: report-only deletes ${JSON.stringify(Object.fromEntries(jobs))}`);
  }
}

/** Paths of the fields that differ, `path: a | b` (short). */
function fieldDiffs(p: unknown, q: unknown, at = ""): string[] {
  if (JSON.stringify(p) === JSON.stringify(q)) return [];
  if (p && q && typeof p === "object" && typeof q === "object" && Array.isArray(p) === Array.isArray(q)) {
    if (Array.isArray(p) && Array.isArray(q) && p.length !== q.length) return [`${at}: ${p.length} items | ${(q as unknown[]).length} items`];
    const keys = new Set([...Object.keys(p as object), ...Object.keys(q as object)]);
    return [...keys].flatMap((k) => fieldDiffs((p as any)[k], (q as any)[k], `${at}.${k}`));
  }
  return [`${at}: ${JSON.stringify(p)?.slice(0, 80)} | ${JSON.stringify(q)?.slice(0, 80)}`];
}

const [cmd, ...rest] = args.filter((x, i) => !x.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (cmd === "prepare") prepare();
else if (cmd === "run" && rest[0]) await run(rest[0]);
else if (cmd === "compare" && rest[0] && rest[1]) compare(rest[0], rest[1]);
else if (cmd === "clean") rmSync(ROOT, { recursive: true, force: true });
else {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
  process.exit(cmd ? 1 : 0);
}
