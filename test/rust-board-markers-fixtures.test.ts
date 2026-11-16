// Shared fixtures of the Rust board's session markers (rust/board/tests/fixtures/sessions/markers.json): inputs for
// what one transcript line means to the chat (session-markers.ts and what it imports), with the answer Bun gives in
// `expect`. Each answer is wrapped as `{ value }`, so an undefined answer reads `{}`. This test checks Bun still gives
// exactly those answers; `cargo test -p ckanban-board --test sessions_markers` in rust/ checks Rust gives them too.
// After a deliberate change, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-markers-fixtures.test.ts`.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandText, localCommandOutput } from "../src/chat/commands";
import { withoutAttachmentNote } from "../src/board/attachments";
import { parseSetupBlock } from "../src/runs/worktree-setup";
import { parseResult } from "../src/runs/result";
import { starredTitle } from "../src/core/util";
import { mockupName, stripMockups } from "../src/board/mockups";
import { parseTeammateProposal } from "../src/huddle/teammate-proposal";
import { parseSquadProposal } from "../src/huddle/squad";
import { parseAutomationProposal } from "../src/schedules/automation-proposal";
import { parseKeysAsk } from "../src/integrations/ask-keys";
import { proposedBudget, rosterError } from "../src/huddle/huddle-roster";
import { helperLineText, suggestedLineError } from "../src/helper/line";
import {
  assistantBlock, cardEntry, dropBlockedMoves, fromAutomation, fromTicket, isPublisher, parseAskMeta, parseProposal,
  parseQuestions, PUBLISHED, resultText, SETUP_HELPER, terminalOnly, userText,
} from "../src/runs/session-markers";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "sessions", "markers.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

const FNS: Record<string, (input: any) => unknown> = {
  commandText, localCommandOutput, withoutAttachmentNote, parseSetupBlock, parseResult, starredTitle, mockupName, stripMockups,
  terminalOnly, parseTeammateProposal, parseSquadProposal, parseAutomationProposal, parseKeysAsk,
  rosterError: (v) => rosterError(v), proposedBudget, helperLineText, suggestedLineError,
  parseAskMeta, parseQuestions, parseProposal, assistantBlock, fromTicket, fromAutomation, userText, resultText, cardEntry, isPublisher,
  dropBlockedMoves: (entries) => {
    dropBlockedMoves(entries);
    return entries;
  },
  published: (text) => [...text.matchAll(PUBLISHED)].map((m) => [m[1], m[2]]),
  isSetupHelper: (text) => SETUP_HELPER.test(text),
};

test("Rust board marker fixtures: Bun gives the answers they record", () => {
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  const want = JSON.parse(JSON.stringify(doc));
  for (const c of doc.cases) {
    const fn = FNS[c.fn];
    if (!fn) throw new Error(`no function ${c.fn}`);
    // A fresh copy: some functions change their input (dropBlockedMoves).
    c.expect = JSON.parse(JSON.stringify({ value: fn(c.input === undefined ? undefined : structuredClone(c.input)) }));
  }
  if (UPDATE) {
    writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
    return;
  }
  expect(doc).toEqual(want);
});
