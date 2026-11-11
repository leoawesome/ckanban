import { afterAll, beforeAll, expect, test } from "bun:test";
import { attentionFor, STUCK_ON_QUESTIONS, userWaitReason } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { stepWait, youWaiting } from "../src/server/main-ticket";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { askClosed, familyState } from "../web/src/family";
import { answersMessage, formStates, parseAnswers } from "../web/src/questionForms";
import { stepMessages } from "../web/src/stepTalk";
import { questionsError } from "../src/mcp-server";
import { tempDir } from "./helpers";

const T = (p: Partial<Ticket>): Ticket => ({
  id: "t", title: "T", status: "review", order: 1, sessionId: "s", worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "b", ...p,
});
const S = (p: Partial<SessionSummary>): SessionSummary => ({
  title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], ...p,
});
const Q = (question: string, context?: string) => ({ question, ...(context ? { context } : {}), options: [{ label: "Yes", recommended: true }, { label: "No" }] });

test("answers pair with their questions by text; unmatched ones stay empty; the note comes after the list", () => {
  const qs = [Q("Ship **it**?"), Q("Which colour?"), Q("Anything else?")];
  const text = answersMessage(qs, [
    { picked: ["Yes"], otherOn: false, other: "" },
    { picked: ["Red", "Blue"], otherOn: true, other: "Green\nand teal" },
    { picked: [], otherOn: false, other: "" },
  ], "Thanks");
  const r = parseAnswers(text, qs);
  expect(r.answers).toEqual(["Yes", "Red; Blue; Green\nand teal", "(no preference)"]);
  expect(r.note).toBe("Thanks");
  // A question the message doesn't answer has no answer, never a guess from its position.
  expect(parseAnswers(text, [Q("Ship **it**?"), Q("Something new?")]).answers).toEqual(["Yes", null]);
  // A typed reply (not the form's message) pairs nothing.
  expect(parseAnswers("Let's skip this", qs)).toEqual({ answers: [null, null, null], note: "" });
});

const E = (uuid: string, p: Record<string, unknown>) => ({ uuid, at: "2026-11-11T00:00:00Z", role: "assistant" as const, kind: "text", text: "", ...p });

test("form states: answered points at its answer; a closed form is closed and stops waiting; closeLatest closes the newest", () => {
  const entries = [E("f1", { questions: [Q("A?")] }), E("u1", { role: "user", text: "My answers:\n- A? → Yes" }), E("f2", { questions: [Q("B?")] })];
  const open = formStates(entries);
  expect(open.get(0)).toEqual({ state: "answered", by: 1 });
  expect(open.get(2)).toEqual({ state: "open", key: "f2" });
  expect(formStates(entries, false, new Set(["f2"])).get(2)).toEqual({ state: "closed" });
  expect(formStates(entries, false, new Set(), true).get(2)).toEqual({ state: "closed" });
  // Answering wins over a stale close flag: replying shows it answered.
  expect(formStates(entries, true, new Set(), true).get(2)).toEqual({ state: "answered" });
  // A closed form followed by a new one: the new one is open on its own key, the closed one isn't "replaced".
  const again = [...entries, E("f3", { questions: [Q("C?")] })];
  const s = formStates(again, false, new Set(["f2"]));
  expect(s.get(2)).toEqual({ state: "closed" });
  expect(s.get(3)).toEqual({ state: "open", key: "f3" });
  // A task's closed form isn't open in the main chat's task card either.
  expect(stepMessages("k", entries, false, new Set(["f2"])).find((m) => m.uuid === "f2")?.form).toEqual({ open: false, key: "f2" });
});

test("a close after the last run ended clears every 'needs you'; a newer run asks again", () => {
  const closedForms = { f2: { at: "2026-11-11T10:00:00.000Z", by: "user" as const } };
  const asked = T({ outcome: "needs_input", runEndedAt: "2026-11-11T09:00:00.000Z" });
  const closed = { ...asked, closedForms };
  expect(askClosed(closed)).toBe(true);
  expect(attentionFor(asked, S({ openQuestions: 1 }), false)?.kind).toBe("questions");
  expect(attentionFor(closed, S({ openQuestions: 1 }), false)).toMatchObject({ kind: "review" });
  expect(userWaitReason(asked, S({ openQuestions: 1 }))).not.toBeNull();
  expect(userWaitReason(closed, S({ openQuestions: 1 }))).toBeNull();
  // A plan stuck only on that question no longer says "Plan stuck"; stuck for another reason still does.
  const plan = { state: "stuck", reason: STUCK_ON_QUESTIONS, wakeups: 0, startedAt: "", originalCount: 1 } as any;
  expect(attentionFor({ ...asked, main: true, plan }, S({ openQuestions: 1 }), false)?.label).toBe("Plan stuck");
  expect(attentionFor({ ...closed, main: true, plan }, S({ openQuestions: 1 }), false)?.label).not.toBe("Plan stuck");
  expect(attentionFor({ ...closed, main: true, plan: { ...plan, reason: "no progress" } }, null, false)?.label).toBe("Plan stuck");
  // A newer run that asks again waits on the user again.
  const later = { ...closed, runEndedAt: "2026-11-11T11:00:00.000Z" };
  expect(askClosed(later)).toBe(false);
  expect(attentionFor(later, S({ openQuestions: 1 }), false)?.kind).toBe("questions");
  // A "with you" task whose question was closed doesn't wait (main card, family row, waiting list).
  const task = { ...closed, tool: true, kind: "with_you" as const, parentId: "m" };
  expect(youWaiting({ ...task, closedForms: undefined }, false)).toBe(true);
  expect(youWaiting(task, false)).toBe(false);
  expect(stepWait(task, false)).toBeNull();
  expect(familyState({ ...task, closedForms: undefined })).toBe("in_review");
  expect(familyState({ ...task, closedForms: undefined }, true)).toBe("needs_you");
  expect(familyState(task)).toBe("waiting");
});

test("ask_questions takes about as a list of task ids", () => {
  const base = { questions: [Q("A?")] };
  expect(questionsError({ ...base, about: ["t_1"] })).toBeNull();
  expect(questionsError({ ...base, about: "t_1" })).toMatch(/about/);
  expect(questionsError({ ...base, about: [1] })).toMatch(/about/);
});

let store: Store;
let board: Board;
let server: ReturnType<typeof createServer>;
let base: string;
const summaries = new Map<string, SessionSummary>();

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false", sessionSummary: (id) => summaries.get(id) ?? null });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  server = createServer({ store, bus: new Bus(), board, port: 0, webDir: tempDir("ck-web-"), isUserBrowser: async () => true });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("Close question is stored on the ticket, starts nothing, and only the user can do it", async () => {
  const t = store.createTicket("p", { title: "Main", body: "", status: "review", main: true });
  store.updateTicket("p", t.id, { sessionId: "sm", outcome: "needs_input", runEndedAt: "2026-01-01T00:00:00.000Z" });
  summaries.set("sm", S({ openQuestions: 1, openFormId: "toolu_1" }));
  const put = (headers: Record<string, string> = {}) => fetch(`${base}/api/profiles/p/tickets/${t.id}/closed-forms/toolu_1`, {
    method: "PUT", body: "{}", headers: { "content-type": "application/json", origin: base, ...headers },
  });
  const r = await put();
  expect(r.status).toBe(200);
  const after = store.getTicket("p", t.id)!;
  expect(after.closedForms?.toolu_1).toMatchObject({ by: "user", run: "2026-01-01T00:00:00.000Z" });
  expect(askClosed(after)).toBe(true);
  // No run, no message, no queue.
  expect(board.isRunning("p", t.id)).toBe(false);
  expect(after.queued ?? []).toEqual([]);
  expect(after.runCount).toBe(0);
  expect(after.status).toBe("review");
  // Survives a reload: it is in the ticket file.
  expect(new Store(store.root).getTicket("p", t.id)?.closedForms?.toolu_1).toBeDefined();
  // A run, a huddle or another program (no Origin) can't close the user's question.
  expect((await put({ "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
});

test("only the user's browser closes a question: runs, huddles, guests and other programs are refused", async () => {
  const t = store.createTicket("p", { title: "Main R", body: "", status: "review", main: true });
  store.updateTicket("p", t.id, { sessionId: "smr", outcome: "needs_input", runEndedAt: "2026-01-01T00:00:00.000Z" });
  summaries.set("smr", S({ openQuestions: 1, openFormId: "toolu_r" }));
  const other = store.createTicket("p", { title: "Other run", body: "", status: "in_progress" });
  const put = (headers: Record<string, string>) => fetch(`${base}/api/profiles/p/tickets/${t.id}/closed-forms/toolu_r`, {
    method: "PUT", body: "{}", headers: { "content-type": "application/json", ...headers },
  });
  expect((await put({ origin: base, "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect((await put({ origin: base, "x-ckanban-run": `p/${other.id}` })).status).toBe(403);
  expect((await put({ origin: base, "x-ckanban-huddle-agent": "h_1" })).status).toBe(403);
  expect((await put({})).status).toBe(403);
  expect(store.getTicket("p", t.id)!.closedForms).toBeUndefined();
});

test("a stale close doesn't hide a newer question", async () => {
  const t = store.createTicket("p", { title: "Main S", body: "", status: "review", main: true });
  store.updateTicket("p", t.id, { sessionId: "sms", outcome: "needs_input", runEndedAt: "2026-01-01T00:00:00.000Z" });
  // A newer run asked a new form (toolu_new); a tab still showing the old one (toolu_old) closes it.
  summaries.set("sms", S({ openQuestions: 1, openFormId: "toolu_new" }));
  const put = (uuid: string) => fetch(`${base}/api/profiles/p/tickets/${t.id}/closed-forms/${uuid}`, {
    method: "PUT", body: "{}", headers: { "content-type": "application/json", origin: base },
  });
  expect((await put("toolu_old")).status).toBe(409);
  expect((await put("made-up-id")).status).toBe(409);
  const after = store.getTicket("p", t.id)!;
  expect(after.closedForms).toBeUndefined();
  expect(askClosed(after)).toBe(false);
  // Nothing open: nothing to close.
  summaries.set("sms", S({}));
  expect((await put("toolu_new")).status).toBe(409);
  // A close is tied to the run that asked: one made for an earlier run never closes the next run's question,
  // even when its time is later (clock skew, a slow request).
  const closedForms = { f1: { at: "2026-11-11T12:00:00.000Z", by: "user" as const, run: "2026-11-11T09:00:00.000Z" } };
  expect(askClosed({ closedForms, runEndedAt: "2026-11-11T09:00:00.000Z" })).toBe(true);
  expect(askClosed({ closedForms, runEndedAt: "2026-11-11T11:00:00.000Z" })).toBe(false);
});

test("answering in a task's chat closes the main ticket's question about that task, and only that", () => {
  const main = store.createTicket("p", { title: "Main 2", body: "", status: "review", main: true });
  store.updateTicket("p", main.id, { sessionId: "sm2", runEndedAt: "2026-01-01T00:00:00.000Z" });
  const task = store.createTicket("p", { title: "Find the deploy break", body: "", status: "done", parentId: main.id, tool: true, kind: "explore" });
  const other = store.createTicket("p", { title: "Other", body: "", status: "done", parentId: main.id, tool: true, kind: "explore" });
  summaries.set("sm2", S({ openQuestions: 1, openFormId: "toolu_main", openAsk: { about: [task.id] } }));
  expect(board.closeQuestionsAbout("p", store.getTicket("p", other.id)!, true)).toBeNull();
  expect(store.getTicket("p", main.id)!.closedForms).toBeUndefined();
  // A message to a task that wasn't waiting on the user ("status?") closes nothing.
  expect(board.closeQuestionsAbout("p", store.getTicket("p", task.id)!, false)).toBeNull();
  expect(store.getTicket("p", main.id)!.closedForms).toBeUndefined();
  expect(board.closeQuestionsAbout("p", store.getTicket("p", task.id)!, true)?.id).toBe(main.id);
  expect(store.getTicket("p", main.id)!.closedForms?.toolu_main).toMatchObject({ by: "task", taskId: task.id, run: "2026-01-01T00:00:00.000Z" });
  // A form without about is never closed by a task's chat.
  const m3 = store.createTicket("p", { title: "Main 3", body: "", status: "review", main: true });
  store.updateTicket("p", m3.id, { sessionId: "sm3" });
  const k3 = store.createTicket("p", { title: "K", body: "", status: "done", parentId: m3.id, tool: true, kind: "explore" });
  summaries.set("sm3", S({ openQuestions: 1, openFormId: "toolu_3" }));
  expect(board.closeQuestionsAbout("p", store.getTicket("p", k3.id)!, true)).toBeNull();
  // A form whose id isn't known is never closed (no "task:<id>" stand-ins).
  const m4 = store.createTicket("p", { title: "Main 4", body: "", status: "review", main: true });
  store.updateTicket("p", m4.id, { sessionId: "sm4" });
  const k4 = store.createTicket("p", { title: "K4", body: "", status: "done", parentId: m4.id, tool: true, kind: "explore" });
  summaries.set("sm4", S({ openQuestions: 1, openAsk: { about: [k4.id] } }));
  expect(board.closeQuestionsAbout("p", store.getTicket("p", k4.id)!, true)).toBeNull();
});

test("the task's waiting state decides: a message to a waiting task closes, to a working or idle one it doesn't", () => {
  const main = store.createTicket("p", { title: "Main W", body: "", status: "review", main: true });
  store.updateTicket("p", main.id, { sessionId: "smw", runEndedAt: "2026-01-01T00:00:00.000Z" });
  const task = store.createTicket("p", { title: "W", body: "", status: "review", parentId: main.id, tool: true, kind: "explore" });
  summaries.set("smw", S({ openQuestions: 1, openFormId: "toolu_w", openAsk: { about: [task.id] } }));
  // Finished task, no question for the user: not waiting.
  store.updateTicket("p", task.id, { outcome: "done" });
  expect(board.waitsForAnswer("p", store.getTicket("p", task.id)!)).toBe(false);
  // It asked: waiting.
  store.updateTicket("p", task.id, { outcome: "needs_input" });
  expect(board.waitsForAnswer("p", store.getTicket("p", task.id)!)).toBe(true);
});
