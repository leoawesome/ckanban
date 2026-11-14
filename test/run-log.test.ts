// Compressing old run logs (run-log-compress.ts) loses nothing, and every reader gives the same answer on a
// compressed log (run-log.ts).
import { beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { ActivityDigests } from "../src/server/activity-digest";
import { draftReport } from "../src/server/bugreport";
import { COMPRESS_AFTER_MS, RunLogCompressor, STATE_FILE } from "../src/server/run-log-compress";
import { gzOf, keptLogUsedAt, loadLog, logStat, resetLogCache, restoreLog } from "../src/server/run-log";
import { SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import { RunLogIndex, ticketRuns } from "../src/server/ticket-usage";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const LATER = () => Date.now() + COMPRESS_AFTER_MS + 86_400_000;

/** A run log of about `kb` KB: runs, edits, results and long tool output with non-ASCII text. */
function logText(kb: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let n = 0; size < kb * 1024; n++) {
    const run = 1 + Math.floor(n / 200);
    const at = new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString();
    const line = n % 200 === 0 ? L({ run, at, event: { type: "ckanban_run", kind: "work" } })
      : n % 200 === 1 ? L({ run, at, event: { type: "system", subtype: "init", permissionMode: "bypassPermissions" } })
      : n % 50 === 0 ? L({ run, at, event: { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `/p/f${n}.ts` } }] } } })
      : n % 200 === 199 ? L({ run, at, event: { type: "result", session_id: `s${run % 3}`, total_cost_usd: run * 0.25 } })
      : L({ run, at, event: { type: "user", message: { content: [{ type: "tool_result", content: `out ${n} é漢字🙂 "q"\n\t`.repeat(1 + (n % 7)) }] } } });
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}

let store: Store;
let running: Set<string>;
const slug = "b";

function doneTicket(kb = 300): { id: string; file: string; original: Buffer<ArrayBufferLike> } {
  const t = store.createTicket(slug, { title: "Old", body: "", status: "done" });
  const file = store.activityPath(slug, t.id);
  writeFileSync(file, logText(kb));
  return { id: t.id, file, original: readFileSync(file) };
}

const compressor = (o: ConstructorParameters<typeof RunLogCompressor>[2] = {}) =>
  new RunLogCompressor(store, (s, id) => running.has(`${s}/${id}`), { now: LATER, ...o });

beforeEach(() => {
  resetLogCache();
  store = new Store(tempDir("ck-runlog-"));
  store.saveProfile({ name: "B", slug, path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  running = new Set();
});

test("round trip: the compressed copy holds exactly the original bytes, keeps its time, and replaces it", async () => {
  const { id, file, original } = doneTicket();
  const mtime = statSync(file).mtimeMs;
  expect(await compressor().compress(slug, id)).toBe("compressed");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(gzOf(file))).toBe(true);
  expect(statSync(gzOf(file)).size).toBeLessThan(original.length / 3);
  expect(Math.abs(statSync(gzOf(file)).mtimeMs - mtime)).toBeLessThan(1);
  expect(Bun.gunzipSync(readFileSync(gzOf(file)))).toEqual(new Uint8Array(original) as any);
  expect(logStat(file)).toMatchObject({ size: original.length, gz: gzOf(file) });
  // No temp files left.
  expect(readdirSync(dirname(file)).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("only tickets Done long enough, not running, with a log worth it; handled ones aren't looked at again", async () => {
  const old = doneTicket();
  const small = store.createTicket(slug, { title: "Small", body: "", status: "done" });
  writeFileSync(store.activityPath(slug, small.id), L({ run: 1, at: "x", event: {} }) + "\n");
  const open = store.createTicket(slug, { title: "Open", body: "", status: "review" });
  writeFileSync(store.activityPath(slug, open.id), logText(50));
  const busy = doneTicket();
  running.add(`${slug}/${busy.id}`);
  expect(await new RunLogCompressor(store, () => false).compress(slug, old.id)).toBe("not-eligible"); // done just now
  const c = compressor({ perPass: 10 });
  expect(await c.scan()).toBe(3);
  expect(await c.pass()).toBe(1);
  expect(existsSync(gzOf(old.file))).toBe(true);
  expect(existsSync(store.activityPath(slug, small.id))).toBe(true);
  expect(existsSync(busy.file)).toBe(true);
  // Handled ones (compressed, small) are skipped by the next scan, even after a restart; the running one isn't.
  const again = compressor();
  expect(await again.scan()).toBe(1);
  expect(readFileSync(join(store.root, "profiles", slug, STATE_FILE), "utf8").trim().split("\n")).toHaveLength(2);
});

test("a crash between the steps never loses the log", async () => {
  // 1. Cut short while writing the copy: a temp file is left, the original is untouched and still read.
  const a = doneTicket();
  writeFileSync(`${gzOf(a.file)}.tmp-abcd1234`, "half a copy");
  expect(store.readActivity(slug, a.id).length).toBeGreaterThan(100);
  expect(await compressor().compress(slug, a.id)).toBe("compressed");
  expect(Bun.gunzipSync(readFileSync(gzOf(a.file)))).toEqual(new Uint8Array(a.original) as any);

  // 2. Cut short after the copy was renamed, before the original was removed: both exist with the same bytes.
  const b = doneTicket();
  writeFileSync(gzOf(b.file), gzipSync(b.original));
  expect(Buffer.from(store.readActivityPage(slug, b.id, undefined, 1 << 30).entries.map((e) => L(e) + "\n").join(""))).toEqual(b.original as any);
  expect(await compressor().compress(slug, b.id)).toBe("compressed");
  expect(existsSync(b.file)).toBe(false);
  expect(Bun.gunzipSync(readFileSync(gzOf(b.file)))).toEqual(new Uint8Array(b.original) as any);

  // 3. Cut short while restoring, then lines appended: the plain file (longer) wins, the stale copy goes.
  const c = doneTicket();
  writeFileSync(gzOf(c.file), gzipSync(c.original));
  appendFileSync(c.file, L({ run: 99, at: "z", event: { type: "user" } }) + "\n");
  const longer = readFileSync(c.file);
  await restoreLog(c.file);
  expect(existsSync(gzOf(c.file))).toBe(false);
  expect(readFileSync(c.file)).toEqual(longer as any);

  // 4. Lines appended to a fresh plain file while the log was compressed (from outside this daemon): joined, old first.
  const d = doneTicket();
  writeFileSync(gzOf(d.file), gzipSync(d.original));
  const extra = L({ run: 99, at: "z", event: { type: "user" } }) + "\n";
  writeFileSync(d.file, extra);
  await restoreLog(d.file);
  expect(readFileSync(d.file)).toEqual(Buffer.concat([d.original, Buffer.from(extra)]) as any);
  expect(existsSync(gzOf(d.file))).toBe(false);
});

test("the original changing or a run starting while the copy is made leaves the original alone", async () => {
  const a = doneTicket();
  const line = L({ run: 50, at: "z", event: { type: "user" } }) + "\n";
  expect(await compressor({ beforeSwap: () => appendFileSync(a.file, line) }).compress(slug, a.id)).toBe("changed");
  expect(readFileSync(a.file)).toEqual(Buffer.concat([a.original, Buffer.from(line)]) as any);
  expect(existsSync(gzOf(a.file))).toBe(false);

  const b = doneTicket();
  expect(await compressor({ beforeSwap: () => void running.add(`${slug}/${b.id}`) }).compress(slug, b.id)).toBe("changed");
  expect(readFileSync(b.file)).toEqual(b.original as any);

  const c = doneTicket();
  expect(await compressor({ beforeSwap: () => void store.updateTicket(slug, c.id, { status: "in_progress" }) }).compress(slug, c.id)).toBe("changed");
  expect(readFileSync(c.file)).toEqual(c.original as any);
  for (const t of [a, b, c]) expect(readdirSync(dirname(t.file)).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("a failed write (as with a full disk) leaves the original and is tried again later", async () => {
  const a = doneTicket();
  const dir = dirname(a.file);
  chmodSync(dir, 0o555);
  try {
    expect(await compressor().compress(slug, a.id)).toBe("failed");
  } finally {
    chmodSync(dir, 0o755);
  }
  expect(readFileSync(a.file)).toEqual(a.original as any);
  expect(existsSync(gzOf(a.file))).toBe(false);
});

test("every reader gives the same result on a compressed log", async () => {
  const { id, file } = doneTicket(1500);
  writeFileSync(store.sideSpendPath(slug, id), "");
  const readAll = async (s: Store) => {
    const pages: unknown[] = [];
    let before: number | undefined;
    for (;;) {
      const p = await s.readActivityPageAsync(slug, id, before, 64 * 1024);
      pages.push(p);
      if (p.before === null) break;
      before = p.before;
    }
    const digest = await new ActivityDigests().get(file);
    const digestNow = new ActivityDigests().getNow(file);
    const spend = new SpendIndex(s);
    const spendAsync = await new SpendIndex(s).ticketAsync(slug, id);
    const entries = await new RunLogIndex().entries(file);
    const report = draftReport(s, { slug, id }).blocks.filter((b) => b.id !== "env");
    return {
      pages, sync: s.readActivityPage(slug, id), whole: s.readActivity(slug, id), digest, digestNow,
      storeDigest: await s.activityDigest(slug, id), spend: spend.ticket(slug, id), spendAsync, runs: ticketRuns(entries), report,
    };
  };
  const plain = await readAll(new Store(store.root));
  expect(plain.whole.length).toBeGreaterThan(1000);
  expect(plain.spend.costUsd).toBeGreaterThan(0);
  expect(await compressor().compress(slug, id)).toBe("compressed");
  resetLogCache();
  const zipped = await readAll(new Store(store.root));
  expect(zipped).toEqual(plain);
  // Readers that knew the log before keep their state: the same size, nothing to read again.
  const warm = new ActivityDigests();
  resetLogCache();
  expect(await warm.get(file)).toEqual(plain.digest);
});

test("a compressed ticket that gets new activity is restored first: nothing lost or reordered", async () => {
  const a = doneTicket();
  expect(await compressor().compress(slug, a.id)).toBe("compressed");
  // An append (a run started without the board's restore): the log comes back, then the line goes at its end.
  store.appendActivity(slug, a.id, 7, { type: "user", n: 1 });
  expect(existsSync(gzOf(a.file))).toBe(false);
  const after = readFileSync(a.file);
  expect(after.subarray(0, a.original.length)).toEqual(a.original as any);
  expect(JSON.parse(after.subarray(a.original.length).toString()).event).toEqual({ type: "user", n: 1 });

  // The board's path: restoreActivity before the run (off the event loop), then appends.
  const b = doneTicket();
  const fresh = new Store(store.root);
  expect(await compressor().compress(slug, b.id)).toBe("compressed");
  await fresh.restoreActivity(slug, b.id);
  expect(readFileSync(b.file)).toEqual(b.original as any);
  fresh.appendActivity(slug, b.id, 8, { type: "user" });
  expect(readFileSync(b.file).length).toBeGreaterThan(b.original.length);
  // Compressed again later (after it is Done again for long enough), the appended line is in the copy too.
  const t = store.getTicket(slug, b.id)!;
  store.updateTicket(slug, b.id, { status: "review" });
  store.updateTicket(slug, b.id, { status: "done" });
  expect(store.getTicket(slug, b.id)!.doneAt).not.toBe(t.doneAt);
  const full = readFileSync(b.file);
  expect(await compressor().compress(slug, b.id)).toBe("compressed");
  expect(Bun.gunzipSync(readFileSync(gzOf(b.file)))).toEqual(new Uint8Array(full) as any);
});


test("the Usage index read while the job swaps the log reads it again without counting anything twice", async () => {
  const { id, file, original } = doneTicket(4000);
  const clean = await new RunLogIndex().entries(file);
  const idx = new RunLogIndex();
  const p = idx.entries(file, 0);
  // Swap once the index has added entries from its first slices (the job's last step, done by hand).
  // Time-based, not a count of ticks: on a busy machine the first slice can take a while.
  for (const until = Date.now() + 20_000; Date.now() < until && !((idx as any).files.get(file)?.entries.length > 0);) await Bun.sleep(0);
  expect((idx as any).files.get(file)?.entries.length).toBeGreaterThan(0);
  writeFileSync(gzOf(file), gzipSync(original));
  rmSync(file);
  expect(await p).toEqual(clean);
  expect(await idx.entries(file)).toEqual(clean);
  expect(id).toBeTruthy();
});

test("a damaged copy is set aside (never deleted): readers see an empty log and the ticket can run again", async () => {
  const { id, file, original } = doneTicket();
  const gz = gzipSync(original);
  gz[Math.floor(gz.length / 2)] ^= 0xff;
  writeFileSync(gzOf(file), gz);
  rmSync(file);
  expect(store.readActivityPage(slug, id).entries).toEqual([]);
  const aside = readdirSync(dirname(file)).filter((f) => f.includes(".unreadable-"));
  expect(aside).toHaveLength(1);
  expect(readFileSync(join(dirname(file), aside[0]))).toEqual(gz as any);
  await store.restoreActivity(slug, id);
  store.appendActivity(slug, id, 1, { type: "user" });
  expect(store.readActivity(slug, id)).toHaveLength(1);
});

test("a plain file that is only the start of the copy gives way to the copy", async () => {
  const { file, original } = doneTicket();
  writeFileSync(gzOf(file), gzipSync(original));
  writeFileSync(file, original.subarray(0, original.indexOf(10, 1000) + 1));
  await restoreLog(file);
  expect(readFileSync(file)).toEqual(original as any);
  expect(existsSync(gzOf(file))).toBe(false);
});

test("a restore that can't write (as with a full disk) fails without touching the copy", async () => {
  const { id, file } = doneTicket();
  expect(await compressor().compress(slug, id)).toBe("compressed");
  const gz = readFileSync(gzOf(file));
  chmodSync(dirname(file), 0o555);
  try {
    await expect(store.restoreActivity(slug, id)).rejects.toThrow();
  } finally {
    chmodSync(dirname(file), 0o755);
  }
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(gzOf(file))).toEqual(gz as any);
});

test("a size look (today's spend every few seconds) doesn't keep a decompressed log in memory", async () => {
  const { id, file, original } = doneTicket();
  expect(await compressor().compress(slug, id)).toBe("compressed");
  await loadLog(file);
  const used = keptLogUsedAt(file);
  expect(used).not.toBeNull();
  await Bun.sleep(5);
  expect(logStat(file)).toMatchObject({ size: original.length, gz: gzOf(file) });
  expect(keptLogUsedAt(file)).toBe(used);
});
