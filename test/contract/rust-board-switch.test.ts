// Runs in flight when the board switches between Bun and the Rust board (docs/rust-port-board-plan.md 5.2): the
// switch is the `rust-board` file and a restart, so a run cut off by Bun's stop is resumed by the Rust board at its
// start, and the reverse. Both write the same files (ticket.md, comments.jsonl), so each takes the other's leftovers:
// a work run still In Progress resumes in its session, a chat reply cut off is continued, a message no run got to is
// answered. Runs only under `bun run test:contract:rust-board` (a ckanban-rs daemon command); other runs skip it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { running, Scripts, scriptDir, settled, view } from "./runs";

const ON = process.env.CKANBAN_RUST_BOARD === "1" && !!process.env.CKANBAN_CONTRACT_DAEMON;
const t = ON ? test : test.skip;
const WAIT = 60_000;
const SLUG = "switch";
const T = `/api/profiles/${SLUG}/tickets`;

let d: Daemon;
let s: Scripts;
let root: string;
let anchor = "";

const dir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(dir(id), "ticket.md"), "utf8")).meta;
const comments = (id: string) => readJsonl(join(dir(id), "comments.jsonl"));
/** Who owns the board now: "rust", or "bun" (also before board mode was ever on: no status file yet). */
const mode = () => {
  const f = join(d.home, "rust-board-status.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).mode : "bun";
};

beforeAll(async () => {
  if (!ON) return;
  root = mkdtempSync(join(tmpdir(), "ck-contract-switch-"));
  s = new Scripts(scriptDir(root));
  // The variable unset: the `rust-board` file decides, as on a real Mac. No file: Bun runs the whole board.
  d = await startDaemon({ env: { FAKE_SCRIPT_DIR: s.dir, CKANBAN_RUST_BOARD: "" } });
  expect((await d.api("POST", "/api/profiles", { name: "Switch", path: d.project })).status).toBe(201);
  anchor = (await d.api("POST", T, { title: "Anchor", body: "" })).data.id;
}, 60_000);

afterAll(async () => {
  await d?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
}, 30_000);

/** A work ticket (not a main ticket: partOf) that starts at once and follows script `name`. */
async function work(title: string, name: string, steps: object[]): Promise<any> {
  const r = await d.api("POST", T, { title, body: `x ${s.set(name, steps)}`, status: "ready", mode: "auto", partOf: anchor });
  expect(r.status).toBe(201);
  return r.data;
}

/** A Backlog ticket whose Planning chat follows script `name`. */
async function chatTicket(title: string, name: string, steps: object[]): Promise<any> {
  const r = await d.api("POST", T, { title, body: `x ${s.set(name, steps)}`, partOf: anchor });
  expect(r.status).toBe(201);
  return r.data;
}

/** Cuts the board off as launchd's stop does, flips the switch, and starts it again. */
async function switchTo(rust: boolean): Promise<void> {
  d.kill("SIGTERM");
  expect(await Promise.race([d.exited(), Bun.sleep(WAIT).then(() => "still running")])).toBe(0);
  if (rust) writeFileSync(join(d.home, "rust-board"), "on\n");
  else rmSync(join(d.home, "rust-board"), { force: true });
  await d.respawn();
  expect(mode()).toBe(rust ? "rust" : "bun");
}

/** One direction: a work run and a Planning reply cut off by the stop, resumed by the other side. */
async function cutAndResume(tag: string, toRust: boolean): Promise<void> {
  const never = join(s.dir, "never");
  const w = await work(`Cut work ${tag}`, `work-${tag}`, [{ waitFile: never }, { summary: `Finished on the other side (${tag}).` }]);
  const c = await chatTicket(`Cut chat ${tag}`, `chat-${tag}`, [{ waitFile: never }, { summary: "Planned." }]);
  await running(d, SLUG, w.id, WAIT);
  expect((await d.api("POST", `${T}/${c.id}/chat`, { text: "shape this" })).status).toBe(202);
  await running(d, SLUG, c.id, WAIT);
  await until(() => s.runs(`work-${tag}`).length === 1 && s.runs(`chat-${tag}`).length === 1, WAIT, "both runs started");
  const session = (await view(d, SLUG, w.id)).sessionId;

  await switchTo(toRust);
  // What the stop left was taken over: the work run resumed in its own session and ended.
  const done = await settled(d, SLUG, w.id, (x) => x.status === "review", WAIT);
  expect(done.outcome).toBe("done");
  expect(done.sessionId).toBe(session);
  expect(comments(w.id).some((x) => x.text === "Interrupted by daemon restart; resuming.")).toBe(true);
  expect(comments(w.id).some((x) => x.text === `Finished on the other side (${tag}).`)).toBe(true);
  const runs = s.runs(`work-${tag}`);
  expect(runs).toHaveLength(2);
  expect(runs[1].args[runs[1].args.indexOf("--resume") + 1]).toBe(session);
  // The Planning reply cut off is continued in the same session and mode, and the card stays in Planning.
  await until(() => s.runs(`chat-${tag}`).length === 2, WAIT, "the cut reply continued");
  const c2 = await settled(d, SLUG, c.id, () => true, WAIT);
  expect(c2.status).toBe("planning");
  expect(comments(c.id).some((x) => x.text === "Reply interrupted by daemon restart; resuming.")).toBe(true);
  expect(meta(c.id).interrupted ?? null).toBeNull();
}

t("a run cut off by Bun's stop is resumed by the Rust board, and one cut off by the Rust board's stop by Bun", async () => {
  expect(mode()).toBe("bun");
  await cutAndResume("b2r", true);
  await cutAndResume("r2b", false);
}, 400_000);
