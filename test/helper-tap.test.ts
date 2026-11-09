// Where a tap on a helper message lands: an urgent alert or reminder about one ticket opens that ticket (and marks
// the message read); everything else opens the message page.
import { describe, expect, test } from "bun:test";
import { Channels, ntfyRequest, pushChannel, tapTicket, tapUrl, type Channel, type OutMessage } from "../src/server/helper/channels";
import { HelperCore } from "../src/server/helper/core";
import type { MessageItem, MessageLevel } from "../src/server/helper/messages";
import { TelegramBot, type TelegramSettings } from "../src/server/helper/telegram";
import { normalizeSettings } from "../src/server/notify";
import { Store } from "../src/server/store";
import { readFromHash } from "../web/src/helperText";
import { tempDir } from "./helpers";

const BASE = "https://mac.tail.ts.net";
const item = (board: string, ticketId: string): MessageItem => ({ board, boardName: board, ticketId, title: ticketId, question: "Stop it?" });
const TICKET = `${BASE}/#/kb/t_1?read=m_1`;
const PAGE = `${BASE}/#/~messages/m_1`;

/** The tap URL a stored message gets, as HelperCore.deliver builds it. */
const tapFor = (level: MessageLevel, items: MessageItem[], messageId: string | null = "m_1") =>
  tapUrl({ messageId, url: `${BASE}/#/~messages/m_1`, ticket: tapTicket({ level, items }) });

describe("tap URL choice", () => {
  test("urgent alert about one ticket: that ticket, carrying the message to mark read", () => {
    expect(tapFor("urgent", [item("kb", "t_1")])).toBe(TICKET);
  });
  test("reminder about one ticket: that ticket", () => {
    expect(tapFor("reminder", [item("kb", "t_1")])).toBe(TICKET);
  });
  test("the same ticket named twice still counts as one", () => {
    expect(tapFor("urgent", [item("kb", "t_1"), { ...item("kb", "t_1"), key: "other" }])).toBe(TICKET);
  });
  test("urgent alert about two tickets (even on two boards with the same id): the message page", () => {
    expect(tapFor("urgent", [item("kb", "t_1"), item("kb", "t_2")])).toBe(PAGE);
    expect(tapFor("urgent", [item("kb", "t_1"), item("other", "t_1")])).toBe(PAGE);
    expect(tapFor("urgent", [])).toBe(PAGE);
  });
  test("summary, digest, pause, hello, direct about one ticket: the message page", () => {
    for (const level of ["summary", "digest", "pause", "hello", "routine", "direct", "fallback"] as MessageLevel[]) {
      expect(tapFor(level, [item("kb", "t_1")])).toBe(PAGE);
    }
  });
  test("test message (not stored): its own link", () => {
    expect(tapUrl({ messageId: null, url: `${BASE}/#/kb`, ticket: null })).toBe(`${BASE}/#/kb`);
  });
  test("board slugs and ticket ids are encoded", () => {
    expect(tapUrl({ messageId: "m 1", url: `${BASE}/`, ticket: { board: "a b", ticketId: "t/1" } })).toBe(`${BASE}/#/a%20b/t%2F1?read=m%201`);
  });
});

describe("every channel uses the same tap URL", () => {
  const settings = normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false, push: true, webhookOn: true });

  async function deliver(level: MessageLevel, items: MessageItem[]) {
    const store = new Store(tempDir("ck-home-"));
    const seen: OutMessage[] = [];
    const spy: Channel = { name: "spy", enabled: () => true, send: async (m) => (seen.push(m), { channel: "spy", ok: true, error: null }) };
    const core = new HelperCore({ root: store.root, store, channels: new Channels([spy]), settings: () => settings, link: (s, id) => `${BASE}/#/${s}/${id}` });
    const message = core.messages.add({ level, oneLine: "x", text: "x", items });
    await core.deliver(message, { level, title: "Pricing", body: "Stop it?", text: "Stop it?", url: (id) => `${BASE}/#/~messages/${id}`, urgent: true });
    return { m: seen[0], id: message.id };
  }

  test("HelperCore.deliver names the ticket for a one-ticket urgent alert, not for a summary", async () => {
    const urgent = await deliver("urgent", [item("kb", "t_1")]);
    expect(urgent.m.ticket).toEqual({ board: "kb", ticketId: "t_1" });
    expect(tapUrl(urgent.m)).toBe(`${BASE}/#/kb/t_1?read=${urgent.id}`);
    const summary = await deliver("summary", [item("kb", "t_1")]);
    expect(summary.m.ticket).toBeNull();
    expect(tapUrl(summary.m)).toBe(`${BASE}/#/~messages/${summary.id}`);
  });

  test("ntfy Click, phone push and Telegram Open all open the ticket", async () => {
    const { m, id } = await deliver("urgent", [item("kb", "t_1")]);
    const want = `${BASE}/#/kb/t_1?read=${id}`;
    expect((ntfyRequest(settings, m, true).init.headers as Record<string, string>).Click).toBe(want);

    const payloads: any[] = [];
    const push = { send: async (p: any) => (payloads.push(p), { sent: 1, onScreen: 0, removed: 0, error: null }), hasThisMac: () => false } as any;
    await pushChannel({ fetch: async () => new Response(), push }).send(m, settings);
    expect(payloads[0]).toMatchObject({ url: want, messageId: id });

    const calls: any[] = [];
    let tg: TelegramSettings = { on: true, token: "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234", chatId: 5, chatName: null, pairedAt: null };
    const bot = new TelegramBot({
      fetch: async (_u, init) => (calls.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
      settings: () => tg, save: (p) => (tg = { ...tg, ...p }), actions: () => ({ gotIt: () => "", notUrgent: () => "", waiting: () => "" }),
      phoneAccess: () => true, boardUrl: () => `${BASE}/`, autoPoll: false, sleep: async () => {},
    });
    await bot.send(m);
    expect(calls[0].reply_markup.inline_keyboard.at(-1)).toEqual([{ text: "Open", url: want }]);
  });

  test("Telegram without phone access: still no Open link", async () => {
    const { m } = await deliver("urgent", [item("kb", "t_1")]);
    const calls: any[] = [];
    const tg: TelegramSettings = { on: true, token: "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234", chatId: 5, chatName: null, pairedAt: null };
    const bot = new TelegramBot({
      fetch: async (_u, init) => (calls.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))),
      settings: () => tg, save: () => {}, actions: () => ({ gotIt: () => "", notUrgent: () => "", waiting: () => "" }),
      phoneAccess: () => false, boardUrl: () => `${BASE}/`, autoPoll: false, sleep: async () => {},
    });
    await bot.send(m);
    expect(JSON.stringify(calls[0].reply_markup)).not.toContain("Open");
  });
});

describe("marking read from the ticket link", () => {
  test("the web app finds the message to mark read and the ticket address without it", () => {
    expect(readFromHash("#/kb/t_1?read=m_1")).toEqual({ id: "m_1", hash: "#/kb/t_1" });
    expect(readFromHash("#/a%20b/t%2F1?read=m%201")).toEqual({ id: "m 1", hash: "#/a%20b/t%2F1" });
    expect(readFromHash("#/kb/t_1")).toBeNull();
    expect(readFromHash("#/~messages/m_1")).toBeNull();
    expect(readFromHash("#/kb/t_1?read=")).toBeNull();
  });

  test("the read link's message is marked read in the store (the call the web app makes)", () => {
    const store = new Store(tempDir("ck-home-"));
    const core = new HelperCore({ root: store.root, store, channels: new Channels([]), settings: () => normalizeSettings({}), link: () => "" });
    const m = core.messages.add({ level: "urgent", oneLine: "x", text: "x", items: [item("kb", "t_1")] });
    expect(core.messages.unread()).toBe(1);
    const r = readFromHash(tapUrl({ messageId: m.id, url: `${BASE}/`, ticket: tapTicket(m) }).slice(BASE.length + 1))!;
    expect(r.hash).toBe("#/kb/t_1");
    core.messages.markRead(r.id);
    expect(core.messages.get(m.id)?.readAt).not.toBeNull();
    expect(core.messages.unread()).toBe(0);
  });
});
