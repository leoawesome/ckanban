import { expect, test } from "bun:test";
import { answersMessage, formStates, isAnswersMessage } from "./questionForms";

const q = [{ question: "Which size goes on the quotation?", options: [{ label: "4ft", recommended: true }, { label: "5ft" }] }];
const form = (uuid: string) => ({ uuid, role: "assistant" as const, kind: "text", questions: q });
const user = (text?: string) => ({ uuid: "u", role: "user" as const, kind: "text", ...(text === undefined ? {} : { text }) });
const answers = answersMessage(q, [{ picked: ["5ft"], otherOn: false, other: "" }]);

test("a typed chat message closes a form as replied, not answered", () => {
  expect([...formStates([form("f"), user("Why did you send 4 instead of 5?")])]).toEqual([[0, { state: "replied", by: 1 }]]);
  expect([...formStates([form("f"), user(answers)])]).toEqual([[0, { state: "answered", by: 1 }]]);
});

test("old chats still render: an entry without its words stays answered", () => {
  expect([...formStates([form("f"), user()])]).toEqual([[0, { state: "answered", by: 1 }]]);
});

test("a message on its way: typed text replies, the form's answers answer", () => {
  expect(formStates([form("f")], "typed").get(0)).toEqual({ state: "replied" });
  expect(formStates([form("f")], true).get(0)).toEqual({ state: "answered" });
  expect(isAnswersMessage(answers)).toBe(true);
  expect(isAnswersMessage("You can create quotation I believe")).toBe(false);
});

test("a form asked again after a typed reply is open", () => {
  const s = formStates([form("f1"), user("Why 4?"), form("f2")]);
  expect(s.get(0)).toEqual({ state: "replied", by: 1 });
  expect(s.get(2)).toEqual({ state: "open", key: "f2" });
});
