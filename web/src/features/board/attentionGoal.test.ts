import { expect, test } from "bun:test";
import { ASK_LOOKBACK, asksUser, attentionGoal, pickAsk } from "../web/src/attentionGoal";

test("a question to the user asks; a status note doesn't", () => {
  expect(asksUser("The fix is to look at every photo. Should I start that fix?", ["Should I start that fix?"])).toBe(true);
  expect(asksUser("Which of the two do you prefer?\n\nA or B.")).toBe(true);
  expect(asksUser("The status now shows the 10 am check ran and the desk missed the photo sizes; the photo fix is waiting for your go-ahead.")).toBe(false);
  expect(asksUser("Done: pushed abc123 to main.")).toBe(false);
});

test("quoted questions, code and links don't count", () => {
  expect(asksUser('It would say "is that your size?" and put the sizes on the card.')).toBe(false);
  expect(asksUser("It now replies “Can I help?” to every customer.")).toBe(false);
  expect(asksUser("Call `ask()?` in the loop.")).toBe(false);
  expect(asksUser("See https://x.com/a?b=1 for details.")).toBe(false);
});

test("a bold ask or an ask phrase counts without a question mark", () => {
  expect(asksUser("Two ways to fix it. Your call.", ["Your call"])).toBe(true);
  expect(asksUser("Here is the plan. Please confirm and I'll start.")).toBe(true);
  expect(asksUser("Let me know which option you want.")).toBe(true);
  expect(asksUser("Fixed it.", ["Fixed"])).toBe(false);
});

test("Leo's case: a question followed by a plain status note picks the question", () => {
  const items = [
    { text: "Earlier report." },
    { text: "The fix is to have the desk look at every customer photo, for example \"is that your size?\". Should I start that fix?", bold: ["Should I start that fix?"] },
    { text: "The status now shows the 10 am follow-up check ran and the desk missed the photo sizes; the photo fix is waiting for your go-ahead." },
  ];
  expect(pickAsk(items)).toBe(1);
});

test("the newest ask wins, and an ask the user already answered doesn't", () => {
  expect(pickAsk([{ text: "Old question?" }, { text: "New question?" }, { text: "Note." }])).toBe(1);
  expect(pickAsk([{ text: "Should I start?" }, { user: true }, { text: "Started. All done." }])).toBe(-1);
  expect(pickAsk([{ text: "Note." }])).toBe(-1);
  expect(pickAsk([])).toBe(-1);
});

test("only the newest replies are looked at", () => {
  const notes = Array.from({ length: ASK_LOOKBACK }, () => ({ text: "Status note." }));
  expect(pickAsk([{ text: "Very old question?" }, ...notes])).toBe(-1);
  expect(pickAsk([{ text: "Recent question?" }, ...notes.slice(1)])).toBe(0);
});

test("only a plain block looks for the ask", () => {
  expect(attentionGoal({ kind: "blocked", label: "Blocked" })!.find).toBe("ask");
  expect(attentionGoal({ kind: "blocked", label: "Stopped at $1.00 cap" }, { capHit: { capUsd: 1 } })!.find).toBeUndefined();
  expect(attentionGoal({ kind: "questions", label: "Answer Claude" })!.find).toBeUndefined();
  expect(attentionGoal({ kind: "proposal", label: "Review" })!.find).toBeUndefined();
  expect(attentionGoal({ kind: "failed", label: "Run failed" })!.find).toBeUndefined();
});
