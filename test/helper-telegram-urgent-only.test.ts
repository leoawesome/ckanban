// Telegram gets only urgent alerts, their reminders and the Settings test; every routine message skips it and still
// reaches the other channels that are on (and the Messages page).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { Channels, telegramTakes, type Channel, type OutMessage } from "../src/server/helper/channels";
import { HELPER_SYSTEM } from "../src/server/helper/decide";
import { normalizeSettings, Notifier, writeNotifySettings, type NotifySettings } from "../src/server/notify";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { tempDir } from "./helpers";

const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const ME = 555;

function stub(name: string, sent: string[], takes?: Channel["takes"]): Channel {
  return { name, enabled: () => true, ...(takes ? { takes } : {}), send: async (m) => (sent.push(`${name}:${m.level}`), { channel: name, ok: true, error: null }) };
}

const msg = (o: Partial<OutMessage>): OutMessage => ({ messageId: "m_1", level: "summary", title: "t", body: "b", text: "x", url: "http://localhost:3000/", ...o });

describe("telegramTakes", () => {
  test("urgent sends (alerts, reminder steps, urgent direct sends) and the test; nothing routine", () => {
    expect(telegramTakes({ level: "urgent", urgent: true })).toBe(true);
    expect(telegramTakes({ level: "reminder", urgent: true })).toBe(true);
    expect(telegramTakes({ level: "fallback", urgent: true })).toBe(true);
    expect(telegramTakes({ level: "test" })).toBe(true);
    for (const level of ["summary", "routine", "direct", "fallback", "digest", "pause", "hello", "message", "reminder"] as const) {
      expect(telegramTakes({ level })).toBe(false);
    }
  });

  test("Channels leaves Telegram out of routine sends; a chain that starts on Telegram moves on", async () => {
    const sent: string[] = [];
    const ch = new Channels([stub("mac", sent), stub("push", sent), stub("telegram", sent, telegramTakes)]);
    const s = {} as NotifySettings;
    await ch.sendAll(msg({ level: "summary" }), s);
    expect(sent).toEqual(["mac:summary", "push:summary"]);
    sent.length = 0;
    expect(await ch.sendAll(msg({ level: "summary" }), s, ["telegram"])).toEqual([]);
    await ch.sendAll(msg({ level: "urgent", urgent: true }), s);
    expect(sent).toEqual(["mac:urgent", "push:urgent", "telegram:urgent"]);
  });
});

let clock = Date.parse("2026-11-09T10:00:00Z");
let root: string;
let store: Store;
const live: Notifier[] = [];

beforeEach(() => {
  clock = Date.parse("2026-11-09T10:00:00Z");
  root = tempDir("ck-tgu-");
  store = new Store(root);
  const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
  store.saveProfile(p);
});
afterEach(() => {
  for (const n of live.splice(0)) n.telegram.stop();
});

/** A Notifier with Telegram paired (fake Bot API) and This Mac on; push and ntfy off, so Telegram is the only phone channel. */
function setup() {
  const tg: any[] = [];
  const banners: string[] = [];
  const s = normalizeSettings({}, undefined, false);
  writeNotifySettings(root, { ...s, mac: true, push: false, webhookOn: false, telegram: { on: true, token: TOKEN, chatId: ME, chatName: "Leo", pairedAt: "x", askTyped: true, takeMessages: true, lockedAt: null } });
  const telegramFetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    if (method === "sendMessage") tg.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 1000 + tg.length } : true }), { status: 200 });
  };
  const notifier = new Notifier(store, new Bus(), {
    root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(), baseUrl: () => "http://localhost:3000",
    fetch: async () => new Response("ok"), telegramFetch, telegramPoll: false, banner: (t) => void banners.push(t), now: () => clock, phoneAccess: () => false,
  });
  live.push(notifier);
  return { notifier, tg, banners };
}

function wait(n: Notifier, title: string, urgent = false) {
  const t = store.createTicket("kb", { title, body: "b", status: "review" });
  return n.helper.waits.add({
    board: "kb", ticketId: t.id, kind: "questions", identity: `q:${title}`, question: "Which port?", label: "questions", since: new Date(clock).toISOString(),
    ...(urgent ? { urgent: true } : {}),
  });
}

describe("with Telegram the only phone channel", () => {
  test("a routine direct send and a digest skip Telegram, reach This Mac and stay on the Messages page", async () => {
    const { notifier, tg, banners } = setup();
    const a = wait(notifier, "Alpha");
    await notifier.helper.sendDirect([a.key], "fallback");
    const b = wait(notifier, "Beta");
    await notifier.helper.digest([b], "digest", "x");
    expect(tg).toEqual([]);
    expect(banners).toHaveLength(2);
    const msgs = notifier.helper.messages.listNewest();
    expect(msgs.map((m) => m.level).sort()).toEqual(["digest", "fallback"]);
    for (const m of msgs) expect(m.sends.map((x: { channel: string }) => x.channel)).toEqual(["mac"]);
  });

  test("an urgent direct send goes to Telegram with sound", async () => {
    const { notifier, tg } = setup();
    const a = wait(notifier, "Pricing", true);
    await notifier.helper.sendDirect([a.key], "fallback");
    expect(tg).toHaveLength(1);
    expect(tg[0].disable_notification).toBe(false);
    expect(tg[0].text).toContain("Pricing");
  });

  test("the Settings test still reaches Telegram", async () => {
    const { notifier, tg } = setup();
    const r = await notifier.test();
    expect(r.channels.find((c) => c.channel === "telegram")?.ok).toBe(true);
    expect(tg).toHaveLength(1);
  });
});

test("the helper is told Telegram gets only urgent alerts and their reminders", () => {
  expect(HELPER_SYSTEM).toContain("Telegram gets only urgent alerts and their reminders");
});
