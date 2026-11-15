// Rust trial: what the Rust front adds per request. Bun alone vs ckanban-rs on an empty temp board, 5 starts each,
// 500 sequential calls of /api/awake and /api/profiles per start, plus the memory of each process.
//   bun scripts/rust-trial-overhead.ts
// Needs /tmp/ckanban-rust-trial/code (made by scripts/rust-trial-bench.ts) and ckanban-rs copied to /tmp/ckanban-rs-bench/
// (CKANBAN_TRIAL_RS overrides it). Both servers run the /tmp copy of the code (CKANBAN_REPO), never this checkout.
import { mkdirSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
const CODE = "/tmp/ckanban-rust-trial/code";
const RS = process.env.CKANBAN_TRIAL_RS ?? "/tmp/ckanban-rs-bench/ckanban-rs";
const BUN = process.execPath;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const freePort = () => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p; };
const rss = async (pid: number) => Number((await new Response(Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)]).stdout).text()).trim()) / 1024;
const kids = async (pid: number) => (await new Response(Bun.spawn(["pgrep", "-P", String(pid)]).stdout).text()).trim().split("\n").filter(Boolean).map(Number);
async function round(kind: "bun" | "rust", i: number) {
  const d = `/tmp/ckanban-rust-trial/oh-${kind}-${i}`; rmSync(d, { recursive: true, force: true });
  for (const s of ["home", "user", "claude", "project"]) mkdirSync(join(d, s), { recursive: true });
  const port = freePort(); let rp = freePort(); while (rp === port) rp = freePort();
  const env = { PATH: `/tmp/ckanban-rust-trial/bin:${BUN.replace(/\/bun$/, "")}:/usr/bin:/bin`, HOME: join(d, "user"), CKANBAN_HOME: join(d, "home"), CLAUDE_CONFIG_DIR: join(d, "claude"),
    CKANBAN_CLAUDE_BIN: "/usr/bin/false", CKANBAN_OSASCRIPT_BIN: "/usr/bin/true", CKANBAN_OPEN_BIN: "/usr/bin/true", CKANBAN_PORT: String(port), CKANBAN_REMOTE_PORT: String(rp),
    CKANBAN_USAGE_URL: "http://127.0.0.1:9/none", CKANBAN_NO_KEYCHAIN: "1", CKANBAN_REPO: CODE, TMPDIR: "/tmp", LANG: "en_US.UTF-8" };
  const cmd = kind === "bun" ? [BUN, `${CODE}/src/cli.ts`, "dev"] : [RS, "dev"];
  const fd = openSync(join(d, "log"), "a");
  const p = Bun.spawn(cmd, { cwd: join(d, "project"), env, stdout: fd, stderr: fd, stdin: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let t = 0; t < 600; t++) { try { if ((await fetch(url + "/api/awake")).ok) break; } catch {} await Bun.sleep(50); }
  await Bun.sleep(3000);
  const out: Record<string, number> = {};
  for (const path of ["/api/awake", "/api/profiles"]) {
    for (let w = 0; w < 50; w++) await (await fetch(url + path)).arrayBuffer();
    const xs: number[] = [];
    for (let n = 0; n < 500; n++) { const t0 = performance.now(); await (await fetch(url + path)).arrayBuffer(); xs.push(performance.now() - t0); }
    out[`${path} p50`] = med(xs); out[`${path} p95`] = pct(xs, 0.95);
  }
  out["rss self MB"] = await rss(p.pid);
  if (kind === "rust") { let c = 0; for (const k of await kids(p.pid)) c += await rss(k); out["rss child MB"] = c; }
  p.kill("SIGTERM"); await p.exited; rmSync(d, { recursive: true, force: true });
  return out;
}
const res: Record<string, Record<string, number[]>> = { bun: {}, rust: {} };
for (let i = 0; i < 5; i++) for (const k of ["bun", "rust"] as const) {
  const r = await round(k, i);
  for (const [m, v] of Object.entries(r)) (res[k][m] ??= []).push(v);
  console.log(k, i, JSON.stringify(r, (_, v) => typeof v === "number" ? Math.round(v * 1000) / 1000 : v));
}
for (const k of ["bun", "rust"] as const) for (const [m, v] of Object.entries(res[k])) console.log(`${k} ${m} median ${med(v).toFixed(3)}`);
