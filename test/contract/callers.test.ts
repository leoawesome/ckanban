// Outside-in contract: the daemon tells the user from board runs by who is on the other end of the connection, and
// that holds whatever server runs (Bun alone, or `ckanban-rs dev` in front of it: `bun run test:contract:rust`). Also
// the event stream arrives as it is written and the terminal's WebSocket works. See contracts/api.md.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { readJsonl } from "./files";

let d: Daemon;
const SLUG = "callers";
// The fake Claude's "call" mode reads its calls from here and writes the answers there.
const dir = mkdtempSync(join(tmpdir(), "ck-contract-calls-"));
const calls = join(dir, "calls.json");
const out = join(dir, "call-out.jsonl");

beforeAll(async () => {
  d = await startDaemon({ fakeMode: "call", env: { FAKE_CALLS_FILE: calls, FAKE_CALL_OUT: out } });
  expect((await d.api("POST", "/api/profiles", { name: "Callers", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("a board run gets 403 on user-only routes; a program outside the board may delete a schedule", async () => {
  const s = (await d.api("POST", `/api/profiles/${SLUG}/schedules`, { name: "Keep", title: "Keep", body: "x", cron: "0 3 * * *" })).data;
  const origin = { origin: `http://127.0.0.1:${d.port}` };
  writeFileSync(calls, JSON.stringify([
    // A plain read works: the run reached the board at the port it was given.
    { method: "GET", path: "/api/profiles" },
    // Deleting a schedule without an Origin: allowed only for a program the daemon didn't start.
    { method: "DELETE", path: `/api/profiles/${SLUG}/schedules/${s.id}` },
    // A user-only action with the board's Origin: allowed only for the user's own browser.
    { method: "POST", path: `/api/profiles/${SLUG}/find-links`, headers: origin, body: {} },
    // Forged front-server headers change nothing.
    { method: "DELETE", path: `/api/profiles/${SLUG}/schedules/${s.id}`, headers: { "x-ckanban-front": "0".repeat(64), "x-ckanban-peer-port": "1" } },
  ]));
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Caller", body: "call the API" })).data;
  expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/chat`, { text: "go" })).status).toBe(202);
  const answers = await until(() => {
    try {
      const rows = readJsonl(out);
      return rows.length >= 4 ? rows : null;
    } catch {
      return null;
    }
  }, 30_000, "the run's API calls");
  // The board may start the fake Claude more than once (side calls too): every invocation makes the same calls.
  for (const a of answers) {
    if (a.method === "GET") {
      expect(a.status).toBe(200);
      continue;
    }
    expect({ path: a.path, status: a.status }).toEqual({ path: a.path, status: 403 });
    // Refused by the caller check, not by the server as a whole.
    expect(JSON.parse(a.text).error).toMatch(/user/);
  }

  // Still there; this test process is outside the board, so it may delete it.
  expect((await d.api("GET", `/api/profiles/${SLUG}/schedules`)).data.some((x: any) => x.id === s.id)).toBe(true);
  expect((await d.api("DELETE", `/api/profiles/${SLUG}/schedules/${s.id}`)).status).toBe(204);
}, 60_000);

test("behind a front server, its internal port refuses requests without the secret", async () => {
  const m = /internal port (\d+)/.exec(d.log());
  // Bun alone: there is no internal port. Another daemon command (a front server) must log one.
  if (!process.env.CKANBAN_CONTRACT_DAEMON && !m) return;
  expect(m).not.toBeNull();
  const internal = Number(m![1]);
  expect(internal).not.toBe(d.port);
  const tries: Record<string, string>[] = [{ host: `127.0.0.1:${d.port}` }, { host: `127.0.0.1:${d.port}`, "x-ckanban-front": "0".repeat(64), "x-ckanban-peer-port": "1" }];
  for (const headers of tries) {
    const r = await fetch(`http://127.0.0.1:${internal}/api/profiles`, { headers });
    expect(r.status).toBe(403);
  }
});

test("the event stream delivers each event while the stream stays open", async () => {
  const ctl = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const readUntil = async (re: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!re.test(seen)) {
      const left = end - Date.now();
      if (left <= 0) throw new Error(`no ${re} in the event stream within ${ms}ms; got: ${seen.slice(-500)}`);
      const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (!r) continue;
      if (r.done) throw new Error("the event stream ended");
      seen += dec.decode(r.value, { stream: true });
    }
  };
  await readUntil(/: connected/, 5_000);
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Streamed" })).data;
  await readUntil(new RegExp(`data: \\{[^\\n]*"${t.id}"`), 5_000);
  ctl.abort();
});

test("the terminal's WebSocket opens a shell and echoes what it runs", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/api/profiles/${SLUG}/shell?cols=80&rows=24`, {
    headers: { origin: `http://127.0.0.1:${d.port}` },
  } as any);
  ws.binaryType = "arraybuffer";
  let output = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    output += typeof e.data === "string" ? e.data : dec.decode(new Uint8Array(e.data as ArrayBuffer));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  ws.send(JSON.stringify({ type: "input", data: "echo ck-ws-$((40+2))\n" }));
  await until(() => output.includes("ck-ws-42"), 10_000, "the shell's echo");
  ws.close();

  // Without the board's Origin the upgrade is refused.
  const bad = new WebSocket(`ws://127.0.0.1:${d.port}/api/profiles/${SLUG}/shell`, { headers: { origin: "http://evil.example" } } as any);
  const opened = await new Promise<boolean>((resolve) => {
    bad.onopen = () => resolve(true);
    bad.onerror = () => resolve(false);
    bad.onclose = () => resolve(false);
  });
  expect(opened).toBe(false);
}, 30_000);
