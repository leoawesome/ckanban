// Run logs (tickets/<id>/activity.jsonl) are never trimmed and reach tens of MB each; a board's add up to GBs. A
// ticket Done for more than 30 days and not running gets its log compressed to activity.jsonl.gz, losing nothing:
// every reader handles both (run-log.ts) and the log comes back as a plain file before anything is appended.
//
// Safety: the copy is written to a temp file off the event loop (streaming gzip, zlib's thread pool), synced, then
// decompressed again and compared with the original (size and SHA-256). Only then, in one step of the event loop, it
// is checked that the original didn't change and the ticket didn't start running, the temp file is renamed to
// activity.jsonl.gz and the original removed. A crash at any point leaves the original, or the original and a verified
// copy (the original wins, see run-log.ts), never neither. A full disk fails the write and leaves the original.
//
// One daemon per data folder (the port allows only one): an append from a second process in the microseconds between
// the last check and the removal of the original would be lost. Older versions don't read compressed logs: after a
// downgrade an old ticket shows an empty log until this version runs again (its lines come back, nothing is lost).
//
// Cost: a pass works on a few tickets. Which tickets are left to look at comes from a list of the board's tickets kept
// in memory (no file reads), gone through in slices every few hours; tickets already handled are written to
// run-logs-compressed.jsonl in the board's folder, so they are skipped after a restart too.
import { appendFileSync, existsSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { pauser, track, trackedInterval } from "./lag";
import { gzOf, removeStaleTemps, settleBoth } from "./run-log";
import type { Store } from "./store";
import type { Ticket } from "./types";
import { newId } from "./util";

/** Done for longer than this before the log is compressed. */
export const COMPRESS_AFTER_MS = 30 * 86_400_000;
/** Logs compressed per pass. */
const PER_PASS = 3;
/** Smaller logs are left as they are (the disk stores a few KB either way). */
const MIN_BYTES = 8 * 1024;
const PASS_MS = 2 * 60_000;
const SCAN_MS = 6 * 3_600_000;
/** A log that failed (a full disk, a copy that didn't match) is tried again after this long. */
const RETRY_MS = 86_400_000;
export const STATE_FILE = "run-logs-compressed.jsonl";

export type CompressResult = "compressed" | "no-log" | "small" | "not-eligible" | "running" | "changed" | "failed";

export interface CompressOptions {
  ageMs?: number;
  perPass?: number;
  minBytes?: number;
  now?: () => number;
  /** Called after the copy is verified, just before the swap (tests use it to change things in between). */
  beforeSwap?: (slug: string, id: string) => void | Promise<void>;
}

/** What a ticket's handled mark is tied to: done again later, or run again, and it is looked at again. */
const handledKey = (t: Ticket) => `${t.doneAt ?? t.updatedAt}|${t.runCount ?? 0}`;

export class RunLogCompressor {
  private handled = new Map<string, Map<string, string>>();
  private failed = new Map<string, number>();
  private queue: { slug: string; id: string }[] = [];
  private queued = new Set<string>();
  private busy: Promise<unknown> | null = null;
  /** What the job saved so far (bytes of logs before and after), for the daemon log. */
  stats = { logs: 0, before: 0, after: 0 };

  constructor(private store: Store, private isRunning: (slug: string, id: string) => boolean, private o: CompressOptions = {}) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Starts the job: a first look a minute after start, then a pass every 2 minutes and a fresh look every 6 hours. */
  start(): () => void {
    if (process.env.CKANBAN_NO_LOG_COMPRESS) return () => {};
    const scan = () => this.exclusive(() => this.scan());
    const pass = () => this.exclusive(() => this.pass());
    const first = setTimeout(() => track("run-log-compress scan", scan), 60_000);
    const scans = trackedInterval("run-log-compress scan", scan, SCAN_MS);
    const passes = trackedInterval("run-log-compress pass", pass, PASS_MS);
    return () => {
      clearTimeout(first);
      clearInterval(scans);
      clearInterval(passes);
    };
  }

  /** One job step at a time: a pass doesn't start while a scan or another pass runs. */
  private exclusive(fn: () => Promise<unknown>): Promise<unknown> {
    if (this.busy) return this.busy;
    this.busy = fn().catch((e) => console.error("run-log-compress", e)).finally(() => (this.busy = null));
    return this.busy;
  }

  private stateFile(slug: string) {
    return join(this.store.root, "profiles", slug, STATE_FILE);
  }

  private async handledOf(slug: string): Promise<Map<string, string>> {
    let m = this.handled.get(slug);
    if (m) return m;
    m = new Map();
    try {
      const text = await readFile(this.stateFile(slug), "utf8");
      const pause = pauser();
      for (const line of text.split("\n")) {
        await pause();
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (typeof e?.id === "string" && typeof e.key === "string") m.set(e.id, e.key);
        } catch {}
      }
    } catch {}
    this.handled.set(slug, m);
    return m;
  }

  private markHandled(slug: string, t: Ticket): void {
    const key = handledKey(t);
    const m = this.handled.get(slug);
    if (m?.get(t.id) === key) return;
    m?.set(t.id, key);
    try {
      appendFileSync(this.stateFile(slug), JSON.stringify({ id: t.id, key }) + "\n");
    } catch {}
  }

  private eligible(t: Ticket | null): t is Ticket {
    if (!t || t.status !== "done") return false;
    const since = Date.parse(t.doneAt ?? t.updatedAt);
    return Number.isFinite(since) && this.now() - since > (this.o.ageMs ?? COMPRESS_AFTER_MS);
  }

  /**
   * Finds the tickets left to look at: Done long enough and not handled since they were last done or run. Goes over
   * the boards' ticket lists in memory (no file reads), pausing every ~30ms. Returns how many are waiting.
   */
  async scan(pause = pauser()): Promise<number> {
    for (const p of this.store.listProfiles()) {
      const handled = await this.handledOf(p.slug);
      for (const t of this.store.listTickets(p.slug)) {
        await pause();
        const k = `${p.slug}/${t.id}`;
        if (this.queued.has(k) || !this.eligible(t) || handled.get(t.id) === handledKey(t)) continue;
        if (this.now() - (this.failed.get(k) ?? -Infinity) < RETRY_MS) continue;
        this.queued.add(k);
        this.queue.push({ slug: p.slug, id: t.id });
      }
    }
    return this.queue.length;
  }

  /** Compresses up to a few logs waiting from the last scan. Returns how many it compressed. */
  async pass(): Promise<number> {
    let done = 0;
    let looked = 0;
    const pause = pauser();
    // Tickets with nothing to do (no log, a small one) don't count towards the few: they cost a stat each.
    while (this.queue.length && done < (this.o.perPass ?? PER_PASS) && looked < 200) {
      const { slug, id } = this.queue.shift()!;
      this.queued.delete(`${slug}/${id}`);
      looked++;
      if ((await this.compress(slug, id)) === "compressed") done++;
      await pause();
    }
    if (done) console.log(`run logs: compressed ${this.stats.logs} so far, ${mb(this.stats.before)} MB to ${mb(this.stats.after)} MB`);
    return done;
  }

  /** Compresses one ticket's log if it qualifies; see the top of the file for the steps. */
  async compress(slug: string, id: string): Promise<CompressResult> {
    const t = this.store.getTicket(slug, id);
    if (!this.eligible(t)) return "not-eligible";
    if (this.isRunning(slug, id)) return "running";
    await this.handledOf(slug);
    const file = this.store.activityPath(slug, id);
    const gz = gzOf(file);
    const k = `${slug}/${id}`;
    try {
      // Temp files a crash left from an earlier try at this log (each a near full-size copy).
      await removeStaleTemps(file);
      // Both there: a step cut short earlier. The plain file wins (joined with the copy if it isn't the same log).
      if (existsSync(file) && existsSync(gz)) await settleBoth(file);
      if (!existsSync(file)) {
        this.markHandled(slug, t);
        return "no-log";
      }
      const st0 = await stat(file);
      if (st0.size < (this.o.minBytes ?? MIN_BYTES)) {
        this.markHandled(slug, t);
        return "small";
      }
      const tmp = `${gz}.tmp-${newId()}`;
      try {
        const sum = createHash("sha256");
        await pipeline(
          createReadStream(file, { start: 0, end: st0.size - 1 }),
          new Transform({ transform(chunk, _e, cb) { sum.update(chunk); cb(null, chunk); } }),
          createGzip({ level: 6 }),
          createWriteStream(tmp, { flags: "wx" }),
        );
        const h = await open(tmp, "r+");
        try {
          await h.sync();
        } finally {
          await h.close();
        }
        const want = sum.digest("hex");
        // Read back: the copy must decompress to exactly the original's bytes.
        const back = createHash("sha256");
        let n = 0;
        await pipeline(createReadStream(tmp), createGunzip(), new Writable({ write(chunk, _e, cb) { back.update(chunk); n += chunk.length; cb(); } }));
        if (n !== st0.size || back.digest("hex") !== want) throw new Error(`copy of ${k} run log didn't match the original`);
        await this.o.beforeSwap?.(slug, id);
        // The swap, in one step of the event loop: no append from this daemon can come in between.
        const st1 = statSync(file);
        if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs || this.isRunning(slug, id) || !this.eligible(this.store.getTicket(slug, id)) || existsSync(gz)) {
          rmSync(tmp, { force: true });
          return "changed";
        }
        const size = statSync(tmp).size;
        utimesSync(tmp, st0.atimeMs / 1000, st0.mtimeMs / 1000);
        renameSync(tmp, gz);
        rmSync(file);
        this.store.activityCompressed(slug, id);
        this.markHandled(slug, this.store.getTicket(slug, id) ?? t);
        this.failed.delete(k);
        this.stats.logs++;
        this.stats.before += st0.size;
        this.stats.after += size;
        return "compressed";
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    } catch (e) {
      this.failed.set(k, this.now());
      console.error(`run-log-compress ${k}:`, (e as Error).message);
      return "failed";
    }
  }
}

const mb = (n: number) => Math.round(n / 1048576);
