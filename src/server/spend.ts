import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dayKey } from "./limit";
import { pauser } from "./lag";
import { readSideSpend } from "./side-call";
import { helperSpendFile } from "./helper/runner";
import { atomicWrite, type Store } from "./store";
import { loadLog, logStat, openLog } from "./run-log";

// Dollars spent, at a glance: each ticket's API-equivalent cost (the same sum as its Usage tab, see ticketRuns) and
// what all boards spent today. Tickets are read from their activity logs, incrementally, plus their side calls'
// ledger (side-call.ts); huddle agents have no ticket log, so their result lines add to a small per-day ledger
// (spend-days.json).

const CHUNK = 1024 * 1024;
/** Days the huddle ledger keeps. */
const KEEP_DAYS = 60;

export interface TicketSpend {
  costUsd: number;
  /** Cost by local day (YYYY-MM-DD) of the result line that reported it. */
  days: Map<string, number>;
}

interface FileState extends TicketSpend {
  offset: number;
  /** Last running total per session (result lines carry the session's total, kept across --resume). */
  totals: Map<string, number>;
}

export interface TodaySpend {
  day: string;
  costUsd: number;
  boards: { slug: string; name: string; costUsd: number }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export class SpendIndex {
  private files = new Map<string, FileState>();
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /** A ticket's cost so far: its runs and its side calls. */
  ticket(slug: string, id: string): TicketSpend {
    return drain(this.ticketSteps(slug, id));
  }

  /**
   * ticket() for a caller that can wait: a compressed log (run-log.ts) not counted yet is decompressed off the event
   * loop first and read in slices, so the sync ticket() after it only reads what is new.
   */
  async ticketAsync(slug: string, id: string, pause: () => Promise<void> = pauser()): Promise<TicketSpend> {
    const file = this.store.activityPath(slug, id);
    const st = logStat(file);
    if (st?.gz && st.size > (this.files.get(file)?.offset ?? 0)) await loadLog(file);
    const g = this.ticketSteps(slug, id);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      await pause();
    }
  }

  /** ticket() in steps: it yields between chunks of a long activity log (a place to pause). */
  private *ticketSteps(slug: string, id: string): Generator<void, TicketSpend> {
    const runs = yield* this.logSteps(this.store.activityPath(slug, id));
    const side = readSideSpend(this.store.sideSpendPath(slug, id));
    if (!side.costUsd) return runs;
    const days = new Map(runs.days);
    for (const [d, c] of side.days) days.set(d, (days.get(d) ?? 0) + c);
    return { costUsd: runs.costUsd + side.costUsd, days };
  }

  /** Cost of the result lines in one activity log (a ticket's, or a quick chat's); reads only what was appended since. */
  private *logSteps(file: string): Generator<void, TicketSpend> {
    let st = this.files.get(file);
    const ls = logStat(file);
    if (!ls) {
      this.files.delete(file);
      return { costUsd: 0, days: new Map() };
    }
    const size = ls.size;
    // Rewritten or replaced (e.g. a deleted and re-made ticket): start over.
    if (!st || size < st.offset) {
      st = { offset: 0, totals: new Map(), costUsd: 0, days: new Map() };
      this.files.set(file, st);
    }
    if (size > st.offset) yield* this.read(file, st, size);
    return st;
  }

  /** Yields after each chunk: a first read of a busy ticket's log is tens of MB. */
  private *read(file: string, st: FileState, size: number): Generator<void> {
    const log = openLog(file);
    if (!log) return;
    size = Math.min(size, log.size);
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - st.offset));
      // Bytes after the last whole line: decoded with the next chunk, so a character split between chunks stays whole.
      let carry: Buffer = Buffer.alloc(0);
      let pos = st.offset;
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
        for (const line of all.toString("utf8", 0, cut).split("\n")) this.line(st, line);
        carry = Buffer.from(all.subarray(cut + 1));
        st.offset = pos - carry.length;
        if (pos < size) {
          const at = st.offset;
          yield;
          // Read on by someone else meanwhile (ticket() doesn't pause): what is left is counted already.
          if (st.offset !== at || this.files.get(file) !== st) return;
        }
      }
    } finally {
      log.close();
    }
  }

  private line(st: FileState, line: string) {
    if (!line.includes('"total_cost_usd"')) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const ev = e?.event;
    if (ev?.type !== "result") return;
    const sid = String(ev.session_id ?? "");
    const total = num(ev.total_cost_usd);
    const prev = st.totals.get(sid) ?? 0;
    const cost = total >= prev ? total - prev : total;
    st.totals.set(sid, total);
    if (!cost) return;
    st.costUsd += cost;
    const at = new Date(e.at);
    const day = Number.isNaN(at.getTime()) ? "" : dayKey(at);
    st.days.set(day, (st.days.get(day) ?? 0) + cost);
  }

  /**
   * today(), at most a few seconds old. Every open page asks again after each ticket change, and one answer stats
   * every ticket of every board (seconds when the Mac is busy). So it is made in slices (pausing every ~sliceMs), one
   * at a time: callers meanwhile wait for the same one.
   */
  async recent(maxAgeMs = 5_000, sliceMs = 30): Promise<TodaySpend> {
    const at = this.now().getTime();
    const fresh = this.last && at - this.last.at < maxAgeMs && at >= this.last.at;
    if (!fresh && !this.making) {
      const pause = pauser(sliceMs);
      this.making = (async () => {
        let spend: TodaySpend | undefined;
        for (const step of this.todaySteps()) {
          if (step) spend = step;
          else await pause();
        }
        this.last = { at, spend: spend! };
        return spend!;
      })().finally(() => (this.making = null));
    }
    return fresh ? this.last!.spend : this.making!;
  }
  private last: { at: number; spend: TodaySpend } | null = null;
  private making: Promise<TodaySpend> | null = null;

  /** What every board spent today (local day): its tickets' runs, its quick chats and its huddle agents. */
  today(): TodaySpend {
    for (const step of this.todaySteps()) if (step) return step;
    throw new Error("unreachable");
  }

  /** today() in steps: undefined between tickets (a place to pause), the answer last. */
  private *todaySteps(): Generator<TodaySpend | undefined | void> {
    const now = this.now();
    const day = dayKey(now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const huddles = readLedger(this.store.root)[day] ?? {};
    const boards: TodaySpend["boards"] = [];
    for (const p of this.store.listProfiles()) {
      let cost = huddles[p.slug] ?? 0;
      const dir = join(this.store.root, "profiles", p.slug, "tickets");
      for (const id of existsSync(dir) ? readdirSync(dir) : []) {
        yield;
        // Untouched since midnight: nothing spent today.
        // A compressed log (run-log.ts) keeps its original's time, so an old one is skipped here like a plain one.
        const mtime = Math.max(logStat(this.store.activityPath(p.slug, id))?.mtimeMs ?? 0, mtimeOf(this.store.sideSpendPath(p.slug, id)));
        if (mtime >= start) cost += (yield* this.ticketSteps(p.slug, id)).days.get(day) ?? 0;
      }
      // Quick chats (quickchat.ts) log their result lines next to each chat.
      const chats = join(this.store.root, "profiles", p.slug, "chats");
      for (const f of existsSync(chats) ? readdirSync(chats) : []) {
        yield;
        const file = join(chats, f);
        if (f.endsWith(".activity.jsonl") && mtimeOf(file) >= start) cost += (yield* this.logSteps(file)).days.get(day) ?? 0;
        // Their side calls ("Say it simpler").
        if (f.endsWith(".side-spend.jsonl") && mtimeOf(file) >= start) cost += readSideSpend(file).days.get(day) ?? 0;
      }
      boards.push({ slug: p.slug, name: p.name, costUsd: cost });
    }
    // The helper (helper/runner.ts) covers every board: its own "Helper" line.
    const helper = readSideSpend(helperSpendFile(this.store.root)).days.get(day) ?? 0;
    if (helper > 0) boards.push({ slug: "~helper", name: "Helper", costUsd: helper });
    yield { day, costUsd: boards.reduce((s, b) => s + b.costUsd, 0), boards };
  }
}

/** Runs a step generator to its end, without pausing. */
function drain<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const ledgerFile = (root: string) => join(root, "spend-days.json");

function readLedger(root: string): Record<string, Record<string, number>> {
  try {
    const v = JSON.parse(readFileSync(ledgerFile(root), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** A huddle agent's run cost (its result line's growth), for today's total. */
export function addHuddleSpend(root: string, slug: string, costUsd: number, at = new Date()): void {
  if (!(costUsd > 0)) return;
  const ledger = readLedger(root);
  const d = (ledger[dayKey(at)] ??= {});
  d[slug] = (d[slug] ?? 0) + costUsd;
  const keep = Object.keys(ledger).sort().slice(-KEEP_DAYS);
  atomicWrite(ledgerFile(root), JSON.stringify(Object.fromEntries(keep.map((k) => [k, ledger[k]]))) + "\n");
}

// Spent from Telegram: model spend of turns that Telegram started (a ticket's run started or steered by a Telegram
// message; the front desk's chats add to the same number). Settings shows today's total, with no limit.
const telegramLedgerFile = (root: string) => join(root, "telegram-spend.json");
// The front desk's own share of it (its daily cap counts only this, not ticket runs Telegram started).
const deskLedgerFile = (root: string) => join(root, "telegram-desk-spend.json");

function readTelegramLedger(root: string, file = telegramLedgerFile(root)): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, n]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && num(n) > 0)) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Adds what a turn Telegram started cost (USD) to that local day's Telegram total. The one helper every Telegram path calls. */
export function addTelegramSpend(root: string, costUsd: number, at = new Date(), file = telegramLedgerFile(root)): void {
  if (!(costUsd > 0) || !Number.isFinite(costUsd)) return;
  const ledger = readTelegramLedger(root, file);
  const day = dayKey(at);
  ledger[day] = (ledger[day] ?? 0) + costUsd;
  const keep = Object.keys(ledger).sort().slice(-KEEP_DAYS);
  atomicWrite(file, JSON.stringify(Object.fromEntries(keep.map((k) => [k, ledger[k]]))) + "\n");
}

/** Adds a front desk turn's cost to today's front desk total (and, like every Telegram turn, to "Spent from Telegram today"). */
export function addDeskSpend(root: string, costUsd: number, at = new Date()): void {
  addTelegramSpend(root, costUsd, at);
  addTelegramSpend(root, costUsd, at, deskLedgerFile(root));
}

/** What the front desk's chats cost today (local day), in USD: what its daily cap is checked against. */
export function deskSpendToday(root: string, now = new Date()): number {
  return readTelegramLedger(root, deskLedgerFile(root))[dayKey(now)] ?? 0;
}

/** What turns Telegram started cost today (local day), in USD. */
export function telegramSpendToday(root: string, now = new Date()): number {
  return readTelegramLedger(root)[dayKey(now)] ?? 0;
}
