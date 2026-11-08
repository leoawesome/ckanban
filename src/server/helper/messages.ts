// Every message the board sends the user (helper or direct) is stored here before it goes out, so a tap always
// finds the full text: `<root>/messages.json`, newest last, 30 days or 500 entries.
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
}

export const MESSAGES_KEEP_MS = 30 * 24 * 3600_000;
export const MESSAGES_MAX = 500;

export type NewMessage = Pick<StoredMessage, "level" | "oneLine" | "text"> & Partial<Pick<StoredMessage, "why" | "items" | "held">>;

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
      ...(m.held ? { held: true } : {}),
    };
    const list = this.items();
    list.push(msg);
    const cut = this.now() - MESSAGES_KEEP_MS;
    const keep = list.filter((x) => Date.parse(x.at) >= cut).slice(-MESSAGES_MAX);
    this.list = keep;
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

  /** Sent messages not read yet ("Messages, N new"). */
  unread(): number {
    return this.items().filter((m) => !m.held && !m.readAt).length;
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
}
