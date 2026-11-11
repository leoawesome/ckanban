import { expect, test } from "bun:test";
import { ticketAttention } from "../src/server/attention";
import { Board } from "../src/server/board";
import { askedNothing, replyAsked } from "../src/server/main-ticket";
import { MAIN_QUESTIONS_RULE, mainTicketRules } from "../src/server/prompts";
import type { Question, SessionSummary } from "../src/server/session";
import type { Plan, Ticket } from "../src/server/types";
import { board, bus, FAKE, setBoard, setup, store, useBoardEnv } from "./board-env";

useBoardEnv();

const QS = [{ question: "Which project?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] as Question[];
const plan = (state: Plan["state"]) => ({ state, wakeups: 0, startedAt: new Date().toISOString(), originalCount: 1, inbox: [], seen: {}, retries: {}, awaiting: null }) as unknown as Plan;

test("replyAsked: an open form or a '?' in the reply's text; the result line doesn't count", () => {
  expect(replyAsked([], "It uses project A (id 123).")).toBe(false);
  expect(replyAsked(QS, "Pick one below.")).toBe(true);
  expect(replyAsked([], "Should I switch to project B?")).toBe(true);
  expect(replyAsked([], 'Done.\nCKANBAN_RESULT: {"status":"questions","summary":"why?"}')).toBe(false);
});

test("askedNothing only for a main ticket with a running plan", () => {
  const main = { main: true, plan: plan("running") } as Ticket;
  expect(askedNothing(main, "questions", false)).toBe(true);
  expect(askedNothing(main, "questions", true)).toBe(false);
  expect(askedNothing(main, "done", false)).toBe(false);
  expect(askedNothing({ main: true, plan: plan("paused") } as Ticket, "questions", false)).toBe(false);
  expect(askedNothing({ main: true } as Ticket, "questions", false)).toBe(false);
  expect(askedNothing({ tool: true, plan: plan("running") } as Ticket, "questions", false)).toBe(false);
});

const summaryOf = (form: Question[] = []) => ({
  openQuestions: form.length, openForm: form, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], pendingAutomations: [], lastMessage: null,
}) as unknown as SessionSummary;

/** A main ticket with a running plan whose chat reply ends with status "questions"; form: the session's open form. */
async function mainReply(o: { form?: Question[]; text?: string }) {
  setBoard(new Board(store, bus, {
    claudeBin: FAKE, isSessionLive: async () => false,
    sessionSummary: () => summaryOf(o.form),
  }));
  await setup();
  const t = await board.createTicket("p", { title: "Berry", body: "", status: "backlog" });
  store.updateTicket("p", t.id, { main: true, plan: plan("running"), sessionId: "s1" });
  // A step still waiting keeps the plan running while the main ticket replies.
  const step = await board.createTicket("p", { title: "Check", body: "", status: "backlog" });
  store.updateTicket("p", step.id, { parentId: t.id, tool: true, kind: "explore", status: "in_progress" });
  process.env.FAKE_MODE = "questions";
  if (o.text) process.env.FAKE_EXTRA = `\n${o.text}`;
  try {
    await board.chat("p", t.id, "Which PostHog project are you using?");
    await board.whenIdle();
  } finally {
    delete process.env.FAKE_EXTRA;
  }
  const after = store.getTicket("p", t.id)!;
  const summary = summaryOf(o.form);
  const attention = ticketAttention(store, "p", { ...after, status: "review" }, summary, false, null, () => false);
  // A running plan's card asks nothing by itself; what the card says without a plan in charge.
  const stopped = ticketAttention(store, "p", { ...after, status: "review", plan: null }, summary, false, null, () => false);
  return { after, attention, stopped };
}

test("a working main ticket's reply that asked nothing ends done, not needs input", async () => {
  const { after, attention, stopped } = await mainReply({});
  expect(after.outcome).toBe("done");
  expect(after.interviewed).not.toBe(true);
  expect(after.plan?.state).not.toBe("stuck");
  for (const a of [attention, stopped]) {
    expect(a?.label).not.toBe("Answer Claude");
    expect(a?.kind).not.toBe("questions");
  }
}, 15000);

test("the same reply with an open ask_questions form keeps needs input", async () => {
  const { after, stopped } = await mainReply({ form: QS });
  expect(after.outcome).toBe("needs_input");
  expect(stopped).toMatchObject({ kind: "questions", label: "Answer 1 question" });
}, 15000);

test("the same reply with a plain-text question keeps needs input", async () => {
  const { after, stopped } = await mainReply({ text: "Should I switch to project B?" });
  expect(after.outcome).toBe("needs_input");
  expect(after.interviewed).toBe(true);
  expect(stopped).toMatchObject({ kind: "questions", label: "Answer Claude" });
}, 15000);

test("the main ticket's rules (its system prompt on every run, wakes included) say when to use questions", () => {
  expect(MAIN_QUESTIONS_RULE).toContain("really asks the user something");
  expect(MAIN_QUESTIONS_RULE).toContain('ends with "done"');
  expect(mainTicketRules({ repo: "local" } as any)).toContain(MAIN_QUESTIONS_RULE);
});
