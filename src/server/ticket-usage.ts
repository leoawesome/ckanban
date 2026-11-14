import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./store";
import { pauser } from "./lag";
import { logStat, readLog } from "./run-log";
import type { ActivityEntry } from "./types";
import type { UsageResult } from "./usage";

// How much of the Claude plan a ticket used. Anthropic only reports a plan-wide % per 5h window, so a ticket's
// share is estimated: its exact cost in a window (from its runs' result events) ÷ the cost of all Claude Code
// activity on this machine in that window (priced from ~/.claude/projects logs) × the window's utilization.

const FIVE_HOURS = 5 * 3600_000;

// ---------- pricing ----------

/** List prices in $ per million tokens; cache writes are 1.25× (5 min) or 2× (1 h) the input price. */
interface Price { input: number; output: number; cacheRead: number }

const OPUS_5_5: Price = { input: 4, output: 20, cacheRead: 0.2 };
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5|^opus$/, OPUS_5_5],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
];

/** Price for a model id ("claude-opus-5-5[1m]", "opus"); unknown models get the current Opus price. */
export function priceFor(model: string): Price {
  const m = model.toLowerCase().replace(/\[.*\]$/, "");
  return PRICES.find(([re]) => re.test(m))?.[1] ?? OPUS_5_5;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** API-equivalent cost of one assistant message from its `usage` block. */
export function messageCost(model: string, usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  const p = priceFor(model);
  const created = num(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  // Claude Code caches for 1 h; count unsplit cache writes that way.
  const w5m = split ? num(split.ephemeral_5m_input_tokens) : 0;
  const w1h = split ? num(split.ephemeral_1h_input_tokens) : created;
  const dollars = num(usage.input_tokens) * p.input + num(usage.output_tokens) * p.output
    + num(usage.cache_read_input_tokens) * p.cacheRead + w5m * p.input * 1.25 + w1h * p.input * 2;
  return (dollars / 1e6) * (usage.speed === "fast" ? 2 : 1);
}

/** Conversation size at one assistant message: everything it read (input, cache read, cache write); 0 without usage. */
export function contextTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

// ---------- machine-wide Claude Code cost ----------

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Costs are kept per minute: 5h windows start at a reset time, which isn't always on the hour. */
const BUCKET_MS = 60_000;
/** How long a request for older activity keeps it in the index (afterwards it is dropped until asked for again). */
const HOLD_MS = 3600_000;

/**
 * Cost of every Claude Code message on this machine, read incrementally from the session logs: each file is
 * read from where the last refresh stopped, and files older than the oldest window asked for are skipped.
 * Costs are summed per minute, and only back to the oldest window asked for in the last hour: one entry per message
 * kept forever grew to hundreds of MB on a busy machine, and each lookup went through all of them.
 */
export class ClaudeLogIndex {
  private files = new Map<string, { offset: number }>();
  /** Cost per minute (start ms / BUCKET_MS). */
  private buckets = new Map<number, number>();
  /**
   * A hash of message id + request id → its minute and cost (a message is logged once per content block, later lines
   * with the final counts; a resumed session's file can repeat earlier messages). Only messages in the index's span:
   * dropped with their minute. Numbers, not strings and objects: a busy month is a million messages.
   */
  private keys = new Map<number, number>();
  private costs = new Map<number, number>();
  /** Activity before this isn't in the index. */
  private horizon = Infinity;
  /** The oldest time each recent caller asked for, and when (they hold the horizon back for HOLD_MS). */
  private asked = new Map<number, number>();
  private lastRefresh = 0;
  private running: Promise<void> | null = null;

  constructor(private root = claudeProjectsDir(), private minIntervalMs = 10_000, private now = Date.now) {}

  /** Catch up with the logs, covering at least activity since `since` (ms). */
  async refresh(since: number): Promise<void> {
    while (this.running) await this.running;
    this.asked.set(since, this.now());
    if (since < this.horizon) this.reset();
    else this.trim();
    if (since >= this.horizon && this.now() - this.lastRefresh < this.minIntervalMs) return;
    this.running = this.scan(Math.min(since, this.horizon));
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  costBetween(start: number, end: number): number {
    let sum = 0;
    const from = Math.ceil(start / BUCKET_MS);
    const to = Math.ceil(end / BUCKET_MS);
    // A 5h window is 300 minutes: look them up, unless the index holds fewer minutes than that.
    if (to - from <= this.buckets.size) {
      for (let m = from; m < to; m++) sum += this.buckets.get(m) ?? 0;
    } else {
      for (const [m, cost] of this.buckets) if (m >= from && m < to) sum += cost;
    }
    return sum;
  }

  /** Older activity was asked for: read every log again from the start (the index only has what is newer). */
  private reset() {
    this.files.clear();
    this.buckets.clear();
    this.keys.clear();
    this.costs.clear();
    this.horizon = Infinity;
  }

  /** Drops what no caller asked for in the last hour. */
  private trim() {
    const now = this.now();
    let oldest = Infinity;
    for (const [since, at] of this.asked) {
      if (now - at > HOLD_MS) this.asked.delete(since);
      else oldest = Math.min(oldest, since);
    }
    if (!(oldest > this.horizon) || oldest === Infinity) return;
    const cut = Math.floor(oldest / BUCKET_MS);
    for (const m of this.buckets.keys()) if (m < cut) this.buckets.delete(m);
    for (const [k, m] of this.keys) if (m < cut) {
      this.keys.delete(k);
      this.costs.delete(k);
    }
    this.horizon = cut * BUCKET_MS;
  }

  private async scan(since: number): Promise<void> {
    // Thousands of files under the projects folder: listed and stat'ed off the event loop (doing it here held the
    // daemon up for seconds when the Mac was busy), a batch of stats at a time.
    let names: string[];
    let listed = true;
    try {
      names = ((await readdir(this.root, { recursive: true })) as string[]).filter((n) => n.endsWith(".jsonl"));
    } catch {
      names = [];
      listed = false;
    }
    const BATCH = 64;
    // Parsing what a file gained is the other cost (a first read takes in megabytes): a pause between files.
    const pause = pauser();
    const floor = Math.floor(since / BUCKET_MS) * BUCKET_MS;
    for (let i = 0; i < names.length; i += BATCH) {
      const part = names.slice(i, i + BATCH).map((name) => join(this.root, name));
      const stats = await Promise.all(part.map((f) => stat(f).catch(() => null)));
      for (let j = 0; j < part.length; j++) {
        await this.catchUp(part[j], stats[j], floor);
        await pause();
      }
    }
    // Forget files that are gone (their costs stay in the minutes they were spent).
    if (listed) {
      const live = new Set(names.map((name) => join(this.root, name)));
      for (const f of this.files.keys()) if (!live.has(f)) this.files.delete(f);
    }
    this.horizon = Math.min(this.horizon, floor);
    this.lastRefresh = this.now();
  }

  private async catchUp(file: string, st: { mtimeMs: number; size: number } | null, since: number): Promise<void> {
    if (!st) return;
    let state = this.files.get(file);
    if (!state) {
      if (st.mtimeMs < since) return;
      state = { offset: 0 };
      this.files.set(file, state);
    }
    if (st.size < state.offset) state.offset = 0;
    if (st.size === state.offset) return;
    // In chunks: a first read of a long transcript all at once held hundreds of MB the daemon kept afterwards. A line
    // still being written is read again next time.
    state.offset = await readLines(file, state.offset, st.size, (lines) => {
      for (const line of lines) this.add(line, since);
    });
  }

  private add(line: string, since: number) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const m = j?.message;
    if (j?.type !== "assistant" || !m?.usage || typeof m.model !== "string" || m.model === "<synthetic>") return;
    const t = Date.parse(j.timestamp);
    if (Number.isNaN(t) || t < since) return;
    const cost = messageCost(m.model, m.usage);
    // 52 bits of a 64-bit hash: a clash is about one in a billion at a million messages.
    const key = Number(BigInt.asUintN(52, BigInt(Bun.hash(`${m.id ?? j.uuid}:${j.requestId ?? ""}`))));
    const at = this.keys.get(key);
    // Later lines of the same message carry the final token counts: they replace its cost.
    if (at !== undefined) {
      this.buckets.set(at, (this.buckets.get(at) ?? 0) - (this.costs.get(key) ?? 0) + cost);
      this.costs.set(key, cost);
    } else {
      const minute = Math.floor(t / BUCKET_MS);
      this.keys.set(key, minute);
      this.costs.set(key, cost);
      this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + cost);
    }
  }
}

// ---------- 5h window snapshots ----------

export interface WindowSnapshot {
  start: string;
  end: string;
  /** Last seen utilization, 0-100. */
  utilization: number;
  seenAt: string;
}

export function readWindows(file: string): WindowSnapshot[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Remembers the 5h window from a usage answer, so runs keep a % after their window has reset. */
export function recordWindow(file: string, r: UsageResult): void {
  if ("error" in r) return;
  const w = r.windows.find((x) => x.key === "five_hour");
  const end = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!w || Number.isNaN(end)) return;
  const snap: WindowSnapshot = {
    start: new Date(end - FIVE_HOURS).toISOString(), end: new Date(end).toISOString(), utilization: w.percent, seenAt: r.fetchedAt,
  };
  // resets_at can wobble by seconds between answers; anything within 15 min is the same window.
  const list = readWindows(file).filter((x) => Math.abs(Date.parse(x.end) - end) >= 15 * 60_000);
  list.push(snap);
  list.sort((a, b) => a.end.localeCompare(b.end));
  atomicWrite(file, JSON.stringify(list.slice(-500)));
}

// ---------- per-ticket runs ----------

export type RunKind = "work" | "planning" | "chat" | "reply" | "follow-up" | "run";

export interface TicketRun {
  run: number;
  kind: RunKind;
  startedAt: string;
  /** Model with the biggest share of the run's cost. */
  model: string | null;
  tokens: number;
  costUsd: number;
  /** Cost per result event, to place it in a 5h window. */
  parts: { at: string; cost: number }[];
}

/**
 * Splits a ticket's activity into runs with their cost and tokens. Result events carry the session's running
 * totals (`total_cost_usd`, `modelUsage`, kept across `--resume`), so a run's cost is the growth since the last one.
 */
export function ticketRuns(activity: ActivityEntry[]): TicketRun[] {
  const out: (TicketRun & { marked: boolean; done: boolean; models: Map<string, number> })[] = [];
  const lastTotal = new Map<string, number>();
  const lastModel = new Map<string, { tokens: number; cost: number }>();
  let cur: (typeof out)[number] | null = null;
  for (const e of activity) {
    const ev = e.event;
    if (!ev || typeof ev !== "object") continue;
    const marker = ev.type === "ckanban_run";
    const init = ev.type === "system" && ev.subtype === "init";
    // Runs logged before markers existed: a new init after a result starts the next turn.
    if (marker || !cur || cur.run !== e.run || (init && cur.done && !cur.marked)) {
      cur = { run: e.run, kind: marker ? ev.kind ?? "run" : "run", startedAt: e.at, model: null, tokens: 0, costUsd: 0, parts: [], marked: marker, done: false, models: new Map() };
      out.push(cur);
    }
    if (init && !cur.marked && cur.kind === "run" && ev.permissionMode === "plan") cur.kind = "planning";
    if (ev.type !== "result") continue;
    cur.done = true;
    const sid = String(ev.session_id ?? "");
    const total = num(ev.total_cost_usd);
    const prev = lastTotal.get(sid) ?? 0;
    const cost = total >= prev ? total - prev : total;
    lastTotal.set(sid, total);
    cur.costUsd += cost;
    cur.parts.push({ at: e.at, cost });
    const mu = ev.modelUsage && typeof ev.modelUsage === "object" && Object.keys(ev.modelUsage).length ? ev.modelUsage : null;
    if (mu) {
      for (const [model, u] of Object.entries<any>(mu)) {
        const now = {
          tokens: num(u?.inputTokens) + num(u?.outputTokens) + num(u?.cacheReadInputTokens) + num(u?.cacheCreationInputTokens),
          cost: num(u?.costUSD),
        };
        const before = lastModel.get(`${sid}|${model}`) ?? { tokens: 0, cost: 0 };
        const grew = now.tokens >= before.tokens && now.cost >= before.cost;
        lastModel.set(`${sid}|${model}`, now);
        cur.tokens += grew ? now.tokens - before.tokens : now.tokens;
        cur.models.set(model, (cur.models.get(model) ?? 0) + (grew ? now.cost - before.cost : now.cost));
      }
    } else if (ev.usage) {
      const u = ev.usage;
      cur.tokens += num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    }
  }
  return out
    .filter((r) => r.done)
    .map(({ marked, done, models, ...r }) => ({
      ...r,
      model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }));
}

// ---------- ticket usage ----------

/** What the agents of a ticket's huddles spent (huddle.ts teammateSpend); counted in the ticket's total cost. */
export interface TeammateUsage {
  costUsd: number;
  huddles: { id: string; status: string; createdAt: string; costUsd: number; teammates: { handle: string; role: string; costUsd: number }[] }[];
}

export interface TicketUsage {
  runs: { run: number; kind: RunKind; startedAt: string; model: string | null; tokens: number; costUsd: number; pct5h: number | null }[];
  /** costUsd: the ticket's runs plus its huddle teammates and side calls; tokens and % are its runs only. */
  totals: { costUsd: number; tokens: number; pctCurrentWindow: number | null; pctLifetime: number | null };
  /** Its huddles' teammates, null when they spent nothing. */
  teammates: TeammateUsage | null;
  /** What its side calls ("Say it simpler", "Help me understand") cost; 0 when none. */
  sideCostUsd: number;
  /** The current 5h window, as last seen. */
  window: { utilization: number; resetsAt: string; seenAt: string } | null;
  /** Why there is no current window (usage endpoint error), if known. */
  windowError: string | null;
}

export interface UsageInputs {
  activity: ActivityEntry[];
  windows: WindowSnapshot[];
  /** Cost of all Claude Code activity on this machine between two times (ms). */
  machineCost: (start: number, end: number) => number;
  now?: number;
  windowError?: string | null;
  teammates?: TeammateUsage;
  /** Its side calls' cost (side-call.ts). */
  side?: number;
}

/** Windows the ticket's runs fall in (and the current one): what the machine-wide index must cover. */
export function windowsNeeded(runs: TicketRun[], windows: WindowSnapshot[], now = Date.now()): WindowSnapshot[] {
  const hit = (t: number) => windows.find((w) => Date.parse(w.start) <= t && t < Date.parse(w.end));
  const set = new Set<WindowSnapshot>();
  const current = hit(now);
  if (current) set.add(current);
  for (const r of runs) for (const p of r.parts) {
    const w = hit(Date.parse(p.at));
    if (w) set.add(w);
  }
  return [...set];
}

export function ticketUsage(i: UsageInputs): TicketUsage {
  const now = i.now ?? Date.now();
  const runs = ticketRuns(i.activity);
  const span = (w: WindowSnapshot) => [Date.parse(w.start), Date.parse(w.end)] as const;
  const windowOf = (t: number) => i.windows.find((w) => {
    const [s, e] = span(w);
    return s <= t && t < e;
  }) ?? null;
  const current = windowOf(now);

  // Per window: the ticket's cost there, and the machine total (never less than the ticket's own).
  const ticketIn = new Map<WindowSnapshot, number>();
  for (const r of runs) for (const p of r.parts) {
    const w = windowOf(Date.parse(p.at));
    if (w) ticketIn.set(w, (ticketIn.get(w) ?? 0) + p.cost);
  }
  const denom = new Map<WindowSnapshot, number>();
  for (const [w, mine] of ticketIn) denom.set(w, Math.max(i.machineCost(...span(w)), mine));

  let pctCurrent = current ? 0 : null;
  let pctLifetime: number | null = null;
  const outRuns = runs.map((r) => {
    let pct: number | null = null;
    for (const p of r.parts) {
      const w = windowOf(Date.parse(p.at));
      if (!w) continue;
      const d = denom.get(w)!;
      const share = d > 0 ? (p.cost / d) * w.utilization : 0;
      pct = (pct ?? 0) + share;
      pctLifetime = (pctLifetime ?? 0) + share;
      if (w === current) pctCurrent = (pctCurrent ?? 0) + share;
    }
    return { run: r.run, kind: r.kind, startedAt: r.startedAt, model: r.model, tokens: r.tokens, costUsd: r.costUsd, pct5h: pct };
  });

  return {
    runs: outRuns,
    totals: {
      costUsd: runs.reduce((s, r) => s + r.costUsd, 0) + (i.teammates?.costUsd ?? 0) + (i.side ?? 0),
      tokens: runs.reduce((s, r) => s + r.tokens, 0),
      pctCurrentWindow: pctCurrent,
      pctLifetime,
    },
    teammates: i.teammates?.costUsd ? i.teammates : null,
    sideCostUsd: i.side ?? 0,
    window: current ? { utilization: current.utilization, resetsAt: current.end, seenAt: current.seenAt } : null,
    windowError: current ? null : i.windowError ?? null,
  };
}

// ---------- run log (what ticketRuns reads of an activity log) ----------

/** The event fields ticketRuns reads. */
const RUN_FIELDS = ["type", "subtype", "kind", "permissionMode", "session_id", "total_cost_usd", "modelUsage", "usage"] as const;
const LOG_CHUNK = 1 << 20;

/**
 * The entries of each ticket's activity log that ticketRuns needs, kept per file and read incrementally in chunks
 * off the event loop. A busy ticket's log is tens of MB of tool output: reading and parsing all of it each time its
 * Usage tab opened froze the daemon for seconds. Run markers, inits and results are kept (with only the fields
 * ticketRuns reads), and one stand-in entry wherever the run number changes.
 */
export class RunLogIndex {
  private files = new Map<string, { offset: number; size: number; entries: ActivityEntry[]; lastRun: number | null }>();
  private reading = new Map<string, Promise<ActivityEntry[]>>();

  entries(file: string, sliceMs = 30): Promise<ActivityEntry[]> {
    const busy = this.reading.get(file);
    if (busy) return busy;
    const p = this.read(file, sliceMs).finally(() => this.reading.delete(file));
    this.reading.set(file, p);
    return p;
  }

  private async read(file: string, sliceMs: number, retried = false): Promise<ActivityEntry[]> {
    try {
      return await this.readOnce(file, sliceMs);
    } catch (e) {
      // The log was swapped for its compressed copy (or restored) between two slices: what this read added is dropped
      // (it would be counted twice) and the log is read again from its start, once.
      this.files.delete(file);
      if (retried) throw e;
      return this.read(file, sliceMs, true);
    }
  }

  private async readOnce(file: string, sliceMs: number): Promise<ActivityEntry[]> {
    // Plain or compressed (run-log.ts): a compressed log keeps the same bytes, so the same offsets.
    const ls = logStat(file);
    if (!ls) {
      this.files.delete(file);
      return [];
    }
    let size = ls.size;
    let st = this.files.get(file);
    if (!st || size < st.size) {
      st = { offset: 0, size: 0, entries: [], lastRun: null };
      this.files.set(file, st);
    }
    if (size <= st.offset) {
      st.size = size;
      return st.entries;
    }
    let source: string | Buffer = file;
    if (ls.gz) {
      const bytes = await readLog(file);
      if (!bytes) return st.entries;
      source = bytes;
      size = Math.min(size, bytes.length);
    }
    const pause = pauser(sliceMs);
    st.offset = await readLines(source, st.offset, size, async (lines) => {
      for (const line of lines) this.add(st!, line);
      await pause();
    });
    st.size = size;
    return st.entries;
  }

  private add(st: { entries: ActivityEntry[]; lastRun: number | null }, line: string): void {
    if (!line) return;
    const wanted = line.includes('"ckanban_run"') || line.includes('"subtype":"init"') || line.includes('"type":"result"');
    if (wanted) {
      let e: ActivityEntry;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const ev = e?.event as Record<string, unknown> | undefined;
      if (!ev || typeof ev !== "object") return;
      const slim: Record<string, unknown> = {};
      for (const k of RUN_FIELDS) if (ev[k] !== undefined) slim[k] = ev[k];
      st.entries.push({ ...e, event: slim } as ActivityEntry);
      st.lastRun = e.run;
      return;
    }
    // Any other line matters only where the run number changes (ticketRuns starts a run there).
    const m = /^\{"run":(\d+),"at":"([^"]*)"/.exec(line);
    if (!m || Number(m[1]) === st.lastRun) return;
    st.lastRun = Number(m[1]);
    st.entries.push({ run: st.lastRun, at: m[2], event: { type: "other" } } as ActivityEntry);
  }
}

/**
 * Reads the whole lines between byte offsets from and to, a chunk at a time (decoding only up to each chunk's last
 * newline, so a character split between chunks stays whole). Returns the offset after the last whole line.
 */
export async function readLines(file: string | Buffer, from: number, to: number, each: (lines: string[]) => void | Promise<void>, chunk = LOG_CHUNK): Promise<number> {
  // A Buffer: a compressed run log already decompressed (run-log.ts), read the same way.
  const f = typeof file === "string" ? Bun.file(file) : null;
  let carry: Buffer = Buffer.alloc(0);
  let pos = from;
  while (pos < to) {
    const end = Math.min(to, pos + chunk);
    const got = f ? Buffer.from(await f.slice(pos, end).arrayBuffer()) : (file as Buffer).subarray(pos, end);
    pos = end;
    const all = carry.length ? Buffer.concat([carry, got]) : got;
    const cut = all.lastIndexOf(10);
    if (cut < 0) {
      carry = all;
      continue;
    }
    await each(all.toString("utf8", 0, cut).split("\n"));
    carry = all.subarray(cut + 1);
  }
  return pos - carry.length;
}
