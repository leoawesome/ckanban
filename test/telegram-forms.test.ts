import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import { TelegramBot } from "../src/server/helper/telegram";
import { rowsOf } from "../src/server/helper/tgforms";
import type { Question, SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile } from "../src/server/types";
import { tempDir } from "./helpers";
import { answersMessage } from "../web/src/questionForms";

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
    telegramPoll: false, telegramPaceMs: 0, banner: () => {}, now: () => clock, phoneAccess: () => !!o.phone,
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
  root = tempDir("ck-tgf-");
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

const WHERE: Question = {
  question: "Which board should the front desk live on?", multiSelect: false,
  options: [{ label: "Kanban", description: "where you paired", recommended: true }, { label: "Shop site", recommended: false }, { label: "Ask me each time", recommended: false }],
};
const POWERS: Question = {
  question: "What can it do without asking?", multiSelect: true,
  options: [{ label: "Read status and chats", recommended: false }, { label: "Answer questions", recommended: false }, { label: "Start new work", recommended: false }],
};
const SHIP: Question = { question: "Ship today?", multiSelect: false, options: [{ label: "Yes", recommended: false }, { label: "No", recommended: false }] };

/** A ticket in Review whose session asks this form, with its wait record open (as the Notifier makes it). */
function formTicket(questions: Question[], title = "Telegram front desk") {
  const t = store.createTicket("kb", { title, body: "b", status: "review" });
  store.updateTicket("kb", t.id, { sessionId: `s-${t.id}` });
  sessions.set(`s-${t.id}`, { openForm: questions, openQuestions: questions.length } as any);
  const n = current.at(-1)!.notifier;
  const rec = n.helper.waits.add({
    board: "kb", ticketId: t.id, kind: "questions", identity: `q:${t.id}`, question: questions.map((q) => q.question).join("\n"), label: "q", since: new Date(clock).toISOString(),
  });
  return { t, rec };
}

/** Sends the alert and waits for the form messages that follow it. Returns the alert's id and the question messages. */
async function alertForm(n: Notifier, api: ReturnType<typeof fakeApi>, key: string) {
  const before = api.sent().length;
  const tg = await alert(n, [key]);
  await n.telegram.idle();
  const msgs = api.calls.filter((c) => c.method === "sendMessage").slice(before + 1);
  return { tg, msgs: msgs.map((m, i) => ({ body: m.body, id: 1000 + before + 1 + i })) };
}

const labels = (body: any) => body.reply_markup.inline_keyboard.map((r: any[]) => r.map((b) => b.text));

describe("a form from Telegram", () => {
  test("one message per question with numbered options and buttons; taps mark ✓; Done sends ONE message in the board's format", async () => {
    const { notifier, api, board } = setup();
    const { t, rec } = formTicket([WHERE, POWERS]);
    const { tg, msgs } = await alertForm(notifier, api, rec.key);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].body.text).toBe('❓ Kanban: "Telegram front desk" asks 2 questions (1 of 2)\n\nWhich board should the front desk live on?\n1. Kanban: where you paired (suggested)\n2. Shop site\n3. Ask me each time');
    expect(msgs[0].body.reply_parameters.message_id).toBe(tg);
    expect(labels(msgs[0].body)).toEqual([["1", "2", "3"], ["Type my own"]]);
    expect(msgs[1].body.text).toBe("(2 of 2) What can it do without asking? Pick any, then Done.\n1. Read status and chats\n2. Answer questions\n3. Start new work");
    expect(labels(msgs[1].body)).toEqual([["1", "2", "3"], ["Type my own"], ["Done, send my answers"]]);
    for (const m of msgs) {
      expect(m.body.disable_notification).toBe(true);
      for (const b of m.body.reply_markup.inline_keyboard.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
    // Single choice: a tap marks it.
    api.queue(tap(1, button(msgs[0].body, "1"), msgs[0].id));
    await notifier.telegram.pollOnce();
    expect(labels(api.edits().at(-1)!.body)).toEqual([["1 ✓", "2", "3"], ["Type my own"]]);
    // Multi-select: taps toggle.
    api.queue(tap(2, button(msgs[1].body, "1"), msgs[1].id), tap(3, button(msgs[1].body, "3"), msgs[1].id));
    await notifier.telegram.pollOnce();
    api.queue(tap(4, button(msgs[1].body, "3"), msgs[1].id), tap(5, button(msgs[1].body, "2"), msgs[1].id));
    await notifier.telegram.pollOnce();
    expect(labels(api.edits().at(-1)!.body)[0]).toEqual(["1 ✓", "2 ✓", "3"]);
    expect(board.sent).toHaveLength(0);
    api.queue(tap(6, button(msgs[1].body, "Done, send my answers"), msgs[1].id));
    await notifier.telegram.pollOnce();
    // One message, exactly as the board's QuestionsForm sends it.
    const board_ = answersMessage([WHERE, POWERS], [
      { picked: ["Kanban"], otherOn: false, other: "" }, { picked: ["Read status and chats", "Answer questions"], otherOn: false, other: "" },
    ]);
    expect(board.sent).toEqual([{ slug: "kb", id: t.id, text: board_, updateId: 6, key: rec.key }]);
    expect(board_).toBe("My answers:\n- Which board should the front desk live on? → Kanban\n- What can it do without asking? → Read status and chats; Answer questions");
    expect(api.last().text).toBe('✓ Sent both answers to "Telegram front desk".');
    // The question messages lose their buttons; a late tap sends nothing.
    expect(api.edits().slice(-2).map((e) => e.body.reply_markup.inline_keyboard)).toEqual([[], []]);
    api.queue(tap(7, button(msgs[0].body, "2"), msgs[0].id));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("Already sent");
    expect(board.sent).toHaveLength(1);
    // Marked "via Telegram" on the board: the ticket's telegramIn has it.
    expect(store.getTicket("kb", t.id)!.telegramIn!.at(-1)!.text).toBe(board_);
  });

  test("single-choice questions: sent once every question has an answer; changing a pick before that works", async () => {
    const { notifier, api, board } = setup();
    const { t, rec } = formTicket([WHERE, SHIP], "Deploy");
    const { msgs } = await alertForm(notifier, api, rec.key);
    expect(labels(msgs[1].body)).toEqual([["1", "2"], ["Type my own"]]);
    api.queue(tap(1, button(msgs[0].body, "2"), msgs[0].id));
    await notifier.telegram.pollOnce();
    api.queue(tap(2, button(msgs[0].body, "3"), msgs[0].id));
    await notifier.telegram.pollOnce();
    expect(board.sent).toHaveLength(0);
    api.queue(tap(3, button(msgs[1].body, "1"), msgs[1].id));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual([answersMessage([WHERE, SHIP], [{ picked: ["Ask me each time"], otherOn: false, other: "" }, { picked: ["Yes"], otherOn: false, other: "" }])]);
    expect(board.sent[0].id).toBe(t.id);
    expect(api.last().text).toBe('✓ Sent both answers to "Deploy".');
  });

  test("Type my own asks for a reply; the reply is that question's answer, with no Send/Cancel echo", async () => {
    const { notifier, api, board } = setup();
    const { rec } = formTicket([WHERE, SHIP]);
    const { msgs } = await alertForm(notifier, api, rec.key);
    api.queue(tap(1, button(msgs[0].body, "Type my own"), msgs[0].id));
    await notifier.telegram.pollOnce();
    const prompt = api.last();
    expect(prompt.reply_markup.force_reply).toBe(true);
    expect(prompt.text).toContain("Type your answer to (1 of 2)");
    const promptId = api.sent().length + 999;
    api.queue(reply(2, promptId, "The shop board,\nbut only weekdays"));
    await notifier.telegram.pollOnce();
    // No echo: the prompt now says it was noted, and the question shows the answer.
    expect(api.sent().some((c) => /^Send this to/.test(c.body.text))).toBe(false);
    expect(api.edits().some((e) => e.body.message_id === promptId && e.body.text.startsWith("✓ Noted your answer to (1 of 2)."))).toBe(true);
    expect(api.edits().some((e) => e.body.message_id === msgs[0].id && e.body.text.includes("Your answer: The shop board, but only weekdays"))).toBe(true);
    // Replying straight to the second question's message works too, and completes the form.
    api.queue(reply(3, msgs[1].id, "no, Friday"));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => s.text)).toEqual(["My answers:\n- Which board should the front desk live on? → The shop board,\n  but only weekdays\n- Ship today? → no, Friday"]);
    expect(board.sent[0].updateId).toBe(3);
  });

  test("a restart mid-form keeps the taps; a final send cut off by a restart is finished once", async () => {
    const first = setup();
    const { rec } = formTicket([WHERE, SHIP]);
    const { msgs } = await alertForm(first.notifier, first.api, rec.key);
    first.api.queue(tap(1, button(msgs[0].body, "2"), msgs[0].id));
    await first.notifier.telegram.pollOnce();
    first.board.hang = "before";
    first.api.queue(tap(2, button(msgs[1].body, "2"), msgs[1].id));
    void first.notifier.telegram.pollOnce();
    for (let i = 0; i < 50 && !first.board.called; i++) await new Promise((r) => setTimeout(r, 5));
    expect(first.board.sent).toHaveLength(0);
    first.notifier.telegram.stop();
    // Restart: the tap is replayed from the saved queue; the first answer came from disk.
    const second = setup();
    await second.notifier.telegram.pollOnce();
    expect(second.board.sent.map((s) => s.text)).toEqual(["My answers:\n- Which board should the front desk live on? → Shop site\n- Ship today? → No"]);
    // Replayed again (a crash after sending): nothing doubles.
    const third = setup();
    (third.notifier.telegram as any).queue.data = { bot: "123456789", items: [tap(2, button(msgs[1].body, "2"), msgs[1].id)], seen: [] };
    await third.notifier.telegram.pollOnce();
    expect(third.board.sent).toHaveLength(0);
    expect(third.api.answers()).toEqual(["Already sent"]);
  });

  test("taps survive a restart before the form is finished", async () => {
    const first = setup();
    const { rec } = formTicket([WHERE, SHIP]);
    const { msgs } = await alertForm(first.notifier, first.api, rec.key);
    first.api.queue(tap(1, button(msgs[0].body, "1"), msgs[0].id));
    await first.notifier.telegram.pollOnce();
    first.notifier.telegram.stop();
    const second = setup();
    second.api.queue(tap(2, button(msgs[1].body, "1"), msgs[1].id));
    await second.notifier.telegram.pollOnce();
    expect(second.board.sent.map((s) => s.text)).toEqual(["My answers:\n- Which board should the front desk live on? → Kanban\n- Ship today? → Yes"]);
  });

  test("answered on the board first: the taps are dropped and the messages say so, without buttons", async () => {
    const { notifier, api, board } = setup();
    const { t, rec } = formTicket([WHERE, SHIP]);
    const { msgs } = await alertForm(notifier, api, rec.key);
    api.queue(tap(1, button(msgs[0].body, "1"), msgs[0].id));
    await notifier.telegram.pollOnce();
    // The board answers: the session's form is no longer open.
    sessions.set(`s-${t.id}`, { openForm: [], openQuestions: 0 } as any);
    await notifier.forms.sync("kb", t.id);
    const time = new Date(clock).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const last2 = api.edits().slice(-2).map((e) => e.body);
    expect(last2.map((b) => b.message_id)).toEqual([msgs[0].id, msgs[1].id]);
    expect(last2[0].text).toBe(`(1 of 2) Which board should the front desk live on?\n\n✓ Answered on the Mac ${time}`);
    expect(last2.every((b) => b.reply_markup.inline_keyboard.length === 0)).toBe(true);
    api.queue(tap(2, button(msgs[1].body, "1"), msgs[1].id));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("This form is closed.");
    expect(board.sent).toHaveLength(0);
  });

  test("a tap after the board answered (before the board noticed) sends nothing", async () => {
    const { notifier, api, board } = setup();
    const { t, rec } = formTicket([WHERE, SHIP]);
    const { msgs } = await alertForm(notifier, api, rec.key);
    api.queue(tap(1, button(msgs[0].body, "1"), msgs[0].id));
    await notifier.telegram.pollOnce();
    store.updateTicket("kb", t.id, { status: "in_progress" });
    api.queue(tap(2, button(msgs[1].body, "1"), msgs[1].id));
    await notifier.telegram.pollOnce();
    expect(api.answers().at(-1)).toBe("Already answered");
    expect(board.sent).toHaveLength(0);
    expect(api.edits().at(-1)!.body.text).toContain("✓ Answered on the Mac");
  });

  test("other text for the ticket while a form is half answered: the answers go first, then the text", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const { t, rec } = formTicket([WHERE, SHIP]);
    const { tg, msgs } = await alertForm(notifier, api, rec.key);
    api.queue(tap(1, button(msgs[0].body, "2"), msgs[0].id));
    await notifier.telegram.pollOnce();
    api.queue(reply(2, tg, "and please hurry"));
    await notifier.telegram.pollOnce();
    expect(board.sent.map((s) => [s.id, s.text])).toEqual([
      [t.id, "My answers:\n- Which board should the front desk live on? → Shop site\n- Ship today? → (no preference)"],
      [t.id, "and please hurry"],
    ]);
    expect(board.sent[0].updateId).toBe(-2);
    expect(api.edits().some((e) => e.body.message_id === msgs[0].id && e.body.text.endsWith("✓ Sent with your message"))).toBe(true);
  });

  test("a typed reply with nothing tapped answers the form itself and closes its buttons (the stopgap is gone)", async () => {
    const { notifier, api, board } = setup({ askTyped: false });
    const { rec } = formTicket([WHERE, POWERS]);
    const { tg, msgs } = await alertForm(notifier, api, rec.key);
    api.queue(reply(1, tg, "kanban, read only"));
    await notifier.telegram.pollOnce();
    expect(api.sent().some((c) => /answer it on the board for now/.test(c.body.text))).toBe(false);
    expect(board.sent.map((s) => s.text)).toEqual(["kanban, read only"]);
    expect(api.edits().filter((e) => e.body.message_id === msgs[1].id).at(-1)!.body.text).toBe("(2 of 2) What can it do without asking?\n\n✓ Answered by your message");
  });

  test("a reminder about the same wait doesn't show the form again", async () => {
    const { notifier, api } = setup();
    const { rec } = formTicket([WHERE, SHIP]);
    await alertForm(notifier, api, rec.key);
    const n = api.sent().length;
    await alert(notifier, [rec.key], "urgent");
    await notifier.telegram.idle();
    expect(api.sent().length).toBe(n + 1);
  });

  test("more than 8 options: 8 buttons in rows of 4, every option listed", async () => {
    const { notifier, api } = setup();
    const many: Question = { question: "Pick a colour", multiSelect: false, options: Array.from({ length: 10 }, (_, i) => ({ label: `c${i + 1}`, recommended: false })) };
    const { rec } = formTicket([many]);
    const { msgs } = await alertForm(notifier, api, rec.key);
    expect(labels(msgs[0].body)).toEqual([["1", "2", "3", "4"], ["5", "6", "7", "8"], ["Type my own"]]);
    expect(msgs[0].body.text).toContain("\n10. c10");
    expect(msgs[0].body.text).toStartWith('❓ Kanban: "Telegram front desk" asks a question (1 of 1)');
  });
});

describe("pacing", () => {
  test("rowsOf: rows of 3-4", () => {
    expect([2, 3, 4, 5, 6, 7, 8].map((n) => rowsOf(Array.from({ length: n })).map((r) => r.length))).toEqual([[2], [3], [4], [3, 2], [3, 3], [4, 3], [4, 4]]);
  });

  test("paced sends and edits are about a second apart; a 429 waits retry_after and tries again", async () => {
    let now = 0;
    const slept: number[] = [];
    let limited = 1;
    const calls: string[] = [];
    const bot = new TelegramBot({
      fetch: async (url) => {
        const method = url.split("/").pop()!;
        calls.push(method);
        if (method === "sendMessage" && limited-- > 0) return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      },
      settings: () => ({ on: true, token: TOKEN, chatId: ME, chatName: null, pairedAt: null, askTyped: true, takeMessages: true, lockedAt: null }),
      save: () => {}, actions: () => ({ gotIt: () => "", notUrgent: () => "", waiting: () => "" }), phoneAccess: () => false, boardUrl: () => "",
      now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; }, autoPoll: false,
    });
    const out = bot.responder(ME, { paced: true });
    const ids = await Promise.all([out.say("a"), out.say("b"), out.edit(1, "c")]);
    expect(ids.slice(0, 2)).toEqual([1, 1]);
    expect(calls).toEqual(["sendMessage", "sendMessage", "sendMessage", "editMessageText"]);
    expect(slept).toEqual([3000, 1000, 1000]);
  });
});
