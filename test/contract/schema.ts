// A small JSON Schema (draft 2020-12) checker for the contract tests, so they need no new package and import nothing
// from src/. It knows only the keywords contracts/schemas/ uses; an unknown keyword is an error, so a schema can't
// silently ask for a check this file doesn't make.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SCHEMAS = resolve(import.meta.dir, "..", "..", "contracts", "schemas");

type Schema = Record<string, any> | boolean;

/** Keywords that only describe; the checker skips them. */
const NOTES = new Set(["$schema", "$id", "title", "description", "$defs", "examples", "default", "$comment"]);
const CHECKED = new Set<string>(["type", "enum", "const", "required", "properties", "additionalProperties", "patternProperties",
  "items", "minItems", "maxItems", "pattern", "minLength", "maxLength", "minimum", "maximum", "oneOf", "anyOf", "$ref", "format"]);

/** Every keyword a schema may use (the rest are refused). */
export const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([...NOTES, ...CHECKED]);

// ISO 8601 with a time and a zone, as new Date().toISOString() writes it (and RFC 3339 in general).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function check(root: Record<string, any>, s: Schema, v: unknown, path: string, out: string[]): void {
  if (s === true) return;
  if (s === false) return void out.push(`${path}: not allowed`);
  for (const k of Object.keys(s)) if (!NOTES.has(k) && !CHECKED.has(k)) out.push(`${path}: schema keyword "${k}" is not supported by test/contract/schema.ts`);
  if (s.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const target = m ? root.$defs?.[m[1]] : undefined;
    if (target === undefined) return void out.push(`${path}: unknown $ref ${s.$ref}`);
    check(root, target, v, path, out);
  }
  const t = typeOf(v);
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return void out.push(`${path}: ${t}, schema says ${types.join("|")}`);
  }
  if (s.enum && !s.enum.some((e: unknown) => equal(e, v))) out.push(`${path}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && !equal(s.const, v)) out.push(`${path}: ${JSON.stringify(v)}, schema says ${JSON.stringify(s.const)}`);
  if (t === "string") {
    const str = v as string;
    if (s.minLength !== undefined && [...str].length < s.minLength) out.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && [...str].length > s.maxLength) out.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, "u").test(str)) out.push(`${path}: ${JSON.stringify(str)} does not match ${s.pattern}`);
    if (s.format === "date-time" && !DATE_TIME.test(str)) out.push(`${path}: ${JSON.stringify(str)} is not a date-time`);
  }
  if (t === "integer" || t === "number") {
    if (s.minimum !== undefined && (v as number) < s.minimum) out.push(`${path}: ${v} < ${s.minimum}`);
    if (s.maximum !== undefined && (v as number) > s.maximum) out.push(`${path}: ${v} > ${s.maximum}`);
  }
  if (t === "array") {
    const a = v as unknown[];
    if (s.minItems !== undefined && a.length < s.minItems) out.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && a.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`);
    if (s.items !== undefined) a.forEach((x, i) => check(root, s.items, x, `${path}[${i}]`, out));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(o)) {
      const p = `${path}.${k}`;
      let matched = false;
      if (s.properties && k in s.properties) {
        matched = true;
        check(root, s.properties[k], x, p, out);
      }
      for (const [re, sub] of Object.entries(s.patternProperties ?? {})) {
        if (new RegExp(re, "u").test(k)) {
          matched = true;
          check(root, sub as Schema, x, p, out);
        }
      }
      if (!matched && s.additionalProperties !== undefined) check(root, s.additionalProperties, x, p, out);
    }
  }
  if (s.anyOf && !s.anyOf.some((sub: Schema) => problems(root, sub, v, path).length === 0)) {
    out.push(`${path}: matches none of anyOf (${s.anyOf.map((sub: Schema) => problems(root, sub, v, path)[0]).join("; ")})`);
  }
  if (s.oneOf) {
    const results = s.oneOf.map((sub: Schema) => problems(root, sub, v, path));
    const ok = results.filter((r: string[]) => r.length === 0).length;
    if (ok !== 1) out.push(`${path}: matches ${ok} of oneOf, needs exactly 1${ok ? "" : ` (${results.map((r: string[]) => r[0]).join("; ")})`}`);
  }
}

function problems(root: Record<string, any>, s: Schema, v: unknown, path: string): string[] {
  const out: string[] = [];
  check(root, s, v, path, out);
  return out;
}

const cache = new Map<string, Record<string, any>>();

/** contracts/schemas/<file>, parsed once. */
export function loadSchema(file: string): Record<string, any> {
  let s = cache.get(file);
  if (!s) {
    s = JSON.parse(readFileSync(join(SCHEMAS, file), "utf8")) as Record<string, any>;
    cache.set(file, s);
  }
  return s;
}

/** Everything wrong with `value` under contracts/schemas/<file> ([] when it matches). `where` names it in messages. */
export function schemaProblems(file: string, value: unknown, where = "$"): string[] {
  const s = loadSchema(file);
  return problems(s, s, value, where);
}
