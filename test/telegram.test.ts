import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { cutBytes, macChannel, messagePageUrl, ntfyRequest, pushChannel, type OutMessage } from "../src/server/helper/channels";
import {
  maskToken, PAIR_TRIES, scrub, TELEGRAM_MAX, TelegramBot, telegramText, type TelegramActions, type TelegramSettings,
} from "../src/server/helper/telegram";
import { createServer } from "../src/server/http";
import { Board } from "../src/server/board";
import { normalizeSettings, Notifier, readNotifySettings, writeNotifySettings } from "../src/server/notify";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { tempDir } from "./helpers";

const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const ME = 555;

interface Call {
  method: string;
  body: any;
}

/** A fake Bot API: answers by method from a script (default ok), records every call. Never touches the network. */
function fakeApi(script: Record<string, (body: any) => any> = {}) {
  const calls: Call[] = [];
  const urls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    const out = script[method]?.(body) ?? { ok: true, result: method === "getMe" ? { username: "my_ck_bot" } : method === "getUpdates" ? [] : true };
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: out.ok ? 200 : out.error_code ?? 400 });
  };
  return { calls, urls, fetch, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

function makeBot(o: { settings?: Partial<TelegramSettings>; script?: Record<string, (b: any) => any>; phone?: boolean; actions?: Partial<TelegramActions>; now?: () => number } = {}) {
  let settings: TelegramSettings = { on: true, token: TOKEN, chatId: null, chatName: null, pairedAt: null, askTyped: true, takeMessages: true, lockedAt: null, ...o.settings } as TelegramSettings;
  const api = fakeApi(o.script);
  const did: string[] = [];
  const sleeps: number[] = [];
  const bot = new TelegramBot({
    fetch: api.fetch, settings: () => settings, save: (p) => (settings = { ...settings, ...p }),
    actions: () => ({
      gotIt: (id) => (did.push(`got:${id}`), "Got it."),
      notUrgent: (id) => (did.push(`not:${id}`), "Stopped reminders for Pricing"),
      waiting: () => "2 tickets wait on you:\n- A\n- B",
      ...o.actions,
    }),
    phoneAccess: () => o.phone ?? false, boardUrl: () => "https://mac.tail.ts.net/", now: o.now, autoPoll: false,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { bot, api, did, sleeps, settings: () => settings };
}

const out = (o: Partial<OutMessage> = {}): OutMessage => ({
  messageId: "m_abc123", level: "urgent", title: "Pricing", body: "Stop the old webhook?", text: "Pricing (Kanban)\n\nStop the old webhook?", url: "https://mac.tail.ts.net/#/kb/t_1", urgent: true, ...o,
});

const msgUpdate = (id: number, chatId: number, text: string, o: { type?: string; date?: number } = {}) => ({
  update_id: id, message: { chat: { id: chatId, type: o.type ?? "private" }, from: { id: chatId, first_name: "Leo", username: "leo" }, date: o.date ?? Math.floor(Date.now() / 1000), text },
});

test("token helpers: masked to its last 4, scrubbed from any text, messages cut to 4096", () => {
  expect(maskToken(TOKEN)).toBe("set …1234");
  expect(maskToken("")).toBe("");
  expect(scrub(`fetch https://api.telegram.org/bot${TOKEN}/getUpdates failed`, TOKEN)).not.toContain(TOKEN);
  expect(scrub(`bot${TOKEN}`, "")).toBe("bot<token>");
  const t = telegramText("x".repeat(5000), "\n\nAnswer on your Mac.");
  expect(t.length).toBe(TELEGRAM_MAX);
  expect(t.endsWith("Answer on your Mac.")).toBe(true);
  expect(Buffer.byteLength(cutBytes("é".repeat(3000), 4000))).toBeLessThanOrEqual(4000);
  expect(messagePageUrl("https://mac.tail.ts.net/#/kb/t_1", "m_1")).toBe("https://mac.tail.ts.net/#/~messages/m_1");
});

describe("pairing", () => {
  test("only the 6-digit code, sent in a private chat after it was shown, pairs; then strangers are ignored", async () => {
    const { bot, api, settings } = makeBot({ settings: { on: false } });
    const { code } = bot.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(bot.state().pairing?.expiresAt).toBeTruthy();
    expect(JSON.stringify(bot.state())).not.toContain(code);
    // A group chat, and a message from before the code was shown (Telegram keeps updates for a day): ignored.
    await bot.handle(msgUpdate(1, -100, code, { type: "group" }));
    await bot.handle(msgUpdate(2, 777, code, { date: Math.floor(Date.now() / 1000) - 3600 }));
    expect(settings().chatId).toBeNull();
    // "hi" from someone: told to send the code, nothing saved.
    await bot.handle(msgUpdate(3, 777, "hi"));
    expect(settings().chatId).toBeNull();
    expect(api.sent().at(-1)!.body.text).toContain("6-digit code");
    await bot.handle(msgUpdate(4, ME, ` ${code.slice(0, 3)} ${code.slice(3)} `));
    expect(settings()).toMatchObject({ chatId: ME, chatName: "Leo (@leo)", on: true });
    const reply = api.sent().at(-1)!.body;
    expect(reply.chat_id).toBe(ME);
    expect(reply.text).toContain("Paired");
    expect(reply.text).toContain("allow Telegram in that Focus");
    expect(bot.state().pairing).toBeNull();
    // The code is used up: a stranger sending it later changes nothing and gets no answer.
    const before = api.calls.length;
    await bot.handle(msgUpdate(5, 777, code));
    await bot.handle(msgUpdate(6, 777, "/waiting"));
    expect(settings().chatId).toBe(ME);
    expect(api.calls.length).toBe(before);
  });

  test("wrong codes stop pairing after a few tries; an expired code pairs nothing", async () => {
    let clock = Date.now();
    const { bot, settings } = makeBot({ now: () => clock });
    const { code } = bot.startPairing();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < PAIR_TRIES; i++) await bot.handle(msgUpdate(i, 777, wrong));
    expect(bot.state().pairing).toBeNull();
    expect(bot.state().pairError).toContain("Too many wrong codes");
    await bot.handle(msgUpdate(99, 777, code));
    expect(settings().chatId).toBeNull();

    const again = bot.startPairing();
    clock += 11 * 60_000;
    expect(bot.state().pairing).toBeNull();
    await bot.handle(msgUpdate(100, ME, again.code));
    expect(settings().chatId).toBeNull();
  });

  test("pairing needs a token; unpair forgets the chat", () => {
    const { bot, settings } = makeBot({ settings: { token: "", chatId: ME } });
    expect(() => bot.startPairing()).toThrow("bot token");
    bot.unpair();
    expect(settings().chatId).toBeNull();
  });
});

describe("receiving", () => {
  test("buttons from the paired chat call the board's handlers; from anyone else they are refused", async () => {
    const { bot, api, did } = makeBot({ settings: { chatId: ME } });
    const cb = (from: number, data: string) => ({ update_id: 1, callback_query: { id: "cq1", from: { id: from }, message: { chat: { id: from } }, data } });
    await bot.handle(cb(ME, "g:m_abc123"));
    await bot.handle(cb(ME, "n:m_abc123"));
    expect(did).toEqual(["got:m_abc123", "not:m_abc123"]);
    const answers = api.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(answers).toEqual(["Got it.", "Stopped reminders for Pricing"]);
    await bot.handle(cb(777, "g:m_abc123"));
    await bot.handle(cb(ME, "g:../../etc"));
    expect(did).toHaveLength(2);
    expect(api.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text).slice(2)).toEqual(["This bot isn't paired with you.", "That button no longer works."]);
  });

  test("/waiting is answered from the summary; other text gets a fixed, silent reply and nothing is kept", async () => {
    const { bot, api } = makeBot({ settings: { chatId: ME } });
    await bot.handle(msgUpdate(1, ME, "/waiting@my_ck_bot"));
    expect(api.sent().at(-1)!.body.text).toBe("2 tickets wait on you:\n- A\n- B");
    await bot.handle(msgUpdate(2, ME, "yes stop the webhook"));
    expect(api.sent().at(-1)!.body.text).toContain("Reply to an alert to answer that ticket. Or answer on your Mac.");
    expect(api.sent().every((c) => c.body.disable_notification === true)).toBe(true);
    const phone = makeBot({ settings: { chatId: ME }, phone: true });
    await phone.bot.handle(msgUpdate(3, ME, "hello"));
    expect(phone.api.sent().at(-1)!.body.text).toContain("https://mac.tail.ts.net/");
    for (const c of [...api.calls, ...phone.api.calls]) expect(c.body.parse_mode).toBeUndefined();
  });

  test("one poll: updates handled in order, offset moves on; a second poller or a webhook is named in plain words", async () => {
    let n = 0;
    const { bot, api } = makeBot({
      settings: { chatId: ME },
      script: {
        getUpdates: () => (n++ === 0 ? { ok: true, result: [msgUpdate(41, ME, "/waiting")] }
          : { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }),
      },
    });
    expect(await bot.pollOnce()).toBe(true);
    expect(bot.state()).toMatchObject({ state: "ok", botName: "@my_ck_bot" });
    expect(api.sent()).toHaveLength(1);
    expect(await bot.pollOnce()).toBe(false);
    expect(api.calls.filter((c) => c.method === "getUpdates").at(-1)!.body.offset).toBe(42);
    const st = bot.state();
    expect(st.state).toBe("error");
    expect(st.error).toContain("Another program is reading this bot's messages");
    expect(st.error).toContain("webhook");
  });

  test("the token never shows in errors or logs, even when fetch names the URL", async () => {
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const { bot } = makeBot({ settings: { chatId: ME }, script: { getMe: () => new Error(`Unable to connect: https://api.telegram.org/bot${TOKEN}/getMe`) } });
      expect(await bot.pollOnce()).toBe(false);
      const r = await makeBot({ settings: { chatId: ME }, script: { sendMessage: () => new Error(`ECONNRESET https://api.telegram.org/bot${TOKEN}/sendMessage`) } }).bot.send(out());
      expect(JSON.stringify(bot.state())).not.toContain(TOKEN);
      expect(r.ok).toBe(false);
      expect(r.error).not.toContain(TOKEN);
      expect(logs.join("\n")).not.toContain(TOKEN);
      expect(logs.join("\n")).toContain("Can't reach Telegram");
    } finally {
      console.warn = warn;
    }
  });
});

describe("sending", () => {
  test("urgent: with sound, Got it / Not urgent buttons, plain text, 'Answer on your Mac' without phone access", async () => {
    const { bot, api } = makeBot({ settings: { chatId: ME } });
    const r = await bot.send(out({ text: "Pricing (Kanban)\n\n" + "y".repeat(5000) }));
    expect(r).toMatchObject({ channel: "telegram", ok: true });
    const b = api.sent()[0].body;
    expect(b.disable_notification).toBe(false);
    expect(b.parse_mode).toBeUndefined();
    expect(b.text.length).toBe(TELEGRAM_MAX);
    expect(b.text.endsWith("Answer on your Mac.")).toBe(true);
    expect(b.reply_markup.inline_keyboard).toEqual([[{ text: "Got it", callback_data: "g:m_abc123" }, { text: "Not urgent", callback_data: "n:m_abc123" }]]);
    for (const row of b.reply_markup.inline_keyboard) for (const k of row) if (k.callback_data) expect(Buffer.byteLength(k.callback_data)).toBeLessThanOrEqual(64);
  });

  test("routine: silent, no reminder buttons; with phone access an Open button to the message page", async () => {
    const { bot, api } = makeBot({ settings: { chatId: ME }, phone: true });
    await bot.send(out({ level: "summary", urgent: false, title: "ckanban", text: "3 tickets wait on you" }));
    const b = api.sent()[0].body;
    expect(b.disable_notification).toBe(true);
    expect(b.text).toBe("ckanban\n\n3 tickets wait on you");
    expect(b.reply_markup.inline_keyboard).toEqual([[{ text: "Open", url: "https://mac.tail.ts.net/#/~messages/m_abc123" }]]);
  });

  test("429: waits retry_after once, then fails so the next channel gets it; not paired is skipped", async () => {
    let n = 0;
    const once = makeBot({ settings: { chatId: ME }, script: { sendMessage: () => (n++ === 0 ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } } : { ok: true, result: {} }) } });
    expect((await once.bot.send(out())).ok).toBe(true);
    expect(once.sleeps).toEqual([3000]);
    const always = makeBot({ settings: { chatId: ME }, script: { sendMessage: () => ({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }) } });
    const r = await always.bot.send(out());
    expect(r.ok).toBe(false);
    expect(always.api.sent()).toHaveLength(2);
    const long = makeBot({ settings: { chatId: ME }, script: { sendMessage: () => ({ ok: false, error_code: 429, parameters: { retry_after: 600 } }) } });
    expect((await long.bot.send(out())).ok).toBe(false);
    expect(long.sleeps).toEqual([]);
    const unpaired = makeBot();
    expect(await unpaired.bot.send(out())).toMatchObject({ ok: false, skipped: true });
    expect(unpaired.api.calls).toHaveLength(0);
  });
});

describe("other channels", () => {
  test("ntfy: full text, Priority 5 when urgent, Click only with phone access, else 'Answer on your Mac'", () => {
    const m = out({ text: "Pricing (Kanban)\n\nStop the old webhook?\n\nWhy: billed twice" });
    const on = ntfyRequest({ webhookUrl: "https://ntfy.sh/t" }, m, true);
    const h = on.init.headers as Record<string, string>;
    expect(h.Priority).toBe("5");
    expect(h.Click).toBe("https://mac.tail.ts.net/#/~messages/m_abc123");
    expect(on.init.body).toBe("Pricing (Kanban)\n\nStop the old webhook?\n\nWhy: billed twice");
    const off = ntfyRequest({ webhookUrl: "https://ntfy.sh/t" }, out({ urgent: false, level: "summary", text: "z".repeat(6000) }), false);
    const h2 = off.init.headers as Record<string, string>;
    expect(h2.Click).toBeUndefined();
    expect(h2.Priority).toBeUndefined();
    expect(Buffer.byteLength(String(off.init.body))).toBeLessThanOrEqual(4000);
    expect(String(off.init.body).endsWith("Answer on your Mac.")).toBe(true);
  });

  test("phone push with no phone fails (so the caller moves on); This Mac's banner points at Messages", async () => {
    const fakePush = { send: async () => ({ sent: 0, removed: 0, onScreen: 0, error: null }), hasThisMac: () => false } as any;
    const r = await pushChannel({ fetch: async () => new Response(""), push: fakePush }).send(out(), normalizeSettings({}));
    expect(r).toMatchObject({ ok: false, empty: true });
    const banners: string[][] = [];
    await macChannel({ fetch: async () => new Response(""), banner: (t, b) => void banners.push([t, b]), push: fakePush }).send(out({ level: "summary", title: "ckanban", body: "3 tickets wait on you" }), normalizeSettings({}));
    expect(banners).toEqual([["ckanban", "3 tickets wait on you · See Messages on the board"]]);
  });
});

describe("Notifier settings", () => {
  let store: Store;
  let notifier: Notifier;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    api = fakeApi();
    notifier = new Notifier(store, new Bus(), {
      root: store.root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "http://localhost:3000", fetch: async () => new Response("ok"), telegramFetch: api.fetch, telegramPoll: false, banner: () => {},
    });
  });
  afterEach(() => notifier.telegram.stop());

  test("notify.json is owner-only and the API state shows the token masked, never whole", () => {
    writeNotifySettings(store.root, normalizeSettings({}));
    const st = notifier.update({ telegram: { token: TOKEN, on: true } });
    expect(statSync(join(store.root, "notify.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(store.root, "notify.json"), "utf8")).toContain(TOKEN);
    expect(JSON.stringify(st)).not.toContain(TOKEN);
    expect(JSON.stringify(notifier.state())).not.toContain(TOKEN);
    expect(st.telegram).toMatchObject({ tokenSet: true, tokenMasked: "set …1234", paired: false, on: true });
    expect(st.channels.map((c) => c.name)).toEqual(["mac", "push", "webhook", "telegram"]);
    expect(st.reachLine).toBe("I can only reach you on this Mac");
    expect(st.ntfyTopicSuggestion).toMatch(/^https:\/\/ntfy\.sh\/ckanban-[A-Za-z0-9]{16}$/);
    expect(st.ntfyWarning).toContain("Anyone who knows the topic name");
    expect(st.focusHint).toContain("allow the ntfy app in that Focus");
    // Sending the state back (as a settings screen might) keeps the token; a bad token is refused without echoing it.
    notifier.update(JSON.parse(JSON.stringify(st)));
    expect(readNotifySettings(store.root).telegram.token).toBe(TOKEN);
    expect(() => notifier.update({ telegram: { token: "my-secret-not-a-token" } })).toThrow(/doesn't look like a bot token/);
    try {
      notifier.update({ telegram: { token: "my-secret-not-a-token" } });
    } catch (e) {
      expect((e as Error).message).not.toContain("my-secret");
    }
  });

  test("the chat comes only from pairing: the API can't set it, and a new token unpairs", async () => {
    notifier.update({ telegram: { token: TOKEN, chatId: 999 } });
    expect(readNotifySettings(store.root).telegram.chatId).toBeNull();
    const { code } = notifier.telegramPair();
    await notifier.telegram.handle(msgUpdate(1, ME, code));
    expect(readNotifySettings(store.root).telegram).toMatchObject({ chatId: ME, on: true });
    expect(statSync(join(store.root, "notify.json")).mode & 0o777).toBe(0o600);
    expect(notifier.state().telegram.paired).toBe(true);
    notifier.update({ telegram: { token: TOKEN.replace("1234", "5678") } });
    expect(readNotifySettings(store.root).telegram.chatId).toBeNull();
  });

  test("Got it from Telegram stops the message's reminders; /waiting lists what waits", async () => {
    const t = store.createTicket("kb", { title: "Pricing", body: "b", status: "review" });
    const rec = notifier.helper.waits.add({ board: "kb", ticketId: t.id, kind: "questions", identity: "q:x", question: "Stop the old webhook?", label: "Answer 1 question", since: new Date().toISOString(), urgent: true, why: null });
    const now = Date.now();
    notifier.helper.waits.update(rec.key, { reminders: [{ channel: "telegram", dueAt: new Date(now + 300_000).toISOString() }] });
    const msg = notifier.helper.messages.add({ level: "urgent", oneLine: "Stop the old webhook?", text: "x", items: [{ key: rec.key, board: "kb", boardName: "Kanban", ticketId: t.id, title: "Pricing", question: "Stop the old webhook?" }] });
    expect(await notifier.helper.waitingText()).toBe("1 ticket waits on you:\n- Pricing (Kanban): Stop the old webhook? [urgent]");
    expect(await notifier.helper.notUrgent(msg.id, "telegram")).toBe("Stopped reminders for Pricing");
    expect(notifier.helper.waits.get(rec.key)!.remindersStopped).toBe("not-urgent");
    expect(notifier.helper.messages.get(msg.id)!.readAt).not.toBeNull();
    expect(await notifier.helper.gotIt("m_gone")).toBe("That message is gone.");
  });
});

test("settings API: token masked; pairing only from the user's browser and its code only in that answer", async () => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "false" });
  const api = fakeApi();
  const notifier = new Notifier(store, bus, {
    root: store.root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => "http://localhost:3000", telegramFetch: api.fetch, telegramPoll: false, banner: () => {},
  });
  let userBrowser = true;
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), notifier, isUserBrowser: async () => userBrowser });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: base }) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    let r = await post("/api/notify/telegram/pair", {});
    expect(r.status).toBe(400);
    r = await post("/api/notify", { telegram: { token: TOKEN, on: true } });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(TOKEN);
    r = await fetch(`${base}/api/notify`);
    const text = await r.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).telegram.tokenMasked).toBe("set …1234");
    // A run's shell (no Origin, no run header) or another program: refused for pairing and the token.
    r = await post("/api/notify/telegram/pair", {}, {});
    expect(r.status).toBe(403);
    r = await post("/api/notify", { telegram: { token: "" } }, {});
    expect(r.status).toBe(403);
    r = await post("/api/notify/telegram/pair", {}, { origin: base, "x-ckanban-run": "kb/t_1" });
    expect(r.status).toBe(403);
    userBrowser = false;
    r = await post("/api/notify/telegram/pair", {});
    expect(r.status).toBe(403);
    r = await post("/api/notify/telegram/unpair", {});
    expect(r.status).toBe(403);
    // Every other setting too: a run's shell can't point the webhook or ntfy at its own address.
    r = await post("/api/notify", { webhookUrl: "https://evil.example/hook" }, {});
    expect(r.status).toBe(403);
    r = await post("/api/notify", { mac: false }, { origin: base, "x-ckanban-run": "kb/t_1" });
    expect(r.status).toBe(403);
    r = await post("/api/notify", { webhookUrl: "https://evil.example/hook" });
    expect(r.status).toBe(403);
    expect(readNotifySettings(store.root).webhookUrl).not.toBe("https://evil.example/hook");
    userBrowser = true;
    r = await post("/api/notify", { mac: false });
    expect(r.status).toBe(200);
    r = await post("/api/notify/telegram/pair", {});
    const pair = (await r.json()) as any;
    expect(pair.code).toMatch(/^\d{6}$/);
    expect(pair.state.telegram.pairing.expiresAt).toBeTruthy();
    expect(JSON.stringify(pair.state)).not.toContain(`"${pair.code}"`);
    expect(await (await fetch(`${base}/api/notify`)).text()).not.toContain(`"${pair.code}"`);
    r = await post("/api/notify/telegram/unpair", {});
    expect(((await r.json()) as any).telegram.paired).toBe(false);
    expect(readNotifySettings(store.root).telegram.token).toBe(TOKEN);
  } finally {
    notifier.telegram.stop();
    server.stop(true);
  }
});

test("phone access can't turn Telegram messages back on or pair; Pause and Unpair still work; this Mac can do all", async () => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "false" });
  const api = fakeApi();
  const HOST = "leos-mbp.tail1234.ts.net";
  const LOGIN = "leo@example.com";
  writeFileSync(join(store.root, "remote.json"), JSON.stringify({ enabled: true, host: HOST, allowedLogin: LOGIN, updatedAt: "" }));
  const paired = (o: { takeMessages: boolean; lockedAt?: string | null; on?: boolean }) => {
    const s = readNotifySettings(store.root);
    writeNotifySettings(store.root, { ...s, telegram: { ...s.telegram, on: o.on ?? true, token: TOKEN, chatId: ME, chatName: "Leo", pairedAt: "x", takeMessages: o.takeMessages, lockedAt: o.lockedAt ?? null } });
  };
  const notifier = new Notifier(store, bus, {
    root: store.root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => "http://localhost:3000", telegramFetch: api.fetch, telegramPoll: false, banner: () => {},
  });
  const server = createServer({ store, bus, board, port: 0, remotePort: 0, webDir: tempDir("ck-web-"), notifier, isUserBrowser: async () => true });
  const base = `http://localhost:${server.port}`;
  const tailnet = `http://127.0.0.1:${server.remoteServer!.port}`;
  const phone = { host: HOST, "tailscale-user-login": LOGIN, origin: `https://${HOST}` };
  const post = (url: string, path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const fromPhone = (path: string, body: unknown) => post(tailnet, path, body, phone);
  const fromMac = (path: string, body: unknown) => post(base, path, body, { origin: base });
  const tg = () => readNotifySettings(store.root).telegram;
  try {
    // Locked from Telegram: the phone can't undo it, by the switch or by turning the channel off and on.
    paired({ takeMessages: false, lockedAt: "2026-11-09T09:00:00.000Z" });
    let r = await fetch(`${tailnet}/api/notify`, { headers: phone });
    expect(((await r.json()) as any).local).toBe(false);
    r = await fromPhone("/api/notify", { telegram: { takeMessages: true } });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("Turn this back on from the Mac.");
    expect(tg()).toMatchObject({ takeMessages: false, lockedAt: "2026-11-09T09:00:00.000Z" });
    paired({ takeMessages: true, on: false });
    r = await fromPhone("/api/notify", { telegram: { on: true } });
    expect(r.status).toBe(403);
    expect(tg().on).toBe(false);
    // Pairing, or a new bot key (the first step of pairing), only from the Mac.
    r = await fromPhone("/api/notify/telegram/pair", {});
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("Pair Telegram from the Mac.");
    r = await fromPhone("/api/notify", { telegram: { token: "987654321:AAHotherOTHERotherOTHERother_9999" } });
    expect(r.status).toBe(403);
    expect(tg().token).toBe(TOKEN);
    // Turning things off from the phone works: Pause, the channel off, Unpair; other settings too.
    paired({ takeMessages: true });
    r = await fromPhone("/api/notify", { telegram: { takeMessages: false } });
    expect(r.status).toBe(200);
    expect(tg().takeMessages).toBe(false);
    r = await fromPhone("/api/notify", { telegram: { askTyped: true }, mac: false });
    expect(r.status).toBe(200);
    r = await fromPhone("/api/notify/telegram/unpair", {});
    expect(r.status).toBe(200);
    expect(tg().chatId).toBe(null);
    // This Mac: pairs, and turns messages back on (which clears the lock).
    r = await fetch(`${base}/api/notify`);
    expect(((await r.json()) as any).local).toBe(true);
    r = await fromMac("/api/notify/telegram/pair", {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).code).toMatch(/^\d{6}$/);
    paired({ takeMessages: false, lockedAt: "2026-11-09T09:00:00.000Z" });
    r = await fromMac("/api/notify", { telegram: { takeMessages: true } });
    expect(r.status).toBe(200);
    expect(tg()).toMatchObject({ takeMessages: true, lockedAt: null });
    // Already on: the phone saving the same value is not a change, so it isn't refused.
    r = await fromPhone("/api/notify", { telegram: { takeMessages: true, on: true } });
    expect(r.status).toBe(200);
  } finally {
    notifier.telegram.stop();
    server.stop(true);
    server.remoteServer?.stop(true);
  }
});

test("a poller stopped during getMe sends no getUpdates (never two pollers on the bot)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { bot, api } = makeBot({ settings: { chatId: ME }, script: {} });
  const orig = (bot as any).d.fetch;
  (bot as any).d.fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/getMe")) await gate;
    return orig(url, init);
  };
  const round = bot.pollOnce();
  bot.stop();
  release();
  await round;
  expect(api.calls.map((c) => c.method)).toEqual(["getMe"]);
  expect(bot.state().botName).toBeNull();
});

test("the read position is saved: after a restart the last batch isn't handled again; another bot starts from 0", async () => {
  const file = join(tempDir("ck-tg-"), "telegram-offset.json");
  const make = (token = TOKEN) => {
    let settings: TelegramSettings = { on: true, token, chatId: ME, chatName: null, pairedAt: null, askTyped: true, takeMessages: true, lockedAt: null };
    const api = fakeApi({ getUpdates: (b) => ({ ok: true, result: b.offset > 41 ? [] : [msgUpdate(41, ME, "/waiting")] }) });
    const bot = new TelegramBot({
      fetch: api.fetch, settings: () => settings, save: (p) => (settings = { ...settings, ...p }),
      actions: () => ({ gotIt: () => "Got it.", notUrgent: () => "Stopped", waiting: () => "Nothing waits on you right now." }),
      phoneAccess: () => false, boardUrl: () => "https://mac.tail.ts.net/", autoPoll: false, offsetFile: file,
    });
    return { bot, api };
  };
  const first = make();
  await first.bot.pollOnce();
  expect(first.api.sent()).toHaveLength(1);
  // Restart: a new bot object reads the saved position.
  const again = make();
  await again.bot.pollOnce();
  expect(again.api.calls.find((c) => c.method === "getUpdates")!.body.offset).toBe(42);
  expect(again.api.sent()).toHaveLength(0);
  const other = make("987654321:AAHotherOTHERotherOTHERother_9999");
  await other.bot.pollOnce();
  expect(other.api.calls.find((c) => c.method === "getUpdates")!.body.offset).toBe(0);
});
