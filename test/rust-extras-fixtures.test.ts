// The board extras' fixture table for the Rust port (rust/board/tests/fixtures/extras.json): the pure helpers R12
// ports from src/board/learn.ts, lessons.ts, linker.ts, recall.ts, mockups.ts, src/usage/ticket-usage.ts and
// src/huddle/huddle-usage.ts, over many inputs, with Bun's answer. This test checks Bun still gives those answers;
// `cargo test -p ckanban-board --test extras` checks Rust gives the same.
//
// After a deliberate change: `UPDATE_RUST_FIXTURES=1 bun test test/rust-extras-fixtures.test.ts`, then make `cargo
// test` pass again.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as L from "../src/board/learn";
import * as Le from "../src/board/lessons";
import * as Li from "../src/board/linker";
import * as R from "../src/board/recall";
import { extractMockups } from "../src/board/mockups";
import { transcript } from "../src/chat/explain";
import { ticketRuns, ticketUsage, windowsNeeded } from "../src/usage/ticket-usage";
import { huddleUsage } from "../src/huddle/huddle-usage";
import { teammateSpend } from "../src/huddle/huddle-types";
import { parseNotes } from "../src/huddle/huddle-notes";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "extras.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

interface Case {
  fn: string;
  args: unknown[];
  json?: unknown;
}

const counter = () => {
  let n = 0;
  return () => `c${++n}`;
};

/** A tidy pass on one group as learner.ts runs it: parse the answer, apply each step, the files after each. */
function tidyRun(files: Record<string, { text: string; by: string; date: string | null; huddle: string | null }[]>, answer: string, roles: string[]) {
  const list: L.TidyNote[] = Object.keys(files).flatMap((role) => files[role].map((note) => ({ role, note })));
  const ops = L.parseTidy(answer, list, roles);
  let cur = files;
  const steps = (ops ?? []).map((op) => (cur = L.applyTidyOp(cur, op, list, "2026-11-17")));
  return { ops, steps };
}

const FNS: Record<string, (...a: any[]) => unknown> = {
  correctionKeys: L.correctionKeys,
  newCorrections: L.newCorrections,
  ticketKey: L.ticketKey,
  shortlist: (pile, kind, dest, text, n) => L.shortlist(pile, kind, dest, text, n).map((c) => c.id),
  shouldPromote: L.shouldPromote,
  addToPile: (pile, l, o) => {
    const c = L.addToPile(pile, l, { ...o, newId: counter() });
    return { pile, id: c.id };
  },
  prune: (pile, now, cap) => L.prune(pile, new Date(now), cap),
  serializeRules: L.serializeRules,
  rulesBlock: L.rulesBlock,
  shiftNotes: (cur, from, to) => L.shiftNotes(cur, from, to),
  parseLearned: L.parseLearned,
  tidyRun,
  pileText: L.pileText,
  huddleLearnPrompt: L.huddleLearnPrompt,
  tidyPrompt: L.tidyPrompt,
  texts: () => ({ learn: L.LEARN_SYSTEM, huddle: L.HUDDLE_LEARN_SYSTEM, tidy: L.TIDY_SYSTEM, suggest: Li.SUGGEST_SYSTEM, find: Li.FIND_SYSTEM }),
  corrections: Le.corrections,
  lessonsPrompt: Le.lessonsPrompt,
  lessonBullets: Le.lessonBullets,
  transcript,
  candidates: (ts, now) => Li.candidates(ts, now).map((t) => t.id),
  suggestPrompt: Li.suggestPrompt,
  parseSuggestion: Li.parseSuggestion,
  findPrompt: Li.findPrompt,
  parseFound: Li.parseFound,
  words: R.words,
  recallBlock: R.recallBlock,
  pickRelated: (t, rows) => R.pickRelated(t, rows).map((r) => r.ticket.id),
  extractMockups,
  ticketRuns,
  windowsNeeded: (runs, windows, now) => windowsNeeded(runs, windows, now).map((w) => windows.indexOf(w)),
  ticketUsage: (i, machine) => ticketUsage({ ...i, machineCost: (a: number, b: number) => machine[`${a}-${b}`] ?? 0 }),
  huddleUsage,
  teammateSpend,
};

const note = (text: string, by = "board", date: string | null = "2026-11-01", huddle: string | null = null) => ({ text, by, date, huddle });
const src = (key: string, at: string, quote = "q") => ({ kind: "ticket", slug: "b", id: key, title: "T", by: "you", at, quote, key });
const cand = (id: string, kind: string, text: string, dest: object, state = "watching", sources = [src("k1", "2026-11-01T00:00:00.000Z")], lastAt = "2026-11-01T00:00:00.000Z") =>
  ({ id, kind, text, general: !!text, dest, sources, firstAt: lastAt, lastAt, state });
const rules = { kind: "rules", slug: "b" };
const notesG = { kind: "notes", role: "qa", scope: "general", slug: "b" };
const notesR = { kind: "notes", role: "qa", scope: "repo", slug: "b" };

function cases(): Case[] {
  const out: Case[] = [];
  const add = (fn: string, ...args: unknown[]) => {
    const json = JSON.parse(JSON.stringify(FNS[fn](...structuredClone(args)) ?? null));
    out.push({ fn, args, json });
  };
  const msgs = [
    { role: "user", kind: "text", text: "Fix it", at: "2026-11-01T00:00:00.000Z", uuid: "u1" },
    { role: "assistant", kind: "text", text: 'Done.\nCKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"Fixed the login."}', at: "2026-11-01T00:01:00.000Z" },
    { role: "user", kind: "text", text: "No, always run the tests first", at: "2026-11-01T00:02:00.000Z", uuid: "u2" },
    { role: "user", kind: "text", text: "  ", at: "2026-11-01T00:02:30.000Z" },
    { role: "user", kind: "text", text: "digest", at: "2026-11-01T00:03:00.000Z", peer: { ticketId: "t_x", title: "Other" } },
    { role: "assistant", kind: "tool", text: "Bash", at: "2026-11-01T00:04:00.000Z" },
    { role: "assistant", kind: "tool", text: "Read", at: "2026-11-01T00:04:01.000Z" },
    { role: "user", kind: "text", text: "late", at: "2026-11-01T00:05:00.000Z" },
    { role: "assistant", kind: "text", text: "Q?", at: "2026-11-01T00:06:00.000Z", questions: [{ question: "Which?" }, { question: "When?" }], proposal: { title: "New" } },
    { role: "user", kind: "board", text: "Board says hi", at: "2026-11-01T00:07:00.000Z" },
    { role: "user", kind: "text", text: "from auto", at: "2026-11-01T00:08:00.000Z", peer: { automation: "Inbox" } },
    { role: "assistant", kind: "agent", text: "helper", at: "2026-11-01T00:09:00.000Z", huddleId: "h_1" },
    { role: "assistant", kind: "text", text: "branch?", at: "2026-11-01T00:10:00.000Z", branch: { reason: "split" }, huddle: { reason: "review" }, deletion: { reason: "dupes" } },
  ];
  const c1 = { messages: [msgs[2], msgs[7]], reopened: true, changesRequested: false, followUps: [{ id: "t_f", title: "Follow" }] };
  add("correctionKeys", c1);
  add("correctionKeys", { messages: [{ at: "x" }], reopened: false, changesRequested: true, followUps: [] });
  add("newCorrections", c1, ["msg:u2", "reopen"]);
  add("newCorrections", c1, []);
  const chain = [{ id: "a" }, { id: "b", madeFrom: "a" }, { id: "c", madeFrom: "b" }, { id: "d", madeFrom: "zz" }, { id: "e", madeFrom: "f" }, { id: "f", madeFrom: "e" }];
  for (const t of chain) add("ticketKey", "b", t, chain);

  const pile = {
    candidates: [
      cand("p1", "ticket", "Run the tests before saying done", rules),
      cand("p2", "ticket", "Ask before deleting files", rules, "saved"),
      cand("p3", "huddle", "Read the tests first", notesG),
      cand("p4", "huddle", "Name the file", notesR, "watching", [src("h1", "2026-11-02T00:00:00.000Z"), src("h2", "2026-11-03T00:00:00.000Z")], "2026-11-03T00:00:00.000Z"),
      cand("p5", "ticket", "Run tests on every change", { kind: "rules", slug: "other" }),
      cand("p6", "huddle", "", notesR, "watching"),
      cand("p7", "ticket", "Tests tests tests run", rules, "dropped", undefined, "2026-10-01T00:00:00.000Z"),
    ],
    scanned: {},
  };
  add("shortlist", pile, "ticket", rules, "run the tests", 25);
  add("shortlist", pile, "ticket", rules, "run the tests please", 2);
  add("shortlist", pile, "huddle", { ...notesG, slug: "zz" }, "file", 1);
  add("shortlist", pile, "huddle", notesR, "anything", 25);
  for (const c of pile.candidates) add("shouldPromote", c);
  add("shouldPromote", { ...pile.candidates[0], standing: true });
  const tsrc = src("ticket:b/t2", "2026-11-05T00:00:00.000Z", "  the   user said <!-- x --> ");
  add("addToPile", pile, { text: "Run the tests first", match: "p1", standing: "always run", evidence: "", mistake: "" }, { kind: "ticket", dest: rules, source: tsrc, userText: "Please ALWAYS run the tests" });
  add("addToPile", pile, { text: "", match: null }, { kind: "ticket", dest: rules, source: tsrc });
  add("addToPile", pile, { text: "New rule", match: "p3", standing: "ab" }, { kind: "ticket", dest: rules, source: tsrc, userText: "ab" });
  add("addToPile", pile, { text: "Better words", match: "p6" }, { kind: "huddle", dest: { ...notesR, role: "dev" }, source: tsrc });
  add("addToPile", pile, { text: "Same", match: "p4" }, { kind: "huddle", dest: { ...notesR, slug: "c" }, source: src("h1", "2026-11-02T00:00:00.000Z") });
  add("prune", pile, Date.parse("2026-12-15T00:00:00.000Z"), 300);
  add("prune", pile, Date.parse("2026-11-10T00:00:00.000Z"), 1);
  add("prune", { ...pile, since: "x", tidyAt: null }, Date.parse("2026-11-10T00:00:00.000Z"), 2);

  const ns = [note("Run the tests"), note("Ask first", "you", null), note("Name it", "qa-1", "2026-11-02", "h_a")];
  add("serializeRules", ns);
  add("serializeRules", []);
  add("rulesBlock", ns);
  add("rulesBlock", []);
  add("rulesBlock", Array.from({ length: 35 }, (_, i) => note(`Rule ${i}`)));
  const md = (xs: string[]) => L.serializeRules(xs.map((x) => note(x)));
  const shifts: [string[], string[] | null, string[] | null][] = [
    [["A", "B", "C"], ["A", "B", "C"], ["B", "C"]],
    [["B", "C"], ["B", "C"], ["A", "B", "C"]],
    [["X", "B", "C"], ["A", "B", "C"], ["A2", "B", "C"]],
    [["C", "B", "X"], ["A", "B", "C"], ["B", "D", "C"]],
    [["A", "A", "B"], ["A", "A", "B"], ["A", "B"]],
    [["Y"], null, ["N1", "N2"]],
    [["N1", "Y"], ["N1"], null],
    [[], ["A"], ["B"]],
  ];
  for (const [cur, from, to] of shifts) add("shiftNotes", cur.map((x) => note(x)), from && md(from), to && md(to));

  const answers = [
    "no json",
    '{"lessons": "x"}',
    'Sure: {"lessons":[{"mistake":"m","evidence":"  e  ","rule":"  Run   the tests <!-- -->","match":"p1","standing":"always"},{"rule":"","match":""},{"text":"From text","match":"zz"},{"rule":"' + "x".repeat(320) + '"},{"rule":"Four"}]} tail',
    '{"lessons":[{"rule":null,"text":"T"},{"rule":"","match":"p2"}]}',
  ];
  for (const a of answers) {
    add("parseLearned", a, ["p1", "p2"]);
    add("parseLearned", a, ["p1"], { keepEmpty: true, max: 5 });
  }
  const files = {
    qa: [note("Read tests first"), note("Mine", "you", null), note("Check logs")],
    _all: [note("Keep it short", "dev")],
    dev: [note("Run lint")],
  };
  const tidyAnswers = [
    '{"ops":[{"op":"merge","ids":[1,3],"text":"Read tests and logs","to":"_all","why":"same"},{"op":"remove","id":5,"why":"stale"},{"op":"rewrite","id":4,"text":"Keep notes short","why":"clearer"}]}',
    '{"ops":[{"op":"rewrite","id":2,"text":"x","why":"y"},{"op":"merge","ids":[1,1],"text":"t","why":"w"},{"op":"rewrite","id":1,"text":"Read tests first","why":"none"},{"op":"rewrite","id":1,"text":"Read tests first","to":"dev","why":"move"},{"op":"remove","id":1,"why":"again"}]}',
    '{"ops":[{"op":"merge","ids":[3,1,4],"text":"All","file":"qa","why":"w"},{"op":"remove","id":9},{"op":"rewrite","id":5,"text":"","why":""},{"op":"bogus","id":5}]}',
    '{"ops":[{"op":"rewrite","id":3,"text":"Check the logs","to":" qa ","why":"w"},{"op":"merge","ids":[1,5],"text":"Merged","to":"nope","why":"w"}]}',
    "nothing",
  ];
  for (const a of tidyAnswers) add("tidyRun", files, a, ["qa", "_all", "dev"]);
  add("tidyRun", { rules: [note("R1"), note("R2"), note("R3", "you", null)] }, '{"ops":[{"op":"merge","ids":[1,2],"text":"R","to":"qa","why":"w"},{"op":"remove","id":3,"why":"x"}]}', ["rules"]);
  add("pileText", pile.candidates.slice(0, 3));
  add("pileText", []);
  add("huddleLearnPrompt", "qa", [{ text: "Read tests", evidence: "" }, { text: "Name files", evidence: "it failed" }], pile.candidates.slice(2, 4));
  add("huddleLearnPrompt", "_all", [], []);
  add("tidyPrompt", Object.keys(files).flatMap((role) => (files as any)[role].map((n: any) => ({ role, note: n }))), ["qa", "_all"]);
  add("texts");

  const ticket = { id: "t_1", title: "Fix login", body: "  Make it work.  ", status: "done", reopenedFrom: "review", pr: { reviewDecision: "CHANGES_REQUESTED" } };
  const tickets = [ticket, { id: "t_2", title: "Follow up", madeFrom: "t_1", body: "", status: "backlog" }, { id: "t_3", title: "Other", madeFrom: "t_9", body: "", status: "done" }];
  add("corrections", ticket, msgs, tickets);
  add("corrections", { ...ticket, reopenedFrom: null, pr: null }, msgs.slice(0, 1), []);
  add("lessonsPrompt", { ticket, entries: msgs, corrections: Le.corrections(ticket as any, msgs as any, tickets as any), existing: ["Rule one", "Rule two"] });
  add("lessonsPrompt", { ticket: { ...ticket, body: " " }, entries: [], corrections: { messages: [{ at: "a", text: "x".repeat(1600) }], reopened: false, changesRequested: false, followUps: [] } });
  add("transcript", msgs);
  add("transcript", [{ role: "user", kind: "text", text: "y".repeat(31_000), at: "a" }, ...msgs]);
  add("transcript", []);
  for (const t of [
    "# Rules\n## Lessons\n- One\n* Two  \n-Three\n- \n  - nested\n### Sub\n- Four\n## Next\n- Five",
    "## lessons \n- A\n# Top\n- B",
    "no section\n- A",
    "## Lessons\r\n- With CR\r\n- Second\r\n",
  ]) add("lessonBullets", t);

  const lt = (id: string, status: string, updatedAt: string, extra: object = {}) => ({ id, title: `Ticket ${id}`, body: `Body of ${id}\n\nwith   spaces`, status, updatedAt, ...extra });
  const board = [
    lt("t_a", "done", "2026-10-01T00:00:00.000Z"), lt("t_b", "done", "2026-11-10T00:00:00.000Z", { partOf: "t_a" }),
    lt("t_c", "backlog", "2026-11-12T00:00:00.000Z", { parentId: "t_b", body: "x".repeat(300) }), lt("t_d", "review", "2026-11-11T00:00:00.000Z", { title: "  Spaced   title  " }),
    lt("t_e", "in_progress", "2026-11-13T00:00:00.000Z", { body: "" }), lt("t_f", "ready", "2026-11-09T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-11-17T00:00:00.000Z");
  add("candidates", board, now);
  add("candidates", Array.from({ length: 130 }, (_, i) => lt(`t_${String(i).padStart(3, "0")}`, "backlog", `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`)), now);
  add("suggestPrompt", board[4], board.slice(0, 4));
  add("suggestPrompt", { ...board[2], body: "y".repeat(1300) }, board);
  for (const a of ['{"parent":"t_a","reason":"  Same   work  "}', '{"parent":"t_zz"}', '{"parent":null}', "x", '{"parent":" t_b ","reason":"' + "r".repeat(200) + '"}']) {
    add("parseSuggestion", a, ["t_a", "t_b"]);
  }
  add("findPrompt", board);
  for (const a of [
    '{"links":[{"id":"t_e","parent":"t_d","reason":"r"},{"id":"t_d","parent":"t_e","reason":"loop"},{"id":"t_e","parent":"t_f"},{"id":"t_c","parent":"t_a"},{"id":"t_f","parent":"t_f"},{"id":"t_f","parent":"t_zz"},{"id":" t_f ","parent":"t_b","reason":"  ok  "}]}',
    '{"links":"x"}',
    "nope",
  ]) add("parseFound", a, board);

  for (const w of ["Tickets and the board's cards, 2026 v2 class glass e.g. UI", "ÉCOLE über naïve", "a an the 123 abc"]) add("words", w);
  const rt = (id: string, title: string, status: string, extra: object = {}) => ({ id, title, body: "", status, parentId: null, lastRunAt: null, updatedAt: "2026-11-01T00:00:00.000Z", runCount: 0, ...extra });
  const rows = [
    { ticket: rt("r1", "Login page fails on Safari", "done", { body: "Safari login cookie", lastRunAt: "2026-11-05T10:00:00.000Z" }), summary: "Fixed the  Safari cookie\nbug in login." },
    { ticket: rt("r2", "Login button colour", "review"), summary: null },
    { ticket: rt("r3", "Safari login again", "backlog", { runCount: 2 }), summary: "Still broken " + "z ".repeat(200) },
    { ticket: rt("r4", "Unrelated billing", "done"), summary: "Billing" },
    { ticket: rt("r5", "Parent work", "backlog"), summary: null },
    { ticket: rt("r6", "Child of query", "done", { parentId: "q" }), summary: "child" },
    { ticket: rt("r7", "Hidden login Safari tool", "done", { tool: true }), summary: "tool" },
    { ticket: rt("r8", "Login Safari cookie fix", "done", { updatedAt: "2026-11-09T00:00:00.000Z" }), summary: "x".repeat(400) },
    { ticket: rt("r9", "Safari", "in_progress", { runCount: 1 }), summary: "s" },
  ];
  const q = { id: "q", title: "Safari login broken", body: "Users can't log in on Safari: cookie", parentId: "r5", madeFrom: "r4", partOf: null };
  add("pickRelated", q, rows);
  add("recallBlock", q, rows);
  add("recallBlock", { ...q, title: "zzz", body: "", parentId: null, madeFrom: null }, rows);
  add("recallBlock", { ...q, parentId: null, madeFrom: null }, rows.map((r) => ({ ...r, summary: (r.summary ?? "") + " " + "word ".repeat(300) })));

  add("extractMockups", 'Hi\n<ckanban-mockup name="a-one.html">\n```html\n<p>1</p>\n```\n</ckanban-mockup>\n<ckanban-mockup  name=" b.htm " ><b>2</b></ckanban-mockup><ckanban-mockup name="../x.html">x</ckanban-mockup><ckanban-mockup name="c.html">  </ckanban-mockup>');

  const ev = (run: number, at: string, event: object) => ({ run, at, event });
  const activity = [
    ev(1, "2026-11-16T09:00:00.000Z", { type: "system", subtype: "init", permissionMode: "plan" }),
    ev(1, "2026-11-16T09:10:00.000Z", { type: "result", session_id: "s1", total_cost_usd: 0.4, usage: { input_tokens: 10, output_tokens: 5 } }),
    ev(1, "2026-11-16T09:20:00.000Z", { type: "system", subtype: "init" }),
    ev(1, "2026-11-16T09:30:00.000Z", { type: "result", session_id: "s1", total_cost_usd: 0.9, modelUsage: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 20, costUSD: 0.8 }, haiku: { inputTokens: 5, costUSD: 0.1 } } }),
    ev(2, "2026-11-16T12:00:00.000Z", { type: "ckanban_run", kind: "chat" }),
    ev(2, "2026-11-16T12:05:00.000Z", { type: "other" }),
    ev(2, "2026-11-16T12:10:00.000Z", { type: "result", session_id: "s1", total_cost_usd: 0.3, modelUsage: { "claude-opus-5-5": { inputTokens: 50, outputTokens: 5, costUSD: 0.3 } } }),
    ev(3, "2026-11-16T13:00:00.000Z", { type: "ckanban_run" }),
    ev(4, "2026-11-16T14:00:00.000Z", { type: "ckanban_run", kind: "work" }),
    ev(4, "2026-11-16T14:30:00.000Z", { type: "result", session_id: "s2", total_cost_usd: 2, modelUsage: {} }),
  ];
  add("ticketRuns", activity);
  add("ticketRuns", []);
  const windows = [
    { start: "2026-11-16T08:00:00.000Z", end: "2026-11-16T13:00:00.000Z", utilization: 40, seenAt: "2026-11-16T12:59:00.000Z" },
    { start: "2026-11-16T13:00:00.000Z", end: "2026-11-16T18:00:00.000Z", utilization: 10, seenAt: "2026-11-16T15:00:00.000Z" },
  ];
  const runs = ticketRuns(activity as any);
  add("windowsNeeded", runs, windows, Date.parse("2026-11-16T15:00:00.000Z"));
  add("windowsNeeded", runs, windows, Date.parse("2026-11-17T15:00:00.000Z"));
  const span = (w: any) => `${Date.parse(w.start)}-${Date.parse(w.end)}`;
  const team = { costUsd: 0.5, huddles: [{ id: "h_1", status: "closed", createdAt: "x", costUsd: 0.5, teammates: [{ handle: "qa", role: "QA", costUsd: 0.5 }] }] };
  add("ticketUsage", { activity, windows, now: Date.parse("2026-11-16T15:00:00.000Z"), teammates: team, side: 0.25 }, { [span(windows[0])]: 4, [span(windows[1])]: 1 });
  add("ticketUsage", { activity, windows, now: Date.parse("2026-11-17T15:00:00.000Z"), windowError: "rate limited" }, { [span(windows[0])]: 0 });
  add("ticketUsage", { activity: [], windows: [], now: 0, teammates: { costUsd: 0, huddles: [] } }, {});

  const h = (id: string, host: string, createdAt: string, participants: object[], template?: string) => ({ id, hostTicket: host, createdAt, status: "closed", participants, ...(template ? { template } : {}) });
  const huddles = [
    h("h_1", "t_1", "2026-11-01T00:00:00.000Z", [
      { kind: "agent", handle: "qa", role: "QA", preset: "qa", joinedAt: "2026-11-01T01:00:00.000Z", costUsd: 0.3 },
      { kind: "agent", handle: "qa-2", role: "QA", preset: "qa", joinedAt: "2026-11-01T00:30:00.000Z", costUsd: 0.2 },
      { kind: "human", handle: "you", role: "you", preset: "x" },
      { kind: "agent", handle: "dev", role: "Dev", costUsd: 0 },
    ], "review"),
    h("h_2", "t_2", "2026-11-03T00:00:00.000Z", [{ kind: "agent", handle: "qa", role: "QA", preset: "qa", costUsd: 0.12345 }], "review"),
    h("h_3", "t_1", "2026-11-02T00:00:00.000Z", [{ kind: "agent", handle: "b", role: "B", preset: "breaker" }]),
  ];
  add("huddleUsage", huddles.map((x, i) => ({ board: i ? "b2" : "b1", huddle: x, title: i === 2 ? null : `T${i}` })));
  add("huddleUsage", []);
  add("teammateSpend", huddles, "t_1");
  add("teammateSpend", huddles, "t_9");
  return out;
}

test("the extras fixture table matches Bun", () => {
  // parseNotes is used by shiftNotes' inputs; touch it so a change there shows up here too.
  expect(parseNotes("- a <!-- by you -->\n").length).toBe(1);
  const table = cases();
  const text = `[\n${table.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`;
  if (UPDATE) writeFileSync(FILE, text);
  const saved = JSON.parse(readFileSync(FILE, "utf8")) as Case[];
  expect(saved.length).toBe(table.length);
  for (let i = 0; i < table.length; i++) expect({ i, ...saved[i] }).toEqual({ i, ...JSON.parse(JSON.stringify(table[i])) });
});
