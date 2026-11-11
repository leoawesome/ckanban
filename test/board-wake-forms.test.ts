import { expect, test } from "bun:test";
import { mainWakePrompt, orchestratorPrompt, statusNudgePrompt } from "../src/server/prompts";
import { parseSession, type Question, type SessionEntry } from "../src/server/session";
import type { Ticket } from "../src/server/types";
import { formStates, fresh, startProgress, type Progress } from "../web/src/questionForms";

const L = (o: unknown) => JSON.stringify(o);
const user = (text: string, at: string) => L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content: text } });
const ask = (id: string, questions: unknown, at: string) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__ckanban__ask_questions", input: { questions } }] } });
const reply = (text: string, at: string) => L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });

const QS = [
  { question: "Which colour?", multiSelect: false, options: [{ label: "Red", recommended: true }, { label: "Blue" }] },
  { question: "Ship today?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
] as Question[];
const T = { id: "t_main", title: "Main", main: true } as unknown as Ticket;
const wake = (open: Question[] = []) => mainWakePrompt(T, { kind: "event", events: ["Build X finished: done"], table: "(none)", board: "b", open });

test("a board wake shows as a board note with a one-line summary, and doesn't answer the open form", () => {
  const s = parseSession([
    user("Plan it", "2026-11-05T01:00:00Z"),
    ask("q1", QS, "2026-11-05T01:00:01Z"),
    user(wake(), "2026-11-05T01:00:02Z"),
    reply("Noted.", "2026-11-05T01:00:03Z"),
    user(statusNudgePrompt("/tmp/status.md", ["Build X: done"]), "2026-11-05T01:00:04Z"),
  ].join("\n"));
  const wakes = s.entries.filter((e) => e.wake);
  expect(wakes).toHaveLength(2);
  expect(wakes[0]).toMatchObject({ role: "user", kind: "board", wake: "1 update from a tool ticket" });
  expect(wakes[0].text).toContain("Build X finished");
  expect(wakes[0].text).not.toContain("ckanban-context");
  expect(wakes[0].rewind).toBeUndefined();
  expect(wakes[1]).toMatchObject({ kind: "board", wake: "status refresh, 1 change in the feature" });
  // The form is still waiting for the user's answers.
  expect(s.openQuestions).toBe(2);
  expect(s.openForm.map((q) => q.question)).toEqual(["Which colour?", "Ship today?"]);
  // Asked again: still one form of 2 questions, not 4.
  const again = parseSession([ask("q1", QS, "2026-11-05T01:00:01Z"), user(wake(QS), "2026-11-05T01:00:02Z"), ask("q2", QS, "2026-11-05T01:00:03Z")].join("\n"));
  expect(again.openQuestions).toBe(2);
  // The user's own answer closes it.
  expect(parseSession([ask("q1", QS, "2026-11-05T01:00:01Z"), user("My answers: Red", "2026-11-05T01:00:02Z")].join("\n")).openQuestions).toBe(0);
});

test("wake texts list the open questions and ask Claude to ask them again; without an open form they don't", () => {
  for (const text of [
    wake(QS),
    statusNudgePrompt("/tmp/status.md", [], QS),
    orchestratorPrompt(T, { kind: "event", events: ["x"], table: "", board: "b", outputDir: "/tmp", open: QS }),
  ]) {
    expect(text).toContain("# Questions still open");
    expect(text).toContain("call ask_questions again with exactly the same questions and options");
    expect(text).toContain(JSON.stringify("Which colour?"));
    expect(text).toMatch(/<ckanban-context [^>]*wake="[^"]+"/);
  }
  expect(wake()).not.toContain("Questions still open");
  // What the wakes ask is otherwise unchanged.
  expect(statusNudgePrompt("/p", ["a"])).toContain("call the ckanban `update_status` tool");
  expect(statusNudgePrompt("/p", ["a"])).toContain("don't write a CKANBAN_RESULT line");
});

const E = (e: Partial<SessionEntry> & Pick<SessionEntry, "uuid">): SessionEntry => ({ at: "", role: "assistant", kind: "text", text: "", ...e }) as SessionEntry;

test("a board update leaves the form open; asked again, the old form says so and both share where the typed answers are saved", () => {
  const form = E({ uuid: "q1", questions: QS });
  const note = E({ uuid: "w", role: "user", kind: "board", wake: "1 update from a tool ticket", text: "1 update…" });
  expect(formStates([form, note]).get(0)).toEqual({ state: "open", key: "q1" });
  const states = formStates([form, note, E({ uuid: "q2", questions: QS })]);
  expect(states.get(0)).toEqual({ state: "replaced", same: true });
  expect(states.get(2)).toEqual({ state: "open", key: "q1" });
  const answered = formStates([form, note, E({ uuid: "q2", questions: QS }), E({ uuid: "u", role: "user", text: "My answers" }), E({ uuid: "q3", questions: QS })]);
  expect(answered.get(2)).toEqual({ state: "answered", by: 3 });
  expect(answered.get(0)).toEqual({ state: "replaced", same: true });
  expect(answered.get(4)).toEqual({ state: "open", key: "q3" });
  expect(formStates([form], true).get(0)).toEqual({ state: "answered" });
  expect(formStates([form, E({ uuid: "q2", questions: [QS[1]] })]).get(0)).toEqual({ state: "replaced", same: false });
});

test("typed answers carry over to the form asked again, question by question", () => {
  const typed: Progress = { ...fresh(QS), answers: [{ picked: [], otherOn: true, other: "Green, half typ" }, { picked: ["No"], otherOn: false, other: "" }], step: 1, note: "thanks" };
  // Same questions: exactly where the user was.
  expect(startProgress(QS, typed)).toBe(typed);
  // A different form that shares a question keeps that answer and the note.
  const next = [QS[1], { question: "New?", multiSelect: false, options: [{ label: "A" }] }] as Question[];
  const carried = startProgress(next, typed);
  expect(carried.answers[0]).toEqual({ picked: ["No"], otherOn: false, other: "" });
  expect(carried.answers[1]).toEqual(fresh(next).answers[1]);
  expect(carried.note).toBe("thanks");
  expect(carried.step).toBe(0);
  // Nothing saved, or unreadable: fresh.
  expect(startProgress(QS, null)).toEqual(fresh(QS));
  expect(startProgress(QS, { sig: "not json" } as unknown as Progress)).toEqual(fresh(QS));
});
