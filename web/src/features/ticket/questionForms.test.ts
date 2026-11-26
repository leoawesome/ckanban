// Question forms: small safe markdown (web/src/features/ticket/miniMarkdown.ts), the optional context, and replies that only repeat a form.
import { expect, test } from "bun:test";
import { inlineMarkdown, miniMarkdown, plainMarkdown } from "./miniMarkdown";
import { answersMessage, parseAnswers, repeatsForm, signature } from "./questionForms";

test("markdown: raw HTML is escaped, never passed through", () => {
  expect(miniMarkdown(`<img src=x onerror="alert(1)"> & <script>x</script>`))
    .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;x&lt;/script&gt;");
  expect(miniMarkdown("**<b>bold</b>**")).toBe("<strong>&lt;b&gt;bold&lt;/b&gt;</strong>");
  expect(miniMarkdown("`<i>`")).toBe("<code>&lt;i&gt;</code>");
});

test("markdown: bold, italic, code and line breaks", () => {
  expect(miniMarkdown("Ship **now** or *later*? Use `bun test`.")).toBe("Ship <strong>now</strong> or <em>later</em>? Use <code>bun test</code>.");
  expect(miniMarkdown("__also__ _this_, not snake_case_name or 2 * 3 * 4")).toBe("<strong>also</strong> <em>this</em>, not snake_case_name or 2 * 3 * 4");
  expect(miniMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
});

test("markdown: links open in a new tab; only http, https and mailto become links", () => {
  expect(miniMarkdown("See [the docs](https://example.com/a?b=1&c=2).")).toBe(
    'See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a>.');
  expect(miniMarkdown("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  expect(miniMarkdown('[x](https://a.b/"onmouseover=1)')).toContain('href="https://a.b/&quot;onmouseover=1"');
  expect(miniMarkdown("Open https://example.com/x.")).toBe(
    'Open <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
  expect(inlineMarkdown("[**a** https://x.y](https://x.y)")).toBe('<a href="https://x.y" target="_blank" rel="noopener noreferrer"><strong>a</strong> https://x.y</a>');
});

test("markdown: simple lists", () => {
  expect(miniMarkdown("What you say on call 5:\n1. Hi, it's **Maria**\n2. Ask for the order")).toBe(
    "<p>What you say on call 5:</p><ol><li>Hi, it&#39;s <strong>Maria</strong></li><li>Ask for the order</li></ol>");
  expect(miniMarkdown("- a\n- b\n  more\n\nafter")).toBe("<ul><li>a</li><li>b more</li></ul><p>after</p>");
  expect(miniMarkdown("3) c\n4) d")).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
  expect(plainMarkdown("Ship **now** or [later](https://x.y) with `code`?")).toBe("Ship now or later with code?");
});

test("context doesn't change what saved answers match", () => {
  // The server is the Rust binary now; these are forms as the Bun server parsed them (src/runs/session.ts
  // parseQuestions), one with context and an old one without.
  const options = [{ label: "Yes", recommended: true }, { label: "No", recommended: false }];
  const qs = [{ question: "Raise the timeout?", context: "The lookup came back **late**.", multiSelect: false, options }];
  const old = [{ question: "Raise the timeout?", multiSelect: false, options }];
  expect(signature(qs)).toBe(signature(old));
});

test("a reply that only repeats the form above it counts as a repeat; a real message doesn't", () => {
  const form = [{
    question: "Does the bot greet **Maria** by name now?",
    context: "The CRM lookup returned the name before the greeting. On call 2 it came back late.",
    options: [{ label: "Yes, by name", description: "Done" }, { label: "No, still Hi there" }],
  }];
  expect(repeatsForm("Does the bot greet Maria by name now?\n\nThe CRM lookup returned the name before the greeting. On call 2 it came back late.", form)).toBe(true);
  expect(repeatsForm("**Does the bot greet Maria by name now?**", form)).toBe(true);
  expect(repeatsForm("I fixed the lookup timeout and redeployed. Does the bot greet Maria by name now?", form)).toBe(false);
  expect(repeatsForm("Yes, by name", form)).toBe(false);
  expect(repeatsForm("", form)).toBe(false);
});

test("markdown: a cut-off summary's unclosed ** is dropped, spaced-out stars stay", () => {
  expect(miniMarkdown("- **Change:** merged **[#430](https://x.y/430) into `master`…"))
    .toBe('<ul><li><strong>Change:</strong> merged <a href="https://x.y/430" target="_blank" rel="noopener noreferrer">#430</a> into <code>master</code>…</li></ul>');
  expect(miniMarkdown("Done, see **t_1")).toBe("Done, see t_1");
  expect(miniMarkdown("2 ** 3 is 8")).toBe("2 ** 3 is 8");
  expect(plainMarkdown("I created the ticket: **t_20261106_kiux** and **more…")).toBe("I created the ticket: t_20261106_kiux and more…");
});

const layoutQs = [
  { question: "Which layout?", multiSelect: false, options: [{ label: "a: compact", recommended: true }, { label: "b: cards" }] },
  { question: "Skip button?", options: [{ label: "Yes", recommended: true }, { label: "No" }] },
  { question: "Which parts?", multiSelect: true, options: [{ label: "API", recommended: true }, { label: "UI" }] },
];
const pick = (...picked: string[]) => ({ picked, otherOn: false, other: "" });

test("answersMessage says skipped and names Claude's pick when the user chose another", () => {
  expect(answersMessage(layoutQs, [pick("b: cards"), pick(), pick("UI")])).toBe(
    "My answers:\n- Which layout? → b: cards (not your pick: a: compact)\n- Skip button? → skipped\n- Which parts? → UI",
  );
  // The recommended pick, a typed-only answer and a multi-select pick get no note.
  expect(answersMessage(layoutQs, [pick("a: compact"), { picked: [], otherOn: true, other: "maybe" }, pick("UI")])).toBe(
    "My answers:\n- Which layout? → a: compact\n- Skip button? → maybe\n- Which parts? → UI",
  );
});

test("parseAnswers reads new messages without the not-your-pick note", () => {
  const sent = answersMessage(layoutQs, [pick("b: cards"), pick(), pick("API", "UI")], "thanks");
  expect(parseAnswers(sent, layoutQs)).toEqual({ answers: ["b: cards", "skipped", "API; UI"], note: "thanks" });
});

test("parseAnswers still reads old messages", () => {
  const old = "My answers:\n- Which layout? → b: cards\n- Skip button? → (no preference)";
  expect(parseAnswers(old, layoutQs)).toEqual({ answers: ["b: cards", "(no preference)", null], note: "" });
});
