import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { helperArgv } from "./artifact";
import { listPages, PORT_FILE, portMatches, readPortFile, requestBrowserClose, type PageTarget, type PortFile } from "./cdp";
import { trackedInterval } from "./lag";
import { nowIso } from "./util";

/**
 * Board browsers (More → Browsers): real Google Chromes the board starts itself, one per set of logins, each with its
 * own data folder (~/.claude-kanban/browsers/<id>/) and driven over its local debugging port, not through the Claude in
 * Chrome extension. So they keep working whatever Claude account is in use, and one run can use several (a business
 * and a personal WhatsApp at once). A run gets each chosen browser as its own MCP server (`ckanban browser-mcp`, see
 * browser-mcp.ts) named browser-<id>.
 *
 * Logins live in the data folder and are only saved when Chrome quits cleanly, so the board never kills one: it asks
 * Chrome to close over its port (Browser.close) and waits. Chrome runs detached from the daemon (its own process group),
 * so a daemon stop or restart leaves it running and the next daemon adopts it again from its DevToolsActivePort file
 * (checked: the port must answer as that very Chrome and be bound to this Mac only). Hidden (headless) browsers close
 * after IDLE_MS without a run, unless "keep running" is on; then the board starts them with the daemon and again if
 * they die.
 *
 * Scripts outside runs may read <folder>/DevToolsActivePort (see docs/board-browsers.md); its place and meaning stay.
 */

export const BROWSERS_DIR = "browsers";
/** Folders being removed go here first (outside BROWSERS_DIR, so they are never adopted again), then get deleted. */
const REMOVED_DIR = "browsers-removed";
const STATE_FILE = "board-browsers.json";
/** Screenshots and other files a browser's tools save when no run folder is given. Never the project folder. */
export const BROWSER_FILES_DIR = "browser-files";

export const IDLE_MS = 10 * 60_000;
export const TICK_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
/** A keep-running browser that won't start waits this long (doubling, up to 30 minutes) before the next try. */
const RETRY_BASE_MS = 60_000;
const NAME_MAX = 40;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WINDOW = "1280,900";

export type BrowserMode = "hidden" | "visible";

export interface BoardBrowser {
  /** Safe slug, also the folder name and the MCP server name (browser-<id>). */
  id: string;
  name: string;
  createdAt: string;
  /** Last time a run asked for it. */
  lastUsedAt: string | null;
  /** The last site open in it, to tell browsers apart ("web.whatsapp.com"). */
  lastSite: { site: string; at: string } | null;
  /** Start it with the daemon, restart it if it dies, never close it when idle (a watcher script needs it). */
  keepRunning: boolean;
  /** A site was opened and the browser was closed cleanly at least once since: its logins are saved. */
  signedIn: boolean;
  /** Page a keep-running start opens (e.g. https://web.whatsapp.com/ for a watcher). Null: a blank page. */
  startUrl: string | null;
}

interface Runtime {
  pid: number | null;
  port: number;
  path: string;
  mode: BrowserMode;
  startedAt: string;
}

export type BrowserState = "stopped" | "starting" | "hidden" | "visible" | "closing";

export interface BoardBrowserView extends BoardBrowser {
  state: BrowserState;
  /** Plain words for the UI. */
  signIn: "Signed in" | "Needs sign-in";
  /** How many runs use it now. */
  inUse: number;
  /** "Open window" was asked while a run used it: the window opens once that run is done. */
  windowPending: boolean;
  /** The last start or close problem, in plain words; null when fine. */
  error: string | null;
  /** Its data folder (for scripts; see docs/board-browsers.md). */
  folder: string;
}

export interface BoardBrowsersView {
  browsers: BoardBrowserView[];
  /** Google Chrome on this Mac; when missing, message says so in plain words. */
  chrome: { installed: boolean; message: string | null };
}

export class BrowserError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface PortOwner {
  pid: number;
  headless: boolean;
}

export interface BrowserDeps {
  /** Google Chrome's binary, or null when it isn't installed. */
  chromeBin?: () => string | null;
  /** Starts Chrome detached (own process group: a daemon stop never takes it down). */
  spawn?: (argv: string[]) => { pid: number };
  /** Which process listens on the port: it must be bound to this Mac only and be Chrome on this data folder. */
  owner?: (port: number, dir: string) => Promise<PortOwner | { error: string }>;
  alive?: (pid: number) => boolean;
  matches?: (pf: PortFile) => Promise<boolean>;
  close?: (pf: PortFile) => Promise<void>;
  pages?: (port: number) => Promise<PageTarget[] | null>;
  /** Chrome's major version, for the hidden browser's user agent. */
  chromeMajor?: () => Promise<string | null>;
  now?: () => number;
  idleMs?: number;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];

export function findChrome(): string | null {
  const home = process.env.HOME ?? "";
  for (const p of [process.env.CKANBAN_CHROME_BIN, ...CHROME_PATHS, join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function output(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 10_000);
  const text = await new Response(p.stdout as ReadableStream).text();
  await p.exited;
  clearTimeout(timer);
  return text;
}

/** True when argv (a ps command line) has exactly --user-data-dir=<dir>. */
export function hasDataDir(cmd: string, dir: string): boolean {
  const flag = `--user-data-dir=${dir}`;
  let i = cmd.indexOf(flag);
  while (i >= 0) {
    const end = i + flag.length;
    if ((i === 0 || cmd[i - 1] === " ") && (end === cmd.length || cmd[end] === " " || cmd[end] === "\n")) return true;
    i = cmd.indexOf(flag, end);
  }
  return false;
}

/** The lsof -F output's listeners: every address must be loopback. */
export function parseListeners(text: string, port: number): { pids: number[]; addrs: string[] } {
  const pids = new Set<number>();
  const addrs: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pids.add(Number(line.slice(1)));
    else if (line.startsWith("n")) addrs.push(line.slice(1));
  }
  return { pids: [...pids].filter((p) => p > 0), addrs: addrs.filter((a) => a.endsWith(`:${port}`)) };
}

export const LOOPBACK = (addr: string) => /^(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(addr);

async function realOwner(port: number, dir: string): Promise<PortOwner | { error: string }> {
  const { pids, addrs } = parseListeners(await output(["/usr/sbin/lsof", "-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"]), port);
  if (!pids.length || !addrs.length) return { error: "nothing listens on its port" };
  if (pids.length > 1) return { error: "more than one program listens on its port" };
  if (!addrs.every(LOOPBACK)) return { error: "its port is open to other computers, not only this Mac" };
  const cmd = (await output(["/bin/ps", "-ww", "-o", "command=", "-p", String(pids[0])])).trim();
  if (!hasDataDir(cmd, dir)) return { error: "its port belongs to another program" };
  return { pid: pids[0], headless: /(^| )--headless(=| |$)/.test(cmd) };
}

async function realChromeMajor(bin: string | null): Promise<string | null> {
  if (!bin) return null;
  try {
    const plist = await Bun.file(join(dirname(dirname(bin)), "Info.plist")).text();
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A normal Mac Chrome user agent: the headless default says "HeadlessChrome", which some sites turn away. */
export function userAgent(major: string | null): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major ?? "140"}.0.0.0 Safari/537.36`;
}

/** The argv that starts Chrome for one data folder. No automation flag (sites distrust it). */
export function chromeArgs(bin: string, dir: string, mode: BrowserMode, major: string | null, url: string | null): string[] {
  return [
    bin, `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    ...(mode === "hidden" ? ["--headless=new", `--user-agent=${userAgent(major)}`, `--window-size=${WINDOW}`] : []),
    url ?? "about:blank",
  ];
}

/** "Fatt Interior WhatsApp" from "fatt-interior-whatsapp". */
export function nameFromId(id: string): string {
  const words: Record<string, string> = { whatsapp: "WhatsApp", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok", github: "GitHub", x: "X" };
  return id.split("-").filter(Boolean).map((w) => words[w] ?? w[0].toUpperCase() + w.slice(1)).join(" ").slice(0, NAME_MAX);
}

export function slugFor(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "browser";
}

export function validBrowserId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

/** The MCP server name a run sees for a board browser; its tools are mcp__<name>__*. */
export const serverName = (id: string) => `browser-${id}`;

function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function cleanName(name: unknown): string {
  if (typeof name !== "string") throw new BrowserError(400, "Give the browser a name.");
  const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  if (!clean) throw new BrowserError(400, "Give the browser a name.");
  return clean;
}

export function cleanStartUrl(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new BrowserError(400, "The start page must be a web address.");
  const s = v.trim();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return u.toString();
  } catch {
    throw new BrowserError(400, "The start page must be a web address, like web.whatsapp.com.");
  }
}

export class BoardBrowsers {
  private browsers: BoardBrowser[] = [];
  private running: Record<string, Runtime> = {};
  private leases = new Map<string, Set<string>>();
  private idleSince = new Map<string, number>();
  private emptyTicks = new Map<string, number>();
  private pending = new Set<string>();
  private errors = new Map<string, string>();
  private busy = new Map<string, BrowserState>();
  private ops = new Map<string, Promise<unknown>>();
  private retry = new Map<string, { at: number; fails: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  readonly dir: string;
  private d: Required<Omit<BrowserDeps, "chromeMajor">> & { chromeMajor: () => Promise<string | null> };

  constructor(private root: string, private onChange: () => void = () => {}, deps: BrowserDeps = {}) {
    this.dir = join(root, BROWSERS_DIR);
    const chromeBin = deps.chromeBin ?? findChrome;
    this.d = {
      chromeBin,
      spawn: deps.spawn ?? ((argv) => {
        const p = Bun.spawn(argv, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        p.unref();
        return { pid: p.pid };
      }),
      owner: deps.owner ?? realOwner,
      alive: deps.alive ?? pidAlive,
      matches: deps.matches ?? ((pf) => portMatches(pf)),
      close: deps.close ?? requestBrowserClose,
      pages: deps.pages ?? ((port) => listPages(port)),
      chromeMajor: deps.chromeMajor ?? (() => realChromeMajor(chromeBin())),
      now: deps.now ?? Date.now,
      idleMs: deps.idleMs ?? IDLE_MS,
      startTimeoutMs: deps.startTimeoutMs ?? START_TIMEOUT_MS,
      closeTimeoutMs: deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
      pollMs: deps.pollMs ?? POLL_MS,
    };
    this.load();
  }

  private get file() {
    return join(this.root, STATE_FILE);
  }

  folder(id: string): string {
    if (!validBrowserId(id)) throw new BrowserError(400, "That isn't a board browser's id.");
    const dir = join(this.dir, id);
    // Never anything outside the browsers folder, whatever the id.
    if (dirname(resolve(dir)) !== resolve(this.dir)) throw new BrowserError(400, "That isn't a board browser's id.");
    return dir;
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      this.browsers = (Array.isArray(raw?.browsers) ? raw.browsers : []).filter((b: any) => b && validBrowserId(b.id)).map((b: any): BoardBrowser => ({
        id: b.id, name: typeof b.name === "string" && b.name.trim() ? b.name.slice(0, NAME_MAX) : nameFromId(b.id),
        createdAt: String(b.createdAt ?? nowIso()), lastUsedAt: typeof b.lastUsedAt === "string" ? b.lastUsedAt : null,
        lastSite: b.lastSite && typeof b.lastSite.site === "string" ? { site: b.lastSite.site, at: String(b.lastSite.at ?? "") } : null,
        keepRunning: b.keepRunning === true, signedIn: b.signedIn === true, startUrl: typeof b.startUrl === "string" ? b.startUrl : null,
      }));
      const run = raw?.running && typeof raw.running === "object" ? raw.running : {};
      for (const [id, r] of Object.entries<any>(run)) {
        if (!this.get(id) || !Number.isInteger(r?.port) || typeof r?.path !== "string") continue;
        this.running[id] = { pid: Number.isInteger(r.pid) ? r.pid : null, port: r.port, path: r.path, mode: r.mode === "visible" ? "visible" : "hidden", startedAt: String(r.startedAt ?? nowIso()) };
      }
    } catch (e) {
      console.error("board browsers: unreadable state", e);
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ browsers: this.browsers, running: this.running }, null, 2));
    renameSync(tmp, this.file);
    this.onChange();
  }

  get(id: string): BoardBrowser | undefined {
    return this.browsers.find((b) => b.id === id);
  }

  ids(): string[] {
    return this.browsers.map((b) => b.id);
  }

  private stateOf(id: string): BrowserState {
    return this.busy.get(id) ?? this.running[id]?.mode ?? "stopped";
  }

  inUse(id: string): number {
    return this.leases.get(id)?.size ?? 0;
  }

  view(): BoardBrowsersView {
    const installed = !!this.d.chromeBin();
    return {
      browsers: this.browsers.map((b) => ({
        ...b, lastSite: b.lastSite ? { ...b.lastSite } : null,
        state: this.stateOf(b.id), signIn: b.signedIn ? "Signed in" : "Needs sign-in", inUse: this.inUse(b.id),
        windowPending: this.pending.has(b.id), error: this.errors.get(b.id) ?? null, folder: join(this.dir, b.id),
      })),
      chrome: { installed, message: installed ? null : "Board browsers need Google Chrome. Install it from google.com/chrome, then come back here." },
    };
  }

  /** One start, close or switch at a time per browser. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(id) ?? Promise.resolve();
    const next: Promise<T> = prev.catch(() => {}).then(async () => {
      try {
        return await fn();
      } finally {
        if (this.ops.get(id) === next) this.ops.delete(id);
      }
    });
    this.ops.set(id, next);
    return next;
  }

  // --- Startup ------------------------------------------------------------------------------------

  /**
   * Adopts every folder in browsers/ as a board browser (the earlier test's logins included; nothing in a folder is
   * changed), re-adopts Chromes still running from before a daemon restart, and starts the keep-running ones.
   */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    let changed = false;
    const entries = (await readdir(this.dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    const folders = new Set<string>();
    for (const e of entries) {
      if (!e.isDirectory() || !validBrowserId(e.name)) continue;
      folders.add(e.name);
      if (this.get(e.name)) continue;
      const dir = join(this.dir, e.name);
      this.browsers.push({
        id: e.name, name: nameFromId(e.name), createdAt: nowIso(), lastUsedAt: null, lastSite: null, keepRunning: false,
        // A folder with saved cookies was used and closed before: count it as signed in.
        signedIn: existsSync(join(dir, "Default", "Cookies")),
        startUrl: e.name.includes("whatsapp") ? "https://web.whatsapp.com/" : null,
      });
      changed = true;
    }
    // A browser whose folder is gone (removed by hand) is forgotten.
    const before = this.browsers.length;
    this.browsers = this.browsers.filter((b) => folders.has(b.id));
    if (this.browsers.length !== before) changed = true;
    for (const id of Object.keys(this.running)) if (!this.get(id)) delete this.running[id];
    for (const b of this.browsers) {
      const was = !!this.running[b.id];
      const live = await this.adopt(b.id);
      if (live) this.idleSince.set(b.id, this.d.now());
      if (was !== live) changed = true;
    }
    if (changed) this.save();
    for (const b of this.browsers) if (b.keepRunning && !this.running[b.id]) void this.keepAlive(b.id);
  }

  /**
   * A Chrome on this folder that is already running (from before a restart, or started outside the board): use it when
   * its port checks out. Returns whether it runs now. A port that fails a check is never used or closed by the board.
   */
  private async adopt(id: string): Promise<boolean> {
    const dir = join(this.dir, id);
    const pf = await readPortFile(dir);
    if (!pf || !(await this.d.matches(pf))) {
      delete this.running[id];
      return false;
    }
    const owner = await this.d.owner(pf.port, dir);
    if ("error" in owner) {
      delete this.running[id];
      this.errors.set(id, `Its Chrome is running but the board can't use it: ${owner.error}.`);
      return false;
    }
    const prev = this.running[id];
    this.running[id] = { pid: owner.pid, port: pf.port, path: pf.path, mode: owner.headless ? "hidden" : "visible", startedAt: prev?.startedAt ?? nowIso() };
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = trackedInterval("board-browsers", () => this.tick().catch((e) => console.error("board browsers tick", e)), TICK_MS);
  }

  /**
   * The daemon stops: board browsers are left running (Chrome is detached), so no close can be cut short and no login
   * is lost; the next daemon adopts them (init). Hidden ones then close after IDLE_MS as usual.
   */
  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- Start and close ----------------------------------------------------------------------------

  /** Running and checked, in any mode; starts it hidden otherwise. Returns the port. */
  ensure(id: string): Promise<number> {
    if (!this.get(id)) return Promise.reject(new BrowserError(404, "There is no board browser with that name."));
    return this.serial(id, async () => {
      if (this.running[id] && (await this.adopt(id))) return this.running[id].port;
      return (await this.launch(id, "hidden", null)).port;
    });
  }

  private async launch(id: string, mode: BrowserMode, url: string | null): Promise<Runtime> {
    const bin = this.d.chromeBin();
    if (!bin) throw new BrowserError(409, "Google Chrome isn't installed on this Mac. Board browsers need it: install it from google.com/chrome.");
    const dir = this.folder(id);
    this.busy.set(id, "starting");
    this.onChange();
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      // Already running on this folder (outside the board, or not yet adopted): use it if it checks out, else say so.
      if (await this.adopt(id)) {
        this.errors.delete(id);
        return this.running[id];
      }
      const holder = await this.lockHolder(dir);
      if (holder !== null) throw new BrowserError(409, "This browser is already open outside the board. Quit that Chrome window, then try again.");
      // A port file left from an earlier start would point at a dead or someone else's port.
      await rm(join(dir, PORT_FILE), { force: true });
      const { pid } = this.d.spawn(chromeArgs(bin, dir, mode, await this.d.chromeMajor(), url));
      // Timeouts go by the real clock (now() is the board's, for idle times).
      const deadline = Date.now() + this.d.startTimeoutMs;
      let pf: PortFile | null = null;
      while (Date.now() < deadline) {
        pf = await readPortFile(dir);
        if (pf && (await this.d.matches(pf))) break;
        pf = null;
        if (!this.d.alive(pid)) throw new BrowserError(502, "Chrome closed right after it started. Try again; if it keeps happening, restart the Mac.");
        await sleep(this.d.pollMs);
      }
      if (!pf) throw new BrowserError(504, "Chrome didn't start in time. Try again in a minute.");
      const owner = await this.d.owner(pf.port, dir);
      if ("error" in owner || owner.pid !== pid) {
        // Ours by the port file, but not safe to use: close it cleanly and refuse.
        await this.d.close(pf).catch(() => {});
        await this.waitGone(pid, dir);
        throw new BrowserError(502, `Chrome started but the board won't use it: ${"error" in owner ? owner.error : "another program answered on its port"}.`);
      }
      this.running[id] = { pid, port: pf.port, path: pf.path, mode, startedAt: nowIso() };
      this.idleSince.set(id, this.d.now());
      this.errors.delete(id);
      this.retry.delete(id);
      return this.running[id];
    } catch (e) {
      this.errors.set(id, (e as Error).message);
      throw e;
    } finally {
      this.busy.delete(id);
      this.save();
    }
  }

  /** The pid in Chrome's SingletonLock ("host-pid") when that Chrome still runs: the folder is in use. */
  private async lockHolder(dir: string): Promise<number | null> {
    try {
      const pid = Number((await readlink(join(dir, "SingletonLock"))).split("-").pop());
      return Number.isInteger(pid) && pid > 0 && this.d.alive(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private async waitGone(pid: number | null, dir: string): Promise<boolean> {
    const deadline = Date.now() + this.d.closeTimeoutMs;
    while (Date.now() < deadline) {
      const gone = pid !== null ? !this.d.alive(pid) : (await this.lockHolder(dir)) === null;
      if (gone) return true;
      await sleep(this.d.pollMs * 2);
    }
    return false;
  }

  /** Closes it cleanly (Browser.close over its checked port) and waits until Chrome is gone. Never kills. */
  close(id: string): Promise<boolean> {
    return this.serial(id, () => this.closeNow(id));
  }

  private async closeNow(id: string): Promise<boolean> {
    const rt = this.running[id];
    const dir = this.folder(id);
    const pf = await readPortFile(dir);
    if (!pf || !(await this.d.matches(pf))) {
      if (rt) {
        delete this.running[id];
        this.save();
      }
      return true;
    }
    if (!rt || rt.port !== pf.port || rt.path !== pf.path) {
      if (!(await this.adopt(id))) return false;
    }
    const pid = this.running[id].pid;
    this.busy.set(id, "closing");
    this.onChange();
    try {
      await this.d.close(pf);
    } catch (e) {
      this.busy.delete(id);
      this.errors.set(id, "The board couldn't ask Chrome to close. It is left running; try again.");
      this.onChange();
      return false;
    }
    const gone = await this.waitGone(pid, dir);
    this.busy.delete(id);
    if (!gone) {
      this.errors.set(id, "Chrome is taking long to close. The board leaves it to finish and checks again.");
      this.onChange();
      return false;
    }
    delete this.running[id];
    this.errors.delete(id);
    this.emptyTicks.delete(id);
    const b = this.get(id);
    if (b?.lastSite) b.signedIn = true;
    this.save();
    return true;
  }

  // --- Runs ---------------------------------------------------------------------------------------

  /**
   * A run (key: "slug/id", a quick chat, a huddle agent) will use these browsers: each one is started if needed and
   * kept from closing until release(key). Never throws: a browser that can't start comes back with why, in plain words.
   */
  async acquire(key: string, ids: string[]): Promise<Map<string, { ok: true; port: number } | { ok: false; why: string }>> {
    const out = new Map<string, { ok: true; port: number } | { ok: false; why: string }>();
    await Promise.all(ids.map(async (id) => {
      const b = this.get(id);
      if (!b) return void out.set(id, { ok: false, why: "it was removed from More, Browsers" });
      let set = this.leases.get(id);
      if (!set) this.leases.set(id, (set = new Set()));
      set.add(key);
      b.lastUsedAt = nowIso();
      try {
        out.set(id, { ok: true, port: await this.ensure(id) });
      } catch (e) {
        out.set(id, { ok: false, why: (e as Error).message });
      }
    }));
    this.save();
    return out;
  }

  /** The run is done with its browsers: idle ones may close later, and a window asked for meanwhile opens now. */
  release(key: string): void {
    for (const [id, set] of this.leases) {
      if (!set.delete(key)) continue;
      if (set.size) continue;
      this.leases.delete(id);
      this.idleSince.set(id, this.d.now());
      if (this.pending.has(id) && !this.stopped) void this.openWindow(id).catch((e) => console.error(`board browser ${id}: open window`, e));
      this.onChange();
    }
  }

  // --- The user's actions -------------------------------------------------------------------------

  async add(name: unknown): Promise<BoardBrowser> {
    const clean = cleanName(name);
    if (this.browsers.some((b) => b.name.toLowerCase() === clean.toLowerCase())) throw new BrowserError(409, `Another browser is already named "${clean}".`);
    if (!this.d.chromeBin()) throw new BrowserError(409, "Board browsers need Google Chrome. Install it from google.com/chrome, then add one.");
    const base = slugFor(clean);
    let id = base;
    for (let n = 2; this.get(id) || existsSync(join(this.dir, id)); n++) id = `${base.slice(0, 44)}-${n}`;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(this.folder(id), { mode: 0o700 });
    const b: BoardBrowser = { id, name: clean, createdAt: nowIso(), lastUsedAt: null, lastSite: null, keepRunning: false, signedIn: false, startUrl: null };
    this.browsers.push(b);
    this.save();
    return b;
  }

  update(id: string, patch: { name?: unknown; keepRunning?: unknown; startUrl?: unknown }): BoardBrowser {
    const b = this.get(id);
    if (!b) throw new BrowserError(404, "There is no board browser with that name.");
    if (patch.name !== undefined) {
      const clean = cleanName(patch.name);
      if (this.browsers.some((o) => o !== b && o.name.toLowerCase() === clean.toLowerCase())) throw new BrowserError(409, `Another browser is already named "${clean}".`);
      b.name = clean;
    }
    if (patch.startUrl !== undefined) b.startUrl = cleanStartUrl(patch.startUrl);
    if (patch.keepRunning !== undefined) {
      if (typeof patch.keepRunning !== "boolean") throw new BrowserError(400, "Keep running must be on or off.");
      b.keepRunning = patch.keepRunning;
      // Off: it closes once idle like any other. On: start it now (in the background; the list shows it starting).
      this.idleSince.set(id, this.d.now());
      if (b.keepRunning && !this.running[id]) void this.keepAlive(id);
    }
    this.save();
    return b;
  }

  /**
   * Removes the browser and its data folder with its logins. Refused while a run uses it; a running Chrome is closed
   * cleanly first. Only the browser's own folder (browsers/<id>, checked) is ever deleted.
   */
  async remove(id: string): Promise<void> {
    const b = this.get(id);
    if (!b) throw new BrowserError(404, "There is no board browser with that name.");
    if (this.inUse(id)) throw new BrowserError(409, "A task is using this browser now. Remove it once the task is done.");
    const dir = this.folder(id);
    if (!(await this.close(id))) throw new BrowserError(409, "Chrome is still closing. Try again in a minute.");
    if (this.inUse(id)) throw new BrowserError(409, "A task started using this browser. Remove it once the task is done.");
    this.browsers = this.browsers.filter((x) => x !== b);
    delete this.running[id];
    this.pending.delete(id);
    this.errors.delete(id);
    this.save();
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      await rm(dir, { force: true });
      return;
    }
    if (!st.isDirectory()) return;
    // Moved out first (one quick rename), so it is gone from the list at once and never adopted again; the slow delete
    // of thousands of Chrome files runs in the background.
    const trash = join(this.root, REMOVED_DIR);
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const target = join(trash, `${id}-${this.d.now()}`);
    await rename(dir, target);
    void rm(target, { recursive: true, force: true }).catch((e) => console.error(`board browser ${id}: delete folder`, e));
  }

  /**
   * Sign in / Open window: a visible Chrome window on this Mac. A hidden browser is closed cleanly and started visible
   * (hidden and visible are different Chrome modes); while a run uses it the window opens once that run is done, so no
   * run is cut off. A keep-running browser stays visible until the user closes its window or quits it, then the board
   * starts it hidden again.
   */
  async openWindow(id: string, url?: unknown): Promise<{ opened: boolean; message: string }> {
    const b = this.get(id);
    if (!b) throw new BrowserError(404, "There is no board browser with that name.");
    const page = url === undefined || url === null || url === "" ? null : cleanStartUrl(url);
    if (!this.d.chromeBin()) throw new BrowserError(409, "Google Chrome isn't installed on this Mac. Board browsers need it: install it from google.com/chrome.");
    if (this.running[id]?.mode !== "visible" && this.inUse(id)) {
      this.pending.add(id);
      this.onChange();
      return { opened: false, message: "A task is using this browser now. Its window opens on this Mac once the task is done." };
    }
    return this.serial(id, async () => {
      this.pending.delete(id);
      if (this.running[id] && !(await this.adopt(id))) delete this.running[id];
      const rt = this.running[id];
      const start = page ?? b.startUrl ?? (b.lastSite ? `https://${b.lastSite.site}/` : null);
      if (rt?.mode === "visible") {
        await this.showWindow(rt, page);
        return { opened: true, message: "The window is open on this Mac." };
      }
      if (rt) {
        if (this.inUse(id)) {
          this.pending.add(id);
          this.onChange();
          return { opened: false, message: "A task is using this browser now. Its window opens on this Mac once the task is done." };
        }
        if (!(await this.closeNow(id))) throw new BrowserError(409, "Chrome is still closing. Try again in a minute.");
      }
      await this.launch(id, "visible", start);
      this.emptyTicks.delete(id);
      return { opened: true, message: b.signedIn ? "The window is open on this Mac." : "The window is open on this Mac. Sign in to the sites this browser is for, then close the window." };
    });
  }

  /** A visible browser already runs: open the page (or a blank tab when it has no window left) in it. */
  private async showWindow(rt: Runtime, page: string | null): Promise<void> {
    const pages = await this.d.pages(rt.port);
    if (!page && pages && pages.length) return;
    try {
      await fetch(`http://127.0.0.1:${rt.port}/json/new?${encodeURIComponent(page ?? "about:blank")}`, { method: "PUT", signal: AbortSignal.timeout(3000) });
    } catch {}
  }

  // --- Upkeep -------------------------------------------------------------------------------------

  private async keepAlive(id: string): Promise<void> {
    const b = this.get(id);
    if (!b?.keepRunning || this.stopped || !this.d.chromeBin()) return;
    const r = this.retry.get(id);
    if (r && this.d.now() < r.at) return;
    try {
      await this.serial(id, async () => {
        if (this.running[id] && (await this.adopt(id))) return;
        await this.launch(id, "hidden", b.startUrl);
      });
    } catch (e) {
      const fails = (r?.fails ?? 0) + 1;
      this.retry.set(id, { fails, at: this.d.now() + Math.min(RETRY_BASE_MS * 2 ** (fails - 1), 30 * 60_000) });
      console.error(`board browser ${id}: keep running`, (e as Error).message);
    }
  }

  /**
   * Every TICK_MS: notices Chromes that died or were quit, restarts keep-running ones, closes hidden ones idle for
   * IDLE_MS, puts away visible ones whose window was closed, and notes the last site. A handful of HTTP calls to
   * 127.0.0.1 per running browser; nothing reads files in bulk.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let changed = false;
    for (const b of [...this.browsers]) {
      const id = b.id;
      if (this.ops.has(id) || this.busy.has(id)) continue;
      const rt = this.running[id];
      if (!rt) {
        if (b.keepRunning) await this.keepAlive(id);
        continue;
      }
      if (!(await this.d.matches({ port: rt.port, path: rt.path }))) {
        // Quit by the user or crashed; a quit is a clean close too.
        delete this.running[id];
        if (b.lastSite && rt.pid !== null && !this.d.alive(rt.pid)) b.signedIn = true;
        changed = true;
        if (b.keepRunning) await this.keepAlive(id);
        continue;
      }
      const pages = await this.d.pages(rt.port);
      const site = pages?.map((p) => siteOf(p.url)).find((s) => !!s) ?? null;
      if (site && (b.lastSite?.site !== site || this.d.now() - Date.parse(b.lastSite.at) > 10 * 60_000)) {
        b.lastSite = { site, at: nowIso() };
        changed = true;
      }
      if (this.inUse(id)) {
        this.emptyTicks.delete(id);
        continue;
      }
      if (rt.mode === "hidden") {
        if (!b.keepRunning && this.d.now() - (this.idleSince.get(id) ?? 0) >= this.d.idleMs) void this.close(id).catch(() => {});
        continue;
      }
      // Visible with no window left (on a Mac, Chrome keeps running after its last window closes): put it away.
      if (pages && pages.length === 0) {
        const n = (this.emptyTicks.get(id) ?? 0) + 1;
        this.emptyTicks.set(id, n);
        if (n >= 2) {
          this.emptyTicks.delete(id);
          void this.serial(id, async () => {
            if (this.inUse(id) || this.running[id]?.mode !== "visible") return;
            if (!(await this.closeNow(id))) return;
            if (b.keepRunning) await this.launch(id, "hidden", b.startUrl).catch(() => {});
          }).catch(() => {});
        }
      } else this.emptyTicks.delete(id);
    }
    if (changed) this.save();
  }

  /** For tests and the uninstall: close every running board browser cleanly. */
  async closeAll(): Promise<void> {
    await Promise.all(Object.keys(this.running).map((id) => this.close(id).catch(() => false)));
  }
}

/** The MCP server a run gets for one board browser (see browser-mcp.ts). outDir: where its screenshots go. */
export function browserServer(b: { id: string; name: string }, folder: string, outDir: string): { command: string; args: string[] } {
  const [command, ...args] = helperArgv();
  return { command, args: [...args, "browser-mcp", "--id", b.id, "--name", b.name, "--dir", folder, "--out", outDir] };
}
