import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { directLabel, usageLimitLine, type HelperSink } from "../src/server/helper/core";
import { HELD_MAX, MessageStore, MESSAGES_MAX } from "../src/server/helper/messages";
import { questionHash, waitIdentity, WaitStore, type WaitRecord } from "../src/server/helper/waits";
import { messageResultText, questionsError } from "../src/mcp-server";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import { parseAskMeta, type SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

test("the same question, re-asked with other spacing or case, keeps its identity; a different one doesn't", () => {
  expect(questionHash("Stop the  old webhook?\n")).toBe(questionHash("stop the old WEBHOOK?"));
  expect(waitIdentity("questions", "Stop the old webhook?")).not.toBe(waitIdentity("questions", "Approve the copy?"));
  expect(waitIdentity("review")).toBe("review");
  expect(waitIdentity("questions", null)).toBe("questions");
});

test("pushes carry the question's first line, never only 'Answer 1 question'", () => {
  expect(directLabel({ kind: "questions", question: "Stop the old webhook?\nAnd the cron?", label: "Answer 2 questions" })).toBe("Stop the old webhook?");
  expect(directLabel({ kind: "questions", question: "Answer Claude", label: "Answer Claude" })).toBe("Answer Claude");
  expect(directLabel({ kind: "review", question: "Ready for review", label: "Ready for review" })).toBe("Ready for review");
  expect(directLabel({ kind: "questions", question: "x".repeat(300), label: "Answer 1 question" }).length).toBeLessThanOrEqual(110);
});

test("usage-limit line", () => {
  const at = new Date(2026, 10, 9, 3, 0).toISOString();
  expect(usageLimitLine(4, at)).toBe("Usage limit: 4 tickets paused until 3:00");
  expect(usageLimitLine(1, null)).toBe("Usage limit: 1 ticket paused");
});

test("ask_questions and notify_user: urgent and why are checked and read from the call", () => {
  const q = { questions: [{ question: "Stop it?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] };
  expect(questionsError({ ...q, urgent: true, why: "billed twice" })).toBeNull();
  expect(questionsError({ ...q, urgent: "yes" })).toContain("urgent");
  expect(questionsError({ ...q, why: "x".repeat(301) })).toContain("too long");
  expect(parseAskMeta({ urgent: true, why: " billed twice " })).toEqual({ urgent: true, why: "billed twice" });
  expect(parseAskMeta({})).toBeUndefined();
  expect(messageResultText({ delivered: true, devices: 0, onScreen: 0, webhook: false, banner: false, reason: null, error: null, helper: true })).toContain("Passed to the helper");
});

describe("message store", () => {
  test("stores before sending, lists newest first, marks read, keeps at most 500 and 30 days", () => {
    let clock = Date.parse("2026-11-01T00:00:00Z");
    const root = tempDir();
    const s = new MessageStore(root, () => clock);
    const a = s.add({ level: "direct", oneLine: "a", text: "A" });
    clock += 1000;
    const b = s.add({ level: "summary", oneLine: "b", text: "B", held: true });
    expect(s.listNewest().map((m) => m.id)).toEqual([a.id]);
    expect(s.listNewest({ held: true }).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(s.unread()).toBe(1);
    s.recordSends(a.id, [{ channel: "push", at: "x", ok: true, devices: 1 }]);
    s.markRead(a.id);
    const again = new MessageStore(root, () => clock);
    expect(again.get(a.id)?.readAt).not.toBeNull();
    expect(again.get(a.id)?.sends).toHaveLength(1);
    expect(again.unread()).toBe(0);
    for (let i = 0; i < MESSAGES_MAX + 5; i++) again.add({ level: "direct", oneLine: `${i}`, text: "" });
    expect(again.listNewest()).toHaveLength(MESSAGES_MAX);
    expect(again.get(b.id)).not.toBeNull();
    clock += 31 * 24 * 3600_000;
    again.add({ level: "direct", oneLine: "new", text: "" });
    expect(again.listNewest({ held: true }).map((m) => m.oneLine)).toEqual(["new"]);
    expect(existsSync(join(root, "messages.json.tmp"))).toBe(false);
  });

  test("600 held log rows don't push out 5 alerts; held rows keep 200 and 7 days, alerts 30 days", () => {
    let clock = Date.parse("2026-11-01T00:00:00Z");
    const s = new MessageStore(tempDir(), () => clock);
    const alerts: string[] = [];
    for (let i = 0; i < 600; i++) {
      if (i % 120 === 0) alerts.push(s.add({ level: "urgent", oneLine: `alert ${i}`, text: "" }).id);
      s.add({ level: "routine", oneLine: `held ${i}`, text: "", held: true });
      clock += 60_000;
    }
    expect(alerts).toHaveLength(5);
    expect(s.listNewest().map((m) => m.id)).toEqual(alerts.slice().reverse());
    const all = s.listNewest({ held: true });
    expect(all.filter((m) => m.held)).toHaveLength(HELD_MAX);
    expect(all[0].oneLine).toBe("held 599");
    // 8 days on: held rows are gone, the alerts stay.
    clock += 8 * 24 * 3600_000;
    s.add({ level: "summary", oneLine: "later", text: "" });
    expect(s.listNewest({ held: true }).filter((m) => m.held)).toHaveLength(0);
    expect(s.listNewest()).toHaveLength(6);
  });

  test("an existing messages.json loads unchanged", () => {
    const root = tempDir();
    const old = {
      version: 1,
      messages: [
        { id: "m_a", at: "2026-11-08T09:00:00.000Z", level: "urgent", oneLine: "Stop it?", text: "Stop the webhook?", why: "billed", items: [], sends: [{ channel: "push", at: "2026-11-08T09:00:01.000Z", ok: true, devices: 1 }], readAt: null, tapped: { how: "got-it", at: "2026-11-08T09:01:00.000Z" } },
        { id: "m_b", at: "2026-11-08T10:00:00.000Z", level: "routine", oneLine: "Kept quiet", text: "", why: null, items: [], sends: [], readAt: null, held: true },
      ],
    };
    writeFileSync(join(root, "messages.json"), JSON.stringify(old));
    const s = new MessageStore(root, () => Date.parse("2026-11-09T00:00:00Z"));
    expect(s.listNewest({ held: true })).toEqual(old.messages.slice().reverse() as any);
    expect(s.unread()).toBe(1);
    const c = s.add({ level: "direct", oneLine: "c", text: "" });
    const saved = JSON.parse(readFileSync(join(root, "messages.json"), "utf8"));
    expect(saved.messages.slice(0, 2)).toEqual(old.messages);
    expect(saved.messages[2].id).toBe(c.id);
  });
});

describe("wait store", () => {
  test("missing, present and corrupt files; tmp plus rename", () => {
    const root = tempDir();
    const w = new WaitStore(root);
    expect(w.start).toBe("missing");
    w.add({ board: "kb", ticketId: "t1", kind: "review", identity: "review", question: "Ready for review", label: "Ready for review", since: "s" });
    expect(new WaitStore(root).start).toBe("present");
    expect(new WaitStore(root).open()).toHaveLength(1);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    writeFileSync(join(root, "waits.json"), "{not json");
    const c = new WaitStore(root);
    expect(c.start).toBe("corrupt");
    expect(readdirSync(root).some((f) => f.startsWith("waits.json.corrupt-"))).toBe(true);
    expect(c.open()).toEqual([]);
  });

  test("the fallback waits at least 2 minutes after boot; a wait that comes back is a new record and the old is kept", () => {
    let clock = 1_000_000;
    const w = new WaitStore(tempDir(), () => clock);
    const r = w.add({ board: "kb", ticketId: "t1", kind: "failed", identity: "failed", question: "Run failed", label: "Run failed", since: "a" });
    expect(Date.parse(r.fallbackAt!)).toBe(1_000_000 + 5 * 60_000);
    w.close([r.key], "cleared");
    clock += 10 * 60_000;
    const r2 = w.add({ board: "kb", ticketId: "t1", kind: "failed", identity: "failed", question: "Run failed", label: "Run failed", since: "b" });
    expect(r2.closedAt).toBeNull();
    expect(w.get(`${r.key}#a`)?.closedAt).not.toBeNull();
  });
});

describe("Notifier with the helper core", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let sent: { url: string; init: RequestInit }[];
  let summaries: Map<string, SessionSummary>;
  let ticket: Ticket;

  const make = () => new Notifier(store, bus, {
    root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => "https://mac.tail.ts.net", debounceMs: 1000, tickMs: 60_000, now: () => clock,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response("ok");
    },
    banner: () => {},
  });
  const summary = (questions: string[], ask?: { urgent?: boolean; why?: string }): SessionSummary => ({
    title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: questions.length,
    openForm: questions.map((q) => ({ question: q, options: [], multiSelect: false })), ...(ask ? { openAsk: ask } : {}),
    pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
  } as SessionSummary);
  const titles = () => sent.map((s) => (s.init.headers as Record<string, string>).Title);
  const ask = (n: Notifier, id: string, questions: string[], extra?: { urgent?: boolean; why?: string }) => {
    summaries.set(`s_${id}`, summary(questions, extra));
    const t = store.updateTicket("kb", id, { status: "planning", sessionId: `s_${id}` });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: t });
  };
  const settle = async (n: Notifier) => {
    n.tick();
    clock += 1000;
    n.tick();
    await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = Date.parse("2026-11-09T14:00:00Z");
    sent = [];
    summaries = new Map();
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
  });

  test("helper off or not plugged in: the question's first line, stored as a message, told; a second question gets its own alert", async () => {
    const n = make();
    const stop = n.start();
    ask(n, ticket.id, ["Stop the old webhook?"], { urgent: true, why: "pricing data is ingested twice" });
    await settle(n);
    expect(titles()).toEqual(["Stop the old webhook?: Pricing"]);
    expect((sent[0].init.headers as Record<string, string>).Priority).toBe("5");
    const recs = n.helper.waits.open();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ toldVia: "direct", urgent: true, why: "pricing data is ingested twice" });
    const msgs = n.helper.messages.listNewest();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ level: "urgent", why: "pricing data is ingested twice", items: [{ ticketId: ticket.id, question: "Stop the old webhook?" }] });
    expect(msgs[0].sends[0]).toMatchObject({ channel: "webhook", ok: true });
    expect(recs[0].messageId).toBe(msgs[0].id);
    // The same form asked again: nothing new. A different question on the waiting ticket: its own alert.
    ask(n, ticket.id, ["stop the old  webhook?"]);
    await settle(n);
    expect(sent).toHaveLength(1);
    ask(n, ticket.id, ["Also delete the cron job?"]);
    await settle(n);
    expect(titles()).toEqual(["Stop the old webhook?: Pricing", "Also delete the cron job?: Pricing"]);
    const open = n.helper.waits.open();
    expect(open).toHaveLength(1);
    expect(open[0].question).toBe("Also delete the cron job?");
    // The ticket is deleted: its records close.
    bus.emit({ type: "ticket.deleted", profile: "kb", id: ticket.id });
    expect(n.helper.waits.open()).toEqual([]);
    stop();
  });

  test("helper on: waits go to the runner, not out; the 5-minute fallback and the 4-hour digest send what it missed", async () => {
    const n = make();
    const heard: [string, string][] = [];
    let last: number | null = null;
    const sink: HelperSink = { healthy: () => true, lastSuccessAt: () => last, onWait: (r, why) => heard.push([r.question, why]) };
    n.helper.setSink(sink);
    const stop = n.start();
    clock += 3 * 60_000;
    ask(n, ticket.id, ["Approve the copy?"]);
    await settle(n);
    expect(sent).toHaveLength(0);
    expect(heard).toEqual([["Approve the copy?", "new"]]);
    // No helper run succeeded: after 5 minutes the board sends it itself, once.
    clock += 5 * 60_000;
    await settle(n);
    expect(titles()).toEqual(["Approve the copy?: Pricing"]);
    expect(n.helper.messages.listNewest()[0].level).toBe("fallback");
    await settle(n);
    expect(sent).toHaveLength(1);

    // A second ticket: the helper ran after it was queued but held it; after 4 hours it goes out in a digest.
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    ask(n, other.id, ["Which tone?"]);
    await settle(n);
    last = clock;
    clock += 10 * 60_000;
    await settle(n);
    expect(sent).toHaveLength(1);
    // Not at 2 hours any more: the safety net waits 4.
    clock += 2 * 3600_000;
    await settle(n);
    expect(sent).toHaveLength(1);
    clock += 2 * 3600_000;
    await settle(n);
    expect(sent).toHaveLength(2);
    expect(n.helper.messages.listNewest()[0]).toMatchObject({ level: "fallback", items: [{ ticketId: other.id }] });
    expect(n.helper.waits.open().every((r) => r.toldAt)).toBe(true);
    stop();
  });

  test("a failing helper (unhealthy) means direct sends", async () => {
    const n = make();
    n.helper.setSink({ healthy: () => false, lastSuccessAt: () => null, onWait: () => { throw new Error("must not be called"); } });
    const stop = n.start();
    ask(n, ticket.id, ["Approve the copy?"]);
    await settle(n);
    expect(titles()).toEqual(["Approve the copy?: Pricing"]);
    stop();
  });

  test("night, helper failing: only urgent waits go out directly; the rest wait for the morning digest", async () => {
    const n = make();
    let morning: number | null = clock + 8 * 3600_000;
    n.helper.setSink({ healthy: () => false, lastSuccessAt: () => null, onWait: () => {}, morning: () => morning });
    const stop = n.start();
    const urgent = store.createTicket("kb", { title: "Billing", body: "b", status: "in_progress" });
    const recent = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    // An urgent alert named Docs an hour ago: Docs counts as urgent tonight.
    n.helper.messages.add({ level: "urgent", oneLine: "x", text: "x", items: [{ board: "kb", boardName: "Kanban", ticketId: recent.id, title: "Docs", question: "q" }] });
    clock += 3600_000;
    ask(n, ticket.id, ["Approve the copy?"]);
    ask(n, urgent.id, ["Refund?"], { urgent: true, why: "customer waits" });
    ask(n, recent.id, ["Which tone?"]);
    await settle(n);
    expect(titles().sort()).toEqual(["Refund?: Billing", "Which tone?: Docs"]);
    const held = n.helper.waits.open().find((r) => r.ticketId === ticket.id)!;
    expect(held).toMatchObject({ toldAt: null, fallbackAt: null, digestAt: new Date(morning).toISOString() });
    // Not dropped: it goes out in the morning digest.
    clock = morning;
    morning = null;
    await settle(n);
    expect(titles()).toHaveLength(3);
    expect(titles().at(-1)).toBe("Pricing");
    expect(n.helper.waits.get(held.key)!.toldVia).toBe("digest");
    stop();
  });

  test("first start (no waits file) seeds current waits for the helper's first summary; a restart reconciles; corrupt gets normal records", async () => {
    summaries.set("s1", summary(["Old question?"]));
    store.updateTicket("kb", ticket.id, { status: "planning", sessionId: "s1" });
    const sink = (heard: string[]): HelperSink => ({ healthy: () => true, lastSuccessAt: () => null, onWait: (_r, why) => heard.push(why) });
    let heard: string[] = [];
    let n = make();
    n.helper.setSink(sink(heard));
    let stop = n.start();
    expect(heard).toEqual(["seeded"]);
    const seeded = n.helper.waits.open()[0];
    expect(seeded).toMatchObject({ seeded: true, fallbackAt: null, toldAt: null });
    expect(n.helper.waits.firstSummaryPending).toBe(true);
    clock += 3600_000;
    await settle(n);
    expect(sent).toHaveLength(0);
    stop();

    // Restart: the same wait keeps its record; a wait that started while the daemon was down opens a normal one.
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "review" });
    heard = [];
    n = make();
    n.helper.setSink(sink(heard));
    stop = n.start();
    expect(heard).toEqual(["restart"]);
    expect(n.helper.waits.open().map((r) => r.ticketId).sort()).toEqual([ticket.id, other.id].sort());
    expect(n.helper.waits.open().find((r) => r.ticketId === other.id)?.fallbackAt).not.toBeNull();
    stop();

    // Corrupt: set aside, current waits get normal records (not seeded).
    writeFileSync(join(store.root, "waits.json"), "garbage");
    heard = [];
    n = make();
    n.helper.setSink(sink(heard));
    stop = n.start();
    expect(heard.sort()).toEqual(["restart", "restart"]);
    expect(n.helper.waits.open().every((r) => !r.seeded && r.fallbackAt)).toBe(true);
    stop();
  });

  test("turning the helper off sends what it held as one digest; on again, what is open counts as told", async () => {
    const n = make();
    n.helper.setSink({ healthy: () => true, lastSuccessAt: () => clock, onWait: () => {} });
    const stop = n.start();
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    ask(n, ticket.id, ["Approve the copy?"]);
    ask(n, other.id, ["Which tone?"]);
    await settle(n);
    expect(sent).toHaveLength(0);
    n.update({ helper: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0].init.body).toContain("2 tickets wait on you");
    expect(n.helper.waits.open().every((r) => r.toldVia === "digest")).toBe(true);
    // Off: one notification per wait again.
    const third = store.createTicket("kb", { title: "Logo", body: "b", status: "in_progress" });
    ask(n, third.id, ["Blue or green?"]);
    await settle(n);
    expect(titles().at(-1)).toBe("Blue or green?: Logo");
    n.update({ helper: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(n.helper.waits.open().every((r) => r.toldAt)).toBe(true);
    stop();
  });

  test("several usage limits merge into one line", async () => {
    const n = make();
    const stop = n.start();
    const ts = [ticket, store.createTicket("kb", { title: "B", body: "b", status: "in_progress" }), store.createTicket("kb", { title: "C", body: "b", status: "in_progress" })];
    const resetAt = new Date(2026, 10, 9, 15, 0).toISOString();
    for (const t of ts) {
      bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", t.id, { status: "review", outcome: "limit", limit: { resetAt, auto: false, at: "", message: "" } }) });
      await settle(n);
    }
    expect(sent).toHaveLength(1);
    clock += 60_000;
    await settle(n);
    expect(sent).toHaveLength(2);
    expect(titles()[1]).toBe("Usage limit: 3 tickets paused until 15:00");
    expect(sent[1].init.body).toBe("Usage limit: 3 tickets paused until 15:00\n- Pricing (Kanban)\n- B (Kanban)\n- C (Kanban)");
    stop();
  });

  test("notify_user with the helper on is passed to it, logged, and its 10-minute limit survives a restart", async () => {
    const n = make();
    const heard: WaitRecord[] = [];
    n.helper.setSink({ healthy: () => true, lastSuccessAt: () => null, onWait: (r) => heard.push(r) });
    const r = await n.message("kb", ticket.id, "Pick A or B", { urgent: true, why: "launch is at 3" });
    expect(r).toMatchObject({ delivered: true, helper: true });
    expect(sent).toHaveLength(0);
    expect(heard[0]).toMatchObject({ kind: "message", question: "Pick A or B", urgent: true, why: "launch is at 3" });
    expect(store.listComments("kb", ticket.id).map((c) => c.text)).toEqual(["Passed to the helper: Pick A or B"]);
    const again = make();
    await expect(again.message("kb", ticket.id, "Still A or B?")).rejects.toMatchObject({ status: 429 });
    // Opening the ticket closes the passed-on message and stops reminders.
    expect(again.opened("kb", ticket.id)).toBe(false);
    expect(again.helper.waits.open()).toEqual([]);
  });

  test("a pending reminder: opening the ticket reports it (markSeen skips its throttle) and stops it", () => {
    const n = make();
    const rec = n.helper.waits.add({ board: "kb", ticketId: ticket.id, kind: "questions", identity: "q:x", question: "Stop it?", label: "Answer 1 question", since: "s" });
    n.helper.waits.update(rec.key, { reminders: [{ channel: "push", dueAt: new Date(clock).toISOString(), sentAt: new Date(clock).toISOString() }, { channel: "webhook", dueAt: new Date(clock + 5 * 60_000).toISOString() }] });
    expect(n.helper.waits.hasPendingReminder("kb", ticket.id)).toBe(true);
    expect(n.opened("kb", ticket.id)).toBe(true);
    const after = n.helper.waits.get(rec.key)!;
    expect(after.openedAt).not.toBeNull();
    expect(after.remindersStopped).toBe("opened");
    expect(after.reminders).toHaveLength(1);
    expect(n.helper.waits.hasPendingReminder("kb", ticket.id)).toBe(false);
    expect(JSON.parse(readFileSync(join(store.root, "waits.json"), "utf8")).records[rec.key].openedAt).toBe(after.openedAt);
  });
});
