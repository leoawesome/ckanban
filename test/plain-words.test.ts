import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Plain words where users read them (CLAUDE.md "Users may not be technical"): no git, worktree, branch, commit,
 * session, cron, raw tool names or token counts in the UI's text. Scans every web/src/*.tsx file: JSX text, strings
 * shown as JSX children, user-facing attributes (title, placeholder, aria-label…) and option labels/hints, plus raw
 * refs rendered as-is ({s.cron}, {diff.base}, {ticket.branch}).
 */
const BANNED = /\bgit\b|worktree|\bbranch(es|ed)?\b|\bcommit(s|ted)?\b|\bsessions?\b|\bcron\b|origin\/|mcp__|\btokens?\b|\bctx\b|\b5h\b|markdown|coordinator|^(tagged|monitor)( \(\$\))?$/i;
/** Properties that hold developer refs: rendering one directly puts "origin/main" or "0 9 * * 2-5" on screen. */
const RAW_REFS = new Set(["cron", "base", "branch", "worktree", "sessionId"]);
const TEXT_ATTRS = new Set(["title", "placeholder", "aria-label", "ariaLabel", "alt", "label", "hint", "keyHint", "confirmLabel", "busyLabel"]);
const TEXT_PROPS = new Set(["label", "hint", "title"]);

/**
 * Known, deliberate exceptions: [file, text it contains, why]. Shrink-only: a fix removes its line, and a line that
 * no longer matches anything fails the test, so the list can't hide new leaks.
 */
const ALLOWED: [string, string, string][] = [
  ["App.tsx", "git", "names the missing program to install"],
  ["UsagePanel.tsx", "tokens", "token count only in the cost tooltip"],
  ["SchedulesDialog.tsx", "Cron expression", "the Edit form, where the timing is typed"],
  ["ShareMenu.tsx", "Copy markdown", "names the copy format"],
  ["TicketMenu.tsx", "Copy branch", "only shown when the folder has version history"],
  ["TicketMenu.tsx", "{ticket.branch}", "the name that Copy branch copies"],
  ["PrBox.tsx", "branch", "pull request box: only for folders on GitHub"],
  ["PrBox.tsx", "{pr.base}", "pull request box: only for folders on GitHub"],
  ["PrList.tsx", "{p.base}", "pull request list: only for folders on GitHub"],
  ["ResolveConflicts.tsx", "base branch", "pull request conflicts: only for folders on GitHub"],
];

export interface Leak { file: string; line: number; text: string }

export function scanSource(file: string, source: string): Leak[] {
  const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const leaks: Leak[] = [];
  const push = (n: ts.Node, text: string) => leaks.push({ file, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, text });
  const add = (n: ts.Node, text: string) => BANNED.test(text.trim()) && push(n, text.trim());
  // Strings that can end up on screen: literals and template text, through ?:, ?? and ||, not into
  // comparisons (copied === "branch"), function calls or nested JSX (scanned on its own).
  const strings = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text);
    else if (ts.isTemplateExpression(n)) {
      add(n, [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" "));
      n.templateSpans.forEach((s) => strings(s.expression));
    } else if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) return;
    else if (ts.isCallExpression(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return;
    else ts.forEachChild(n, strings);
  };
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) add(n, n.text);
    else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      strings(n.expression);
      if (ts.isPropertyAccessExpression(n.expression) && RAW_REFS.has(n.expression.name.text)) push(n, `raw ${n.expression.name.text}: {${n.expression.getText()}}`);
    } else if (ts.isJsxAttribute(n) && TEXT_ATTRS.has(n.name.getText()) && n.initializer) strings(n.initializer);
    else if (ts.isPropertyAssignment(n) && TEXT_PROPS.has(n.name.getText())) strings(n.initializer);
    ts.forEachChild(n, walk);
  };
  walk(src);
  return leaks;
}

const WEB = join(import.meta.dir, "..", "web", "src");

test("no developer words in the UI's text", () => {
  const leaks = readdirSync(WEB).filter((f) => f.endsWith(".tsx")).flatMap((f) => scanSource(f, readFileSync(join(WEB, f), "utf8")));
  const used = new Set<number>();
  const open = leaks.filter((l) => {
    const i = ALLOWED.findIndex(([f, t]) => f === l.file && l.text.includes(t));
    if (i >= 0) used.add(i);
    return i < 0;
  });
  expect(open.map((l) => `${l.file}:${l.line}: ${l.text}`)).toEqual([]);
  // Stale exceptions go: the list only shrinks.
  expect(ALLOWED.filter((_, i) => !used.has(i)).map(([f, t]) => `${f}: ${t}`)).toEqual([]);
});

test("the word check catches each leak the UI/UX review found", () => {
  const leaks = (jsx: string) => scanSource("x.tsx", `const X = () => (${jsx});`).map((l) => l.text);
  for (const jsx of [
    `<p>A board runs tickets in one folder, usually a git repo.</p>`,
    `<span>vs <code>{diff.base}</code>{diff.branch && <> · <code>{diff.branch}</code></>}</span>`,
    `<div>No changes against <code>{diff.base}</code> yet.</div>`,
    `<span className="menu-label">Branch ticket…</span>`,
    `<span className="menu-label">Unlink session</span>`,
    `<button>Start from an existing Claude session…</button>`,
    `<textarea placeholder="Context, acceptance criteria, links… (markdown)" />`,
    `<div className="sched-when">{s.summary} <code>{s.cron}</code></div>`,
    `<Select options={[{ value: "tagged", label: "tagged", hint: "sleeps until @mentioned" }]} />`,
    `<span className="pill lead">{hosted ? "ticket's session" : "coordinator"}</span>`,
    `<span>of current 5h session</span>`,
    `<span>API-equivalent · {n} tokens</span>`,
    `<span className="steps-text">{"Did 3 steps · mcp__linear-server__get_document"}</span>`,
    `<span title={\`\${p.handle}'s session (read-only)\`} />`,
  ]) expect(leaks(jsx).length, jsx).toBeGreaterThan(0);
  // Not leaks: comparisons, call arguments, and ordinary words like "commitment" or "GitHub".
  expect(leaks(`<button onClick={() => copyItem("branch", b)}>{copied === "branch" ? "Copied" : "Copy"}</button>`)).toEqual([]);
  expect(leaks(`<p>Open it on GitHub. A real commitment.</p>`)).toEqual([]);
});
