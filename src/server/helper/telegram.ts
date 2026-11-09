// Telegram: a bot the user makes with BotFather. The board sends through it (plain text, no parse_mode) and reads
// what comes back with one getUpdates long poll (phone access is tailnet-only, so no public webhook is possible).
// Pairing: Settings shows a 6-digit code, the user sends it to the bot, and the board keeps that chat id. Only the
// paired chat is listened to. A reply to an alert goes to that ticket (tgreply.ts); other text gets a fixed answer.
// "Take messages from Telegram" off (Pause, or /lock from the chat): alerts, Got it, Not urgent and /waiting still
// work; everything that would reach a ticket gets NOT_TAKING. Only the Mac's Settings turns it back on.
// Updates are saved (tgstores.ts UpdateQueue) before the read position moves on, so a restart neither drops nor
// doubles one. Everything the bot says besides the helper's alerts is silent. The token is never logged (scrub) and
// never shown (maskToken).
import { randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tapUrl, type Channel, type ChannelResult, type OutMessage } from "./channels";
import type { IncomingReply, Responder, TelegramReplies, TgButton } from "./tgreply";
import { UpdateQueue, type LinkItem, type TelegramLinks } from "./tgstores";

export interface TelegramSettings {
  on: boolean;
  /** BotFather's token. Secret: notify.json is owner-only and the settings API only shows maskToken(). */
  token: string;
  /** The paired chat (set only by pairing, never through the settings API). */
  chatId: number | null;
  /** Who paired, e.g. "Leo (@leo)". */
  chatName: string | null;
  pairedAt: string | null;
  /** A typed reply that answers a ticket's question is echoed with [Send] [Cancel] first ("Ask before sending typed answers"). */
  askTyped: boolean;
  /**
   * "Take messages from Telegram": off (Pause in Settings, or /lock in Telegram), alerts still go out and Got it /
   * Not urgent still work, but text and taps that would send to a ticket are refused. Only the Mac turns it back on.
   */
  takeMessages: boolean;
  /** When /lock turned takeMessages off (null: not locked from Telegram). Cleared when Settings turns it back on. */
  lockedAt: string | null;
  /** "Front desk lives on": the board whose quick chats hold the front desk (null: the board paired from, else the first). */
  frontDesk?: string | null;
  /** When the briefing (what the bot can do) went to the paired chat; null: not yet (sent once, also to chats paired before it). */
  briefedAt?: string | null;
}

export const DEFAULT_TELEGRAM: TelegramSettings = { on: false, token: "", chatId: null, chatName: null, pairedAt: null, askTyped: true, takeMessages: true, lockedAt: null, frontDesk: null, briefedAt: null };

/** The one reply to text or a tap while "Take messages from Telegram" is off. */
export const NOT_TAKING = "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
/** The answer to /lock. */
export const LOCKED = "🔒 Locked. I won't take messages from this chat until you unlock it on the Mac (Settings, Telegram). Alerts still arrive.";

/** "/lock" (or "/lock@mybot"): handled at once, beside the messages in line. */
export const isLock = (text: unknown) => typeof text === "string" && /^\/lock(@\S+)?$/i.test(text.trim().split(/\s+/)[0] ?? "");

/** BotFather tokens look like 123456789:AAH...; nothing else is accepted (and so nothing else ends up in a URL). */
export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

/** Longest Telegram message. */
export const TELEGRAM_MAX = 4096;
/** A pairing code is good for this long. */
export const PAIR_MS = 10 * 60_000;
/** Wrong codes allowed during one pairing before it is cancelled (6 digits: guessing has no real chance). */
export const PAIR_TRIES = 10;
/** Longest wait on a 429 before trying once more; longer than this fails at once so the next channel gets it. */
export const RETRY_AFTER_MAX_S = 30;
/** Telegram allows about one message a second in one chat: form messages and their edits are spaced this far. */
export const PACE_MS = 1000;
/** Long-poll length (seconds). */
export const POLL_TIMEOUT_S = 50;

export const FOCUS_HINT_TELEGRAM = "If you use Focus on your phone, allow Telegram in that Focus so urgent messages can get through (not guaranteed).";

/** "set …AbCd": the settings API never shows more of the token. */
export function maskToken(token: string): string {
  return token ? `set …${token.slice(-4)}` : "";
}

/** Takes the token out of any text that may hold it (fetch errors name the URL, which holds the token). */
export function scrub(text: string, token: string): string {
  let out = text;
  if (token) out = out.split(token).join("<token>");
  return out.replace(/bot\d{5,15}:[A-Za-z0-9_-]{20,}/g, "bot<token>");
}

/** Cut to Telegram's limit, keeping the tail (the "Answer on your Mac" line). */
export function telegramText(body: string, tail = ""): string {
  const room = TELEGRAM_MAX - tail.length;
  const b = body.length <= room ? body : `${body.slice(0, room - 1)}…`;
  return b + tail;
}

/** What the buttons and commands do (helper/core.ts: the same handlers as the board's buttons). */
export interface TelegramActions {
  /** Got it: reminders for this message stop. Returns the short reply shown on the phone. */
  gotIt(messageId: string): Promise<string> | string;
  /** Not urgent: reminders stop at once; returns e.g. "Stopped reminders for <title>". */
  notUrgent(messageId: string): Promise<string> | string;
  /** /waiting: what waits on the user now (the summary builder). */
  waiting(): Promise<string> | string;
}

export type TelegramState = "off" | "no-token" | "connecting" | "ok" | "error";

export interface TelegramStatus {
  state: TelegramState;
  /** Plain words, never the token. */
  error: string | null;
  /** The bot's @name once Telegram answered. */
  botName: string | null;
}

export interface TelegramDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  settings: () => TelegramSettings;
  save: (patch: Partial<TelegramSettings>) => void;
  actions: () => TelegramActions;
  /** Phone access is on: messages get an Open button (else the text ends "Answer on your Mac"). */
  phoneAccess: () => boolean;
  /** The board's address (for the fixed reply to free text). */
  boardUrl: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Start the long poll on refresh() (tests drive pollOnce themselves). Default true. */
  autoPoll?: boolean;
  /** Where the read position (getUpdates offset) is kept across restarts, so the last batch isn't handled twice. */
  offsetFile?: string;
  /** Where updates wait to be handled (the board's data folder); omitted: kept in memory only (tests). */
  queueRoot?: string;
  /** The message map: each sent message's Telegram id → its stored message and tickets. */
  links?: TelegramLinks;
  /** The tickets a stored helper message is about (for the message map). */
  itemsOf?: (messageId: string) => LinkItem[];
  /** Replies to alerts and their buttons (tgreply.ts); null: replies get the fixed answer. */
  replies?: () => TelegramReplies | null;
  /**
   * /lock: turn "Take messages from Telegram" off now and drop what Telegram left waiting (buttons, queued messages).
   * Default: only the setting is saved.
   */
  lock?: () => void;
  /**
   * An alert reached the chat (its Telegram message_id): forms the tickets in it wait on are shown under it
   * (tgforms.ts). Runs in the background; idle() waits for it.
   */
  alerted?: (m: OutMessage, tg: number, chatId: number) => Promise<void> | void;
  /** Least time between paced sends and edits (forms), ms. Telegram allows about one message a second in a chat. Default 1000. */
  paceMs?: number;
  /** The front desk (frontdesk.ts): text that isn't a reply to an alert. Null or false back: the fixed answer. */
  frontDesk?: () => { onText(m: { chatId: number; updateId: number; tg: number; text: string; forwarded?: string | null; quoted?: string | null }): Promise<boolean> } | null;
  /** The briefing after pairing (frontdesk.ts FrontDesk.briefing). Default: the short "Paired" text. */
  briefing?: (paired: boolean) => string;
}

/** The bot's command menu (setMyCommands). */
export const COMMANDS = [
  { command: "waiting", description: "What waits on you now" },
  { command: "lock", description: "Stop taking messages from this chat (alerts still arrive)" },
];
/** Voice, photos, files and stickers. */
export const TEXT_ONLY = "Text only for now.";
/** An edited message. */
export const SEND_AGAIN = "Send it again to change it.";

/** Who a forwarded message came from (forward_origin), or null when it isn't forwarded. */
export function forwardedFrom(msg: any): string | null {
  const o = msg?.forward_origin ?? (msg?.forward_from || msg?.forward_sender_name || msg?.forward_from_chat ? { type: "legacy" } : null);
  if (!o) return null;
  const u = o.sender_user ?? msg?.forward_from;
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username : o.sender_user_name ?? msg?.forward_sender_name ?? o.chat?.title ?? o.sender_chat?.title ?? msg?.forward_from_chat?.title;
  return name ? String(name).slice(0, 80) : "someone";
}

/** A bot token's public part (the bot's id), to tell which bot a saved read position or message belongs to. */
export const botId = (token: string) => token.split(":")[0] ?? "";

const CONFLICT = "Another program is reading this bot's messages, or the bot has a web address (webhook) set. Only one can: close the other program or remove its webhook, or make a new bot with BotFather just for ckanban.";
const BAD_TOKEN = "Telegram doesn't accept this bot token. Copy it again from BotFather.";

interface ApiReply {
  ok: boolean;
  result?: any;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramBot {
  private status: TelegramStatus = { state: "off", error: null, botName: null };
  private pairing: { code: string; startedAt: number; expiresAt: number; tries: number } | null = null;
  private pairError: string | null = null;
  private offset = 0;
  private offsetLoaded = false;
  /** Bumped on every (re)start and stop: an older loop sees it and ends, so only one poller runs. */
  private gen = 0;
  private abort: AbortController | null = null;
  private polling = false;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  readonly queue: UpdateQueue;
  /** Updates being handled now (by update_id). */
  private inFlight = new Set<number>();
  /** Messages are handled one at a time, in order; button taps beside them, so a slow message never holds a tap. */
  private msgChain: Promise<void> = Promise.resolve();
  private taps = new Set<Promise<void>>();
  /** Paced calls (form messages and edits) run one after another, PACE_MS apart. */
  private paceChain: Promise<unknown> = Promise.resolve();
  private lastPaced = -Infinity;
  /** The command menu was set for this bot (once per daemon run). */
  private commandsFor: string | null = null;

  constructor(private d: TelegramDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.queue = new UpdateQueue(d.queueRoot ?? null, () => botId(this.token));
  }

  private get token(): string {
    return this.d.settings().token;
  }

  /** Calls the Bot API. Never throws; errors come back with the token scrubbed. */
  async api(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ApiReply> {
    const token = this.token;
    if (!TOKEN_RE.test(token)) return { ok: false, error_code: 401, description: "no bot token" };
    try {
      const r = await this.d.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(method === "getUpdates" ? (POLL_TIMEOUT_S + 15) * 1000 : 10_000),
      });
      let j: ApiReply;
      try {
        j = (await r.json()) as ApiReply;
      } catch {
        j = { ok: r.ok, error_code: r.status, description: `${r.status} ${r.statusText}`.trim() };
      }
      if (!j.ok && j.error_code === undefined) j.error_code = r.status;
      if (j.description) j.description = scrub(j.description, token);
      return j;
    } catch (e) {
      return { ok: false, error_code: 0, description: scrub((e as Error).message ?? String(e), token) };
    }
  }

  /** Plain words for an API failure. */
  private explain(r: ApiReply): string {
    if (r.error_code === 409) return CONFLICT;
    if (r.error_code === 401 || r.error_code === 404) return BAD_TOKEN;
    if (r.error_code === 0) return `Can't reach Telegram: ${r.description ?? "network error"}`;
    return `Telegram answered: ${r.description ?? r.error_code}`;
  }

  /** For the settings API: whether a pairing is going on and until when, never its code (only startPairing returns it). */
  state(): TelegramStatus & { pairing: { expiresAt: string } | null; pairError: string | null } {
    const p = this.pairing && this.pairing.expiresAt > this.now() ? this.pairing : null;
    const s = this.d.settings();
    const state: TelegramState = !s.token ? "no-token" : !this.wanted() ? "off" : this.status.state === "off" ? "connecting" : this.status.state;
    return {
      ...this.status, state,
      pairing: p ? { expiresAt: new Date(p.expiresAt).toISOString() } : null,
      pairError: this.pairError,
    };
  }

  /** Listen while the channel is on and paired, or while a pairing is going on. */
  private wanted(): boolean {
    const s = this.d.settings();
    if (!TOKEN_RE.test(s.token)) return false;
    const pairing = !!this.pairing && this.pairing.expiresAt > this.now();
    return pairing || (s.on && s.chatId !== null);
  }

  /** Settings changed (or start-up): start or stop the one poller. */
  refresh(): void {
    if (!this.wanted()) {
      this.stop();
      return;
    }
    if (this.polling || this.d.autoPoll === false) return;
    void this.loop();
  }

  /** Stops the poller (shutdown, token removed, channel off). */
  stop(): void {
    this.gen++;
    this.abort?.abort();
    this.abort = null;
    this.polling = false;
    this.status = { ...this.status, state: "off", error: null };
  }

  /** The token changed: what Telegram said about the old one no longer holds. */
  reset(): void {
    this.stop();
    this.status = { state: "off", error: null, botName: null };
    this.offset = 0;
    // The saved position belongs to the bot it was saved for (read again for the new token).
    this.offsetLoaded = false;
  }

  /** The saved read position, if it was saved for this bot (the token's bot id, not the secret part). */
  private loadOffset(): void {
    if (this.offsetLoaded) return;
    this.offsetLoaded = true;
    if (!this.d.offsetFile) return;
    try {
      const v = JSON.parse(readFileSync(this.d.offsetFile, "utf8"));
      if (v?.bot === botId(this.token) && Number.isSafeInteger(v.offset)) this.offset = Math.max(this.offset, v.offset);
    } catch {}
  }

  private saveOffset(): void {
    if (!this.d.offsetFile) return;
    try {
      const tmp = `${this.d.offsetFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ bot: botId(this.token), offset: this.offset }) + "\n");
      renameSync(tmp, this.d.offsetFile);
    } catch (e) {
      console.warn(`telegram: couldn't save the read position: ${(e as Error).message}`);
    }
  }

  private async loop(): Promise<void> {
    const gen = ++this.gen;
    this.polling = true;
    let backoff = 5000;
    try {
      while (gen === this.gen && this.wanted()) {
        const ok = await this.pollOnce(gen);
        if (gen !== this.gen) return;
        if (ok) backoff = 5000;
        else {
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    } finally {
      if (gen === this.gen) this.polling = false;
    }
  }

  /** One getUpdates round (and getMe first while the bot's name is unknown). False on an error. */
  async pollOnce(gen = this.gen): Promise<boolean> {
    if (this.status.state === "off") this.status = { ...this.status, state: "connecting" };
    if (!this.status.botName) {
      const me = await this.api("getMe", {});
      // Stopped or restarted meanwhile (token changed): this round is over, or two pollers would hold the bot.
      if (gen !== this.gen) return true;
      if (!me.ok) {
        if (gen === this.gen) this.fail(me);
        return false;
      }
      this.status = { ...this.status, botName: me.result?.username ? `@${me.result.username}` : null };
    }
    // The menu of commands, once per bot: /waiting and /lock.
    if (this.commandsFor !== botId(this.token) && this.d.settings().chatId !== null) {
      this.commandsFor = botId(this.token);
      void this.api("setMyCommands", { commands: COMMANDS }).then((r) => (r.ok ? undefined : console.warn(`telegram: couldn't set the command menu: ${this.explain(r)}`)));
    }
    this.loadOffset();
    // Updates saved before a restart and not handled yet.
    this.drain();
    const abort = new AbortController();
    this.abort = abort;
    const r = await this.api("getUpdates", {
      offset: this.offset, timeout: this.d.autoPoll === false ? 0 : POLL_TIMEOUT_S, allowed_updates: ["message", "edited_message", "callback_query"],
    }, AbortSignal.any([abort.signal, AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000)]));
    if (gen !== this.gen) return true;
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.status = { ...this.status, state: "ok", error: null };
    const updates: any[] = Array.isArray(r.result) ? r.result : [];
    // Saved first, then the position moves on: a restart in between handles them after it (the queue skips ids
    // already handled), so nothing is dropped or done twice.
    try {
      this.queue.add(updates);
    } catch (e) {
      console.warn(`telegram: couldn't save incoming messages, reading them again: ${(e as Error).message}`);
      return false;
    }
    const before = this.offset;
    for (const u of updates) if (typeof u?.update_id === "number") this.offset = Math.max(this.offset, u.update_id + 1);
    if (this.offset !== before) this.saveOffset();
    this.drain();
    // Tests drive one round at a time and look at what it did.
    if (this.d.autoPoll === false) await this.idle();
    return true;
  }

  /** Starts handling what waits in the queue: messages in order, one at a time; taps at once. */
  drain(): void {
    for (const u of this.queue.pending()) {
      const id: number = u.update_id;
      if (this.inFlight.has(id)) continue;
      this.inFlight.add(id);
      const run = async () => {
        try {
          await this.handle(u);
        } catch (e) {
          console.error("telegram: update", scrub((e as Error).message ?? String(e), this.token));
        } finally {
          this.queue.done(id);
          this.inFlight.delete(id);
        }
      };
      // Taps and /lock go at once: a slow message in line never holds them (/lock: the messages behind it are refused).
      if (u.callback_query || isLock(u.message?.text)) {
        const p = run();
        this.taps.add(p);
        void p.finally(() => this.taps.delete(p));
      } else this.msgChain = this.msgChain.then(run);
    }
  }

  /** Resolves once everything queued so far is handled (and background work such as showing a form is done). */
  async idle(): Promise<void> {
    await Promise.all([this.msgChain, ...this.taps]);
    if (this.taps.size) await this.idle();
  }

  /** Background work idle() waits for (showing a form after an alert). */
  private track(p: Promise<void>): void {
    const q = p.catch((e) => console.error("telegram:", scrub((e as Error).message ?? String(e), this.token)));
    this.taps.add(q);
    void q.finally(() => this.taps.delete(q));
  }

  /**
   * A Bot API call spaced at least paceMs after the last paced one (Telegram allows about one message a second in a
   * chat); a 429 waits retry_after (up to RETRY_AFTER_MAX_S) and tries again, twice at most.
   */
  paced(method: string, body: Record<string, unknown>): Promise<ApiReply> {
    const run = async () => {
      const gap = this.lastPaced + (this.d.paceMs ?? PACE_MS) - this.now();
      if (gap > 0) await this.sleep(gap);
      let r = await this.api(method, body);
      for (let i = 0; i < 2 && !r.ok && r.error_code === 429; i++) {
        const wait = r.parameters?.retry_after ?? 1;
        if (wait > RETRY_AFTER_MAX_S) break;
        await this.sleep(wait * 1000);
        r = await this.api(method, body);
      }
      this.lastPaced = this.now();
      return r;
    };
    const p = this.paceChain.then(run, run);
    this.paceChain = p.catch(() => {});
    return p;
  }

  private fail(r: ApiReply): void {
    const error = this.explain(r);
    if (error !== this.status.error) console.warn(`telegram: ${error}`);
    this.status = { ...this.status, state: "error", error };
  }

  /** Starts pairing: a fresh 6-digit code for 10 minutes; the poller runs meanwhile. */
  startPairing(): { code: string; expiresAt: string } {
    if (!TOKEN_RE.test(this.token)) throw new Error("Add the bot token from BotFather first.");
    const now = this.now();
    this.pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), startedAt: now, expiresAt: now + PAIR_MS, tries: 0 };
    this.pairError = null;
    this.refresh();
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  /** Forgets the paired chat. */
  unpair(): void {
    this.pairing = null;
    this.d.save({ chatId: null, chatName: null, pairedAt: null });
    this.refresh();
  }

  /** The bot's own answers: always silent (only the helper's urgent alerts make a sound). */
  private async reply(chatId: number, text: string): Promise<void> {
    await this.responder(chatId).say(text);
  }

  /** How the reply router (and report backs) talk in this chat. Url buttons only for https links. paced: forms (see paced()). */
  responder(chatId: number, o: { paced?: boolean } = {}): Responder {
    const call = (method: string, body: Record<string, unknown>) => (o.paced ? this.paced(method, body) : this.api(method, body));
    const markup = (buttons?: TgButton[][]) => {
      const rows = (buttons ?? []).map((row) => row.filter((b) => (b.url ? /^https:\/\//.test(b.url) : !!b.data))
        .map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))).filter((row) => row.length);
      return { inline_keyboard: rows };
    };
    return {
      say: async (text, o = {}) => {
        const kb = markup(o.buttons);
        const r = await call("sendMessage", {
          chat_id: chatId, text: telegramText(text), disable_notification: true, disable_web_page_preview: true,
          ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
          ...(o.forceReply ? { reply_markup: { force_reply: true, input_field_placeholder: o.forceReply.slice(0, 64) } } : kb.inline_keyboard.length ? { reply_markup: kb } : {}),
        });
        if (!r.ok) {
          console.warn(`telegram: reply failed: ${this.explain(r)}`);
          return null;
        }
        const tg = r.result?.message_id;
        if (!Number.isSafeInteger(tg)) return null;
        if (o.link?.length) this.d.links?.add({ bot: botId(this.token), tg, chatId, messageId: null, level: o.level ?? "report", items: o.link });
        return tg;
      },
      edit: async (messageId, text, buttons) => {
        const r = await call("editMessageText", {
          chat_id: chatId, message_id: messageId, text: telegramText(text), disable_web_page_preview: true, reply_markup: markup(buttons),
        });
        if (!r.ok) console.warn(`telegram: edit failed: ${this.explain(r)}`);
      },
    };
  }

  private codeMatches(text: string): boolean {
    if (!this.pairing) return false;
    const a = Buffer.from(text), b = Buffer.from(this.pairing.code);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** One update from getUpdates. Only the paired chat is acted on; a stranger only ever gets the pairing check. */
  async handle(u: any): Promise<void> {
    const s = this.d.settings();
    const cq = u?.callback_query;
    if (cq) {
      const chat = cq.message?.chat?.id;
      if (s.chatId === null || chat !== s.chatId || cq.from?.id !== s.chatId) {
        await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: "This bot isn't paired with you." });
        return;
      }
      const data = String(cq.data ?? "");
      const m = /^([gn]):(m_[a-z0-9]{1,40})$/.exec(data);
      const p = /^p:([a-z0-9]{10}):([a-z0-9]{1,3})$/.exec(data);
      const replies = this.d.replies?.();
      let text = "That button no longer works.";
      try {
        if (m) {
          const a = this.d.actions();
          text = await (m[1] === "g" ? a.gotIt(m[2]) : a.notUrgent(m[2]));
        } else if (p && s.takeMessages === false) {
          text = NOT_TAKING;
        } else if (p && replies) {
          text = await replies.onTap(p[1], p[2], chat, cq.message?.message_id ?? 0, this.responder(chat), u.update_id);
        }
      } finally {
        // Always answered, or the button keeps spinning on the phone.
        await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: text.slice(0, 200) });
      }
      return;
    }
    // An edited message: the first version was already handled; editing doesn't change what was sent.
    const edited = u?.edited_message;
    if (edited?.chat && edited.chat.id === s.chatId && s.chatId !== null) {
      await this.reply(edited.chat.id, SEND_AGAIN);
      return;
    }
    const msg = u?.message;
    if (!msg?.chat || typeof msg.chat.id !== "number") return;
    const chatId: number = msg.chat.id;
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    // Pairing: private chats only, messages sent after the code was shown (Telegram keeps old updates for a day).
    if (this.pairing && chatId !== s.chatId) {
      const p = this.pairing;
      if (p.expiresAt <= this.now()) this.pairing = null;
      else if (msg.chat.type === "private" && typeof msg.date === "number" && msg.date * 1000 >= p.startedAt - 5000) {
        const code = text.replace(/\s+/g, "");
        if (!/^\d{6}$/.test(code)) {
          await this.reply(chatId, "Send the 6-digit code shown in the board's Settings.");
          return;
        }
        if (this.codeMatches(code)) {
          const from = msg.from ?? msg.chat;
          const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "you";
          this.pairing = null;
          this.d.save({ chatId, chatName: from.username ? `${name} (@${from.username})` : name, pairedAt: new Date(this.now()).toISOString(), on: true, takeMessages: true, lockedAt: null });
          await this.reply(chatId, this.d.briefing?.(true) ?? `Paired. The ckanban helper will message you here.\n\nUrgent messages come with sound; the rest arrive silently. ${FOCUS_HINT_TELEGRAM}\n\nReply to an alert to answer that ticket. Send /waiting any time to see what waits on you.`);
          this.d.save({ briefedAt: new Date(this.now()).toISOString() });
          return;
        }
        p.tries++;
        if (p.tries >= PAIR_TRIES) {
          this.pairing = null;
          this.pairError = "Too many wrong codes were sent to the bot, so pairing stopped. Start pairing again.";
          console.warn("telegram: pairing stopped after too many wrong codes");
        }
        await this.reply(chatId, "That code doesn't match. Check the code in the board's Settings.");
        return;
      }
    }
    if (s.chatId === null || chatId !== s.chatId) return;
    const cmd = text.split(/\s+/)[0]?.replace(/@\S+$/, "").toLowerCase();
    if (cmd === "/lock") {
      // Saved before the answer goes out; there is no /unlock: only Settings on the Mac turns it back on.
      if (this.d.lock) this.d.lock();
      else this.d.save({ takeMessages: false, lockedAt: new Date(this.now()).toISOString() });
      await this.reply(chatId, LOCKED);
      return;
    }
    if (cmd === "/waiting") {
      await this.reply(chatId, await this.d.actions().waiting());
      return;
    }
    // Read again: a /lock handled meanwhile counts for the messages behind it.
    if (this.d.settings().takeMessages === false) {
      await this.reply(chatId, NOT_TAKING);
      return;
    }
    // Voice, photos, files, stickers: nothing is passed on.
    if (!text) {
      await this.reply(chatId, TEXT_ONLY);
      return;
    }
    const replyTo = msg.reply_to_message?.message_id;
    const replies = this.d.replies?.();
    // A forwarded message is quoted text for the front desk, never an answer to an alert.
    const forwarded = forwardedFrom(msg);
    if (Number.isSafeInteger(replyTo) && replies && !forwarded) {
      const r: IncomingReply = { chatId, updateId: u.update_id, tg: msg.message_id, replyTo, text };
      if (await replies.onReply(r, this.responder(chatId))) return;
    }
    // Everything else goes to the front desk (a reply to a summary carries the summary's text).
    const desk = this.d.frontDesk?.();
    if (desk) {
      const quoted = typeof msg.reply_to_message?.text === "string" && msg.reply_to_message.from?.is_bot ? msg.reply_to_message.text : null;
      if (await desk.onText({ chatId, updateId: u.update_id, tg: msg.message_id, text, forwarded, quoted })) return;
    }
    // No front desk: a fixed answer; nothing is saved or passed on.
    const where = this.d.phoneAccess() ? `Or answer on the board: ${this.d.boardUrl()}` : "Or answer on your Mac.";
    await this.reply(chatId, `Reply to an alert to answer that ticket. ${where}\n\nSend /waiting to see what waits on you.`);
  }

  /** "typing…" in the chat (it shows about 5 seconds). */
  async typing(chatId: number): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /** Sends a file (sendDocument, multipart). Returns an error in plain words, or null when sent. */
  async sendFile(chatId: number, file: string, caption: string, replyTo: number | null): Promise<string | null> {
    const token = this.token;
    if (!TOKEN_RE.test(token)) return "Telegram isn't set up.";
    try {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", caption.slice(0, 1024));
      form.set("disable_notification", "true");
      if (replyTo !== null) form.set("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
      form.set("document", Bun.file(file), file.split("/").pop() ?? "file");
      const r = await this.d.fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
      let j: ApiReply;
      try {
        j = (await r.json()) as ApiReply;
      } catch {
        j = { ok: r.ok, error_code: r.status, description: `${r.status}` };
      }
      if (j.ok) return null;
      return this.explain({ ...j, description: j.description ? scrub(j.description, token) : j.description });
    } catch (e) {
      return `Can't reach Telegram: ${scrub((e as Error).message ?? String(e), token)}`;
    }
  }

  /** The briefing to a chat paired before it existed (once; briefedAt). */
  async briefOnce(): Promise<void> {
    const s = this.d.settings();
    if (!s.on || s.chatId === null || s.briefedAt || !TOKEN_RE.test(s.token) || !this.d.briefing) return;
    this.d.save({ briefedAt: new Date(this.now()).toISOString() });
    await this.reply(s.chatId, this.d.briefing(false));
  }

  /** The channel's send: plain text, sound only when urgent, Got it / Not urgent on messages that remind. */
  async send(m: OutMessage): Promise<ChannelResult> {
    const s = this.d.settings();
    if (!TOKEN_RE.test(s.token) || s.chatId === null) return { channel: "telegram", ok: false, skipped: true, error: null };
    const link = this.d.phoneAccess() ? tapUrl(m) : null;
    const head = m.text.startsWith(m.title) ? m.text : `${m.title}\n\n${m.text}`;
    const text = telegramText(head, link ? "" : "\n\nAnswer on your Mac.");
    const rows: { text: string; callback_data?: string; url?: string }[][] = [];
    if (m.messageId && (m.level === "urgent" || m.level === "reminder")) {
      rows.push([{ text: "Got it", callback_data: `g:${m.messageId}` }, { text: "Not urgent", callback_data: `n:${m.messageId}` }]);
    }
    if (link && /^https:\/\//.test(link)) rows.push([{ text: "Open", url: link }]);
    const body = {
      chat_id: s.chatId, text, disable_notification: !m.urgent, disable_web_page_preview: true,
      ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
    };
    let r = await this.api("sendMessage", body);
    if (!r.ok && r.error_code === 429) {
      const wait = r.parameters?.retry_after ?? 1;
      if (wait <= RETRY_AFTER_MAX_S) {
        await this.sleep(wait * 1000);
        r = await this.api("sendMessage", body);
      }
    }
    if (r.ok) {
      const tg = r.result?.message_id;
      if (Number.isSafeInteger(tg) && this.d.links) {
        try {
          this.d.links.add({ bot: botId(s.token), tg, chatId: s.chatId, messageId: m.messageId, level: m.level, items: m.messageId ? this.d.itemsOf?.(m.messageId) ?? [] : [] });
        } catch (e) {
          console.warn(`telegram: couldn't note the sent message: ${(e as Error).message}`);
        }
      }
      if (Number.isSafeInteger(tg) && this.d.alerted) {
        const chatId = s.chatId;
        this.track((async () => this.d.alerted!(m, tg, chatId))());
      }
      return { channel: "telegram", ok: true, devices: 1, error: null };
    }
    return { channel: "telegram", ok: false, error: r.error_code === 429 ? "Telegram is limiting messages right now" : this.explain(r) };
  }
}

export function telegramChannel(bot: TelegramBot): Channel {
  return {
    name: "telegram",
    enabled: (s) => s.telegram.on && TOKEN_RE.test(s.telegram.token) && s.telegram.chatId !== null,
    send: (m) => bot.send(m),
  };
}
