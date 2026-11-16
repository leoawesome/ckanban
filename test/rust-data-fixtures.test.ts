// Shared fixtures of the Rust port's data-folder library (rust/core/tests/fixtures/data): YAML front matter cases
// and a small data folder written by Bun's own Store and writers. This test checks Bun still writes exactly those
// bytes (a ticket saved again unchanged, each JSON file re-serialized, each JSONL line); `cargo test` in rust/ checks
// Rust reads and writes them back byte for byte too. After a deliberate change to how Bun writes data files, run
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-data-fixtures.test.ts`, then make `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { Store } from "../src/core/store";
import { addHuddleSpend } from "../src/usage/spend";
import { recordWindow } from "../src/usage/ticket-usage";
import { tempDir } from "./support/helpers";

const DIR = resolve(import.meta.dir, "..", "rust", "core", "tests", "fixtures", "data");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

// ---- YAML cases ----

/** mulberry32: the same cases on every update. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "word", "Fix", "login", "a", "x", " ", " ", "  ", "\n", "\n", "\n\n", "\t", ": ", ":", " #", "#", "'", "\"", "- ", "-", "?", "---", "...", "%",
  "é", "漢字", "🙂", "\u0001", "\u007f", "123", "1e5", "0x1F", "true", "null", "~", "[", "]", "{", "}", ",", "&", "*", "!", "|", ">", "@", "`",
  "supercalifragilisticexpialidocious-and-then-some-more-letters-to-make-it-long", "https://example.com/a/b?c=d#e", "\\", "\\n", " \n", "\n ",
];

function randomString(r: () => number): string {
  const n = Math.floor(r() * 40);
  let s = "";
  for (let i = 0; i < n; i++) {
    const p = PIECES[Math.floor(r() * PIECES.length)];
    s += r() < 0.7 && !/\s/.test(p) && i > 0 ? ` ${p}` : p;
  }
  return s;
}

function randomValue(r: () => number, depth: number): unknown {
  const k = r();
  if (depth > 2 || k < 0.55) return randomString(r);
  if (k < 0.62) return Math.floor(r() * 2000) - 1000;
  if (k < 0.66) return Math.round(r() * 1e6) / 1000;
  if (k < 0.69) return r() < 0.5;
  if (k < 0.72) return null;
  if (k < 0.86) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  return randomObject(r, depth + 1);
}

function randomObject(r: () => number, depth: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const key = r() < 0.75 ? `k${i}` : Array.from(randomString(r)).slice(0, 30).join("") || `k${i}`;
    o[key] = randomValue(r, depth);
  }
  return o;
}

const HAND_STRINGS = [
  "", " ", "plain", "Fix: login: \"broken\" on #phone", "it's", "both ' and \"", "123", "-1.5", ".5", "1e3", "0o17", "0x1F", ".inf", "-.Inf", ".nan",
  "true", "False", "NULL", "~", "yes", "no", "on", "2026-11-15T08:00:00.000Z", "- item", "-", "?", "? x", "a: b", "a:b", "a #b", "a#b", "trailing ",
  " leading", "trailing:", "#hash", "%pct", "@at", "`tick", "|pipe", ">gt", "[x]", "{x}", "a, b", "*star", "&amp", "!bang",
  "---", "--- x", "...", "a\n---\nb", "line1\nline2", "line1\nline2\n", "line1\n\nline2\n\n\n", "\nstarts with newline", "  indented\nnext",
  "a\n  more indented\nb", "ends with spaces\n  ", "tab\there", "ctl\u0001char", "bell\u0007 esc\u001b nul\u0000 vt\u000b", "nbsp x",
  "word ".repeat(25).trim(), "x".repeat(120), `${"long line of words ".repeat(6)}\n${"second long line of words ".repeat(5)}`,
  `${"word ".repeat(30)}\n  indented ${"more ".repeat(20)}\nback`, `"${"quoted words ".repeat(10)}"`, `it's ${"long words ".repeat(12)}`,
  `${"a ".repeat(50)}\n`, `a  \n${"b ".repeat(50)}`, "é漢字🙂 ".repeat(20), `${"x ".repeat(20)}\u0001${" y".repeat(40)}`,
  `line one has a space before newline \n${"and more text ".repeat(6)}`, `${"long ".repeat(10)}\n\n\n${"text ".repeat(20)}\n\n`,
];

function yamlCases() {
  const r = rng(20261116);
  const values: unknown[] = [
    { s: HAND_STRINGS },
    Object.fromEntries(HAND_STRINGS.map((s, i) => [`k${i}`, s])),
    Object.fromEntries(HAND_STRINGS.filter((s) => s).map((s, i) => [s, i])),
    { n: [0, 1, -1, 1.5, 0.1, 1e21, 1.5e-7, 123456789012, 0.000001], b: [true, false], z: null, e: [], o: {} },
    { deep: { a: [{ b: [{ c: { d: ["x", ["y", []]] } }] }], e: [[], {}, [[1]]] } },
    { ["a".repeat(70)]: "value after a very long key that should fold differently from a short key here" },
    { ["b".repeat(60)]: "word ".repeat(20) },
  ];
  for (let i = 0; i < 150; i++) values.push(randomObject(r, 0));
  return values.map((value) => ({ value, yaml: YAML.stringify(value) }));
}

const PARSE_TEXTS = [
  "a: 1\nb: '2'\nc: \"3\"\nd: 2026-11-15T08:00:00.000Z\ne: yes\nf: 1_000\ng: 0o17\nh: 0x1F\ni: -1.50\nj: ~\nk: True\nl: 1e3\nm: .5\nn: +7\n",
  "list: [a, 'b', 1, {x: y}]\nmap: {a: 1, b: [2, 3]}\n",
  "lit: |\n  line 1\n   line 2\n\nfold: >-\n  folded\n  text\n\n  para\nkeep: |+\n  x\n\n",
  "# comment\na: 1 # trailing\nb:\n  - x\n  # inner\n  - y\n",
  "p: plain multi\n  line text\nq: \"esc \\n \\t \\x41 \\u00e9 \\\\\"\ns: 'it''s'\n",
  "anchor: &a {x: 1}\nalias: *a\n",
  "empty:\nnested:\n  deep:\n    deeper: null\n",
  "\"quoted key\": 1\n'1': one\n2: two\ntrue: t\n",
  // Not YAML Bun accepts: both sides must refuse them (a ticket that shows as corrupt).
  "a: 1\na: 2\n", "a: [1\n", "plain multi\n  line: no\n", "a: 'open\n", "- a\nb: 1\n",
];

/** YAML.parse's value, or { error: true } when it throws. */
function parsed(yaml: string): { value: unknown } | { error: true } {
  try {
    return { value: YAML.parse(yaml) };
  } catch {
    return { error: true };
  }
}

describe("Rust port data fixtures: Bun writes the bytes they record", () => {
  test("YAML.stringify and YAML.parse", () => {
    const file = join(DIR, "yaml.json");
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      const stringify = yamlCases();
      const parse = [...PARSE_TEXTS, ...stringify.map((c) => c.yaml)].map((yaml) => ({ yaml, ...parsed(yaml) }));
      writeFileSync(file, JSON.stringify({ stringify, parse }, null, 1) + "\n");
      return;
    }
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const c of doc.stringify) expect(YAML.stringify(c.value)).toBe(c.yaml);
    for (const c of doc.parse) expect(parsed(c.yaml)).toEqual(c.error ? { error: true } : { value: c.value });
  });

  test("a data folder written by Bun", async () => {
    const home = join(DIR, "home");
    if (UPDATE) {
      rmSync(home, { recursive: true, force: true });
      writeHome(home);
    }
    expect(existsSync(home)).toBe(true);
    // Bun reads and saves every file again unchanged: same bytes.
    const copy = tempDir("ck-rust-data-");
    cpSync(home, copy, { recursive: true });
    const store = new Store(copy);
    for (const p of store.listProfiles()) {
      for (const id of readdirSync(join(copy, "profiles", p.slug, "tickets"))) store.updateTicket(p.slug, id, {}, { keepUpdatedAt: true });
    }
    for (const rel of filesUnder(home)) {
      const want = readFileSync(join(home, rel), "utf8");
      const got = readFileSync(join(copy, rel), "utf8");
      expect(got).toBe(want);
      const fmt = FORMATS.find(([re]) => re.test(rel))?.[1];
      if (fmt) expect(`${JSON.stringify(JSON.parse(want), null, fmt.indent)}${fmt.nl ? "\n" : ""}`).toBe(want);
      if (rel.endsWith(".jsonl")) for (const line of want.split("\n").filter(Boolean)) expect(JSON.stringify(JSON.parse(line))).toBe(line);
    }
  });
});

/** The JSON files of the fixture folder and their layout (Rust's `datafile::formats` must agree; tests/data.rs). */
const FORMATS: [RegExp, { indent?: number; nl: boolean }][] = [
  [/profile\.json$|schedules\/[a-z0-9]+\.json$|jobs\/[a-z0-9]+\.json$|loops\/[a-z0-9]+\.json$|huddles\/h_\w+\.json$|huddle-(presets|templates)\.json$|snippets\.json$|avatars\.json$|help\.json$/, { indent: 2, nl: true }],
  [/\.state\.json$|spend-days\.json$/, { nl: true }],
  [/usage-windows\.json$/, { nl: false }],
  [/outputs\/status\.json$/, { indent: 2, nl: false }],
];

function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p, base) : [relative(base, p)];
  });
}

/** The fixture folder, made with Bun's own writers (ticket ids and times change on each update). */
function writeHome(home: string) {
  const store = new Store(home);
  const slug = "demo";
  store.saveProfile({ name: "Démo board", slug, path: "/Users/sam/code/demo", baseBranch: "main", model: null, createdAt: "2026-11-15T08:00:00.000Z" } as never);
  const a = store.createTicket(slug, { title: "Fix: login: \"broken\" on #phone", body: "## Goal\nFix it.\n", status: "backlog", tags: ["ui", "phone"], partOf: "t_20261115_main", partOfVia: "chat", tool: true, kind: "build" });
  store.updateTicket(slug, a.id, {
    status: "done",
    notice: `${"A long notice line with many words that goes past the line width ".repeat(2)}\n\nSecond paragraph.\n`,
    error: "ctl\u0001 in an error",
    results: [{ at: "2026-11-15T09:00:00.000Z", summary: "Done.\nTwo lines", costUsd: 0.0421 }, { at: "2026-11-15T10:00:00.000Z", summary: "word ".repeat(30).trim() }],
    plan: { state: "running", steps: [{ key: "a", title: "it's a: step", deps: [] }], meta: {} },
    teammateCards: { "123": { open: true }, "key: odd": { n: 1.5 } },
    prs: [],
    runCapUsd: 2.5,
    pinnedAt: "2026-11-15T08:30:00.000Z",
  } as never);
  const b = store.createTicket(slug, { title: "x".repeat(100), body: "", status: "ready", dependsOn: [a.id], needs: ["chrome"], important: true, model: "opus", effort: "high", main: true, startFrom: "main" });
  store.updateTicket(slug, b.id, { title: `Émoji 🙂 and 漢字 ${"word ".repeat(18).trim()}`, body: "no final newline", lastActivity: "- starts with a dash", outcome: null } as never);
  store.addComment(slug, a.id, "ai", "Done. Fixed the login.\nSecond line with \"quotes\" and é");
  store.addComment(slug, a.id, "user", "A note", "t_20261115_other");
  store.appendActivity(slug, a.id, 1, { type: "ckanban_run", kind: "work" });
  store.appendActivity(slug, a.id, 1, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.042, result: "Done." });
  store.saveSchedule(slug, {
    id: "q8w3n2xk", name: "Morning inbox", title: "Inbox check {date}", cron: "0 9 * * 1-5", mode: "auto", body: "Check my inbox.", enabled: true, skipIfRunning: true,
    tags: ["inbox"], quiet: false, model: null, partOf: null, createdAt: "2026-11-15T08:00:00.000Z", updatedAt: "2026-11-15T08:00:00.000Z", lastFiredAt: null, lastError: null, nextRunAt: "2026-11-16T09:00:00.000Z",
  } as never);
  store.appendScheduleHistory(slug, "q8w3n2xk", { at: "2026-11-15T08:00:00.000Z", kind: "edited", action: "created", fields: [], by: "user" } as never);
  store.appendScheduleHistory(slug, "q8w3n2xk", { at: "2026-11-16T09:00:00.000Z", kind: "fired", trigger: "schedule", ticketId: b.id } as never);
  store.saveJob(slug, {
    id: "m4p0c7rt", name: "Deploy check", at: "2026-11-15T18:00:00.000Z", action: { kind: "command", command: "./scripts/check.sh", timeoutSec: 300 }, state: "scheduled",
    sourceTicketId: null, createdAt: "2026-11-15T08:00:00.000Z", updatedAt: "2026-11-15T08:00:00.000Z", firedAt: null, result: null,
  } as never);
  store.saveLoop(slug, { version: 1, id: "l00p0001", name: "Watch", enabled: true, service: "gmail", passes: [], scriptHash: "abc", everyMinutes: 15, column: "backlog", autoStart: false, askClaude: { on: false, prompt: "" }, instructions: "", allowedTools: [], createdAt: "2026-11-15T08:00:00.000Z", updatedAt: "2026-11-15T08:00:00.000Z", lastCheckedAt: null, lastFiredAt: null, lastError: null } as never);
  store.saveLoopState(slug, "l00p0001", { seen: ["a", "b"], primed: true, failures: 0, backoffUntil: null, lastFound: 2, lastItems: [] } as never);
  store.saveLoopScript(slug, "l00p0001", "#!/bin/sh\necho '[]'\n");
  store.saveHuddle(slug, { id: "h_4f2kq9zb", ticketId: a.id, status: "open", createdAt: "2026-11-15T08:00:00.000Z", participants: [{ handle: "qa-1", role: "qa", token: "secret" }], costUsd: 0.25 } as never);
  store.appendHuddleMessage(slug, "h_4f2kq9zb", { id: "m1", seq: 1, ts: "2026-11-15T08:01:00.000Z", from: "main", text: "@qa-1 check it", mentions: ["qa-1"], kind: "chat" } as never);
  store.saveHuddlePresets(null, [{ name: "qa", role: "QA", prompt: "Check: it.\nAll of it.", model: null, mode: "auto", lead: false, canEdit: false, workspace: "shared" }] as never);
  store.saveHuddleTemplates(slug, [{ name: "t", label: "T", description: "", roster: [], rounds: 2, maxCostUsd: 10, report: "", hostRules: "" }] as never);
  addHuddleSpend(home, slug, 0.125, new Date("2026-11-15T12:00:00.000Z"));
  recordWindow(join(home, "usage-windows.json"), { windows: [{ key: "five_hour", percent: 42.5, resetsAt: "2026-11-15T13:00:00.000Z" }], fetchedAt: "2026-11-15T09:00:00.000Z" } as never);
  const outputs = join(home, "profiles", slug, "tickets", a.id, "outputs");
  mkdirSync(outputs, { recursive: true });
  // feature.ts writes status.json this way (pretty, no final newline, fixed .tmp).
  writeFileSync(join(outputs, "status.json"), JSON.stringify({ goal: "Ship it", next: "Land it", updatedAt: "2026-11-15T09:00:00.000Z" }, null, 2));
}
