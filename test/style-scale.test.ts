// One shared scale for text sizes, weights, corners, shadows, icons, colours and spacing (scripts/style-scale.ts,
// design-system/kanban/MASTER.md).
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SPACING, offScaleCss, offScaleTsx } from "../scripts/style-scale";

const WEB = join(import.meta.dir, "../web/src");

test("styles.css stays on the scale", () => {
  expect(offScaleCss(readFileSync(join(WEB, "styles.css"), "utf8"))).toEqual([]);
});

test("components use on-scale icon sizes, spacing and colours", () => {
  const problems = readdirSync(WEB).filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => offScaleTsx(readFileSync(join(WEB, f), "utf8")).map((p) => `${f}:${p.line} ${p.text}`));
  expect(problems).toEqual([]);
});

test("the stylesheet has at most 6 text sizes, 4 weights, 3 corners and 3 shadows, none under 11px", () => {
  const css = readFileSync(join(WEB, "styles.css"), "utf8");
  const tokens = (re: RegExp) => new Set([...css.matchAll(re)].map((m) => m[1]));
  expect(tokens(/^\s*(--fs-[\w-]+):/gm).size).toBe(6);
  expect(tokens(/(?<![-\w])font-weight:\s*(\d+)/g).size).toBeLessThanOrEqual(4);
  expect(tokens(/^\s*(--r-[\w-]+):/gm).size).toBe(3);
  expect(tokens(/^\s*(--shadow-[\w-]+):/gm).size).toBe(3);
  const sizes = [...css.matchAll(/^\s*--fs-[\w-]+:\s*(\d+)px/gm)].map((m) => +m[1]);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
});

test("off-scale values fail the check", () => {
  expect(offScaleCss(".a { font-size: 12.5px; }")).toEqual([{ line: 1, text: "font-size: 12.5px" }]);
  expect(offScaleCss(".a {\n  border-radius: 8px;\n}")).toEqual([{ line: 2, text: "border-radius: 8px" }]);
  expect(offScaleCss(".a { font-weight: 560; }")).toHaveLength(1);
  expect(offScaleCss(".a { font: 600 10px/1 var(--mono); }")).toHaveLength(1);
  expect(offScaleCss(".a { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); }")).toHaveLength(1);
  expect(offScaleTsx("<CloseIcon size={9} />")).toHaveLength(1);
});

test("on-scale values pass", () => {
  expect(offScaleCss(`.a { font-size: var(--fs-xs); font-weight: 600; border-radius: var(--r-md) var(--r-md) 0 0;
    box-shadow: 0 0 0 2px var(--accent), var(--shadow-pop); font: 600 var(--fs-2xs)/1 var(--mono); }
    .b { border-radius: 50%; box-shadow: inset 3px 0 0 var(--accent); font: inherit; }
    :root { --fs-xs: 12px; --r-sm: 6px; }`)).toEqual([]);
  expect(offScaleTsx("<CheckIcon size={14} />")).toEqual([]);
});

test("raw colours outside the token definitions fail", () => {
  expect(offScaleCss(".a { color: #123456; }")).toEqual([{ line: 1, text: "color: #123456" }]);
  expect(offScaleCss(".a { background: rgba(0, 0, 0, 0.4); }")).toHaveLength(1);
  expect(offScaleCss(".a { border: 1px solid hsl(20 50% 50%); }")).toHaveLength(1);
  expect(offScaleCss(".a { color: white; }")).toHaveLength(1);
  expect(offScaleCss(".a { box-shadow: 0 0 0 2px #fff; }")).toHaveLength(1);
  expect(offScaleTsx(`<b style={{ color: "#fff" }} />`)).toHaveLength(1);
  expect(offScaleTsx(`<b style={{ background: "rgb(1, 2, 3)" }} />`)).toHaveLength(1);
});

test("padding, margin and gap off the spacing tokens fail", () => {
  expect(offScaleCss(".a { padding: 7px; }")).toEqual([{ line: 1, text: "padding: 7px" }]);
  expect(offScaleCss(".a { margin: 0 var(--sp-3) 5px; }")).toHaveLength(1);
  expect(offScaleCss(".a { gap: 8px; }")).toHaveLength(1);
  expect(offScaleCss(".a { padding-left: max(14px, env(safe-area-inset-left)); }")).toHaveLength(1);
  expect(offScaleCss(".a { margin-top: -3px; }")).toHaveLength(1);
  expect(offScaleCss(".a { padding: 1rem; }")).toHaveLength(1);
  expect(offScaleTsx("<b style={{ padding: 7 }} />")).toHaveLength(1);
  expect(offScaleTsx("<b style={{ paddingLeft: 8 + depth * 14 }} />")).toHaveLength(1);
  expect(offScaleTsx(`<b style={{ margin: "0 5px" }} />`)).toHaveLength(1);
});

test("tokens, transparent, mask alphas and spacing tokens pass", () => {
  expect(offScaleCss(`:root { --surface: #ffffff; --scrim: rgba(20, 18, 15, 0.42); }
    .card.x { --tag-bg: hsl(var(--tag-h) 70% 92%); }
    .a { color: var(--text); background: color-mix(in srgb, var(--info) 35%, transparent); border-color: currentColor; }
    .b { mask-image: linear-gradient(#000 60%, transparent); content: "red"; white-space: nowrap; }
    .c { padding: 0 var(--sp-3) var(--sp-2h); margin: auto; gap: var(--sp-1) var(--sp-7); }
    .d { margin-top: calc(-1 * var(--sp-2)); padding: var(--sp-5) max(var(--sp-5), calc((100% - var(--read-max)) / 2)); }
    .e { padding-bottom: max(var(--sp-4), env(safe-area-inset-bottom)); margin: 0.5em 0; padding: 0px; }
    /* color: #123456; padding: 7px; (comments aren't checked) */
    a:hover { color: var(--accent-text); }`)).toEqual([]);
  expect(offScaleTsx("<b style={{ margin: 0, paddingLeft: `calc(var(--sp-3) + ${depth} * var(--sp-4))` }} />")).toEqual([]);
  expect(offScaleTsx(`<rect style={{ fill: "var(--accent)" }} />`)).toEqual([]);
});

test("the spacing tokens in styles.css match the checker's list", () => {
  const css = readFileSync(join(WEB, "styles.css"), "utf8");
  const defined = Object.fromEntries([...css.matchAll(/^\s*(--sp-[\w-]+):\s*(\d+)px;/gm)].map((m) => [m[1], +m[2]]));
  expect(defined).toEqual(SPACING);
});
