// Quick chats' shared fixtures (rust/board/tests/fixtures/quickchat.json): inputs for the pure text of quick chats
// (titles, the run note, attachment paths, live drafts, "session missing", the error line) with the answer Bun gives
// in `expect` (as JSON text). This test checks Bun still gives exactly those answers; `cargo test -p ckanban-board
// --test quickchat_text` checks Rust gives them too. After a deliberate change to that Bun code, run
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-quickchat-fixtures.test.ts`, then make `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { autoTitle, quickChatNote } from "../src/chat/quickchat";
import { localizeAttachments } from "../src/board/attachments";
import { DraftTracker } from "../src/chat/draft";
import { sessionMissing } from "../src/board/board-types";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "quickchat.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const doc = JSON.parse(readFileSync(FILE, "utf8"));
const before = JSON.stringify(doc);
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

const fill: Record<string, (c: any) => unknown> = {
  autoTitle: (c) => autoTitle(c.text),
  quickChatNote: (c) => quickChatNote({ name: c.name, slug: c.slug, path: c.path }),
  localizeAttachments: (c) => localizeAttachments(c.prompt, "/data/attachments"),
  draft: (c) => {
    const d = new DraftTracker();
    const seen = c.events.map((e: unknown) => d.feed(e));
    return { seen, text: d.text, finished: d.finished };
  },
  sessionMissing: (c) => sessionMissing(c.error, c.events),
  // The error line a failed reply saves (QuickChats.execute).
  errorLine: (c) => c.error.split("\n").findLast((l: string) => l.trim())?.trim().slice(0, 500) ?? c.error.slice(0, 500),
};

describe("Rust board quick chat fixtures: Bun gives the answers they record", () => {
  for (const [group, cases] of Object.entries(doc.groups as Record<string, any[]>)) {
    test(group, () => {
      const f = fill[group];
      expect(f).toBeDefined();
      for (const c of cases) c.expect = j(f(c));
    });
  }
  test("the file is up to date", () => {
    expect(Object.keys(fill).sort()).toEqual(Object.keys(doc.groups).sort());
    if (UPDATE) {
      writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
      return;
    }
    expect(JSON.parse(JSON.stringify(doc))).toEqual(JSON.parse(before));
  });
});
