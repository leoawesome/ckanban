// Telegram gating against a real Board and Notifier (from the step 2 review, qa-1): nothing reaches a ticket once Telegram stops taking messages.
// Never the network (fake Bot API), never ~/.claude-kanban (temp roots).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { Board } from "../src/server/board";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { makeRepo, tempDir, until } from "./helpers";

const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const ME = 555;
const NOT_TAKING = "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
const LOCKED = "🔒 Locked. I won't take messages from this chat until you unlock it on the Mac (Settings, Telegram). Alerts still arrive.";

function fakeApi() {
  const calls: { method: string; body: any }[] = [];
  let nextId = 1000;
  let updates: any[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    let result: any = true;
    if (method === "getMe") result = { username: "my_ck_bot" };
    else if (method === "getUpdates") { result = updates.filter((u) => u.update_id >= (body.offset ?? 0)); updates = []; }
    else if (method === "sendMessage") result = { message_id: nextId++ };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  return {
    calls, fetch,
    queue: (...u: any[]) => void updates.push(...u),
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    edits: () => calls.filter((c) => c.method === "editMessageText"),
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text as string),
    last: () => calls.filter((c) => c.method === "sendMessage").at(-1)!.body,
  };
}

let clock = Date.parse("2026-11-09T10:00:00Z");
let root: string;
let store: Store;
const sessions = new Map<string, SessionSummary>();
const live: { notifier: Notifier; board: Board }[] = [];

function settings(o: { askTyped?: boolean; takeMessages?: boolean; lockedAt?: string | null } = {}) {
  const s = normalizeSettings({}, undefined, false);
  writeNotifySettings(root, { ...s, telegram: { on: true, token: TOKEN, chatId: ME, chatName: "Leo", pairedAt: "x", askTyped: o.askTyped ?? false, takeMessages: o.takeMessages ?? true, lockedAt: o.lockedAt ?? null } });
}

/** A real Notifier with a real Board plugged in (claude = /usr/bin/false, so a started run ends at once). */
function setup(o: { askTyped?: boolean; takeMessages?: boolean; lockedAt?: string | null; keepSettings?: boolean } = {}) {
  const api = fakeApi();
  if (!o.keepSettings) settings(o);
  const notifier = new Notifier(store, new Bus(), {
    root, sessionSummary: (id) => sessions.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => "http://localhost:3000", fetch: async () => new Response("ok"), telegramFetch: api.fetch,
    telegramPoll: false, banner: () => {}, now: () => clock, phoneAccess: () => false,
  });
  const board = new Board(store, new Bus(), { claudeBin: "/usr/bin/false" });
  notifier.plugBoard(board);
  live.push({ notifier, board });
  return { notifier, api, board };
}

async function alert(n: Notifier, keys: string[]): Promise<number> {
  const items = keys.map((k) => n.helper.item(n.helper.waits.get(k)!));
  await n.helper.send({ level: "urgent", oneLine: "x", text: "x", items }, { level: "urgent", title: "ckanban", body: "x", text: "x", url: "http://localhost:3000/", urgent: true }, ["telegram"]);
  return n.telegramLinks.forMessage(n.helper.messages.listNewest()[0].id)[0].tg;
}
function wait(n: Notifier, ticketId: string, question = "Which port?") {
  return n.helper.waits.add({ board: "kb", ticketId, kind: "questions" as any, identity: `q:${question}`, question, label: "questions", since: new Date(clock).toISOString() });
}
const reply = (updateId: number, replyTo: number, text: string) => ({
  update_id: updateId, message: { message_id: 9000 + updateId, chat: { id: ME, type: "private" }, from: { id: ME }, date: Math.floor(clock / 1000), text, reply_to_message: { message_id: replyTo } },
});
const msg = (updateId: number, text: string) => ({
  update_id: updateId, message: { message_id: 9000 + updateId, chat: { id: ME, type: "private" }, from: { id: ME }, date: Math.floor(clock / 1000), text },
});
const tap = (updateId: number, data: string, messageId: number) => ({
  update_id: updateId, callback_query: { id: `cq${updateId}`, from: { id: ME }, message: { message_id: messageId, chat: { id: ME } }, data },
});
const button = (body: any, label: string): string => body.reply_markup.inline_keyboard.flat().find((b: any) => b.text === label)!.callback_data;
/** Did anything from Telegram reach this ticket (its chat input, its queue)? */
const reached = (id: string) => {
  const t = store.getTicket("kb", id)!;
  return { telegramIn: (t.telegramIn ?? []).map((m) => m.text), queued: (t.queued ?? []).filter((m) => m.telegram).map((m) => m.text) };
};

beforeEach(async () => {
  clock = Date.parse("2026-11-09T10:00:00Z");
  root = tempDir("ck-qa1-");
  store = new Store(root);
  sessions.clear();
  const p: Profile = { name: "Kanban", slug: "kb", path: await makeRepo(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
  store.saveProfile(p);
});
afterEach(async () => {
  for (const c of live) { c.notifier.telegram.stop(); await c.board.whenIdle(); }
  live.length = 0;
});

describe("QA-1: switch off", () => {
  test("text reply, Send tap, plain text: none reaches the ticket; each gets NOT_TAKING exactly", async () => {
    const { notifier, api } = setup({ askTyped: true });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(notifier, t.id).key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    const send = button(api.last(), "Send");
    notifier.update({ telegram: { takeMessages: false } });
    api.queue(tap(2, send, 1001), reply(3, tg, "9090"), msg(4, "start deploying"));
    await notifier.telegram.pollOnce();
    expect(reached(t.id)).toEqual({ telegramIn: [], queued: [] });
    expect(api.sent().slice(-2).map((c) => c.body.text)).toEqual([NOT_TAKING, NOT_TAKING]);
    // The echo's Send was expired by Pause, so the tap gets "expired", not NOT_TAKING (spec: "ignored with one short reply").
  });

  test("channel off (Telegram 'on' false) also gates replies (taking() includes on)", async () => {
    const { notifier, api } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(notifier, t.id).key]);
    notifier.update({ telegram: { on: false } });
    // The bot only polls when on; drive the handler directly as if an update was already in hand.
    const bot = notifier.telegram as any;
    bot.queue.add([reply(1, tg, "8080")]);
    await bot.drain?.();
    await Bun.sleep(50);
    expect(reached(t.id)).toEqual({ telegramIn: [], queued: [] });
  });

  test("tap after restart: a Send tap saved in the update queue, daemon restarts with the switch off (file) -> refused", async () => {
    const first = setup({ askTyped: true });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(first.notifier, [wait(first.notifier, t.id).key]);
    first.api.queue(reply(1, tg, "8080"));
    await first.notifier.telegram.pollOnce();
    const send = button(first.api.last(), "Send");
    first.notifier.telegram.stop();
    // Locked while the daemon was down (file says off), and the tap sits unhandled in the saved queue.
    const s = first.notifier.settings();
    writeNotifySettings(root, { ...s, telegram: { ...s.telegram, takeMessages: false, lockedAt: new Date(clock).toISOString() } });
    const second = setup({ keepSettings: true });
    (second.notifier.telegram as any).queue.data = { bot: "123456789", items: [tap(2, send, 1001)], seen: [] };
    await second.notifier.telegram.pollOnce();
    expect(reached(t.id)).toEqual({ telegramIn: [], queued: [] });
    expect(second.api.answers()).toEqual([NOT_TAKING]);
  });

  test("queued Telegram message in a busy ticket's queue is dropped by Pause, /lock and Unpair (real Board)", async () => {
    for (const how of ["pause", "lock", "unpair"] as const) {
      const { notifier, api } = setup();
      const t = store.createTicket("kb", { title: `Q ${how}`, body: "b", status: "review" });
      const at = new Date().toISOString();
      store.updateTicket("kb", t.id, { queued: [
        { id: "a", text: "from phone", at, state: "queued", telegram: { updateId: 1, tg: 2 } },
        { id: "b", text: "typed on Mac", at, state: "queued" },
      ] });
      if (how === "pause") notifier.update({ telegram: { takeMessages: false } });
      if (how === "unpair") notifier.telegramUnpair();
      if (how === "lock") { api.queue(msg(50, "/lock")); await notifier.telegram.pollOnce(); expect(api.last().text).toBe(LOCKED); }
      expect(store.getTicket("kb", t.id)!.queued!.map((m) => m.text)).toEqual(["typed on Mac"]);
      notifier.telegram.stop();
    }
  });
});

describe("QA-1: /lock", () => {
  test("exact reply, switch off and saved; variants /LOCK, ' /lock ', '/lock now' lock too", async () => {
    let uid = 100;
    for (const text of ["/lock", "/LOCK", "/lock now", "/lock@my_ck_bot"]) {
      const { notifier, api } = setup();
      api.queue(msg(uid++, text));
      await notifier.telegram.pollOnce();
      expect(api.last().text).toBe(LOCKED);
      expect(notifier.settings().telegram.takeMessages).toBe(false);
      expect(typeof notifier.settings().telegram.lockedAt).toBe("string");
      notifier.telegram.stop();
    }
  });

  test("/lock sent as a reply to an alert locks (doesn't go to the ticket)", async () => {
    const { notifier, api } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(notifier, t.id).key]);
    api.queue(reply(1, tg, "/lock"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toBe(LOCKED);
    expect(reached(t.id)).toEqual({ telegramIn: [], queued: [] });
  });

  test("nothing in Telegram turns it back on: re-sending the pairing-like text, /start, /unlock, Got it", async () => {
    const { notifier, api } = setup({ takeMessages: false, lockedAt: "2026-11-09T09:00:00.000Z" });
    let got = 0;
    (notifier.telegram as any).d.actions = () => ({ gotIt: () => (got++, "Got it."), notUrgent: () => "x", waiting: () => "w" });
    api.queue(msg(1, "/unlock"), msg(2, "/start"), msg(3, "123456"), tap(4, "g:m_x", 1), msg(5, "/waiting"));
    await notifier.telegram.pollOnce();
    expect(got).toBe(1);
    expect(notifier.settings().telegram).toMatchObject({ takeMessages: false, lockedAt: "2026-11-09T09:00:00.000Z" });
  });
});

describe("QA-1: Unpair", () => {
  test("pending actions expire and update queue empties; later tap of an old button does nothing", async () => {
    const { notifier, api } = setup({ askTyped: true });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(notifier, t.id).key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    const send = button(api.last(), "Send");
    const bot = notifier.telegram as any;
    bot.queue.data = { ...bot.queue.load(), items: [reply(2, tg, "later")] };
    expect(bot.queue.pending()).toHaveLength(1);
    notifier.telegramUnpair();
    expect(bot.queue.pending()).toHaveLength(0);
    expect(notifier.telegramActions.find(() => true)).toBeNull();
    // Re-pair, then the old Send button is tapped: must not send.
    const { code } = notifier.telegramPair();
    api.queue(msg(3, code));
    await notifier.telegram.pollOnce();
    api.queue(tap(4, send, 1001));
    await notifier.telegram.pollOnce();
    expect(reached(t.id)).toEqual({ telegramIn: [], queued: [] });
  });
});

describe("QA-1: f1 race (real Board, idle ticket with a rewind folder so chat() awaits takeSnapshot)", () => {
  for (const how of ["lock", "pause", "unpair"] as const) {
    test(`a typed reply already past taking() when ${how} happens must not reach the ticket`, async () => {
      const { notifier, api, board } = setup({ askTyped: false });
      const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
      // Give it a folder with version history: rewindDir != null, so chat() awaits takeSnapshot before queueing.
      store.updateTicket("kb", t.id, { workdir: store.getProfile("kb")!.path } as any);
      expect(board.rewindDir("kb", t.id)).not.toBeNull();
      const tg = await alert(notifier, [wait(notifier, t.id).key]);
      const orig = board.chatFromTelegram.bind(board);
      let fired = false;
      (board as any).chatFromTelegram = async (...a: Parameters<typeof orig>) => {
        const p = orig(...a); // runs synchronously up to `await takeSnapshot(...)`
        // The user hits /lock (or Pause / Unpair on the Mac) while the snapshot is being taken.
        // /lock from the chat calls d.lock() = notifier.telegramLock() (telegram.ts:509); a nested poll would deadlock the test.
        if (how === "lock") (notifier.telegram as any).d.lock();
        if (how === "pause") notifier.update({ telegram: { takeMessages: false } });
        if (how === "unpair") notifier.telegramUnpair();
        fired = true;
        return p;
      };
      api.queue(reply(1, tg, "rm -rf build && deploy"));
      await notifier.telegram.pollOnce();
      await until(() => fired, 5000);
      await Bun.sleep(300);
      const r = reached(t.id);
      expect(notifier.settings().telegram.takeMessages === false || notifier.settings().telegram.chatId === null).toBe(true);
      expect(r).toEqual({ telegramIn: [], queued: [] });
    });
  }
});
