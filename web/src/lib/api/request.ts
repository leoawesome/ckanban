import { type ChannelLike, LIVE_NAME, type LocksLike, type PageLike, type SourceLike, createLive } from "../../app/liveEvents";
import type { BusEvent } from "./types/board";
import type { Ticket } from "./types/ticket";

/** A question the daemon wants the user to answer before it goes on (e.g. a run and a huddle on the same ticket). */
export interface ServerConfirm { kind: string; message: string }
let askConfirm: ((q: ServerConfirm) => Promise<boolean>) | null = null;
/** The user answered a ServerConfirm with Cancel: nothing changed. */
export class NotStarted extends Error {
  constructor() { super("Not started."); }
}
/** ParallelConfirm registers the dialog that answers ServerConfirm questions (null: unregister). */
export function setServerConfirm(fn: typeof askConfirm) { askConfirm = fn; }

export async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";
  const r = await fetch(url, {
    method,
    // x-ckanban-source: the daemon records where huddle posts come from.
    headers: hasBody ? { "content-type": "application/json", "x-ckanban-source": "ui" } : undefined,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  // The daemon asks first (409 + confirm): resend with the user's yes, or stop with nothing started.
  const confirm = (data as any).confirm;
  if (r.status === 409 && typeof confirm === "string" && askConfirm && body && typeof body === "object") {
    if (await askConfirm({ kind: confirm, message: (data as any).error ?? "" })) return req<T>(method, url, { ...body, confirmParallel: true });
    throw new NotStarted();
  }
  if (!r.ok) {
    const e = new Error((data as any).error ?? `${r.status} ${r.statusText}`) as Error & { code?: string };
    if (typeof (data as any).code === "string") e.code = (data as any).code;
    throw e;
  }
  return data as T;
}

// One live connection per browser, shared across board tabs (see liveEvents.ts).
const live = createLive<BusEvent>({
  makeSource: () => new EventSource("/api/events") as unknown as SourceLike,
  locks: typeof navigator !== "undefined" && navigator.locks ? (navigator.locks as unknown as LocksLike) : null,
  makeChannel: typeof BroadcastChannel !== "undefined" ? () => new BroadcastChannel(LIVE_NAME) as unknown as ChannelLike : null,
  page: typeof document !== "undefined" ? pageEvents() : null,
  makeAbort: typeof AbortController !== "undefined" ? () => new AbortController() : null,
});

/** The page's state for the live connection: on screen or not, frozen by Chrome or put in the back/forward cache. */
function pageEvents(): PageLike {
  return {
    visible: () => document.visibilityState === "visible",
    on(event, fn) {
      if (event === "visible") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fn(); });
      else if (event === "freeze") { document.addEventListener("freeze", fn); window.addEventListener("pagehide", fn); }
      else { document.addEventListener("resume", fn); window.addEventListener("pageshow", fn); }
    },
  };
}

export function subscribe(fn: (e: BusEvent) => void): () => void {
  return live.subscribe(fn);
}

/** Shows a ticket this tab just changed (a request's answer) at once, without waiting for the live connection. */
export function showTicket(profile: string, ticket: Ticket): void {
  live.emitLocal({ type: "ticket.updated", profile, ticket });
}

/** Called after the live connection comes back (daemon restart, laptop sleep, leader tab closed): refetch state. */
export function onReconnect(fn: () => void): () => void {
  return live.onReconnect(fn);
}

/** Only allow https links from untrusted data (e.g. PR URLs reported by Claude). */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https:\/\//.test(url) ? url : undefined;
}

/** Resolves false when nothing could be copied. Over plain http (a phone on the LAN) navigator.clipboard is missing. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen and read-only: no scroll jump and no phone keyboard popping up.
    ta.readOnly = true;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* not supported */ }
    ta.remove();
    return ok;
  }
}
