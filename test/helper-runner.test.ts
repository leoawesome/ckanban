import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { checkDecision, channelFor, parseDecision, type CheckContext, type ItemState } from "../src/server/helper/decide";
import { backoffMs, HelperRunner, keptQuietLine, lookBeforeDigest, meetingTime } from "../src/server/helper/runner";
import { HelperSettingsStore, inNight, morningDigestAt, nightEnd } from "../src/server/helper/settings";
import type { Channel } from "../src/server/helper/channels";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { parseSideResult, sideCallArgs, type SideCallInput, type SideCallResult } from "../src/server/side-call";
import { SpendIndex } from "../src/server/spend";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

const DAY = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();
const NIGHT = { start: "22:00", end: "07:00" };

describe("night window", () => {
  test("wraps midnight; ends in the morning", () => {
    expect(inNight(DAY(23), NIGHT)).toBe(true);
    expect(inNight(DAY(3), NIGHT)).toBe(true);
    expect(inNight(DAY(7), NIGHT)).toBe(false);
    expect(inNight(DAY(14), NIGHT)).toBe(false);
    expect(nightEnd(DAY(23), NIGHT)).toBe(new Date(2026, 10, 10, 7, 0).getTime());
    expect(nightEnd(DAY(3), NIGHT)).toBe(DAY(7));
    expect(nightEnd(DAY(14), NIGHT)).toBe(DAY(14));
    expect(inNight(DAY(13), { start: "12:00", end: "14:00" })).toBe(true);
  });

  test("a digest the night holds goes 30 minutes after it ends; the look before it is at the night's end", () => {
    const next7 = new Date(2026, 10, 10, 7, 0).getTime();
    expect(morningDigestAt(DAY(23), NIGHT)).toBe(next7 + 30 * 60_000);
    expect(morningDigestAt(DAY(3), NIGHT)).toBe(DAY(7, 30));
    expect(morningDigestAt(DAY(14), NIGHT)).toBe(DAY(14));
    // 5 minutes before a 7:30 digest is 7:25: the helper looks at 7:00 instead, so its morning summary goes first.
    expect(lookBeforeDigest(DAY(7, 25), NIGHT)).toBe(DAY(7));
    expect(lookBeforeDigest(DAY(3), NIGHT)).toBe(DAY(7));
    expect(lookBeforeDigest(DAY(23), NIGHT)).toBe(next7);
    expect(lookBeforeDigest(DAY(7, 40), NIGHT)).toBe(DAY(7, 40));
    expect(lookBeforeDigest(DAY(14), NIGHT)).toBe(DAY(14));
  });

  test("settings: defaults, checks, feedback list", () => {
    const s = new HelperSettingsStore(tempDir());
    expect(s.get()).toMatchObject({ model: "sonnet", night: NIGHT, nightOptIn: null, feedback: [] });
    expect(() => s.update({ model: "opus" })).toThrow("model");
    expect(() => s.update({ night: { start: "25:00", end: "07:00" } })).toThrow("night start");
    expect(s.update({ model: "haiku", night: { start: "23:30", end: "6:00" }, nightOptIn: true })).toMatchObject({ model: "haiku", night: { start: "23:30", end: "06:00" }, nightOptIn: true });
    const l = s.addFeedback("  Pricing is always urgent ");
    expect(l.text).toBe("Pricing is always urgent");
    expect(() => s.addFeedback("")).toThrow("required");
    expect(s.removeFeedback(l.id)).toBe(true);
    expect(s.get().feedback).toEqual([]);
  });
});

test("prep items leave at their meeting time: creation day, or the next day when HH:MM is earlier", () => {
  const created = new Date(2026, 10, 9, 9, 0).toISOString();
  expect(meetingTime("Prep: client call at 10:30", created)).toBe(DAY(10, 30));
  expect(meetingTime("Prep: standup at 8:15", created)).toBe(new Date(2026, 10, 10, 8, 15).getTime());
  expect(meetingTime("Reply to Anna", created)).toBeNull();
});

describe("the board's checks on a decision (table)", () => {
  const st = (o: Partial<ItemState> = {}): ItemState => ({ open: true, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null, ...o });
  const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({
    now: DAY(14, 10), night: NIGHT, nightOptIn: false, channels: ["mac", "webhook", "push", "telegram"], on: ["mac", "push", "telegram"],
    items: new Map([["a", st()], ["b", st()], ["told", st({ told: true })], ["snz", st({ snoozed: true })], ["got", st({ told: true, stopped: "got-it" })], ["run", st({ told: true, pendingReminders: true })], ["checkin:kb/t9", st({ checkin: true })]]),
    ...o,
  });
  const urgent = (o: object = {}) => ({ level: "urgent", oneLine: "Stop the webhook", why: "billed twice", itemKeys: ["a"], escalation: [{ channel: "push", afterMin: 0 }, { channel: "telegram", afterMin: 5 }], ...o });
  const dec = (sends: object[], o: object = {}) => ({ sends, nextWakeIn: 30, notes: "n", log: "l", ...o });

  const rows: [string, unknown, Partial<CheckContext>, (r: ReturnType<typeof checkDecision>) => void][] = [
    ["bad shape fails the run", { sends: "x" }, {}, (r) => expect(r.ok).toBe(false)],
    ["missing nextWakeIn fails the run", { sends: [] }, {}, (r) => expect(r.ok).toBe(false)],
    ["unknown keys are dropped; a send left empty is dropped", dec([urgent({ itemKeys: ["nope"] })]), {}, (r) => expect(r.ok && r.decision.sends).toEqual([])],
    ["snoozed keys are dropped", dec([{ ...urgent(), level: "summary", itemKeys: ["snz", "b"] }]), {}, (r) => expect(r.ok && r.decision.sends[0].keys).toEqual(["b"])],
    ["no re-alert after Got it, none while reminders run, no urgent check-ins", dec([urgent({ itemKeys: ["got", "run", "checkin:kb/t9"] })]), {}, (r) => expect(r.ok && r.decision.sends).toEqual([])],
    ["urgent first step moves to minute 0", dec([urgent({ escalation: [{ channel: "push", afterMin: 3 }] })]), {}, (r) => expect(r.ok && r.decision.sends[0].steps).toEqual([{ channel: "push", afterMin: 0 }])],
    ["5-minute floor between steps", dec([urgent({ escalation: [{ channel: "push", afterMin: 0 }, { channel: "telegram", afterMin: 1 }, { channel: "push", afterMin: 2 }] })]), {},
      (r) => expect(r.ok && r.decision.sends[0].steps.map((s) => s.afterMin)).toEqual([0, 5, 10])],
    ["30-minute floor at night (with opt-in)", dec([urgent()]), { now: DAY(23), nightOptIn: true }, (r) => expect(r.ok && r.decision.sends[0].steps.map((s) => s.afterMin)).toEqual([0, 30])],
    ["urgent at night without opt-in is held", dec([urgent()]), { now: DAY(23) }, (r) => expect(r.ok && r.decision.sends).toEqual([])],
    ["a summary at night is held, even with the night opt-in", dec([urgent(), { ...urgent(), level: "summary", itemKeys: ["b"] }]), { now: DAY(3), nightOptIn: true },
      (r) => expect(r.ok && r.decision.sends.map((x) => x.level)).toEqual(["urgent"])],
    ["off channel falls to the next one on", dec([urgent({ escalation: [{ channel: "webhook", afterMin: 0 }] })]), {}, (r) => expect(r.ok && r.decision.sends[0].steps[0].channel).toBe("push")],
    ["empty escalation: one step on the first channel on", dec([urgent({ escalation: [] })]), {}, (r) => expect(r.ok && r.decision.sends[0].steps).toEqual([{ channel: "mac", afterMin: 0 }])],
    ["at most 6 steps within 2 hours", dec([urgent({ escalation: Array.from({ length: 10 }, (_, i) => ({ channel: "push", afterMin: i * 20 })) })]), {},
      (r) => expect(r.ok && r.decision.sends[0].steps.map((s) => s.afterMin)).toEqual([0, 20, 40, 60, 80, 100])],
    ["next wake between 1 minute and 24 hours", dec([], { nextWakeIn: 0.1 }), {}, (r) => expect(r.ok && r.decision.nextWakeAt).toBe(DAY(14, 11))],
    ["next wake at most 24 hours", dec([], { nextWakeIn: 99999 }), {}, (r) => expect(r.ok && r.decision.nextWakeAt).toBe(DAY(14, 10) + 24 * 3600_000)],
    ["oneLine cut at about 110 characters", dec([urgent({ oneLine: "x".repeat(300) })]), {}, (r) => expect(r.ok && r.decision.sends[0].oneLine.length).toBeLessThanOrEqual(110)],
    ["a summary with nothing new is dropped", dec([{ ...urgent(), level: "summary", itemKeys: ["told"] }]), {}, (r) => expect(r.ok && r.decision.sends).toEqual([])],
    ["an item named twice goes with the urgent send", dec([{ ...urgent(), level: "summary", itemKeys: ["a", "b"] }, urgent()]), {},
      (r) => expect(r.ok && r.decision.sends.map((s) => [s.level, s.keys])).toEqual([["urgent", ["a"]], ["summary", ["b"]]])],
    ["no channel on: the alert is only stored", dec([urgent()]), { on: [] }, (r) => expect(r.ok && r.decision.sends[0].steps).toEqual([])],
  ];
  for (const [name, raw, o, check] of rows) test(name, () => check(checkDecision(raw, ctx(o))));

  test("channel fallback order wraps; bad JSON is a failed run", () => {
    expect(channelFor("telegram", ["mac", "webhook", "push", "telegram"], ["mac"])).toBe("mac");
    expect(channelFor("x", ["mac"], [])).toBeNull();
    expect(parseDecision("not json").ok).toBe(false);
    expect(parseDecision('```json\n{"sends":[]}\n```').ok).toBe(true);
  });
});

test("side call: --json-schema, and the answer read from structured_output", () => {
  const args = sideCallArgs({ prompt: "p", system: "s", jsonSchema: { type: "object" } });
  expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  const r = parseSideResult(JSON.stringify({ result: "", structured_output: { sends: [] }, total_cost_usd: 0.02 }), 0, "", "sonnet");
  expect(r).toEqual({ ok: true, text: '{"sends":[]}', costUsd: 0.02, model: "sonnet" });
});

describe("helper runner", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let hooks: { title: string; body: string; priority?: string }[];
  let tg: { text: string; ok: boolean }[];
  let tgOk: boolean;
  let hookOk: boolean;
  let snoozes: Map<string, string>;
  let summaries: Map<string, SessionSummary>;
  let calls: SideCallInput[];
  let answers: (SideCallResult | ((i: SideCallInput) => SideCallResult))[];
  let ticket: Ticket;
  let n: Notifier;
  let h: HelperRunner;

  const telegram: Channel = {
    name: "telegram", enabled: () => true,
    async send(m) {
      tg.push({ text: m.text, ok: tgOk });
      return { channel: "telegram", ok: tgOk, error: tgOk ? null : "telegram down" };
    },
  };
  const make = () => {
    n = new Notifier(store, bus, {
      root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.ts.net", debounceMs: 1000, tickMs: 3600_000, now: () => clock,
      fetch: async (_url, init) => {
        const hd = init.headers as Record<string, string>;
        hooks.push({ title: hd.Title, body: String(init.body), priority: hd.Priority });
        return hookOk ? new Response("ok") : new Response("down", { status: 500 });
      },
      banner: () => {},
    });
    n.helper.channels.register(telegram);
    h = new HelperRunner({
      root: store.root, store, core: n.helper, notifySettings: () => n.settings(), link: (s, id) => n.link(s, id), messageLink: (id) => n.messageLink(id), now: () => clock,
      snoozedUntil: (_b, id) => snoozes.get(id) ?? null,
      sideCall: async (i) => {
        calls.push(i);
        const a = answers.shift();
        if (!a) return { ok: false, error: "no answer queued" };
        return typeof a === "function" ? a(i) : a;
      },
    });
    return n.start();
  };
  const answer = (d: object, costUsd = 0.02): SideCallResult => ({ ok: true, text: JSON.stringify({ sends: [], nextWakeIn: 60, notes: "", log: "ok", ...d }), costUsd, model: "sonnet" });
  const summary = (questions: string[], ask?: { urgent?: boolean; why?: string }): SessionSummary => ({
    title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: questions.length,
    openForm: questions.map((q) => ({ question: q, options: [], multiSelect: false })), ...(ask ? { openAsk: ask } : {}),
    pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
  } as SessionSummary);
  const ask = (id: string, questions: string[], extra?: { urgent?: boolean; why?: string }) => {
    summaries.set(`s_${id}`, summary(questions, extra));
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

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = DAY(14, 0);
    hooks = [];
    tg = [];
    tgOk = true;
    hookOk = true;
    snoozes = new Map();
    summaries = new Map();
    calls = [];
    answers = [];
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
    // Not a first run: the hello went out before.
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z" }));
  });

  test("a new wait batches about a minute; nothing waiting skips the model call", async () => {
    const stop = make();
    await h.tick();
    expect(calls).toHaveLength(0);
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    expect(h.dueAt()).toBe(clock + 60_000);
    await h.tick();
    expect(calls).toHaveLength(0);
    clock += 60_000;
    answers.push(answer({ nextWakeIn: 120, log: "held the copy question" }));
    await h.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "sonnet", jsonSchema: expect.any(Object) });
    const input = JSON.parse(calls[0].prompt);
    expect(input.items[0]).toMatchObject({ key: keyOf(ticket.id), ticket: "Pricing", question: "Approve the copy?", new: true, told: "no" });
    // Held: no send, the Inbox line says until when, the log has a held entry.
    expect(hooks).toHaveLength(0);
    expect(h.status().lines[`kb/${ticket.id}`]).toBe("In the 16:01 summary: Approve the copy?");
    const note = n.helper.messages.listNewest({ held: true })[0];
    expect(note).toMatchObject({ held: true, level: "routine", oneLine: "Kept quiet: 1 ticket, nothing urgent. It'll be in the next summary, by 16:01." });
    // The helper's own log line stays in the full text, not the one-liner.
    expect(note.text.split("\n")[0]).toBe("held the copy question");
    // The ticket stops waiting: the next wake has nothing to look at, so no model call.
    store.updateTicket("kb", ticket.id, { status: "done" });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.getTicket("kb", ticket.id)! });
    await settle();
    clock += 3 * 3600_000;
    await h.tick();
    expect(calls).toHaveLength(1);
    expect(h.status().runs.at(-1)).toMatchObject({ ok: true, skipped: true });
    stop();
  });

  test("an asker's urgent mark wakes at once; the urgent alert names its next step; reminders fire, fail over, and stop on Got it", async () => {
    const stop = make();
    // Loop guard: a run a moment ago holds the next wake for a minute.
    clock += 2 * 60_000;
    ask(ticket.id, ["Stop the old webhook?"], { urgent: true, why: "pricing data ingested twice" });
    await settle();
    const key = keyOf(ticket.id);
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Pricing ingests data twice until you answer", why: "double ingestion", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "telegram", afterMin: 5 }, { channel: "webhook", afterMin: 10 }] }] }));
    await h.tick();
    expect(calls).toHaveLength(1);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].priority).toBe("5");
    const alert = n.helper.messages.listNewest()[0];
    expect(alert.level).toBe("urgent");
    expect(alert.text).toContain("Next: I'll remind you on Telegram at 14:07, until 16:02 at most, unless you open it.");
    expect(alert.text).toContain("Right call?");
    expect(n.helper.waits.get(key)).toMatchObject({ toldVia: "helper", messageId: alert.id });
    expect(h.status().lines[`kb/${ticket.id}`]).toBe("Urgent: ntfy 14:02, Telegram 14:07, ntfy 14:12");
    expect(h.wantsAwake()).toBe(true);
    // Step 2 on Telegram, which fails: it moves on to the next channel at once.
    tgOk = false;
    clock += 5 * 60_000;
    await h.tick();
    expect(tg).toHaveLength(1);
    expect(hooks).toHaveLength(2);
    expect(n.helper.messages.listNewest()[0]).toMatchObject({ level: "reminder" });
    expect(n.helper.messages.listNewest()[0].sends.map((s) => [s.channel, s.ok])).toEqual([["telegram", false], ["webhook", true]]);
    // Got it: no more reminders, not even at the next step.
    const r = h.gotIt(alert.id);
    expect(r.stopped).toBe(1);
    clock += 10 * 60_000;
    await h.tick();
    expect(hooks).toHaveLength(2);
    expect(h.status().lines[`kb/${ticket.id}`]).toContain("you tapped Got it");
    stop();
  });

  test("reminders stop on opening the ticket, on Not urgent, and expire after 2 hours with one message", async () => {
    const stop = make();
    const other = store.createTicket("kb", { title: "Billing", body: "b", status: "in_progress" });
    ask(ticket.id, ["Stop the old webhook?"]);
    ask(other.id, ["Refund the customer?"]);
    await settle();
    const [a, b] = [keyOf(ticket.id), keyOf(other.id)];
    const steps = [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 30 }, { channel: "webhook", afterMin: 200 }];
    answers.push(answer({ sends: [
      { level: "urgent", oneLine: "Webhook", why: "w", itemKeys: [a], escalation: steps },
      { level: "urgent", oneLine: "Refund", why: "r", itemKeys: [b], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 100 }] },
    ] }));
    clock += 60_000;
    await h.tick();
    expect(hooks).toHaveLength(2);
    // Opening the ticket stops its reminders.
    expect(n.opened("kb", ticket.id)).toBe(true);
    expect(n.helper.waits.get(a)?.remindersStopped).toBe("opened");
    // Not urgent stops the other's at once.
    const msgB = n.helper.waits.get(b)!.messageId!;
    expect(h.notUrgent(msgB).text).toBe("Stopped reminders for Billing");
    clock += 3 * 3600_000;
    await h.tick();
    expect(hooks).toHaveLength(2);

    // Expiry: an alert whose plan runs past 2 hours ends with "I've stopped reminding you".
    const third = store.createTicket("kb", { title: "Deploy", body: "b", status: "in_progress" });
    ask(third.id, ["Roll back?"]);
    await settle();
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Prod down", why: "x", itemKeys: [keyOf(third.id)], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 110 }] }] }));
    clock += 61_000;
    await h.tick();
    expect(hooks).toHaveLength(3);
    clock += 125 * 60_000;
    await h.tick();
    expect(n.helper.messages.listNewest()[0].oneLine).toBe("I've stopped reminding you: Deploy");
    expect(n.helper.waits.get(keyOf(third.id))?.remindersStopped).toBe("expired");
    stop();
  });

  test("summaries: short (new rows, still waiting counted), at most every 3 hours, nothing new means no summary, check-ins named once", async () => {
    const stop = make();
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    answers.push(answer({ sends: [{ level: "summary", oneLine: "1 waits: copy question", why: "the copy question is new", itemKeys: [keyOf(ticket.id)], escalation: [] }] }));
    clock += 60_000;
    await h.tick();
    expect(hooks.map((x) => x.title)).toEqual(["1 ticket waits on you"]);
    const first = n.helper.messages.listNewest()[0];
    // No "Why now", no links in the text; the page gets rows.
    expect(first.text).toBe("1 waits on you: copy question\n\n- Pricing: Approve the copy?");
    expect(first.why).toBeNull();
    expect(first.summary).toMatchObject({ new: [{ ticketId: ticket.id, label: "Approve the copy?" }], stillCount: 0 });
    // A check-in raised a prep ticket; a new question arrives.
    store.createTicket("kb", { title: "Prep: client call at 18:30", body: "b", status: "backlog", raisedBy: { scheduleId: "s1", ticketId: "x" } } as any);
    ask(other.id, ["Which tone?"]);
    await settle();
    const all = (i: SideCallInput) => {
      const input = JSON.parse(i.prompt);
      const keys = input.items.filter((x: any) => x.told === "no").map((x: any) => x.key);
      return answer({ sends: [{ level: "summary", oneLine: "2 wait: tone question on Docs", why: "", itemKeys: [...keys, keyOf(ticket.id)], escalation: [] }], nextWakeIn: 600 });
    };
    // 2 minutes after the last summary: the board holds it, and the helper hears when the next may go.
    let seen: any = null;
    answers.push((i) => {
      seen = JSON.parse(i.prompt);
      return all(i);
    });
    clock += 2 * 60_000;
    await h.tick();
    expect(hooks).toHaveLength(1);
    const gapEnd = Date.parse(first.at) + 3 * 3600_000;
    expect(seen.nextSummaryAt).toBe(new Date(gapEnd).toString());
    expect(h.status().runs.at(-1)!.fixes!.some((f) => f.startsWith("held a summary: the last one went out under 3 hours ago"))).toBe(true);
    // It looks again when the gap ends (not at its own 10 hours), and the items are held until then.
    expect(h.dueAt()).toBe(gapEnd);
    expect(n.helper.waits.get(keyOf(other.id))).toMatchObject({ toldAt: null, heldUntil: new Date(gapEnd).toISOString() });
    clock = gapEnd;
    answers.push(all);
    await h.tick();
    expect(hooks).toHaveLength(2);
    const m = n.helper.messages.listNewest()[0];
    expect(m.level).toBe("summary");
    expect(m.text).toBe("2 wait on you: tone question on Docs\n\n- Docs: Which tone?\n\n1 more still waits on you, oldest from 9 Nov.\n\nFrom your check-ins:\n- Prep: client call at 18:30: prep ready");
    expect(m.summary).toMatchObject({ stillCount: 1, still: [{ ticketId: ticket.id }], checkins: [{ title: "Prep: client call at 18:30" }] });
    expect(hooks.at(-1)!.title).toBe("2 tickets wait on you");
    // Nothing new: the helper's summary is dropped.
    answers.push(answer({ sends: [{ level: "summary", oneLine: "still 2", why: "", itemKeys: [keyOf(ticket.id), keyOf(other.id)], escalation: [] }] }));
    clock += 3 * 3600_000;
    h.requestWake(clock);
    await h.tick();
    expect(hooks).toHaveLength(2);
    expect(h.status().runs.at(-1)!.fixes).toContain("dropped a summary with nothing new");
    stop();
  });

  test("the 3-hour summary gap never holds an urgent alert, and a morning summary isn't held", async () => {
    const stop = make();
    const other = store.createTicket("kb", { title: "Deploy", body: "b", status: "in_progress" });
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    answers.push(answer({ sends: [{ level: "summary", oneLine: "copy question", why: "", itemKeys: [keyOf(ticket.id)], escalation: [] }] }));
    clock += 60_000;
    await h.tick();
    expect(hooks).toHaveLength(1);
    // Minutes later an urgent one: it goes out at once, with its plan.
    ask(other.id, ["Production is down: roll back?"], { urgent: true, why: "customers can't log in" });
    await settle();
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Production is down", why: "customers can't log in", itemKeys: [keyOf(other.id)], escalation: [{ channel: "webhook", afterMin: 0 }] }] }));
    clock += 2 * 60_000;
    await h.tick();
    expect(hooks).toHaveLength(2);
    expect(n.helper.messages.listNewest()[0].level).toBe("urgent");
    expect(n.helper.waits.get(keyOf(other.id))!.toldAt).not.toBeNull();
    stop();
  });

  test("a summary held by the 3-hour gap keeps its wake at the gap's end, even after a later wake asks for 24 hours", async () => {
    const stop = make();
    const b = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    const c = store.createTicket("kb", { title: "Deploy", body: "b", status: "in_progress" });
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    answers.push(answer({ sends: [{ level: "summary", oneLine: "copy", why: "", itemKeys: [keyOf(ticket.id)], escalation: [] }] }));
    clock += 60_000;
    await h.tick();
    const gapEnd = Date.parse(n.helper.messages.listNewest()[0].at) + 3 * 3600_000;
    ask(b.id, ["Which tone?"]);
    await settle();
    answers.push(answer({ sends: [{ level: "summary", oneLine: "tone", why: "", itemKeys: [keyOf(b.id)], escalation: [] }], nextWakeIn: 1440 }));
    clock += 61_000;
    await h.tick();
    expect(hooks).toHaveLength(1);
    // An urgent one comes; the helper asks to look again in 24 hours.
    ask(c.id, ["Production is down: roll back?"], { urgent: true, why: "customers can't log in" });
    await settle();
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Production is down", why: "customers", itemKeys: [keyOf(c.id)], escalation: [{ channel: "webhook", afterMin: 0 }] }], nextWakeIn: 1440 }));
    clock += 61_000;
    await h.tick();
    expect(hooks).toHaveLength(2);
    expect(h.dueAt()).toBe(gapEnd);
    expect(n.helper.waits.get(keyOf(b.id))!.heldUntil).toBe(new Date(gapEnd).toISOString());
    // At the gap's end the held summary goes out (not the board's "didn't tell you in time" digest later).
    clock = gapEnd;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "tone", why: "", itemKeys: [keyOf(b.id)], escalation: [] }] }));
    await h.tick();
    expect(n.helper.messages.listNewest()[0]).toMatchObject({ level: "summary", items: [expect.objectContaining({ ticketId: b.id }), expect.anything(), expect.anything()] });
    expect(n.helper.waits.get(keyOf(b.id))!.toldVia).toBe("helper");
    stop();
  });

  test("a held item gets a look shortly before the 4-hour digest would send it", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    answers.push(answer({ nextWakeIn: 1440, log: "held" }));
    clock += 61_000;
    await h.tick();
    const digest = Date.parse(n.helper.waits.get(keyOf(ticket.id))!.digestAt!);
    expect(h.dueAt()).toBe(digest - 5 * 60_000);
    stop();
  });

  // Items held overnight: one from the evening (its 4-hour digest falls in the night), one from the night.
  const holdOvernight = async () => {
    clock = DAY(19);
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    answers.push(answer({ nextWakeIn: 24 * 60, log: "held" }));
    clock += 61_000;
    await h.tick();
    const morning = new Date(2026, 10, 10, 7, 0).getTime();
    clock = DAY(23);
    ask(other.id, ["Which tone?"]);
    await settle();
    answers.push(answer({ nextWakeIn: 24 * 60, log: "night: held for the morning" }));
    clock += 61_000;
    await h.tick();
    const keys = [keyOf(ticket.id), keyOf(other.id)];
    for (const k of keys) expect(n.helper.waits.get(k)).toMatchObject({ toldAt: null, digestAt: new Date(morning + 30 * 60_000).toISOString() });
    // The helper looks again when the night ends, before the digests.
    expect(h.dueAt()).toBe(morning);
    expect(hooks).toHaveLength(0);
    return { keys, morning };
  };

  test("morning: the helper's summary goes first, even when its call takes a few seconds; no digest", async () => {
    const stop = make();
    const { keys, morning } = await holdOvernight();
    clock = morning;
    // The board checks once a second while the helper's call runs.
    answers.push((async () => {
      for (let i = 0; i < 5; i++) await settle();
      return answer({ sends: [{ level: "summary", oneLine: "2 wait on you", why: "", itemKeys: keys, escalation: [] }], nextWakeIn: 600 });
    }) as any);
    await settle();
    await h.tick();
    // Later in the morning: nothing more.
    for (const t of [7 * 60 + 30, 7 * 60 + 31, 9 * 60]) {
      clock = morning + (t - 7 * 60) * 60_000;
      await settle();
    }
    const sent = n.helper.messages.listNewest().filter((m) => !m.held);
    expect(sent.map((m) => m.level)).toEqual(["summary"]);
    expect(hooks).toHaveLength(1);
    for (const k of keys) expect(n.helper.waits.get(k)!.toldVia).toBe("helper");
    stop();
  });

  test("morning: the helper's call hangs; the digest still goes out 30 minutes after the night ends", async () => {
    const stop = make();
    const { keys, morning } = await holdOvernight();
    clock = morning;
    answers.push((() => new Promise(() => {})) as any);
    void h.tick();
    await settle();
    clock = morning + 29 * 60_000;
    await settle();
    expect(hooks).toHaveLength(0);
    clock = morning + 30 * 60_000;
    await settle();
    expect(n.helper.messages.listNewest().filter((m) => !m.held).map((m) => m.level)).toEqual(["fallback"]);
    expect(hooks).toHaveLength(1);
    for (const k of keys) expect(n.helper.waits.get(k)!.toldVia).toBe("digest");
    stop();
  });

  test("morning: the helper keeps failing; both items still reach the user", async () => {
    const stop = make();
    const { keys, morning } = await holdOvernight();
    for (clock = morning; clock <= morning + 31 * 60_000; clock += 30_000) {
      answers.push({ ok: false, error: "Not logged in" });
      await h.tick();
      await settle();
    }
    for (const k of keys) expect(n.helper.waits.get(k)!.toldAt).not.toBeNull();
    stop();
  });

  test("failures back off 1 to 30 minutes; after 3 the waits go out directly with one pause message", async () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((f) => backoffMs(f) / 60_000)).toEqual([1, 2, 4, 8, 16, 30, 30]);
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 60_000;
    answers.push({ ok: false, error: "Not logged in" });
    await h.tick();
    expect(h.status()).toMatchObject({ failures: 1, failReason: "Not logged in", problem: true });
    // Backoff: not again within the minute.
    clock += 30_000;
    await h.tick();
    expect(calls).toHaveLength(1);
    clock += 31_000;
    answers.push({ ok: true, text: "not json", costUsd: 0.01, model: "sonnet" });
    await h.tick();
    expect(calls).toHaveLength(2);
    expect(h.status().failReason).toContain("not valid JSON");
    clock += 2 * 60_000 + 1000;
    answers.push({ ok: false, error: "timed out" });
    await h.tick();
    expect(calls).toHaveLength(3);
    expect(h.healthy()).toBe(false);
    expect(hooks.map((x) => x.title)).toEqual(["Pricing", "ckanban helper paused"]);
    expect(hooks[0].body).toContain("Approve the copy?");
    expect(h.status().line).toContain("Helper paused");
    // Meanwhile a new wait goes out directly; the pause message isn't sent again.
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    ask(other.id, ["Which tone?"]);
    await settle();
    clock += 10 * 60_000;
    answers.push({ ok: false, error: "timed out" });
    await h.tick();
    expect(hooks.map((x) => x.title)).toEqual(["Pricing", "ckanban helper paused", "Which tone?: Docs"]);
    // It works again: back to the helper, nothing sent twice.
    clock += 30 * 60_000;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "x", why: "", itemKeys: [keyOf(ticket.id)], escalation: [] }] }));
    await h.tick();
    expect(h.healthy()).toBe(true);
    expect(hooks).toHaveLength(3);
    stop();
  });

  test("first run: a hello on the channels, then a summary of the seeded waits; spend has a Helper line", async () => {
    writeFileSync(join(store.root, "helper-state.json"), "{}");
    summaries.set("s1", summary(["Old question?"]));
    store.updateTicket("kb", ticket.id, { status: "planning", sessionId: "s1" });
    const stop = make();
    expect(n.helper.waits.firstSummaryPending).toBe(true);
    expect(h.status().notice).toBe(true);
    answers.push(answer({}, 0.03));
    clock += 60_000;
    await h.tick();
    expect(hooks.map((x) => x.title)).toEqual(["ckanban helper", "1 ticket waits on you"]);
    expect(tg[0].text).toContain("Hi, I'm the helper");
    expect(tg[1].text).toContain("This is your first summary");
    expect(n.helper.waits.firstSummaryPending).toBe(false);
    expect(JSON.parse(calls[0].prompt).firstSummary).toBe(true);
    h.noticeSeen();
    expect(h.status().notice).toBe(false);
    const spend = new SpendIndex(store, () => new Date(clock)).today();
    expect(spend.boards.find((b) => b.name === "Helper")?.costUsd).toBeCloseTo(0.03);
    stop();
  });

  test("first run at night: the hello and the first summary are stored but held until the night ends", async () => {
    clock = DAY(4, 5);
    writeFileSync(join(store.root, "helper-state.json"), "{}");
    summaries.set("s1", summary(["Old question?"]));
    store.updateTicket("kb", ticket.id, { status: "planning", sessionId: "s1" });
    const stop = make();
    expect(n.helper.waits.firstSummaryPending).toBe(true);
    answers.push(answer({ nextWakeIn: 600 }));
    clock += 60_000;
    await h.tick();
    expect(calls).toHaveLength(1);
    // Nothing reached a channel at night; the hello is stored, the first summary still pending.
    expect(hooks).toHaveLength(0);
    expect(tg).toHaveLength(0);
    expect(n.helper.messages.listNewest().map((m) => m.level)).toEqual(["hello"]);
    expect(n.helper.waits.firstSummaryPending).toBe(true);
    // The helper looks again when the night ends, not later.
    expect(h.dueAt()).toBe(DAY(7));
    clock = DAY(6, 59);
    await h.tick();
    expect(hooks).toHaveLength(0);
    clock = DAY(7);
    answers.push(answer({}));
    await h.tick();
    expect(hooks.map((x) => x.title)).toEqual(["ckanban helper", "1 ticket waits on you"]);
    expect(tg[0].text).toContain("Hi, I'm the helper");
    expect(tg[1].text).toContain("This is your first summary");
    expect(n.helper.waits.firstSummaryPending).toBe(false);
    // Sent once only.
    clock += 60_000;
    await h.tick();
    expect(hooks).toHaveLength(2);
    stop();
  });

  test("a summary the helper sends at night is held for the morning", async () => {
    clock = DAY(2);
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 60_000;
    answers.push(answer({ sends: [{ level: "summary", oneLine: "Copy waits", why: "", itemKeys: [keyOf(ticket.id)], escalation: [] }], nextWakeIn: 24 * 60 }));
    await h.tick();
    expect(hooks).toHaveLength(0);
    expect(h.status().runs.at(-1)?.fixes).toContain("held a summary: it is night; it goes out when the night ends");
    expect(h.dueAt()).toBe(DAY(7));
    stop();
  });

  for (const recovered of [false, true]) {
    test(`the pause notice at night waits for the morning (${recovered ? "dropped: the helper works again" : "sent: still failing"})`, async () => {
      clock = DAY(1);
      const stop = make();
      ask(ticket.id, ["Approve the copy?"]);
      await settle();
      for (let i = 0; i < 3; i++) {
        clock += 60_000;
        await h.wake();
      }
      expect(h.healthy()).toBe(false);
      expect(n.helper.messages.listNewest().some((m) => m.level === "pause")).toBe(true);
      expect(hooks).toHaveLength(0);
      if (recovered) {
        clock += 60_000;
        answers.push(answer({}));
        await h.wake();
        expect(h.healthy()).toBe(true);
      }
      clock = DAY(7);
      answers.push(answer({}));
      await h.tick();
      expect(hooks.some((x) => x.title === "ckanban helper paused")).toBe(!recovered);
      stop();
    });
  }

  test("a new feedback line wakes the helper (loop guard applies); Should have pinged me writes one", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 60_000;
    answers.push(answer({ nextWakeIn: 600 }));
    await h.tick();
    clock += 1000;
    h.shouldHavePinged("kb", ticket.id);
    expect(h.settings.get().feedback[0]).toMatchObject({ source: "should-have-pinged", text: 'Should have pinged me about "Pricing": Approve the copy?' });
    await h.tick();
    expect(calls).toHaveLength(1);
    clock += 59_000;
    answers.push(answer({}));
    await h.tick();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].prompt).newFeedback).toHaveLength(1);
    stop();
  });

  test("review fixes: a slow send can't fire a step twice; overdue steps after sleep fire once; a paused helper recovers with nothing open", async () => {
    const stop = make();
    ask(ticket.id, ["Stop the old webhook?"]);
    await settle();
    const key = keyOf(ticket.id);
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Webhook", why: "w", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "telegram", afterMin: 10 }, { channel: "telegram", afterMin: 20 }, { channel: "telegram", afterMin: 30 }] }] }));
    clock += 60_000;
    await h.tick();
    // Asleep for 35 minutes: three steps overdue, only the latest fires; a slow send overlapping the next tick doesn't repeat it.
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const send = telegram.send;
    telegram.send = async (m, st) => {
      await slow;
      return send(m, st);
    };
    clock += 35 * 60_000;
    const first = h.tick();
    await h.tick();
    await h.reminders();
    release();
    await first;
    telegram.send = send;
    expect(tg).toHaveLength(1);
    expect(tg[0].text).toContain("Reminder 4 of 4");
    expect(n.helper.waits.get(key)!.reminders.filter((x) => x.skipped)).toHaveLength(2);
    await h.tick();
    expect(tg).toHaveLength(1);

    // Paused after 3 failures, then nothing is open: the retry still asks the helper, and it recovers.
    for (let i = 0; i < 3; i++) {
      answers.push({ ok: false, error: "down" });
      h.requestWake(clock);
      clock += 31 * 60_000;
      await h.tick();
    }
    expect(h.healthy()).toBe(false);
    store.updateTicket("kb", ticket.id, { status: "done" });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.getTicket("kb", ticket.id)! });
    await settle();
    expect(n.helper.waits.open()).toEqual([]);
    const before = calls.length;
    answers.push(answer({}));
    clock += 31 * 60_000;
    await h.tick();
    expect(calls.length).toBe(before + 1);
    expect(h.healthy()).toBe(true);
    stop();
  });

  test("an urgent alert that reaches no channel stays untold: the next step tells it, or the helper looks again soon", async () => {
    const stop = make();
    clock += 2 * 60_000;
    ask(ticket.id, ["Stop the old webhook?"], { urgent: true });
    await settle();
    const key = keyOf(ticket.id);
    hookOk = false;
    tgOk = false;
    // One step only: every channel fails, nothing counts as sent, the helper retries within 5 minutes.
    answers.push(answer({ nextWakeIn: 120, sends: [{ level: "urgent", oneLine: "Webhook runs twice", why: "", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }] }] }));
    await h.tick();
    expect(hooks).toHaveLength(1);
    expect(tg).toHaveLength(1);
    expect(n.helper.waits.get(key)).toMatchObject({ toldAt: null });
    expect(h.status().lines[`kb/${ticket.id}`]).toBe("Urgent: ntfy 14:02 (didn't get through)");
    expect(h.status().runs.at(-1)).toMatchObject({ ok: true, sends: 0 });
    expect(Date.parse(h.status().nextWakeAt!)).toBeLessThanOrEqual(clock + 5 * 60_000);
    expect(n.helper.messages.listNewest({ held: true }).some((m) => m.held)).toBe(false);
    // The next wake sees it untold and sends again; now a later step is planned. Its first send fails too...
    clock += 5 * 60_000;
    answers.push(answer({ nextWakeIn: 120, sends: [{ level: "urgent", oneLine: "Webhook runs twice", why: "", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 5 }] }] }));
    await h.tick();
    expect(JSON.parse(calls[1].prompt).items[0]).toMatchObject({ key, told: "no" });
    expect(n.helper.waits.get(key)!.toldAt).toBeNull();
    // ...and the next planned step gets through: now it is told, and nothing goes out twice.
    hookOk = true;
    clock += 5 * 60_000;
    await h.tick();
    const reminder = n.helper.messages.listNewest()[0];
    expect(reminder.level).toBe("reminder");
    expect(n.helper.waits.get(key)).toMatchObject({ toldVia: "helper", messageId: reminder.id });
    const count = hooks.length;
    clock += 3 * 3600_000;
    await n.helper.tick();
    expect(hooks).toHaveLength(count);
    stop();
  });

  test("a snooze ending wakes the helper", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 60_000;
    answers.push(answer({ nextWakeIn: 600, log: "held" }));
    await h.tick();
    expect(calls).toHaveLength(1);
    snoozes.set(ticket.id, new Date(clock + 30 * 60_000).toISOString());
    await h.tick();
    expect(h.dueAt()).toBe(clock + 30 * 60_000);
    clock += 29 * 60_000;
    await h.tick();
    expect(calls).toHaveLength(1);
    clock += 60_000;
    answers.push(answer({ nextWakeIn: 600 }));
    await h.tick();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].prompt).items[0]).toMatchObject({ snoozed: false });
    stop();
  });

  test("a snooze until unsnoozed keeps the wait out of summaries and safety nets, with no wake for its end; unsnoozing gives the 4-hour digest back", async () => {
    const stop = make();
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    snoozes.set(ticket.id, "9999-12-31T23:59:59.000Z");
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    await h.tick();
    const key = keyOf(ticket.id);
    expect(n.helper.waits.get(key)!.digestAt).toBe("9999-12-31T23:59:59.000Z");
    // A new wait elsewhere still gets the 1-minute batch wake (the far-off end doesn't block it).
    ask(other.id, ["Which tone?"]);
    await settle();
    let seen: any = null;
    answers.push((i) => {
      seen = JSON.parse(i.prompt);
      return answer({ sends: [{ level: "summary", oneLine: "tone", why: "", itemKeys: [key, keyOf(other.id)], escalation: [] }], nextWakeIn: 1440 });
    });
    clock += 61_000;
    await h.tick();
    expect(calls).toHaveLength(1);
    expect(seen.items.find((x: any) => x.key === key)).toMatchObject({ snoozed: true });
    // The board drops the snoozed one from the summary.
    const m = n.helper.messages.listNewest()[0];
    expect(m.items.map((i) => i.ticketId)).toEqual([other.id]);
    expect(n.helper.waits.get(key)!.toldAt).toBeNull();
    // Weeks later nothing has gone out about it.
    clock += 30 * 24 * 3600_000;
    await h.tick();
    await settle();
    expect(n.helper.messages.listNewest().filter((x) => x.items.some((i) => i.ticketId === ticket.id))).toEqual([]);
    // Unsnoozed: its safety net comes back from now.
    snoozes.delete(ticket.id);
    await h.tick();
    expect(Date.parse(n.helper.waits.get(key)!.digestAt!)).toBe(clock + 4 * 3600_000);
    stop();
  });

  test("a failed AI call's cost counts in the Helper spend line", async () => {
    const r = parseSideResult(JSON.stringify({ is_error: true, result: "", subtype: "error_max_turns", total_cost_usd: 0.012 }), 1, "", "sonnet");
    expect(r).toMatchObject({ ok: false, costUsd: 0.012 });
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    clock += 60_000;
    answers.push({ ok: false, error: "max turns", costUsd: 0.012 });
    await h.tick();
    expect(h.status().runs.at(-1)).toMatchObject({ ok: false, costUsd: 0.012 });
    const spend = new SpendIndex(store, () => new Date(clock)).today();
    expect(spend.boards.find((b) => b.name === "Helper")?.costUsd).toBeCloseTo(0.012);
    stop();
  });

  test("the helper isn't an active run: a restart neither waits for it nor holds it", async () => {
    const stop = make();
    ask(ticket.id, ["Approve the copy?"]);
    await settle();
    let release!: () => void;
    answers.push(() => answer({}));
    const board = new Board(store, bus, { claudeBin: "/bin/false" });
    // The run hangs until released.
    const slow = new Promise<void>((r) => (release = r));
    const inner = (h as any).d.sideCall;
    (h as any).d.sideCall = async (i: SideCallInput) => {
      await slow;
      return inner(i);
    };
    clock += 60_000;
    const waking = h.tick();
    let restarted = false;
    expect(board.requestRestart(() => (restarted = true)).running).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(restarted).toBe(true);
    // ...and a pending restart doesn't hold the helper.
    release();
    await waking;
    expect(calls).toHaveLength(1);
    expect(h.status().runs.at(-1)!.ok).toBe(true);
    stop();
  });
});

test("the kept-quiet note reads plainly and stays short", () => {
  expect(keptQuietLine(2, "12:41")).toBe("Kept quiet: 2 tickets, nothing urgent. They'll be in the next summary, by 12:41.");
  expect(keptQuietLine(1, "9:05")).toBe("Kept quiet: 1 ticket, nothing urgent. It'll be in the next summary, by 9:05.");
  expect(keptQuietLine(120, "23:59").length).toBeLessThanOrEqual(110);
});
