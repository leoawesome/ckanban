// "You said" quotes (the helper's `followed` indexes, quoted by the board) and the week's first summary recap line.
import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { checkDecision, checkFollowed, DECISION_SCHEMA, HELPER_SYSTEM, type CheckContext, type ItemState } from "../src/server/helper/decide";
import { helperSpendFile, HelperRunner } from "../src/server/helper/runner";
import { weekRecapLine, weekStart, type RecapRecord } from "../src/server/helper/summary";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { addSideSpend, type SideCallInput, type SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

// 9 Nov 2026 is a Monday.
const DAY = (h: number, m = 0, d = 9) => new Date(2026, 10, d, h, m).getTime();
const NIGHT = { start: "22:00", end: "07:00" };
const iso = (ms: number) => new Date(ms).toISOString();

describe("followed: the board quotes the feedback line", () => {
  const FB = ["pricing questions are always urgent", "never wake me for docs"];
  const st = (o: Partial<ItemState> = {}): ItemState => ({ open: true, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null, ...o });
  const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({
    now: DAY(14), night: NIGHT, nightOptIn: false, channels: ["mac", "push"], on: ["push"], items: new Map([["a", st()], ["b", st()]]), feedback: FB, ...o,
  });
  const send = (o: object = {}) => ({ level: "urgent", oneLine: "Pricing is billed twice", why: "customers pay twice", itemKeys: ["a"], escalation: [], ...o });
  const run = (sends: object[], o: Partial<CheckContext> = {}) => {
    const r = checkDecision({ sends, nextWakeIn: 30, notes: "", log: "" }, ctx(o));
    if (!r.ok) throw new Error(r.error);
    return r.decision;
  };

  test("the schema offers followed as an optional list of whole numbers; the instructions ask for it", () => {
    const props = DECISION_SCHEMA.properties.sends.items.properties as Record<string, any>;
    expect(props.followed).toMatchObject({ type: "array", items: { type: "integer" } });
    expect(DECISION_SCHEMA.properties.sends.items.required as readonly string[]).not.toContain("followed");
    expect(HELPER_SYSTEM).toContain("followed");
  });

  test("a good index appends the exact line to the why", () => {
    const d = run([send({ followed: [0] })]);
    expect(d.sends[0].why).toBe('customers pay twice You said: "pricing questions are always urgent"');
    expect(d.sends[0].followed).toEqual(["pricing questions are always urgent"]);
    expect(d.fixes).toEqual([]);
  });

  test("bad and out-of-range indexes are dropped and logged; repeats quoted once", () => {
    const d = run([send({ followed: [5, -1, 0.5, "1", null, 1, 1] })]);
    expect(d.sends[0].followed).toEqual(["never wake me for docs"]);
    expect(d.sends[0].why).toBe('customers pay twice You said: "never wake me for docs"');
    expect(d.fixes.filter((f) => f.startsWith("dropped followed"))).toHaveLength(5);
  });

  test("not a list, missing, or no feedback given: nothing is quoted and the send still goes", () => {
    const a = run([send({ followed: "0" })]);
    expect(a.sends[0]).toMatchObject({ why: "customers pay twice" });
    expect(a.sends[0].followed).toBeUndefined();
    expect(a.fixes).toEqual(["dropped followed: not a list"]);
    expect(run([send()]).sends[0].followed).toBeUndefined();
    expect(run([send({ followed: [0] })], { feedback: undefined }).sends[0].why).toBe("customers pay twice");
  });

  test("an empty why gets only the quote; at most 3 lines are quoted", () => {
    const many = ["one", "two", "three", "four"];
    expect(checkFollowed([0, 1, 2, 3], many)).toEqual(["one", "two", "three"]);
    const d = run([send({ why: "", followed: [1] })]);
    expect(d.sends[0].why).toBe('You said: "never wake me for docs"');
  });
});

describe("weekRecapLine (fixtures)", () => {
  const MON = DAY(9, 30); // this week's Monday
  const told = (at: number, via: RecapRecord["toldVia"] = "helper"): RecapRecord => ({ toldAt: iso(at), toldVia: via, reminders: [] });
  const alert = (at: number, o: Partial<RecapRecord["reminders"][number]> = {}): RecapRecord => ({
    toldAt: iso(at), toldVia: "helper", reminders: [{ channel: "push", dueAt: iso(at), sentAt: iso(at), ...o }, { channel: "push", dueAt: iso(at + 300_000), sentAt: null }],
  });

  test("weeks start Monday 00:00 local time", () => {
    expect(weekStart(MON)).toBe(DAY(0));
    expect(weekStart(DAY(23, 59, 15))).toBe(DAY(0)); // Sunday 15 Nov
    expect(weekStart(DAY(0, 0, 16))).toBe(DAY(0, 0, 16));
  });

  test("counts last Monday to Sunday: urgent alerts, held into summaries, helper spend", () => {
    const records = [
      alert(DAY(10, 0, 3)), alert(DAY(23, 0, 8)),
      told(DAY(9, 0, 2)), told(DAY(12, 0, 5)), told(DAY(18, 0, 8), "digest"),
      // Not counted: before last week, this week, told directly or never told, an alert that reached no one.
      told(DAY(23, 0, 1)), told(DAY(8, 0, 9)), told(DAY(12, 0, 4), "direct"), { toldAt: null, toldVia: null, reminders: [] },
      alert(DAY(11, 0, 4), { failed: true }),
      // An alert sent this week on a wait told last week counts for this week, not last.
      { ...alert(DAY(8, 0, 9)), toldAt: iso(DAY(20, 0, 8)) },
    ];
    // The failed alert fell back to a summary-like told mark: it isn't an alert, and its told time counts it as held.
    const days = new Map([["2026-11-02", 1.5], ["2026-11-06", 4.6], ["2026-11-01", 9], ["2026-11-09", 2]]);
    expect(weekRecapLine(records, days, MON)).toBe("Last week: 2 urgent alerts, 4 held into summaries, helper $6.10");
  });

  test("one of each reads in the singular where it matters; no spend leaves the dollar part out", () => {
    expect(weekRecapLine([alert(DAY(10, 0, 3)), told(DAY(10, 0, 4))], new Map(), MON)).toBe("Last week: 1 urgent alert, 1 held into summaries");
  });

  test("only spend: the line still goes; nothing at all: no line", () => {
    expect(weekRecapLine([], new Map([["2026-11-04", 0.4]]), MON)).toBe("Last week: 0 urgent alerts, 0 held into summaries, helper $0.40");
    expect(weekRecapLine([told(DAY(10, 0, 9))], new Map([["2026-11-09", 3]]), MON)).toBeNull();
    expect(weekRecapLine([], new Map(), MON)).toBeNull();
  });

  test("later in the week it still describes the week before", () => {
    expect(weekRecapLine([told(DAY(10, 0, 3))], new Map(), DAY(15, 0, 12))).toBe("Last week: 0 urgent alerts, 1 held into summaries");
  });
});

describe("runner: quotes and the recap in real messages", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let hooks: { title: string; body: string }[];
  let calls: SideCallInput[];
  let answers: (SideCallResult | ((i: SideCallInput) => SideCallResult))[];
  let summaries: Map<string, SessionSummary>;
  let ticket: Ticket;
  let n: Notifier;
  let h: HelperRunner;

  const make = () => {
    n = new Notifier(store, bus, {
      root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.ts.net", debounceMs: 1000, tickMs: 3600_000, now: () => clock,
      fetch: async (_url, init) => {
        const hd = init.headers as Record<string, string>;
        hooks.push({ title: hd.Title, body: String(init.body) });
        return new Response("ok");
      },
      banner: () => {},
    });
    h = new HelperRunner({
      root: store.root, store, core: n.helper, notifySettings: () => n.settings(), link: (s, id) => n.link(s, id), messageLink: (id) => n.messageLink(id), now: () => clock,
      sideCall: async (i) => {
        calls.push(i);
        const a = answers.shift();
        if (!a) return { ok: false, error: "no answer queued" };
        return typeof a === "function" ? a(i) : a;
      },
    });
    return n.start();
  };
  const answer = (d: object): SideCallResult => ({ ok: true, text: JSON.stringify({ sends: [], nextWakeIn: 60, notes: "", log: "ok", ...d }), costUsd: 0.02, model: "sonnet" });
  const ask = (id: string, q: string, extra?: { urgent?: boolean; why?: string }) => {
    summaries.set(`s_${id}`, {
      title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 1, openForm: [{ question: q, options: [], multiSelect: false }],
      ...(extra ? { openAsk: extra } : {}), pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
    } as SessionSummary);
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", id, { status: "planning", sessionId: `s_${id}` }) });
  };
  const settle = async () => {
    n.tick();
    clock += 1000;
    n.tick();
    await new Promise((r) => setTimeout(r, 5));
  };
  const keyOf = (id: string) => n.helper.waits.open().find((r) => r.ticketId === id)!.key;
  const summarySend = (id: string, o: object = {}) => answer({ sends: [{ level: "summary", oneLine: "copy question", why: "", itemKeys: [keyOf(id)], escalation: [], ...o }] });

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = DAY(14);
    hooks = [];
    calls = [];
    answers = [];
    summaries = new Map();
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z", nightNoticeAt: "2026-11-01T00:00:00Z" }));
  });

  test("an urgent alert quotes the feedback line it followed; a line removed during the call can't shift the quote", async () => {
    const stop = make();
    h.settings.addFeedback("docs can always wait");
    h.settings.addFeedback("pricing questions are always urgent");
    clock += 2 * 60_000;
    ask(ticket.id, "Stop the old webhook?", { urgent: true, why: "pricing data ingested twice" });
    await settle();
    const key = keyOf(ticket.id);
    answers.push((i) => {
      expect(JSON.parse(i.prompt).feedback).toEqual(["docs can always wait", "pricing questions are always urgent"]);
      // The user removes the first line while the helper thinks.
      h.settings.removeFeedback(h.settings.get().feedback[0].id);
      return answer({ sends: [{ level: "urgent", oneLine: "Pricing ingests data twice", why: "double ingestion", itemKeys: [key], escalation: [{ channel: "webhook", afterMin: 0 }], followed: [1] }] });
    });
    await h.tick();
    const alert = n.helper.messages.listNewest()[0];
    expect(alert.level).toBe("urgent");
    expect(alert.why).toBe('double ingestion You said: "pricing questions are always urgent"');
    expect(alert.text).toContain('Why: double ingestion You said: "pricing questions are always urgent"');
    stop();
  });

  test("a summary shows its quote as a line; the week's first summary carries the recap, the next one doesn't", async () => {
    // Last week's helper spend, and a wait told in a summary last week.
    addSideSpend(helperSpendFile(store.root), "helper", 1.5, new Date(DAY(10, 0, 3)));
    addSideSpend(helperSpendFile(store.root), "helper", 4.6, new Date(DAY(10, 0, 6)));
    const stop = make();
    h.settings.addFeedback("copy questions can wait for a summary");
    ask(ticket.id, "Approve the copy?");
    await settle();
    clock += 60_000;
    answers.push(summarySend(ticket.id, { followed: [0, 7] }));
    await h.tick();
    const first = n.helper.messages.listNewest()[0];
    expect(first.level).toBe("summary");
    expect(first.text).toBe('1 new for you: copy question\n\n- Pricing: Approve the copy?\n\nYou said: "copy questions can wait for a summary"\n\nLast week: 0 urgent alerts, 0 held into summaries, helper $6.10');
    expect(first.summary!.notes).toEqual(['You said: "copy questions can wait for a summary"', "Last week: 0 urgent alerts, 0 held into summaries, helper $6.10"]);
    // The wrong index is in the log, the good one was quoted.
    expect(h.status().runs.at(-1)!.fixes).toContain("dropped followed 7 (no such feedback line)");
    // Later the same week: no recap. The recap needed no model call of its own.
    const other = store.createTicket("kb", { title: "Docs", body: "b", status: "in_progress" });
    clock += 3 * 3600_000;
    ask(other.id, "Which tone?");
    await settle();
    clock += 60_000;
    answers.push(summarySend(other.id, { oneLine: "tone question" }));
    await h.tick();
    const second = n.helper.messages.listNewest()[0];
    expect(second.id).not.toBe(first.id);
    expect(second.text).not.toContain("Last week");
    expect(calls).toHaveLength(2);
    stop();
  });

  test("the week's first summary has no recap when last week has no data", async () => {
    const stop = make();
    ask(ticket.id, "Approve the copy?");
    await settle();
    clock += 60_000;
    answers.push(summarySend(ticket.id));
    await h.tick();
    expect(n.helper.messages.listNewest()[0].text).toBe("1 new for you: copy question\n\n- Pricing: Approve the copy?");
    stop();
  });
});
