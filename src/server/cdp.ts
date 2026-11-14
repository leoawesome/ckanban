import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A small client for Chrome's debugging port (the Chrome DevTools Protocol), used by the board's browsers
 * (board-browsers.ts) to check and close a Chrome, and by `ckanban browser-mcp` (browser-mcp.ts) to drive it.
 * Only 127.0.0.1 is ever dialled.
 */

/** Chrome writes the port it picked (--remote-debugging-port=0) to this file in its data folder: line 1 the port, line 2 the browser's path. */
export const PORT_FILE = "DevToolsActivePort";

export interface PortFile {
  port: number;
  /** "/devtools/browser/<uuid>": unique to the Chrome that wrote the file. */
  path: string;
}

export function parsePortFile(text: string): PortFile | null {
  const [a, b] = text.split(/\r?\n/);
  const port = Number(a?.trim());
  const path = (b ?? "").trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{8,}$/.test(path)) return null;
  return { port, path };
}

export async function readPortFile(dir: string): Promise<PortFile | null> {
  try {
    return parsePortFile(await readFile(join(dir, PORT_FILE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * True when 127.0.0.1:<port> answers as the very Chrome that wrote the port file: its browser WebSocket path (a fresh
 * uuid per start) must match. A dead port, another program, or another Chrome that got the same port later all fail.
 */
export async function portMatches(pf: PortFile, timeoutMs = 2000, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${pf.port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const v = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (typeof v?.webSocketDebuggerUrl !== "string") return false;
    const u = new URL(v.webSocketDebuggerUrl);
    return u.pathname === pf.path;
  } catch {
    return false;
  }
}

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

/** The open tabs (page targets) over plain HTTP; null when the port doesn't answer. */
export async function listPages(port: number, timeoutMs = 2000, fetchFn: typeof fetch = fetch): Promise<PageTarget[] | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const list = (await res.json()) as PageTarget[];
    return Array.isArray(list) ? list.filter((t) => t?.type === "page") : null;
  } catch {
    return null;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CdpError extends Error {}

/** One WebSocket to the browser; page sessions go over it too (Target.attachToTarget with flatten). */
export class Cdp {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  private opened: Promise<void>;
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError("the browser didn't answer in time")), 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new CdpError("couldn't connect to the browser"));
      });
    });
    this.opened.catch(() => {});
    this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpError("the browser closed the connection"));
      }
      this.pending.clear();
    });
  }

  static async connect(port: number, path: string): Promise<Cdp> {
    const c = new Cdp(`ws://127.0.0.1:${port}${path}`);
    await c.opened;
    return c;
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(String(msg.error.message ?? "browser error")));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
  }

  on(fn: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the browser connection is closed"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`the browser didn't answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}

/**
 * Asks the Chrome behind a checked port to quit (Browser.close): Chrome saves its cookies and logins on the way out,
 * which a kill doesn't. Resolves once the request went out (Chrome may drop the connection before answering).
 */
export async function requestBrowserClose(pf: PortFile): Promise<void> {
  const c = await Cdp.connect(pf.port, pf.path);
  try {
    await c.send("Browser.close", {}, undefined, 5000);
  } catch (e) {
    // The connection closing under us is Chrome quitting: that is the answer.
    if (!(e instanceof CdpError) || !/closed/.test(e.message)) throw e;
  } finally {
    c.close();
  }
}
