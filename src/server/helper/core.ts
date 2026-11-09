// The helper's board side, without the AI: wait records, the message store, channels and the routing switch.
// Helper on (and a runner plugged in and healthy): new waits become records and go to the runner (HelperSink).
// Helper off, missing or failing: the board sends each wait directly, as before, but every send is stored as a
// message and its record marked told, so nothing goes out twice.
import type { NotifyMessage, NotifySettings } from "../notify";
import type { Store } from "../store";
import { Channels, tapTicket, type ChannelResult, type OutMessage } from "./channels";
import { MessageStore, type MessageItem, type NewMessage, type StoredMessage } from "./messages";
import { pending, WaitStore, type NewWait, type ToldVia, type WaitRecord } from "./waits";

/** Why the runner hears about a record. */
export type WaitEventReason = "new" | "urgent" | "seeded" | "restart" | "message";

/**
 * The helper runner plugs in here (Notifier.helper.setSink). While a sink is set, healthy and the helper is on,
 * waits go to it instead of straight out; the board still sends a wait itself if no run succeeded within 5 minutes
 * of it (fallbackAt) or no message named it within 4 hours (digestAt).
 */
export interface HelperSink {
  /** False while runs keep failing (3 in a row): waits go out directly meanwhile. */
  healthy(): boolean;
  /** When a helper run last succeeded (ms), or null. */
  lastSuccessAt(): number | null;
  /** A record opened (or turned urgent). The runner batches and wakes. */
  onWait(rec: WaitRecord, reason: WaitEventReason): void;
  /**
   * If `now` is inside the user's night: when its held digest goes (ms), the night's end plus a grace so the helper's
   * morning summary goes first; else null. Direct sends because the helper failed hold non-urgent waits until then.
   */
  morning?(now: number): number | null;
  /** The user allowed urgent alerts to wake them at night (settings nightAllowed). Missing: not allowed. */
  nightAllowed?(): boolean;
}

/** An urgent message about a ticket within this long counts as "urgent" for night-time direct sends. */
export const URGENT_RECENT_MS = 24 * 3600_000;

/** Phone line length. */
export const ONE_LINE_MAX = 110;
/** Usage-limit waits within this time of the first go out as one merged line. */
export const LIMIT_BATCH_MS = 60_000;

export const cut = (s: string, max = ONE_LINE_MAX) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** "3:00" or "15:30" in this Mac's time: the way the board writes a reset time. */
/**
 * Where a message's ticket stands now: still open, answered (or seen, or no longer waiting: how), or removed (the
 * ticket or its board is gone). at: when it closed.
 */
export interface ItemState {
  state: "open" | "answered" | "removed";
  at?: string | null;
  how?: "answered" | "seen" | "done";
}

/** The itemState key of a message item or summary row: its wait's key, else "<board>/<ticketId>". */
export function itemStateKey(i: { key?: string | null; board: string; ticketId: string }): string {
  return i.key || `${i.board}/${i.ticketId}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The merged usage-limit line: "Usage limit: 4 tickets paused until 3:00". */
export function usageLimitLine(count: number, resetAt: string | null): string {
  const n = count === 1 ? "1 ticket" : `${count} tickets`;
  return `Usage limit: ${n} paused${resetAt ? ` until ${clockTime(resetAt)}` : ""}`;
}

/** What a push says a ticket needs: the question's first line (never just "Answer 1 question"), else the label. */
export function directLabel(rec: Pick<WaitRecord, "kind" | "question" | "label">): string {
  if (rec.kind !== "questions" || !rec.question || rec.question === rec.label) return rec.label;
  const lines = rec.question.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return rec.label;
  return cut(lines[0], ONE_LINE_MAX);
}

/** What a send carries; url may be built from the stored message's id. */
export type OutBody = Omit<OutMessage, "messageId" | "url"> & { url: string | ((messageId: string) => string) };

/**
 * What Got it, Not urgent and /waiting do. The board's buttons and Telegram's call the same HelperCore methods; the
 * runner may replace any of them (setActions), e.g. to note feedback or answer /waiting from its summary builder.
 */
export interface HelperActions {
  /** Got it: the message's reminders stop (no re-alert). Returns a short reply for the user. */
  gotIt(messageId: string, via: string): Promise<string> | string;
  /** Not urgent: the message's reminders stop at once; returns "Stopped reminders for <title>". */
  notUrgent(messageId: string, via: string): Promise<string> | string;
  /** What waits on the user now, as plain text (Telegram's /waiting). */
  waiting(): Promise<string> | string;
  /** Yes / Not at night on a message that asks the night question; returns the reply. */
  night(messageId: string, allow: boolean, via: string): Promise<string> | string;
  /** After Got it / Not urgent on this message: the night question to offer next, or null. */
  nightAfter(messageId: string): string | null;
}

export interface HelperCoreDeps {
  root: string;
  store: Store;
  channels: Channels;
  settings: () => NotifySettings;
  link: (slug: string, id?: string) => string;
  now?: () => number;
  /** Called with every channel result (the Notifier keeps lastSentAt / lastError). */
  onResults?: (results: ChannelResult[]) => void;
  /** A message was stored or read: the new unread count. */
  onMessages?: (unread: number) => void;
}

export class HelperCore {
  readonly waits: WaitStore;
  readonly messages: MessageStore;
  readonly channels: Channels;
  private sink: HelperSink | null = null;
  private actions: Partial<HelperActions> = {};
  private listeners = new Set<(rec: WaitRecord, reason: WaitEventReason) => void>();
  private now: () => number;
  /** The usage-limit batch (direct mode): when the first limit went out, and the keys waiting to be merged. */
  private limitWindow: { at: number; sent: string[]; batch: string[] } | null = null;

  constructor(private d: HelperCoreDeps) {
    this.now = d.now ?? Date.now;
    this.waits = new WaitStore(d.root, this.now);
    this.messages = new MessageStore(d.root, this.now, d.onMessages);
    this.channels = d.channels;
  }

  /** The runner plugs in (null unplugs). Plug in before Notifier.start so start-up seeds for the helper. */
  setSink(sink: HelperSink | null): void {
    this.sink = sink;
  }

  /** Replaces what Got it, Not urgent or /waiting do (the runner's own handlers). */
  setActions(a: Partial<HelperActions>): void {
    this.actions = { ...this.actions, ...a };
  }

  /** Got it on a message (board button or Telegram): its records' reminders stop; the message counts as read. */
  async gotIt(messageId: string, via = "board"): Promise<string> {
    if (this.actions.gotIt) return this.actions.gotIt(messageId, via);
    const msg = this.messages.get(messageId);
    if (!msg) return "That message is gone.";
    let stopped = 0;
    for (const it of msg.items) {
      const r = it.key ? this.waits.forMessage(it.key, msg) : undefined;
      if (r && this.waits.stopReminders(r.key, "got-it")) stopped++;
    }
    this.messages.markTapped(messageId, "got-it");
    return stopped ? "Got it. No more reminders for this." : "Got it.";
  }

  /** Not urgent on a message: its records' reminders stop at once. */
  async notUrgent(messageId: string, via = "board"): Promise<string> {
    if (this.actions.notUrgent) return this.actions.notUrgent(messageId, via);
    const msg = this.messages.get(messageId);
    if (!msg) return "That message is gone.";
    for (const it of msg.items) {
      const r = it.key ? this.waits.forMessage(it.key, msg) : undefined;
      if (r) this.waits.stopReminders(r.key, "not-urgent");
    }
    this.messages.markTapped(messageId, "not-urgent");
    const titles = msg.items.map((i) => i.title);
    return titles.length ? cut(`Stopped reminders for ${titles.join(", ")}`, 190) : "Noted: not urgent.";
  }

  /** Yes / Not at night (Telegram's buttons; the page saves the setting itself). */
  async nightAnswer(messageId: string, allow: boolean, via = "board"): Promise<string> {
    if (this.actions.night) return this.actions.night(messageId, allow, via);
    return "That button no longer works.";
  }

  /** The night question to offer after a tap on this message, or null. */
  nightAfter(messageId: string): string | null {
    return this.actions.nightAfter?.(messageId) ?? null;
  }

  /** What waits on the user now, one line per ticket (Telegram's /waiting). */
  async waitingText(): Promise<string> {
    if (this.actions.waiting) return this.actions.waiting();
    const open = this.waits.open();
    if (!open.length) return "Nothing waits on you right now.";
    const lines = open.map((r) => {
      const it = this.item(r);
      return `- ${it.title} (${it.boardName}): ${directLabel(r)}${r.urgent ? " [urgent]" : ""}`;
    });
    return [`${open.length === 1 ? "1 ticket waits" : `${open.length} tickets wait`} on you:`, ...lines].join("\n");
  }

  /** Hears about every record that opens for the helper (besides the sink). Returns an unsubscribe. */
  subscribe(fn: (rec: WaitRecord, reason: WaitEventReason) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The helper setting is on and a runner is plugged in (it may be failing). */
  plugged(settings = this.d.settings()): boolean {
    return settings.helper && !!this.sink;
  }

  /** Waits go to the helper now (on, plugged in, healthy). */
  active(settings = this.d.settings()): boolean {
    return this.plugged(settings) && this.sink!.healthy();
  }

  private emit(rec: WaitRecord, reason: WaitEventReason): void {
    try {
      this.sink?.onWait(rec, reason);
    } catch (e) {
      console.error("helper: sink", e);
    }
    for (const fn of this.listeners) {
      try {
        fn(rec, reason);
      } catch (e) {
        console.error("helper: listener", e);
      }
    }
  }

  /**
   * A ticket started waiting (or a new question on a waiting ticket). Helper active: open a record and hand it to the
   * runner. Otherwise: open it and send it directly (usage limits merged).
   */
  async route(w: NewWait): Promise<WaitRecord> {
    const settings = this.d.settings();
    const before = this.waits.get(`${w.board}/${w.ticketId}|${w.identity}`);
    const existed = !!before && !before.closedAt;
    const wasUrgent = existed && !!before!.urgent;
    const rec = this.waits.add(w);
    if (this.active(settings)) {
      if (!existed) this.emit(rec, w.kind === "message" ? "message" : "new");
      else if (rec.urgent && !wasUrgent) this.emit(rec, "urgent");
      return rec;
    }
    if (rec.toldAt) return rec;
    // The helper is on but failing: at night only urgent waits go out now; the rest wait for the morning digest.
    if (this.plugged(settings) && !this.holdForMorning([rec]).length) return rec;
    if (rec.kind === "limit") await this.directLimit(rec);
    else await this.sendDirect([rec.key]);
    return rec;
  }

  /**
   * Start-up for one ticket: what waits now (or null), given how the waits file was found. steps: on a main ticket,
   * the questions its steps wait on (one wait each, see Notifier.stepAsks); their records stay open and missing ones
   * open like `w`. fromStep: `w` is a step's question shown on the main ticket.
   */
  reconcile(board: string, ticketId: string, w: NewWait | null, identity: string | null, o: { steps?: NewWait[]; fromStep?: boolean } = {}): void {
    const plugged = this.plugged();
    // A step's question recorded before the board knew its text (kept under its main ticket as plain "questions"): the
    // same wait, so it moves to its real key, told state kept, instead of closing and alerting again.
    if (w && o.fromStep && w.identity !== "questions") {
      const from = this.waits.get(`${board}/${ticketId}|questions`);
      const moved = this.waits.rekey(`${board}/${ticketId}|questions`, w);
      if (moved && plugged && moved.urgent && !from?.urgent && !moved.toldAt) this.emit(moved, "urgent");
    }
    const keep = new Set([identity, ...(o.steps ?? []).map((s) => s.identity)].filter(Boolean).map((i) => `${board}/${ticketId}|${i}`));
    for (const r of this.waits.openFor(board, ticketId)) {
      if (r.kind === "message") continue;
      if (!keep.has(r.key)) this.waits.close([r.key], r.kind === "questions" ? "answered" : "cleared");
    }
    const seen = new Set<string>();
    for (const x of [w, ...(o.steps ?? [])]) {
      if (!x || seen.has(x.identity)) continue;
      seen.add(x.identity);
      this.openAtStart(x, plugged);
    }
  }

  private openAtStart(w: NewWait, plugged: boolean): void {
    if (this.waits.get(`${w.board}/${w.ticketId}|${w.identity}`)?.closedAt === null) return;
    if (this.waits.start === "missing") {
      // Fresh install or upgrade: no fallback; the helper's first summary takes them (or, without a helper, they count as told).
      const rec = this.waits.add(w, plugged ? { seeded: true } : { told: "seed" });
      if (plugged) {
        if (!this.waits.firstSummaryPending) this.waits.firstSummaryPending = true;
        this.emit(rec, "seeded");
      }
      return;
    }
    // Restart (or a corrupt file set aside): a wait with no record opens a normal one for the helper; without a helper,
    // as before, what already waits at start-up isn't sent again.
    const rec = this.waits.add(w, plugged ? {} : { told: "restart" });
    if (plugged) this.emit(rec, "restart");
  }

  /** Start-up is done: the waits file exists from now on (the next start is a restart, not an upgrade). */
  started(): void {
    this.waits.save();
  }

  /** The ticket no longer waits on these (answered, cleared). Passed-on messages close only when nothing waits any more. */
  settled(board: string, ticketId: string, identity: string | null, steps: string[] = []): void {
    // A main ticket's steps that still wait on a question keep their records (steps: their identities).
    const keep = new Set([identity, ...steps].filter(Boolean).map((i) => `${board}/${ticketId}|${i}`));
    const recs = this.waits.openFor(board, ticketId).filter((r) => !keep.has(r.key) && (r.kind !== "message" || !identity));
    for (const r of recs) this.waits.close([r.key], r.kind === "questions" ? "answered" : "cleared");
  }

  /** A main ticket's step no longer waits on its question (answered, or the main ticket dealt with it): its record closes. */
  stepSettled(board: string, ticketId: string, identity: string, current: string | null): void {
    if (identity === current) return;
    this.waits.close([`${board}/${ticketId}|${identity}`], "answered");
  }

  /** The ticket (or, without ticketId, the board) was deleted: its records close and reminders stop at once. */
  deleted(board: string, ticketId?: string): void {
    this.waits.close(this.waits.openFor(board, ticketId).map((r) => r.key), "deleted");
  }

  /** The user opened the ticket. */
  opened(board: string, ticketId: string): void {
    this.waits.opened(board, ticketId);
  }

  /** The message item for a record: its ticket title and board name as the board knows them now. */
  item(rec: WaitRecord): MessageItem {
    const t = this.d.store.getTicket(rec.board, rec.ticketId);
    const p = this.d.store.getProfile(rec.board);
    return { key: rec.key, board: rec.board, boardName: p?.name ?? rec.board, ticketId: rec.ticketId, title: t?.title ?? rec.ticketId, question: rec.question };
  }

  /**
   * Where each ticket of a message stands now (its page shows "Answered 14:02" or "Ticket removed"), keyed by
   * itemStateKey: the wait it told about, closed or not, or removed when the ticket (or its board) is gone.
   */
  itemStates(m: StoredMessage): Record<string, ItemState> {
    const out: Record<string, ItemState> = {};
    const rows: { key?: string | null; board: string; ticketId: string }[] = [
      ...m.items, ...(m.summary ? [...m.summary.new, ...m.summary.still, ...m.summary.checkins] : []),
    ];
    for (const i of rows) {
      const k = itemStateKey(i);
      if (out[k]) continue;
      const rec = i.key ? this.waits.forMessage(i.key, m) : undefined;
      if (!this.d.store.getTicket(i.board, i.ticketId) || rec?.closedWhy === "deleted") {
        out[k] = { state: "removed", at: rec?.closedWhy === "deleted" ? rec.closedAt : null };
      } else if (rec?.closedAt) {
        out[k] = { state: "answered", at: rec.closedAt, how: rec.closedWhy === "opened" ? "seen" : rec.closedWhy === "answered" ? "answered" : "done" };
      } else out[k] = { state: "open" };
    }
    return out;
  }

  /** A message with its tickets' states (GET /api/messages/:id and the page's buttons). */
  withStates(m: StoredMessage): StoredMessage & { itemState: Record<string, ItemState> } {
    return { ...m, itemState: this.itemStates(m) };
  }

  /**
   * Stores the message, sends it to the channels (default: every one that is on) and records how that went. url may be
   * a function of the stored message's id (a link to its message page).
   */
  async send(m: NewMessage, out: OutBody, only?: string[]): Promise<{ message: StoredMessage; results: ChannelResult[] }> {
    const message = this.messages.add(m);
    const results = await this.deliver(message, out, only);
    return { message, results };
  }

  /**
   * Sends a stored message. only: these channels at once; chain: one at a time in this order, moving to the next at
   * once when a send fails (0 devices or an error), until one reaches the user.
   */
  async deliver(message: StoredMessage, out: OutBody, only?: string[], chain?: string[]): Promise<ChannelResult[]> {
    const full: OutMessage = {
      ...out, url: typeof out.url === "function" ? out.url(message.id) : out.url, messageId: message.id, ticket: tapTicket(message),
    };
    const record = (results: ChannelResult[]) => {
      const at = new Date(this.now()).toISOString();
      this.messages.recordSends(message.id, results.filter((r) => !r.skipped).map((r) => ({
        channel: r.channel, at, ok: r.ok, ...(r.devices !== undefined ? { devices: r.devices } : {}), error: r.error,
      })));
      this.d.onResults?.(results);
    };
    if (!chain) {
      const results = await this.channels.sendAll(full, this.d.settings(), only);
      record(results);
      return results;
    }
    const all: ChannelResult[] = [];
    for (const name of chain) {
      const results = await this.channels.sendAll(full, this.d.settings(), [name]);
      record(results);
      all.push(...results);
      if (results.some((r) => r.ok)) break;
    }
    return all;
  }

  /**
   * The ticket counts as urgent at night: the asker marked the wait urgent, or an urgent alert (or its reminder) named
   * the ticket in the last 24 hours.
   */
  urgentForNight(rec: WaitRecord): boolean {
    if (rec.urgent) return true;
    const since = this.now() - URGENT_RECENT_MS;
    return this.messages.listNewest().some((m) => (m.level === "urgent" || m.level === "reminder") && Date.parse(m.at) >= since
      && m.items.some((i) => i.board === rec.board && i.ticketId === rec.ticketId));
  }

  /**
   * Night: during the user's night only urgent records go out now (returned), and only if the user allowed night
   * wake-ups; the rest stay untold, their fallback dropped and their digest moved to the morning, so the helper's
   * morning message (or the morning digest, if the helper fails) takes them. Nothing is dropped. A held record that
   * counts as urgent is marked (nightHeldAt) so the morning message says so. Outside the night: all of them.
   */
  holdForMorning(recs: WaitRecord[]): WaitRecord[] {
    const morning = this.sink?.morning?.(this.now()) ?? null;
    if (morning === null) return recs;
    const allowed = this.sink?.nightAllowed?.() === true;
    const at = new Date(morning).toISOString();
    const nowIso = new Date(this.now()).toISOString();
    const now: WaitRecord[] = [];
    let held = 0;
    for (const r of recs) {
      const urgent = this.urgentForNight(r);
      if (urgent && allowed) now.push(r);
      else {
        this.waits.update(r.key, { fallbackAt: null, digestAt: at, ...(urgent && !r.nightHeldAt ? { nightHeldAt: nowIso } : {}) });
        held++;
      }
    }
    if (held) console.warn(`helper: night: holding ${held} wait${held === 1 ? "" : "s"} for the morning (${clockTime(at)} at the latest)`);
    return now;
  }

  /**
   * The morning message's first line for records held overnight while urgent: "Held overnight: Billing, marked
   * urgent 22:35" (several joined with "; "), or null.
   */
  heldOvernightLine(recs: WaitRecord[]): string | null {
    // Only waits not told yet: a wait the morning message already told doesn't carry the line into a later alert.
    const held = recs.filter((r) => r.nightHeldAt && !r.toldAt);
    if (!held.length) return null;
    return `Held overnight: ${held.map((r) => `${this.item(r).title}, marked urgent ${clockTime(r.nightHeldAt!)}`).join("; ")}`;
  }

  /** Marks records told by a message (the runner calls this for what its message named). */
  markTold(keys: string[], via: ToldVia, messageId?: string | null): void {
    this.waits.markTold(keys, via, messageId);
  }

  /** Sends these open, untold records directly, one message per ticket (as before the helper), and marks them told. */
  async sendDirect(keys: string[], level: "direct" | "fallback" = "direct"): Promise<void> {
    for (const key of keys) {
      const rec = this.waits.get(key);
      if (!rec || rec.closedAt || rec.toldAt) continue;
      const it = this.item(rec);
      const label = directLabel(rec);
      const notify: NotifyMessage = {
        board: rec.board, boardName: it.boardName, ticketId: rec.ticketId, title: it.title, kind: rec.kind, label, url: this.d.link(rec.board, rec.ticketId),
      };
      // Told before the send resolves: a tick meanwhile must not send it again.
      this.waits.markTold([key], "direct");
      const text = [`${it.title} (${it.boardName})`, rec.question || rec.label, ...(rec.why ? [`Why: ${rec.why}`] : [])].join("\n\n");
      const { message } = await this.send(
        { level: rec.urgent ? "urgent" : level, oneLine: cut(`${label}: ${it.title}`), text, why: rec.why ?? null, items: [it] },
        { level: rec.urgent ? "urgent" : level, title: it.title, body: label, text, url: notify.url, notify, urgent: rec.urgent, everyDevice: rec.urgent },
      );
      this.waits.update(key, { messageId: message.id });
    }
  }

  /** A usage-limit wait, helper not active: the first goes out at once, more within LIMIT_BATCH_MS merge into one line. */
  private async directLimit(rec: WaitRecord): Promise<void> {
    const now = this.now();
    if (this.limitWindow && now - this.limitWindow.at < LIMIT_BATCH_MS) {
      this.waits.markTold([rec.key], "direct");
      this.limitWindow.batch.push(rec.key);
      return;
    }
    this.limitWindow = { at: now, sent: [rec.key], batch: [] };
    await this.sendDirect([rec.key]);
  }

  /** Sends the merged usage-limit line once the batch window ends. */
  private async flushLimits(): Promise<void> {
    const w = this.limitWindow;
    if (!w || this.now() - w.at < LIMIT_BATCH_MS) return;
    this.limitWindow = null;
    if (!w.batch.length) return;
    const recs = [...w.sent, ...w.batch].map((k) => this.waits.get(k)).filter((r): r is WaitRecord => !!r);
    const resets = recs.map((r) => this.d.store.getTicket(r.board, r.ticketId)?.limit?.resetAt).filter((x): x is string => !!x).sort();
    const line = usageLimitLine(recs.length, resets.at(-1) ?? null);
    const items = recs.map((r) => this.item(r));
    const text = [line, ...items.map((i) => `- ${i.title} (${i.boardName})`)].join("\n");
    const url = this.d.link(recs[0]?.board ?? "");
    const names = cut(items.map((i) => i.title).join(", "));
    const notify: NotifyMessage = { board: recs[0]?.board ?? "", boardName: items[0]?.boardName ?? "ckanban", ticketId: "", title: line, kind: "message", label: names, url };
    const { message } = await this.send({ level: "direct", oneLine: line, text, items }, { level: "direct", title: line, body: names, text, url, tag: "usage-limit", notify });
    for (const k of w.batch) this.waits.update(k, { messageId: message.id });
  }

  /**
   * Once a second: the merged usage-limit line, the 5-minute fallback (no helper run succeeded since the record was
   * queued) and the 4-hour fallback digest (no message named it).
   */
  async tick(): Promise<void> {
    await this.flushLimits();
    const now = this.now();
    const last = this.sink?.lastSuccessAt() ?? null;
    const open = this.waits.open().filter((r) => !r.toldAt);
    const fallback = this.holdForMorning(open.filter((r) => r.fallbackAt && Date.parse(r.fallbackAt) <= now && (last === null || last < Date.parse(r.queuedAt))));
    if (fallback.length) {
      console.warn(`helper: no helper run in 5 minutes, sending ${fallback.length} directly`);
      await this.sendDirect(fallback.map((r) => r.key), "fallback");
    }
    // A wait the Telegram front desk already showed the user (seenInChatAt) isn't missed: no digest for it. Its urgent
    // alert and the 5-minute fallback still go by toldAt.
    const digest = this.holdForMorning(this.waits.open().filter((r) => !r.toldAt && !r.seenInChatAt && r.digestAt && Date.parse(r.digestAt) <= now));
    if (digest.length) {
      console.warn(`helper: helper missed ${digest.length} waits for 4 hours, sending a digest`);
      await this.digest(digest, "fallback", "The helper didn't tell you about these in time, so the board sends them itself.");
    }
  }

  /** One direct message naming several records; marks them told. */
  async digest(recs: WaitRecord[], level: "fallback" | "digest", why: string): Promise<StoredMessage | null> {
    const fresh = recs.filter((r) => !r.closedAt && !r.toldAt);
    if (!fresh.length) return null;
    // Before the told mark: the line names waits held overnight that no message told yet.
    const overnight = this.heldOvernightLine(fresh);
    this.waits.markTold(fresh.map((r) => r.key), "digest");
    const items = fresh.map((r) => this.item(r));
    const oneLine = fresh.length === 1 ? cut(`${directLabel(fresh[0])}: ${items[0].title}`) : `${fresh.length} tickets wait on you`;
    const text = [...(overnight ? [overnight] : []), oneLine, ...items.map((it, i) => `- ${it.title} (${it.boardName}): ${directLabel(fresh[i])}`)].join("\n");
    const url = fresh.length === 1 ? this.d.link(fresh[0].board, fresh[0].ticketId) : this.d.link(fresh[0].board);
    const notify: NotifyMessage = { board: fresh[0].board, boardName: items[0].boardName, ticketId: fresh.length === 1 ? fresh[0].ticketId : "", title: fresh.length === 1 ? items[0].title : "ckanban", kind: "message", label: fresh.length === 1 ? directLabel(fresh[0]) : oneLine, url };
    const urgent = fresh.some((r) => r.urgent);
    const { message } = await this.send(
      { level, oneLine, text, why, items, ...(overnight ? { heldOvernight: overnight, nightAsk: this.sink?.nightAllowed?.() !== true } : {}) },
      { level, title: notify.title, body: notify.label, text, url, tag: "ckanban-digest", notify, urgent },
    );
    for (const r of fresh) this.waits.update(r.key, { messageId: message.id });
    return message;
  }

  /**
   * The helper setting changed. Off: pending reminders stop and what it held (open, not told) goes out as one direct
   * digest. On: what is already open counts as told (it went out directly while the helper was off).
   */
  async switched(on: boolean): Promise<void> {
    const open = this.waits.open();
    if (on) {
      this.waits.markTold(open.filter((r) => !r.toldAt).map((r) => r.key), "direct");
      return;
    }
    for (const r of open) if (pending(r)) this.waits.stopReminders(r.key, "off");
    const held = open.filter((r) => !r.toldAt);
    if (held.length) await this.digest(held, "digest", "The helper was turned off; these were waiting for its next message.");
  }
}
