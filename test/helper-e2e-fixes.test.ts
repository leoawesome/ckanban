// The end-to-end test's four problems (t_20261108_hjwr): phone reminder steps fall to this Mac last, reminder text
// without the alert's own plan lines, Got it shown on the message page, and the board's own counts in summaries.
import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import type { Channel } from "../src/server/helper/channels";
import { HELPER_SYSTEM } from "../src/server/helper/decide";
import { HelperRunner, reminderBody, stepChain, summaryLine } from "../src/server/helper/runner";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { sendTrail, userTrail } from "../web/src/helperText";
import { tempDir } from "./helpers";

const DAY = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();

describe("pure parts", () => {
  test("A: a phone step tries every other phone channel before this Mac; a Mac step keeps the Mac first", () => {
    expect(stepChain("push", [], ["mac", "push", "webhook", "telegram"])).toEqual(["push", "webhook", "telegram", "mac"]);
    expect(stepChain("push", ["mac", "telegram"], ["mac", "push", "webhook"])).toEqual(["push", "telegram", "webhook", "mac"]);
    expect(stepChain("mac", ["push"], ["mac", "push", "webhook"])).toEqual(["mac", "push", "webhook"]);
  });
  test("B: a reminder's text leaves out the alert's Next and Right call lines", () => {
    const alert = ["Stop it", "Why: billed twice", "Pricing\nStop the old webhook?\nhttps://x/t", "Next: I'll remind you on phone at 3:31, until 5:26 at most, unless you open it.", "Right call? Tap Got it if this was worth interrupting you, or Not urgent if it wasn't."].join("\n\n");
    expect(reminderBody(alert)).toBe("Stop it\n\nWhy: billed twice\n\nPricing\nStop the old webhook?\nhttps://x/t");
    expect(reminderBody("A\n\nNo reminders planned: this is the only alert.")).toBe("A");
    // Only the closing lines go: a question that happens to start "Right call?" stays.
    expect(reminderBody("A\n\nRight call? on pricing\n\nB")).toBe("A\n\nRight call? on pricing\n\nB");
  });
  test("C: the trail says the user tapped Got it (no separate 'opened' when only the tap read it)", () => {
    const base = { id: "m", at: "2026-11-09T14:00:00Z", level: "urgent" as const, oneLine: "x", text: "x", why: null, items: [], sends: [] };
    expect(userTrail({ readAt: "2026-11-09T14:05:00Z", tapped: { how: "got-it", at: "2026-11-09T14:05:00Z" } }).map((u) => u.text)).toEqual(["You tapped Got it"]);
    expect(userTrail({ readAt: "2026-11-09T14:01:00Z", tapped: { how: "not-urgent", at: "2026-11-09T14:05:00Z" } }).map((u) => u.text)).toEqual(["You opened it", "You tapped Not urgent"]);
    expect(userTrail({ readAt: "2026-11-09T14:01:00Z" }).map((u) => u.text)).toEqual(["You opened it"]);
    expect(sendTrail({ ...base, readAt: "2026-11-09T14:05:00Z", tapped: { how: "got-it", at: "2026-11-09T14:05:00Z" } })).toMatch(/^Got it /);
  });
  test("D: a summary's count is the board's own; the helper's count is dropped", () => {
    expect(summaryLine(5, "6 tickets wait on you: new copy question on Docs")).toBe("5 wait on you: new copy question on Docs");
    expect(summaryLine(7, "5 routine questions wait on you - pricing is new")).toBe("7 wait on you: pricing is new");
    expect(summaryLine(1, "New copy question on Docs")).toBe("1 waits on you: New copy question on Docs");
    expect(summaryLine(3, "3 wait on you")).toBe("3 wait on you");
    expect(summaryLine(0, "Prep ready for your 3pm call")).toBe("Prep ready for your 3pm call");
  });
  test("D: the helper is told feedback lines are standing preferences, and not to count", () => {
    expect(HELPER_SYSTEM).toContain("standing preferences");
    expect(HELPER_SYSTEM).toContain("send me the summary now");
    expect(HELPER_SYSTEM).toContain("Never write counts");
  });
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
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z" }));
  });


  let macs: string[];
  /** This Mac works; phone push is on but no phone has it (0 devices). */
  const phoneless = () => {
    macs = [];
    n.helper.channels.register({ name: "mac", enabled: () => true, async send(m) { macs.push(m.text); return { channel: "mac", ok: true, error: null }; } });
    n.helper.channels.register({ name: "push", enabled: () => true, async send() { return { channel: "push", ok: false, empty: true, error: "no phone has notifications turned on" }; } });
  };
  /** An urgent alert on Telegram, then one phone step 5 minutes later that fires. */
  const alertThenPhoneStep = async (beforeStep?: () => void) => {
    const key = await urgentWait();
    answers.push(urgentAns(key, [{ channel: "telegram", afterMin: 0 }, { channel: "push", afterMin: 5 }]));
    await h.tick();
    const alertId = n.helper.waits.get(key)!.messageId!;
    beforeStep?.();
    clock += 6 * 60_000;
    await h.tick();
    const reminder = n.helper.messages.listNewest().find((m) => m.level === "reminder")!;
    return { key, alertId, reminder };
  };

  test("A: a phone step with no phone goes to ntfy, not this Mac", async () => {
    const stop = make();
    phoneless();
    const { key, reminder } = await alertThenPhoneStep();
    expect(reminder).toBeTruthy();
    expect(macs).toEqual([]);
    expect(hooks.length).toBe(1);
    expect(reminder.sends.map((s) => [s.channel, s.ok])).toEqual([["push", false], ["webhook", true]]);
    expect(n.helper.waits.get(key)!.reminders[1]).toMatchObject({ channel: "webhook", sentAt: expect.any(String) });
    stop();
  });

  test("A: this Mac is still the last resort when no phone channel works", async () => {
    const stop = make();
    phoneless();
    const { reminder } = await alertThenPhoneStep(() => {
      // ntfy and Telegram fail too.
      tgOk = false;
      n.helper.channels.register({ name: "webhook", enabled: () => true, async send() { return { channel: "webhook", ok: false, error: "ntfy down" }; } });
    });
    expect(reminder.sends.map((x) => x.channel)).toEqual(["push", "webhook", "telegram", "mac"]);
    expect(reminder.sends.at(-1)).toMatchObject({ channel: "mac", ok: true });
    expect(macs.length).toBe(1);
    stop();
  });

  test("B: the reminder text has its own next step, not the alert's Next and Right call lines", async () => {
    const stop = make();
    const { alertId, reminder } = await alertThenPhoneStep();
    const alert = n.helper.messages.get(alertId)!;
    expect(alert.text).toContain("Next: I'll remind you");
    expect(alert.text).toContain("Right call?");
    expect(reminder.text).not.toContain("Next: I'll remind you");
    expect(reminder.text).not.toContain("Right call?");
    expect(reminder.text).toContain("Stop the old webhook?");
    expect(reminder.text).toMatch(/This is the last reminder\.$/);
    // The alert is not a reminder: the one step after it is "1 of 1".
    expect(reminder.text).toMatch(/^Reminder 1 of 1, not opened yet\./);
    stop();
  });

  test("C: Got it on a reminder shows on the reminder and on its alert", async () => {
    const stop = make();
    const { alertId, reminder } = await alertThenPhoneStep();
    clock += 60_000;
    h.gotIt(reminder.id);
    for (const id of [alertId, reminder.id]) {
      const m = n.helper.messages.get(id)!;
      expect(m.tapped).toEqual({ how: "got-it", at: new Date(clock).toISOString() });
      expect(m.readAt).toBeTruthy();
    }
    h.notUrgent(alertId);
    expect(n.helper.messages.get(reminder.id)!.tapped!.how).toBe("not-urgent");
    stop();
  });

  test("D: the summary line carries the board's count, not the helper's", async () => {
    const stop = make();
    ask(ticket.id, ["Which tone for the pricing page?"]);
    await settle();
    const key = keyOf(ticket.id);
    answers.push(answer({ sends: [{ level: "summary", oneLine: "6 tickets wait on you: tone question on Pricing", why: "", itemKeys: [key], escalation: [] }] }));
    await wakeNow();
    const m = n.helper.messages.listNewest().find((x) => x.level === "summary")!;
    expect(m.oneLine).toBe("1 waits on you: tone question on Pricing");
    expect(m.text.startsWith("1 waits on you: tone question on Pricing")).toBe(true);
    stop();
  });
});
