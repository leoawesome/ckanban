// One shared scale for text sizes, weights, corners, shadows and icons (scripts/style-scale.ts).
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { offScaleCss, offScaleTsx } from "../scripts/style-scale";

const WEB = join(import.meta.dir, "../web/src");

test("styles.css stays on the scale", () => {
  expect(offScaleCss(readFileSync(join(WEB, "styles.css"), "utf8"))).toEqual([]);
});

test("components use on-scale icon sizes", () => {
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
