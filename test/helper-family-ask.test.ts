// A question asked by a ticket inside a feature (a "with you" step, a tool ticket) shows on its main ticket: the wait
// recorded for the main ticket carries the asker's urgent mark, why and question text, one wait per (asker, question).
import { beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../src/server/events";
import { recordKey, WaitStore, type WaitRecord } from "../src/server/helper/waits";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

describe("questions from a feature's steps", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let summaries: Map<string, SessionSummary>;
  let main: Ticket;

  const make = () => new Notifier(store, bus, {
    root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
    baseUrl: () => "https://mac.tail.ts.net", debounceMs: 1000, tickMs: 60_000, now: () => clock,
    fetch: async () => new Response("ok"), banner: () => {},
  });
  const summary = (questions: string[], ask?: { urgent?: boolean; why?: string }): SessionSummary => ({
    title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: questions.length,
    openForm: questions.map((q) => ({ question: q, options: [], multiSelect: false })), ...(ask ? { openAsk: ask } : {}),
    pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], cache: null,
  } as SessionSummary);
  /** A "with you" step of the main ticket ends its run asking (ask_questions in its own session). */
  const stepAsks = (title: string, questions: string[], ask?: { urgent?: boolean; why?: string }) => {
    const c = store.createTicket("kb", { title, body: "b", status: "in_progress" });
    summaries.set(`s_${c.id}`, summary(questions, ask));
    const t = store.updateTicket("kb", c.id, {
      parentId: main.id, tool: true, kind: "with_you", status: "review", outcome: "needs_input", sessionId: `s_${c.id}`,
      runEndedAt: new Date(clock).toISOString(),
    });
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: t });
    return t;
  };
  const answered = (t: Ticket) => {
    summaries.delete(`s_${t.id}`);
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", t.id, { status: "done", outcome: "done" }) });
  };
  const settle = async (n: Notifier) => {
    n.tick();
    clock += 1000;
    n.tick();
    await new Promise((r) => setTimeout(r, 5));
  };
  const plugIn = (n: Notifier) => {
    const heard: WaitRecord[] = [];
    n.helper.setSink({ healthy: () => true, lastSuccessAt: () => null, onWait: (r) => heard.push(r) });
    return heard;
  };

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = Date.parse("2026-11-09T07:09:00Z");
    summaries = new Map();
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    main = store.createTicket("kb", { title: "Watcher agent", body: "b", status: "in_progress" });
    main = store.updateTicket("kb", main.id, { main: true, status: "in_progress", runEndedAt: "2026-11-09T07:00:00Z" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
  });

  test("a with-you step's urgent question: the main ticket's wait is urgent, with its why and the real question", async () => {
    const n = make();
    const heard = plugIn(n);
    const stop = n.start();
    stepAsks("Phone test", ["Did the urgent alert reach your phone?"], { urgent: true, why: "testing the urgent path" });
    await settle(n);
    const open = n.helper.waits.open();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ticketId: main.id, kind: "questions", urgent: true, why: "testing the urgent path", question: "Did the urgent alert reach your phone?" });
    expect(heard.map((r) => r.urgent)).toEqual([true]);
    stop();
  });

  test("not urgent unless the step said so; a second step's question gets its own wait; answers close them", async () => {
    const n = make();
    plugIn(n);
    const stop = n.start();
    const a = stepAsks("Copy", ["Approve the copy?"]);
    await settle(n);
    const first = n.helper.waits.open();
    expect(first).toHaveLength(1);
    expect(first[0].urgent).toBeUndefined();
    expect(first[0]).toMatchObject({ why: null, question: "Approve the copy?" });
    answered(a);
    clock += 60_000;
    stepAsks("Pricing", ["Which plan name?"], { urgent: true, why: "launch at 3" });
    await settle(n);
    const second = n.helper.waits.open();
    expect(second).toHaveLength(1);
    expect(second[0].key).not.toBe(first[0].key);
    expect(second[0]).toMatchObject({ urgent: true, why: "launch at 3", question: "Which plan name?" });
    expect(n.helper.waits.get(first[0].key)?.closedWhy).toBe("answered");
    stop();
  });

  test("two steps ask at once: each gets its own wait, the later urgent one is alerted at once; answering one closes only it", async () => {
    const n = make();
    const heard = plugIn(n);
    const stop = n.start();
    const a = stepAsks("Copy", ["Approve the copy?"]);
    await settle(n);
    clock += 60_000;
    stepAsks("Pricing", ["Which plan name?"], { urgent: true, why: "launch at 3" });
    await settle(n);
    expect(heard.map((r) => [r.question, !!r.urgent])).toEqual([["Approve the copy?", false], ["Which plan name?", true]]);
    expect(n.helper.waits.open().map((r) => r.question).sort()).toEqual(["Approve the copy?", "Which plan name?"]);
    answered(a);
    await settle(n);
    expect(n.helper.waits.open().map((r) => r.question)).toEqual(["Which plan name?"]);
    expect(heard).toHaveLength(2);
    stop();
  });

  test("the shown step switches and back: a step's wait stays open while it waits and is never sent twice", async () => {
    const n = make();
    const heard = plugIn(n);
    const stop = n.start();
    // A tool step's question the main ticket hasn't seen: shown on the card.
    const c = store.createTicket("kb", { title: "Research", body: "b", status: "in_progress" });
    summaries.set(`s_${c.id}`, summary(["Which source?"], { urgent: true, why: "x" }));
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", c.id, { parentId: main.id, tool: true, status: "review", outcome: "needs_input", sessionId: `s_${c.id}`, runEndedAt: new Date(clock + 1).toISOString() }) });
    await settle(n);
    clock += 60_000;
    const b = stepAsks("Phone test", ["Did it ring?"]);
    await settle(n);
    answered(b);
    await settle(n);
    expect(heard.map((r) => r.question)).toEqual(["Which source?", "Did it ring?"]);
    const research = n.helper.waits.all().filter((r) => r.question === "Which source?");
    expect(research).toHaveLength(1);
    expect(research[0].closedAt).toBeNull();
    stop();
  });

  test("a step deleted while it waits: its wait closes", async () => {
    const n = make();
    plugIn(n);
    const stop = n.start();
    stepAsks("Copy", ["Approve the copy?"]);
    const b = stepAsks("Pricing", ["Which plan name?"]);
    await settle(n);
    expect(n.helper.waits.open()).toHaveLength(2);
    store.deleteTicket("kb", b.id);
    bus.emit({ type: "ticket.deleted", profile: "kb", id: b.id });
    await settle(n);
    expect(n.helper.waits.open().map((r) => r.question)).toEqual(["Approve the copy?"]);
    stop();
  });

  test("a tool step's question closes once the main ticket works on it", async () => {
    const n = make();
    plugIn(n);
    const running = new Set<string>();
    (n as unknown as { o: { isRunning: (s: string, id: string) => boolean } }).o.isRunning = (_s, id) => running.has(id);
    const stop = n.start();
    const c = store.createTicket("kb", { title: "Research", body: "b", status: "in_progress" });
    summaries.set(`s_${c.id}`, summary(["Which source?"], { urgent: true, why: "x" }));
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", c.id, { parentId: main.id, tool: true, status: "review", outcome: "needs_input", sessionId: `s_${c.id}`, runEndedAt: new Date(clock + 1).toISOString() }) });
    await settle(n);
    expect(n.helper.waits.open()).toHaveLength(1);
    running.add(main.id);
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.getTicket("kb", main.id)! });
    await settle(n);
    expect(n.helper.waits.open()).toEqual([]);
    stop();
  });

  test("a top-level ticket's own urgent question still carries its own mark", async () => {
    const n = make();
    plugIn(n);
    const stop = n.start();
    const t = store.createTicket("kb", { title: "Solo", body: "b", status: "in_progress" });
    summaries.set(`s_${t.id}`, summary(["Stop the webhook?"], { urgent: true, why: "billed twice" }));
    bus.emit({ type: "ticket.updated", profile: "kb", ticket: store.updateTicket("kb", t.id, { status: "planning", sessionId: `s_${t.id}` }) });
    await settle(n);
    expect(n.helper.waits.open()).toEqual([expect.objectContaining({ ticketId: t.id, urgent: true, why: "billed twice", question: "Stop the webhook?" })]);
    stop();
  });

  test("restart: an open wait recorded the old way (under the main ticket, no question) keeps its told state, no second alert", async () => {
    const before = make();
    plugIn(before);
    const stop0 = before.start();
    stop0();
    stepAsks("Phone test", ["Did it reach your phone?"], { urgent: true, why: "testing" });
    // What the old board recorded: the step's label as the question, no urgent mark, already held in a summary.
    const legacy = before.helper.waits.add({ board: "kb", ticketId: main.id, kind: "questions", identity: "questions", question: "Phone test needs you", label: "Phone test needs you", since: new Date(clock).toISOString() });
    before.helper.waits.markTold([legacy.key], "helper", "m1");
    expect(new WaitStore(store.root).get(recordKey("kb", main.id, "questions"))?.closedAt).toBeNull();
    const n = make();
    const heard = plugIn(n);
    const stop = n.start();
    await settle(n);
    expect(heard).toEqual([]);
    const open = n.helper.waits.open();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ toldVia: "helper", messageId: "m1", question: "Did it reach your phone?", urgent: true, why: "testing" });
    stop();
  });
});

describe("notify_user from a step", () => {
  test("a hidden tool ticket's urgent message keeps its urgent mark and why", async () => {
    const store = new Store(tempDir("ck-home-"));
    const bus = new Bus();
    store.saveProfile({ name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
    const main = store.updateTicket("kb", store.createTicket("kb", { title: "Feature", body: "b", status: "review" }).id, { main: true });
    const tool = store.updateTicket("kb", store.createTicket("kb", { title: "Step", body: "b", status: "in_progress" }).id, { parentId: main.id, tool: true, kind: "with_you" });
    const n = new Notifier(store, bus, {
      root: store.root, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://x", debounceMs: 1000, tickMs: 60_000, fetch: async () => new Response("ok"), banner: () => {},
    });
    const heard: WaitRecord[] = [];
    n.helper.setSink({ healthy: () => true, lastSuccessAt: () => null, onWait: (r) => heard.push(r) });
    await n.message("kb", tool.id, "Check your phone now", { urgent: true, why: "the test alert is out" });
    expect(heard).toEqual([expect.objectContaining({ ticketId: main.id, kind: "message", urgent: true, why: "the test alert is out", question: "Step: Check your phone now" })]);
  });
});
