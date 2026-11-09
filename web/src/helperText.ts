// Words and routes for the helper screens (no browser APIs here, so tests can load it).

export type MessageLevel = "urgent" | "reminder" | "summary" | "routine" | "pause" | "fallback" | "digest" | "hello" | "direct" | "message" | "test";

export interface MessageItem {
  key?: string | null;
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  question: string;
}

/** One row of a summary's page (src/server/helper/messages.ts SummaryRow). */
export interface SummaryRow {
  key?: string | null;
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  label: string;
  since?: string;
  /** Runs of one repeating schedule merged into this row. */
  count?: number;
}

/** A summary's rows; older summaries have none (their page shows the text). */
export interface SummaryView {
  new: SummaryRow[];
  still: SummaryRow[];
  stillCount: number;
  oldestAt: string | null;
  /** Waits older than the stale cut-off, counted only (missing on older summaries). */
  olderCount?: number;
  checkins: SummaryRow[];
  olderCheckins: number;
  notes: string[];
  grouped: boolean;
}

export interface MessageSend {
  channel: string;
  at: string;
  ok: boolean;
  devices?: number;
  error?: string | null;
}

/** One message the board sent (src/server/helper/messages.ts StoredMessage). */
export interface Message {
  id: string;
  at: string;
  level: MessageLevel;
  oneLine: string;
  text: string;
  why: string | null;
  items: MessageItem[];
  sends: MessageSend[];
  readAt: string | null;
  /** Got it or Not urgent was tapped on this alert. */
  tapped?: { how: "got-it" | "not-urgent"; at: string } | null;
  held?: boolean;
  summary?: SummaryView;
  /** A pretend urgent alert (or its reminder) the user asked for. */
  practice?: boolean;
  /** Carries the night question while the user hasn't chosen. */
  nightAsk?: boolean;
  /** The morning message's first line: "Held overnight: <title>, marked urgent 22:35". */
  heldOvernight?: string;
  /** Where each ticket stands now, keyed by itemStateKey (one message's GET; lists leave it out). */
  itemState?: Record<string, ItemState>;
}

/** src/server/helper/core.ts ItemState: still open, answered (seen, no longer waiting) or the ticket was removed. */
export interface ItemState {
  state: "open" | "answered" | "removed";
  at?: string | null;
  how?: "answered" | "seen" | "done";
}

/** The itemState key of a message item or summary row: its wait's key, else "<board>/<ticketId>". */
export const itemStateKey = (i: { key?: string | null; board: string; ticketId: string }) => i.key || `${i.board}/${i.ticketId}`;

/** What an old message's ticket shows instead of its helper line: "Answered 14:02", "Ticket removed"; null while open. */
export function itemStateLabel(st: ItemState | undefined, time: (iso: string) => string = clock): string | null {
  if (!st || st.state === "open") return null;
  if (st.state === "removed") return "Ticket removed";
  const at = st.at ? ` ${time(st.at)}` : "";
  return st.how === "seen" ? `Seen${at}` : st.how === "done" ? `No longer waiting${at}` : `Answered${at}`;
}

/** Got it / Not urgent show while some ticket of the alert is still open (or the page doesn't know: no states, no tickets). */
export function anyItemOpen(m: Pick<Message, "items" | "itemState">): boolean {
  if (!m.itemState || !m.items.length) return true;
  return m.items.some((i) => (m.itemState![itemStateKey(i)]?.state ?? "open") === "open");
}

// ---- words ----

/** Messages pages: #/~messages and #/~messages/<id> ("~" can't start a board slug). */
export const MESSAGES_HASH = "#/~messages";
export const messageHash = (id: string) => `${MESSAGES_HASH}/${encodeURIComponent(id)}`;

/**
 * A tap on an urgent alert about one ticket opens #/<board>/<ticketId>?read=<messageId>: the message to mark read and
 * the address without "?read=…". null when the hash has none.
 */
export function readFromHash(hash: string): { id: string; hash: string } | null {
  const m = /^(#\/[^?]*)\?(?:.*&)?read=([^&]+)/.exec(hash);
  if (!m) return null;
  let id = m[2];
  try {
    id = decodeURIComponent(id);
  } catch {}
  return id ? { id, hash: m[1] } : null;
}

/** The message route in a hash: null when it isn't one; id null for the history. */
export function messagesRoute(hash: string): { id: string | null } | null {
  const m = /^#\/~messages(?:\/([^/?#]+))?\/?$/.exec(hash);
  if (!m) return null;
  let id: string | null = null;
  try {
    id = m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    id = m[1] ?? null;
  }
  return { id };
}

/** The badge word for each kind of message. */
export function levelLabel(level: MessageLevel, held?: boolean, practice?: boolean): string {
  if (held) return "Kept quiet";
  if (practice) return "Practice";
  switch (level) {
    case "urgent": return "Urgent";
    case "reminder": return "Reminder";
    case "summary": return "Summary";
    case "digest": return "Summary";
    case "fallback": return "Missed";
    case "pause": return "Helper paused";
    case "hello": return "Hello";
    case "test": return "Test";
    case "message": return "From Claude";
    default: return "Update";
  }
}

/** Badge colour: urgent red, summaries blue, hello green, held and pause amber, the rest grey. */
export function levelTone(level: MessageLevel, held?: boolean, practice?: boolean): "urgent" | "sum" | "ok" | "warn" | "plain" {
  if (held) return "warn";
  if (practice) return "urgent";
  if (level === "urgent" || level === "reminder") return "urgent";
  if (level === "summary" || level === "digest") return "sum";
  if (level === "hello" || level === "test") return "ok";
  if (level === "pause" || level === "fallback") return "warn";
  return "plain";
}

const CHANNEL_WORDS: Record<string, string> = { push: "Phone", mac: "This Mac", webhook: "ntfy", telegram: "Telegram" };
export const channelWord = (name: string) => CHANNEL_WORDS[name] ?? name;

/** "2:10" in the Mac's clock, "Yesterday 4:00 pm"-style days are made by dayLabel. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday" or "Mon 3 Nov". */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const start = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** Newest first, grouped by day. */
export function groupByDay(list: Message[], now = Date.now()): { day: string; messages: Message[] }[] {
  const out: { day: string; messages: Message[] }[] = [];
  for (const m of list) {
    const day = dayLabel(m.at, now);
    const last = out.at(-1);
    if (last && last.day === day) last.messages.push(m);
    else out.push({ day, messages: [m] });
  }
  return out;
}

/** "Got it" or "Not urgent": the button the user tapped. */
export const tapWord = (how: "got-it" | "not-urgent") => (how === "got-it" ? "Got it" : "Not urgent");

/**
 * What the user did with a message, oldest first: "You opened it" (left out when it was only read by the tap itself)
 * and "You tapped Got it" / "You tapped Not urgent".
 */
export function userTrail(m: Pick<Message, "readAt" | "tapped">): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  if (m.readAt && !(m.tapped && m.readAt >= m.tapped.at)) out.push({ at: m.readAt, text: "You opened it" });
  if (m.tapped) out.push({ at: m.tapped.at, text: `You tapped ${tapWord(m.tapped.how)}` });
  return out;
}

/** "Phone 2:10 · Telegram 2:15 · opened 2:17": where a message went (one entry per channel and time). */
export function sendTrail(m: Message): string {
  const parts = m.sends.map((s) => `${channelWord(s.channel)} ${clock(s.at)}${s.ok ? "" : " (failed)"}`);
  for (const u of userTrail(m)) parts.push(`${u.text === "You opened it" ? "opened" : tapWord(m.tapped!.how)} ${clock(u.at)}`);
  return [...new Set(parts)].join(" · ");
}

/**
 * A held item's helper line ("In the 4 pm summary: ..."; older daemons: "Held for the ..."): it was kept for a later
 * summary, so "Should have pinged me" fits. A told item's "In the 4 pm summary" has no colon and doesn't match.
 */
export const isHeldLine = (line: string | undefined) => !!line && (line.startsWith("Held for") || /^In the \S+ summary: /.test(line));

/** A board link on a line of its own ("  https://mac.ts.net/#/kanban/t_1"): left out on the page, where Open buttons do that. */
const LINK_LINE = /^\s*https?:\/\/\S*#\/\S*\s*$/;

/** A message's stored text without the board links it carried for phones (older messages keep one per ticket). */
export function withoutLinks(text: string): string {
  return text.split("\n").filter((l) => !LINK_LINE.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Rows under board headings, in first-seen order. */
export function rowsByBoard<T extends { board: string; boardName: string }>(rows: T[]): { board: string; boardName: string; rows: T[] }[] {
  const out: { board: string; boardName: string; rows: T[] }[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.board === r.board);
    if (g) g.rows.push(r);
    else out.push({ board: r.board, boardName: r.boardName, rows: [r] });
  }
  return out;
}

/** "27 more still wait on you, oldest from 12 Oct." (as the summary's text says it). */
export function stillWaitingLine(v: Pick<SummaryView, "stillCount" | "oldestAt" | "new">): string {
  const n = v.stillCount;
  const d = v.oldestAt ? new Date(v.oldestAt) : null;
  const day = d ? `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}` : null;
  return `${n}${v.new.length ? " more" : ""} still ${n === 1 ? "waits" : "wait"} on you${day ? `, oldest from ${day}` : ""}.`;
}

/** The newer and older message next to this one in a newest-first list (null at either end or when it isn't there). */
export function messageNeighbours(list: Pick<Message, "id">[], id: string): { newer: string | null; older: string | null } {
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return { newer: null, older: null };
  return { newer: list[i - 1]?.id ?? null, older: list[i + 1]?.id ?? null };
}

/** What next/previous carried from the message page it stepped from: the page it went to and that page's list. */
export interface Stepping { to: string; withHeld: boolean }

/**
 * Whether a message page's next/previous walks the list with held items: the list carried while stepping, else the
 * history's "Show held items" choice, or yes when this message is held.
 */
export function listWithHeld(stepping: Stepping | null, id: string, historyHeld: boolean, messageHeld: boolean): boolean {
  if (stepping?.to === id) return stepping.withHeld;
  return historyHeld || messageHeld;
}

/** The night question, as the board asks it (src/server/helper/settings.ts nightQuestion). */
export function nightQuestion(night: { start: string; end: string }): string {
  return `Should urgent alerts wake you at night (${night.start}-${night.end})? I'd only do it when harm keeps growing, like customers billed twice.`;
}

/** The message page asks the night question: the user hasn't chosen, and the message carries it (or is a tapped practice alert). */
export function asksNight(m: Pick<Message, "nightAsk" | "heldOvernight" | "practice" | "tapped">, nightOptIn: boolean | null | undefined): boolean {
  return nightOptIn === null && (!!m.nightAsk || !!m.heldOvernight || (!!m.practice && !!m.tapped));
}

/** The helper card's spend: "Today: 12 checks, $0.21", "Today: no checks yet". */
export function spendLine(today: { checks: number; costUsd: number } | undefined): string | null {
  if (!today) return null;
  if (!today.checks) return "Today: no checks yet";
  const usd = today.costUsd > 0 && today.costUsd < 0.01 ? "<$0.01" : `$${today.costUsd.toFixed(2)}`;
  return `Today: ${today.checks} check${today.checks === 1 ? "" : "s"}, ${usd}`;
}
