import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { Board } from "../src/server/board";
import { reportParts } from "../src/server/helper/tgreply";
import { LOCKED_NOTE, LOCKED_NOTE_MS, safeCut, telegramText } from "../src/server/helper/telegram";
import { ACTION_TTL_MS, PendingActions, UpdateQueue } from "../src/server/helper/tgstores";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import { addTelegramSpend } from "../src/server/spend";
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
    dropped: 0,
    dropTelegramQueued: () => (o.dropped++, 0),
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
  writeNotifySettings(root, { ...s, telegram: { on: true, token: TOKEN, chatId: ME, chatName: "Leo", pairedAt: "x", askTyped: o.askTyped ?? true, takeMessages: true, lockedAt: null } });
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

  test("a typed reply to a ticket with a form passes as its answer (the form's buttons are in tgforms; no 'answer on the board' stopgap)", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Form", body: "b", status: "review" });
    store.updateTicket("kb", t.id, { sessionId: "s1" });
    const q = (question: string) => ({ question, options: [{ label: "a" }, { label: "b" }], multiSelect: false });
    sessions.set("s1", { openForm: [q("One?"), q("Two?")] } as any);
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "a for both"));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["a for both"]);
  });

  test("an alert about several tickets asks which one, one button per ticket naming its board", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const a = store.createTicket("kb", { title: "Alpha", body: "b", status: "review" });
    const b = store.createTicket("shop", { title: "Beta", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(a.id, "questions").key, wait(b.id, "questions", "Which colour?", "shop").key]);
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
    // Phone access off (no link): no "read" invitation, only where the rest is.
    expect(parts[2].endsWith("… (cut: the rest is on the board)")).toBe(true);
    const linked = reportParts("T (B):", Array(15).fill(line).join("\n"), 3, 4096, "https://mac.tail.ts.net/#/kb/t1");
    expect(linked[2].endsWith("… (cut: read the rest on the board: https://mac.tail.ts.net/#/kb/t1)")).toBe(true);
    expect(reportParts("T", "CKANBAN_RESULT: {}")).toEqual([]);
  });

  test("a long reply is never split inside an emoji (surrogate pair), on a long line or at the cut", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // One line of emoji longer than several messages, starting at an odd offset so a plain cut lands mid-pair.
    const text = `x${"😀".repeat(6000)}`;
    const parts = reportParts("", text, 10);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThan(4096);
      expect(lone.test(p)).toBe(false);
    }
    expect(parts.join("")).toBe(text);
    // Cut at the parts limit: the last part's cut is whole too.
    const cut = reportParts("", text, 2);
    for (const p of cut) expect(lone.test(p)).toBe(false);
    expect(safeCut("a😀", 2)).toBe(1);
    expect(safeCut("a😀", 3)).toBe(3);
    expect(lone.test(telegramText(`x${"😀".repeat(3000)}`))).toBe(false);
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

describe("off switch, Pause, /lock and Unpair", () => {
  const NOT_TAKING = "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
  const LOCKED = "🔒 Locked. I won't take messages from this chat until you unlock it on the Mac (Settings, Telegram). Alerts still arrive.";
  const msg = (updateId: number, text: string, chat = ME) => ({
    update_id: updateId, message: { message_id: 9000 + updateId, chat: { id: chat, type: "private" }, from: { id: chat }, date: Math.floor(clock / 1000), text },
  });

  test("off: replies and taps that would send are refused with one short reply; alerts, Got it and /waiting still work", async () => {
    const { notifier, api, board } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const rec = wait(t.id, "questions");
    const tg = await alert(notifier, [rec.key]);
    api.queue(reply(1, tg, "port 8080"));
    await notifier.telegram.pollOnce();
    const send = button(api.last(), "Send");
    const echoId = api.sent().length + 999;
    // Pause (Settings): the echo shown before it no longer sends.
    const s = notifier.update({ telegram: { takeMessages: false } });
    expect(s.telegram.takeMessages).toBe(false);
    expect(s.telegram.lockedAt).toBeNull();
    expect(board.dropped).toBe(1);
    api.queue(tap(2, send, echoId), reply(3, tg, "port 9090"), msg(4, "hello"));
    await notifier.telegram.pollOnce();
    expect(board.sent).toHaveLength(0);
    expect(api.answers()).toEqual([NOT_TAKING]);
    expect(api.sent().slice(-2).map((c) => c.body.text)).toEqual([NOT_TAKING, NOT_TAKING]);
    // Alerts still go out; Got it still works; /waiting still answers.
    const before = api.sent().length;
    await alert(notifier, [rec.key]);
    expect(api.sent().length).toBe(before + 1);
    let got = 0;
    (notifier.telegram as any).d.actions = () => ({ gotIt: () => (got++, "Got it."), notUrgent: () => "x", waiting: () => "Nothing waits." });
    api.queue(tap(5, "g:m_abc", 1), msg(6, "/waiting"));
    await notifier.telegram.pollOnce();
    expect(got).toBe(1);
    // The tap runs beside the message line, so its "Got it." reply may come before or after the /waiting answer.
    expect(api.sent().slice(-2).map((c) => c.body.text).sort()).toEqual(["Got it.", "Nothing waits."]);
    // Back on: the old echo stays dead (expired), a new reply works.
    notifier.update({ telegram: { takeMessages: true } });
    api.queue(tap(7, send, echoId));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("This button expired.");
    expect(board.sent).toHaveLength(0);
    api.queue(reply(8, tg, "port 8080"));
    await notifier.telegram.pollOnce();
    api.queue(tap(9, button(api.last(), "Send"), 1));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((m) => m.text)).toEqual(["port 8080"]);
  });

  test("/lock: off at once, saved with the time; cannot be undone from Telegram; Settings turns it back on", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    // A stranger's /lock does nothing.
    api.queue(msg(1, "/lock", 999));
    await notifier.telegram.pollOnce();
    expect(notifier.settings().telegram.takeMessages).toBe(true);
    api.queue(msg(2, "/lock@my_ck_bot"));
    await notifier.telegram.pollOnce();
    expect(api.last().text).toBe(LOCKED);
    expect(api.last().disable_notification).toBe(true);
    const st = notifier.state().telegram;
    expect(st.takeMessages).toBe(false);
    const lockedAt = new Date(clock).toISOString();
    expect(st.lockedAt).toBe(lockedAt);
    expect(board.dropped).toBe(1);
    api.queue(reply(3, tg, "8080"), msg(4, "/unlock"), msg(5, "/start"));
    await notifier.telegram.pollOnce();
    expect(board.sent).toHaveLength(0);
    // Locked: one silent note says why nothing happens (not one per message), again after 10 minutes.
    expect(api.sent().slice(-1).map((c) => c.body.text)).toEqual([LOCKED_NOTE]);
    expect(api.last().disable_notification).toBe(true);
    const before = api.sent().length;
    api.queue(msg(6, "hello?"));
    await notifier.telegram.pollOnce();
    expect(api.sent().length).toBe(before);
    clock += LOCKED_NOTE_MS;
    api.queue(msg(7, "hello again"));
    await notifier.telegram.pollOnce();
    expect(api.sent().length).toBe(before + 1);
    expect(api.last().text).toBe(LOCKED_NOTE);
    expect(board.sent).toHaveLength(0);
    expect(notifier.settings().telegram.takeMessages).toBe(false);
    // The settings API can't set lockedAt; turning it on clears it.
    notifier.update({ telegram: { lockedAt: "2020-01-01T00:00:00Z" } });
    expect(notifier.state().telegram.lockedAt).toBe(lockedAt);
    const on = notifier.update({ telegram: { takeMessages: true } });
    expect(on.telegram.takeMessages).toBe(true);
    expect(on.telegram.lockedAt).toBeNull();
  });

  test("/lock isn't held behind a slow message, and the messages behind it are refused", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    board.hang = "before";
    const bot = notifier.telegram as any;
    bot.queue.add([reply(1, tg, "slow"), msg(2, "/lock")]);
    bot.drain();
    for (let i = 0; i < 50 && notifier.settings().telegram.takeMessages; i++) await new Promise((r) => setTimeout(r, 5));
    expect(notifier.settings().telegram.takeMessages).toBe(false);
    expect(api.last().text).toBe(LOCKED);
  });

  test("a tap already on its way when Telegram stops taking messages doesn't reach the ticket", async () => {
    const { notifier, api, board } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    const id = /^p:([a-z0-9]{10}):y$/.exec(button(api.last(), "Send"))![1];
    // Turned off behind the bot's back (the check at handling time already passed).
    const s = notifier.settings();
    writeNotifySettings(root, { ...s, telegram: { ...s.telegram, takeMessages: false } });
    const answer = await notifier.replies.onTap(id, "y", ME, 1, notifier.telegram.responder(ME), 2);
    expect(answer).toBe("Not sent");
    expect(board.sent).toHaveLength(0);
    expect(api.edits().at(-1)!.body.text).toBe(NOT_TAKING);
  });

  test("Unpair forgets the chat, expires open buttons and drops the queue; pairing again turns taking messages on", async () => {
    const { notifier, api, board } = setup();
    const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
    const tg = await alert(notifier, [wait(t.id, "questions").key]);
    api.queue(reply(1, tg, "8080"));
    await notifier.telegram.pollOnce();
    const send = button(api.last(), "Send");
    notifier.update({ telegram: { takeMessages: false } });
    const bot = notifier.telegram as any;
    bot.queue.add([reply(2, tg, "later")]);
    expect(bot.queue.pending()).toHaveLength(1);
    const s = notifier.telegramUnpair();
    expect(s.telegram.paired).toBe(false);
    expect(bot.queue.pending()).toHaveLength(0);
    expect(bot.queue.seen(2)).toBe(true);
    expect(board.dropped).toBe(2);
    expect(notifier.telegramActions.find(() => true)).toBeNull();
    // A tap from the old chat: not paired.
    api.queue(tap(3, send, 1));
    await notifier.telegram.pollOnce();
    expect(board.sent).toHaveLength(0);
    // Pairing again: on by default.
    const { code } = notifier.telegramPair();
    api.queue(msg(4, code));
    await notifier.telegram.pollOnce();
    expect(notifier.state().telegram).toMatchObject({ paired: true, takeMessages: true, lockedAt: null });
  });

  test("Settings shows today's Telegram spend", () => {
    const { notifier } = setup();
    expect(notifier.state().telegram.spentToday).toBe(0);
    addTelegramSpend(root, 1.234, new Date(clock));
    expect(notifier.state().telegram.spentToday).toBe(1.23);
  });
});

test("Board.dropTelegramQueued drops Telegram messages not handed to Claude yet, and only those", () => {
  const board = new Board(store, new Bus(), { claudeBin: "false" });
  const t = store.createTicket("kb", { title: "Deploy", body: "b", status: "review" });
  const at = new Date().toISOString();
  store.updateTicket("kb", t.id, { queued: [
    { id: "a", text: "from phone", at, state: "queued", telegram: { updateId: 1, tg: 2 } },
    { id: "b", text: "typed", at, state: "queued" },
    { id: "c", text: "from phone, unsent", at, state: "unsent", telegram: { updateId: 3, tg: 4 } },
  ] });
  expect(board.dropTelegramQueued()).toBe(2);
  expect(store.getTicket("kb", t.id)!.queued!.map((m) => m.id)).toEqual(["b"]);
});
