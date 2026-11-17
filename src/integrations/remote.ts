// Phone access over Tailscale: `tailscale serve` proxies https://<this Mac>.<tailnet>.ts.net to the daemon on
// 127.0.0.1, and the daemon accepts that host only with the owner's Tailscale login (see allowedRemote).
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-generator";
import { track, trackedInterval } from "../core/lag";

export interface RemoteConfig {
  enabled: boolean;
  /** MagicDNS name, e.g. leos-mbp.tail1234.ts.net (no trailing dot). */
  host: string;
  /** Tailscale login allowed in (Tailscale-User-Login header set by `tailscale serve`). */
  allowedLogin: string;
  updatedAt: string;
}

export interface RemoteStatus {
  enabled: boolean;
  url: string | null;
  host: string | null;
  allowedLogin: string | null;
  /** Last request from the tailnet host (since the daemon started). */
  lastVisit: string | null;
  /** `off` disabled access but couldn't remove the serve mapping. */
  warning?: string;
  /** Live Tailscale state on this Mac, checked only while enabled (see liveStatus): the phone can reach the board only when running. */
  tailscale?: TailscaleState;
  /** Tailscale's own BackendState (e.g. Stopped, NeedsLogin), when it answered. */
  backendState?: string;
  /**
   * Tailscale's HTTPS link to the board (`tailscale serve`, port 443), checked only while on and running: ok, or a
   * problem the board couldn't fix by itself (`serveProblem` says it in plain words). Missing: not checked or unknown.
   */
  serve?: ServeState;
  serveProblem?: string;
}

export type TailscaleState = "running" | "stopped" | "unavailable";
/** missing: no link and it couldn't be put back; other: port 443 goes to another program; public: Funnel is on for 443. */
export type ServeState = "ok" | "missing" | "other" | "public";

/** What `tailscale serve status --json` says about HTTPS port 443. */
export type ServeLink = { kind: "none" } | { kind: "proxy"; target: string; funnel: boolean } | { kind: "other"; funnel: boolean };

/**
 * Reads port 443 out of `tailscale serve status --json`; null when that isn't the JSON Tailscale prints. `host` (the
 * board's MagicDNS name) picks the board's own entry; another app's `tailscale serve|funnel 443` run in the foreground
 * (under `Foreground`) counts too, as another program's link.
 */
export function parseServe(out: string, host?: string): ServeLink | null {
  let s: any;
  try {
    s = JSON.parse(out);
  } catch {
    return null;
  }
  // Nothing served at all: Tailscale prints `null` (an empty config).
  if (s === null) return { kind: "none" };
  if (typeof s !== "object" || Array.isArray(s)) return null;
  const is443 = (k: string) => (host ? k === `${host}:443` : k.endsWith(":443"));
  const funnelIn = (c: any) => Object.entries(c?.AllowFunnel ?? {}).some(([k, v]) => k.endsWith(":443") && v === true);
  const usedIn = (c: any) => !!c?.TCP?.["443"] || Object.keys(c?.Web ?? {}).some((k) => k.endsWith(":443"));
  const fg = Object.values(s.Foreground ?? {});
  const funnel = funnelIn(s) || fg.some(funnelIn);
  const web = Object.entries(s.Web ?? {}).find(([k]) => is443(k))?.[1] as any;
  const target = web?.Handlers?.["/"]?.Proxy;
  if (typeof target === "string" && !fg.some(usedIn)) return { kind: "proxy", target, funnel };
  if (usedIn(s) || fg.some(usedIn) || funnel) return { kind: "other", funnel };
  return { kind: "none" };
}

/** Header on every answer of the daemon's phone access listener, so `on` never points serve at some other program. */
export const LISTENER_HEADER = "x-ckanban-listener";

/** True when the daemon's phone access listener answers on this loopback port. */
export async function isPhoneListener(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/remote`, { signal: AbortSignal.timeout(3000) });
    return r.headers.get(LISTENER_HEADER) === "remote";
  } catch {
    return false;
  }
}

export type TailscaleRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export class RemoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Header `tailscale serve` adds with the visitor's login (it strips any copy the client sent). */
export const LOGIN_HEADER = "tailscale-user-login";
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HINT = "Install Tailscale (https://tailscale.com/download) and sign in, then try again.";

/**
 * The `tailscale` CLI: CKANBAN_TAILSCALE (tests point it at a fake, so they never change the Mac's real Tailscale),
 * else the app's own binary (the Homebrew/PATH `tailscale` is often a shell wrapper around it), else PATH.
 */
export function tailscaleBin(): string | null {
  const own = process.env.CKANBAN_TAILSCALE;
  if (own) return own;
  return existsSync(APP_CLI) ? APP_CLI : Bun.which("tailscale");
}

/** `tailscale serve` prints this and then waits for the user when Serve or HTTPS isn't enabled on the tailnet yet. */
const ENABLE_LINK = /To enable, visit:\s*(https:\/\/\S+)/;
const RUN_TIMEOUT_MS = 30_000;
/** Status checks give up sooner: they only decide what the Phone access dialog shows. */
const CHECK_TIMEOUT_MS = 3_000;

/** The Mac app's binary acts as the CLI only when it thinks a terminal started it; launchd gives the daemon no TERM. */
export function tailscaleEnv(): Record<string, string | undefined> {
  return { ...process.env, TAILSCALE_BE_CLI: "1" };
}

/** Printed (with exit code 0) when the Mac app's binary tried to open its window instead of running the command. */
const GUI_FAILED = /Tailscale GUI failed to start/i;

/** First lines of what Tailscale printed, for error messages. */
function excerpt(text: string): string {
  return text.trim().split("\n").slice(0, 6).join("\n");
}

export function tailscaleRunner(findBin: () => string | null = tailscaleBin): TailscaleRunner {
  return async (args) => {
    const bin = findBin();
    if (!bin) throw new RemoteError(424, `tailscale CLI not found. ${HINT}`);
    // Own process group, so a timeout also ends a wrapper script's child.
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: tailscaleEnv() });
    let stdout = "", stderr = "";
    let stop: (r: { code: number; stdout: string; stderr: string }) => void = () => {};
    const stopped = new Promise<{ code: number; stdout: string; stderr: string }>((r) => (stop = r));
    const end = (code: number) => {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {}
      stop({ code, stdout, stderr });
    };
    const read = async (stream: ReadableStream<Uint8Array>, add: (t: string) => void) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        add(dec.decode(chunk, { stream: true }));
        if (ENABLE_LINK.test(stdout + stderr)) end(1);
      }
    };
    const timer = setTimeout(() => {
      stderr += `\n(gave up after ${RUN_TIMEOUT_MS / 1000}s)`;
      end(124);
    }, RUN_TIMEOUT_MS);
    const done = Promise.all([read(p.stdout, (t) => (stdout += t)), read(p.stderr, (t) => (stderr += t)), p.exited])
      .then(([, , code]) => ({ code, stdout, stderr }));
    const r = await Promise.race([done, stopped]);
    clearTimeout(timer);
    return r;
  };
}

export const defaultRunner: TailscaleRunner = tailscaleRunner();

/** `serve --https=443 off` when port 443 has nothing: the link is already gone, which is what off wants. */
const ALREADY_OFF = /handler does not exist/i;
/** How often the daemon checks that Tailscale still sends the phone to the board (watchServe). */
export const SERVE_CHECK_MS = 3 * 60_000;

/** The daemon's phone access listener: CKANBAN_REMOTE_PORT, config.json remotePort, else the board port + 1. */
export function remoteListenPort(boardPort: number, configured?: number): number {
  return Number(process.env.CKANBAN_REMOTE_PORT) || configured || boardPort + 1;
}

export function remoteUrl(host: string): string {
  return `https://${host}`;
}

/** QR code of a URL, as an SVG tag (UI) or block characters (terminal). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function qrTerminal(text: string): string {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  // Two module rows per text line (▀ ▄ █), with a 2-module quiet zone; light-on-dark terminals invert, so draw light modules.
  const lines: string[] = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = "";
    for (let c = -2; c < n + 2; c++) {
      const top = !dark(r, c), bottom = !dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Remote access settings in `<root>/remote.json`, shared by the CLI and the daemon (re-read when the file changes). */
export class RemoteAccess {
  private cache: { mtime: number; config: RemoteConfig | null } | null = null;
  private lastVisit: string | null = null;

  constructor(private root: string, private port: () => number, private run: TailscaleRunner = defaultRunner,
    private probe: (port: number) => Promise<boolean> = isPhoneListener) {}

  private get file() {
    return join(this.root, "remote.json");
  }

  /** Current settings; null when never set up or the file is unreadable. Cheap: stats the file per call. */
  config(): RemoteConfig | null {
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.cache = null;
      return null;
    }
    if (this.cache?.mtime === mtime) return this.cache.config;
    let config: RemoteConfig | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw.host === "string" && typeof raw.allowedLogin === "string") {
        config = { enabled: raw.enabled === true, host: raw.host, allowedLogin: raw.allowedLogin, updatedAt: String(raw.updatedAt ?? "") };
      }
    } catch {}
    this.cache = { mtime, config };
    return config;
  }

  /** Enabled settings, for the request check. */
  active(): RemoteConfig | null {
    const c = this.config();
    return c?.enabled && c.host && c.allowedLogin ? c : null;
  }

  noteVisit(at: string) {
    this.lastVisit = at;
  }

  status(): RemoteStatus {
    const c = this.config();
    const on = !!this.active();
    return {
      enabled: on,
      url: c?.host ? remoteUrl(c.host) : null,
      host: c?.host ?? null,
      allowedLogin: c?.allowedLogin ?? null,
      lastVisit: on ? this.lastVisit : null,
    };
  }

  /** status() plus the live Tailscale state when enabled, so a saved "on" doesn't hide a stopped Tailscale. Never throws. */
  async liveStatus(): Promise<RemoteStatus> {
    const st = this.status();
    if (!st.enabled) return st;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS)));
      const r = await Promise.race([this.run(["status", "--json"]), timeout]);
      const backendState = r.code === 0 ? JSON.parse(r.stdout)?.BackendState : undefined;
      if (typeof backendState !== "string") return { ...st, tailscale: "unavailable" };
      if (backendState !== "Running") return { ...st, tailscale: "stopped", backendState };
    } catch {
      return { ...st, tailscale: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
    const serve = await this.checkServe();
    return { ...st, tailscale: "running", backendState: "Running", ...serve };
  }

  private checking: Promise<{ serve?: ServeState; serveProblem?: string }> | null = null;
  /** What the last check logged, so a problem that stays is logged once, not every few minutes. */
  private lastLogged = "";

  /**
   * While phone access is on: checks that Tailscale's HTTPS port 443 still goes to the board's phone listener and, when
   * port 443 has nothing at all, puts the tailnet-only link back (never Funnel, never over another program's link).
   * One check at a time; never throws. Logs one line when it puts the link back or when the problem changes.
   */
  checkServe(log: (line: string) => void = console.log): Promise<{ serve?: ServeState; serveProblem?: string }> {
    this.checking ??= this.serveCheck(log).catch(() => ({})).finally(() => (this.checking = null));
    return this.checking;
  }

  private async serveCheck(log: (line: string) => void): Promise<{ serve?: ServeState; serveProblem?: string }> {
    const c = this.active();
    if (!c) return {};
    const note = (key: string, line: string) => {
      if (key !== this.lastLogged) log(`phone access: ${line}`);
      this.lastLogged = key;
    };
    const port = this.port();
    const mine = (target: string) => !!port && (target === `http://127.0.0.1:${port}` || target === `http://localhost:${port}`);
    const link = await this.readServe();
    if (!link) return {};
    if (link.kind !== "none" && link.funnel) {
      note("public", "Tailscale has a public link (Funnel) on port 443; the board doesn't put itself there");
      return { serve: "public", serveProblem: "Tailscale has a public link (Funnel) on this Mac's https address, so the board stays off it. " +
        "Turn off Funnel for port 443 in Tailscale, then press Turn off and Turn on here." };
    }
    if (link.kind === "proxy" && mine(link.target)) {
      if (this.lastLogged) note("", "Tailscale's link to the board is back");
      return { serve: "ok" };
    }
    if (link.kind !== "none") {
      note(`other ${link.kind === "proxy" ? link.target : ""}`, `Tailscale's https port 443 goes to ${link.kind === "proxy" ? link.target : "another program"}, not the board; left as it is`);
      return { serve: "other", serveProblem: `Tailscale's address for this Mac (${remoteUrl(c.host)}) goes to another program, so your phone ` +
        "can't reach the board. Press Turn off, then Turn on, to point it back at the board." };
    }
    // Nothing on 443: the board's link is gone. Put it back, but only at the board's own listener.
    const missing = (why: string) => {
      note(`missing ${why}`, `Tailscale's link to the board is missing and couldn't be put back: ${why}`);
      return { serve: "missing" as const, serveProblem: `Tailscale lost the link to the board and the board couldn't put it back (${why}). ` +
        "Press Turn off, then Turn on." };
    };
    if (!port || !(await this.probe(port))) return missing(`the board's phone listener isn't answering on 127.0.0.1:${port || "?"}`);
    // Turned off while this check ran: leave it off.
    if (!this.active()) return {};
    try {
      await this.tailscale(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    } catch (e) {
      return missing(excerpt(e instanceof Error ? e.message : String(e)).split("\n")[0]);
    }
    this.lastLogged = "";
    log(`phone access: Tailscale's link to the board was missing; put it back (https 443 -> 127.0.0.1:${port})`);
    return { serve: "ok" };
  }

  /** Port 443 as `tailscale serve status --json` reports it; null when Tailscale can't be asked or answers oddly. */
  private async readServe(): Promise<ServeLink | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS)));
      const r = await Promise.race([this.run(["serve", "status", "--json"]), timeout]);
      if (r.code !== 0 || GUI_FAILED.test(r.stdout + r.stderr)) return null;
      // No output can't be told apart from a stand-in command that prints nothing: unknown. An empty config is `null`.
      return r.stdout.trim() === "" ? null : parseServe(r.stdout, this.config()?.host);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private write(config: RemoteConfig) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmp, this.file);
    this.cache = null;
  }

  private async tailscale(args: string[]) {
    const r = await this.run(args);
    if (GUI_FAILED.test(r.stdout + r.stderr)) {
      throw new RemoteError(502, `tailscale ${args[0]} didn't run: Tailscale tried to open its app window instead. ` +
        `It said: ${excerpt(r.stderr + "\n" + r.stdout)}`);
    }
    if (r.code !== 0) {
      const link = (r.stdout + r.stderr).match(ENABLE_LINK)?.[1];
      if (link) throw new RemoteError(424, `Tailscale Serve isn't enabled on your tailnet yet. Enable it at ${link} and try again.`);
      const msg = excerpt(r.stderr || r.stdout);
      throw new RemoteError(502, `tailscale ${args[0]} failed${msg ? `: ${msg}` : ""}`);
    }
    return r.stdout;
  }

  /** This Mac's MagicDNS name and the signed-in user's login, from `tailscale status --json`. */
  async identity(): Promise<{ host: string; login: string }> {
    const out = await this.tailscale(["status", "--json"]);
    let s: any;
    try {
      s = JSON.parse(out);
    } catch {
      const said = excerpt(out);
      throw new RemoteError(502, `could not read \`tailscale status --json\`${said ? `. Tailscale said: ${said}` : " (it printed nothing)"}`);
    }
    if (s?.BackendState !== "Running") {
      throw new RemoteError(424, `Tailscale is not connected (state: ${s?.BackendState ?? "unknown"}). ${HINT}`);
    }
    const host = String(s?.Self?.DNSName ?? "").replace(/\.$/, "");
    const login = String(s?.User?.[String(s?.Self?.UserID)]?.LoginName ?? "");
    if (!host) throw new RemoteError(424, "this Mac has no MagicDNS name: turn on MagicDNS in the Tailscale admin console (DNS page).");
    if (!login) throw new RemoteError(424, "could not find the signed-in Tailscale user (tagged devices are not supported).");
    return { host, login };
  }

  /** Point `tailscale serve` (HTTPS 443, tailnet only) at the daemon and let the signed-in user in. */
  async on(): Promise<RemoteStatus> {
    const { host, login } = await this.identity();
    const port = this.port();
    if (!port || !(await this.probe(port))) {
      throw new RemoteError(409, `the daemon's phone access listener isn't on 127.0.0.1:${port || "?"}: restart the daemon ` +
        "(`ckanban restart`) and try again; if the port is taken, set remotePort in ~/.claude-kanban/config.json");
    }
    await this.tailscale(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    this.write({ enabled: true, host, allowedLogin: login, updatedAt: new Date().toISOString() });
    // identity() just saw Tailscale running.
    return { ...this.status(), tailscale: "running", backendState: "Running" };
  }

  /** Remove the serve mapping and refuse the tailnet host again. Settings are kept (disabled) for the next `on`. */
  async off(): Promise<RemoteStatus> {
    const c = this.config();
    // Disable first: even if tailscale fails below, the daemon stops letting the tailnet in.
    if (c) this.write({ ...c, enabled: false, updatedAt: new Date().toISOString() });
    else rmSync(this.file, { force: true });
    this.lastLogged = "";
    // A link check that started before off ends first, so it can't put the link back after it.
    await this.checking;
    // Remove port 443 only when it is the board's link: nothing there is already off, and another program's link
    // (another board's daemon on another port, a TCP forward, a test daemon) isn't the board's to remove. Unknown
    // (Tailscale's answer can't be read): try anyway, as before.
    const link = await this.readServe();
    const port = this.port();
    const mine = link?.kind === "proxy" && !!port && (link.target === `http://127.0.0.1:${port}` || link.target === `http://localhost:${port}`);
    if (link && !mine) return this.status();
    try {
      await this.tailscale(["serve", "--https=443", "off"]);
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      if (ALREADY_OFF.test(e.message)) return this.status();
      return { ...this.status(), warning: e.message };
    }
    return this.status();
  }
}

/**
 * While phone access is on, checks Tailscale's link to the board soon after start and every SERVE_CHECK_MS, and puts it
 * back when it went missing (RemoteAccess.checkServe). Returns the stop function.
 */
export function watchServe(remote: RemoteAccess, everyMs = SERVE_CHECK_MS, firstMs = 10_000): () => void {
  const check = () => (remote.active() ? remote.checkServe() : undefined);
  const first = setTimeout(() => void track("phone access: serve check", check), firstMs);
  const timer = trackedInterval("phone access: serve check", check, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
