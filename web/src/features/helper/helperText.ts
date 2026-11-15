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

// ---- the Messages list: tabs, light rows, folding ----

/** The Messages screen's tabs (src/server/helper/messages.ts MessageTab); Needs you opens first. */
export type MessageTab = "needs" | "all" | "summaries" | "quiet";
export const MESSAGE_TABS: { id: MessageTab; label: string }[] = [
  { id: "needs", label: "Needs you" }, { id: "all", label: "All" }, { id: "summaries", label: "Summaries" }, { id: "quiet", label: "Kept quiet" },
];
export const asTab = (v: unknown): MessageTab => (MESSAGE_TABS.some((t) => t.id === v) ? (v as MessageTab) : "needs");

/** One row of the list (GET /api/messages; src/server/helper/messages.ts MessageRow). */
export interface MessageRow {
  id: string;
  at: string;
  level: MessageLevel;
  oneLine: string;
  title: string;
  sub: string;
  readAt: string | null;
  held?: boolean;
  practice?: boolean;
  needsYou?: boolean;
}

/** GET /api/messages: one page of a tab. */
export interface MessagePage { rows: MessageRow[]; hasMore: boolean; needs: number; unread: number }

/** The query for a page: the tab, then the row to load below (older) or above (newer). */
export function pageQuery(tab: MessageTab, o: { before?: MessageRow | null; after?: MessageRow | null; limit?: number } = {}): string {
  const q = new URLSearchParams({ tab, limit: String(o.limit ?? 30) });
  if (o.before) { q.set("beforeAt", o.before.at); q.set("beforeId", o.before.id); }
  if (o.after) { q.set("afterAt", o.after.at); q.set("afterId", o.after.id); }
  return q.toString();
}

/** Newer rows on top of the loaded ones (no row twice; the newer copy wins). */
export function prependRows(rows: MessageRow[], newer: MessageRow[]): MessageRow[] {
  const ids = new Set(newer.map((r) => r.id));
  return [...newer, ...rows.filter((r) => !ids.has(r.id))];
}

/** The next page under the loaded rows (no row twice). */
export function appendRows(rows: MessageRow[], older: MessageRow[]): MessageRow[] {
  const ids = new Set(rows.map((r) => r.id));
  return [...rows, ...older.filter((r) => !ids.has(r.id))];
}

/** Unread and not held: a dot and a bold title. */
export const isFresh = (r: Pick<MessageRow, "readAt" | "held" | "practice">) => !r.readAt && !r.held && !r.practice;

/** Routine rows ("Ready for review", "Claude replied"): runs of two or more fold into "N updates". */
export const isUpdate = (r: Pick<MessageRow, "level" | "held">) => !r.held && (r.level === "direct" || r.level === "routine");

/** A pause and its "Missed" sent this close together become one row. */
export const PAIR_MS = 90_000;

/** One line of the list: a message, a pause with its missed waits, or a run of updates. */
export type ListEntry =
  | { kind: "one"; row: MessageRow }
  | { kind: "pair"; pause: MessageRow; missed: MessageRow }
  | { kind: "group"; rows: MessageRow[] };

export const entryKey = (e: ListEntry) => (e.kind === "one" ? e.row.id : e.kind === "pair" ? e.missed.id : `g-${e.rows.at(-1)!.id}`);
export const entryRows = (e: ListEntry): MessageRow[] => (e.kind === "one" ? [e.row] : e.kind === "pair" ? [e.missed, e.pause] : e.rows);

const isPairOf = (a: MessageRow, b: MessageRow) =>
  !a.held && !b.held && ((a.level === "pause" && b.level === "fallback") || (a.level === "fallback" && b.level === "pause"))
  && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= PAIR_MS;

/** Folds a newest-first run of rows (one day's): pause + missed pairs into one, runs of 2+ updates into a group. */
export function foldRows(rows: MessageRow[]): ListEntry[] {
  const out: ListEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const next = rows[i + 1];
    if (next && isPairOf(r, next)) {
      out.push(r.level === "pause" ? { kind: "pair", pause: r, missed: next } : { kind: "pair", pause: next, missed: r });
      i++;
      continue;
    }
    if (isUpdate(r)) {
      let j = i;
      while (j + 1 < rows.length && isUpdate(rows[j + 1])) j++;
      if (j > i) {
        out.push({ kind: "group", rows: rows.slice(i, j + 1) });
        i = j;
        continue;
      }
    }
    out.push({ kind: "one", row: r });
  }
  return out;
}

/** Day headings (Today, Yesterday, dates) over the loaded rows, each day folded on its own. */
export function foldByDay(rows: MessageRow[], now = Date.now()): { day: string; entries: ListEntry[] }[] {
  const days: { day: string; rows: MessageRow[] }[] = [];
  for (const r of rows) {
    const day = dayLabel(r.at, now);
    const last = days.at(-1);
    if (last && last.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
  }
  return days.map((d) => ({ day: d.day, entries: foldRows(d.rows) }));
}

/** A folded row's two lines: "Helper paused · 5 tickets wait on you", "4 updates" naming the first few. */
export function entryLines(e: ListEntry): { title: string; sub: string } {
  if (e.kind === "one") return { title: e.row.title, sub: e.row.sub || levelLabel(e.row.level, e.row.held, e.row.practice) };
  if (e.kind === "pair") return { title: `Helper paused · ${e.missed.title}`, sub: e.pause.sub || "It can't run right now, so you get each wait directly" };
  const names = [...new Set(e.rows.map((r) => r.sub || r.title).filter(Boolean))];
  return { title: `${e.rows.length} updates`, sub: names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "") };
}

/** The round icon on a row: its colour and the character in it. */
export function rowIcon(e: ListEntry): { tone: "urgent" | "sum" | "ok" | "warn" | "plain"; glyph: string } {
  if (e.kind === "pair") return { tone: "warn", glyph: "!" };
  if (e.kind === "group") return { tone: "plain", glyph: String(e.rows.length) };
  const r = e.row;
  const tone = levelTone(r.level, r.held, r.practice);
  if (r.held) return { tone, glyph: "z" };
  if (r.level === "summary" || r.level === "digest") return { tone, glyph: /^(\d+)\b/.exec(r.title)?.[1] ?? "Σ" };
  if (tone === "urgent" || tone === "warn") return { tone, glyph: "!" };
  if (r.level === "hello" || r.level === "test") return { tone, glyph: "✓" };
  if (r.level === "message") return { tone, glyph: "✉" };
  return { tone, glyph: "✓" };
}

/** "Loading more of today…", "Loading more of Mon 3 Nov…": the day the next page continues. */
export function loadingMoreLine(last: MessageRow | undefined, now = Date.now()): string {
  if (!last) return "Loading…";
  const day = dayLabel(last.at, now);
  return `Loading more of ${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}…`;
}

/** What each tab says when it has nothing. */
export function emptyLine(tab: MessageTab): string {
  if (tab === "needs") return "Nothing needs you right now. New and unanswered messages show here.";
  if (tab === "summaries") return "No summaries yet.";
  if (tab === "quiet") return "The helper hasn't kept anything quiet in the last 7 days.";
  return "No messages yet. When the helper tells you something, it shows here.";
}
