// Shared fixtures of the Rust board port (rust/board/tests/fixtures/sessions/agents.json): subagents, workflows, tool
// details and chat search, with the answer Bun gives in `expect`. This test checks Bun still gives exactly those
// answers; `cargo test -p ckanban-board --test sessions_agents` in rust/ checks Rust gives them too. After a deliberate
// change to that Bun code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-agents-fixtures.test.ts` to rewrite
// `expect`, then make the cargo test pass again.
//
// Cases with `files` build a temp folder first; "$TMP" in inputs stands for it, and in answers it replaces it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  notifiedStatus, parseAgentTranscript, parseTaskNotification, settleAgent, SubagentCache, subagentFiles, toolLabel, withTranscript,
} from "../src/runs/subagents";
import {
  parseJournal, parseWorkflowMeta, progressStatus, settleWorkflow, transcriptCost, transcriptDirOf, WorkflowCache, workflowAgentDetail,
  workflowDirCost, workflowFromCall, workflowLaunched, workflowNotified, workflowScript, withRun, type WorkflowRun,
} from "../src/runs/workflows";
import { findToolDetail, findToolDetailIn } from "../src/chat/tooldetail";
import { matchesText, parseRef, queryWords, readChat, readText, searchChat, toolOutputs, whoWrote, type ChatSource } from "../src/chat/chat-search";
import { tempDir } from "./support/helpers";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "sessions", "agents.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

/** Deep copy with every string mapped. */
const mapStrings = (v: any, f: (s: string) => string): any =>
  typeof v === "string" ? f(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, f)) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) : v;

/** "NaN" / "Infinity" stand for those numbers (JSON has none). */
const numArg = (v: any) => (typeof v === "string" ? Number(v) : v);

const run = (r: any): WorkflowRun | null => (r ? { ...r, agents: new Map(Object.entries(r.agents ?? {})) } : null);
const src = (s: any): ChatSource => ({ ...s, toolOutput: s.toolOutput ? new Map(Object.entries(s.toolOutput)) : undefined });
const sorted = (m: Map<string, any>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const caught = (f: () => any) => {
  try {
    return f();
  } catch (e) {
    return { error: (e as Error).message };
  }
};

/** Every file written gets this mtime (seconds) unless the case gives one, so version strings are fixed. */
const MTIME = 1794736800;

/** Writes `files` under a new temp folder and sets the given mtimes (seconds). */
function build(files: Record<string, string>, mtimes: Record<string, number> = {}): string {
  const dir = tempDir("ck-rust-agents-");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content, MTIME);
  for (const [rel, t] of Object.entries(mtimes)) utimesSync(join(dir, rel), t, t);
  return dir;
}

function write(dir: string, rel: string, content: string, mtime = MTIME) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  utimesSync(p, mtime, mtime);
}

function answer(fn: string, i: any, tmp: string | null): any {
  switch (fn) {
    case "toolLabel": return toolLabel(i.block);
    case "parseAgentTranscript": return parseAgentTranscript(i.raw);
    case "parseTaskNotification": return parseTaskNotification(i.text);
    case "notifiedStatus": return notifiedStatus(i.status);
    case "withTranscript": return withTranscript(i.a, i.t ?? undefined);
    case "settleAgent": return settleAgent(i.a, i.runActive, i.now);
    case "parseWorkflowMeta": return parseWorkflowMeta(i.script);
    case "workflowFromCall": return workflowFromCall(i.toolUseId, i.input, i.at);
    case "workflowLaunched": workflowLaunched(i.w, i.block, i.meta ?? undefined, i.at); return i.w;
    case "workflowNotified": workflowNotified(i.w, i.status, i.result, i.at); return i.w;
    case "transcriptDirOf": return transcriptDirOf(i.text);
    case "transcriptCost": return transcriptCost(i.raw);
    case "parseJournal": return parseJournal(i.raw);
    case "progressStatus": return progressStatus(i.state);
    case "withRun": return withRun(i.w, run(i.run), i.progress);
    case "workflowAgentDetail": return workflowAgentDetail(i.w, run(i.run), i.agentId);
    case "settleWorkflow": return settleWorkflow(i.w, i.runActive, i.now);
    case "workflowScript": return workflowScript(i.w, run(i.run));
    case "findToolDetail": return findToolDetail(i.raw, i.id);
    case "findToolDetailIn": return findToolDetailIn(i.paths, i.id);
    case "whoWrote": return whoWrote(i.e);
    case "queryWords": return queryWords(i.query);
    case "searchChat": return caught(() => searchChat(i.sources.map(src), i.query, { includeTools: i.includeTools, limit: i.limit }));
    case "parseRef": return parseRef(i.ref);
    case "readChat": return caught(() => readChat(src(i.src), i.index, { before: numArg(i.before), after: numArg(i.after) }));
    case "toolOutputs": return sorted(toolOutputs(i.raw));
    case "matchesText": return matchesText(i.ticketId, i.query, i.r, i.includeTools);
    case "readText": return readText(i.ticketId, i.r);
    case "subagentFiles": return subagentFiles(i.session);
    case "workflowDirCost": return workflowDirCost(i.dir);
    case "SubagentCache":
    case "WorkflowCache": {
      const dir = tmp!;
      const cache = fn === "SubagentCache" ? new SubagentCache() : new WorkflowCache();
      return i.steps.map((s: any) => {
        if (s.op === "version") return cache.version(i.session);
        if (s.op === "write") return write(dir, s.path, s.content, s.mtime), null;
        if (s.op === "rm") return rmSync(join(dir, s.path)), null;
        if (cache instanceof SubagentCache) return sorted(cache.load(i.session));
        const r = cache.load(i.session, s.runId);
        return { ...r, agents: [...r.agents] };
      });
    }
  }
  throw new Error(`unknown fn ${fn}`);
}

describe("Rust board fixtures: subagents, workflows, tool details, chat search", () => {
  test("Bun gives the recorded answers", () => {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    const want = JSON.parse(JSON.stringify(doc));
    for (const c of doc.cases) {
      let input = c.input;
      let tmp: string | null = null;
      if (input.files) {
        tmp = build(input.files, input.mtimes);
        input = mapStrings(input, (s) => s.split("$TMP").join(tmp!));
      } else input = structuredClone(input);
      let out = answer(c.fn, input, tmp);
      if (tmp) out = mapStrings(out, (s) => s.split(tmp!).join("$TMP"));
      c.expect = out === undefined ? null : JSON.parse(JSON.stringify(out));
    }
    if (UPDATE) {
      writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
      return;
    }
    expect(doc).toEqual(want);
  });
});
