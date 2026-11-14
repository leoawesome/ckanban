// What the daemon needs from a ticket's run log (activity.jsonl), kept per file and brought up to date by reading only
// the bytes appended since last time (like SpendIndex.logSteps). Run logs reach tens of MB on a real board, so reading
// them whole (to count changed files, a follow-up's cost, a session's previous total) froze the daemon.
import { pauser } from "./lag";
import { loadLog, logStat, openLog } from "./run-log";
import type { ActivityEntry } from "./types";

/** Bytes read between pauses: a first read of a 50 MB log goes in slices. */
const CHUNK = 1 << 20;
/** Logs kept in memory; a log pushed out is read again (in slices) next time it's asked for. */
const MAX_FILES = 500;
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const EDIT_RE = /"name":"(Edit|Write|NotebookEdit)"/;
const HEAD_RE = /^\{"run":(-?\d+)/;

export interface ActivityDigest {
  /** Bytes read so far (up to the last whole line). */
  offset: number;
  /** Files the run's Edit/Write/NotebookEdit tool calls named, first seen first. */
  edited: Set<string>;
  /**
   * The entries ticketRuns() looks at, trimmed to the fields it reads: run markers, inits, results and the first event
   * of each new run number. ticketRuns(runEntries) equals ticketRuns(the whole log).
   */
  runEntries: ActivityEntry[];
  /** Per session: its last two running totals from result lines, older first. */
  sessionTotals: Map<string, number[]>;
  lastRun: number | null;
}

const fresh = (): ActivityDigest => ({ offset: 0, edited: new Set(), runEntries: [], sessionTotals: new Map(), lastRun: null });

function slimEvent(ev: any): any {
  if (ev.type === "ckanban_run") return { type: ev.type, kind: ev.kind };
  if (ev.type === "system") return { type: ev.type, subtype: ev.subtype, permissionMode: ev.permissionMode };
  if (ev.type === "result") return { type: ev.type, session_id: ev.session_id, total_cost_usd: ev.total_cost_usd, modelUsage: ev.modelUsage, usage: ev.usage };
  return { type: ev.type };
}

function addLine(d: ActivityDigest, line: string): void {
  if (!line) return;
  const head = HEAD_RE.exec(line);
  const run = head ? Number(head[1]) : null;
  const marker = line.includes('"ckanban_run"');
  const init = line.includes('"init"');
  const result = line.includes('"total_cost_usd"');
  const edit = line.includes('"tool_use"') && EDIT_RE.test(line);
  // Most lines (tool output, text, stream events) need no parsing at all.
  if (run !== null && run === d.lastRun && !marker && !init && !result && !edit) return;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const ev = e?.event;
  if (!ev || typeof ev !== "object") return;
  if (edit && ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) if (b?.type === "tool_use" && EDIT_TOOLS.has(b.name) && typeof b.input?.file_path === "string") d.edited.add(b.input.file_path);
  }
  const isInit = ev.type === "system" && ev.subtype === "init";
  if (ev.type === "ckanban_run" || isInit || ev.type === "result" || e.run !== d.lastRun) {
    d.runEntries.push({ run: e.run, at: e.at, event: slimEvent(ev) });
    d.lastRun = e.run;
  }
  if (ev.type === "result") {
    const sid = String(ev.session_id ?? "");
    const t = d.sessionTotals.get(sid) ?? [];
    t.push(Number(ev.total_cost_usd) || 0);
    d.sessionTotals.set(sid, t.slice(-2));
  }
}

export class ActivityDigests {
  private files = new Map<string, ActivityDigest>();

  /** The digest of `file`, read in slices (pausing between them) as far as it has been written. */
  async get(file: string, pause: () => Promise<void> = pauser()): Promise<ActivityDigest> {
    // A compressed log (run-log.ts) with something left to read is decompressed off the event loop first.
    const st = logStat(file);
    if (st?.gz && st.size > (this.files.get(file)?.offset ?? 0)) await loadLog(file);
    const g = this.steps(file);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      await pause();
    }
  }

  /** The same without pausing: reads whatever was appended since the last call in one go (one run's worth, once warm). */
  getNow(file: string): ActivityDigest {
    const g = this.steps(file);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
    }
  }

  /** Steps that bring the digest up to date; yields between chunks. */
  *steps(file: string): Generator<void, ActivityDigest> {
    const st = logStat(file);
    if (!st) {
      this.files.delete(file);
      return fresh();
    }
    let size = st.size;
    let d = this.files.get(file);
    // Rewritten or replaced (a deleted and re-made ticket): start over.
    if (!d || size < d.offset) d = fresh();
    // Most recently used last, so the oldest is pushed out first.
    this.files.delete(file);
    this.files.set(file, d);
    if (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value!);
    if (size <= d.offset) return d;
    const log = openLog(file);
    if (!log) return d;
    size = Math.min(size, log.size);
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - d.offset));
      // Bytes after the last whole line: decoded with the next chunk, so a character split between chunks stays whole.
      let carry: Buffer = Buffer.alloc(0);
      let pos = d.offset;
      while (pos < size) {
        const n = log.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const all = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const cut = all.lastIndexOf(10);
        // A line still being written stays for the next read.
        if (cut < 0) {
          carry = Buffer.from(all);
          continue;
        }
        for (const line of all.toString("utf8", 0, cut).split("\n")) addLine(d, line);
        carry = Buffer.from(all.subarray(cut + 1));
        d.offset = pos - carry.length;
        if (pos < size) {
          const at = d.offset;
          yield;
          // Read on by another caller meanwhile: what is left is read already (or the digest was replaced).
          if (d.offset !== at || this.files.get(file) !== d) return d;
        }
      }
    } finally {
      log.close();
    }
    return d;
  }
}
