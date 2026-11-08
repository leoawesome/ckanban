// Channels the board reaches the user on. Built in: "mac" (banner, or this Mac's browser when it gets notifications),
// "push" (phones and other browsers that turned phone push on), "webhook" (ntfy or JSON) and "telegram"
// (telegram.ts, registered by the Notifier). Each has its own on/off switch in notify.json.
import { headerValue, isNtfy, macBanner, NTFY_TAGS, pushPayload, webhookRequest, type NotifyMessage, type NotifySettings } from "../notify";
import type { PushService } from "../push";
import type { MessageLevel } from "./messages";

/** One message on its way out, in every shape a channel needs. */
export interface OutMessage {
  /** The stored message (messages.json); null for messages that aren't stored (the test button). */
  messageId: string | null;
  level: MessageLevel;
  /** Title line (the ticket, or "ckanban"). */
  title: string;
  /** One line under the title (about 110 characters). */
  body: string;
  /** The full text (channels that carry it: ntfy, Telegram). */
  text: string;
  /** Where a tap goes. */
  url: string;
  /** Phone push tag: a new message with the same tag replaces the old one. */
  tag?: string;
  /** Interrupt: ntfy priority 5, Telegram with sound (routine Telegram is silent). */
  urgent?: boolean;
  /** The legacy "needs you" shape: the built-in channels format exactly as before when given. */
  notify?: NotifyMessage;
  /** Push to every device, also where the board is on screen (the test button; urgent sends). */
  everyDevice?: boolean;
}

export interface ChannelResult {
  channel: string;
  /** Reached the user. */
  ok: boolean;
  /** Not used: the channel is off or not set up (not an error). */
  skipped?: boolean;
  devices?: number;
  onScreen?: number;
  /** Nothing to send to (no phone turned push on): a failure for the caller, but not an error to show the user. */
  empty?: boolean;
  error: string | null;
}

export interface Channel {
  name: string;
  /** On and set up. */
  enabled(settings: NotifySettings): boolean;
  send(m: OutMessage, settings: NotifySettings): Promise<ChannelResult>;
}

export interface BuiltinDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  banner?: (title: string, body: string) => void;
  push?: PushService;
  /** Phone access is on (links work off this Mac). ntfy gets a Click link only then; else its text ends "Answer on your Mac". */
  phoneAccess?: () => boolean;
}

/** The message page for a stored message, on the same address as the link. */
export function messagePageUrl(url: string, messageId: string): string {
  try {
    return `${new URL(url).origin}/#/~messages/${encodeURIComponent(messageId)}`;
  } catch {
    return url;
  }
}

/** What a tap opens: the message's page (full text) when it is stored, else the link. */
export const tapUrl = (m: OutMessage) => (m.messageId ? messagePageUrl(m.url, m.messageId) : m.url);

/** The Mac banner can't open a page, so it points the user at the board. */
export const MAC_BANNER_HINT = "See Messages on the board";

/** ntfy's body limit is 4096 bytes; keep under it. */
export const NTFY_MAX_BYTES = 4000;

/** Cuts text to at most `max` UTF-8 bytes (never inside a character). */
export function cutBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let s = buf.subarray(0, Math.max(0, max - 3)).toString("utf8");
  if (s.endsWith("\uFFFD")) s = s.slice(0, -1);
  return `${s}…`;
}

const legacy = (m: OutMessage): NotifyMessage => m.notify ?? {
  board: "", boardName: "ckanban", ticketId: "", title: m.title, kind: "message", label: m.body, url: m.url,
};

/**
 * This Mac: a push to this Mac's browser when one gets notifications (a click opens the message), else the macOS
 * banner (a click can't open a page, so it says "See Messages on the board").
 */
export function macChannel(d: BuiltinDeps): Channel {
  const banner = d.banner ?? macBanner;
  return {
    name: "mac",
    enabled: (s) => s.mac,
    async send(m) {
      if (d.push?.hasThisMac()) {
        const r = await d.push.send(payloadOf(m), { thisMac: true, skipVisible: !m.everyDevice });
        if (r.sent > 0 || r.onScreen > 0) return { channel: "mac", ok: r.sent > 0, devices: r.sent, onScreen: r.onScreen, error: r.error };
        // The browser didn't take it: the banner still can.
      }
      const n = legacy(m);
      const hint = m.messageId ? MAC_BANNER_HINT : n.boardName;
      if (m.notify && n.kind !== "message") banner(`${n.label}: ${n.title}`, m.messageId ? `${n.boardName} · ${MAC_BANNER_HINT}` : hint);
      else banner(m.title, m.messageId ? `${m.body} · ${MAC_BANNER_HINT}` : m.body);
      return { channel: "mac", ok: true, error: null };
    },
  };
}

/** The phone push payload: a tap opens the message page (sw.js), the one line below the title. */
function payloadOf(m: OutMessage) {
  const p = m.notify ? pushPayload(m.notify) : { title: m.title, body: m.body, url: m.url, tag: m.tag ?? "ckanban" };
  if (m.tag) p.tag = m.tag;
  return { ...p, url: tapUrl(m), ...(m.messageId ? { messageId: m.messageId } : {}) };
}

/** Phones and other browsers that turned phone push on (this Mac's browser is the "mac" channel). 0 devices is a failure. */
export function pushChannel(d: BuiltinDeps): Channel {
  return {
    name: "push",
    enabled: (s) => !!d.push && s.push,
    async send(m) {
      if (!d.push) return { channel: "push", ok: false, skipped: true, error: null };
      const r = await d.push.send(payloadOf(m), { skipVisible: !m.everyDevice, exceptThisMac: true });
      const empty = !r.error && !r.sent && !r.onScreen && !r.removed;
      const error = r.error ?? (empty ? "no phone has notifications turned on" : null);
      return { channel: "push", ok: r.sent > 0, devices: r.sent, onScreen: r.onScreen, error, ...(empty ? { empty } : {}) };
    },
  };
}

/** ntfy: the full text in the body (up to about 4 KB), Priority 5 when urgent, a Click link only with phone access. */
export function ntfyRequest(s: Pick<NotifySettings, "webhookUrl">, m: OutMessage, phoneAccess: boolean): { url: string; init: RequestInit } {
  const n = legacy(m);
  const title = m.notify && n.kind !== "message" ? `${n.label}: ${n.title}` : m.title;
  const tail = phoneAccess ? "" : "\n\nAnswer on your Mac.";
  const text = m.text.trim() || m.body;
  const headers: Record<string, string> = {
    Title: headerValue(title), Tags: m.urgent ? "rotating_light" : NTFY_TAGS[n.kind], "Content-Type": "text/plain; charset=utf-8",
  };
  if (phoneAccess) headers.Click = tapUrl(m);
  if (m.urgent) headers.Priority = "5";
  return { url: s.webhookUrl, init: { method: "POST", headers, body: cutBytes(text, NTFY_MAX_BYTES - Buffer.byteLength(tail)) + tail } };
}

/** The web address channel: ntfy (see ntfyRequest) or any JSON endpoint (unchanged). */
export function webhookChannel(d: BuiltinDeps): Channel {
  return {
    name: "webhook",
    enabled: (s) => !!s.webhookUrl && s.webhookOn,
    async send(m, s) {
      if (!s.webhookUrl) return { channel: "webhook", ok: false, skipped: true, error: null };
      const { url, init } = isNtfy(s) ? ntfyRequest(s, m, d.phoneAccess?.() ?? false) : webhookRequest(s, legacy(m));
      try {
        const r = await d.fetch(url, init);
        return r.ok ? { channel: "webhook", ok: true, error: null } : { channel: "webhook", ok: false, error: `webhook answered ${r.status} ${r.statusText}`.trim() };
      } catch (e) {
        return { channel: "webhook", ok: false, error: `webhook failed: ${(e as Error).message}` };
      }
    },
  };
}

/** The channels in fallback order; sendAll sends to every one that is on. */
export class Channels {
  private list: Channel[] = [];

  constructor(builtin: Channel[] = []) {
    for (const c of builtin) this.register(c);
  }

  /** Adds a channel, or replaces the one with its name. */
  register(c: Channel): void {
    const i = this.list.findIndex((x) => x.name === c.name);
    if (i >= 0) this.list[i] = c;
    else this.list.push(c);
  }

  get(name: string): Channel | undefined {
    return this.list.find((c) => c.name === name);
  }

  names(): string[] {
    return this.list.map((c) => c.name);
  }

  /** Channels that are on, in order. */
  enabled(settings: NotifySettings): Channel[] {
    return this.list.filter((c) => c.enabled(settings));
  }

  /** Sends to the named channels (default: every one that is on), all at once. */
  async sendAll(m: OutMessage, settings: NotifySettings, only?: string[]): Promise<ChannelResult[]> {
    const targets = only ? only.map((n) => this.get(n)).filter((c): c is Channel => !!c && c.enabled(settings)) : this.enabled(settings);
    return Promise.all(targets.map((c) => c.send(m, settings).catch((e) => ({ channel: c.name, ok: false, error: `${c.name} failed: ${(e as Error).message}` }))));
  }
}
