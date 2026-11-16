// The run engine's shared fixtures (rust/board/tests/fixtures/runs.json): inputs for the pure logic of src/runs/ with
// the answer Bun gives in `expect` (as JSON text, so key order and number text count too). This test checks Bun still
// gives exactly those answers; `cargo test -p ckanban-board` checks Rust gives them too (rust/board/tests/runs.rs).
// After a deliberate change to that Bun code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-runs-fixtures.test.ts`
// to rewrite `expect`, then make `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseResult } from "../src/runs/result";
import { isTransientText, transientError } from "../src/runs/retry";
import { isLimitText, limitMessage } from "../src/usage/limit";
import { describeTool, extractFinalText, summarizeEvent } from "../src/runs/activity";
import { liveJson } from "../src/runs/live-cut";
import { connectorRunOptions, connectorSetting, connectorToolPrefix, parseConnectorSetting, runDisallowed } from "../src/runs/connectors";
import { familyVersion, newerVersion } from "../web/src/lib/models";
import { learnedVersions, learnModel, useModelVersionsFile } from "../src/runs/model-versions";
import { buildArgs, controlResponse } from "../src/runs/runner";
import { parseSideResult, readSideSpend, sideCallArgs } from "../src/runs/side-call";
import { claudeDefaults, encodeProjectDir, isClaudeCommand, listClaudeProjects, listSessions, liveSessionMatch } from "../src/runs/claude";
import { ActivityDigests } from "../src/runs/activity-digest";
import { tempDir } from "./support/helpers";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "runs.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const doc = JSON.parse(readFileSync(FILE, "utf8"));
const before = JSON.stringify(doc);
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

/** The mask the liveJson cases use. */
const mask = (s: string) => s.replaceAll("SECRET-KEY-123", "***");

/** Writes a fixture's files under `dir`: { path, text, mtime (epoch s) }. */
function lay(dir: string, files: { path: string; text: string; mtime?: number }[]) {
  for (const f of files) {
    const p = join(dir, f.path);
    mkdirSync(join(p, ".."), { recursive: true });
    if (f.path.endsWith("/")) mkdirSync(p, { recursive: true });
    else writeFileSync(p, f.text);
    if (f.mtime) utimesSync(p, f.mtime, f.mtime);
  }
}

const fill: Record<string, (c: any) => unknown> = {
  parseResult: (c) => parseResult(c.text),
  transientError: (c) => ({ transient: transientError(c.events, c.stderr), limit: limitMessage(c.events, c.stderr) }),
  textChecks: (c) => ({ transient: isTransientText(c.text), limit: isLimitText(c.text) }),
  describeTool: (c) => describeTool(c.name, c.input),
  summarizeEvent: (c) => ({ plain: summarizeEvent(c.event) ?? null, raw: summarizeEvent(c.event, { raw: true }) ?? null }),
  extractFinalText: (c) => extractFinalText(c.events),
  liveJson: (c) => liveJson(c.value, mask, c.max),
  runDisallowed: (c) => runDisallowed(c.own, c.ultracode),
  connectorSetting: (c) => ({ setting: connectorSetting({ claudeAiConnectors: c.value }), parsed: parseConnectorSetting(c.value) }),
  connectorToolPrefix: (c) => connectorToolPrefix(c.name),
  connectorRunOptions: (c) => connectorRunOptions(c.setting, c.known),
  familyVersion: (c) => familyVersion(c.id),
  newerVersion: (c) => newerVersion(c.a, c.b),
  learnModel: (c) => {
    const f = join(tempDir(), "model-versions.json");
    if (c.saved != null) writeFileSync(f, c.saved);
    useModelVersionsFile(f);
    for (const ev of c.events) learnModel(ev);
    let file: string | null = null;
    try {
      file = readFileSync(f, "utf8");
    } catch {}
    return { learned: learnedVersions(), file };
  },
  buildArgs: (c) => buildArgs(c.sessionId, c.resume, c.model, c.disallowed, c.mcp, c.systemPrompt, c.maxBudgetUsd, c.effort, c.ultracode, c.more),
  controlResponse: (c) => controlResponse(c.event, c.planning),
  sideCallArgs: (c) => sideCallArgs(c.input),
  parseSideResult: (c) => parseSideResult(c.out, c.code, c.err, c.model),
  encodeProjectDir: (c) => encodeProjectDir(c.path),
  isClaudeCommand: (c) => isClaudeCommand(c.cmd),
  liveSessionMatch: (c) => liveSessionMatch(c.commands, { id: c.id, title: c.title }),
  listSessions: (c) => {
    const config = tempDir();
    lay(join(config, "projects", encodeProjectDir(c.project)), c.files);
    return listSessions(c.project, { configDir: config }, c.limit);
  },
  listClaudeProjects: (c) => {
    const home = tempDir();
    const sub = (s: string) => s.replaceAll("$HOME", home);
    // A session folder is named after its project's path: `project` gives it.
    const path = (f: any) => sub(f.project ? `${f.path}${encodeProjectDir(sub(f.project))}/` : f.path);
    lay(home, c.files.map((f: any) => ({ ...f, path: path(f), text: sub(f.text ?? "") })));
    const out = listClaudeProjects({ homeDir: home, configDir: join(home, ".claude"), excludePrefixes: c.exclude.map(sub), dataDir: sub(c.dataDir) });
    return JSON.parse(JSON.stringify(out).replaceAll(home, "$HOME"));
  },
  claudeDefaults: (c) => {
    const config = tempDir();
    if (c.settings != null) writeFileSync(join(config, "settings.json"), c.settings);
    return claudeDefaults({ configDir: config });
  },
  activityDigest: (c) => {
    const f = join(tempDir(), "activity.jsonl");
    writeFileSync(f, c.log);
    const d = new ActivityDigests().getNow(f);
    return { offset: d.offset, edited: [...d.edited], runEntries: d.runEntries, sessionTotals: [...d.sessionTotals.entries()], lastRun: d.lastRun };
  },
  readSideSpend: (c) => {
    const f = join(tempDir(), "side-spend.jsonl");
    writeFileSync(f, c.ledger);
    const s = readSideSpend(f);
    return { costUsd: s.costUsd, days: Object.fromEntries(s.days), calls: Object.fromEntries(s.calls ?? []) };
  },
};

describe("Rust board run engine fixtures: Bun gives the answers they record", () => {
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
