import {
  appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type {
  ActivityEntry, Comment, Config, Huddle, HuddleMessage, Job, Loop, LoopState, OutputFile, Profile, Schedule, ScheduleHistoryEntry, Status, Ticket, TicketMode, TicketSource,
} from "./types";
import { cleanPresets, type HuddlePreset } from "./huddle-presets";
import { cleanTemplates, type HuddleTemplate } from "./huddle-templates";
import { type HuddleNote, type NoteScope, parseNotes, serializeNotes } from "./huddle-notes";
import { newId, newTicketId, nowIso } from "./util";

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

export function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
    const size = statSync(file).size;
    const end = Math.min(Math.max(0, opts.before ?? size), size);
    let want = Math.max(1, opts.maxBytes ?? ACTIVITY_PAGE_BYTES);
    for (;;) {
      const start = Math.max(0, end - want);
      const buf = Buffer.alloc(end - start);
      for (let got = 0; got < buf.length;) {
        const n = readSync(fd, buf, got, buf.length - got, start + got);
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
  } finally {
    closeSync(fd);
  }
}

function parseTicket(raw: string): Ticket {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = YAML.parse(m[1]);
  if (!meta || typeof meta !== "object" || !meta.id) throw new Error("invalid frontmatter");
  // Add-ons were saved as followUpOf before "follow-up" came to mean a timed wake (FollowUp).
  if ("followUpOf" in meta) {
    const { followUpOf, ...rest } = meta;
    return { ...rest, ...(followUpOf && !rest.addOnOf ? { addOnOf: followUpOf } : {}), body: m[2] ?? "" } as Ticket;
  }
  return { ...meta, body: m[2] ?? "" } as Ticket;
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

export class Store {
  /** Parsed huddle message logs by "<slug>/<huddle>", with the byte offset read up to (see readHuddleMessages). */
  /** huddleIndex's parsed huddles per board, with the folder mtime they were read at. */
  private huddleCache = new Map<string, { mtime: number; gen: number; list: Huddle[] }>();
  private huddleGen = 0;
  private huddleLogs = new Map<string, { offset: number; msgs: HuddleMessage[] }>();
  private aiCache = new Map<string, { key: string; comments: Comment[] }>();
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
  private boards = new Map<string, { dirMtime: number; checkedAt: number; ids: Set<string>; list: readonly Ticket[] | null; version: number }>();
  private now: () => number;
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
    const dir = join(this.profileDir(slug), "tickets");
    let dirMtime: number;
    try {
      dirMtime = statSync(dir).mtimeMs;
    } catch {
      this.boards.delete(slug);
      return [];
    }
    const b = this.boards.get(slug);
    if (b?.list && b.dirMtime === dirMtime && this.now() - b.checkedAt < TICKET_RECHECK_MS) return [...b.list];
    const prev = b?.list;
    const ids = new Set<string>();
    const out: Ticket[] = [];
    if (b && b.dirMtime === dirMtime && this.now() - b.checkedAt < TICKET_RECHECK_MS) {
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
    out.sort((x, y) => x.order - y.order);
    const changed = !prev || prev.length !== out.length || out.some((t, i) => t !== prev[i]);
    const version = (b?.version ?? 0) + (changed && b ? 1 : 0);
    const checkedAt = b && b.dirMtime === dirMtime && this.now() - b.checkedAt < TICKET_RECHECK_MS ? b.checkedAt : this.now();
    this.boards.set(slug, { dirMtime, checkedAt, ids, list: out, version });
    return [...out];
  }

  /** A number that changes whenever the board's ticket listing changes (Store writes at once; outside edits by the next re-check). */
  ticketsVersion(slug: string): number {
    this.listTickets(slug);
    return this.boards.get(slug)?.version ?? 0;
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

  /** After a Store write: cache the saved ticket (null: deleted) and mark the board's listing for a rebuild. */
  private saved(slug: string, id: string, t: Ticket | null): void {
    const file = this.ticketPath(slug, id);
    const b = this.boards.get(slug);
    if (t) {
      const st = statSync(file);
      this.ticketCache.set(file, { key: `${st.mtimeMs}:${st.size}`, ticket: deepFreeze(structuredClone(t)) });
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
    }
    this.touchBoard(slug);
  }

  private touchBoard(slug: string): void {
    const b = this.boards.get(slug);
    if (b) b.list = null;
  }

  getTicket(slug: string, id: string): Ticket | null {
    return this.readTicketOrCorrupt(slug, id);
  }

  nextOrder(slug: string, status: Status): number {
    const orders = this.listTickets(slug).filter((t) => t.status === status).map((t) => t.order);
    return orders.length ? Math.max(...orders) + 1 : 1;
  }

  topOrder(slug: string, status: Status): number {
    const orders = this.listTickets(slug).filter((t) => t.status === status).map((t) => t.order);
    return orders.length ? Math.min(...orders) - 1 : 1;
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
      model?: string | null; raisedBy?: { scheduleId: string; ticketId: string } | null;
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
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      ...(input.needs?.length ? { needs: input.needs } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.important ? { important: true } : {}),
      ...(input.partOf ? { partOf: input.partOf, ...(input.partOfVia ? { partOfVia: input.partOfVia } : {}) } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.raisedBy ? { raisedBy: input.raisedBy } : {}),
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
    const out: OutputFile[] = [];
    const walk = (sub: string) => {
      for (const name of readdirSync(join(dir, sub))) {
        const rel = sub ? `${sub}/${name}` : name;
        const st = lstatSync(join(dir, rel));
        if (st.isDirectory()) {
          if (!SKIPPED_OUTPUT_DIRS.has(name)) walk(rel);
        } else if (st.isFile()) out.push({ name: rel, size: st.size, updatedAt: st.mtime.toISOString() });
      }
    };
    walk("");
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_OUTPUT_FILES);
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
    return this.aiComments(slug, id).at(-1)?.text ?? null;
  }

  /** The ticket's Claude comments (its result summaries), oldest first, cached until comments.jsonl changes. */
  aiComments(slug: string, id: string): Comment[] {
    const file = join(this.ticketDir(slug, id), "comments.jsonl");
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return [];
    }
    const hit = this.aiCache.get(file);
    if (hit?.key === key) return hit.comments;
    const comments = this.listComments(slug, id).filter((c) => c.author === "ai");
    this.aiCache.set(file, { key, comments });
    return comments;
  }

  addComment(slug: string, id: string, author: Comment["author"], text: string, from?: string): Comment {
    const c: Comment = { id: newId(), author, text, at: nowIso(), ...(from ? { from } : {}) };
    appendFileSync(join(this.ticketDir(slug, id), "comments.jsonl"), JSON.stringify(c) + "\n");
    return c;
  }

  appendActivity(slug: string, id: string, run: number, event: unknown): void {
    const e: ActivityEntry = { run, at: nowIso(), event };
    appendFileSync(join(this.ticketDir(slug, id), "activity.jsonl"), JSON.stringify(e) + "\n");
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

  /** "Help me understand" answers shown as cards in the ticket's chat (explain.ts). */
  helpPath(slug: string, id: string): string {
    return join(this.ticketDir(slug, id), "help.json");
  }

  readActivity(slug: string, id: string): ActivityEntry[] {
    return readJsonl<ActivityEntry>(this.activityPath(slug, id));
  }

  /** The newest page of the activity log, or the page before byte `before` (readJsonlPage). */
  readActivityPage(slug: string, id: string, before?: number, maxBytes?: number): { entries: ActivityEntry[]; before: number | null } {
    return readJsonlPage<ActivityEntry>(this.activityPath(slug, id), { before, maxBytes });
  }

  private schedulesDir(slug: string) {
    return join(this.profileDir(slug), "schedules");
  }

  listSchedules(slug: string): Schedule[] {
    const dir = this.schedulesDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getSchedule(slug, f.slice(0, -5)))
      .filter((s): s is Schedule => s !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    atomicWrite(join(this.schedulesDir(slug), `${s.id}.json`), JSON.stringify(s, null, 2) + "\n");
  }

  deleteSchedule(slug: string, id: string): void {
    rmSync(join(this.schedulesDir(slug), `${id}.json`), { force: true });
    rmSync(join(this.schedulesDir(slug), `${id}.history.jsonl`), { force: true });
  }

  appendScheduleHistory(slug: string, id: string, e: ScheduleHistoryEntry): void {
    mkdirSync(this.schedulesDir(slug), { recursive: true });
    appendFileSync(join(this.schedulesDir(slug), `${id}.history.jsonl`), JSON.stringify(e) + "\n");
  }

  readScheduleHistory(slug: string, id: string): ScheduleHistoryEntry[] {
    return readJsonl<ScheduleHistoryEntry>(join(this.schedulesDir(slug), `${id}.history.jsonl`));
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

  listLoops(slug: string): Loop[] {
    const dir = this.loopsDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".state.json"))
      .map((f) => this.getLoop(slug, f.slice(0, -5)))
      .filter((l): l is Loop => l !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    atomicWrite(join(this.loopsDir(slug), `${l.id}.json`), JSON.stringify(l, null, 2) + "\n");
  }

  deleteLoop(slug: string, id: string): void {
    rmSync(join(this.loopsDir(slug), `${id}.json`), { force: true });
    rmSync(join(this.loopsDir(slug), `${id}.state.json`), { force: true });
    rmSync(this.loopScriptFile(slug, id), { force: true });
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

  /** One-time jobs (jobs.ts), oldest due first. */
  listJobs(slug: string): Job[] {
    const dir = this.jobsDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getJob(slug, f.slice(0, -5)))
      .filter((j): j is Job => j !== null)
      .sort((a, b) => a.at.localeCompare(b.at) || a.createdAt.localeCompare(b.createdAt));
  }

  getJob(slug: string, id: string): Job | null {
    if (!/^[a-z0-9]+$/.test(id)) return null;
    const file = join(this.jobsDir(slug), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      // Older versions kept a late job "missed" until the user ran or skipped it; that step is gone.
      if (j.state === "missed") return { ...j, state: "skipped", result: { ...j.result, message: "was due while the computer was off" } };
      return j;
    } catch {
      return null;
    }
  }

  saveJob(slug: string, j: Job): void {
    atomicWrite(join(this.jobsDir(slug), `${j.id}.json`), JSON.stringify(j, null, 2) + "\n");
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
   * The board's huddles, parsed once and shared: read only, never change them (listHuddles gives copies to change).
   * Read again after saveHuddle or when the folder's mtime changes: huddle files are written by rename (atomicWrite),
   * which changes it; appending to a message log doesn't.
   * shortcut: a huddle .json rewritten in place from outside (no rename) shows only after the next change; fine while every writer renames.
   */
  huddleIndex(slug: string): readonly Huddle[] {
    const dir = this.huddlesDir(slug);
    let mtime: number;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      this.huddleCache.delete(slug);
      return [];
    }
    const hit = this.huddleCache.get(slug);
    if (hit?.mtime === mtime) return hit.list;
    const list = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getHuddle(slug, f.slice(0, -5)))
      .filter((h): h is Huddle => h !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.huddleCache.set(slug, { mtime, gen: ++this.huddleGen, list });
    return list;
  }

  /** The board's huddles, oldest first, as copies the caller may change. */
  listHuddles(slug: string): Huddle[] {
    return structuredClone(this.huddleIndex(slug) as Huddle[]);
  }

  /** Change marker for the board's huddle files: a new value whenever huddleIndex was read again. */
  huddlesVersion(slug: string): string {
    this.huddleIndex(slug);
    return String(this.huddleCache.get(slug)?.gen ?? "");
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
    atomicWrite(join(this.huddlesDir(slug), `${h.id}.json`), JSON.stringify(h, null, 2) + "\n");
    this.huddleCache.delete(slug);
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
    mkdirSync(this.huddlesDir(slug), { recursive: true });
    appendFileSync(join(this.huddlesDir(slug), `${id}.messages.jsonl`), JSON.stringify(m) + "\n");
  }

  /**
   * The huddle's messages, oldest first. The parsed log is cached per huddle with the byte offset read up to (the
   * append index): a read parses only the lines appended since. A shorter file (replaced) is read again in full.
   */
  readHuddleMessages(slug: string, id: string): HuddleMessage[] {
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
      const msgs = log.msgs.slice();
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          msgs.push(JSON.parse(line));
        } catch {}
      }
      log = { offset: log.offset + end, msgs };
    }
    this.huddleLogs.set(key, log);
    // Copies: a caller changing a message must not change the cache.
    return log.msgs.map((m) => ({ ...m, mentions: [...(m.mentions ?? [])] }));
  }

  /** Where a huddle participant saves reports and scripts: outputs/<handle>/ of the host ticket. */
  huddleOutputsDir(slug: string, ticketId: string, handle: string): string {
    const dir = join(this.ticketDir(slug, ticketId), "outputs", handle);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
