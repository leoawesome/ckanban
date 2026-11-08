// Telegram: a bot the user makes with BotFather. The board sends through it (plain text, no parse_mode) and reads
// what comes back with one getUpdates long poll (phone access is tailnet-only, so no public webhook is possible).
// Pairing: Settings shows a 6-digit code, the user sends it to the bot, and the board keeps that chat id. Only the
// paired chat is listened to; nothing a chat writes is saved. The token is never logged (scrub) and never shown
// (maskToken).
import { randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { messagePageUrl, type Channel, type ChannelResult, type OutMessage } from "./channels";

export interface TelegramSettings {
  on: boolean;
  /** BotFather's token. Secret: notify.json is owner-only and the settings API only shows maskToken(). */
  token: string;
  /** The paired chat (set only by pairing, never through the settings API). */
  chatId: number | null;
  /** Who paired, e.g. "Leo (@leo)". */
  chatName: string | null;
  pairedAt: string | null;
}

export const DEFAULT_TELEGRAM: TelegramSettings = { on: false, token: "", chatId: null, chatName: null, pairedAt: null };

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
}

/** A bot token's public part (the bot's id), to tell which bot a saved read position belongs to. */
const botId = (token: string) => token.split(":")[0] ?? "";

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

  constructor(private d: TelegramDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    this.loadOffset();
    const abort = new AbortController();
    this.abort = abort;
    const r = await this.api("getUpdates", {
      offset: this.offset, timeout: this.d.autoPoll === false ? 0 : POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"],
    }, AbortSignal.any([abort.signal, AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000)]));
    if (gen !== this.gen) return true;
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.status = { ...this.status, state: "ok", error: null };
    const updates: any[] = Array.isArray(r.result) ? r.result : [];
    // The position is saved before the batch is handled: a restart mid-batch skips the rest rather than doing taps twice.
    const before = this.offset;
    for (const u of updates) if (typeof u?.update_id === "number") this.offset = Math.max(this.offset, u.update_id + 1);
    if (this.offset !== before) this.saveOffset();
    for (const u of updates) {
      try {
        await this.handle(u);
      } catch (e) {
        console.error("telegram: update", scrub((e as Error).message ?? String(e), this.token));
      }
    }
    return true;
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

  private async reply(chatId: number, text: string): Promise<void> {
    const r = await this.api("sendMessage", { chat_id: chatId, text: telegramText(text), disable_web_page_preview: true });
    if (!r.ok) console.warn(`telegram: reply failed: ${this.explain(r)}`);
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
      const m = /^([gn]):(m_[a-z0-9]{1,40})$/.exec(String(cq.data ?? ""));
      let text = "That button no longer works.";
      if (m) {
        const a = this.d.actions();
        text = await (m[1] === "g" ? a.gotIt(m[2]) : a.notUrgent(m[2]));
      }
      await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: text.slice(0, 200) });
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
          this.d.save({ chatId, chatName: from.username ? `${name} (@${from.username})` : name, pairedAt: new Date(this.now()).toISOString(), on: true });
          await this.reply(chatId, `Paired. The ckanban helper will message you here.\n\nUrgent messages come with sound; the rest arrive silently. ${FOCUS_HINT_TELEGRAM}\n\nSend /waiting any time to see what waits on you.`);
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
    if (cmd === "/waiting") {
      await this.reply(chatId, await this.d.actions().waiting());
      return;
    }
    // Free text: a fixed reply; nothing is saved or passed on.
    const where = this.d.phoneAccess() ? `Answer on the board: ${this.d.boardUrl()}` : "Answer on your Mac.";
    await this.reply(chatId, `I can't pass answers to tickets yet. ${where}\n\nSend /waiting to see what waits on you.`);
  }

  /** The channel's send: plain text, sound only when urgent, Got it / Not urgent on messages that remind. */
  async send(m: OutMessage): Promise<ChannelResult> {
    const s = this.d.settings();
    if (!TOKEN_RE.test(s.token) || s.chatId === null) return { channel: "telegram", ok: false, skipped: true, error: null };
    const link = this.d.phoneAccess() ? (m.messageId ? messagePageUrl(m.url, m.messageId) : m.url) : null;
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
    if (r.ok) return { channel: "telegram", ok: true, devices: 1, error: null };
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
