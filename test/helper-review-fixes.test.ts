// The phase 1 review's findings (reminder races, one alert per wait, helper off mid-run, claims before sends,
// records normalised on load, decision checks). Each test failed before its fix.
import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import type { Channel } from "../src/server/helper/channels";
import { checkDecision, type CheckContext, type ItemState } from "../src/server/helper/decide";
import { HelperRunner } from "../src/server/helper/runner";
import { normalizeRecords } from "../src/server/helper/waits";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const DAY = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();
const NIGHT = { start: "22:00", end: "07:00" };

describe("decision checks", () => {
  const st = (o: Partial<ItemState> = {}): ItemState => ({ open: true, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null, ...o });
  const ctx = (): CheckContext => ({
    now: DAY(14, 10), night: NIGHT, nightOptIn: false, channels: ["mac", "webhook", "push", "telegram"], on: ["mac", "push", "telegram"],
    items: new Map([
      ["a", st()], ["exp", st({ told: true, stopped: "expired" })], ["op", st({ told: true, stopped: "opened" })],
      ["seen", st({ opened: true })], ["done", st({ told: true, alerted: true })], ["off", st({ told: true, stopped: "off" })],
    ]),
  });
  test("one urgent alert per wait: none after it reached the user, after opening, expiry or helper off; a key named twice counts once; an empty oneLine is noted", () => {
    const r = checkDecision({ sends: [{ level: "urgent", oneLine: "", why: "", itemKeys: ["a", "a", "exp", "op", "seen", "done", "off"], escalation: [] }], nextWakeIn: 5, notes: "", log: "" }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.sends.map((s) => s.keys)).toEqual([["a"]]);
    expect(r.decision.fixes).toContain("dropped item a named twice in one send");
    expect(r.decision.fixes.some((f) => f.includes("no oneLine"))).toBe(true);
  });
  test("a summary may still name an opened or expired wait", () => {
    const r = checkDecision({ sends: [{ level: "summary", oneLine: "x", why: "", itemKeys: ["a", "exp", "seen"], escalation: [] }], nextWakeIn: 5, notes: "", log: "" }, ctx());
    expect(r.ok && r.decision.sends[0].keys).toEqual(["a", "exp", "seen"]);
  });
});

test("records are normalised on load: a missing reminders field or junk entries can't break every tick", () => {
  const out = normalizeRecords({ ok: { board: "kb", ticketId: "t1", kind: "failed", queuedAt: "2026-11-09T10:00:00Z" }, junk: 5, half: { board: "kb" } });
  expect(Object.keys(out)).toEqual(["ok"]);
  expect(out.ok).toMatchObject({ key: "ok", reminders: [], toldAt: null, closedAt: null, fallbackAt: null, digestAt: null, since: "2026-11-09T10:00:00Z" });
});

describe("helper runner", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let hooks: { title: string; body: string }[];
  let tg: { text: string; ok: boolean }[];
  let tgOk: boolean;
  let tgHook: ((m: any) => void | Promise<void>) | null;
  let summaries: Map<string, SessionSummary>;
  let answers: (SideCallResult | ((i: SideCallInput) => SideCallResult | Promise<SideCallResult>))[];
  let ticket: Ticket;
  let n: Notifier;
  let h: HelperRunner;

  const telegram: Channel = {
    name: "telegram", enabled: () => true,
    async send(m) {
      await tgHook?.(m);
      tg.push({ text: m.text, ok: tgOk });
      return { channel: "telegram", ok: tgOk, error: tgOk ? null : "telegram down" };
    },
  };
  const make = () => {
    n = new Notifier(store, bus, {
      root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.ts.net", debounceMs: 1000, tickMs: 3600_000, now: () => clock, telegramPoll: false,
      fetch: async (_url, init) => {
        const hd = init.headers as Record<string, string>;
        hooks.push({ title: hd.Title, body: String(init.body) });
        return new Response("ok");
      },
      banner: () => {},
    });
    n.helper.channels.register(telegram);
    h = new HelperRunner({
      root: store.root, store, core: n.helper, notifySettings: () => n.settings(), link: (s, id) => n.link(s, id), messageLink: (id) => n.messageLink(id), now: () => clock,
      sideCall: async (i) => {
        const a = answers.shift();
        if (!a) return { ok: false, error: "no answer queued" };
        return typeof a === "function" ? a(i) : a;
      },
    });
    return n.start();
  };
  const answer = (d: object): SideCallResult => ({ ok: true, text: JSON.stringify({ sends: [], nextWakeIn: 60, notes: "", log: "ok", ...d }), costUsd: 0.02, model: "sonnet" });
  const ask = (id: string, questions: string[], extra?: { urgent?: boolean; why?: string }) => {
    summaries.set(`s_${id}`, {
      title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: questions.length,
      openForm: questions.map((q) => ({ question: q, options: [], multiSelect: false })), ...(extra ? { openAsk: extra } : {}),
      pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
    } as SessionSummary);
    const t = store.updateTicket("kb", id, { status: "planning", sessionId: `s_${id}` });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: t });
  };
  const settle = async () => {
    n.tick();
    clock += 1000;
    n.tick();
    await new Promise((r) => setTimeout(r, 5));
  };
  const keyOf = (id: string) => n.helper.waits.open().find((r) => r.ticketId === id)!.key;
  const urgentAns = (key: string, esc = [{ channel: "telegram", afterMin: 0 }, { channel: "webhook", afterMin: 5 }], oneLine = "Stop it") =>
    answer({ sends: [{ level: "urgent", oneLine, why: "billed twice", itemKeys: [key], escalation: esc }] });
  const wakeNow = async () => { clock += 31 * 60_000; h.requestWake(clock); await h.tick(); };
  const urgentWait = async () => {
    clock += 2 * 60_000;
    ask(ticket.id, ["Stop the old webhook?"], { urgent: true, why: "x" });
    await settle();
    return keyOf(ticket.id);
  };
  const stillPending = (key: string) => n.helper.waits.get(key)!.reminders.some((x) => !x.sentAt);

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = DAY(14, 0);
    hooks = [];
    tg = [];
    tgOk = true;
    tgHook = null;
    summaries = new Map();
    answers = [];
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z", nightNoticeAt: "2026-11-01T00:00:00Z" }));
  });

  // Finding 1: the plan was written after the send from a stale copy, undoing what the user did meanwhile.
  test("opening the ticket while the urgent alert is being sent stops its reminders", async () => {
    const stop = make();
    const key = await urgentWait();
    tgHook = () => { n.opened("kb", ticket.id); };
    answers.push(urgentAns(key));
    await h.tick();
    const r = n.helper.waits.get(key)!;
    expect(r.remindersStopped).toBe("opened");
    expect(stillPending(key)).toBe(false);
    expect(r.reminders[0]).toMatchObject({ channel: "telegram", sentAt: expect.any(String) });
    stop();
  });

  test("Got it tapped while the urgent alert is being sent stops its reminders", async () => {
    const stop = make();
    const key = await urgentWait();
    let reply = "";
    tgHook = (m) => { reply = h.gotIt(m.messageId).text; };
    answers.push(urgentAns(key));
    await h.tick();
    expect(reply).toBe("Got it: no more reminders for Pricing");
    expect(n.helper.waits.get(key)!.remindersStopped).toBe("got-it");
    expect(stillPending(key)).toBe(false);
    stop();
  });

  // Finding 2: the cap is per wait; no new alert after the last step or after opening.
  test("after the last step the wait is expired and the helper can't alert it again", async () => {
    const stop = make();
    const key = await urgentWait();
    answers.push(urgentAns(key));
    await h.tick();
    clock += 6 * 60_000;
    await h.tick();
    expect(n.helper.waits.get(key)!.remindersStopped).toBe("expired");
    const sent = tg.length + hooks.length;
    // Told and expired: nothing left for the helper, so the wake makes no model call and sends nothing.
    const queued = answers.length;
    answers.push(urgentAns(key));
    await wakeNow();
    expect(stillPending(key)).toBe(false);
    expect(tg.length + hooks.length).toBe(sent);
    expect(answers.length).toBe(queued + 1);
    expect(h.status().runs.at(-1)).toMatchObject({ ok: true, skipped: true });
    // With something else to look at, the helper is asked, and the board still refuses to alert the expired wait.
    const other = store.createTicket("kb", { title: "Other", body: "b", status: "in_progress" });
    ask(other.id, ["Ship it?"]);
    await settle();
    await wakeNow();
    expect(answers.length).toBe(queued);
    expect(tg.length + hooks.length).toBe(sent);
    expect(h.status().runs.at(-1)!.fixes!.join(" ")).toContain("expired");
    stop();
  });

  test("an urgent alert on a wait a summary already told that reaches no channel is retried by the next wake", async () => {
    const stop = make();
    clock += 2 * 60_000;
    ask(ticket.id, ["Stop the old webhook?"]);
    await settle();
    const key = keyOf(ticket.id);
    clock += 60_000;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "1 waits", why: "", itemKeys: [key], escalation: [] }], nextWakeIn: 24 * 60 }));
    await h.tick();
    expect(n.helper.waits.get(key)!.toldVia).toBe("helper");
    // A new question wakes the helper, which escalates the told wait; every channel fails.
    const other = store.createTicket("kb", { title: "Other", body: "b", status: "in_progress" });
    ask(other.id, ["Ship it?"]);
    await settle();
    tgOk = false;
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "", mac: false }));
    answers.push(urgentAns(key, [{ channel: "telegram", afterMin: 0 }]));
    await wakeNow();
    expect(n.helper.waits.get(key)!.reminders.some((x) => x.failed)).toBe(true);
    // The other ticket stops waiting; the retry wake still asks the helper (the told wait isn't "nothing to do").
    store.updateTicket("kb", other.id, { status: "done" });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.getTicket("kb", other.id)! });
    await settle();
    tgOk = true;
    const reached = tg.filter((x) => x.ok).length;
    const queued = answers.length;
    answers.push(urgentAns(key, [{ channel: "telegram", afterMin: 0 }]));
    await wakeNow();
    expect(answers.length).toBe(queued);
    expect(tg.filter((x) => x.ok)).toHaveLength(reached + 1);
    expect(n.helper.messages.listNewest()[0].level).toBe("urgent");
    stop();
  });

  test("an opened wait gets no new urgent alert", async () => {
    const stop = make();
    const key = await urgentWait();
    answers.push(urgentAns(key));
    await h.tick();
    n.opened("kb", ticket.id);
    answers.push(urgentAns(key));
    await wakeNow();
    expect(n.helper.waits.get(key)!.remindersStopped).toBe("opened");
    expect(stillPending(key)).toBe(false);
    stop();
  });

  test("an alert that reached no one may be retried, within what is left of the wait's 2 hours and 6 steps", async () => {
    const stop = make();
    const key = await urgentWait();
    tgOk = false;
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "", mac: false }));
    answers.push(urgentAns(key, [{ channel: "telegram", afterMin: 0 }]));
    await h.tick();
    let r = n.helper.waits.get(key)!;
    expect(r.toldAt).toBeNull();
    expect(r.digestAt).not.toBeNull();
    const until = r.remindUntil;
    tgOk = true;
    clock += 10 * 60_000;
    const esc = Array.from({ length: 6 }, (_, i) => ({ channel: "telegram", afterMin: i * 10 }));
    answers.push(urgentAns(key, esc));
    h.requestWake(clock);
    await h.tick();
    r = n.helper.waits.get(key)!;
    expect(r.toldAt).not.toBeNull();
    expect(r.remindUntil).toBe(until);
    expect(r.stepsUsed).toBe(1);
    // 6 steps per wait: the failed alert used one, so this plan keeps 5.
    expect(r.reminders).toHaveLength(5);
    stop();
  });

  // Finding 3: helper turned off while the model thinks.
  test("helper turned off during a wake's model call: nothing more goes out after the off digest", async () => {
    const stop = make();
    const key = await urgentWait();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answers.push(async () => {
      await gate;
      return urgentAns(key, [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 5 }]);
    });
    const p = h.tick();
    await new Promise((r) => setTimeout(r, 5));
    n.update({ helper: false });
    await new Promise((r) => setTimeout(r, 5));
    const afterOff = hooks.length + tg.length;
    release();
    await p;
    expect(hooks.length + tg.length).toBe(afterOff);
    expect(n.helper.waits.get(key)!.reminders).toEqual([]);
    stop();
  });

  // Finding 4: claim before the send.
  test("the 2-hour digest coming due while the helper's summary is being sent doesn't tell the wait twice", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    const key = keyOf(ticket.id);
    clock += 60_000;
    answers.push(answer({ nextWakeIn: 119, log: "hold" }));
    await h.tick();
    clock = Date.parse(n.helper.waits.get(key)!.digestAt!) - 30_000;
    let slow!: () => void;
    const gate = new Promise<void>((r) => (slow = r));
    tgHook = () => gate;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "1 ticket waits", why: "", itemKeys: [key], escalation: [] }] }));
    const p = h.wake();
    await new Promise((r) => setTimeout(r, 20));
    clock += 60_000;
    await n.helper.tick();
    slow();
    await p;
    const named = n.helper.messages.listNewest().filter((m) => m.items.some((i) => i.key === key));
    expect(named.map((m) => m.level)).toEqual(["summary"]);
    stop();
  });

  test("a summary that reached no channel gives its claim back: the wait stays untold for the next message or the digest", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    const key = keyOf(ticket.id);
    const digestAt = n.helper.waits.get(key)!.digestAt;
    tgOk = false;
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "", mac: false }));
    clock += 60_000;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "", why: "", itemKeys: [key], escalation: [] }] }));
    await h.tick();
    const r = n.helper.waits.get(key)!;
    expect(r.toldAt).toBeNull();
    expect(r.digestAt).toBe(digestAt);
    // The empty oneLine got the board's own line (after the board's count).
    expect(n.helper.messages.listNewest().find((m) => m.level === "summary")!.oneLine).toBe("1 new for you: Approve the copy?: Pricing");
    stop();
  });

  // Finding 6.
  test("a waits file with a record missing its reminders doesn't make ticks throw", async () => {
    writeFileSync(join(store.root, "waits.json"), JSON.stringify({ version: 1, records: { "kb/x|failed": { key: "kb/x|failed", board: "kb", ticketId: "x", kind: "failed", closedAt: null, toldAt: null, queuedAt: new Date(clock).toISOString(), fallbackAt: new Date(clock).toISOString() } }, notifyUserAt: {} }));
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 10 * 60_000;
    await n.helper.tick();
    await h.tick();
    stop();
  });
});
