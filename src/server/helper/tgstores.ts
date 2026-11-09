// Small on-disk stores the Telegram bot keeps beside notify.json (all in the board's data folder):
// - TelegramLinks (telegram-links.json): which Telegram message the board sent for which stored helper message, board,
//   ticket and wait, so a reply (reply_to_message.message_id) finds its ticket. Later steps reuse it for edits.
// - PendingActions (telegram-pending.json): what a button tap does, under a short id (callback_data is 64 bytes at
//   most). A tap works once and expires after about 10 minutes.
// - UpdateQueue (telegram-updates.json): updates saved before the read position moves on, so a restart neither drops
//   one (it is handled after the restart) nor handles it twice (update ids already handled are remembered).
// Each file is written with temp file plus rename; a missing or unreadable file starts empty.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readJson(file: string): any {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`telegram: ${file} could not be read (${(e as Error).message}); starting a new one`);
    return null;
  }
}

function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** One ticket a sent Telegram message is about. key: its wait record (null: no wait, e.g. a ticket's reply sent back). */
export interface LinkItem {
  board: string;
  ticketId: string;
  key: string | null;
}

/** A message the board sent to Telegram. */
export interface TelegramLink {
  /** The bot that sent it (the token's public id): message ids start again with a new bot. */
  bot: string;
  /** Telegram's message_id. */
  tg: number;
  chatId: number;
  at: string;
  /** The stored helper message (messages.json), or null (a ticket's reply sent back to Telegram). */
  messageId: string | null;
  /** The stored message's level ("urgent", "summary", ...), or "report" for a ticket's reply sent back. */
  level: string;
  items: LinkItem[];
  /** The waits it was about closed and the message was edited to say so (front desk, f26): never edited again. */
  closedAt?: string;
}

export const LINKS_KEEP_MS = 30 * 24 * 3600_000;
export const LINKS_MAX = 2000;

/** The message map: Telegram message → what it was about. */
export class TelegramLinks {
  readonly file: string;
  private list: TelegramLink[] | null = null;

  constructor(root: string, private now: () => number = Date.now) {
    this.file = join(root, "telegram-links.json");
  }

  private items(): TelegramLink[] {
    if (this.list) return this.list;
    const v = readJson(this.file);
    this.list = Array.isArray(v?.links) ? v.links.filter((l: any) => l && Number.isSafeInteger(l.tg) && Array.isArray(l.items)) : [];
    return this.list!;
  }

  add(l: Omit<TelegramLink, "at">): TelegramLink {
    const link: TelegramLink = { ...l, at: new Date(this.now()).toISOString() };
    const cut = this.now() - LINKS_KEEP_MS;
    this.list = [...this.items().filter((x) => Date.parse(x.at) >= cut), link].slice(-LINKS_MAX);
    try {
      writeJson(this.file, { version: 1, links: this.list });
    } catch (e) {
      console.warn(`telegram: couldn't save the message map: ${(e as Error).message}`);
    }
    return link;
  }

  /** This bot's message with this id in this chat (the newest), or null (not sent by the board, another bot, or older than 30 days). */
  get(chatId: number, tg: number, bot: string): TelegramLink | null {
    return this.items().findLast((l) => l.bot === bot && l.chatId === chatId && l.tg === tg) ?? null;
  }

  /** Sent alerts (a stored helper message) about this wait that weren't edited to "closed" yet. */
  openFor(key: string): TelegramLink[] {
    return this.items().filter((l) => l.messageId && !l.closedAt && l.items.some((i) => i.key === key));
  }

  /** Notes that a message was edited to say its waits closed. */
  markClosed(l: TelegramLink): void {
    const x = this.items().find((y) => y.bot === l.bot && y.chatId === l.chatId && y.tg === l.tg);
    if (!x) return;
    x.closedAt = new Date(this.now()).toISOString();
    try {
      writeJson(this.file, { version: 1, links: this.items() });
    } catch (e) {
      console.warn(`telegram: couldn't save the message map: ${(e as Error).message}`);
    }
  }

  /** Every Telegram message sent for a stored helper message (edits in later steps). */
  forMessage(messageId: string): TelegramLink[] {
    return this.items().filter((l) => l.messageId === messageId);
  }
}

/** A button's action, kept until it is tapped (once) or expires. */
export interface PendingAction<T = any> {
  id: string;
  kind: string;
  data: T;
  at: string;
  expiresAt: string;
}

/** About 10 minutes: a tap after that is refused (the state may have changed). */
export const ACTION_TTL_MS = 10 * 60_000;

/** Short ids for callback_data ("p:<id>:<choice>" stays far below 64 bytes). */
export const ACTION_ID_RE = /^[a-z0-9]{10}$/;

/** replay: the same tap (update) took it before a restart cut its handling off: finish it (the send itself is checked for doubles). */
export type TakeResult<T> = { action: PendingAction<T>; replay?: boolean } | { gone: "expired" | "unknown" };

/** Pending button actions: single-use, expiring, on disk so a restart doesn't break a button shown before it. */
export class PendingActions {
  readonly file: string;
  private map: Record<string, PendingAction> | null = null;

  constructor(root: string, private now: () => number = Date.now) {
    this.file = join(root, "telegram-pending.json");
  }

  private items(): Record<string, PendingAction> {
    if (this.map) return this.map;
    const v = readJson(this.file);
    const out: Record<string, PendingAction> = {};
    if (v?.actions && typeof v.actions === "object") {
      for (const [k, a] of Object.entries<any>(v.actions)) if (ACTION_ID_RE.test(k) && a && typeof a.kind === "string") out[k] = a;
    }
    return (this.map = out);
  }

  private save(): void {
    // Expired ones are kept a day, so a late tap says "expired" rather than "unknown".
    const cut = this.now() - 24 * 3600_000;
    const map = this.items();
    for (const [k, a] of Object.entries(map)) if (Date.parse(a.expiresAt) < cut) delete map[k];
    writeJson(this.file, { version: 1, actions: map });
  }

  create<T>(kind: string, data: T, ttlMs = ACTION_TTL_MS): PendingAction<T> {
    const map = this.items();
    let id = "";
    do id = Array.from(randomBytes(10), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    while (map[id]);
    const now = this.now();
    const a: PendingAction<T> = { id, kind, data, at: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
    map[id] = a;
    this.save();
    return a;
  }

  /** The open action matching (by its data), e.g. the echo already shown for this update after a restart. */
  find<T = any>(fn: (a: PendingAction<T>) => boolean): PendingAction<T> | null {
    const now = this.now();
    return (Object.values(this.items()) as PendingAction<T>[]).find((a) => Date.parse(a.expiresAt) > now && !(a as any).used && fn(a)) ?? null;
  }

  /**
   * Uses the action up (saved before anything acts on it, so a second tap or a restart can't run it twice). Expired
   * or already used: gone.
   */
  take<T = any>(id: string, by?: number): TakeResult<T> {
    const map = this.items();
    const a = map[id] as (PendingAction<T> & { used?: string; usedBy?: number }) | undefined;
    if (!a) return { gone: "unknown" };
    if (a.used) return by !== undefined && a.usedBy === by ? { action: a, replay: true } : { gone: "unknown" };
    if (Date.parse(a.expiresAt) <= this.now()) return { gone: "expired" };
    a.used = new Date(this.now()).toISOString();
    if (by !== undefined) a.usedBy = by;
    this.save();
    return { action: a };
  }

  /**
   * The action as it is now, without using it up (a form's taps change it many times; only its final send takes it).
   * state: open, used (with the update that used it) or expired.
   */
  peek<T = any>(id: string): { action: PendingAction<T>; state: "open" | "used" | "expired"; usedBy?: number } | null {
    const a = this.items()[id] as (PendingAction<T> & { used?: string; usedBy?: number }) | undefined;
    if (!a) return null;
    if (a.used) return { action: a, state: "used", ...(a.usedBy !== undefined ? { usedBy: a.usedBy } : {}) };
    return { action: a, state: Date.parse(a.expiresAt) <= this.now() ? "expired" : "open" };
  }

  /** Every action kept (open, used or expired), e.g. to find the form a Telegram message belongs to. */
  all<T = any>(kind?: string): (PendingAction<T> & { used?: string; usedBy?: number })[] {
    return (Object.values(this.items()) as any[]).filter((a) => !kind || a.kind === kind);
  }

  /** Saves a changed action's data (still open or not). */
  update<T>(id: string, data: T): void {
    const a = this.items()[id];
    if (!a) return;
    a.data = data;
    this.save();
  }

  /** Notes the Telegram message that shows the action's buttons (it was shown: a replay needn't show it again). */
  shown(id: string, card: number): void {
    const a = this.items()[id] as (PendingAction & { card?: number }) | undefined;
    if (!a) return;
    a.card = card;
    this.save();
  }

  /**
   * Every open button stops working now (Pause, /lock, Unpair): they count as expired, so a late tap says so and its
   * card changes to "This expired". Returns how many.
   */
  expireAll(): number {
    const now = this.now();
    let n = 0;
    for (const a of Object.values(this.items()) as (PendingAction & { used?: string })[]) {
      if (a.used || Date.parse(a.expiresAt) <= now) continue;
      a.expiresAt = new Date(now - 1).toISOString();
      n++;
    }
    if (n) this.save();
    return n;
  }

  /** Drops an action (its card never reached the user). */
  remove(id: string): void {
    if (!this.items()[id]) return;
    delete this.items()[id];
    this.save();
  }
}

/** Update ids already handled are remembered this many (Telegram keeps undelivered updates for a day). */
export const SEEN_MAX = 1000;

/** Updates waiting to be handled, saved before the read position moves on. */
export class UpdateQueue {
  /** null: kept in memory only. */
  readonly file: string | null;
  private data: { bot: string; items: any[]; seen: number[] } | null = null;

  constructor(root: string | null, private bot: () => string) {
    this.file = root ? join(root, "telegram-updates.json") : null;
  }

  private load(): { bot: string; items: any[]; seen: number[] } {
    const bot = this.bot();
    if (this.data && this.data.bot === bot) return this.data;
    const v = this.data || !this.file ? null : readJson(this.file);
    // Saved for another bot (the token changed): its updates aren't this bot's.
    this.data = v?.bot === bot && Array.isArray(v.items) && Array.isArray(v.seen)
      ? { bot, items: v.items.filter((u: any) => Number.isSafeInteger(u?.update_id)), seen: v.seen.filter(Number.isSafeInteger) }
      : { bot, items: [], seen: [] };
    return this.data;
  }

  private save(): void {
    if (this.file) writeJson(this.file, this.load());
  }

  /** Adds updates not seen or queued yet; returns the ones added. Saved before it returns (throws when it can't be). */
  add(updates: any[]): any[] {
    const d = this.load();
    const have = new Set([...d.seen, ...d.items.map((u) => u.update_id)]);
    const fresh = updates.filter((u) => Number.isSafeInteger(u?.update_id) && !have.has(u.update_id) && (have.add(u.update_id), true));
    if (fresh.length) {
      d.items.push(...fresh);
      this.save();
    }
    return fresh;
  }

  /** Updates still to handle, oldest first. */
  pending(): any[] {
    return [...this.load().items];
  }

  /** Handled: off the queue, its id remembered. */
  done(updateId: number): void {
    const d = this.load();
    d.items = d.items.filter((u) => u.update_id !== updateId);
    if (!d.seen.includes(updateId)) d.seen = [...d.seen, updateId].slice(-SEEN_MAX);
    try {
      this.save();
    } catch (e) {
      console.warn(`telegram: couldn't save the update queue: ${(e as Error).message}`);
    }
  }

  /** Drops every update still waiting (Pause, /lock, Unpair): marked handled, so none is handled later. Returns how many. */
  clear(): number {
    const d = this.load();
    const n = d.items.length;
    if (!n) return 0;
    d.seen = [...d.seen, ...d.items.map((u) => u.update_id).filter((id) => !d.seen.includes(id))].slice(-SEEN_MAX);
    d.items = [];
    this.save();
    return n;
  }

  seen(updateId: number): boolean {
    return this.load().seen.includes(updateId);
  }
}
