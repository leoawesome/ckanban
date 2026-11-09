import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { Board } from "../src/server/board";
import { reportParts } from "../src/server/helper/tgreply";
import { ACTION_TTL_MS, PendingActions, UpdateQueue } from "../src/server/helper/tgstores";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { tempDir } from "./helpers";

const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const ME = 555;

interface Call {
  method: string;
  body: any;
}

/** A fake Bot API: every sendMessage gets a fresh message_id; getUpdates hands out what the test queued. Never the network. */
function fakeApi() {
  const calls: Call[] = [];
  let nextId = 1000;
  let updates: any[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    let result: any = true;
    if (method === "getMe") result = { username: "my_ck_bot" };
    else if (method === "getUpdates") {
      result = updates.filter((u) => u.update_id >= (body.offset ?? 0));
      updates = [];
    } else if (method === "sendMessage") result = { message_id: nextId++ };
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

/** Board.chatFromTelegram's bookkeeping, without starting Claude. hang: stop (as if the daemon died) before or after sending. */
function fakeBoard(store: Store) {
  const sent: { slug: string; id: string; text: string; updateId: number; key: string | null | undefined }[] = [];
  const o = {
    sent, hang: null as null | "before" | "after", called: 0,
    async chatFromTelegram(slug: string, id: string, text: string, from: { updateId: number; tg: number; chatId: number; key?: string | null }) {
      o.called++;
      const t = store.getTicket(slug, id)!;
      if (t.telegramIn?.some((m) => m.updateId === from.updateId)) return false;
      if (o.hang === "before") await new Promise(() => {});
      sent.push({ slug, id, text, updateId: from.updateId, key: from.key });
      const at = new Date().toISOString();
      store.updateTicket(slug, id, {
        telegramIn: [...(t.telegramIn ?? []), { updateId: from.updateId, tg: from.tg, chatId: from.chatId, at, text, key: from.key ?? null }],
        telegramReport: { tg: from.tg, chatId: from.chatId, at },
      });
      if (o.hang === "after") await new Promise(() => {});
      return true;
    },
    patchTelegram: (slug: string, id: string, p: any) => store.updateTicket(slug, id, p),
  };
  return o;
}

let clock = Date.parse("2026-11-09T10:00:00Z");
let root: string;
let store: Store;
const sessions = new Map<string, SessionSummary>();

function makeNotifier(o: { askTyped?: boolean; phone?: boolean } = {}) {
  const api = fakeApi();
  const s = normalizeSettings({}, undefined, false);
  writeNotifySettings(root, { ...s, telegram: { on: true, token: TOKEN, chatId: ME, chatName: "Leo", pairedAt: "x", askTyped: o.askTyped ?? true } });
  const notifier = new Notifier(store, new Bus(), {
    root, sessionSummary: (id) => sessions.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => (o.phone ? "https://mac.tail.ts.net" : "http://localhost:3000"), fetch: async () => new Response("ok"), telegramFetch: api.fetch,
    telegramPoll: false, banner: () => {}, now: () => clock, phoneAccess: () => !!o.phone,
  });
  const board = fakeBoard(store);
  notifier.plugBoard(board);
  return { notifier, api, board };
}

/** Sends an alert about these waits to Telegram (through the helper core, so the message map is filled as in real use). */
async function alert(n: Notifier, keys: string[], level: "urgent" | "summary" | "routine" = "urgent"): Promise<number> {
  const items = keys.map((k) => n.helper.item(n.helper.waits.get(k)!));
  await n.helper.send({ level, oneLine: "x", text: "x", items }, { level, title: "ckanban", body: "x", text: "x", url: "http://localhost:3000/", urgent: level === "urgent" }, ["telegram"]);
  return n.telegramLinks.forMessage(n.helper.messages.listNewest()[0].id)[0].tg;
}

const reply = (updateId: number, replyTo: number, text: string) => ({
  update_id: updateId, message: { message_id: 9000 + updateId, chat: { id: ME, type: "private" }, from: { id: ME }, date: Math.floor(clock / 1000), text, reply_to_message: { message_id: replyTo } },
});
const tap = (updateId: number, data: string, messageId: number) => ({
  update_id: updateId, callback_query: { id: `cq${updateId}`, from: { id: ME }, message: { message_id: messageId, chat: { id: ME } }, data },
});
/** The callback_data of the last message's button with this label. */
const button = (body: any, label: string): string => body.reply_markup.inline_keyboard.flat().find((b: any) => b.text === label)!.callback_data;

/** Opens a wait record on the current notifier. */
function wait(ticketId: string, kind: string, question = "Which port?", board = "kb") {
  return (current.at(-1)!.notifier).helper.waits.add({
    board, ticketId, kind: kind as any, identity: kind === "questions" ? `q:${question}` : kind, question, label: kind, since: new Date(clock).toISOString(),
  });
}

beforeEach(() => {
  clock = Date.parse("2026-11-09T10:00:00Z");
  root = tempDir("ck-tgr-");
  store = new Store(root);
  sessions.clear();
  for (const [slug, name] of [["kb", "Kanban"], ["shop", "Shop"]]) {
    const p: Profile = { name, slug, path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
  }
});

let current: ReturnType<typeof makeNotifier>[] = [];
afterEach(() => {
  for (const c of current) c.notifier.telegram.stop();
  current = [];
});
function setup(o: Parameters<typeof makeNotifier>[0] = {}) {
  const c = makeNotifier(o);
  current.push(c);
  return c;
}

/** Every message the bot itself sends (replies, echoes, confirmations, report backs) is silent. */
function allSilentExceptUrgent(api: ReturnType<typeof fakeApi>) {
  for (const c of api.sent()) if (!c.body.reply_markup?.inline_keyboard?.flat().some((b: any) => /^[gn]:/.test(b.callback_data ?? ""))) expect(c.body.disable_notification).toBe(true);
}

describe("a reply to an alert", () => {
  test("answers the current question: echo with Send/Cancel, Send puts it in that ticket's chat once; a second tap does nothing", async () => {
    const { notifier, api, board } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const rec = wait(t.id, "questions");
    const tg = await alert(notifier, [rec.key]);
    api.queue(reply(1, tg, "port 8080"));
    await notifier.telegram.pollOnce();
    const echo = api.last();
    expect(echo.text).toBe('Send this to "Deploy" (Kanban)?\n\n"port 8080"');
    expect(echo.reply_parameters.message_id).toBe(9001);
    expect(board.sent).toHaveLength(0);
    const send = button(echo, "Send");
    expect(Buffer.byteLength(send)).toBeLessThanOrEqual(64);
    const echoId = api.sent().length + 999;
    api.queue(tap(2, send, echoId));
    await notifier.telegram.pollOnce();
    expect(board.sent).toEqual([{ slug: "kb", id: t.id, text: "port 8080", updateId: 1, key: rec.key }]);
    expect(api.edits().at(-1)!.body.text).toBe("✓ Sent to \"Deploy\". I'll reply here when it has news.");
    expect(api.edits().at(-1)!.body.reply_markup.inline_keyboard).toEqual([]);
    // Single use: the same tap again (double tap, or Telegram sending it twice) sends nothing more.
    api.queue(tap(3, send, echoId));
    await notifier.telegram.pollOnce();
    expect(board.sent).toHaveLength(1);
    expect(api.answers()).toEqual(["Sent", "This button was already used."]);
    allSilentExceptUrgent(api);
  });

  test("with 'Ask before sending typed answers' off, an answer goes straight in", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["8080"]);
    expect(api.last().text).toContain('✓ Sent to "Deploy"');
    expect(api.last().disable_notification).toBe(true);
  });

  test("steering a ticket in Review (or failed) needs Confirm naming the board, the ticket and the first line", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("shop", { title: "Checkout", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "review", "Ready for review", "shop").key]);
    api.queue(reply(1, tg, "also fix the footer\nand the header"));
    await notifier.telegram.pollOnce();
    const card = api.last();
    expect(card.text).toBe('Confirm: send this to "Checkout" (Shop)?\nIt is in Review: this starts it working again.\n\n"also fix the footer"');
    expect(board.sent).toHaveLength(0);
    api.queue(tap(2, button(card, "Confirm"), 1001));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["also fix the footer\nand the header"]);
    // Cancel works once too.
    const f = store.createTicket("shop", { title: "Search", body: "b", status: "review" });
    store.updateTicket("shop", f.id, { outcome: "failed" });
    const tg2 = await alert(notifier, [wait(f.id, "failed", "Failed", "shop").key]);
    api.queue(reply(3, tg2, "try again"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain("Its run failed: this starts it again.");
    api.queue(tap(4, button(api.last(), "Cancel"), 1003));
    await notifier.telegram.pollOnce();
    expect(api.edits().at(-1)!.body.text).toBe("Cancelled. Nothing was sent.");
    expect(board.sent).toHaveLength(1);
  });

  test("a usage limit, a proposal or a huddle: 'This needs the board.', nothing sent (Open only with an https link)", async () => {
    const { notifier, api, board } = setup({ phone: true });
    for (const kind of ["limit", "proposal", "huddle"]) {
      const t = store.createTicket("kb", { title: `T ${kind}`, body: "b", status: "review" });
      const tg = await alert(notifier, [wait(t.id, kind).key]);
      api.queue(reply(api.calls.length + 100, tg, "yes"));
      await notifier.telegram.pollOnce();
      expect(api.last().text).toBe("This needs the board.");
      expect(api.last().reply_markup.inline_keyboard).toEqual([[{ text: "Open", url: `https://mac.tail.ts.net/#/kb/${t.id}` }]]);
    }
    expect(board.sent).toHaveLength(0);
  });

  test("a form with several questions is answered on the board for now; a single question passes", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Form", body: "b", status: "review" });
    store.updateTicket("kb", t.id, { sessionId: "s1" });
    const q = (question: string) => ({ question, options: [{ label: "a" }, { label: "b" }], multiSelect: false });
    sessions.set("s1", { openForm: [q("One?"), q("Two?")] } as any);
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "a"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toBe("This question has a form; answer it on the board for now.");
    sessions.set("s1", { openForm: [q("One?")] } as any);
    api.queue(reply(2, tg, "b please"));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["b please"]);
  });

  test("a summary about several tickets asks which one, one button per ticket naming its board", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const a = store.createTicket("kb", { title: "Alpha", body: "b", status: "review" });
    const b = store.createTicket("shop", { title: "Beta", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(a.id, "questions").key, wait(b.id, "questions", "Which colour?", "shop").key], "summary");
    api.queue(reply(1, tg, "blue"));
    await notifier.telegram.pollOnce();
    const card = api.last();
    expect(card.text).toContain("Which one");
    expect(card.reply_markup.inline_keyboard.map((r: any) => r[0].text)).toEqual(["Alpha (Kanban)", "Beta (Shop)", "Cancel"]);
    api.queue(tap(2, button(card, "Beta (Shop)"), 1001));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => [s.slug, s.id, s.text])).toEqual([["shop", b.id, "blue"]]);
  });
});

describe("old replies", () => {
  test("an answered question: says so, quoting the answer; Send anyway goes through Confirm", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const rec = wait(t.id, "questions");
    const tg = await alert(notifier, [rec.key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    notifier.helper.waits.close([rec.key], "answered");
    store.updateTicket("kb", t.id, { status: "review" });
    api.queue(reply(2, tg, "actually 9090"));
    await notifier.telegram.pollOnce();
    const card = api.last();
    expect(card.text).toBe('"Deploy" (Kanban): that question was already answered. You answered: "8080"\n\nI didn\'t send this.');
    expect(board.sent).toHaveLength(1);
    api.queue(tap(3, button(card, "Send anyway"), 1002));
    await notifier.telegram.pollOnce();
    const confirm = api.edits().at(-1)!.body;
    expect(confirm.text).toContain('Confirm: send this to "Deploy" (Kanban)?');
    api.queue(tap(4, button(confirm, "Confirm"), 1002));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["8080", "actually 9090"]);
  });

  test("refused after a day, or when the ticket is done or deleted", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    clock += 25 * 3600_000;
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain("more than a day old");
    clock -= 25 * 3600_000;
    store.updateTicket("kb", t.id, { status: "done" });
    api.queue(reply(2, tg, "8080"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toBe('"Deploy" (Kanban) is done, so I didn\'t send this. Open it on the board to pick it up again.');
    store.deleteTicket("kb", t.id);
    api.queue(reply(3, tg, "8080"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain("deleted or moved to another board");
    expect(board.sent).toHaveLength(0);
  });
});

describe("buttons", () => {
  test("expire after about 10 minutes and check the state again before acting", async () => {
    const { notifier, api, board } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const rec = wait(t.id, "questions");
    const tg = await alert(notifier, [rec.key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    const late = button(api.last(), "Send");
    clock += ACTION_TTL_MS + 1000;
    api.queue(tap(2, late, 1001));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("This button expired.");
    expect(board.sent).toHaveLength(0);
    // Fresh echo, but the question is answered on the board before the tap: nothing is sent.
    api.queue(reply(3, tg, "8081"));
    await notifier.telegram.pollOnce();
    const send = button(api.last(), "Send");
    notifier.helper.waits.close([rec.key], "answered");
    api.queue(tap(4, send, 1002));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("Not sent");
    expect(api.edits().at(-1)!.body.text).toContain("answered or changed meanwhile");
    expect(board.sent).toHaveLength(0);
    // A tap that isn't ours, or from someone else: answered too (the phone never spins).
    api.queue(tap(5, "p:zzzzzzzzzz:y", 1002));
    api.queue({ update_id: 6, callback_query: { id: "cq6", from: { id: 777 }, message: { message_id: 1, chat: { id: 777 } }, data: send } });
    await notifier.telegram.pollOnce();
    expect(api.answers().slice(-2).sort()).toEqual(["This bot isn't paired with you.", "This button was already used."]);
  });

  test("pending actions: short ids, single use, expiry, kept across a restart", () => {
    const dir = tempDir("ck-pa-");
    let now = 1_000_000;
    const a = new PendingActions(dir, () => now);
    const x = a.create("send", { n: 1 });
    expect(x.id).toMatch(/^[a-z0-9]{10}$/);
    const again = new PendingActions(dir, () => now);
    expect("action" in again.take(x.id)).toBe(true);
    expect(new PendingActions(dir, () => now).take(x.id)).toEqual({ gone: "unknown" });
    const y = a.create("send", { n: 2 });
    now += ACTION_TTL_MS + 1;
    expect(new PendingActions(dir, () => now).take(y.id)).toEqual({ gone: "expired" });
  });
});

describe("restarts", () => {
  test("no drop: a reply saved but not handled before a restart is handled after it, once", async () => {
    const first = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(first.notifier, [wait(t.id, "questions").key]);
    first.board.hang = "before";
    first.api.queue(reply(41, tg, "8080"));
    void first.notifier.telegram.pollOnce();
    for (let i = 0; i < 50 && !first.board.called; i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.board.called).toBe(1);
    expect(first.board.sent).toHaveLength(0);
    // The daemon dies here. After the restart the read position has moved on, but the reply is in the saved queue.
    first.notifier.telegram.stop();
    const second = setup({ askTyped: false });
    await second.notifier.telegram.pollOnce();
    expect(second.api.calls.find((c) => c.method === "getUpdates")!.body.offset).toBe(42);
    expect(second.board.sent.map((s) => [s.text, s.updateId])).toEqual([["8080", 41]]);
    await second.notifier.telegram.pollOnce();
    expect(second.board.sent).toHaveLength(1);
  });

  test("no double: a reply sent just before a restart (not yet marked handled) isn't sent again", async () => {
    const first = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(first.notifier, [wait(t.id, "questions").key]);
    first.board.hang = "after";
    first.api.queue(reply(41, tg, "8080"));
    void first.notifier.telegram.pollOnce();
    for (let i = 0; i < 50 && !first.board.sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.board.sent).toHaveLength(1);
    first.notifier.telegram.stop();
    const second = setup({ askTyped: false });
    // Telegram hands the same update out again too (as if the position had not been saved).
    second.api.queue(reply(41, tg, "8080"));
    await second.notifier.telegram.pollOnce();
    expect(second.board.sent).toHaveLength(0);
    expect(store.getTicket("kb", t.id)!.telegramIn).toHaveLength(1);
    expect(second.api.sent()).toHaveLength(0);
  });

  test("an echo shown before a restart isn't shown again; the queue skips update ids already handled", async () => {
    const first = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(first.notifier, [wait(t.id, "questions").key]);
    // The echo went out but the daemon died before the update was marked handled.
    first.api.queue(reply(41, tg, "8080"));
    await first.notifier.telegram.pollOnce();
    const q = new UpdateQueue(root, () => "123456789");
    q.add([reply(41, tg, "8080")]);
    expect(q.pending()).toHaveLength(0);
    const echoes = first.api.sent().length;
    const second = setup();
    (second.notifier.telegram as any).queue.data = { bot: "123456789", items: [reply(41, tg, "8080")], seen: [] };
    await second.notifier.telegram.pollOnce();
    expect(second.api.sent()).toHaveLength(0);
    expect(echoes).toBe(2);
  });

  test("a slow reply doesn't hold a button tap", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    board.hang = "before";
    let got = 0;
    const actions = (notifier.telegram as any).d;
    actions.actions = () => ({ gotIt: () => (got++, "Got it."), notUrgent: () => "x", waiting: () => "x" });
    const bot = notifier.telegram as any;
    bot.queue.add([reply(1, tg, "slow"), tap(2, "g:m_abc", 1)]);
    bot.drain();
    for (let i = 0; i < 50 && !api.answers().length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(got).toBe(1);
    expect(board.sent).toHaveLength(0);
    expect(api.answers()).toEqual(["Got it."]);
  });
});

describe("report back", () => {
  test("the ticket's next reply goes back as an answer to the user's message, silent, split at line breaks; marked sent", async () => {
    const { notifier, api } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    await notifier.turnEnded("kb", t.id, "Done: it runs on 8080.\nCKANBAN_RESULT: {\"status\":\"done\"}");
    const back = api.last();
    expect(back.text).toBe("Deploy (Kanban):\n\nDone: it runs on 8080.");
    expect(back.reply_parameters.message_id).toBe(9001);
    expect(back.disable_notification).toBe(true);
    const after = store.getTicket("kb", t.id)!;
    expect(after.telegramReport).toBeNull();
    expect(after.telegramOut?.map((o) => o.text)).toEqual(["Done: it runs on 8080."]);
    // One reply per message: the next turn sends nothing.
    const n = api.sent().length;
    await notifier.turnEnded("kb", t.id, "more");
    expect(api.sent()).toHaveLength(n);
    // A reply to that report goes to the same ticket (its question is answered now, so it is steering).
    notifier.helper.waits.close(notifier.helper.waits.openFor("kb", t.id).map((w) => w.key), "answered");
    const reportTg = 1000 + n - 1;
    api.queue(reply(2, reportTg, "thanks, now 9090"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain('Confirm: send this to "Deploy" (Kanban)?');
  });

  test("long replies are split at line breaks under 4096 characters, at most 3 parts", () => {
    const line = "x".repeat(1000);
    const parts = reportParts("T (B):", Array(15).fill(line).join("\n"));
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.length).toBeLessThan(4096);
    expect(parts[0].startsWith("T (B):\n\nxxx")).toBe(true);
    expect(parts[2]).toContain("read the rest on the board");
    expect(reportParts("T", "CKANBAN_RESULT: {}")).toEqual([]);
  });
});

test("Board.chatFromTelegram: the message carries its update, so the same update is never sent twice", async () => {
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "false" });
  const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
  expect(await board.chatFromTelegram("kb", t.id, "8080", { updateId: 7, tg: 70, chatId: ME, key: "k" })).toBe(true);
  const after = store.getTicket("kb", t.id)!;
  expect(after.telegramIn?.map((m) => [m.updateId, m.text, m.key])).toEqual([[7, "8080", "k"]]);
  expect(after.telegramReport).toMatchObject({ tg: 70, chatId: ME });
  expect(await board.chatFromTelegram("kb", t.id, "8080", { updateId: 7, tg: 70, chatId: ME })).toBe(false);
  await board.whenIdle();
});

test("the board chat marks messages that came from Telegram and replies sent back there", async () => {
  const { telegramMarks } = await import("../web/src/chatTurns");
  const e = (uuid: string, at: string, role: string, text: string) => ({ uuid, at, role, kind: "text", text });
  const entries = [
    e("u1", "2026-11-09T10:00:00Z", "user", "8080"),
    e("a1", "2026-11-09T10:00:05Z", "assistant", "Done: it runs on 8080.\n\nMore details"),
    e("u2", "2026-11-09T10:05:00Z", "user", "8080"),
    e("a2", "2026-11-09T10:05:05Z", "assistant", "Typed on the board, not mirrored."),
  ];
  const m = telegramMarks(entries, [{ at: "2026-11-09T10:04:59Z", text: "8080" }], [{ at: "2026-11-09T10:01:00Z", text: "Done: it runs on 8080. More" }]);
  expect([...m.in]).toEqual(["u2"]);
  expect([...m.out]).toEqual(["a1"]);
});

describe("review fixes", () => {
  test("f1: a Send tap cut off by a restart is finished when it is replayed, once", async () => {
    const first = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(first.notifier, [wait(t.id, "questions").key]);
    first.api.queue(reply(1, tg, "8080"));
    await first.notifier.telegram.pollOnce();
    const send = button(first.api.last(), "Send");
    first.board.hang = "before";
    first.api.queue(tap(2, send, 1001));
    void first.notifier.telegram.pollOnce();
    for (let i = 0; i < 50 && !first.board.called; i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.board.sent).toHaveLength(0);
    first.notifier.telegram.stop();
    // Restart: the tap is replayed from the saved queue and sends the reply.
    const second = setup();
    await second.notifier.telegram.pollOnce();
    expect(second.board.sent.map((s) => s.text)).toEqual(["8080"]);
    expect(second.api.answers()).toEqual(["Sent"]);
    // Replayed once more (crash after sending): no double, the card keeps saying it was sent.
    const third = setup();
    (third.notifier.telegram as any).queue.data = { bot: "123456789", items: [tap(2, send, 1001)], seen: [] };
    await third.notifier.telegram.pollOnce();
    expect(third.board.sent).toHaveLength(0);
    expect(third.api.edits().at(-1)!.body.text).toContain('✓ Sent to "Deploy"');
    // A different (second) tap on the used button changes nothing on the card.
    third.api.queue(tap(3, send, 1001));
    await third.notifier.telegram.pollOnce();
    expect(third.api.answers().at(-1)).toBe("This button was already used.");
    expect(third.api.edits()).toHaveLength(1);
  });

  test("f2: a reply to a notify_user message (not a question) is steering: Confirm even with the echo off", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [notifier.helper.waits.add({ board: "kb", ticketId: t.id, kind: "message", identity: "m:x", question: "Merged and deployed", label: "x", since: new Date(clock).toISOString() }).key]);
    api.queue(reply(1, tg, "great, now delete prod"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain("Confirm: send this to");
    expect(board.sent).toHaveLength(0);
    // A question on a failed ticket is confirmed too.
    const f = store.createTicket("kb", { title: "Broken", body: "b", status: "review" });
    store.updateTicket("kb", f.id, { outcome: "failed" });
    const tg2 = await alert(notifier, [wait(f.id, "questions").key]);
    api.queue(reply(2, tg2, "8080"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toContain("Its run failed");
    expect(board.sent).toHaveLength(0);
  });

  test("f3: an echo that never reached the phone is shown again after a restart, not dropped", async () => {
    const { notifier, api } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    // The action was saved but the daemon died before the card went out.
    notifier.telegramActions.create("send", { r: { chatId: ME, updateId: 1, tg: 9001, replyTo: tg, text: "8080" }, t: {}, mode: "answer" });
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toBe('Send this to "Deploy" (Kanban)?\n\n"8080"');
  });

  test("f8: after a new bot token, a reply never matches the old bot's message with the same id", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    notifier.telegramLinks.add({ bot: "987654321", tg: tg + 50, chatId: ME, messageId: null, level: "urgent", items: [] });
    expect(notifier.telegramLinks.get(ME, tg, "987654321")).toBeNull();
    expect(notifier.telegramLinks.get(ME, tg, "123456789")?.items[0].ticketId).toBe(t.id);
    void api;
    void board;
  });

  test("f4/f5: a turn with no text ends the wait for a reply; report back needs Telegram on", async () => {
    const { notifier, api } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    await notifier.turnEnded("kb", t.id, "");
    expect(store.getTicket("kb", t.id)!.telegramReport).toBeNull();
    const n = api.sent().length;
    await notifier.turnEnded("kb", t.id, "typed on the board");
    expect(api.sent()).toHaveLength(n);
    store.updateTicket("kb", t.id, { telegramReport: { tg: 9001, chatId: ME, at: new Date(clock).toISOString() } });
    notifier.update({ telegram: { on: false } });
    await notifier.turnEnded("kb", t.id, "done");
    expect(api.sent()).toHaveLength(n);
  });
});
