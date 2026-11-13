// Every message the board sends the user (helper or direct) is stored here before it goes out, so a tap always
// finds the full text: `<root>/messages.json`, newest last. Sent messages keep 30 days or 500 entries; the helper's
// held log rows ("Kept quiet") have their own, smaller cap (7 days or 200), so they never push real alerts out.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What kind of message it is (the page and history show it). */
export type MessageLevel = "urgent" | "reminder" | "summary" | "routine" | "pause" | "fallback" | "digest" | "hello" | "direct" | "message" | "test";

/** One ticket a message is about. */
export interface MessageItem {
  /** The wait record's key, when there is one. */
  key?: string | null;
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  /** The question text or what the ticket waits on. */
  question: string;
}

/** One row of a summary's page: a ticket (or several runs of one schedule) and what it needs. */
export interface SummaryRow {
  key?: string | null;
  board: string;
  boardName: string;
  /** The ticket Open goes to (the newest run when count is set). */
  ticketId: string;
  title: string;
  /** What it needs, short: "Ready for review", the question's first line, "4 runs ready for review". */
  label: string;
  /** When it started waiting. */
  since?: string;
  /** Runs of one repeating schedule merged into this row. */
  count?: number;
}

/** What a summary's page shows instead of its text (summaries from before this have none: the page shows the text). */
export interface SummaryView {
  new: SummaryRow[];
  /** Everything still waiting (counted in the text; the page lists them behind "Show all"). */
  still: SummaryRow[];
  stillCount: number;
  oldestAt: string | null;
  /** Waits older than the stale cut-off: counted only ("+N older in Inbox"), not listed. Missing on older summaries. */
  olderCount?: number;
  checkins: SummaryRow[];
  olderCheckins: number;
  /** Closing lines: the first summary's greeting, the check-in offer. */
  notes: string[];
  /** Rows go under board headings. */
  grouped: boolean;
}

/** How sending to one channel went. */
export interface ChannelSendRecord {
  channel: string;
  at: string;
  ok: boolean;
  /** Phones and browsers reached (push). */
  devices?: number;
  error?: string | null;
}

export interface StoredMessage {
  id: string;
  at: string;
  level: MessageLevel;
  /** The one line a phone shows. */
  oneLine: string;
  /** The full text the message page shows. */
  text: string;
  why: string | null;
  items: MessageItem[];
  sends: ChannelSendRecord[];
  readAt: string | null;
  /** The user tapped Got it or Not urgent on this alert (or another message of the same alert). */
  tapped?: { how: "got-it" | "not-urgent"; at: string } | null;
  /** Held by the helper, never sent (the log's "Show held items"). */
  held?: boolean;
  /** A summary's rows (the page renders these, not the text). */
  summary?: SummaryView;
  /** A pretend urgent alert (or its reminder) the user asked for: Got it buttons, never a wait, never counted as new. */
  practice?: boolean;
  /** Carries the night question (Yes / Not at night) while the user hasn't chosen. */
  nightAsk?: boolean;
  /** The morning message's first line: "Held overnight: <title>, marked urgent 22:35". */
  heldOvernight?: string;
}

export const MESSAGES_KEEP_MS = 30 * 24 * 3600_000;
export const MESSAGES_MAX = 500;
/** Held log rows (never sent) keep less, on their own count. */
export const HELD_KEEP_MS = 7 * 24 * 3600_000;
export const HELD_MAX = 200;

/** Keeps sent messages for 30 days / 500 rows and held log rows for 7 days / 200 rows, each counted on its own; order is kept. */
export function trimMessages(list: StoredMessage[], now: number): StoredMessage[] {
  const cut = now - MESSAGES_KEEP_MS;
  const heldCut = now - HELD_KEEP_MS;
  const keep = new Set<StoredMessage>();
  let sent = 0;
  let held = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const at = Date.parse(m.at);
    if (m.held === true) {
      if (held < HELD_MAX && at >= heldCut) {
        keep.add(m);
        held++;
      }
    } else if (sent < MESSAGES_MAX && at >= cut) {
      keep.add(m);
      sent++;
    }
  }
  return list.filter((m) => keep.has(m));
}

export type NewMessage = Pick<StoredMessage, "level" | "oneLine" | "text"> & Partial<Pick<StoredMessage, "why" | "items" | "held" | "summary" | "practice" | "nightAsk" | "heldOvernight">>;

export class MessageStore {
  readonly file: string;
  private list: StoredMessage[] | null = null;

  /** onChange: a message was added or read (the board's "Messages, N new" count follows it). */
  constructor(root: string, private now: () => number = Date.now, private onChange?: (unread: number) => void) {
    this.file = join(root, "messages.json");
  }

  private changed(): void {
    try {
      this.onChange?.(this.unread());
    } catch {}
  }

  private items(): StoredMessage[] {
    if (this.list) return this.list;
    let list: StoredMessage[] = [];
    if (existsSync(this.file)) {
      try {
        const v = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(v?.messages)) list = v.messages.filter((m: any) => m && typeof m.id === "string");
      } catch (e) {
        console.warn(`helper: messages.json could not be read (${(e as Error).message}); starting a new one`);
      }
    }
    return (this.list = list);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, messages: this.items() }) + "\n");
    renameSync(tmp, this.file);
  }

  /** Stores a new message (before it is sent) and returns it. */
  add(m: NewMessage): StoredMessage {
    const msg: StoredMessage = {
      id: `m_${this.now().toString(36)}${randomBytes(3).toString("hex")}`, at: new Date(this.now()).toISOString(),
      level: m.level, oneLine: m.oneLine, text: m.text, why: m.why ?? null, items: m.items ?? [], sends: [], readAt: null,
      ...(m.held ? { held: true } : {}), ...(m.summary ? { summary: m.summary } : {}),
      ...(m.practice ? { practice: true } : {}), ...(m.nightAsk ? { nightAsk: true } : {}), ...(m.heldOvernight ? { heldOvernight: m.heldOvernight } : {}),
    };
    const list = this.items();
    list.push(msg);
    this.list = trimMessages(list, this.now());
    this.save();
    this.changed();
    return msg;
  }

  /** Adds how the sends went. */
  recordSends(id: string, sends: ChannelSendRecord[]): StoredMessage | null {
    const m = this.get(id);
    if (!m) return null;
    m.sends.push(...sends);
    this.save();
    return m;
  }

  get(id: string): StoredMessage | null {
    return this.items().find((m) => m.id === id) ?? null;
  }

  /** Newest first. held: include held items (the helper's log). */
  listNewest(o: { held?: boolean; limit?: number } = {}): StoredMessage[] {
    const out = this.items().filter((m) => o.held || !m.held).slice().reverse();
    return o.limit ? out.slice(0, o.limit) : out;
  }

  /** Sent messages not read yet ("Messages, N new"). A practice alert never counts. */
  unread(): number {
    return this.items().filter((m) => !m.held && !m.practice && !m.readAt).length;
  }

  /** Records Got it or Not urgent on a message (the latest tap counts); it counts as read too. */
  markTapped(id: string, how: "got-it" | "not-urgent"): StoredMessage | null {
    const m = this.get(id);
    if (!m) return null;
    const at = new Date(this.now()).toISOString();
    m.tapped = { how, at };
    const read = !m.readAt;
    if (read) m.readAt = at;
    this.save();
    if (read) this.changed();
    return m;
  }

  markRead(id: string): StoredMessage | null {
    const m = this.get(id);
    if (!m) return null;
    if (!m.readAt) {
      m.readAt = new Date(this.now()).toISOString();
      this.save();
      this.changed();
    }
    return m;
  }

  /** "Mark all read": every sent message not read yet gets readAt now, in one write; read ones keep theirs. Returns how many. */
  markAllRead(): number {
    const at = new Date(this.now()).toISOString();
    let n = 0;
    for (const m of this.items()) {
      if (m.held || m.readAt) continue;
      m.readAt = at;
      n++;
    }
    if (n) {
      this.save();
      this.changed();
    }
    return n;
  }
}

// ---- the Messages screen's list: tabs, light rows, pages ----

/** The Messages screen's tabs: Needs you, All (sent), Summaries, Kept quiet (held). */
export type MessageTab = "needs" | "all" | "summaries" | "quiet";
export const MESSAGE_TABS: MessageTab[] = ["needs", "all", "summaries", "quiet"];
export const asMessageTab = (v: unknown): MessageTab => (MESSAGE_TABS.includes(v as MessageTab) ? (v as MessageTab) : "all");

/** One row of the list: only what a row shows (no text, sends, items or summary rows). */
export interface MessageRow {
  id: string;
  at: string;
  level: MessageLevel;
  oneLine: string;
  /** The row's bold line ("Ready for review", "6 new for you", the alert's line). */
  title: string;
  /** The muted second line: the ticket, the rest of a summary's line, or what a pause means. */
  sub: string;
  readAt: string | null;
  held?: boolean;
  practice?: boolean;
  /** Unread, or a ticket it names still waits on the user (and no newer message names that wait). */
  needsYou?: boolean;
}

/** A place in the newest-first list: the row's time and id (the id wins while it is still stored). */
export interface MessageCursor { at: string; id: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A ticket's title for a row, never its raw id (a ticket gone when the message was made kept its id as title). */
const itemName = (i: Pick<MessageItem, "title" | "ticketId">) => {
  const t = i.title.trim();
  return t && t !== i.ticketId && !/^t_\d{8}_\w+$/.test(t) ? t : "";
};

/** "1 ticket on rocketbots", "3 tickets on rocketbots and kanban": a row's line when no item has a title. */
function ticketsOn(items: Pick<MessageItem, "boardName" | "board">[]): string {
  const boards = [...new Set(items.map((i) => (i.boardName || i.board).trim()).filter(Boolean))];
  const n = items.length;
  const on = boards.length ? ` on ${boards.length > 2 ? `${boards.slice(0, 2).join(", ")} and ${boards.length - 2} more boards` : boards.join(" and ")}` : "";
  return `${n} ticket${n === 1 ? "" : "s"}${on}`;
}

/** A row's two lines from a stored message. */
export function rowLines(m: Pick<StoredMessage, "level" | "oneLine" | "items" | "held">): { title: string; sub: string } {
  const line = m.oneLine.trim();
  if (m.level === "pause" && !m.held) return { title: "Helper paused", sub: "It can't run right now, so you get each wait directly" };
  if (m.items.length === 1) {
    const t = itemName(m.items[0]);
    if (t && line.endsWith(`: ${t}`) && line.length > t.length + 2) return { title: clip(line.slice(0, -(t.length + 2)), 160), sub: clip(t, 120) };
  }
  if (m.level === "summary" || m.level === "digest") {
    const at = line.indexOf(": ");
    if (at > 0) return { title: clip(line.slice(0, at), 160), sub: clip(line.slice(at + 2), 120) };
  }
  const names = [...new Set(m.items.map(itemName).filter(Boolean))];
  if (!names.length && m.items.length) return { title: clip(line, 160), sub: clip(ticketsOn(m.items), 120) };
  return { title: clip(line, 160), sub: clip(names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : ""), 120) };
}

export function toRow(m: StoredMessage, needs: Set<string>): MessageRow {
  return {
    id: m.id, at: m.at, level: m.level, oneLine: clip(m.oneLine, 200), ...rowLines(m), readAt: m.readAt,
    ...(m.held ? { held: true } : {}), ...(m.practice ? { practice: true } : {}), ...(needs.has(m.id) ? { needsYou: true } : {}),
  };
}

/** Whether a message shows under a tab (needs: the ids needsYouIds found). */
export function inTab(m: Pick<StoredMessage, "id" | "level" | "held">, tab: MessageTab, needs: Set<string>): boolean {
  if (tab === "quiet") return !!m.held;
  if (m.held) return false;
  if (tab === "summaries") return m.level === "summary" || m.level === "digest";
  if (tab === "needs") return needs.has(m.id);
  return true;
}

/**
 * "Needs you", over a newest-first list: a sent message that is unread, or that names a wait still open which no newer
 * message names (so one open wait lights only its latest message). openKey: the open record's key a message's item
 * meant, or null. A summary counts its new rows only; tapped alerts and practice ones never count for open waits.
 */
export function needsYouIds(newest: StoredMessage[], openKey: (key: string, m: StoredMessage) => string | null): Set<string> {
  const out = new Set<string>();
  const claimed = new Set<string>();
  for (const m of newest) {
    if (m.held || m.practice) continue;
    const rows: { key?: string | null }[] = m.summary ? m.summary.new : m.items;
    let open = false;
    for (const r of rows) {
      const k = r.key ? openKey(r.key, m) : null;
      if (!k || claimed.has(k)) continue;
      claimed.add(k);
      open = true;
    }
    if (!m.readAt || (open && !m.tapped)) out.add(m.id);
  }
  return out;
}

/** The most ids a message page sends as keep (its Needs you tab as the user saw it). */
export const NEAR_KEEP_MAX = 300;

/** A pause and its "Missed" sent this close together show as one row (the list's PAIR_MS). */
export const PAIR_MS = 90_000;

/**
 * The Needs you badge: the rows its tab shows, so a pause and its missed message (one folded row) count once, as the
 * list folds them (each pause and missed next to each other in the tab, sent within PAIR_MS).
 */
export function needsShown(newest: Pick<StoredMessage, "id" | "at" | "level" | "held">[], needs: Set<string>): number {
  const tab = newest.filter((m) => !m.held && needs.has(m.id));
  let n = 0;
  for (let i = 0; i < tab.length; i++) {
    const a = tab[i], b = tab[i + 1];
    const pair = !!b && ((a.level === "pause" && b.level === "fallback") || (a.level === "fallback" && b.level === "pause"))
      && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= PAIR_MS;
    if (pair) i++;
    n++;
  }
  return n;
}

/** Index of the cursor in a newest-first list: its id, else the first message older than its time (end when none). */
function cursorIndex(newest: StoredMessage[], c: MessageCursor, side: "before" | "after"): number {
  const i = newest.findIndex((m) => m.id === c.id);
  if (i >= 0) return i;
  const t = Date.parse(c.at);
  // A trimmed or unknown id: place it by time (older rows follow it, newer ones come before it).
  const j = newest.findIndex((m) => (side === "before" ? Date.parse(m.at) < t || (Date.parse(m.at) === t && m.id < c.id) : Date.parse(m.at) <= t));
  return j < 0 ? newest.length : j - (side === "before" ? 1 : 0);
}

/**
 * One page of a tab, newest first. before: rows older than that row (the next page down); after: rows newer than that
 * row (what came in since the newest row shown), the newest `limit` of them with hasMore when there were more.
 */
export function pageOf(newest: StoredMessage[], o: { tab: MessageTab; limit: number; before?: MessageCursor | null; after?: MessageCursor | null }, needs: Set<string>): { rows: StoredMessage[]; hasMore: boolean } {
  let from = 0;
  let to = newest.length;
  if (o.before) from = cursorIndex(newest, o.before, "before") + 1;
  if (o.after) to = Math.min(to, cursorIndex(newest, o.after, "after"));
  const hits: StoredMessage[] = [];
  let hasMore = false;
  for (let i = Math.max(0, from); i < to; i++) {
    if (!inTab(newest[i], o.tab, needs)) continue;
    if (hits.length === o.limit) {
      hasMore = true;
      break;
    }
    hits.push(newest[i]);
  }
  return { rows: hits, hasMore };
}

/**
 * The tab a message page's up/down walks: the one the list shows when the message belongs there (Needs you keeps
 * a message it just marked read), else Kept quiet for a held message and All for the rest.
 */
export function stepTab(m: Pick<StoredMessage, "id" | "level" | "held">, tab: MessageTab, needs: Set<string>): MessageTab {
  if (inTab(m, tab, needs) || (tab === "needs" && !m.held)) return tab;
  return m.held ? "quiet" : "all";
}

/** The newer and older message next to one in a tab, by its place in the whole list (it may have left the tab). */
export function neighboursIn(newest: StoredMessage[], id: string, tab: MessageTab, needs: Set<string>): { newer: string | null; older: string | null } {
  const i = newest.findIndex((m) => m.id === id);
  if (i < 0) return { newer: null, older: null };
  let newer: string | null = null;
  for (let j = i - 1; j >= 0; j--) if (inTab(newest[j], tab, needs)) { newer = newest[j].id; break; }
  let older: string | null = null;
  for (let j = i + 1; j < newest.length; j++) if (inTab(newest[j], tab, needs)) { older = newest[j].id; break; }
  return { newer, older };
}

/**
 * A message page's up/down (/near): the tab it walks and the messages next to it there. keep (Needs you): the ids the
 * user's list showed this session, comma separated; read since, they left the tab, but still step both ways.
 */
export function nearOf(newest: StoredMessage[], msg: Pick<StoredMessage, "id" | "level" | "held">, asked: MessageTab, needs: Set<string>, keep?: string | null): { tab: MessageTab; newer: string | null; older: string | null } {
  const ids = (keep ?? "").split(",").filter(Boolean).slice(0, NEAR_KEEP_MAX);
  const walk = asked === "needs" && ids.length ? new Set([...needs, ...ids]) : needs;
  const tab = stepTab(msg, asked, walk);
  return { tab, ...neighboursIn(newest, msg.id, tab, walk) };
}
