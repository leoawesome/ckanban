import { useSyncExternalStore } from "react";
import { onReconnect, req, subscribe } from "./api";

// The helper (src/server/helper/): its status line, the helper line per Inbox row, settings, "What the helper knows
// about you", and the messages it (or the board) sent the user. One shared copy for every screen, kept fresh by the
// live events helper.updated and messages.updated.

/** GET /api/helper (src/server/helper/runner.ts HelperStatus). */
export interface HelperStatus {
  on: boolean;
  model: "sonnet" | "haiku";
  night: { start: string; end: string };
  nightOptIn: boolean | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  nextWakeAt: string | null;
  failures: number;
  failReason: string | null;
  paused: boolean;
  /** No phone channel works: "I can only reach you on this Mac". */
  onlyMac: boolean;
  /** Show the one-time "Notifications now come grouped" notice. */
  notice: boolean;
  /** "Helper on, checked 2:41, nothing waits on you". */
  line: string;
  /** Red: failing or paused. */
  problem: boolean;
  waiting: number;
  /** The helper line per waiting ticket, keyed "<board>/<ticketId>". */
  lines: Record<string, string>;
  /** The message each line is about (same keys), when there is one: the line links to its page. */
  lineMsg?: Record<string, string>;
  /** The helper's paid checks today and what they cost. */
  today?: { checks: number; costUsd: number };
}

import { readFromHash, type Message } from "./helperText";
export type { Message, MessageItem, MessageLevel, MessageSend } from "./helperText";

export interface FeedbackLine {
  id: string;
  text: string;
  at?: string;
}

export const helperApi = {
  status: () => req<HelperStatus>("GET", "/api/helper"),
  settings: (patch: { model?: "sonnet" | "haiku"; night?: { start: string; end: string }; nightOptIn?: boolean }) =>
    req<HelperStatus>("POST", "/api/helper/settings", patch),
  feedback: () => req<{ lines: FeedbackLine[] }>("GET", "/api/helper/feedback"),
  addFeedback: (text: string) => req<{ line: FeedbackLine; lines: FeedbackLine[] }>("POST", "/api/helper/feedback", { text }),
  removeFeedback: (id: string) => req<{ lines: FeedbackLine[] }>("DELETE", `/api/helper/feedback/${encodeURIComponent(id)}`),
  shouldHavePinged: (profile: string, ticketId: string) => req<{ text: string }>("POST", "/api/helper/should-have-pinged", { profile, ticketId }),
  noticeSeen: () => req<HelperStatus>("POST", "/api/helper/notice-seen", {}),
  /** A pretend urgent alert: one now, one reminder a minute later unless Got it stops it. */
  practice: () => req<{ messageId: string }>("POST", "/api/helper/practice", {}),
  messages: (held = false) => req<{ messages: Message[]; unread: number }>("GET", `/api/messages${held ? "?held=1" : ""}`),
  message: (id: string) => req<Message>("GET", `/api/messages/${encodeURIComponent(id)}`),
  markRead: (id: string) => req<{ message: Message; unread: number }>("POST", `/api/messages/${encodeURIComponent(id)}/read`, {}),
  stop: (id: string, how: "got-it" | "not-urgent", key?: string | null) =>
    req<{ stopped: number; text: string; message: Message; unread: number }>("POST", `/api/messages/${encodeURIComponent(id)}/${how}`, key ? { key } : {}),
};

// ---- the shared copy ----

interface Shared {
  status: HelperStatus | null;
  unread: number;
  /** Bumped when messages change, so open lists reload. */
  messagesRev: number;
}

let shared: Shared = { status: null, unread: 0, messagesRev: 0 };
const subs = new Set<() => void>();
let started = false;
let loading: Promise<void> | null = null;

function set(patch: Partial<Shared>) {
  shared = { ...shared, ...patch };
  subs.forEach((f) => f());
}

/** Refetch the status and the unread count (one request each at a time). */
export function reloadHelper(): Promise<void> {
  loading ??= Promise.all([
    helperApi.status().then((status) => set({ status }), () => {}),
    helperApi.messages().then((r) => set({ unread: r.unread }), () => {}),
  ]).then(() => { loading = null; });
  return loading;
}

/** Put a status the server just returned in place (after a settings change). */
export function setHelperStatus(status: HelperStatus) {
  set({ status });
}

/**
 * The address came from a tap on an urgent alert about one ticket (#/<board>/<ticketId>?read=<id>): marks that
 * message read and drops "?read=…" from the address (same history entry). The ticket view opening stops its reminders.
 */
export function takeReadFromHash() {
  const r = readFromHash(location.hash);
  if (!r) return;
  history.replaceState(history.state, "", r.hash);
  helperApi.markRead(r.id).then((x) => setUnread(x.unread), () => {});
}

/** The server said how many messages are unread now (mark read, Got it). */
export function setUnread(unread: number) {
  set({ unread });
}

function start() {
  if (started) return;
  started = true;
  void reloadHelper();
  subscribe((e) => {
    if (e.type === "helper.updated") void reloadHelper();
    else if (e.type === "messages.updated") set({ unread: e.unread, messagesRev: shared.messagesRev + 1 });
  });
  onReconnect(() => {
    void reloadHelper();
    set({ messagesRev: shared.messagesRev + 1 });
  });
}

function subscribeShared(fn: () => void) {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
}

/** The helper's status, the unread count and a counter that moves when messages change. */
export function useHelper(): Shared {
  return useSyncExternalStore(subscribeShared, () => shared);
}

export * from "./helperText";
