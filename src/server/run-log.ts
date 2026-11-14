// A ticket's run log (activity.jsonl) as readers see it: the plain file, or, for a ticket Done long ago, its
// compressed copy (activity.jsonl.gz, made by run-log-compress.ts). Readers get the same bytes either way, with the
// same byte offsets, so pages, digests and indexes give the same answers and their caches (keyed by size) stay valid.
//
// Rules every reader and writer keeps:
// - The plain file, when it exists, is the log. A compressed copy next to it is a leftover of a step cut short (a
//   crash between writing the copy and removing the original, or between restoring and removing the copy).
// - A compressed copy alone is the log. Before anything is appended, it is restored to the plain file (restoreLog).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, rm, stat as statAsync } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { newId } from "./util";

const gunzipAsync = promisify(gunzip);

export const gzOf = (file: string) => `${file}.gz`;

/** Decompressed logs kept in memory, newest use last; past the cap the oldest go (one bigger log stays on its own). */
const MAX_BYTES = 256 * 1024 * 1024;
/** A decompressed log not read for this long is let go. */
const IDLE_MS = 5 * 60_000;

type Unzipped = { key: string; buf: Buffer; usedAt: number };
const unzipped = new Map<string, Unzipped>();
let unzippedBytes = 0;
const loading = new Map<string, Promise<Buffer | null>>();
/** Uncompressed sizes read from compressed copies' trailers, by path (bounded like a cache). */
const sizes = new Map<string, { key: string; size: number }>();
const MAX_SIZES = 20_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (s: { size: number; mtimeMs: number }) => `${s.size}:${s.mtimeMs}`;

function remember(gz: string, key: string, buf: Buffer): void {
  forget(gz);
  unzipped.set(gz, { key, buf, usedAt: Date.now() });
  unzippedBytes += buf.length;
  for (const [k, v] of unzipped) {
    if (unzippedBytes <= MAX_BYTES || unzipped.size <= 1) break;
    if (k === gz) continue;
    unzipped.delete(k);
    unzippedBytes -= v.buf.length;
  }
  if (!idleTimer) {
    idleTimer = setTimeout(dropIdle, IDLE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  }
}

function dropIdle(): void {
  idleTimer = null;
  const now = Date.now();
  for (const [k, v] of unzipped) if (now - v.usedAt >= IDLE_MS) forget(k);
  if (unzipped.size) {
    idleTimer = setTimeout(dropIdle, IDLE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  }
}

function forget(gz: string): void {
  const had = unzipped.get(gz);
  if (!had) return;
  unzipped.delete(gz);
  unzippedBytes -= had.buf.length;
}

/** When the kept decompressed copy of a log was last used (for tests); null when none is kept. */
export function keptLogUsedAt(file: string): number | null {
  return unzipped.get(gzOf(file))?.usedAt ?? null;
}

/** Lets go of what is kept for a log (after it was restored, or compressed again). */
export function forgetLog(file: string): void {
  forget(gzOf(file));
  sizes.delete(gzOf(file));
}

/** The kept copy when it is current. mark: counts as a use (keeps it from the idle drop); a look doesn't. */
function cached(gz: string, key: string, mark = true): Buffer | null {
  const c = unzipped.get(gz);
  if (!c || c.key !== key) return null;
  if (!mark) return c.buf;
  c.usedAt = Date.now();
  unzipped.delete(gz);
  unzipped.set(gz, c);
  return c.buf;
}

/** The uncompressed size from a gzip trailer (the last 4 bytes, size mod 4 GB: run logs stay far below that). */
function trailerSize(gz: string, st: { size: number; mtimeMs: number }): number {
  const key = keyOf(st);
  const c = sizes.get(gz);
  if (c?.key === key) return c.size;
  const fd = openSync(gz, "r");
  try {
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, Math.max(0, st.size - 4));
    const size = b.readUInt32LE(0);
    sizes.set(gz, { key, size });
    if (sizes.size > MAX_SIZES) sizes.delete(sizes.keys().next().value!);
    return size;
  } finally {
    closeSync(fd);
  }
}

export interface LogStat {
  /** Bytes of the log (uncompressed). */
  size: number;
  /** Last change (a compressed copy keeps the original's). */
  mtimeMs: number;
  /** The compressed copy's path when the log is compressed, else null. */
  gz: string | null;
}

/** The log's size and age, plain or compressed; null when neither exists. */
export function logStat(file: string): LogStat | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs, gz: null };
  } catch {}
  const gz = gzOf(file);
  try {
    const s = statSync(gz);
    // Only a look: today's spend stats every log every few seconds, which kept every decompressed log in memory.
    const buf = cached(gz, keyOf(s), false);
    return { size: buf ? buf.length : trailerSize(gz, s), mtimeMs: s.mtimeMs, gz };
  } catch {
    return null;
  }
}

/** The log exists, plain or compressed. */
export function logExists(file: string): boolean {
  return existsSync(file) || existsSync(gzOf(file));
}

/**
 * Decompresses a compressed log off the event loop (zlib's thread pool) and keeps it for the readers' next sync reads.
 * Nothing to do for a plain log. Readers that can wait call this first, so their reads don't decompress in place.
 */
export async function loadLog(file: string): Promise<void> {
  if (existsSync(file)) return;
  await unzipAsync(gzOf(file));
}

async function unzipAsync(gz: string): Promise<Buffer | null> {
  const busy = loading.get(gz);
  if (busy) return busy;
  const p = (async () => {
    let s;
    try {
      s = await statAsync(gz);
    } catch {
      return null;
    }
    const key = keyOf(s);
    const have = cached(gz, key);
    if (have) return have;
    let raw: Buffer;
    try {
      raw = await readFile(gz);
    } catch (e) {
      // Restored meanwhile (the copy is gone): the plain file is the log now.
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
    let buf: Buffer;
    try {
      buf = await gunzipAsync(raw);
    } catch (e) {
      if (!damaged(e)) throw e;
      setAside(gz.slice(0, -3), e);
      return null;
    }
    remember(gz, key, buf);
    return buf;
  })().finally(() => loading.delete(gz));
  loading.set(gz, p);
  return p;
}

/** The compressed log's bytes now: kept ones, else decompressed in place (a freeze of about 4 ms per MB). */
function unzipSync(gz: string): Buffer | null {
  let s;
  try {
    s = statSync(gz);
  } catch {
    return null;
  }
  const key = keyOf(s);
  const have = cached(gz, key);
  if (have) return have;
  let buf: Buffer;
  try {
    buf = gunzipSync(readFileSync(gz));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    if (!damaged(e)) throw e;
    setAside(gz.slice(0, -3), e);
    return null;
  }
  remember(gz, key, buf);
  return buf;
}

/** Positioned reads of a log, plain or compressed. */
export interface LogReader {
  size: number;
  read(buf: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

/** Opens the log for positioned reads; null when it doesn't exist. A compressed one is decompressed in place unless loadLog ran. */
export function openLog(file: string): LogReader | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
  } catch {}
  if (fd !== null) {
    const f = fd;
    return {
      size: statSync(file).size,
      read: (buf, offset, length, position) => readSync(f, buf, offset, length, position),
      close: () => closeSync(f),
    };
  }
  const bytes = unzipSync(gzOf(file));
  if (!bytes) return null;
  return {
    size: bytes.length,
    read: (buf, offset, length, position) => {
      if (position >= bytes.length) return 0;
      return bytes.copy(buf, offset, position, Math.min(bytes.length, position + length));
    },
    close: () => {},
  };
}

/** The whole log's bytes (plain or compressed), or null. For one ticket at a time: logs reach tens of MB. */
export function readLogSync(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {}
  return unzipSync(gzOf(file));
}

/** The whole log's bytes off the event loop (plain or compressed), or null. */
export async function readLog(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {}
  // Null also when the copy was restored meanwhile: then the plain file is there.
  return (await unzipAsync(gzOf(file))) ?? (await readFile(file).catch(() => null));
}

const restoring = new Map<string, Promise<void>>();

/**
 * Brings a compressed log back to the plain file, so new lines can be appended (a Done ticket reopened, or sent a
 * message). Decompressed off the event loop (zlib checks the copy's checksum), written to a temp file and synced, then
 * renamed into place and the copy removed in one step. A crash leaves the copy (and maybe a temp file), or both files
 * with the same bytes: never neither. If both are already there (an earlier step was cut short), see settleBoth.
 */
export function restoreLog(file: string): Promise<void> {
  return oneAtATime(file, async () => {
    const gz = gzOf(file);
    if (!existsSync(gz)) return;
    if (existsSync(file)) return settleNow(file);
    const bytes = await unzipOrSetAside(file, () => unzipAsync(gz));
    if (!bytes) return;
    const tmp = `${file}.tmp-${newId()}`;
    try {
      const h = await open(tmp, "wx");
      try {
        await h.writeFile(bytes);
        await h.sync();
      } finally {
        await h.close();
      }
      // Restored meanwhile by an append (restoreLogSync): that one is the log now, and the copy is gone or a leftover.
      if (existsSync(file)) {
        rmSync(tmp, { force: true });
        return existsSync(gz) ? settleNow(file) : undefined;
      }
      renameSync(tmp, file);
      rmSync(gz, { force: true });
      forgetLog(file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
}

/** Restores and joins of one log run one at a time (two at once could write the old history twice). */
function oneAtATime(file: string, fn: () => Promise<void>): Promise<void> {
  const busy = restoring.get(file);
  if (busy) return busy;
  const p = fn().finally(() => restoring.delete(file));
  restoring.set(file, p);
  return p;
}

/** zlib says the data is bad (Z_DATA_ERROR, Z_BUF_ERROR; not Z_MEM_ERROR): the copy is damaged, not the disk full or a file missing. */
const damaged = (e: unknown) => /^Z_(DATA|BUF)_ERROR$/.test(String((e as { code?: unknown })?.code ?? ""));

/**
 * The copy's bytes, or null when the copy is damaged (it doesn't decompress: changed on disk from outside). A damaged
 * copy is renamed aside (activity.jsonl.gz.unreadable-<id>, never deleted) so the ticket can run again with a fresh
 * log instead of failing at every start.
 */
async function unzipOrSetAside(file: string, unzip: () => Promise<Buffer | null> | Buffer | null): Promise<Buffer | null> {
  try {
    return await unzip();
  } catch (e) {
    if (!damaged(e)) throw e;
    setAside(file, e);
    return null;
  }
}

function setAside(file: string, e: unknown): void {
  const gz = gzOf(file);
  const aside = `${gz}.unreadable-${newId()}`;
  try {
    renameSync(gz, aside);
  } catch {
    return; // gone meanwhile (set aside or restored by another step)
  }
  forgetLog(file);
  console.error(`run log ${file}: its compressed copy doesn't decompress (${(e as Error).message}); kept as ${aside}, a new log starts`);
}

/**
 * restoreLog without waiting, for an append that finds the log compressed (the board restores before a run starts, so
 * this is a safety net). Decompresses in place: a freeze of about 4 ms per MB of log.
 */
export function restoreLogSync(file: string): void {
  const gz = gzOf(file);
  if (existsSync(file) || !existsSync(gz)) return;
  let bytes: Buffer | null;
  try {
    bytes = unzipSync(gz);
  } catch (e) {
    if (!damaged(e)) throw e;
    setAside(file, e);
    return;
  }
  if (!bytes) return;
  const tmp = `${file}.tmp-${newId()}`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    rmSync(gz, { force: true });
    forgetLog(file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Both the plain log and a compressed copy exist. If the plain file starts with exactly the copy's bytes (a step cut
 * short, maybe with lines appended since), the plain file is the log and the copy is removed. Otherwise lines were
 * appended to a fresh plain file while the log was compressed (only possible from outside this daemon): the two are
 * joined, the copy's bytes first, into the plain file, then the copy is removed. Nothing is dropped either way.
 */
export function settleBoth(file: string): Promise<void> {
  return oneAtATime(file, () => settleNow(file));
}

async function settleNow(file: string): Promise<void> {
  const gz = gzOf(file);
  if (!existsSync(gz) || !existsSync(file)) return;
  // Taken before the compare: lines appended after it make the join below stop and try again later.
  const st0 = await statAsync(file);
  const bytes = await unzipOrSetAside(file, () => unzipAsync(gz));
  if (!bytes) return;
  const s = st0;
  let same = false;
  if (s.size >= bytes.length) {
    const h = await open(file, "r");
    try {
      const head = Buffer.alloc(bytes.length);
      for (let got = 0; got < head.length;) {
        const { bytesRead } = await h.read(head, got, head.length - got, got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      same = head.equals(bytes);
    } finally {
      await h.close();
    }
  }
  // The plain file is the start of the copy (only a copy of the log cut short from outside): the copy is the log.
  let prefix = false;
  if (!same && s.size < bytes.length) {
    const plain = await readFile(file);
    prefix = plain.length === s.size && bytes.subarray(0, plain.length).equals(plain);
  }
  if (!same) {
    const tmp = `${file}.tmp-${newId()}`;
    try {
      const h = await open(tmp, "wx");
      try {
        await h.writeFile(bytes);
        if (!prefix) await h.writeFile(await readFile(file));
        await h.sync();
      } finally {
        await h.close();
      }
      const st1 = statSync(file);
      // Grew meanwhile: try again next time rather than lose the new lines.
      if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) {
        rmSync(tmp, { force: true });
        return;
      }
      renameSync(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  rmSync(gz, { force: true });
  forgetLog(file);
}

/** Exposed for tests: drops every kept decompressed log. */
export function resetLogCache(): void {
  unzipped.clear();
  unzippedBytes = 0;
  sizes.clear();
}

/** Temp files of this log's own steps (a copy being made, a restore) older than maxAgeMs: a crash leaves them. */
export async function removeStaleTemps(file: string, maxAgeMs = 10 * 60_000): Promise<void> {
  const dir = dirname(file);
  const base = basename(file);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(`${base}.tmp-`) && !n.startsWith(`${base}.gz.tmp-`)) continue;
    try {
      const p = join(dir, n);
      if (Date.now() - (await statAsync(p)).mtimeMs >= maxAgeMs) await rm(p, { force: true });
    } catch {}
  }
}
