// Question forms: small safe markdown (web/src/miniMarkdown.ts), the optional context, and replies that only repeat a form.
import { expect, test } from "bun:test";
import { inlineMarkdown, miniMarkdown, plainMarkdown } from "../web/src/miniMarkdown";
import { repeatsForm, signature } from "../web/src/questionForms";
import { parseQuestions } from "../src/server/session";
import { openQuestionsRule } from "../src/server/prompts";

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

test("context: kept from the tool input; old forms without it still read, and it doesn't change what saved answers match", () => {
  const input = [{ question: "Raise the timeout?", context: "  The lookup came back **late**.  ", options: [{ label: "Yes", recommended: true }, { label: "No" }] }];
  const qs = parseQuestions(input)!;
  expect(qs[0].context).toBe("The lookup came back **late**.");
  const old = parseQuestions([{ question: "Raise the timeout?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }])!;
  expect(old[0]).not.toHaveProperty("context");
  expect(signature(qs)).toBe(signature(old));
  expect(openQuestionsRule(qs)).toContain(`"context":"The lookup came back **late**."`);
  expect(openQuestionsRule(old)).not.toContain("context");
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
