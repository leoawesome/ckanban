// The contract tests' JSON Schema checker (schema.ts) finds what it should, and every schema in contracts/schemas/
// uses only keywords it checks.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { KNOWN_KEYWORDS, loadSchema, SCHEMAS, schemaProblems } from "./schema";

test("every schema in contracts/schemas parses and uses only keywords the checker knows", () => {
  const files = readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    const s = loadSchema(f);
    expect(s.$id).toBe(`https://ckanban.dev/contracts/schemas/${f}`);
    const unknown: string[] = [];
    const walk = (x: unknown, at: string) => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return;
      for (const [k, v] of Object.entries(x)) {
        if (!KNOWN_KEYWORDS.has(k)) unknown.push(`${f} ${at}: ${k}`);
        if (k === "properties" || k === "patternProperties" || k === "$defs") for (const [n, sub] of Object.entries(v as object)) walk(sub, `${at}/${k}/${n}`);
        else if (k === "items" || k === "additionalProperties") walk(v, `${at}/${k}`);
        else if (k === "oneOf" || k === "anyOf") (v as unknown[]).forEach((sub, i) => walk(sub, `${at}/${k}/${i}`));
      }
    };
    walk(s, "#");
    expect(unknown).toEqual([]);
  }
});

test("the checker reports wrong types, missing fields, enums, patterns, dates and unions", () => {
  // comment.schema.json: required id/author/text/at, author enum, id pattern, at a date-time.
  expect(schemaProblems("comment.schema.json", { id: "abcd1234", author: "ai", text: "t", at: "2026-11-15T07:50:46.838Z" })).toEqual([]);
  expect(schemaProblems("comment.schema.json", { id: "ABC", author: "bot", text: 1, at: "yesterday" })).toEqual([
    "$.id: \"ABC\" does not match ^[0-9a-z]{8}$",
    "$.author: \"bot\" is not one of [\"user\",\"ai\"]",
    "$.text: integer, schema says string",
    "$.at: \"yesterday\" is not a date-time",
  ]);
  expect(schemaProblems("comment.schema.json", { id: "abcd1234" })).toEqual(["$: missing author", "$: missing text", "$: missing at"]);
  // activity-entry.schema.json: a nested object with its own required field.
  expect(schemaProblems("activity-entry.schema.json", { run: 0, at: "2026-11-15T07:50:46.838Z", event: {} })).toEqual(["$.run: 0 < 1", "$.event: missing type"]);
});
