// A main ticket's chat while tasks wait on the user (web/src/taskCards.ts): short grey notes, the card's question and
// one-click answer, the "N waiting on you" list and the side sheet's URL hash.
import { expect, test } from "bun:test";
import { cardQuestion, oneClick, oneLine, sheetFromHash, sheetHash, shortNote, waitingItems, waitingLabel } from "../web/src/taskCards";

const TITLE = "Live-call session 3 with Leo's phone (remaining 19 lines)";

test("shortNote drops the task's name the card already shows", () => {
  expect(shortNote(`${TITLE} needs you: Call 3 results:`, TITLE)).toBe("Call 3 results");
  expect(shortNote(`Round 1: ${TITLE} needs you: Call 2 passed.`, TITLE)).toBe("Call 2 passed.");
  expect(shortNote(`${TITLE} needs you`, TITLE)).toBe("Needs you");
  // Notes about something else, or with an unknown task, stay whole.
  expect(shortNote("Staging check finished", TITLE)).toBe("Staging check finished");
  expect(shortNote(`Other task needs you: hi`, TITLE)).toBe("Other task needs you: hi");
  expect(shortNote(`${TITLE} needs you: x`, undefined)).toBe(`${TITLE} needs you: x`);
});

test("oneLine keeps the first line and cuts long text with …", () => {
  expect(oneLine("\n## Heading\nmore")).toBe("Heading");
  expect(oneLine("Call 4 results:\n- greeted by name\n- hung up")).toBe("Call 4 results: greeted by name");
  const long = oneLine("a".repeat(300), 20);
  expect(long.length).toBe(20);
  expect(long.endsWith("…")).toBe(true);
});

const q = (question: string, rec?: string, multiSelect = false) => ({
  question, multiSelect, options: [{ label: "Yes", recommended: rec === "Yes" }, { label: "No", recommended: rec === "No" }],
});
const form = (questions: ReturnType<typeof q>[], open = true) => ({ role: "reply" as const, text: "", questions, form: { open, key: "k" } });

test("cardQuestion: the open form's first question in plain words, else the last reply's first line", () => {
  expect(cardQuestion([form([q("Did the bot greet the caller by **name**?")])])).toBe("Did the bot greet the caller by name?");
  expect(cardQuestion([form([q("First?"), q("Second?")])])).toBe("First? (+1 more)");
  expect(cardQuestion([{ role: "reply", text: "Results so far:\n- a\n- b" }])).toBe("Results so far: a");
  // An answered form doesn't count as waiting.
  expect(cardQuestion([form([q("Old?")], false), { role: "user", text: "yes" }, { role: "reply", text: "Ready for call 4?" }])).toBe("Ready for call 4?");
});

test("oneClick sends the recommended answers the way the form does", () => {
  const one = oneClick([q("Did it greet by name?", "Yes")]);
  expect(one?.label).toBe("Yes (recommended)");
  expect(one?.text).toBe("My answers:\n- Did it greet by name? → Yes");
  const two = oneClick([q("A?", "Yes"), q("B?", "No")]);
  expect(two?.label).toBe("Use the 2 recommended answers");
  expect(two?.text).toBe("My answers:\n- A? → Yes\n- B? → No");
  // Something the user has to choose: no shortcut.
  expect(oneClick([q("A?", "Yes"), q("B?")])).toBeNull();
  expect(oneClick([q("A?", "Yes", true)])).toBeNull();
  expect(oneClick(undefined)).toBeNull();
});

test("waitingItems: waiting tasks, other tasks that need the user, then this chat's form; no sentence twice", () => {
  const items = waitingItems({
    steps: [{ id: "a", title: "Live-call session 3", waiting: true }, { id: "b", title: "Done task", waiting: false }],
    messages: [{ stepId: "a", ...form([q("Did the bot greet the caller by name?", "Yes")]) }],
    needsYou: [{ id: "a", title: "Live-call session 3" }, { id: "c", title: "Script review", why: "1 question for you" }],
    selfForm: { question: "Keep the **Spanish** line?" },
    statusWaiting: "Answer the call 3 questions",
  });
  expect(items).toEqual([
    { kind: "task", id: "a", title: "Live-call session 3", question: "Did the bot greet the caller by name?" },
    { kind: "task", id: "c", title: "Script review", question: "1 question for you" },
    { kind: "form", id: "", title: "This chat", question: "Keep the Spanish line?" },
  ]);
  // Claude's status sentence shows only when nothing else waits.
  expect(waitingItems({ steps: [], messages: [], needsYou: [], selfForm: null, statusWaiting: "  Pick a\nchat style " }))
    .toEqual([{ kind: "status", id: "", title: "Status", question: "Pick a chat style" }]);
  expect(waitingItems({ steps: [], messages: [], needsYou: [], selfForm: null })).toEqual([]);
  expect(waitingLabel(3)).toBe("3 waiting on you");
});

test("the sheet's task lives in the URL hash", () => {
  expect(sheetHash("#/rocketbots/t_1", "t_2")).toBe("#/rocketbots/t_1?sheet=t_2");
  expect(sheetHash("#/rocketbots/t_1?sheet=t_2", null)).toBe("#/rocketbots/t_1");
  expect(sheetHash("#/rocketbots/t_1?x=1&sheet=t_2", null)).toBe("#/rocketbots/t_1?x=1");
  expect(sheetFromHash("#/rocketbots/t_1?sheet=t_2")).toBe("t_2");
  expect(sheetFromHash("#/rocketbots/t_1")).toBeNull();
});
