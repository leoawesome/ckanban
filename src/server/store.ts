import {
  appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  ActivityEntry, Comment, Config, Huddle, HuddleMessage, Job, Loop, LoopState, OutputFile, Profile, Schedule, ScheduleHistoryEntry, Status, Ticket, TicketKind, TicketMode, TicketSource,
} from "./types";
import { cleanAvatars, type SavedAvatarMap } from "./avatars";
import { cleanPresets, type HuddlePreset } from "./huddle-presets";
import { cleanTemplates, type HuddleTemplate } from "./huddle-templates";
import { type HuddleNote, type NoteScope, parseNotes, serializeNotes } from "./huddle-notes";
import { newId, newTicketId, nowIso } from "./util";
import { pauser } from "./lag";
import { atomicWrite } from "./atomic";
import { BOARD_TOOLS_FILE, readBoardTools, type ToolEntry, writeBoardTools } from "./board-tools";
import { maskSaved, maskSavedJson } from "./board-keys";
import { ActivityDigests, type ActivityDigest } from "./activity-digest";
import { forgetLog, gzOf, loadLog, type LogReader, openLog, readLogSync, restoreLog, restoreLogSync } from "./run-log";
import { JsonDir } from "./json-dir";
import { ScheduleHistoryDigests, type ScheduleHistoryDigest } from "./schedule-history";

/** Dependency, build and version-history folders: never deliverables, and they can hold tens of thousands of files. */
const SKIPPED_OUTPUT_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__"]);
/** Most output files listed (newest first); the UI renders every one. */
export const MAX_OUTPUT_FILES = 2000;
/** How often a board's listing stats every ticket file again, to catch edits made outside the Store. */
export const TICKET_RECHECK_MS = 30_000;
const DEFAULT_CONFIG: Config = { port: 7777, prPollMinutes: 5 };

export function defaultRoot(): string {
  return process.env.CKANBAN_HOME ?? join(homedir(), ".claude-kanban");
}

/** One of the Store's own writes (Store.onChange). */
export type StoreChange = { kind: "ticket" | "huddle" | "schedule" | "job"; slug: string; id: string };

export { atomicWrite };

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return parseJsonl<T>(readFileSync(file, "utf8"));
}

function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** About how much of an activity log one page holds (GET ticket activity). */
export const ACTIVITY_PAGE_BYTES = 512 * 1024;

/**
 * One page of a JSONL file read from its end with positioned reads: the whole lines that end before byte `before`
 * (default: the end of the file), about maxBytes of them (more when one line is bigger). Lines that don't parse are
 * skipped, like readJsonl, so a last line still being written is left out until it is complete. The result's
 * `before` is where the page starts (pass it back for the page before); null once the page reaches the first line.
 */
export function readJsonlPage<T>(file: string, opts: { before?: number; maxBytes?: number } = {}): { entries: T[]; before: number | null } {
  if (!existsSync(file)) return { entries: [], before: null };
  const fd = openSync(file, "r");
  try {
    return readPage<T>({ size: statSync(file).size, read: (buf, off, len, pos) => readSync(fd, buf, off, len, pos), close: () => {} }, opts);
  } finally {
    closeSync(fd);
  }
}

/** readJsonlPage over any positioned reader (a plain or compressed run log, run-log.ts). */
export function readPage<T>(log: LogReader, opts: { before?: number; maxBytes?: number } = {}): { entries: T[]; before: number | null } {
  const size = log.size;
  const end = Math.min(Math.max(0, opts.before ?? size), size);
  let want = Math.max(1, opts.maxBytes ?? ACTIVITY_PAGE_BYTES);
  for (;;) {
    const start = Math.max(0, end - want);
    const buf = Buffer.alloc(end - start);
    for (let got = 0; got < buf.length;) {
      const n = log.read(buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    // The chunk starts mid-line unless it starts the file: the page begins after its first newline.
    const skip = start === 0 ? 0 : buf.indexOf(10) + 1;
    if (start > 0 && skip === 0) {
      want *= 2; // one line longer than the page: read more of it
      continue;
    }
    const entries: T[] = [];
    for (const line of buf.subarray(skip).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    // Nothing whole yet (a long last line still being written filled the page): read more.
    if (!entries.length && start > 0) {
      want *= 2;
      continue;
    }
    return { entries, before: start === 0 ? null : start + skip };
  }
}

function parseTicket(raw: string): Ticket {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = YAML.parse(m[1]);
  if (!meta || typeof meta !== "object" || !meta.id) throw new Error("invalid frontmatter");
  return { ...withoutAddOn(meta), body: m[2] ?? "" } as Ticket;
}

/**
 * Add-on tickets are gone: an old add-on link (addOnOf, saved as followUpOf before "follow-up" came to mean a timed
 * wake) loads as a plain family link to the same ticket (partOf, unless it already had one, which won before too) and
 * keeps where it came from (madeFrom). The ticket's parent stays exactly where it was (partOf won over addOnOf, and
 * addOnOf over a plan). Nothing is written on load: the file changes on the ticket's next save, and reading it again
 * gives the same result.
 */
export function withoutAddOn(meta: Record<string, unknown>): Record<string, unknown> {
  if (!("addOnOf" in meta) && !("followUpOf" in meta)) return meta;
  const { addOnOf, followUpOf, ...rest } = meta;
  const from = typeof addOnOf === "string" && addOnOf ? addOnOf : typeof followUpOf === "string" && followUpOf ? followUpOf : null;
  if (!from) return rest;
  return { ...rest, ...(rest.partOf ? {} : { partOf: from, ...(rest.partOfVia ? { partOfVia: null } : {}) }), ...(rest.madeFrom ? {} : { madeFrom: from }) };
}

/**
 * Puts ticket `t` (null: none) where it belongs in a list sorted by order, replacing the entry with its id: kept in
 * place when its order didn't change, else after every ticket with the same or a lower order (where a rebuild puts a
 * newly added ticket).
 */
function placeTicket(list: Ticket[], id: string, t: Ticket | null): void {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0 && t && list[i].order === t.order) {
    list[i] = t;
    return;
  }
  if (i >= 0) list.splice(i, 1);
  if (!t) return;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].order <= t.order) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, t);
}

type FoundOutput = { name: string; size: number; at: number };

/** The newest MAX_OUTPUT_FILES, newest first (ties keep the walk's order), as listOutputs returns them. */
function newestOutputs(found: FoundOutput[]): OutputFile[] {
  // By the time in ms (what updatedAt shows), not by the ISO text: 20,000 string compares were most of the cost.
  return found.sort((a, b) => b.at - a.at).slice(0, MAX_OUTPUT_FILES)
    .map((f) => ({ name: f.name, size: f.size, updatedAt: new Date(f.at).toISOString() }));
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function serializeTicket(t: Ticket): string {
  const { body, ...meta } = t;
  return `---\n${YAML.stringify(meta)}---\n${body}`;
}

/** Board comments that aren't Claude's result ("Run failed: …"; a fresh session's prompt skips them for "Last result"). */
export const BOARD_NOTE_RE = /^(Run failed|Could not start|Run stopped|Planner stopped|Started a fresh session|Started a fresh chat|Took over the session|This ticket's Claude session is still open)/;
/** Tickets whose last summary stays in memory (Store.aiCache). */
const AI_CACHE_MAX = 500;
/** Huddle message logs kept parsed in memory (Store.huddleLogs): the live ones and the last few looked at. */
const HUDDLE_LOGS_MAX = 20;

/** Plain string order (ISO times): the same order as localeCompare for them, much cheaper on big lists. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ID_JSON = /^[a-z0-9]+\.json$/;

function parseJob(raw: string): Job {
  const j = JSON.parse(raw);
  // Older versions kept a late job "missed" until the user ran or skipped it; that step is gone.
  if (j.state === "missed") return { ...j, state: "skipped", result: { ...j.result, message: "was due while the computer was off" } };
  return j;
}

export class Store {
  /** Each board's huddle files, parsed once and kept by file mtime and size (huddleIndex). Open huddles are live. */
  private huddleFiles = new JsonDir<Huddle>({
    match: (f) => /^h_[a-z0-9_]+\.json$/i.test(f), parse: JSON.parse, sort: (a, b) => cmp(a.createdAt, b.createdAt),
    live: (h) => h.status !== "closed",
  });
  /** One-time jobs, schedules and automations per board: parsed once, kept by file mtime and size (json-dir.ts). */
  private jobFiles = new JsonDir<Job>({
    match: (f) => ID_JSON.test(f), parse: parseJob, sort: (a, b) => cmp(a.at, b.at) || cmp(a.createdAt, b.createdAt),
    live: (j) => j.state === "scheduled" || j.state === "running",
  });
  private scheduleFiles = new JsonDir<Schedule>({ match: (f) => ID_JSON.test(f), parse: JSON.parse, sort: (a, b) => cmp(a.createdAt, b.createdAt) });
  private loopFiles = new JsonDir<Loop>({ match: (f) => ID_JSON.test(f), parse: JSON.parse, sort: (a, b) => cmp(a.createdAt, b.createdAt) });
  /** What the schedules list needs from each history file, read only as far as it grew since (schedule-history.ts). */
  private scheduleHistories = new ScheduleHistoryDigests();
  /**
   * Parsed huddle message logs by "<slug>/<huddle>", with the byte offset read up to (see readHuddleMessages). At most
   * HUDDLE_LOGS_MAX, least recently read go first.
   */
  private huddleLogs = new Map<string, { offset: number; msgs: readonly HuddleMessage[] }>();
  /**
   * Each ticket's last Claude comment and last result summary (not a board note), by comments.jsonl path, keyed by its
   * mtime and size. Only two strings per ticket, and at most AI_CACHE_MAX tickets (least recently used go first).
   */
  private aiCache = new Map<string, { key: string; last: string | null; summary: string | null }>();
  /** Writes to each comments.jsonl through addComment in this process (commentStamp). */
  private commentWrites = new Map<string, number>();
  /** What the daemon needs from each run log, read only as far as it grew since (activity-digest.ts). */
  private activityDigests = new ActivityDigests();
  /**
   * Parsed ticket files by path, keyed by mtime and size: the watchers list every board's tickets every few seconds,
   * and parsing their YAML was most of the daemon's CPU.
   */
  private ticketCache = new Map<string, { key: string; ticket: Ticket }>();
  /**
   * Each board's last ticket listing. Store writes update it in place; the files are stat'ed again only when the
   * tickets folder changes (a ticket added or removed from outside) or every TICKET_RECHECK_MS, which catches a
   * ticket.md edited from outside (a planning chat rewrites its body).
   */
  private boards = new Map<string, {
    dirMtime: number; checkedAt: number; ids: Set<string>; list: Ticket[] | null; open: Ticket[] | null; version: number;
    /** The listing's tickets by id, built on demand (peekTicket); a Store write patches it like the list. */
    byId?: Map<string, Ticket> | null;
  }>();
  private now: () => number;
  private changeFns = new Set<(c: StoreChange) => void>();
  constructor(public readonly root: string, opts: { now?: () => number } = {}) {
    mkdirSync(join(root, "profiles"), { recursive: true });
    this.now = opts.now ?? Date.now;
  }

  config(): Config {
    const file = join(this.root, "config.json");
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Pasted images, shared by all profiles (see attachments.ts). */
  get attachmentsDir(): string {
    return join(this.root, "attachments");
  }

  private profileDir(slug: string) {
    return join(this.root, "profiles", slug);
  }

  private ticketDir(slug: string, id: string) {
    return join(this.profileDir(slug), "tickets", id);
  }

  listProfiles(): Profile[] {
    const dir = join(this.root, "profiles");
    return readdirSync(dir)
      .map((s) => this.getProfile(s))
      .filter((p): p is Profile => p !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getProfile(slug: string): Profile | null {
    const file = join(this.profileDir(slug), "profile.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveProfile(p: Profile): void {
    atomicWrite(join(this.profileDir(p.slug), "profile.json"), JSON.stringify(p, null, 2) + "\n");
  }

  /** The board's "only this board" tools file (see board-tools.ts). Deleted with the board. */
  boardToolsPath(slug: string): string {
    return join(this.profileDir(slug), BOARD_TOOLS_FILE);
  }

  /** The board's "only this board" tools, as `mcpServers` entries. Can hold secrets: never log them. */
  boardTools(slug: string): Record<string, ToolEntry> {
    return readBoardTools(this.boardToolsPath(slug));
  }

  saveBoardTools(slug: string, servers: Record<string, ToolEntry>): void {
    writeBoardTools(this.boardToolsPath(slug), servers);
  }

  deleteProfile(slug: string): void {
    rmSync(this.profileDir(slug), { recursive: true, force: true });
  }

  ticketPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "ticket.md");
  }

  /**
   * The board's tickets by order. The tickets are shared and frozen: copy one before changing it
   * (`{ ...t }`, or structuredClone for its lists). The array is the caller's own.
   */
  listTickets(slug: string): Ticket[] {
    return [...this.ticketList(slug)];
  }

  /**
   * The board's tickets that aren't Done, by order: the open work, without going through thousands of Done tickets.
   * Kept like the full list (a Store write patches it). Tickets shared and frozen; the array is the caller's own.
   */
  listOpenTickets(slug: string): Ticket[] {
    return [...this.openList(slug)];
  }

  private openList(slug: string): readonly Ticket[] {
    this.ticketList(slug);
    const b = this.boards.get(slug);
    if (!b?.list) return [];
    b.open ??= b.list.filter((t) => t.status !== "done");
    return b.open;
  }

  /** The board's cached ticket list, brought up to date (shared: never hand it out or change it). */
  private ticketList(slug: string): readonly Ticket[] {
    const dir = join(this.profileDir(slug), "tickets");
    let dirMtime: number;
    try {
      dirMtime = statSync(dir).mtimeMs;
    } catch {
      this.boards.delete(slug);
      return [];
    }
    const b = this.boards.get(slug);
    // With rechecks in the background (recheckTickets), a listing never stats every ticket file just because time passed.
    const recent = !!b && b.dirMtime === dirMtime && (this.rechecking || this.now() - b.checkedAt < TICKET_RECHECK_MS);
    if (b?.list && recent) return b.list;
    const ids = new Set<string>();
    const out: Ticket[] = [];
    if (b && recent) {
      // Only Store writes since the last listing: they keep ticketCache current, no need to stat every file.
      for (const id of b.ids) {
        const hit = this.ticketCache.get(this.ticketPath(slug, id))?.ticket ?? this.readTicketOrCorrupt(slug, id);
        if (hit) (ids.add(id), out.push(hit));
      }
    } else {
      for (const id of readdirSync(dir)) {
        const t = this.readTicketOrCorrupt(slug, id);
        if (t) (ids.add(id), out.push(t));
      }
    }
    return this.remember(slug, dirMtime, b && recent ? b.checkedAt : this.now(), ids, out);
  }

  /** Keeps a freshly built listing (sorted here); its version moves on when it differs from the last one. */
  private remember(slug: string, dirMtime: number, checkedAt: number, ids: Set<string>, out: Ticket[]): Ticket[] {
    const b = this.boards.get(slug);
    const prev = b?.list;
    out.sort((x, y) => x.order - y.order);
    const changed = !prev || prev.length !== out.length || out.some((t, i) => t !== prev[i]);
    const version = (b?.version ?? 0) + (changed && b ? 1 : 0);
    this.boards.set(slug, { dirMtime, checkedAt, ids, list: out, open: null, version, byId: null });
    return out;
  }

  /**
   * listTickets, except that a board not read yet (the first listing after a start) reads its ticket files in slices,
   * pausing every ~sliceMs, instead of all in one go: on a big board that froze the daemon for a second or more.
   */
  async listTicketsSliced(slug: string, sliceMs = 30): Promise<Ticket[]> {
    if (this.boards.get(slug)?.list) return this.listTickets(slug);
    const dir = join(this.profileDir(slug), "tickets");
    let dirMtime: number;
    let names: string[];
    try {
      dirMtime = statSync(dir).mtimeMs;
      names = readdirSync(dir);
    } catch {
      return this.listTickets(slug);
    }
    const startedAt = this.now();
    const pause = pauser(sliceMs);
    // Each ticket read, and whether it came from ticketCache (a corrupt file's placeholder isn't cached).
    const got = new Map<string, { t: Ticket; cached: boolean }>();
    for (const id of names) {
      await pause();
      const t = this.readTicketOrCorrupt(slug, id);
      if (t) got.set(id, { t, cached: this.ticketCache.get(this.ticketPath(slug, id))?.ticket === t });
    }
    // Another listing or a Store write got there first while this one paused: the normal path is current and cheap now.
    if (this.boards.get(slug)?.list) return this.listTickets(slug);
    // Store writes during the pauses found no list to patch (saved()): take what they left in ticketCache (no file
    // read), so a ticket changed or moved after the read passed it doesn't stay old in the list. Gone from the cache:
    // deleted meanwhile. A new ticket made meanwhile changed the folder: read the names again, only new ones are read.
    const ids = new Set<string>();
    const out: Ticket[] = [];
    for (const [id, r] of got) {
      const hit = this.ticketCache.get(this.ticketPath(slug, id));
      if (hit) (ids.add(id), out.push(hit.ticket));
      else if (!r.cached) (ids.add(id), out.push(r.t));
    }
    try {
      const now = statSync(dir).mtimeMs;
      if (now !== dirMtime) {
        dirMtime = now;
        const names = readdirSync(dir);
        // Gone meanwhile without a Store write (removed from outside, or a corrupt ticket the Store deleted): dropped.
        const there = new Set(names);
        for (let i = out.length - 1; i >= 0; i--) if (!there.has(out[i].id)) (ids.delete(out[i].id), out.splice(i, 1));
        for (const id of names) {
          if (got.has(id)) continue;
          const t = this.readTicketOrCorrupt(slug, id);
          if (t) (ids.add(id), out.push(t));
        }
      }
    } catch {}
    return [...this.remember(slug, dirMtime, startedAt, ids, out)];
  }

  /** Reads every board's tickets in slices (listTicketsSliced), so the first listings after a start are quick. */
  async loadAllTickets(sliceMs = 30): Promise<void> {
    for (const p of this.listProfiles()) await this.listTicketsSliced(p.slug, sliceMs);
  }

  /** Set by recheckTickets(): the daemon rechecks the ticket files in the background, listings don't. */
  private rechecking = false;

  /**
   * Stats every board's ticket files again, in slices (pausing every ~sliceMs), to catch edits made outside the Store;
   * a changed one shows in the next listing. Once called, listTickets leaves this to it (the daemon calls it every
   * TICKET_RECHECK_MS): stat'ing a big board's every file inside a listing froze the daemon for seconds on a busy Mac.
   */
  async recheckTickets(sliceMs = 30): Promise<void> {
    this.rechecking = true;
    const pause = pauser(sliceMs);
    for (const p of this.listProfiles()) {
      const dir = join(this.profileDir(p.slug), "tickets");
      let ids: string[];
      try {
        ids = readdirSync(dir);
      } catch {
        continue;
      }
      const startedAt = this.now();
      for (const id of ids) {
        await pause();
        this.readTicketOrCorrupt(p.slug, id);
      }
      const b = this.boards.get(p.slug);
      if (b) b.checkedAt = Math.max(b.checkedAt, startedAt);
    }
  }

  /** A number that changes whenever the board's ticket listing changes (Store writes at once; outside edits by the next re-check). */
  ticketsVersion(slug: string): number {
    // The shared list: copying the whole listing per call (once per card that shows other tickets) added up.
    this.ticketList(slug);
    return this.boards.get(slug)?.version ?? 0;
  }

  /**
   * The ticket as the board's listing holds it, without a stat of its file (getTicket stats it): for walking links
   * between tickets (the tickets above a card) many times per page. Shared and frozen; undefined when not listed.
   */
  peekTicket(slug: string, id: string): Ticket | undefined {
    const list = this.ticketList(slug);
    const b = this.boards.get(slug);
    if (!b?.list) return undefined;
    b.byId ??= new Map(list.map((t) => [t.id, t]));
    return b.byId.get(id);
  }

  /** null when the ticket file doesn't exist. Parses only when the file changed (see ticketCache); the ticket is shared and frozen. */
  private readTicketOrCorrupt(slug: string, id: string): Ticket | null {
    const file = this.ticketPath(slug, id);
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      if (this.ticketCache.delete(file)) this.touchBoard(slug);
      return null;
    }
    const hit = this.ticketCache.get(file);
    if (hit?.key === key) return hit.ticket;
    try {
      const ticket = deepFreeze(parseTicket(readFileSync(file, "utf8")));
      // A ticket we knew changed outside the store: the board's listing must show it now, not at the next re-check.
      if (hit) this.touchBoard(slug);
      this.ticketCache.set(file, { key, ticket });
      return ticket;
    } catch (e) {
      const at = nowIso();
      return deepFreeze({
        id, title: id, status: "backlog", order: 0, sessionId: null, worktree: null, branch: null,
        prUrl: null, outcome: null, lastActivity: null, lastRunAt: null, runCount: 0,
        error: `corrupt ticket file: ${(e as Error).message}`, createdAt: at, updatedAt: at, body: "",
      });
    }
  }

  /**
   * After a Store write: cache the saved ticket (null: deleted) and patch the board's listing in place (replace,
   * insert or remove that one ticket), instead of rebuilding and re-sorting all of it.
   */
  private saved(slug: string, id: string, t: Ticket | null): void {
    const file = this.ticketPath(slug, id);
    const b = this.boards.get(slug);
    let cached: Ticket | null = null;
    if (t) {
      const st = statSync(file);
      cached = deepFreeze(structuredClone(t));
      this.ticketCache.set(file, { key: `${st.mtimeMs}:${st.size}`, ticket: cached });
      b?.ids.add(id);
    } else {
      this.ticketCache.delete(file);
      b?.ids.delete(id);
    }
    if (b) {
      // Our own mkdir or rmdir changed the folder's mtime: take it, so the listing isn't fully re-read for it.
      try {
        b.dirMtime = statSync(join(this.profileDir(slug), "tickets")).mtimeMs;
      } catch {}
      if (b.list) {
        placeTicket(b.list, id, cached);
        if (b.open) placeTicket(b.open, id, cached && cached.status !== "done" ? cached : null);
        if (b.byId) cached ? b.byId.set(id, cached) : b.byId.delete(id);
        b.version++;
      }
    }
    this.changed({ kind: "ticket", slug, id });
  }

  /** Calls fn after each of this Store's own writes to a ticket, huddle, schedule or job (not outside edits). */
  onChange(fn: (c: StoreChange) => void): () => void {
    this.changeFns.add(fn);
    return () => this.changeFns.delete(fn);
  }

  private changed(c: StoreChange): void {
    for (const fn of this.changeFns) {
      try {
        fn(c);
      } catch (e) {
        console.error("store change listener", e);
      }
    }
  }

  private touchBoard(slug: string): void {
    const b = this.boards.get(slug);
    if (b) (b.list = null), (b.open = null), (b.byId = null);
  }

  getTicket(slug: string, id: string): Ticket | null {
    return this.readTicketOrCorrupt(slug, id);
  }

  nextOrder(slug: string, status: Status): number {
    let max = -Infinity;
    for (const t of this.columnSource(slug, status)) if (t.status === status && t.order > max) max = t.order;
    return max === -Infinity ? 1 : max + 1;
  }

  topOrder(slug: string, status: Status): number {
    let min = Infinity;
    for (const t of this.columnSource(slug, status)) if (t.status === status && t.order < min) min = t.order;
    return min === Infinity ? 1 : min - 1;
  }

  /** The tickets a column's position is worked out from: only the open ones, unless it is Done. */
  private columnSource(slug: string, status: Status): readonly Ticket[] {
    if (status !== "done") return this.openList(slug);
    return this.ticketList(slug);
  }

  /** Where a ticket lands when it enters a column: on top, except Ready, which is a FIFO run queue. */
  entryOrder(slug: string, status: Status): number {
    return status === "ready" ? this.nextOrder(slug, status) : this.topOrder(slug, status);
  }

  createTicket(
    slug: string,
    input: {
      title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; jobId?: string; source?: TicketSource; parentId?: string; planKey?: string; dependsOn?: string[];
      needs?: string[]; tags?: string[]; important?: boolean; partOf?: string; partOfVia?: "chat";
      model?: string | null; raisedBy?: { scheduleId: string; ticketId: string } | null; proposedAs?: string; madeFrom?: string; kind?: TicketKind | null;
      effort?: string | null; main?: boolean; tool?: boolean; startFrom?: string | null; waitsForStart?: boolean;
    },
  ): Ticket {
    const at = nowIso();
    const t: Ticket = {
      id: newTicketId(), title: input.title, status: input.status, mode: input.mode ?? "auto", order: this.entryOrder(slug, input.status),
      sessionId: null, worktree: null, branch: null, prUrl: null, outcome: null, lastActivity: null,
      lastRunAt: null, runCount: 0, error: null, createdAt: at, updatedAt: at, body: input.body,
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.planKey ? { planKey: input.planKey } : {}),
      ...(input.proposedAs ? { proposedAs: input.proposedAs } : {}),
      ...(input.madeFrom ? { madeFrom: input.madeFrom } : {}),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      ...(input.needs?.length ? { needs: input.needs } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.important ? { important: true } : {}),
      ...(input.partOf ? { partOf: input.partOf, ...(input.partOfVia ? { partOfVia: input.partOfVia } : {}) } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.raisedBy ? { raisedBy: input.raisedBy } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.main ? { main: true } : {}),
      ...(input.waitsForStart ? { waitsForStart: true } : {}),
      ...(input.tool ? { tool: true } : {}),
      ...(input.startFrom ? { startFrom: input.startFrom } : {}),
    };
    atomicWrite(this.ticketPath(slug, t.id), serializeTicket(t));
    this.saved(slug, t.id, t);
    return t;
  }

  updateTicket(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    const current = parseTicket(readFileSync(this.ticketPath(slug, id), "utf8"));
    const next: Ticket = { ...current, ...patch, id, updatedAt: nowIso() };
    // Changing column without an explicit position (drag drop) places the ticket by entryOrder().
    if (patch.status !== undefined && patch.status !== current.status && patch.order === undefined) {
      next.order = this.entryOrder(slug, patch.status);
    }
    if (patch.body === undefined) next.body = current.body;
    if (next.status === "done" && current.status !== "done") next.doneAt = next.updatedAt;
    // Every status change is saved here, so a pin always ends when the ticket reaches Done (the user's drag, a run, the CLI, MCP).
    if (next.status === "done" && next.pinnedAt) next.pinnedAt = null;
    atomicWrite(this.ticketPath(slug, id), serializeTicket(next));
    this.saved(slug, id, next);
    return next;
  }

  deleteTicket(slug: string, id: string): void {
    rmSync(this.ticketDir(slug, id), { recursive: true, force: true });
    this.saved(slug, id, null);
  }

  /** Folder where runs save deliverables (reports etc.) for the user to read on the board. */
  outputsDir(slug: string, id: string): string {
    const dir = join(this.ticketDir(slug, id), "outputs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Absolute path of the outputs folder, without creating it (shown in the Share menu). */
  outputsPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "outputs");
  }

  /** Give a branched ticket its own copy of the source's deliverables. */
  copyOutputs(slug: string, from: string, to: string): void {
    const src = join(this.ticketDir(slug, from), "outputs");
    if (existsSync(src)) cpSync(src, join(this.ticketDir(slug, to), "outputs"), { recursive: true });
  }

  /**
   * The ticket's output files, newest first. Skips dependency and build folders (a run that copied a project into its
   * outputs once left 70k files there, and listing them all froze the browser), doesn't follow symlinks, and keeps
   * at most MAX_OUTPUT_FILES.
   */
  listOutputs(slug: string, id: string): OutputFile[] {
    const dir = join(this.ticketDir(slug, id), "outputs");
    if (!existsSync(dir)) return [];
    const found: FoundOutput[] = [];
    // A folder or file removed while this walks (a helper's copy being cleaned up, output-copies.ts) is left out.
    const walk = (sub: string) => {
      let names: string[];
      try {
        names = readdirSync(join(dir, sub));
      } catch {
        return;
      }
      for (const name of names) {
        const rel = sub ? `${sub}/${name}` : name;
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(join(dir, rel));
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIPPED_OUTPUT_DIRS.has(name)) walk(rel);
        } else if (st.isFile()) found.push({ name: rel, size: st.size, at: st.mtime.getTime() });
      }
    };
    walk("");
    return newestOutputs(found);
  }

  /**
   * listOutputs for the daemon's requests: the same result, but the folders are read and the files stat'ed off the
   * event loop (64 at a time), with a pause every ~30ms of work, so 20,000 files don't freeze the board.
   */
  async listOutputsAsync(slug: string, id: string): Promise<OutputFile[]> {
    const dir = join(this.ticketDir(slug, id), "outputs");
    const found: FoundOutput[] = [];
    const pause = pauser();
    const walk = async (sub: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdirAsync(join(dir, sub));
      } catch (e) {
        // No outputs folder, or a subfolder removed meanwhile (a helper's copy being cleaned up): left out.
        if (sub && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        return;
      }
      for (let i = 0; i < names.length; i += 64) {
        const batch = names.slice(i, i + 64).map((name) => (sub ? `${sub}/${name}` : name));
        // A file removed between the folder read and its stat is left out.
        const stats = await Promise.all(batch.map((rel) => lstatAsync(join(dir, rel)).catch(() => null)));
        for (let k = 0; k < batch.length; k++) {
          const st = stats[k];
          const rel = batch[k];
          if (!st) continue;
          if (st.isDirectory()) {
            if (!SKIPPED_OUTPUT_DIRS.has(rel.slice(rel.lastIndexOf("/") + 1))) await walk(rel);
          } else if (st.isFile()) found.push({ name: rel, size: st.size, at: st.mtime.getTime() });
        }
        await pause();
      }
    };
    await walk("");
    return newestOutputs(found);
  }

  /** Resolve an output file path, refusing anything outside the ticket's outputs folder. */
  outputPath(slug: string, id: string, name: string): string | null {
    const dir = join(this.ticketDir(slug, id), "outputs");
    const file = resolve(dir, name);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  }

  listComments(slug: string, id: string): Comment[] {
    return readJsonl<Comment>(join(this.ticketDir(slug, id), "comments.jsonl"));
  }

  /** Text of the ticket's last Claude comment (its last result summary). */
  lastAiComment(slug: string, id: string): string | null {
    return this.aiTail(slug, id).last;
  }

  /** The ticket's last result summary: its newest Claude comment that isn't a board note (BOARD_NOTE_RE); null for none. */
  lastAiSummary(slug: string, id: string): string | null {
    return this.aiTail(slug, id).summary;
  }

  /**
   * Changes whenever addComment writes the ticket's comments: lets a cache built from lastAiSummary (the recall index)
   * skip a stat per ticket. Only the daemon writes comments.jsonl; a hand edit shows after the ticket changes or a restart.
   */
  commentStamp(slug: string, id: string): number {
    return this.commentWrites.get(join(this.ticketDir(slug, id), "comments.jsonl")) ?? 0;
  }

  private aiTail(slug: string, id: string): { last: string | null; summary: string | null } {
    const file = join(this.ticketDir(slug, id), "comments.jsonl");
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return { last: null, summary: null };
    }
    const hit = this.aiCache.get(file);
    if (hit?.key === key) {
      this.aiCache.delete(file);
      this.aiCache.set(file, hit);
      return hit;
    }
    const ai = this.aiComments(slug, id);
    const entry = { key, last: ai.at(-1)?.text ?? null, summary: ai.findLast((c) => !BOARD_NOTE_RE.test(c.text))?.text ?? null };
    this.aiCache.delete(file);
    this.aiCache.set(file, entry);
    if (this.aiCache.size > AI_CACHE_MAX) this.aiCache.delete(this.aiCache.keys().next().value!);
    return entry;
  }

  /** The ticket's Claude comments (its result summaries), oldest first. Reads the file: for one ticket at a time. */
  aiComments(slug: string, id: string): Comment[] {
    return this.listComments(slug, id).filter((c) => c.author === "ai");
  }

  addComment(slug: string, id: string, author: Comment["author"], text: string, from?: string): Comment {
    // A saved key never lands in the ticket's files, even if a run's summary or a message quotes one.
    const c: Comment = { id: newId(), author, text: maskSaved(this.root, text), at: nowIso(), ...(from ? { from } : {}) };
    const file = join(this.ticketDir(slug, id), "comments.jsonl");
    appendFileSync(file, JSON.stringify(c) + "\n");
    this.commentWrites.set(file, (this.commentWrites.get(file) ?? 0) + 1);
    return c;
  }

  appendActivity(slug: string, id: string, run: number, event: unknown): void {
    const e: ActivityEntry = { run, at: nowIso(), event };
    const file = this.activityPath(slug, id);
    // A log compressed while the ticket sat in Done (run-log-compress.ts) comes back before anything is added to it.
    // The board restores it before a run starts (restoreActivity); this is the safety net, checked once per log.
    if (!this.appendChecked.has(file)) {
      if (existsSync(gzOf(file))) restoreLogSync(file);
      this.appendChecked.add(file);
      if (this.appendChecked.size > 5000) this.appendChecked.delete(this.appendChecked.values().next().value!);
    }
    // Run output that shows a saved key (a command that printed it) is stored with the key hidden.
    appendFileSync(file, maskSavedJson(this.root, JSON.stringify(e)) + "\n");
  }

  /** Logs appended to since this daemon started (their compressed copy, if any, was restored first). */
  private appendChecked = new Set<string>();

  /** Brings a compressed run log back (run-log.ts restoreLog), off the event loop; the board calls it before a run. */
  async restoreActivity(slug: string, id: string): Promise<void> {
    const file = this.activityPath(slug, id);
    await restoreLog(file);
    this.appendChecked.add(file);
  }

  /** The run log was just compressed (run-log-compress.ts): the next append checks for the copy again. */
  activityCompressed(slug: string, id: string): void {
    const file = this.activityPath(slug, id);
    this.appendChecked.delete(file);
    forgetLog(file);
  }

  activityPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "activity.jsonl");
  }

  /** Side calls' cost (side-call.ts): counts in the ticket's spend, never in its activity log or session. */
  sideSpendPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "side-spend.jsonl");
  }

  /** Plain-words versions of the ticket's Claude replies, by message (simplify.ts). */
  simplifiedPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "simplified.json");
  }

  /** The Context panel's last `/context` result for the ticket's chat (context-usage.ts). */
  contextPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "context.json");
  }

  /** "Help me understand" answers shown as cards in the ticket's chat (explain.ts). */
  helpPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "help.json");
  }

  /** The whole run log, parsed. Tens of MB on a busy ticket: the daemon uses activityDigest or readActivityPage instead. */
  readActivity(slug: string, id: string): ActivityEntry[] {
    const bytes = readLogSync(this.activityPath(slug, id));
    return bytes ? parseJsonl<ActivityEntry>(bytes.toString("utf8")) : [];
  }

  /** Changed files, runs and session totals from the run log, reading only what was appended since last time, in slices. */
  activityDigest(slug: string, id: string, pause?: () => Promise<void>): Promise<ActivityDigest> {
    return this.activityDigests.get(this.activityPath(slug, id), pause);
  }

  /** activityDigest without pausing, for callers that can't wait: warm it first (activityDigest) so this reads only a tail. */
  activityDigestNow(slug: string, id: string): ActivityDigest {
    return this.activityDigests.getNow(this.activityPath(slug, id));
  }

  /** The newest page of the activity log, or the page before byte `before` (readJsonlPage). */
  readActivityPage(slug: string, id: string, before?: number, maxBytes?: number): { entries: ActivityEntry[]; before: number | null } {
    const log = openLog(this.activityPath(slug, id));
    if (!log) return { entries: [], before: null };
    try {
      return readPage<ActivityEntry>(log, { before, maxBytes });
    } finally {
      log.close();
    }
  }

  /** readActivityPage, decompressing a compressed log off the event loop first (then kept for the next pages). */
  async readActivityPageAsync(slug: string, id: string, before?: number, maxBytes?: number): Promise<{ entries: ActivityEntry[]; before: number | null }> {
    await loadLog(this.activityPath(slug, id));
    return this.readActivityPage(slug, id, before, maxBytes);
  }

  /** Decompresses the ticket's run log off the event loop when it is compressed, so sync readers after it don't. */
  loadActivity(slug: string, id: string): Promise<void> {
    return loadLog(this.activityPath(slug, id));
  }

  private schedulesDir(slug: string) {
    return join(this.profileDir(slug), "schedules");
  }

  /** The board's schedules, oldest first. Shared and frozen: copy one before changing it. */
  listSchedules(slug: string): readonly Schedule[] {
    return this.scheduleFiles.list(this.schedulesDir(slug));
  }

  getSchedule(slug: string, id: string): Schedule | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    const file = join(this.schedulesDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveSchedule(slug: string, s: Schedule): void {
    const dir = this.schedulesDir(slug);
    const before = this.scheduleFiles.mtime(dir);
    atomicWrite(join(dir, `${s.id}.json`), JSON.stringify(s, null, 2) + "\n");
    this.scheduleFiles.saved(dir, `${s.id}.json`, s, before);
    this.changed({ kind: "schedule", slug, id: s.id });
  }

  deleteSchedule(slug: string, id: string): void {
    const dir = this.schedulesDir(slug);
    const before = this.scheduleFiles.mtime(dir);
    rmSync(join(dir, `${id}.json`), { force: true });
    rmSync(join(dir, `${id}.history.jsonl`), { force: true });
    this.scheduleFiles.saved(dir, `${id}.json`, null, before);
    this.changed({ kind: "schedule", slug, id });
  }

  appendScheduleHistory(slug: string, id: string, e: ScheduleHistoryEntry): void {
    const dir = this.schedulesDir(slug);
    mkdirSync(dir, { recursive: true });
    // The first line makes a new file there: the schedule list's cache takes the folder's new mtime instead of a rescan.
    const before = this.scheduleFiles.mtime(dir);
    appendFileSync(join(dir, `${id}.history.jsonl`), JSON.stringify(e) + "\n");
    this.scheduleFiles.touched(dir, before);
  }

  /** The whole history, parsed. Can grow for years: the daemon uses scheduleHistoryTail or scheduleHistoryDigest. */
  readScheduleHistory(slug: string, id: string): ScheduleHistoryEntry[] {
    return readJsonl<ScheduleHistoryEntry>(join(this.schedulesDir(slug), `${id}.history.jsonl`));
  }

  /**
   * The newest history entries, at least `min` of them (all when the file has fewer; then complete is true), oldest
   * first. Reads the file from its end.
   */
  scheduleHistoryTail(slug: string, id: string, min: number): { entries: ScheduleHistoryEntry[]; complete: boolean } {
    const file = join(this.schedulesDir(slug), `${id}.history.jsonl`);
    const pages: ScheduleHistoryEntry[][] = [];
    let n = 0;
    let before: number | undefined;
    for (;;) {
      const page = readJsonlPage<ScheduleHistoryEntry>(file, { before, maxBytes: 64 * 1024 });
      pages.unshift(page.entries);
      n += page.entries.length;
      if (page.before === null) return { entries: pages.flat(), complete: true };
      if (n >= min) return { entries: pages.flat(), complete: false };
      before = page.before;
    }
  }

  /** The schedules list's figures from the history (totals, last pause, recent entries), kept up to date by mtime and size. */
  scheduleHistoryDigest(slug: string, id: string): ScheduleHistoryDigest {
    return this.scheduleHistories.get(join(this.schedulesDir(slug), `${id}.history.jsonl`));
  }

  /** scheduleHistoryDigest with a pause between reads (a big history read for the first time), for requests. */
  scheduleHistoryDigestAsync(slug: string, id: string, pause: () => Promise<void>): Promise<ScheduleHistoryDigest> {
    return this.scheduleHistories.getAsync(join(this.schedulesDir(slug), `${id}.history.jsonl`), pause);
  }

  private loopsDir(slug: string) {
    return join(this.profileDir(slug), "loops");
  }

  /** An automation's check script, next to its settings (the loop keeps the hash it was saved with). */
  loopScriptFile(slug: string, id: string): string {
    return join(this.loopsDir(slug), `${id}.sh`);
  }

  saveLoopScript(slug: string, id: string, script: string): void {
    atomicWrite(this.loopScriptFile(slug, id), script);
  }

  /** The board's automations, oldest first. Shared and frozen: copy one before changing it. */
  listLoops(slug: string): readonly Loop[] {
    return this.loopFiles.list(this.loopsDir(slug));
  }

  getLoop(slug: string, id: string): Loop | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    const file = join(this.loopsDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveLoop(slug: string, l: Loop): void {
    const dir = this.loopsDir(slug);
    const before = this.loopFiles.mtime(dir);
    atomicWrite(join(dir, `${l.id}.json`), JSON.stringify(l, null, 2) + "\n");
    this.loopFiles.saved(dir, `${l.id}.json`, l, before);
  }

  deleteLoop(slug: string, id: string): void {
    const dir = this.loopsDir(slug);
    const before = this.loopFiles.mtime(dir);
    rmSync(join(dir, `${id}.json`), { force: true });
    rmSync(join(dir, `${id}.state.json`), { force: true });
    rmSync(this.loopScriptFile(slug, id), { force: true });
    this.loopFiles.saved(dir, `${id}.json`, null, before);
  }

  getLoopState(slug: string, id: string): LoopState {
    const file = join(this.loopsDir(slug), `${id}.state.json`);
    const empty: LoopState = { seen: [], primed: false, failures: 0, backoffUntil: null, lastFound: 0, lastItems: [] };
    if (!existsSync(file)) return empty;
    try {
      return { ...empty, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return empty;
    }
  }

  saveLoopState(slug: string, id: string, s: LoopState): void {
    atomicWrite(join(this.loopsDir(slug), `${id}.state.json`), JSON.stringify(s) + "\n");
  }

  private jobsDir(slug: string) {
    return join(this.profileDir(slug), "jobs");
  }

  /** One-time jobs (jobs.ts), oldest due first. Shared and frozen: copy one before changing it. */
  listJobs(slug: string): readonly Job[] {
    return this.jobFiles.list(this.jobsDir(slug));
  }

  /** Only the jobs still to run or running (what the job tick needs), oldest due first. Shared and frozen. */
  openJobs(slug: string): readonly Job[] {
    return this.jobFiles.liveList(this.jobsDir(slug));
  }

  getJob(slug: string, id: string): Job | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    const file = join(this.jobsDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return parseJob(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveJob(slug: string, j: Job): void {
    const dir = this.jobsDir(slug);
    const before = this.jobFiles.mtime(dir);
    atomicWrite(join(dir, `${j.id}.json`), JSON.stringify(j, null, 2) + "\n");
    this.jobFiles.saved(dir, `${j.id}.json`, j, before);
    this.changed({ kind: "job", slug, id: j.id });
  }

  /**
   * Reads every board's huddles, jobs, schedules and automations not read yet, pausing every ~sliceMs: the first read
   * of a board with thousands of them froze the daemon. After it, their lists are cache hits.
   */
  async loadAllLists(sliceMs = 30): Promise<void> {
    const pause = pauser(sliceMs);
    for (const p of this.listProfiles()) {
      await this.huddleFiles.load(this.huddlesDir(p.slug), pause);
      await this.jobFiles.load(this.jobsDir(p.slug), pause);
      await this.scheduleFiles.load(this.schedulesDir(p.slug), pause);
      await this.loopFiles.load(this.loopsDir(p.slug), pause);
    }
  }

  /**
   * Stats every board's huddle, job, schedule and automation files again in slices (JsonDir.recheck), to catch one
   * edited in place from outside. Once called, list reads leave this to it (the daemon calls it every JSON_DIR_RECHECK_MS).
   */
  async recheckLists(sliceMs = 30): Promise<void> {
    const pause = pauser(sliceMs);
    for (const p of this.listProfiles()) {
      await this.huddleFiles.recheck(this.huddlesDir(p.slug), pause);
      await this.jobFiles.recheck(this.jobsDir(p.slug), pause);
      await this.scheduleFiles.recheck(this.schedulesDir(p.slug), pause);
      await this.loopFiles.recheck(this.loopsDir(p.slug), pause);
    }
  }

  /** Huddle presets at one level: a board's own (slug), or the global ones every board gets (slug null). Merge with mergePresets. */
  listHuddlePresets(slug: string | null): HuddlePreset[] {
    return this.readList(this.levelFile(slug, "huddle-presets.json"), cleanPresets);
  }

  saveHuddlePresets(slug: string | null, ps: HuddlePreset[]): void {
    atomicWrite(this.levelFile(slug, "huddle-presets.json"), JSON.stringify(ps, null, 2) + "\n");
  }

  /** Huddle templates at one level: a board's own (slug), or the global ones (slug null). Merge with mergeTemplates. */
  listHuddleTemplates(slug: string | null): HuddleTemplate[] {
    return this.readList(this.levelFile(slug, "huddle-templates.json"), cleanTemplates);
  }

  saveHuddleTemplates(slug: string | null, ts: HuddleTemplate[]): void {
    atomicWrite(this.levelFile(slug, "huddle-templates.json"), JSON.stringify(ts, null, 2) + "\n");
  }

  /** The user's avatar choices, shared by every board (<home>/avatars.json). Missing or damaged: none (defaults show). */
  listAvatars(): SavedAvatarMap {
    const file = join(this.root, "avatars.json");
    if (!existsSync(file)) return {};
    try {
      return cleanAvatars(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return {};
    }
  }

  saveAvatars(map: SavedAvatarMap): void {
    atomicWrite(join(this.root, "avatars.json"), JSON.stringify(cleanAvatars(map), null, 2) + "\n");
  }

  /** <home>/<name> for the global level (slug null), else the board's profiles/<slug>/<name>. */
  private levelFile(slug: string | null, name: string): string {
    return join(slug === null ? this.root : this.profileDir(slug), name);
  }

  private readList<T>(file: string, clean: (v: unknown) => T[]): T[] {
    if (!existsSync(file)) return [];
    try {
      return clean(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return [];
    }
  }

  /** A role's notes file: general ones are global (<home>/huddle-notes), repo ones the board's. role: "_all" or a preset name. */
  huddleNotesPath(slug: string, role: string, scope: NoteScope): string {
    return join(scope === "general" ? this.root : this.profileDir(slug), "huddle-notes", `${role}.md`);
  }

  /** A role's notes, newest first. */
  readHuddleNotes(slug: string, role: string, scope: NoteScope): HuddleNote[] {
    const file = this.huddleNotesPath(slug, role, scope);
    return existsSync(file) ? parseNotes(readFileSync(file, "utf8")) : [];
  }

  writeHuddleNotes(slug: string, role: string, scope: NoteScope, notes: HuddleNote[]): void {
    atomicWrite(this.huddleNotesPath(slug, role, scope), serializeNotes(role, scope, notes));
  }

  /** Roles with a notes file (general or this board's repo notes). */
  huddleNoteRoles(slug: string): string[] {
    return [...new Set([...this.noteFileRoles(slug, "general"), ...this.noteFileRoles(slug, "repo")])].sort();
  }

  /** Roles with a notes file in one scope (general: every board's; repo: this board's). */
  noteFileRoles(slug: string, scope: NoteScope): string[] {
    const dir = join(scope === "general" ? this.root : this.profileDir(slug), "huddle-notes");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [];
  }

  /** What the board learned on its own (learn.ts): the pile and the change log, shared by every board. */
  learnedDir(): string {
    return join(this.root, "learned");
  }

  /** The rules the board learned from the user's corrections; every run on the board gets them (learn.ts). */
  boardRulesPath(slug: string): string {
    return join(this.profileDir(slug), "learned-rules.md");
  }

  private huddlesDir(slug: string) {
    return join(this.profileDir(slug), "huddles");
  }

  /**
   * The board's huddles, oldest first, parsed once and shared (frozen): read only (listHuddles gives copies to change).
   * Kept per file by mtime and size (json-dir.ts): a save replaces its one entry; open huddles' files are stat'ed on
   * every read; a change to the folder from outside re-stats the names and reads only the files that changed.
   */
  huddleIndex(slug: string): readonly Huddle[] {
    return this.huddleFiles.list(this.huddlesDir(slug));
  }

  /**
   * Reads the board's huddles in slices if they aren't read yet (a no-op stat once they are). For pages that need them
   * right after a start, before loadAllLists got to this board: huddleIndex would read thousands of files in one go.
   */
  async loadHuddles(slug: string, sliceMs = 30): Promise<void> {
    await this.huddleFiles.load(this.huddlesDir(slug), pauser(sliceMs));
  }

  /** The board's huddles that aren't closed, oldest first. Shared and frozen. */
  openHuddles(slug: string): readonly Huddle[] {
    return this.huddleFiles.liveList(this.huddlesDir(slug));
  }

  /** The board's huddles, oldest first, as copies the caller may change. Copies every huddle: prefer huddleIndex. */
  listHuddles(slug: string): Huddle[] {
    return structuredClone(this.huddleIndex(slug) as Huddle[]);
  }

  /** Change marker for the board's huddle files: a new value whenever the huddle list changed. */
  huddlesVersion(slug: string): string {
    return String(this.huddleFiles.version(this.huddlesDir(slug)));
  }

  getHuddle(slug: string, id: string): Huddle | null {
    if (!/^h_[a-z0-9_]+$/i.test(id)) return null;
    const file = join(this.huddlesDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  saveHuddle(slug: string, h: Huddle): void {
    const dir = this.huddlesDir(slug);
    const before = this.huddleFiles.mtime(dir);
    atomicWrite(join(dir, `${h.id}.json`), JSON.stringify(h, null, 2) + "\n");
    this.huddleFiles.saved(dir, `${h.id}.json`, h, before);
    this.changed({ kind: "huddle", slug, id: h.id });
  }

  /** Identifies one version of the huddle file (inode and mtime), or null if it is gone: tells edits from outside. */
  huddleStamp(slug: string, id: string): string | null {
    try {
      const st = statSync(join(this.huddlesDir(slug), `${id}.json`));
      return `${st.ino}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** The message log is append-only: messages are never edited or removed. */
  appendHuddleMessage(slug: string, id: string, m: HuddleMessage): void {
    const dir = this.huddlesDir(slug);
    mkdirSync(dir, { recursive: true });
    // The first message makes a new file there: the huddle list's cache takes the folder's new mtime instead of a rescan.
    const before = this.huddleFiles.mtime(dir);
    appendFileSync(join(dir, `${id}.messages.jsonl`), maskSavedJson(this.root, JSON.stringify(m)) + "\n");
    this.huddleFiles.touched(dir, before);
  }

  /**
   * The huddle's messages, oldest first: a shared frozen array (copy before changing). The parsed log is cached per
   * huddle with the byte offset read up to (the append index): a read parses only the lines appended since. A shorter
   * file (replaced) is read again in full. Only the last HUDDLE_LOGS_MAX huddles read stay in memory.
   */
  readHuddleMessages(slug: string, id: string): readonly HuddleMessage[] {
    const file = join(this.huddlesDir(slug), `${id}.messages.jsonl`);
    const key = `${slug}/${id}`;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      this.huddleLogs.delete(key);
      return [];
    }
    let log = this.huddleLogs.get(key);
    this.huddleLogs.delete(key);
    if (!log || size < log.offset) log = { offset: 0, msgs: [] };
    if (size > log.offset) {
      const fd = openSync(file, "r");
      let buf: Buffer;
      try {
        buf = Buffer.alloc(size - log.offset);
        buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, log.offset));
      } finally {
        closeSync(fd);
      }
      // Only whole lines: a line still being written is read next time.
      const end = buf.lastIndexOf(0x0a) + 1;
      const added: HuddleMessage[] = [];
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          added.push(deepFreeze({ ...m, mentions: m.mentions ?? [] }));
        } catch {}
      }
      // A new array only when lines were added: callers holding the old one keep a consistent snapshot.
      if (added.length) log = { offset: log.offset + end, msgs: Object.freeze([...log.msgs, ...added]) };
      else log = { offset: log.offset + end, msgs: log.msgs };
    }
    this.huddleLogs.set(key, log);
    if (this.huddleLogs.size > HUDDLE_LOGS_MAX) this.huddleLogs.delete(this.huddleLogs.keys().next().value!);
    return log.msgs;
  }

  /** Where a huddle participant saves reports and scripts: outputs/<handle>/ of the host ticket. */
  huddleOutputsDir(slug: string, ticketId: string, handle: string): string {
    const dir = join(this.ticketDir(slug, ticketId), "outputs", handle);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
