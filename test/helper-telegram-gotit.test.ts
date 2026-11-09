// Got it on a Telegram reminder (t_20261109_na7b): the tap goes through the board's real Telegram bot and the helper
// runner, stops the whole alert's steps, shows on the phone (buttons go, a silent reply says what happened), works
// after a restart, says when reminders had already stopped, and never reaches a newer wait that reuses the key.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { HelperRunner } from "../src/server/helper/runner";
import { DEFAULT_TELEGRAM } from "../src/server/helper/telegram";
import { WaitStore } from "../src/server/helper/waits";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import type { SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const ME = 555;
const DAY = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();

describe("WaitStore.forMessage", () => {
  test("a message's item finds the wait it told, not a newer one under the same key", () => {
    let clock = DAY(9);
    const w = new WaitStore(tempDir("ck-waits-"), () => clock);
    const nw = { board: "kb", ticketId: "t_1", kind: "questions" as const, identity: "q:x", question: "Stop it?", label: "Answer 1 question", since: new Date(clock).toISOString(), urgent: true, why: null };
    const old = w.add(nw);
    w.update(old.key, { messageId: "m_alert1", reminders: [{ channel: "telegram", dueAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString(), messageId: "m_rem1" }] });
    const summaryAt = new Date(clock + 1000).toISOString();
    clock += 60_000;
    w.close([old.key], "answered");
    const fresh = w.add({ ...nw, since: new Date(clock).toISOString() });
    expect(fresh.key).toBe(old.key);
    // The old alert and reminder find the archived wait; a message sent after the new wait opened finds the new one.
    expect(w.forMessage(old.key, { id: "m_rem1", at: summaryAt })!.key).toBe(`${old.key}#${nw.since}`);
    expect(w.forMessage(old.key, { id: "m_alert1", at: summaryAt })!.key).toBe(`${old.key}#${nw.since}`);
    expect(w.forMessage(old.key, { id: "m_other", at: new Date(clock + 5).toISOString() })!.queuedAt).toBe(fresh.queuedAt);
    // A message not linked to either, sent while the old wait was live: the old one.
    expect(w.forMessage(old.key, { id: "m_summary", at: summaryAt })!.key).toBe(`${old.key}#${nw.since}`);
    // One sent before any wait existed: none.
    expect(w.forMessage(old.key, { id: "m_x", at: new Date(DAY(8)).toISOString() })).toBeUndefined();
  });
});

describe("Got it from Telegram, end to end", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let summaries: Map<string, SessionSummary>;
  let answers: SideCallResult[];
  let ticket: Ticket;
  let n: Notifier;
  let h: HelperRunner;
  let calls: { method: string; body: any }[];
  let updates: any[];
  let hooks: string[];
  let msgNo: number;

  const tgFetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    let result: unknown = true;
    if (method === "getMe") result = { username: "my_ck_bot" };
    else if (method === "getUpdates") result = updates.filter((u) => u.update_id >= (body.offset ?? 0));
    else if (method === "sendMessage") result = { message_id: ++msgNo, chat: { id: body.chat_id } };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const make = () => {
    n = new Notifier(store, bus, {
      root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.ts.net", debounceMs: 1000, tickMs: 3600_000, now: () => clock, telegramPoll: false, telegramFetch: tgFetch,
      fetch: async (_url, init) => {
        hooks.push(String(init.body));
        return new Response("ok");
      },
      banner: () => {},
    });
    h = new HelperRunner({
      root: store.root, store, core: n.helper, notifySettings: () => n.settings(), link: (s, id) => n.link(s, id), messageLink: (id) => n.messageLink(id), now: () => clock,
      sideCall: async () => answers.shift() ?? { ok: false, error: "no answer queued" },
    });
    return n.start();
  };
  const answer = (d: object): SideCallResult => ({ ok: true, text: JSON.stringify({ sends: [], nextWakeIn: 60, notes: "", log: "ok", ...d }), costUsd: 0.02, model: "sonnet" });
  const settle = async () => {
    n.tick();
    clock += 1000;
    n.tick();
    await new Promise((r) => setTimeout(r, 5));
  };
  const keyOf = () => n.helper.waits.open().find((r) => r.ticketId === ticket.id)!.key;
  const tgSends = () => calls.filter((c) => c.method === "sendMessage");
  /** An urgent alert on ntfy, then a Telegram reminder 5 minutes later (with Got it), then ntfy again at 10. */
  const alertThenTelegramReminder = async () => {
    clock += 2 * 60_000;
    summaries.set(`s_${ticket.id}`, {
      title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 1,
      openForm: [{ question: "Stop the old webhook?", options: [], multiSelect: false }], openAsk: { urgent: true, why: "billed twice" },
      pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
    } as SessionSummary);
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", ticket.id, { status: "planning", sessionId: `s_${ticket.id}` }) });
    await settle();
    const key = keyOf();
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Stop it", why: "billed twice", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "telegram", afterMin: 5 }, { channel: "webhook", afterMin: 10 }] }] }));
    await h.tick();
    clock += 5 * 60_000 + 1000;
    await h.tick();
    const sent = tgSends().at(-1)!;
    const reminder = n.helper.messages.listNewest().find((m) => m.level === "reminder")!;
    return { key, reminder, sent, telegramMessageId: msgNo };
  };
  const tap = (updateId: number, telegramMessageId: number, markup: any, data: string, from = ME) => ({
    update_id: updateId,
    callback_query: { id: `cq${updateId}`, from: { id: from }, data, message: { message_id: telegramMessageId, chat: { id: from }, reply_markup: markup } },
  });

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = DAY(14, 0);
    summaries = new Map();
    answers = [];
    calls = [];
    updates = [];
    hooks = [];
    msgNo = 100;
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, { ...normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }), telegram: { ...DEFAULT_TELEGRAM, on: true, token: TOKEN, chatId: ME } });
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z" }));
  });

  test("Got it on the reminder stops the alert's later steps, answers the tap, drops the buttons and replies", async () => {
    const stop = make();
    const { key, reminder, sent, telegramMessageId } = await alertThenTelegramReminder();
    expect(hooks).toHaveLength(1);
    const markup = sent.body.reply_markup;
    // The reminder's buttons point at the reminder itself, which belongs to the alert's wait.
    expect(markup.inline_keyboard[0][0]).toEqual({ text: "Got it", callback_data: `g:${reminder.id}` });
    expect(markup.inline_keyboard.at(-1)[0].url).toMatch(/^https:\/\//);
    await n.telegram.handle(tap(1, telegramMessageId, markup, `g:${reminder.id}`));
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body).toEqual({ callback_query_id: "cq1", text: "Got it: no more reminders for Pricing" });
    const edit = calls.find((c) => c.method === "editMessageReplyMarkup")!.body;
    expect(edit).toMatchObject({ chat_id: ME, message_id: telegramMessageId });
    expect(edit.reply_markup.inline_keyboard).toEqual([markup.inline_keyboard.at(-1)]);
    const reply = tgSends().at(-1)!.body;
    expect(reply).toMatchObject({ chat_id: ME, text: "Got it: no more reminders for Pricing", disable_notification: true, reply_parameters: { message_id: telegramMessageId } });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(TOKEN);
    expect(n.helper.waits.get(key)!.remindersStopped).toBe("got-it");
    expect(n.helper.messages.get(reminder.id)!.tapped!.how).toBe("got-it");
    expect(n.helper.messages.get(n.helper.waits.get(key)!.messageId!)!.tapped!.how).toBe("got-it");
    // The 10-minute ntfy step never comes.
    clock += 10 * 60_000;
    await h.tick();
    expect(hooks).toHaveLength(1);
    stop();
  });

  test("after a restart the poller reads the tap, stops the reminders, and never handles the same tap twice", async () => {
    let stop = make();
    const { key, reminder, sent, telegramMessageId } = await alertThenTelegramReminder();
    stop();
    // The daemon restarts; the tap is waiting at Telegram.
    updates = [tap(500, telegramMessageId, sent.body.reply_markup, `g:${reminder.id}`)];
    stop = make();
    expect(await n.telegram.pollOnce()).toBe(true);
    expect(n.helper.waits.get(key)!.remindersStopped).toBe("got-it");
    expect(JSON.parse(readFileSync(join(store.root, "telegram-offset.json"), "utf8"))).toEqual({ bot: "123456789", offset: 501 });
    stop();
    calls = [];
    stop = make();
    expect(await n.telegram.pollOnce()).toBe(true);
    expect(calls.find((c) => c.method === "getUpdates")!.body).toMatchObject({ offset: 501, allowed_updates: ["message", "callback_query"] });
    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(0);
    stop();
  });

  test("Got it after the reminders already stopped says why instead of a bare 'Got it'", async () => {
    const stop = make();
    const { reminder, sent, telegramMessageId } = await alertThenTelegramReminder();
    n.helper.waits.opened("kb", ticket.id);
    await n.telegram.handle(tap(2, telegramMessageId, sent.body.reply_markup, `g:${reminder.id}`));
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("Got it: reminders for Pricing had already stopped (you opened it)");
    expect(tgSends().at(-1)!.body.text).toBe("Got it: reminders for Pricing had already stopped (you opened it)");
    stop();
  });

  test("Got it on an old reminder doesn't stop a newer wait that asks the same question", async () => {
    const stop = make();
    const { key, reminder, sent, telegramMessageId } = await alertThenTelegramReminder();
    // Answered, then the same question comes back as a new wait with its own pending reminder.
    n.helper.waits.close([key], "answered");
    clock += 60_000;
    const fresh = n.helper.waits.add({ board: "kb", ticketId: ticket.id, kind: "questions", identity: key.split("|")[1], question: "Stop the old webhook?", label: "Answer 1 question", since: new Date(clock).toISOString(), urgent: true, why: null });
    n.helper.waits.update(fresh.key, { messageId: "m_newalert", reminders: [{ channel: "webhook", dueAt: new Date(clock + 300_000).toISOString() }] });
    await n.telegram.handle(tap(3, telegramMessageId, sent.body.reply_markup, `g:${reminder.id}`));
    expect(n.helper.waits.get(fresh.key)!.remindersStopped ?? null).toBeNull();
    expect(n.helper.waits.get(fresh.key)!.reminders.some((s) => !s.sentAt)).toBe(true);
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("Got it: reminders for Pricing had already stopped (it was answered)");
    stop();
  });

  test("a tap from another chat stops nothing and gets no reply or edit", async () => {
    const stop = make();
    const { key, reminder, sent, telegramMessageId } = await alertThenTelegramReminder();
    await n.telegram.handle(tap(4, telegramMessageId, sent.body.reply_markup, `g:${reminder.id}`, 777));
    expect(n.helper.waits.get(key)!.reminders.some((s) => !s.sentAt)).toBe(true);
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("This bot isn't paired with you.");
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(false);
    expect(n.helper.messages.get(reminder.id)!.tapped ?? null).toBeNull();
    stop();
  });
});
