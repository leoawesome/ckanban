// "Needs you" notifications: when a ticket starts waiting on the user (attention.ts), tell them once, off the Mac too.
// A ticket's Claude can also send its own message (notify_user, Notifier.message). Sends to a webhook (ntfy topic URL or any JSON endpoint), to devices that turned phone push on (push.ts) and/or
// shows a macOS banner, per kind (notify.json).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, rmSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pauser, track, trackedInterval } from "./lag";
import { homedir } from "node:os";
import { join } from "node:path";
import { featureRows, hiddenTool, mainTicketOf, withYouTool } from "../../web/src/family";
import { type AttentionKind, type HostHuddle, ticketAttention } from "./attention";
import { stepWait } from "./main-ticket";
import type { Bus } from "./events";
import { run as runCmd } from "./git";
import type { PushPayload, PushService } from "./push";
import type { SessionSummary } from "./session";
import type { Store } from "./store";
import type { Ticket } from "./types";
import { nowIso } from "./util";
import { Channels, macChannel, pushChannel, webhookChannel, type ChannelResult } from "./helper/channels";
import { HelperCore } from "./helper/core";
import { botId, DEFAULT_TELEGRAM, maskToken, scrub, TelegramBot, telegramChannel, TOKEN_RE, type TelegramSettings } from "./helper/telegram";
import { waitIdentity, type NewWait } from "./helper/waits";
import { TelegramReplies } from "./helper/tgreply";
import { telegramSpendToday } from "./spend";
import { PendingActions, TelegramLinks } from "./helper/tgstores";
import { TelegramForms } from "./helper/tgforms";
import { FrontDesk } from "./helper/frontdesk";
import { HelperSettingsStore } from "./helper/settings";

/** What the Telegram reply router needs from the board (Board implements it; plugged in with Notifier.plugBoard). */
export interface TelegramBoard {
  chatFromTelegram(slug: string, id: string, text: string, from: { updateId: number; tg: number; chatId: number; key?: string | null; still?: () => boolean }): Promise<boolean>;
  patchTelegram(slug: string, id: string, patch: Pick<Partial<Ticket>, "telegramIn" | "telegramOut" | "telegramReport">): unknown;
  /** Drops messages from Telegram still waiting in tickets' queues (Pause, /lock, Unpair). */
  dropTelegramQueued(): number;
}

/** What a notification is about: a "needs you" kind, or a message a ticket's Claude wrote itself (notify_user). */
export type NotifyKind = AttentionKind | "message";

export const NOTIFY_KINDS: NotifyKind[] = ["stalled", "questions", "proposal", "review", "failed", "limit", "blocked", "huddle", "reply", "message"];

/** Longest notify_user message: it has to fit a phone notification. */
export const CLAUDE_MESSAGE_MAX = 200;
/** notify_user sends at most one message per ticket in this time (stops a runaway loop, not a careful Claude). */
export const CLAUDE_MESSAGE_GAP_MS = 10 * 60_000;

/** notify_user input the board refuses; status is the HTTP status. */
export class MessageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** What notify_user tells Claude: where the message went, or why it went nowhere. */
export interface MessageResult {
  /** Reached the user somewhere (a device, the webhook or the macOS banner). */
  delivered: boolean;
  /** Phones and browsers that got it. */
  devices: number;
  /** Devices skipped because the board is on screen there right now. */
  onScreen: number;
  webhook: boolean;
  banner: boolean;
  /** Reached the paired Telegram chat. */
  telegram?: boolean;
  /** Why it went nowhere: "off" (Messages from Claude is off), "nowhere" (no device, webhook or banner), "on-screen". */
  reason: "off" | "nowhere" | "on-screen" | null;
  error: string | null;
  /** Passed to the helper instead of sent (it tells the user itself). */
  helper?: boolean;
}

/** How the webhook gets the message. auto: ntfy when the URL's host has "ntfy" in it, else JSON. */
export type WebhookFormat = "auto" | "ntfy" | "json";

export interface NotifySettings {
  /** Empty: no webhook. */
  webhookUrl: string;
  format: WebhookFormat;
  /** macOS banner on this Mac (skipped while a browser on this Mac gets notifications, see Notifier.macBrowser). */
  mac: boolean;
  kinds: Record<NotifyKind, boolean>;
  /** The helper groups routine waits and interrupts only for urgent ones (helper/core.ts). Off: one notification per wait, as before. */
  helper: boolean;
  /** Phone push channel on (phones and other browsers that turned notifications on). */
  push: boolean;
  /** The web address channel (ntfy or JSON) on; the address is kept while it is off. */
  webhookOn: boolean;
  /** Telegram (helper/telegram.ts). The token is a secret: state() masks it. */
  telegram: TelegramSettings;
}

/** One channel as Settings lists it. */
export interface ChannelState {
  name: "mac" | "push" | "webhook" | "telegram";
  label: string;
  on: boolean;
  /** Set up so a send can reach the user. */
  ready: boolean;
  /** One plain line under the switch. */
  detail: string;
}

/** Telegram as the settings API shows it: never the token itself. */
export interface TelegramPublic {
  on: boolean;
  tokenSet: boolean;
  /** "set …AbCd" or "". */
  tokenMasked: string;
  paired: boolean;
  chatName: string | null;
  pairedAt: string | null;
  /** off | no-token | connecting | ok | error. */
  status: string;
  error: string | null;
  botName: string | null;
  /** A pairing is going on until expiresAt. The code itself only comes back from POST /api/notify/telegram/pair. */
  pairing: { expiresAt: string } | null;
  pairError: string | null;
  /** A typed answer to a ticket's question is echoed with [Send] [Cancel] first. */
  askTyped: boolean;
  /** "Take messages from Telegram" (off: Pause in Settings, or /lock in Telegram). */
  takeMessages: boolean;
  /** When /lock turned it off, or null. */
  lockedAt: string | null;
  /** "Spent from Telegram today" in USD (spend.ts telegramSpendToday). No limit. */
  spentToday: number;
  /** The front desk's daily cap (USD) and what its chats cost today. */
  deskCapUsd: number;
  deskSpentToday: number;
  /** "Front desk lives on": the board whose quick chats hold the front desk (helper/frontdesk.ts). */
  frontDesk: string | null;
  /** The boards it can live on. */
  boards: { slug: string; name: string }[];
}

/** Shown with the ntfy topic box. */
export const NTFY_WARNING = "Anyone who knows the topic name can read these messages. Use a long random name like the suggested one and don't share it.";
/** Focus mode on the phone, in plain words (Settings, the pairing reply, the first message). */
export const FOCUS_HINT = "Focus mode on your phone can hold notifications back. ntfy can get through Focus if you allow the ntfy app in that Focus. For Telegram, allow Telegram in your Focus (not guaranteed). Phone push from the board can't get through Focus.";
/** The status line until a phone channel works. */
export const MAC_ONLY_LINE = "I can only reach you on this Mac";
/** What phone access (the remote listener) gets for turning Telegram messages back on: only the Mac may undo /lock or Pause. */
export const TG_ON_FROM_MAC = "Turn this back on from the Mac.";
/** What phone access gets for pairing Telegram or giving it a new bot key. */
export const TG_PAIR_FROM_MAC = "Pair Telegram from the Mac.";

/** A settings change only this Mac may make (not phone access). The settings API answers 403 with the message. */
export class MacOnlyError extends Error {}

/** What the settings dialog shows besides the settings: how the last send went. */
export interface NotifyState extends Omit<NotifySettings, "telegram"> {
  telegram: TelegramPublic;
  channels: ChannelState[];
  /** A phone channel (push, ntfy/web address, Telegram) is on and set up. */
  phoneReady: boolean;
  /** "I can only reach you on this Mac" until phoneReady, else null. */
  reachLine: string | null;
  /** A random ntfy topic address to offer (the same for the daemon's lifetime). */
  ntfyTopicSuggestion: string;
  ntfyWarning: string;
  focusHint: string;
  lastSentAt: string | null;
  lastError: string | null;
  /** A browser on this Mac gets notifications, so the macOS banner isn't used (see Notifier.macBrowser). */
  macBrowser: boolean;
}

// "Claude replied" fires on every Planning chat turn, mostly while the user is watching: off until they want it.
export const DEFAULT_NOTIFY: NotifySettings = {
  webhookUrl: "",
  format: "auto",
  mac: true,
  kinds: { stalled: true, questions: true, proposal: true, review: true, failed: true, limit: true, blocked: true, huddle: true, reply: false, message: true },
  helper: true,
  push: true,
  webhookOn: true,
  telegram: DEFAULT_TELEGRAM,
};

/** Settings in `<root>/notify.json`; defaults for anything missing or invalid. */
export function readNotifySettings(root: string): NotifySettings {
  const file = join(root, "notify.json");
  if (!existsSync(file)) return structuredClone(DEFAULT_NOTIFY);
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, "utf8")), DEFAULT_NOTIFY, true);
  } catch {
    return structuredClone(DEFAULT_NOTIFY);
  }
}

/** Owner-only (0600, like push.json): it holds the Telegram bot token. */
export function writeNotifySettings(root: string, s: NotifySettings): void {
  const file = join(root, "notify.json");
  const tmp = `${file}.tmp`;
  // A leftover tmp (say 0644) would hold the token until the chmod below: start fresh.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when the file is new: a leftover tmp keeps its old mode otherwise.
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Merge a partial update into settings. Throws on a webhook URL that isn't http(s) or a Telegram token that isn't one.
 * The paired Telegram chat is read only from the file (fromFile): only pairing sets it, never the settings API.
 */
export function normalizeSettings(raw: any, base: NotifySettings = DEFAULT_NOTIFY, fromFile = false): NotifySettings {
  const out = structuredClone(base);
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.webhookUrl === "string") {
    const url = raw.webhookUrl.trim();
    if (url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Error("webhook URL is not a valid URL");
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("webhook URL must start with https:// or http://");
    }
    out.webhookUrl = url;
  }
  if (raw.format === "auto" || raw.format === "ntfy" || raw.format === "json") out.format = raw.format;
  if (typeof raw.mac === "boolean") out.mac = raw.mac;
  if (typeof raw.helper === "boolean") out.helper = raw.helper;
  if (typeof raw.push === "boolean") out.push = raw.push;
  if (typeof raw.webhookOn === "boolean") out.webhookOn = raw.webhookOn;
  const tg = raw.telegram;
  if (tg && typeof tg === "object") {
    if (typeof tg.on === "boolean") out.telegram.on = tg.on;
    if (typeof tg.askTyped === "boolean") out.telegram.askTyped = tg.askTyped;
    // The front desk's daily cap: $0 to $100, in cents (0 keeps it paused).
    if (typeof tg.deskCapUsd === "number" && Number.isFinite(tg.deskCapUsd) && tg.deskCapUsd >= 0) out.telegram.deskCapUsd = Math.min(100, Math.round(tg.deskCapUsd * 100) / 100);
    if (tg.frontDesk === null || (typeof tg.frontDesk === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tg.frontDesk))) out.telegram.frontDesk = tg.frontDesk;
    if (typeof tg.takeMessages === "boolean") {
      out.telegram.takeMessages = tg.takeMessages;
      // Turned back on (only Settings on the Mac can): no longer locked.
      if (tg.takeMessages && !fromFile) out.telegram.lockedAt = null;
    }
    if (typeof tg.token === "string") {
      const token = tg.token.trim();
      if (fromFile) out.telegram.token = token;
      else if (token !== out.telegram.token) {
        // Never echo what was typed: it may be the token.
        if (token && !TOKEN_RE.test(token)) throw new Error("That doesn't look like a bot token from BotFather (it looks like 123456789:AAH...). Copy it again.");
        // A new bot (or none) means pairing again.
        out.telegram = { ...out.telegram, token, chatId: null, chatName: null, pairedAt: null };
      }
    }
    if (fromFile) {
      if (typeof tg.chatId === "number" && Number.isSafeInteger(tg.chatId)) out.telegram.chatId = tg.chatId;
      if (typeof tg.chatName === "string") out.telegram.chatName = tg.chatName.slice(0, 120);
      if (typeof tg.pairedAt === "string") out.telegram.pairedAt = tg.pairedAt;
      if (typeof tg.lockedAt === "string") out.telegram.lockedAt = tg.lockedAt;
      if (typeof tg.briefedAt === "string") out.telegram.briefedAt = tg.briefedAt;
    }
  }
  if (raw.kinds && typeof raw.kinds === "object") {
    for (const k of NOTIFY_KINDS) if (typeof raw.kinds[k] === "boolean") out.kinds[k] = raw.kinds[k];
  }
  return out;
}

export function isNtfy(s: Pick<NotifySettings, "webhookUrl" | "format">): boolean {
  if (s.format !== "auto") return s.format === "ntfy";
  try {
    return new URL(s.webhookUrl).hostname.includes("ntfy");
  } catch {
    return false;
  }
}

/** One "needs you" message. */
export interface NotifyMessage {
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  kind: NotifyKind;
  /** The attention label, e.g. "Answer 2 questions", or Claude's own text for kind "message". */
  label: string;
  /** Deep link to the ticket. */
  url: string;
}

/** A phone notification: the ticket as title, what it needs (and the board) below; one per ticket on screen. */
export function pushPayload(m: NotifyMessage): PushPayload {
  return { title: m.title, body: `${m.label} · ${m.boardName}`, url: m.url, tag: m.ticketId ? `${m.board}/${m.ticketId}` : "ckanban" };
}

/** HTTP headers allow Latin-1 only; ntfy reads RFC 2047 encoded words for anything else. */
export function headerValue(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

export const NTFY_TAGS: Record<NotifyKind, string> = {
  stalled: "warning", questions: "question", proposal: "memo", review: "eyes", failed: "x", limit: "hourglass", blocked: "no_entry", huddle: "speech_balloon", reply: "speech_balloon", message: "bell",
};

/** The webhook request: ntfy (plain text body, Title/Click/Tags headers) or JSON {board, ticketId, title, kind, url}. */
export function webhookRequest(s: Pick<NotifySettings, "webhookUrl" | "format">, m: NotifyMessage): { url: string; init: RequestInit } {
  if (isNtfy(s)) {
    return {
      url: s.webhookUrl,
      init: {
        method: "POST",
        headers: { Title: headerValue(m.kind === "message" ? m.title : `${m.label}: ${m.title}`), Click: m.url, Tags: NTFY_TAGS[m.kind], "Content-Type": "text/plain; charset=utf-8" },
        body: `${m.boardName} · ${m.label}`,
      },
    };
  }
  return {
    url: s.webhookUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: m.board, boardName: m.boardName, ticketId: m.ticketId, title: m.title, kind: m.kind, label: m.label, url: m.url }),
    },
  };
}

/** macOS notification; silently nothing elsewhere or when osascript fails. */
export function macBanner(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").slice(0, 240));
  runCmd(["osascript", "-e", `display notification ${q(body)} with title ${q(title)}`], homedir()).catch(() => {});
}

/**
 * Turns a stream of "what does this ticket need now" observations into notifications: one per transition into a
 * kind. A new state (a kind, or not waiting) counts only once it has held for debounceMs, so flicker (a run ending
 * and the next starting, questions answered and re-asked) neither notifies twice nor misses a real change.
 */
export class TransitionTracker<T extends string = AttentionKind> {
  private states = new Map<string, { settled: T | null; seen: T | null; since: number }>();

  constructor(private debounceMs: number) {}

  /** Record the current state without notifying (what was already waiting when the daemon started). */
  seed(key: string, kind: T | null, now: number): void {
    this.states.set(key, { settled: kind, seen: kind, since: now });
  }

  /** The kind to notify about now, or null. Call again later (see unsettled) to let a pending change settle. */
  observe(key: string, kind: T | null, now: number): T | null {
    let s = this.states.get(key);
    if (!s) {
      // First sight of a ticket after startup: it's new, so it wasn't waiting before.
      s = { settled: null, seen: kind, since: now };
      this.states.set(key, s);
    }
    if (s.seen !== kind) {
      s.seen = kind;
      s.since = now;
    }
    if (s.seen === s.settled || now - s.since < this.debounceMs) return null;
    s.settled = s.seen;
    return s.settled;
  }

  /** The settled state (undefined: never seen). */
  settledOf(key: string): T | null | undefined {
    return this.states.get(key)?.settled;
  }

  /** Tickets whose latest state hasn't settled yet. */
  unsettled(): string[] {
    return [...this.states].filter(([, s]) => s.seen !== s.settled).map(([k]) => k);
  }

  forget(key: string): void {
    this.states.delete(key);
  }
}

export interface NotifierOptions {
  root: string;
  sessionSummary: (sessionId: string) => SessionSummary | null;
  /**
   * Settles once session summaries are ready (SessionCache.ready). Given, the start-up stock-take waits for it and then
   * runs in slices instead of reading every transcript at once.
   */
  sessionsReady?: () => Promise<unknown>;
  isRunning: (slug: string, id: string) => boolean;
  hostHuddles: (slug: string) => Map<string, HostHuddle>;
  /** Where links point: the tailnet URL when phone access is on, else this Mac's localhost. */
  baseUrl: () => string;
  debounceMs?: number;
  tickMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  banner?: (title: string, body: string) => void;
  now?: () => number;
  /** Phone push to the devices that turned it on; omitted: none. */
  push?: PushService;
  /** Phone access is on (links open off this Mac). Default: baseUrl isn't this Mac's localhost. */
  phoneAccess?: () => boolean;
  /** Telegram's fetch (long poll; default: global fetch with a 65 s timeout). Tests pass a mock. */
  telegramFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Start Telegram's long poll (default true; tests drive TelegramBot.pollOnce). */
  telegramPoll?: boolean;
  /** Least time between Telegram form messages and edits (ms; default about one a second). Tests pass 0. */
  telegramPaceMs?: number;
  /** The front desk's "typing" interval (ms; default about 5 s; 0: once per message). */
  typingMs?: number;
}

/** A main ticket's step waiting on a question it asked: its wait, recorded under the main ticket. */
interface StepAsk {
  stepId: string;
  wait: NewWait;
  /** A "with you" step: only the user answers it, so its question goes to the helper even when not shown on the card. */
  withYou: boolean;
}

export class Notifier {
  private tracker: TransitionTracker<string>;
  /** Per main ticket (`<board>/<main>`): the steps whose question waits are tracked (keys `<board>/<main>~<step>`). */
  private stepKeys = new Map<string, Set<string>>();
  private dirty = new Set<string>();
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  private fetch: (url: string, init: RequestInit) => Promise<Response>;
  private banner: (title: string, body: string) => void;
  private now: () => number;
  /** Wait records, the message store, channels and the routing switch (helper/core.ts). The helper runner plugs in with helper.setSink. */
  readonly helper: HelperCore;
  /** The Telegram bot: sends, pairs and listens (helper/telegram.ts). */
  readonly telegram: TelegramBot;
  private phoneAccess: () => boolean;
  /** Replies to alerts (helper/tgreply.ts), with the message map and the buttons' pending actions. */
  readonly replies: TelegramReplies;
  readonly telegramLinks: TelegramLinks;
  readonly telegramActions: PendingActions;
  /** Question forms answered from Telegram (helper/tgforms.ts). */
  readonly forms: TelegramForms;
  /** The front desk: Telegram text that isn't a reply to an alert (helper/frontdesk.ts). Plugged into the quick chats by http.ts. */
  readonly frontDesk: FrontDesk;
  private board: TelegramBoard | null = null;
  private ntfyTopic = `https://ntfy.sh/ckanban-${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}`;

  constructor(private store: Store, private bus: Bus, private o: NotifierOptions) {
    this.tracker = new TransitionTracker<string>(o.debounceMs ?? 5000);
    this.fetch = o.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
    this.banner = o.banner ?? macBanner;
    this.now = o.now ?? Date.now;
    this.phoneAccess = o.phoneAccess ?? (() => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(o.baseUrl()));
    const deps = {
      fetch: (url: string, init: RequestInit) => this.fetch(url, init), banner: (t: string, b: string) => this.banner(t, b), push: o.push,
      phoneAccess: () => this.phoneAccess(),
    };
    this.telegram = new TelegramBot({
      fetch: o.telegramFetch ?? o.fetch ?? ((url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(65_000) })),
      settings: () => this.settings().telegram,
      save: (patch) => {
        const s = this.settings();
        writeNotifySettings(this.o.root, { ...s, telegram: { ...s.telegram, ...patch } });
      },
      actions: () => ({
        gotIt: (id) => this.helper.gotIt(id, "telegram"),
        notUrgent: (id) => this.helper.notUrgent(id, "telegram"),
        waiting: () => this.helper.waitingText(),
        night: (id, allow) => this.helper.nightAnswer(id, allow, "telegram"),
        nightAfter: (id) => this.helper.nightAfter(id),
      }),
      phoneAccess: () => this.phoneAccess(),
      boardUrl: () => `${this.o.baseUrl()}/`,
      now: this.now,
      autoPoll: o.telegramPoll ?? true,
      offsetFile: join(o.root, "telegram-offset.json"),
      queueRoot: o.root,
      links: this.telegramLinks = new TelegramLinks(o.root, this.now),
      itemsOf: (id) => (this.helper.messages.get(id)?.items ?? []).map((i) => ({ board: i.board, ticketId: i.ticketId, key: i.key ?? null })),
      replies: () => this.replies,
      lock: () => this.telegramLock(),
      alerted: (m, tg, chatId) => (m.messageId ? this.forms.show(this.helper.messages.get(m.messageId)?.items.map((i) => ({ board: i.board, ticketId: i.ticketId, key: i.key ?? null })) ?? [], tg, chatId) : undefined),
      ...(o.telegramPaceMs !== undefined ? { paceMs: o.telegramPaceMs } : {}),
      frontDesk: () => (this.frontDesk.ready() ? this.frontDesk : null),
      briefing: (paired) => FrontDesk.briefing(paired),
    });
    this.telegramActions = new PendingActions(o.root, this.now);
    this.helper = new HelperCore({
      root: o.root, store, channels: new Channels([macChannel(deps), webhookChannel(deps), pushChannel(deps), telegramChannel(this.telegram)]),
      settings: () => this.settings(), link: (slug, id) => this.link(slug, id), now: this.now, onResults: (r) => this.noteResults(r),
      onMessages: (unread) => this.bus.emit({ type: "messages.updated", unread }),
    });
    const taking = () => {
      const t = this.settings().telegram;
      return t.on && t.takeMessages && t.chatId !== null;
    };
    this.forms = new TelegramForms({
      store, waits: this.helper.waits, links: this.telegramLinks, pending: this.telegramActions,
      session: (sid) => o.sessionSummary(sid), bot: () => botId(this.settings().telegram.token),
      out: (chatId) => {
        const t = this.settings().telegram;
        return t.on && t.chatId === chatId && TOKEN_RE.test(t.token) ? this.telegram.responder(chatId, { paced: true }) : null;
      },
      chat: () => (this.board ? (slug, id, text, from) => this.board!.chatFromTelegram(slug, id, text, from) : null),
      taking, isRunning: (slug, id) => o.isRunning(slug, id), now: this.now,
    });
    const helperSettings = new HelperSettingsStore(o.root, this.now);
    this.frontDesk = new FrontDesk({
      root: o.root, store, waits: this.helper.waits, messages: this.helper.messages, pending: this.telegramActions, links: this.telegramLinks,
      settings: () => this.settings().telegram, night: () => helperSettings.get().night,
      out: (chatId, paced) => {
        const t = this.settings().telegram;
        return t.on && t.chatId === chatId && TOKEN_RE.test(t.token) ? this.telegram.responder(chatId, { paced: !!paced }) : null;
      },
      typing: (chatId) => this.telegram.typing(chatId),
      sendFile: (chatId, file, caption, replyTo) => this.telegram.sendFile(chatId, file, caption, replyTo),
      taking, isRunning: (slug, id) => o.isRunning(slug, id), board: () => this.board, phoneAccess: () => this.phoneAccess(), now: this.now,
      boardUrl: (slug) => {
        const url = this.link(slug);
        return this.phoneAccess() && /^https:\/\//.test(url) ? url : null;
      },
      ...(o.typingMs !== undefined ? { typingMs: o.typingMs } : {}),
    });
    // A wait closed: its Telegram alert says so and loses its buttons.
    this.helper.waits.onClosed = (recs) => void this.frontDesk.closed(recs).catch((e) => console.error("telegram: closed alert", e));
    this.replies = new TelegramReplies({
      store, waits: this.helper.waits, links: this.telegramLinks, pending: this.telegramActions,
      session: (sid) => o.sessionSummary(sid), isRunning: (slug, id) => o.isRunning(slug, id), bot: () => botId(this.settings().telegram.token),
      chat: () => (this.board ? (slug, id, text, from) => this.board!.chatFromTelegram(slug, id, text, from) : null),
      patch: (slug, id, patch) => void this.board?.patchTelegram(slug, id, patch),
      askTyped: () => this.settings().telegram.askTyped,
      taking, forms: this.forms, frontDesk: () => this.frontDesk,
      ticketUrl: (slug, id) => {
        const url = this.link(slug, id);
        return this.phoneAccess() && /^https:\/\//.test(url) ? url : null;
      },
      now: this.now,
    });
    o.push?.onDropped((d) => this.dropped(d.label));
  }

  /** lastSentAt / lastError from a send's channel results (webhook and push; the banner can't tell). */
  private noteResults(results: ChannelResult[]): void {
    const counted = results.filter((r) => r.channel !== "mac" && !r.skipped && !r.empty);
    const error = counted.find((r) => r.error)?.error ?? null;
    const sent = counted.some((r) => r.ok);
    if (error) console.warn(`notify: ${scrub(error, this.settings().telegram.token)}`);
    if (sent || error) this.lastError = error;
    if (sent) this.lastSentAt = nowIso();
  }

  /**
   * A device stopped accepting notifications and the board removed it: log it and tell the user on this Mac (its
   * browser, or the banner), since that device won't hear about it. The Notifications dialog shows it too.
   */
  private dropped(label: string): void {
    console.warn(`notify: ${label} no longer accepts notifications (its push service said it is gone), so the board removed it`);
    if (!this.settings().mac) return;
    const title = `Notifications stopped on ${label}`;
    const body = "Open the board there and turn notifications on again.";
    if (!this.macBrowser()) return this.banner(title, body);
    const url = `${this.o.baseUrl()}/`;
    void this.o.push!.send({ title, body, url, tag: "push-dropped" }, { thisMac: true, skipVisible: false })
      .then((r) => r.error && console.warn(`notify: ${r.error}`));
  }

  settings(): NotifySettings {
    return readNotifySettings(this.o.root);
  }

  /** The settings API's view: the Telegram token masked, each channel's state, and the setup hints. */
  state(): NotifyState {
    const { telegram: t, ...s } = this.settings();
    const tg = this.telegram.state();
    const telegram: TelegramPublic = {
      on: t.on, tokenSet: !!t.token, tokenMasked: maskToken(t.token), paired: t.chatId !== null, chatName: t.chatName, pairedAt: t.pairedAt,
      status: tg.state, error: tg.error, botName: tg.botName, pairing: tg.pairing, pairError: tg.pairError, askTyped: t.askTyped,
      takeMessages: t.takeMessages, lockedAt: t.lockedAt, spentToday: Math.round(telegramSpendToday(this.o.root, new Date(this.now())) * 100) / 100,
      deskCapUsd: this.frontDesk.cap(), deskSpentToday: Math.round(this.frontDesk.spentToday() * 100) / 100,
      frontDesk: this.frontDesk.board(), boards: this.store.listProfiles().map((p) => ({ slug: p.slug, name: p.name })),
    };
    const macBrowser = this.macBrowser();
    const phones = this.o.push?.phoneCount() ?? 0;
    const ntfy = isNtfy(s);
    const channels: ChannelState[] = [
      { name: "mac", label: "This Mac", on: s.mac, ready: true, detail: macBrowser ? "Notifications in this Mac's browser; a click opens the message." : "A Mac banner that says: See Messages on the board." },
      { name: "push", label: "Phone push", on: s.push, ready: phones > 0, detail: phones ? `${phones === 1 ? "1 phone or browser" : `${phones} phones or browsers`} get notifications; a tap opens the message.` : "No phone has notifications turned on yet (needs phone access)." },
      {
        name: "webhook", label: ntfy || !s.webhookUrl ? "ntfy" : "Web address (JSON)", on: s.webhookOn, ready: !!s.webhookUrl,
        detail: !s.webhookUrl ? "Not set up: add an ntfy topic address." : ntfy ? "The ntfy app shows the full message; urgent ones at top priority." : "The board posts each message to this address.",
      },
      {
        name: "telegram", label: "Telegram", on: t.on, ready: telegram.tokenSet && telegram.paired && tg.state !== "error",
        detail: !t.token ? "Not set up: make a bot with BotFather and paste its token." : !telegram.paired ? "Not paired yet: send the pairing code to your bot." : tg.error ?? (t.takeMessages ? `Paired with ${t.chatName ?? "your chat"}.` : `Paired with ${t.chatName ?? "your chat"}. ${t.lockedAt ? "Locked from Telegram" : "Paused"}: not taking messages; alerts still arrive.`),
      },
    ];
    const phoneReady = channels.some((c) => c.name !== "mac" && c.on && c.ready);
    return {
      ...s, telegram, channels, phoneReady, reachLine: phoneReady ? null : MAC_ONLY_LINE,
      ntfyTopicSuggestion: this.ntfyTopic, ntfyWarning: NTFY_WARNING, focusHint: FOCUS_HINT,
      lastSentAt: this.lastSentAt, lastError: this.lastError, macBrowser,
    };
  }

  /** Saves a settings change. Turning the helper off sends what it held as one digest; on, what is open counts as told. */
  /**
   * from "remote" (phone access): anything that turns Telegram messages back on, or sets a new bot key, is refused with
   * a MacOnlyError, so a lost phone with board access can't undo /lock or Pause. Turning things off stays allowed.
   */
  update(patch: unknown, from: "local" | "remote" = "local"): NotifyState {
    const before = this.settings();
    const next = normalizeSettings(patch, before);
    if (next.telegram.frontDesk && next.telegram.frontDesk !== before.telegram.frontDesk && !this.store.getProfile(next.telegram.frontDesk)) {
      throw new Error(`board ${next.telegram.frontDesk} not found`);
    }
    const taking = (t: TelegramSettings) => t.on && t.takeMessages && t.chatId !== null;
    if (from === "remote") {
      if (next.telegram.token && next.telegram.token !== before.telegram.token) throw new MacOnlyError(TG_PAIR_FROM_MAC);
      if ((next.telegram.takeMessages && !before.telegram.takeMessages) || (taking(next.telegram) && !taking(before.telegram))) {
        throw new MacOnlyError(TG_ON_FROM_MAC);
      }
    }
    writeNotifySettings(this.o.root, next);
    if (before.helper !== next.helper) void this.helper.switched(next.helper).catch((e) => console.error("helper: switch", e));
    if (before.telegram.token !== next.telegram.token) this.telegram.reset();
    // Stopped taking messages (Pause, the channel off, a new bot): nothing Telegram left waiting reaches a ticket.
    if (taking(before.telegram) && !taking(next.telegram)) this.dropTelegramWork();
    this.telegram.refresh();
    return this.state();
  }

  /**
   * Telegram stopped taking messages: open buttons expire, updates waiting to be handled are dropped, and messages
   * from Telegram that wait in a ticket's queue (not handed to Claude yet) are taken out.
   */
  private dropTelegramWork(): void {
    try {
      this.telegramActions.expireAll();
    } catch (e) {
      console.warn(`telegram: couldn't drop pending buttons: ${(e as Error).message}`);
    }
    try {
      this.telegram.queue.clear();
    } catch (e) {
      console.warn(`telegram: couldn't drop queued updates: ${(e as Error).message}`);
    }
    try {
      this.board?.dropTelegramQueued();
    } catch (e) {
      console.warn(`telegram: couldn't drop queued ticket messages: ${(e as Error).message}`);
    }
  }

  /** /lock from the paired chat: "Take messages from Telegram" off at once; only Settings on the Mac turns it back on. */
  telegramLock(): void {
    const s = this.settings();
    writeNotifySettings(this.o.root, { ...s, telegram: { ...s.telegram, takeMessages: false, lockedAt: new Date(this.now()).toISOString() } });
    this.dropTelegramWork();
  }

  /** The board plugs in: replies to alerts go into its tickets' chats. */
  plugBoard(board: TelegramBoard): void {
    this.board = board;
  }

  /** A ticket's run ended (Board turnEnded): a Telegram message waiting for its reply gets it. */
  async turnEnded(slug: string, id: string, text: string): Promise<void> {
    const s = this.settings().telegram;
    await this.replies.turnEnded(slug, id, text, (chatId) => (s.on && s.chatId === chatId && TOKEN_RE.test(s.token) ? this.telegram.responder(chatId) : null));
  }

  /** Settings' "Pair": a fresh 6-digit code to send to the bot. Throws without a token. */
  telegramPair(board?: string | null): { code: string; expiresAt: string } {
    const r = this.telegram.startPairing();
    // The front desk lives on the board paired from, unless Settings already chose one.
    const s = this.settings();
    if (board && this.store.getProfile(board) && !s.telegram.frontDesk) writeNotifySettings(this.o.root, { ...s, telegram: { ...s.telegram, frontDesk: board } });
    return r;
  }

  /** Settings' "Unpair": forget the chat, and drop its open buttons and everything it left waiting. */
  telegramUnpair(): NotifyState {
    this.telegram.unpair();
    this.dropTelegramWork();
    return this.state();
  }

  /**
   * Takes stock of what already waits (reconciled with the waits file: see HelperCore.reconcile), then follows
   * ticket, session and huddle changes.
   */
  start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const off = this.bus.on((e) => {
      if (e.type === "ticket.updated") {
        this.dirty.add(`${e.profile}/${e.ticket.id}`);
        // A tool ticket's question or failure shows on its main ticket: look at that one again too.
        if (e.ticket.tool) {
          const main = mainTicketOf(this.store.listTickets(e.profile), e.ticket.id);
          if (main) this.dirty.add(`${e.profile}/${main.id}`);
        }
      }
      else if (e.type === "session.updated") {
        this.dirty.add(`${e.profile}/${e.id}`);
        // A step's question (form, urgent mark) is read from its own session: its main ticket looks again too.
        const t = this.store.getTicket(e.profile, e.id);
        const main = t?.tool ? mainTicketOf(this.store.listTickets(e.profile), e.id) : undefined;
        if (main) this.dirty.add(`${e.profile}/${main.id}`);
      }
      else if (e.type === "huddle.updated" && e.huddle.hostTicket) this.dirty.add(`${e.profile}/${e.huddle.hostTicket}`);
      else if (e.type === "ticket.deleted") {
        this.tracker.forget(`${e.profile}/${e.id}`);
        for (const sid of this.stepKeys.get(`${e.profile}/${e.id}`) ?? []) this.tracker.forget(`${e.profile}/${e.id}~${sid}`);
        this.stepKeys.delete(`${e.profile}/${e.id}`);
        // A deleted step: its main ticket looks again, so the step's wait closes.
        for (const [k, ids] of this.stepKeys) if (k.startsWith(`${e.profile}/`) && ids.has(e.id)) this.dirty.add(k);
        this.helper.deleted(e.profile, e.id);
      } else if (e.type === "profile.updated" && e.profile === null) this.helper.deleted(e.slug);
    });
    const follow = () => {
      if (stopped) return;
      this.helper.started();
      this.telegram.refresh();
      // Chats paired before the front desk existed get its briefing once.
      void this.telegram.briefOnce().catch((e) => console.error("telegram: briefing", e));
      timer = trackedInterval("notifier", () => this.tick(), this.o.tickMs ?? 1000);
    };
    const keys = () => this.store.listProfiles().flatMap((p) => this.store.listTickets(p.slug).map((t) => [p.slug, t.id] as const));
    const stock = (slug: string, id: string, now: number) => {
      const w = this.waitOf(slug, id);
      const asks = this.stepAsks(slug, id);
      this.tracker.seed(`${slug}/${id}`, w?.identity ?? null, now);
      for (const a of asks) this.tracker.seed(`${slug}/${id}~${a.stepId}`, a.wait.identity, now);
      if (asks.length) this.stepKeys.set(`${slug}/${id}`, new Set(asks.map((a) => a.stepId)));
      const on = this.settings().kinds.questions;
      this.helper.reconcile(slug, id, w && this.settings().kinds[w.kind] ? w : null, w?.identity ?? null, {
        steps: on ? asks.filter((a) => a.withYou || a.wait.identity === w?.identity).map((a) => a.wait) : [],
        fromStep: !!w && asks.some((a) => a.wait.identity === w.identity),
      });
    };
    if (this.o.sessionsReady) {
      // Changes seen meanwhile are kept (dirty) and looked at on the first tick.
      void track("notifier: stock-take", async () => {
        await this.o.sessionsReady!();
        const now = this.now();
        const pause = pauser(30);
        for (const [slug, id] of keys()) {
          await pause();
          if (stopped) return;
          stock(slug, id, now);
        }
      }).catch((e) => console.error("notifier", e)).finally(follow);
    } else {
      const now = this.now();
      for (const [slug, id] of keys()) stock(slug, id, now);
      follow();
    }
    return () => {
      stopped = true;
      off();
      if (timer) clearInterval(timer);
      this.telegram.stop();
      this.frontDesk.stop();
    };
  }

  /** Look again at changed tickets and those whose change is still settling; route the transitions; run the helper's due times. */
  tick(): void {
    // A step's tracker key (`<board>/<main>~<step>`) is looked at with its main ticket.
    const keys = new Set([...this.dirty, ...this.tracker.unsettled()].map((k) => k.split("~")[0]));
    this.dirty.clear();
    const now = this.now();
    for (const key of keys) {
      const [slug, id] = key.split("/");
      const w = this.waitOf(slug, id);
      const asks = this.stepAsks(slug, id);
      const before = this.tracker.settledOf(key);
      const identity = this.tracker.observe(key, w?.identity ?? null, now);
      const after = this.tracker.settledOf(key);
      const stepIds = asks.map((a) => a.wait.identity);
      if (before !== after && before !== undefined) this.helper.settled(slug, id, after ?? null, stepIds);
      if (identity && w) this.fire(w);
      this.observeSteps(key, slug, id, asks, after ?? null, now);
      // A form shown on Telegram that the ticket no longer asks (answered on the board): its taps go, its messages say so.
      void this.forms.sync(slug, id).catch((e) => console.error("telegram: form", e));
    }
    void this.helper.tick().catch((e) => console.error("helper: tick", e));
  }

  /**
   * A main ticket's steps' questions, one wait each: a step's question is its own wait from when it settles until the
   * step stops waiting, whichever step the card shows. "With you" ones go to the helper; others only when shown.
   */
  private observeSteps(key: string, slug: string, id: string, asks: StepAsk[], current: string | null, now: number): void {
    const known = this.stepKeys.get(key) ?? new Set<string>();
    for (const a of asks) known.add(a.stepId);
    for (const sid of [...known]) {
      const sk = `${key}~${sid}`;
      const a = asks.find((x) => x.stepId === sid);
      const before = this.tracker.settledOf(sk);
      const identity = this.tracker.observe(sk, a?.wait.identity ?? null, now);
      const after = this.tracker.settledOf(sk);
      if (before && before !== after) this.helper.stepSettled(slug, id, before, current);
      if (identity && a?.withYou) this.fire(a.wait);
      if (!a && !after && !this.tracker.unsettled().includes(sk)) {
        this.tracker.forget(sk);
        known.delete(sid);
      }
    }
    if (known.size) this.stepKeys.set(key, known);
    else this.stepKeys.delete(key);
  }

  /** On a main ticket: each of its tool tickets that waits on a question (stepWait), as a wait under the main ticket. */
  private stepAsks(slug: string, id: string): StepAsk[] {
    const t = this.store.getTicket(slug, id);
    if (!t?.main || t.status === "done" || t.status === "backlog") return [];
    const tickets = this.store.listTickets(slug);
    // A tool step's question (not "with you") is the main ticket's to handle: it is the user's only while the main
    // ticket hasn't seen it and won't be woken for it (attentionFor's rule).
    const handling = this.o.isRunning(slug, id) || ((t.plan?.state === "running" || t.plan?.state === "finishing") && (!!t.plan.awaiting || !!t.plan.inbox?.length));
    const out: StepAsk[] = [];
    // Its own tasks only: a sub-feature's tasks ask in the sub-feature's chat (featureRows stops there).
    for (const r of featureRows(tickets, id)) {
      if (r.ticket.id === id || !hiddenTool(r.ticket)) continue;
      const sw = stepWait(r.ticket, this.o.isRunning(slug, r.ticket.id));
      if (sw?.attention !== "questions") continue;
      if (!sw.withYou && (handling || sw.since <= (t.runEndedAt ?? ""))) continue;
      out.push({ stepId: r.ticket.id, wait: this.stepQuestion(slug, id, r.ticket, sw.label, sw.since), withYou: !!sw.withYou });
    }
    return out;
  }

  /**
   * A step's question as a wait under its main ticket: the step asked it, so its form, urgent mark and why are in the
   * step's own session. Its identity names the step, so another step's question is its own wait.
   */
  private stepQuestion(slug: string, mainId: string, step: Ticket, label: string, since: string): NewWait {
    const s = step.sessionId ? this.o.sessionSummary(step.sessionId) : null;
    const form = s?.openForm?.length ? s.openForm.map((q) => q.question).join("\n") : null;
    const ask = form ? s?.openAsk : undefined;
    return {
      board: slug, ticketId: mainId, kind: "questions", identity: waitIdentity("questions", `${step.id}\n${form ?? ""}`), question: form ?? label, label, since,
      ...(ask?.urgent ? { urgent: true } : {}), why: ask?.why ?? null,
    };
  }

  /** What the ticket waits on now, as a wait the helper core can record, or null. */
  private waitOf(slug: string, id: string): NewWait | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return null;
    const s = t.sessionId ? this.o.sessionSummary(t.sessionId) : null;
    const att = ticketAttention(this.store, slug, t, s, this.o.isRunning(slug, id), this.o.hostHuddles(slug).get(id), (x) => this.o.isRunning(slug, x));
    if (!att) return null;
    // A step's question shown on its main ticket: the step's own wait (stepQuestion), with the card's label.
    const step = att.kind === "questions" && att.stepId ? this.store.getTicket(slug, att.stepId) : undefined;
    if (step) return { ...this.stepQuestion(slug, id, step, att.label, att.since), label: att.label };
    const form = att.kind === "questions" && s?.openForm?.length ? s.openForm.map((q) => q.question).join("\n") : null;
    const ask = att.kind === "questions" && form ? s?.openAsk : undefined;
    return {
      board: slug, ticketId: id, kind: att.kind, identity: waitIdentity(att.kind, form), question: form ?? att.label, label: att.label, since: att.since,
      ...(ask?.urgent ? { urgent: true } : {}), why: ask?.why ?? null,
    };
  }

  private fire(w: NewWait) {
    // A kind turned off in the old switches stays off, also for the helper.
    if (!this.settings().kinds[w.kind]) return;
    if (!this.store.getTicket(w.board, w.ticketId) || !this.store.getProfile(w.board)) return;
    void this.helper.route(w).catch((e) => console.error("helper: route", e));
  }

  /** A message's page (#/~messages/<id>): where a tap on a helper message lands. */
  messageLink(id: string): string {
    return `${this.o.baseUrl()}/#/~messages/${encodeURIComponent(id)}`;
  }

  link(slug: string, id?: string): string {
    return `${this.o.baseUrl()}/#/${encodeURIComponent(slug)}${id ? `/${encodeURIComponent(id)}` : ""}`;
  }

  /**
   * The user opened the ticket: its wait records note it (openedAt) and their reminders stop. Returns whether a
   * reminder was pending, so markSeen records the open even inside its 5-minute throttle.
   */
  opened(slug: string, id: string): boolean {
    const pending = this.helper.waits.hasPendingReminder(slug, id);
    this.helper.opened(slug, id);
    return pending;
  }

  /**
   * Whether a browser on this Mac gets notifications. Then it replaces the macOS banner: its notifications open the
   * ticket when clicked, the banner can't (a click opens Finder or Script Editor).
   */
  private macBrowser(): boolean {
    return !!this.o.push?.hasThisMac();
  }

  /**
   * Only on this Mac (when the banner is on), not to the webhook or phones. For board events that aren't "needs you"
   * (plan done). `url` is the ticket a click opens.
   */
  macOnly(title: string, body: string, url: string): void {
    if (!this.settings().mac) return;
    if (!this.macBrowser()) return this.banner(title, body);
    void this.o.push!.send({ title, body, url, tag: url }, { thisMac: true }).then((r) => r.error && console.warn(`notify: ${r.error}`));
  }

  /**
   * Banner, webhook and phone push as configured, stored as a message first. Resolves with the first error, or null.
   * Push skips devices with the board on screen unless `everyDevice` (the test button).
   */
  async send(_settings: NotifySettings, m: NotifyMessage, everyDevice = false): Promise<string | null> {
    return firstError(await this.sendResults(m, everyDevice));
  }

  private async sendResults(m: NotifyMessage, everyDevice: boolean, text = m.label): Promise<ChannelResult[]> {
    const level = everyDevice ? "test" : "direct";
    const { results } = await this.helper.send(
      { level, oneLine: `${m.label}: ${m.title}`, text: `${m.title} (${m.boardName})\n\n${text}` },
      { level, title: m.title, body: m.label, text, url: m.url, notify: m, everyDevice },
    );
    return results;
  }

  /**
   * notify_user: a ticket's Claude tells the user something in its own words (ticket title above, its text below; a
   * tap opens the ticket). Helper on: passed to the helper (a wait record of kind "message") instead. Otherwise the
   * same channels and on-screen skip as "needs you". At most one per ticket per CLAUDE_MESSAGE_GAP_MS (kept on disk).
   * Logged on the ticket when it reached the user (or the helper).
   */
  async message(slug: string, id: string, raw: string, o: { urgent?: boolean; why?: string | null } = {}): Promise<MessageResult> {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) throw new MessageError("message is required: what you need from the user, in one short sentence");
    if (text.length > CLAUDE_MESSAGE_MAX) throw new MessageError(`message is too long (${text.length} characters, max ${CLAUDE_MESSAGE_MAX}): keep it to one short ask`);
    const t = this.store.getTicket(slug, id);
    const p = this.store.getProfile(slug);
    if (!t || !p) throw new MessageError(`ticket ${id} not found`, 404);
    const last = this.helper.waits.lastNotifyUser(slug, id);
    const now = this.now();
    if (last !== undefined && now - last < CLAUDE_MESSAGE_GAP_MS) {
      const next = new Date(last + CLAUDE_MESSAGE_GAP_MS);
      throw new MessageError(`a message was already sent for this ticket in the last ${CLAUDE_MESSAGE_GAP_MS / 60_000} minutes; the next one is allowed after ${next.toISOString()}`, 429);
    }
    const none = { delivered: false, devices: 0, onScreen: 0, webhook: false, banner: false, error: null };
    const settings = this.settings();
    if (!settings.kinds.message) return { ...none, reason: "off" };
    // A "with you" step talks to the user in its main ticket's chat: a tap opens that chat (newest at the bottom, where its message is).
    const main = withYouTool(t) ? mainTicketOf(this.store.listTickets(slug), id) : undefined;
    const target = main && main.id !== id ? main : t;
    const label = target.id === id ? text : `${t.title}: ${text}`;
    const why = typeof o.why === "string" && o.why.trim() ? o.why.trim() : null;
    if (this.helper.active(settings)) {
      await this.helper.route({
        board: slug, ticketId: target.id, kind: "message", identity: waitIdentity("message", label), question: label, label, since: new Date(now).toISOString(),
        ...(o.urgent ? { urgent: true } : {}), why,
      });
      this.helper.waits.setNotifyUser(slug, id, now);
      this.store.addComment(slug, id, "ai", `Passed to the helper: ${text}`);
      return { ...none, delivered: true, reason: null, helper: true };
    }
    const m: NotifyMessage = { board: slug, boardName: p.name, ticketId: target.id, title: target.title, kind: "message", label, url: this.link(slug, target.id) };
    const item = { board: slug, boardName: p.name, ticketId: target.id, title: target.title, question: label };
    const full = `${target.title} (${p.name})\n\n${label}${why ? `\n\nWhy: ${why}` : ""}`;
    const { results } = await this.helper.send(
      { level: o.urgent ? "urgent" : "message", oneLine: `${target.title}: ${label}`.slice(0, 240), text: full, why, items: [item] },
      { level: o.urgent ? "urgent" : "message", title: m.title, body: label, text: full, url: m.url, notify: m, urgent: o.urgent },
    );
    const hook = results.find((r) => r.channel === "webhook");
    const push = results.find((r) => r.channel === "push");
    const mac = results.find((r) => r.channel === "mac");
    const tg = results.find((r) => r.channel === "telegram");
    const banner = !!mac?.ok && mac.devices === undefined;
    const error = firstError(results);
    const devices = (push?.devices ?? 0) + (mac?.devices ?? 0);
    const onScreen = (push?.onScreen ?? 0) + (mac?.onScreen ?? 0);
    const delivered = banner || !!hook?.ok || devices > 0 || !!tg?.ok;
    if (delivered) {
      this.helper.waits.setNotifyUser(slug, id, now);
      this.store.addComment(slug, id, "ai", `Sent you a notification: ${text}`);
    }
    return {
      delivered, devices, onScreen, webhook: !!hook?.ok, banner, error, ...(tg ? { telegram: tg.ok } : {}),
      reason: delivered ? null : onScreen ? "on-screen" : error ? null : "nowhere",
    };
  }

  /**
   * A board browser was logged out (board-browsers.ts sign-in check): an urgent message to the user on every channel
   * (a customer desk may be waiting), stored in Messages, and shown on open boards as an urgent line. The caller sends
   * it once per logout. slug: a board that uses the browser (the tap opens its Browsers window), or null.
   */
  async browserLoggedOut(name: string, site: string, slug: string | null, boards: string[]): Promise<string | null> {
    const body = `${name} is logged out of ${site}. Open More, Browsers to sign in again.`;
    const text = `${body}${boards.length ? `\n\nUsed by: ${boards.join(", ")}.` : ""}\n\nOn a phone, the Browsers window shows the login page so you can sign in from there.`;
    const url = `${slug ? this.link(slug) : `${this.o.baseUrl()}/#/`}?browsers`;
    const { results } = await this.helper.send(
      { level: "urgent", oneLine: body, text },
      { level: "urgent", title: "Browser logged out", body, text, url, urgent: true, everyDevice: true, tag: `browser-${name}` },
    );
    return firstError(results);
  }

  private testMessage(slug?: string): NotifyMessage {
    const p = slug ? this.store.getProfile(slug) : this.store.listProfiles()[0];
    return {
      board: p?.slug ?? "", boardName: p?.name ?? "ckanban", ticketId: "", title: "Test notification", kind: "review",
      label: "ckanban", url: p ? this.link(p.slug) : `${this.o.baseUrl()}/`,
    };
  }

  /**
   * The "Send test notification" button: a sample message through banner, webhook and every phone (the board is on
   * screen there, so the visible skip doesn't apply), whatever the kind toggles say.
   */
  async test(slug?: string): Promise<{ ok: boolean; error: string | null; webhook: boolean; devices: number; channels: ChannelResult[] }> {
    const settings = this.settings();
    const results = await this.sendResults(this.testMessage(slug), true, "Test notification from ckanban: if you can read this, this channel works.");
    const error = firstError(results);
    return { ok: !error, error, webhook: !!settings.webhookUrl, devices: this.o.push?.devices().length ?? 0, channels: results };
  }

  /** A device's own "Send test": that device only. */
  async testDevice(id: string, slug?: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.o.push) return { ok: false, error: "phone push is not available" };
    const r = await this.o.push.send(pushPayload(this.testMessage(slug)), { only: id, skipVisible: false });
    const error = r.error ?? (r.removed ? "this device no longer accepts notifications: turn them on again" : r.sent ? null : "device not found");
    return { ok: !error, error };
  }
}

/** The first error worth showing (not the Mac banner, which can't tell, and not "no phone turned push on"). */
function firstError(results: ChannelResult[]): string | null {
  return results.find((r) => r.channel !== "mac" && !r.empty && r.error)?.error ?? null;
}
