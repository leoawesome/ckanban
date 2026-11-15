// Copy on a Draft card in Claude's reply takes only the quote's text (web/src/draftText.ts), and on a phone one of the
// user's messages at a time shows its actions (web/src/shownMessage.ts).
import { expect, test } from "bun:test";
import { draftText, type DraftNode } from "../web/src/draftText";
import { nextShown } from "../web/src/shownMessage";

const text = (t: string): DraftNode => ({ nodeType: 3, nodeName: "#text", nodeValue: t, childNodes: [] });
const el = (name: string, ...kids: (DraftNode | string)[]): DraftNode =>
  ({ nodeType: 1, nodeName: name, nodeValue: null, childNodes: kids.map((k) => (typeof k === "string" ? text(k) : k)) });

test("a draft keeps its line breaks and paragraphs, without the HTML's own newlines", () => {
  // What marked makes of "> Hi Sam,\n>\n> Thanks for the proposal.\n> The price is too high.\n>\n> Best,\n> Leo"
  const quote = el("BLOCKQUOTE", "\n",
    el("P", "Hi Sam,"), "\n",
    el("P", "Thanks for the proposal.", el("BR"), "The price is too high."), "\n",
    el("P", "Best,", el("BR"), "\nLeo"), "\n");
  expect(draftText(quote)).toBe("Hi Sam,\n\nThanks for the proposal.\nThe price is too high.\n\nBest,\nLeo");
});

test("inline formatting stays as plain text; lists put each item on its own line", () => {
  const quote = el("BLOCKQUOTE",
    el("P", "Please ", el("STRONG", "confirm"), " by ", el("EM", "Friday"), ":"), "\n",
    el("UL", "\n", el("LI", "the date"), "\n", el("LI", "the price"), "\n"), "\n",
    el("OL", el("LI", "one"), el("LI", "two")));
  expect(draftText(quote)).toBe("Please confirm by Friday:\n\n- the date\n- the price\n\n1. one\n2. two");
});

test("code keeps its spacing and the card's buttons aren't copied", () => {
  const quote = el("BLOCKQUOTE", el("P", "Run:"),
    el("DIV", el("PRE", el("CODE", "if x:\n    go()\n")), el("BUTTON", "Copy text")));
  expect(draftText(quote)).toBe("Run:\n\nif x:\n    go()");
});

test("one message at a time shows its actions; tapping it again hides them", () => {
  expect(nextShown(null, "a")).toBe("a");
  expect(nextShown("a", "a")).toBeNull();
  expect(nextShown("a", "b")).toBe("b");
});
