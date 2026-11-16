// Shared fixtures of the Rust board port (rust/board/tests/fixtures/sessions/parse.json): whole transcripts, taken from
// the ones Bun's own session, workflow, chat cache, commands and rewind tests parse, with Bun's answers in `expect`:
// the parse (`parseSession`) and the session summary (`SessionCache.summary`, without its file time). This test checks
// Bun still gives exactly those; `cargo test -p ckanban-board --test sessions_parse` checks Rust gives them too, also
// when the transcript arrives in pieces. After a deliberate change to Bun's session parsing, run
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-parse-fixtures.test.ts`, then make the cargo test pass again.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSession, SessionCache } from "../src/runs/session";
import { tempDir } from "./support/helpers";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "sessions", "parse.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

test("Rust port fixtures: Bun parses the transcripts as recorded", () => {
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  const want = JSON.parse(JSON.stringify(doc));
  const config = tempDir("ck-parse-fixtures-");
  mkdirSync(join(config, "projects", "-p"), { recursive: true });
  doc.cases.forEach((c: any, i: number) => {
    const id = `s${i}`;
    writeFileSync(join(config, "projects", "-p", `${id}.jsonl`), c.raw);
    const summary = new SessionCache({ configDir: config }).summary(id);
    const { updatedAt: _, ...s } = summary ?? { updatedAt: "" };
    c.expect = { parsed: parseSession(c.raw), summary: summary ? s : null };
  });
  if (UPDATE) {
    writeFileSync(FILE, JSON.stringify(doc, null, 1) + "\n");
    return;
  }
  expect(JSON.parse(JSON.stringify(doc))).toEqual(want);
});
