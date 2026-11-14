import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util";

/**
 * Named Chromes (More → Browsers). The user may have several Chromes (profiles) connected through Claude in Chrome, and
 * runs picked the wrong one. The board learns which exist from runs: whenever a run's stream shows a
 * list_connected_browsers result, every local Chrome in it is recorded here (browsers.json, one list for this Mac).
 * The user names each one once; a board picks a default (Profile.chrome) and a ticket may pick its own (Ticket.chrome).
 * Everything is keyed by deviceId: Claude in Chrome's display names ("Browser 1") swap when a browser reconnects.
 */

export interface ChromeBrowser {
  deviceId: string;
  /** The user's name for it ("Work"); "" until they name it. */
  name: string;
  /** Claude in Chrome's own display name when last listed ("Browser 1"); it can change on reconnect. */
  label: string;
  osPlatform?: string;
  firstSeenAt: string;
  /** Last time a run listed it as connected. */
  lastSeenAt: string;
  /** Last site a run opened on it, to tell the Chromes apart ("mail.google.com"). */
  hint?: { site: string; at: string } | null;
}

export interface ChromesState {
  browsers: ChromeBrowser[];
  /** When a run last listed the connected browsers, and which deviceIds were connected then. */
  listedAt: string | null;
  connected: string[];
}

/** Per-board default or per-ticket pick: a deviceId, or "ask" (ask each time). Null/missing: no choice (the old rule). */
export const ASK_CHROME = "ask";

/** What a run is told: one named Chrome, ask the user, or nothing (the rule stays as it was). */
export type ChromeChoice =
  | { kind: "device"; deviceId: string; name: string; note?: string }
  | { kind: "devices"; list: { deviceId: string; name: string; note?: string }[] }
  | { kind: "ask"; named: { deviceId: string; name: string }[] }
  | null;

/**
 * One browser a board or ticket chose for its runs (Profile.browsers, Ticket.browsers): a Claude in Chrome Chrome
 * (kind "chrome", id = deviceId), a board browser (kind "board", id = its slug, see board-browsers.ts), or "ask" (ask
 * which Chrome each time). note: what it is for, told to the run ("Business WhatsApp, for customers").
 */
export interface BrowserPick {
  kind: "chrome" | "board" | "ask";
  id?: string;
  note?: string;
}

export const NOTE_MAX = 120;
const PICKS_MAX = 10;

const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const NAME_MAX = 40;
const CHROME = "mcp__claude-in-chrome__";

export class ChromeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function validChromeId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

/** A board's or ticket's chrome setting from a request: a known deviceId, "ask", or null (none / the board's). */
export function chromeSetting(v: unknown, known: (id: string) => boolean): string | null {
  if (v === null || v === "") return null;
  if (v === ASK_CHROME) return ASK_CHROME;
  if (!validChromeId(v) || !known(v)) throw new ChromeError(400, "chrome must be the deviceId of a Chrome in More → Browsers, \"ask\", or null");
  return v;
}

/** The old single setting (Profile.chrome, Ticket.chrome) as a list of one; nothing set: null. */
export function picksFromLegacy(chrome: string | null | undefined): BrowserPick[] | null {
  if (!chrome) return null;
  if (chrome === ASK_CHROME) return [{ kind: "ask" }];
  return validChromeId(chrome) ? [{ kind: "chrome", id: chrome }] : null;
}

/** What one board or ticket set itself: its list when it has one, else its old single setting. Null: not set here. */
export function ownPicks(x: { browsers?: BrowserPick[] | null; chrome?: string | null } | null | undefined): BrowserPick[] | null {
  if (!x) return null;
  if (Array.isArray(x.browsers) && x.browsers.length) return x.browsers;
  return picksFromLegacy(x.chrome);
}

/** The old field to keep in step with a list (an older ckanban reads it): its first Claude in Chrome pick, or null. */
export function legacyChrome(picks: BrowserPick[] | null): string | null {
  const p = picks?.find((x) => x.kind === "ask" || x.kind === "chrome");
  return !p ? null : p.kind === "ask" ? ASK_CHROME : p.id ?? null;
}

/**
 * A board's or ticket's browser list from a request: [{kind, id, note}], or null/[] for none (the ticket above it, the
 * board's). Each id must be known; duplicates are dropped.
 */
export function browserPicks(v: unknown, known: { chrome: (id: string) => boolean; board: (id: string) => boolean }): BrowserPick[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw new ChromeError(400, "browsers must be a list of {kind, id, note}, or null");
  if (v.length > PICKS_MAX) throw new ChromeError(400, `at most ${PICKS_MAX} browsers`);
  const out: BrowserPick[] = [];
  for (const raw of v) {
    const kind = raw?.kind;
    const note = typeof raw?.note === "string" ? raw.note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
    if (raw?.note !== undefined && raw?.note !== null && typeof raw.note !== "string") throw new ChromeError(400, "a browser's note must be text");
    let pick: BrowserPick;
    if (kind === "ask") pick = { kind };
    else if (kind === "chrome") {
      if (!validChromeId(raw.id) || !known.chrome(raw.id)) throw new ChromeError(400, "That Chrome isn't in More, Browsers.");
      pick = { kind, id: raw.id };
    } else if (kind === "board") {
      if (typeof raw.id !== "string" || !known.board(raw.id)) throw new ChromeError(400, "That board browser isn't in More, Browsers.");
      pick = { kind, id: raw.id };
    } else throw new ChromeError(400, "a browser's kind must be chrome, board or ask");
    if (note) pick.note = note;
    if (out.some((o) => o.kind === pick.kind && o.id === pick.id)) continue;
    out.push(pick);
  }
  return out.length ? out : null;
}

/**
 * The browsers that apply to a ticket: its own list (or old single setting), else the nearest ticket above it that set
 * one (a tool step inherits its main ticket's), else the board's. Null: nothing set anywhere (runs behave as before).
 */
export function resolveBrowserPicks(
  t: { id: string; chrome?: string | null; browsers?: BrowserPick[] | null; parentId?: string | null },
  all: { id: string; chrome?: string | null; browsers?: BrowserPick[] | null; parentId?: string | null }[],
  board: { chrome?: string | null; browsers?: BrowserPick[] | null } | null | undefined,
): BrowserPick[] | null {
  const seen = new Set<string>();
  let cur: typeof t | undefined = t;
  while (cur && !seen.has(cur.id)) {
    const own = ownPicks(cur);
    if (own) return own;
    seen.add(cur.id);
    const up: string | null | undefined = cur.parentId;
    cur = up ? all.find((o) => o.id === up) : undefined;
  }
  return ownPicks(board);
}

export class Chromes {
  private state: ChromesState;

  constructor(private root: string, private onChange: () => void = () => {}) {
    this.state = this.load();
  }

  private get file() {
    return join(this.root, "browsers.json");
  }

  private load(): ChromesState {
    const empty: ChromesState = { browsers: [], listedAt: null, connected: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const browsers = (Array.isArray(raw?.browsers) ? raw.browsers : []).filter((b: any) => b && validChromeId(b.deviceId)).map((b: any): ChromeBrowser => ({
        deviceId: b.deviceId, name: typeof b.name === "string" ? b.name.slice(0, NAME_MAX) : "", label: typeof b.label === "string" ? b.label : "",
        ...(typeof b.osPlatform === "string" ? { osPlatform: b.osPlatform } : {}),
        firstSeenAt: String(b.firstSeenAt ?? nowIso()), lastSeenAt: String(b.lastSeenAt ?? b.firstSeenAt ?? nowIso()),
        hint: b.hint && typeof b.hint.site === "string" ? { site: b.hint.site, at: String(b.hint.at ?? "") } : null,
      }));
      return {
        browsers,
        listedAt: typeof raw?.listedAt === "string" ? raw.listedAt : null,
        connected: Array.isArray(raw?.connected) ? raw.connected.filter(validChromeId) : [],
      };
    } catch {
      return empty;
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
    this.onChange();
  }

  view(): ChromesState {
    return { browsers: this.state.browsers.map((b) => ({ ...b })), listedAt: this.state.listedAt, connected: [...this.state.connected] };
  }

  get(deviceId: string): ChromeBrowser | undefined {
    return this.state.browsers.find((b) => b.deviceId === deviceId);
  }

  /** A run listed the connected browsers. Only Chromes on this Mac (isLocal) are kept. */
  listed(list: { deviceId: string; name?: string; osPlatform?: string; isLocal?: boolean }[], at = nowIso()): void {
    const local = list.filter((b) => validChromeId(b.deviceId) && b.isLocal !== false);
    for (const b of local) {
      const known = this.get(b.deviceId);
      if (known) {
        known.lastSeenAt = at;
        if (b.name) known.label = b.name;
        if (b.osPlatform) known.osPlatform = b.osPlatform;
      } else {
        this.state.browsers.push({ deviceId: b.deviceId, name: "", label: b.name ?? "", ...(b.osPlatform ? { osPlatform: b.osPlatform } : {}), firstSeenAt: at, lastSeenAt: at, hint: null });
      }
    }
    this.state.listedAt = at;
    this.state.connected = local.map((b) => b.deviceId);
    this.save();
  }

  /** A run opened a site on this Chrome: the hint line that tells the Chromes apart. */
  sawSite(deviceId: string, site: string, at = nowIso()): void {
    const b = this.get(deviceId);
    if (!b || !site) return;
    if (b.hint?.site === site && Date.parse(at) - Date.parse(b.hint.at) < 60_000) return;
    b.hint = { site, at };
    this.save();
  }

  rename(deviceId: string, name: string): void {
    const b = this.get(deviceId);
    if (!b) throw new ChromeError(404, "no such Chrome");
    const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    if (clean && this.state.browsers.some((o) => o !== b && o.name.toLowerCase() === clean.toLowerCase())) {
      throw new ChromeError(409, `another Chrome is already named "${clean}"`);
    }
    b.name = clean;
    this.save();
  }

  /** Forget a Chrome (it comes back, unnamed, the next time a run lists it). */
  remove(deviceId: string): void {
    const before = this.state.browsers.length;
    this.state.browsers = this.state.browsers.filter((b) => b.deviceId !== deviceId);
    if (this.state.browsers.length === before) throw new ChromeError(404, "no such Chrome");
    this.save();
  }

  named(): { deviceId: string; name: string }[] {
    return this.state.browsers.filter((b) => b.name).map((b) => ({ deviceId: b.deviceId, name: b.name }));
  }

  /** The Claude in Chrome part of a browser list (board browsers left out): ask, one Chrome, several, or none. */
  choiceOf(picks: BrowserPick[] | null): ChromeChoice {
    if (!picks) return null;
    if (picks.some((p) => p.kind === "ask")) return this.choice(ASK_CHROME);
    const list = picks.filter((p) => p.kind === "chrome" && p.id && this.get(p.id)).map((p) => {
      const b = this.get(p.id!)!;
      return { deviceId: b.deviceId, name: b.name || b.label || "this Chrome", ...(p.note ? { note: p.note } : {}) };
    });
    if (!list.length) return null;
    return list.length === 1 ? { kind: "device", ...list[0] } : { kind: "devices", list };
  }

  /** What a run is told, from the setting that applies (see chromeSetting / resolveChromeSetting). */
  choice(setting: string | null | undefined): ChromeChoice {
    if (!setting) return null;
    if (setting === ASK_CHROME) {
      const named = this.named();
      return named.length ? { kind: "ask", named } : null;
    }
    const b = this.get(setting);
    if (!b) return null;
    return { kind: "device", deviceId: b.deviceId, name: b.name || b.label || "this Chrome" };
  }
}

/**
 * The old single setting that applies to a ticket (see resolveBrowserPicks for lists): its own, else the nearest ticket above it that set one (a tool step inherits its
 * main ticket's), else the board's default. Undefined/null means "not set here"; the walk stops on loops.
 */
export function resolveChromeSetting(
  t: { id: string; chrome?: string | null; parentId?: string | null },
  all: { id: string; chrome?: string | null; parentId?: string | null }[],
  boardDefault: string | null | undefined,
): string | null {
  const seen = new Set<string>();
  let cur: typeof t | undefined = t;
  while (cur && !seen.has(cur.id)) {
    if (cur.chrome) return cur.chrome;
    seen.add(cur.id);
    const up: string | null | undefined = cur.parentId;
    cur = up ? all.find((o) => o.id === up) : undefined;
  }
  return boardDefault || null;
}

function host(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function resultText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean);
}

/**
 * Reads one run's stream-json for Claude in Chrome calls: list_connected_browsers results go to Chromes.listed, and the
 * sites the run opens on the Chrome it uses become that Chrome's hint. Which Chrome is in use: the one the list marks
 * inUse (or the only one), then whatever select_browser picks; after switch_browser it is unknown until the next list.
 */
export class ChromeWatch {
  private calls = new Map<string, { name: string; input: any }>();
  private current: string | null = null;

  constructor(private chromes: Chromes) {}

  feed(ev: any): void {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) return;
    if (ev.type === "assistant") {
      for (const b of content) {
        if (b?.type === "tool_use" && typeof b.name === "string" && b.name.startsWith(CHROME)) {
          this.calls.set(String(b.id), { name: b.name.slice(CHROME.length), input: b.input ?? {} });
        }
      }
      return;
    }
    if (ev.type !== "user") return;
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const call = this.calls.get(String(b.tool_use_id));
      if (!call) continue;
      this.calls.delete(String(b.tool_use_id));
      if (b.is_error) continue;
      try {
        this.result(call, resultText(b.content));
      } catch (e) {
        console.error("chrome watch:", e);
      }
    }
  }

  private result(call: { name: string; input: any }, texts: string[]): void {
    switch (call.name) {
      case "list_connected_browsers": {
        for (const text of texts) {
          let list: unknown;
          try {
            list = JSON.parse(text);
          } catch {
            continue;
          }
          if (!Array.isArray(list)) continue;
          const items = list.filter((b: any) => b && validChromeId(b.deviceId));
          this.chromes.listed(items);
          const local = items.filter((b: any) => b.isLocal !== false);
          this.current = (local.find((b: any) => b.inUse) ?? (local.length === 1 ? local[0] : null))?.deviceId ?? null;
          return;
        }
        return;
      }
      case "select_browser":
        if (validChromeId(call.input?.deviceId) && !texts.some((t) => /not (found|connected)|error/i.test(t))) this.current = call.input.deviceId;
        return;
      case "switch_browser":
        this.current = null;
        return;
      case "navigate": {
        const site = host(call.input?.url);
        if (site && this.current) this.chromes.sawSite(this.current, site);
        return;
      }
    }
  }
}
