// Old message pages show where each ticket stands (Answered 14:02, Ticket removed), the ticket page's helper line
// links to its alert, and the helper card counts today's checks.
import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/server/events";
import { itemStateKey } from "../src/server/helper/core";
import { helperSpendFile, helperSpendOn, HelperRunner, lineMessage } from "../src/server/helper/runner";
import { normalizeSettings, Notifier, writeNotifySettings } from "../src/server/notify";
import type { SessionSummary } from "../src/server/session";
import { addSideSpend, type SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Profile, Ticket } from "../src/server/types";
import { anyItemOpen, itemStateLabel, spendLine, type Message } from "../web/src/helperText";
import { tempDir } from "./helpers";

const DAY = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();

describe("message item states, helper line link, spend count", () => {
  let store: Store;
  let bus: Bus;
  let clock: number;
  let summaries: Map<string, SessionSummary>;
  let answers: SideCallResult[];
  let ticket: Ticket;
  let n: Notifier;
  let h: HelperRunner;

  const make = () => {
    n = new Notifier(store, bus, {
      root: store.root, sessionSummary: (id) => summaries.get(id) ?? null, isRunning: () => false, hostHuddles: () => new Map(),
      baseUrl: () => "https://mac.ts.net", debounceMs: 1000, tickMs: 3600_000, now: () => clock,
      fetch: async () => new Response("ok"),
      banner: () => {},
    });
    h = new HelperRunner({
      root: store.root, store, core: n.helper, notifySettings: () => n.settings(), link: (s, id) => n.link(s, id), messageLink: (id) => n.messageLink(id), now: () => clock,
      snoozedUntil: () => null,
      sideCall: async () => answers.shift() ?? { ok: false, error: "no answer queued" },
    });
    return n.start();
  };
  const answer = (d: object, costUsd = 0.02): SideCallResult => ({ ok: true, text: JSON.stringify({ sends: [], nextWakeIn: 60, notes: "", log: "ok", ...d }), costUsd, model: "sonnet" });
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

  beforeEach(() => {
    store = new Store(tempDir("ck-home-"));
    bus = new Bus();
    clock = DAY(14, 0);
    summaries = new Map();
    answers = [];
    const p: Profile = { name: "Kanban", slug: "kb", path: tempDir(), baseBranch: "main", maxParallel: 1, model: null, createdAt: "" };
    store.saveProfile(p);
    ticket = store.createTicket("kb", { title: "Pricing", body: "b", status: "in_progress" });
    writeNotifySettings(store.root, normalizeSettings({ webhookUrl: "https://ntfy.sh/topic", mac: false }));
    writeFileSync(join(store.root, "helper-state.json"), JSON.stringify({ helloSentAt: "2026-11-01T00:00:00Z", nightNoticeAt: "2026-11-01T00:00:00Z" }));
  });

  test("an alert's tickets go open → answered, or removed when the ticket is deleted; the line links to the newest reminder", async () => {
    const stop = make();
    const other = store.createTicket("kb", { title: "Billing", body: "b", status: "in_progress" });
    clock += 2 * 60_000;
    ask(ticket.id, ["Stop the old webhook?"], { urgent: true, why: "ingested twice" });
    ask(other.id, ["Refund the customer?"], { urgent: true, why: "angry customer" });
    await settle();
    const [a, b] = [keyOf(ticket.id), keyOf(other.id)];
    answers.push(answer({ sends: [{ level: "urgent", oneLine: "Two things are urgent", why: "x", itemKeys: [a, b], escalation: [{ channel: "webhook", afterMin: 0 }, { channel: "webhook", afterMin: 5 }, { channel: "webhook", afterMin: 10 }] }] }));
    await h.tick();
    const alert = n.helper.messages.listNewest()[0];
    expect(n.helper.itemStates(alert)).toEqual({ [a]: { state: "open" }, [b]: { state: "open" } });
    expect(h.status().lineMsg[`kb/${ticket.id}`]).toBe(alert.id);
    expect(h.status().today).toEqual({ checks: 1, costUsd: 0.02 });

    // A reminder: the ticket page's line now opens the reminder.
    clock += 5 * 60_000;
    await h.tick();
    const reminder = n.helper.messages.listNewest()[0];
    expect(reminder.level).toBe("reminder");
    expect(h.status().lineMsg[`kb/${ticket.id}`]).toBe(reminder.id);

    // Opening the ticket: the line says so.
    n.opened("kb", ticket.id);
    expect(h.status().lines[`kb/${ticket.id}`]).toMatch(/^Urgent: ntfy \S+, ntfy \S+; reminders stopped when you opened this$/);

    // Answered: closed with its time. The other ticket is deleted: removed, also on the reminder's page.
    clock += 60_000;
    n.helper.settled("kb", ticket.id, null);
    store.deleteTicket("kb", other.id);
    bus.emit({ type: "ticket.deleted", profile: "kb", id: other.id });
    const states = n.helper.itemStates(alert);
    expect(states[a]).toEqual({ state: "answered", at: new Date(clock).toISOString(), how: "answered" });
    expect(states[b].state).toBe("removed");
    expect(n.helper.itemStates(reminder)[b].state).toBe("removed");
    // No item open any more: Got it / Not urgent go away.
    const page = { ...alert, itemState: states } as unknown as Message;
    expect(anyItemOpen(page)).toBe(false);
    expect(anyItemOpen({ ...page, itemState: { ...states, [a]: { state: "open" } } })).toBe(true);
    // The line and its link are gone with the wait.
    expect(h.status().lines[`kb/${ticket.id}`]).toBeUndefined();
    expect(h.status().lineMsg[`kb/${ticket.id}`]).toBeUndefined();
    stop();
  });

  test("a ticket deleted with no wait on record, and a summary's rows, get states too", () => {
    const stop = make();
    const gone = store.createTicket("kb", { title: "Old", body: "b", status: "in_progress" });
    store.deleteTicket("kb", gone.id);
    const m = n.helper.messages.add({
      level: "summary", oneLine: "2 new for you", text: "t",
      summary: { new: [{ board: "kb", boardName: "Kanban", ticketId: ticket.id, title: "Pricing", label: "Ready" }, { board: "kb", boardName: "Kanban", ticketId: gone.id, title: "Old", label: "Ready" }], still: [], stillCount: 0, oldestAt: null, checkins: [], olderCheckins: 0, notes: [], grouped: false },
    });
    const s = n.helper.itemStates(m);
    expect(s[itemStateKey({ board: "kb", ticketId: ticket.id })]).toEqual({ state: "open" });
    expect(s[`kb/${gone.id}`]).toEqual({ state: "removed", at: null });
    expect(n.helper.withStates(m)).toMatchObject({ id: m.id, itemState: s });
    stop();
  });
});

test("the words an old message's ticket shows", () => {
  const t = (iso: string) => iso.slice(11, 16);
  expect(itemStateLabel(undefined)).toBeNull();
  expect(itemStateLabel({ state: "open" })).toBeNull();
  expect(itemStateLabel({ state: "removed", at: null })).toBe("Ticket removed");
  expect(itemStateLabel({ state: "answered", at: "2026-11-09T14:02:00", how: "answered" }, t)).toBe("Answered 14:02");
  expect(itemStateLabel({ state: "answered", at: "2026-11-09T14:02:00", how: "seen" }, t)).toBe("Seen 14:02");
  expect(itemStateLabel({ state: "answered", at: "2026-11-09T14:02:00", how: "done" }, t)).toBe("No longer waiting 14:02");
});

test("Got it shows when the page knows nothing yet, or the alert has no tickets (a practice alert)", () => {
  const base = { items: [], itemState: undefined } as Pick<Message, "items" | "itemState">;
  expect(anyItemOpen(base)).toBe(true);
  expect(anyItemOpen({ items: [], itemState: {} })).toBe(true);
});

test("the helper card's spend line counts today's paid checks only", () => {
  const root = tempDir();
  const now = new Date(2026, 10, 9, 15, 0);
  expect(helperSpendOn(root, now)).toEqual({ checks: 0, costUsd: 0 });
  addSideSpend(helperSpendFile(root), "helper", 0.5, new Date(2026, 10, 8, 23, 0));
  addSideSpend(helperSpendFile(root), "helper", 0.02, new Date(2026, 10, 9, 9, 0));
  addSideSpend(helperSpendFile(root), "helper", 0.03, new Date(2026, 10, 9, 10, 0));
  const today = helperSpendOn(root, now);
  expect(today.checks).toBe(2);
  expect(today.costUsd).toBeCloseTo(0.05);
  expect(spendLine(undefined)).toBeNull();
  expect(spendLine({ checks: 0, costUsd: 0 })).toBe("Today: no checks yet");
  expect(spendLine({ checks: 1, costUsd: 0.004 })).toBe("Today: 1 check, <$0.01");
  expect(spendLine({ checks: 12, costUsd: 0.214 })).toBe("Today: 12 checks, $0.21");
});

test("a line links to its newest sent reminder, else the message that told it", () => {
  expect(lineMessage({ messageId: "m1", reminders: [] })).toBe("m1");
  expect(lineMessage({ messageId: "m1", reminders: [{ channel: "push", dueAt: "x", sentAt: "y", messageId: "m2" }, { channel: "push", dueAt: "z" }] })).toBe("m2");
  expect(lineMessage({ messageId: null, reminders: [] })).toBeNull();
});
