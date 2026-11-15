import { closeSync, openSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import { pauser, track, trackedInterval } from "../core/lag";
import { dirname, join } from "node:path";
import type { Bus } from "../core/events";
import { DONE_PASS_MS, SAFETY_PASS_MS, type SessionChanges } from "../core/changefeed";
import { atomicWrite, atomicWriteAsync } from "../core/atomic";
import { VERSION } from "../core/version";
import { maskSaved } from "../integrations/board-keys";
import type { Store } from "../core/store";
import type { Ticket } from "../core/types";
import { SubagentCache, subagentFiles, withTranscript } from "./subagents";
import { WorkflowCache, withRun, type WorkflowRun } from "./workflows";
import { findToolDetailIn, type ToolDetail } from "../chat/tooldetail";
import type { ParsedSession, SessionSummary } from "./session-markers";
import { scanSessionFiles, scanSessionFilesAsync, type Dirs } from "./session-files";
import { SessionParser } from "./session-parser";

interface CacheItem {
  file: string;
  /** The file read so far: its inode, size and change time when last checked, and how many bytes were parsed. */
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  parser: SessionParser;
  /** The parse with its subagents' transcripts merged in, for agentKey and that parse. */
  agentKey: string;
  mergedFrom: ParsedSession | null;
  merged: ParsedSession | null;
}

/**
 * How many parsed sessions stay in memory, most recently used first. A parse holds every entry of a transcript, so
 * keeping all of them (hundreds) took most of the daemon's memory; idle ones keep only their saved summary and are
 * parsed again when opened. Running sessions are kept too.
 */
const MAX_PARSED = 30;
/** A session whose transcript changed this recently counts as running and keeps its parse. */
const ACTIVE_MS = 10 * 60_000;

/** How much of a transcript one step of a warm-up reads (about 1 to 2ms of parsing). */
const WARM_CHUNK = 1 << 20;
let sharedRead: Buffer | null = null;
const readBuffer = () => (sharedRead ??= Buffer.allocUnsafe(WARM_CHUNK));

/** A session file missing this long is searched for at most every MISSING_RETRY_MS. */
const MISSING_GRACE_MS = 5 * 60_000;
const MISSING_RETRY_MS = 60_000;
/** How long one scan of the projects folder answers lookups (a new run's file is found on the next poll). */
const INDEX_MS = 1_000;
/** The same while the session feed watches the folder: it adds new files to the scan, this is only a safety net. */
const FED_INDEX_MS = 60_000;
/**
 * How soon new summaries are written to the summary cache file. The file is rewritten whole (megabytes on a big board),
 * and running sessions make new summaries every few seconds: at most this often, and at shutdown (main.ts).
 */
const SUMMARY_FLUSH_MS = 30_000;
/** A saved summary nobody used this many days is dropped (made again if that session is opened). */
const SUMMARY_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

type StoredSummary = Omit<SessionSummary, "updatedAt">;
/** u: the day (ms / DAY_MS) the summary was last used; missing in files from older code (counts as the day it loaded). */
type SummaryItems = Record<string, { v: string; s: StoredSummary; u?: number }>;
interface SummaryFile {
  tag: string;
  items: SummaryItems;
  /**
   * Summaries made by older code (another tag) whose transcripts haven't changed. They are shown until warm() has
   * made each one again, so a restart after a change to the parsing doesn't hold the board up while every transcript
   * is read; the file keeps them, so a second restart before that is done doesn't lose them either.
   */
  stale?: SummaryItems;
}

/**
 * The first part of the summaries' tag. Summaries from older code with the same number are shown until they are made
 * again (SummaryFile.stale); fields they lack get the empty summary's values. Raise it when an existing field
 * changes its type or meaning, so the old ones are dropped instead.
 */
const SUMMARY_FORMAT = 2;
const sameFormat = (tag: unknown) => typeof tag === "string" && tag.startsWith(`${SUMMARY_FORMAT}:`);
const isItems = (v: unknown): v is SummaryItems => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Tells summaries made by other code apart: the release version, and from source a hash of the code that makes them
 * (this file and what it imports, recursively), so a fix to the parsing applies at the next restart while a change
 * elsewhere in the server keeps the saved summaries. Most landed tickets change server files; dropping every summary
 * then made the first pass after the restart read every transcript again (seconds on a big board).
 */
export function summaryTag(dir = import.meta.dir, entry = "session"): string {
  const seen = new Set<string>();
  const hash: string[] = [];
  const todo = [entry];
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    let src: string;
    try {
      src = readFileSync(join(dir, `${name}.ts`), "utf8");
    } catch {
      continue;
    }
    hash.push(`${name}:${Bun.hash(src).toString(36)}`);
    // Relative imports in any folder (session.ts is a barrel over session-*.ts, which import ../core, ../server ...).
    for (const m of src.matchAll(/^(?:import|export)(?! type )[^;]*?from "(\.{1,2}\/[\w./-]+)"/gm)) todo.push(join(dirname(name), m[1]));
  }
  return `${SUMMARY_FORMAT}:${VERSION}:${Bun.hash(hash.sort().join(",")).toString(36)}`;
}

/**
 * JSON.stringify(file) made one summary at a time with a pause between slices, so the text of thousands of summaries
 * doesn't block the event loop in one go. A summary replaced meanwhile is written as it is when its turn comes.
 */
async function summariesJson(file: SummaryFile, pause: () => Promise<void>): Promise<string> {
  const part = async (items: SummaryItems) => {
    const out: string[] = [];
    for (const id of Object.keys(items)) {
      const e = items[id];
      if (e) out.push(`${JSON.stringify(id)}:${JSON.stringify(e)}`);
      await pause();
    }
    return `{${out.join(",")}}`;
  };
  const stale = file.stale ? `,"stale":${await part(file.stale)}` : "";
  return `{"tag":${JSON.stringify(file.tag)},"items":${await part(file.items)}${stale}}`;
}

/** Parses session files lazily; re-reads only when size/mtime change. */
export class SessionCache {
  private items = new Map<string, CacheItem>();
  private files = new Map<string, string>();
  private agents = new SubagentCache();
  private workflowFiles = new WorkflowCache();
  /** Sessions whose file wasn't found: since when, and when it was last searched for. */
  private missing = new Map<string, { since: number; at: number }>();
  /**
   * Session files by id from one scan of the projects folder. Searching each id on its own stats a path per projects
   * folder (often 1000+), so a few dozen tickets whose transcripts are gone held the daemon up for seconds.
   */
  private index: { at: number; files: Map<string, string> } | null = null;

  /**
   * Summaries by session id and file version, kept on disk (summaryFile) so the board's first load after a restart
   * doesn't read and parse every ticket's transcript again.
   */
  private summaries: SummaryFile | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The warm-ups started so far (warm()), one after another. */
  private warming: Promise<void> = Promise.resolve();
  /** Settles once the latest warm-up has a summary to show for each of its sessions (ready()). */
  private usable: Promise<void> = Promise.resolve();
  /** What a summary of an empty transcript holds: the values an older summary's missing fields get. */
  private blank: StoredSummary | null = null;
  /** The session feed keeping the scan current (follow()), so it isn't redone every second while a session is missing. */
  private feed: SessionChanges | null = null;

  constructor(private dirs: Dirs = {}, private now: () => number = Date.now, private summaryFile?: string) {}

  private storedSummaries(): SummaryFile {
    if (this.summaries) return this.summaries;
    const tag = summaryTag();
    let items: SummaryItems = {};
    let stale: SummaryItems = {};
    if (this.summaryFile) {
      try {
        const v = JSON.parse(readFileSync(this.summaryFile, "utf8"));
        if (isItems(v?.items) && sameFormat(v.tag)) {
          const older = isItems(v.stale) ? v.stale : {};
          if (v.tag === tag) [items, stale] = [v.items, older];
          else (stale = { ...older, ...v.items }), (this.summariesDirty = true);
        }
      } catch {}
      const today = this.today();
      for (const e of Object.values(items)) if (e.u === undefined) (e.u = today), (this.summariesDirty = true);
    }
    return (this.summaries = { tag, items, ...(Object.keys(stale).length ? { stale } : {}) });
  }

  /** An older summary of this session that still matches its transcript (version v), to show until it is made again. */
  private staleSummary(sessionId: string, v: string | null): StoredSummary | null {
    const old = v ? this.storedSummaries().stale?.[sessionId] : undefined;
    if (!old || old.v !== v) return null;
    this.blank ??= this.summaryOf(new SessionParser().result());
    return { ...this.blank, ...old.s };
  }

  private today(): number {
    return Math.floor(this.now() / DAY_MS);
  }

  /** Notes that a saved summary was used today (written with the next flush), so the prune keeps it. */
  private used(e: { u?: number }) {
    const today = this.today();
    if (e.u === today) return;
    e.u = today;
    this.summariesDirty = true;
  }

  /** The saved summaries changed since the file was last written (flushSummaries writes only then). */
  private summariesDirty = false;

  private storeSummary(sessionId: string, v: string, s: StoredSummary) {
    if (!this.summaryFile) return;
    const stored = this.storedSummaries();
    stored.items[sessionId] = { v, s, u: this.today() };
    if (stored.stale) delete stored.stale[sessionId];
    this.summariesDirty = true;
    this.flushTimer ??= setTimeout(() => this.flushSummaries(), SUMMARY_FLUSH_MS);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /** The write in progress (flushSummaries), so writes run one after another. */
  private flushing: Promise<void> = Promise.resolve();
  /** Bumped by every write: an older background write that finishes later doesn't replace a newer file. */
  private writeSeq = 0;

  /**
   * Writes the summary cache file (on a timer after new summaries), only when something in it changed. The file is
   * megabytes on a big board: its text is made in slices (pauser) and written off the event loop. A sync write of the
   * 5.8 MB file once froze the daemon for 13s on a busy Mac. Tracked, so a freeze from it still names it in daemon.log.
   */
  flushSummaries(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.summaryFile || !this.summaries) return Promise.resolve();
    const next = this.flushing.then(() => track("session summaries write", () => this.writeSummaries()));
    return (this.flushing = next.catch(() => {}));
  }

  private async writeSummaries(): Promise<void> {
    const pause = pauser();
    await this.pruneSummaries(pause);
    if (!this.summariesDirty || !this.summaries) return;
    // Changes made while this write runs set it again: the next flush writes them.
    this.summariesDirty = false;
    const seq = ++this.writeSeq;
    try {
      const text = await summariesJson(this.summaries, pause);
      if (seq !== this.writeSeq) return;
      await atomicWriteAsync(this.summaryFile!, text, () => seq === this.writeSeq);
    } catch (e) {
      this.summariesDirty = true;
      console.error("session summary cache", e);
    }
  }

  /** The same write in one go, for shutdown (the daemon exits right after, so a short block doesn't matter). */
  flushSummariesNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.summaryFile || !this.summaries) return;
    track("session summaries write (shutdown)", () => {
      void this.pruneSummaries();
      if (!this.summariesDirty) return;
      // A background write still running must not rename its older text over this one.
      this.writeSeq++;
      try {
        atomicWrite(this.summaryFile!, JSON.stringify(this.summaries));
        this.summariesDirty = false;
      } catch (e) {
        console.error("session summary cache", e);
      }
    });
  }

  /**
   * Drops saved summaries of sessions whose transcript is gone (from the last scan of the projects folder, so no file
   * is read here) and those nobody used for SUMMARY_KEEP_DAYS: the file otherwise kept every session ever seen.
   * Every ticket's summary is used at each start (warm), so only old sessions no ticket links any more go.
   */
  private async pruneSummaries(pause?: () => Promise<void>): Promise<void> {
    const items = this.summaries?.items;
    if (!items) return;
    const oldest = this.today() - SUMMARY_KEEP_DAYS;
    // An empty scan is more likely a folder that couldn't be read than every transcript gone.
    const scan = this.index?.files.size ? this.index.files : null;
    for (const [id, e] of Object.entries(items)) {
      if ((e.u ?? oldest) < oldest || (scan && !scan.has(id) && !this.files.has(id))) (delete items[id], (this.summariesDirty = true));
      if (pause) await pause();
    }
  }

  /** Keeps the scan of the projects folder current from the feed's new transcripts instead of rescanning it every second. */
  follow(feed: SessionChanges): () => void {
    this.feed = feed;
    const stop = feed.subscribe((c) => {
      if (!c?.file) return;
      this.index?.files.set(c.sessionId, c.file);
      this.scanAdds?.set(c.sessionId, c.file);
      this.missing.delete(c.sessionId);
    });
    return () => {
      stop();
      if (this.feed === feed) this.feed = null;
    };
  }

  private locate(sessionId: string): string | null {
    const known = this.files.get(sessionId);
    if (known) {
      try {
        statSync(known);
        return known;
      } catch {
        // Gone: the scan still lists it until its next refresh (up to a minute while the feed runs).
        this.files.delete(sessionId);
        if (this.index?.files.get(sessionId) === known) this.index.files.delete(sessionId);
      }
    }
    // A search stats one path per projects folder (often 1000+), and old tickets' transcripts get deleted. A new run's
    // file shows up within seconds, so only one missing for a while is searched less often.
    const now = this.now();
    const miss = this.missing.get(sessionId);
    if (miss && now - miss.since >= MISSING_GRACE_MS && now - miss.at < MISSING_RETRY_MS) return null;
    const indexMs = this.feed?.live ? FED_INDEX_MS : INDEX_MS;
    if (!this.index || now - this.index.at >= indexMs || now < this.index.at) {
      // With the feed live a fresh scan is only a safety net: it runs in the background (seconds of frozen daemon on a
      // busy Mac when done here), and the scan we have answers meanwhile.
      if (this.index && this.feed?.live) this.rescan();
      else this.index = { at: now, files: scanSessionFiles(this.dirs) };
    }
    const f = this.index.files.get(sessionId) ?? null;
    if (f) {
      this.files.set(sessionId, f);
      this.missing.delete(sessionId);
    } else this.missing.set(sessionId, { since: miss?.since ?? now, at: now });
    return f;
  }

  /** Files the feed reported while a background scan runs: the scan may have read their folder before they came. */
  private scanAdds: Map<string, string> | null = null;
  private firstScan: Promise<void> | null = null;

  /**
   * The first scan of the projects folder, off the event loop. Without it the first lookup after a start (a page, the
   * warm-up) read every projects folder in one go: thousands of folders, a freeze of 100ms or more on a busy Mac.
   */
  scanned(): Promise<void> {
    if (this.index) return Promise.resolve();
    this.firstScan ??= (async () => {
      const adds = (this.scanAdds = new Map());
      const at = this.now();
      try {
        const files = await scanSessionFilesAsync(this.dirs);
        if (!this.index) {
          for (const [id, f] of adds) files.set(id, f);
          this.index = { at, files };
        }
      } catch (e) {
        console.error("session scan", e);
      } finally {
        if (this.scanAdds === adds) this.scanAdds = null;
        this.firstScan = null;
      }
    })();
    return this.firstScan;
  }

  /** A fresh index from a scan off the event loop (one at a time); the old index stays until it is done. */
  private rescan(): void {
    if (this.scanAdds) return;
    const adds = (this.scanAdds = new Map());
    const at = this.now();
    void scanSessionFilesAsync(this.dirs)
      .then((files) => {
        for (const [id, f] of adds) files.set(id, f);
        this.index = { at, files };
      }, (e) => console.error("session scan", e))
      .finally(() => {
        if (this.scanAdds === adds) this.scanAdds = null;
      });
  }

  private fileVersion(f: string): string | null {
    try {
      const s = statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** The session's transcript file, wherever it is under the projects folder; null when there is none. */
  file(sessionId: string): string | null {
    return this.locate(sessionId);
  }

  /** Cheap change marker for polling (subagent transcripts included); null when the session file doesn't exist. */
  version(sessionId: string): string | null {
    const f = this.locate(sessionId);
    const v = f && this.fileVersion(f);
    if (!f || !v) return null;
    const agents = this.agents.version(f);
    const workflows = this.workflowFiles.version(f);
    return `${v}${agents ? `|${agents}` : ""}${workflows ? `|w${workflows}` : ""}`;
  }

  /**
   * Parses what the transcript gained since the last call (at most maxBytes of it): only new lines are read, a
   * half-written last line waits for the next call, and a file that shrank or was replaced is parsed from the start.
   */
  private catchUp(sessionId: string, f: string, maxBytes = Infinity): CacheItem | null {
    let st: Stats;
    try {
      st = statSync(f);
    } catch {
      return null;
    }
    let hit = this.items.get(sessionId);
    const rewritten = hit && (hit.file !== f || hit.ino !== st.ino || st.size < hit.offset || (st.size === hit.size && st.mtimeMs !== hit.mtimeMs));
    if (!hit || rewritten) {
      hit = { file: f, ino: st.ino, size: 0, mtimeMs: 0, offset: 0, parser: new SessionParser(), agentKey: "", mergedFrom: null, merged: null };
    }
    hit.size = st.size;
    hit.mtimeMs = st.mtimeMs;
    // Most recently used last; the oldest beyond MAX_PARSED are dropped, except sessions written to lately (running
    // ones: their transcripts are the biggest and are read again every poll).
    this.items.delete(sessionId);
    this.items.set(sessionId, hit);
    if (this.items.size > MAX_PARSED) {
      const recent = this.now() - ACTIVE_MS;
      for (const [k, v] of this.items) {
        if (this.items.size <= MAX_PARSED) break;
        // One still being read in slices (readIn, warm) stays, or it would start again at byte 0 next slice.
        if (k !== sessionId && v.mtimeMs < recent && v.offset >= v.size) this.items.delete(k);
      }
    }
    const n = Math.min(st.size - hit.offset, maxBytes);
    if (n <= 0) return hit;
    let fd: number | null = null;
    try {
      fd = openSync(f, "r");
      // In steps of at most WARM_CHUNK, into one shared buffer (the parser copies what it keeps): a buffer per read
      // was a stream of 1 MB allocations while the first pass reads every transcript, and GC pauses with it.
      const buf = readBuffer();
      for (let left = n; left > 0; ) {
        const got = readSync(fd, buf, 0, Math.min(left, buf.length), hit.offset);
        hit.parser.feed(buf.subarray(0, got));
        hit.offset += got;
        left -= got;
        // The file is shorter than it said (cut while reading): look again next time.
        if (!got) {
          hit.size = hit.offset;
          break;
        }
      }
    } catch {
      this.items.delete(sessionId);
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return hit;
  }

  /** The session's own transcript parsed, without its subagents' transcripts. */
  private parsed(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    return (f ? this.catchUp(sessionId, f)?.parser.result() : null) ?? null;
  }

  get(sessionId: string): ParsedSession | null {
    const f = this.locate(sessionId);
    const hit = f && this.catchUp(sessionId, f);
    if (!f || !hit) return null;
    const parsed = hit.parser.result();
    const hasAgents = parsed.entries.some((e) => e.agent);
    const hasWorkflows = parsed.entries.some((e) => e.workflow);
    if (!hasAgents && !hasWorkflows) return parsed;
    const agentKey = `${hasAgents ? this.agents.version(f) : ""}|${hasWorkflows ? this.workflowFiles.version(f) : ""}`;
    if (hit.agentKey !== agentKey || hit.mergedFrom !== parsed || !hit.merged) {
      const transcripts = hasAgents ? this.agents.load(f) : new Map();
      hit.merged = {
        ...parsed,
        entries: parsed.entries.map((e) => {
          if (e.agent) return { ...e, agent: withTranscript(e.agent, transcripts.get(e.agent.toolUseId)) };
          if (e.workflow) return { ...e, workflow: withRun(e.workflow, e.workflow.runId ? this.workflowFiles.load(f, e.workflow.runId) : null) };
          return e;
        }),
      };
      hit.mergedFrom = parsed;
      hit.agentKey = agentKey;
    }
    return hit.merged;
  }

  /**
   * Readies these sessions' summaries without blocking the event loop for more than about sliceMs at a time: big
   * transcripts are read in chunks, with a pause between steps. Sessions whose saved summary is still valid are
   * skipped. Pages that list many tickets wait for it (ready()) instead of parsing everything at once.
   *
   * Two rounds. First the sessions with nothing to show (no saved summary, or the transcript changed since): ready()
   * waits for these only. Then the ones still shown from an older summary (SummaryFile.stale) are made again, and
   * `changed` is called for each whose summary came out different. The returned promise settles after both.
   */
  warm(sessionIds: string[], sliceMs = 30, changed?: (sessionId: string) => void): Promise<void> {
    const pause = pauser(sliceMs);
    const read = async (id: string, f: string) => {
      for (;;) {
        const hit = this.catchUp(id, f, WARM_CHUNK);
        if (!hit || hit.offset >= hit.size) break;
        await pause();
      }
    };
    const missing = async () => {
      await this.scanned();
      for (const id of sessionIds) {
        await pause();
        const f = this.locate(id);
        if (!f) continue;
        const v = this.summaryFile ? this.version(id) : null;
        const saved = this.storedSummaries().items[id];
        if (v && saved?.v === v) {
          this.used(saved);
          continue;
        }
        if (v && this.staleSummary(id, v)) continue;
        await read(id, f);
        this.summary(id);
      }
    };
    const remake = async () => {
      if (!this.summaryFile) return;
      for (const id of sessionIds) {
        await pause();
        if (!this.storedSummaries().stale?.[id]) continue;
        const f = this.locate(id);
        const old = f && this.staleSummary(id, this.version(id));
        // Gone, or changed since the first round: summary() reads it when someone asks.
        if (!f || !old) continue;
        await read(id, f);
        const now = this.fresh(id);
        if (now && changed) {
          const { updatedAt: _, ...s } = now;
          if (!Bun.deepEquals(s, old)) changed(id);
        }
      }
      // What is left belongs to sessions nobody asked for (deleted tickets): not kept for another restart.
      const stored = this.storedSummaries();
      if (stored.stale) {
        delete stored.stale;
        this.summariesDirty = true;
        this.flushTimer ??= setTimeout(() => this.flushSummaries(), SUMMARY_FLUSH_MS);
        (this.flushTimer as { unref?: () => void }).unref?.();
      }
    };
    const usable = this.warming.then(missing, missing);
    const next: Promise<void> = usable.then(remake).finally(() => {
      if (this.warming === next) this.warming = this.usable = Promise.resolve();
    });
    this.usable = usable;
    return (this.warming = next);
  }

  /**
   * Reads what the session's transcript gained, a chunk at a time with `pause` between, unless its saved summary still
   * holds (or, with parse, whatever). Watchers call it before summary(): a running session's first read after a restart (tens of MB) or one that
   * fell out of the parse cache otherwise froze the daemon for seconds in one go.
   */
  async readIn(sessionId: string, pause: () => Promise<void>, o: { parse?: boolean } = {}): Promise<void> {
    const f = this.locate(sessionId);
    if (!f) return;
    // parse: for a caller that needs the parse itself (get()), not only the summary.
    if (this.summaryFile && !o.parse) {
      const v = this.version(sessionId);
      if (v && (this.storedSummaries().items[sessionId]?.v === v || this.staleSummary(sessionId, v))) return;
    }
    for (;;) {
      const hit = this.catchUp(sessionId, f, WARM_CHUNK);
      if (!hit || hit.offset >= hit.size) break;
      await pause();
    }
  }

  /**
   * Settles when every session of the warm-ups started so far has a summary to show (some still from older code, until
   * made again: see warm()).
   */
  ready(): Promise<void> {
    return this.scanned().then(() => this.usable);
  }

  /** Settles when every warm() started so far has finished: every summary is made by this code. */
  settled(): Promise<void> {
    return this.warming;
  }

  /** A workflow's files (journal, agent transcripts, summary), or null when the session or run is unknown. */
  workflowRun(sessionId: string, runId: string): WorkflowRun | null {
    const f = this.locate(sessionId);
    return f ? this.workflowFiles.load(f, runId) : null;
  }

  /** One tool call in full (input and output), from the session or one of its subagents' transcripts. */
  toolDetail(sessionId: string, toolUseId: string): ToolDetail | null {
    const f = this.locate(sessionId);
    return f ? findToolDetailIn([f, ...subagentFiles(f)], toolUseId) : null;
  }

  summary(sessionId: string): SessionSummary | null {
    const f = this.locate(sessionId);
    if (!f) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    // Its transcript (and its subagents') unchanged since the summary was made: no need to read it.
    const v = this.summaryFile ? this.version(sessionId) : null;
    const hit = v ? this.storedSummaries().items[sessionId] : undefined;
    if (hit && hit.v === v) {
      this.used(hit);
      return { ...hit.s, updatedAt };
    }
    const old = this.staleSummary(sessionId, v);
    if (old) return { ...old, updatedAt };
    return this.fresh(sessionId);
  }

  /** The summary read from the transcript now (and saved), whatever older summary there is. */
  private fresh(sessionId: string): SessionSummary | null {
    const f = this.locate(sessionId);
    const p = f && this.parsed(sessionId);
    if (!f || !p) return null;
    let updatedAt = "";
    try {
      updatedAt = statSync(f).mtime.toISOString();
    } catch {}
    const v = this.summaryFile ? this.version(sessionId) : null;
    const s = this.summaryOf(p);
    if (v) this.storeSummary(sessionId, v, s);
    return { ...s, updatedAt };
  }

  private summaryOf(p: ParsedSession): StoredSummary {
    return {
      // The preview is stored and sent to the UI: a saved key in Claude's last message is hidden there.
      title: p.title, lastMessage: p.lastMessage && this.summaryFile ? { ...p.lastMessage, text: maskSaved(dirname(this.summaryFile), p.lastMessage.text) } : p.lastMessage, artifacts: p.artifacts,
      openQuestions: p.openQuestions, openForm: p.openForm, ...(p.openAsk ? { openAsk: p.openAsk } : {}), ...(p.openFormId ? { openFormId: p.openFormId } : {}), pendingProposal: p.pendingProposal, pendingTeammates: p.pendingTeammates, pendingSquads: p.pendingSquads,
      pendingAutomations: p.pendingAutomations, ...(p.pendingKeys.length ? { pendingKeys: p.pendingKeys } : {}),
      ...(p.pendingScheduleDeletes.length ? { pendingScheduleDeletes: p.pendingScheduleDeletes } : {}),
      ...(p.pendingHelperRules.length ? { pendingHelperRules: p.pendingHelperRules } : {}), cache: p.cache,
    };
  }
}

/**
 * One polling pass: emit session.updated for every ticket whose session file changed since last pass. With emit
 * false it only notes the versions and readies the summaries (the watcher's first pass: nothing changed yet for pages
 * that load after it, and their first load finds the summaries ready).
 * It pauses every ~sliceMs, also inside a long transcript read. Each ticket's look costs a few stats (its transcript,
 * its subagents' and workflows' folders): tens of ms for a big board on an idle Mac, but seconds of frozen daemon when
 * the Mac is busy (test suites, a virus scan). The listing can be a moment old by the time a ticket is looked at: what
 * changed meanwhile the Store's writes and the feed report to the next pass anyway.
 * skipDone: Done tickets are only noted (seen), not looked at; their last versions are kept.
 */
export async function pollSessionsSliced(store: Store, bus: Bus, cache: SessionCache, state: Map<string, string>, emit = true, seen?: (sessionId: string | null, key: string) => void, sliceMs = 30, skipDone = false): Promise<void> {
  const pause = pauser(sliceMs);
  const live = new Set<string>();
  for (const p of store.listProfiles()) {
    for (const t of store.listTickets(p.slug)) {
      await pause();
      const key = `${p.slug}/${t.id}`;
      seen?.(t.sessionId, key);
      if (skipDone && t.status === "done") {
        if (t.sessionId) live.add(key);
        continue;
      }
      await pollOneSliced(bus, cache, state, live, p.slug, t, emit, pause);
    }
  }
  for (const k of state.keys()) if (!live.has(k)) state.delete(k);
}

/** pollOne, with a changed transcript read in chunks first (SessionCache.readIn). */
async function pollOneSliced(bus: Bus, cache: SessionCache, state: Map<string, string>, live: Set<string>, slug: string, t: Ticket, emit: boolean, pause: () => Promise<void>): Promise<void> {
  if (t.sessionId) {
    const v = cache.version(t.sessionId);
    if (v && state.get(`${slug}/${t.id}`) !== `${t.sessionId}:${v}`) await cache.readIn(t.sessionId, pause);
  }
  pollOne(bus, cache, state, live, slug, t, emit);
}

function pollOne(bus: Bus, cache: SessionCache, state: Map<string, string>, live: Set<string>, slug: string, t: Ticket, emit: boolean): void {
  if (!t.sessionId) return;
  const key = `${slug}/${t.id}`;
  live.add(key);
  const v = cache.version(t.sessionId);
  if (!v || state.get(key) === `${t.sessionId}:${v}`) return;
  state.set(key, `${t.sessionId}:${v}`);
  const session = cache.summary(t.sessionId);
  if (session && emit) bus.emit({ type: "session.updated", profile: slug, id: t.id, session });
}

const SILENT = { emit() {} } as unknown as Bus;

/**
 * The watcher's first pass after a start: readies every ticket's summary (reading transcripts in slices, see
 * SessionCache.warm) and notes the versions. It pauses every ~sliceMs, so a start with no saved summaries (seconds of
 * reading on a big board, minutes on a busy Mac) never freezes the daemon. It sends nothing, except for a ticket whose
 * summary from older code was shown meanwhile and came out different (given `bus`).
 */
export async function primeSessions(store: Store, cache: SessionCache, state: Map<string, string>, sliceMs = 30, bus?: Bus): Promise<void> {
  const tickets = store.listProfiles().flatMap((p) => store.listTickets(p.slug).map((t) => ({ slug: p.slug, t })));
  // Huddle teammates' sessions too: a ticket's links list their artifacts.
  const teammates = store.listProfiles().flatMap((p) => store.huddleIndex(p.slug).flatMap((h) => h.participants.flatMap((x) => (x.kind === "agent" && x.sessionId ? [x.sessionId] : []))));
  const remade = new Set<string>();
  await cache.warm([...tickets.flatMap(({ t }) => (t.sessionId ? [t.sessionId] : [])), ...teammates], sliceMs, (id) => remade.add(id));
  const pause = pauser(sliceMs);
  const live = new Set<string>();
  for (const { slug, t } of tickets) {
    await pause();
    if (!t.sessionId) continue;
    if (bus && remade.has(t.sessionId)) {
      // Announce it even when a pass during the warm-up already noted this version (with the older summary).
      const session = cache.summary(t.sessionId);
      if (session) bus.emit({ type: "session.updated", profile: slug, id: t.id, session });
    }
    pollOne(SILENT, cache, state, live, slug, t, false);
  }
}

/**
 * Announces ticket sessions that changed. With a session feed watching Claude's projects folder, a pass looks only at
 * the tickets the Store just wrote and the sessions the feed reported, plus a full pass every safetyMs for missed
 * changes (outside edits to ticket files, a dropped event). Without a live feed every pass is a full one.
 */
export function startSessionWatcher(store: Store, bus: Bus, cache: SessionCache, intervalMs = 2000, o: { feed?: SessionChanges; safetyMs?: number; now?: () => number; sliceMs?: number } = {}): () => void {
  const state = new Map<string, string>();
  const sliceMs = o.sliceMs ?? 30;
  const now = o.now ?? Date.now;
  const safetyMs = o.safetyMs ?? SAFETY_PASS_MS;
  // Changes since the last pass: tickets by "slug/id", sessions by id; unknown when the feed couldn't say what changed.
  const tickets = new Set<string>();
  const sessions = new Set<string>();
  let unknown = false;
  // Ticket keys by session id, from the last full pass and the Store's writes since.
  let owners = new Map<string, Set<string>>();
  // What the full pass under way has seen so far; it replaces owners when the pass is done.
  let nextOwners: Map<string, Set<string>> | null = null;
  const add = (map: Map<string, Set<string>>, sessionId: string, key: string) => {
    let keys = map.get(sessionId);
    if (!keys) map.set(sessionId, (keys = new Set()));
    keys.add(key);
  };
  const own = (sessionId: string | null | undefined, key: string) => {
    if (!sessionId) return;
    add(owners, sessionId, key);
    if (nextOwners) add(nextOwners, sessionId, key);
  };
  const stopStore = store.onChange((c) => {
    if (c.kind === "ticket") tickets.add(`${c.slug}/${c.id}`);
  });
  const stopFeed = o.feed?.subscribe((c) => (c ? sessions.add(c.sessionId) : (unknown = true)));
  // The first timer pass is a full one: it learns which tickets own which sessions.
  let lastFull = -Infinity;
  // Done tickets (most of a big board) are looked at every DONE_PASS_MS while the feed is live and missed nothing.
  let lastDone = -Infinity;
  // A full pass runs in slices (pollSessionsSliced): on a busy Mac it takes seconds, and the daemon answers meanwhile.
  // The owners it learns replace the old ones only when it is done, so changed() keeps finding them until then.
  const full = async (emit: boolean) => {
    const skipDone = !!o.feed?.live && !unknown && now() - lastDone < DONE_PASS_MS;
    if (!skipDone) lastDone = now();
    tickets.clear();
    sessions.clear();
    unknown = false;
    lastFull = now();
    const next = (nextOwners = new Map());
    try {
      await pollSessionsSliced(store, bus, cache, state, emit, (id, key) => id && add(next, id, key), sliceMs, skipDone);
      owners = next;
    } finally {
      nextOwners = null;
    }
  };
  // One at a time, in slices: a changed session's transcript may need a long read (SessionCache.readIn).
  let changing: Promise<void> | null = null;
  const changed = () => {
    if (changing) return changing;
    const keys = new Set(tickets);
    for (const id of sessions) for (const k of owners.get(id) ?? []) keys.add(k);
    tickets.clear();
    sessions.clear();
    if (!keys.size) return;
    const pause = pauser(sliceMs);
    const run = async () => {
      for (const key of keys) {
        await pause();
        const i = key.indexOf("/");
        const slug = key.slice(0, i);
        const t = store.getTicket(slug, key.slice(i + 1));
        if (!t?.sessionId) {
          state.delete(key);
          continue;
        }
        own(t.sessionId, key);
        await pollOneSliced(bus, cache, state, new Set(), slug, t, true, pause);
      }
    };
    return (changing = run().catch((e) => console.error("session watcher", e)).finally(() => (changing = null)));
  };
  // The first pass after a start announced every ticket's session (hundreds of events, each built for every open tab:
  // seconds right after a restart). Pages load what they need when they (re)connect, and the notifier takes stock at
  // its start, so the first pass only takes stock. It starts at once (pages wait through cache.ready() until every
  // ticket has a summary to show, the notifier through cache.settled() until the pass is done) and runs in slices; the
  // timer's full passes wait until it is done. Meanwhile, with a live feed, the timer still announces the sessions
  // that change (running tickets' chats keep moving however long the first pass takes on a busy Mac).
  let primed = false;
  let priming = true;
  for (const p of store.listProfiles()) for (const t of store.listTickets(p.slug)) own(t.sessionId, `${p.slug}/${t.id}`);
  void track("session-watcher: first pass", () => primeSessions(store, cache, state, 30, bus))
    .then(() => {
      primed = true;
      lastDone = now();
    }, (e) => console.error("session watcher", e))
    .finally(() => (priming = false));
  let passing = false;
  const timer = trackedInterval("session-watcher", () => {
    try {
      // The first pass or a full one still under way: only what the feed says changed meanwhile.
      if (priming || passing) {
        if (o.feed?.live && !unknown) return changed();
        return;
      }
      if (!primed || !o.feed?.live || unknown || now() - lastFull >= safetyMs) {
        passing = true;
        const emit = primed;
        primed = true;
        return full(emit)
          .catch((e) => console.error("session watcher", e))
          .finally(() => (passing = false));
      }
      return changed();
    } catch (e) {
      console.error("session watcher", e);
    }
  }, intervalMs);
  return () => {
    clearInterval(timer);
    stopStore();
    stopFeed?.();
  };
}
