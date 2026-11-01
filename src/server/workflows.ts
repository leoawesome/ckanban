import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentTranscript, type AgentStep } from "./subagents";
import { messageCost } from "./ticket-usage";

// Workflows: scripts Claude Code runs with the Workflow tool, each starting many helper agents in phases (ultracode
// turns them on for every substantial task). The parent transcript has the Workflow call, its launch result (run id,
// task id) and a <task-notification> when it ends. Claude Code writes the rest next to the session file:
//   <session>/subagents/workflows/<runId>/journal.jsonl         launched / started (agentId, label, phase) / result
//   <session>/subagents/workflows/<runId>/agent-<agentId>.jsonl each helper agent's transcript (usage gives its cost)
//   <session>/workflows/<runId>.json                            written when the workflow ends: status, phases, progress
// While it runs, the stream also carries task_progress events with the full agent list (queued ones too); the board
// keeps the latest per workflow (see Board.workflowProgress) and merges it in with withProgress.

export const WORKFLOW_TOOL = /^Workflow$/;

export type WorkflowStatus = "running" | "done" | "failed" | "stopped";
export type WorkflowAgentStatus = "waiting" | "running" | "done" | "failed" | "stopped";

export interface WorkflowAgent {
  /** Claude Code's agent id (links the row to its transcript); null for an agent still waiting to start. */
  agentId: string | null;
  label: string;
  /** The phase it belongs to ("" when the script gave none). */
  phase: string;
  status: WorkflowAgentStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Last time anything was written for it. */
  updatedAt: string | null;
  costUsd: number;
  /** Label of the tool call it is in the middle of (running agents only). */
  current: string | null;
  stepCount: number;
}

/** One agent in full, for its opened row: its steps and what it handed back. */
export interface WorkflowAgentDetail extends WorkflowAgent {
  steps: AgentStep[];
  result: string | null;
}

export interface WorkflowInfo {
  /** The parent's Workflow tool_use id. */
  toolUseId: string;
  /** Claude Code's run id (names the workflow's files); null until it launched. */
  runId: string | null;
  /** The background task id (what stop_task takes); null until it launched. */
  taskId: string | null;
  name: string;
  description: string;
  /** Phase titles in script order. */
  phases: string[];
  status: WorkflowStatus;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  agents: WorkflowAgent[];
  costUsd: number;
  error: string | null;
  /** The script (server side only: the conversation route strips it, the script route serves it). */
  script?: string | null;
  /** Where Claude Code saved the script, when the call named a file instead of passing it inline. */
  scriptPath?: string | null;
}

/** name / description / phase titles from a script's `export const meta = { ... }`. */
export function parseWorkflowMeta(script: string): { name: string | null; description: string | null; phases: string[] } {
  const start = script.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) return { name: null, description: null, phases: [] };
  const open = script.indexOf("{", start);
  const meta = script.slice(open, bracketEnd(script, open));
  // The phase list is read apart: a phase's own title/detail aren't the workflow's name/description.
  const at = meta.search(/\bphases\s*:\s*\[/);
  let rest = meta, list = "";
  if (at >= 0) {
    const from = meta.indexOf("[", at);
    const end = bracketEnd(meta, from);
    list = meta.slice(from, end);
    rest = meta.slice(0, at) + meta.slice(end);
  }
  const str = (key: string) => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`, "s").exec(rest);
    return m ? unescape(m[2]) : null;
  };
  const phases = [...list.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs)].map((m) => unescape(m[2]));
  return { name: str("name"), description: str("description"), phases };
}

function unescape(s: string): string {
  return s.replace(/\\(['"`\\])/g, "$1").replace(/\\n/g, " ");
}

/** Index just past the bracket that closes the one at `from` (strings skipped); text.length when it never closes. */
function bracketEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The parent's view of a Workflow call, before its files are read. */
export function workflowFromCall(toolUseId: string, input: any, at: string): WorkflowInfo {
  const script = typeof input?.script === "string" ? input.script : null;
  const meta = script ? parseWorkflowMeta(script) : { name: null, description: null, phases: [] };
  const named = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : null;
  return {
    toolUseId, runId: null, taskId: null,
    name: meta.name ?? named ?? "Workflow",
    description: meta.description ?? "",
    phases: meta.phases,
    status: "running", startedAt: at, endedAt: null, updatedAt: at,
    agents: [], costUsd: 0, error: null,
    script, scriptPath: typeof input?.scriptPath === "string" ? input.scriptPath : null,
  };
}

/** The Workflow call's tool_result: launched (run and task ids) or an error. */
export function workflowLaunched(w: WorkflowInfo, block: any, meta: any, at: string): void {
  w.updatedAt = at || w.updatedAt;
  const text = resultText(block?.content);
  if (block?.is_error) {
    w.status = "failed";
    w.error = text.trim() || "The workflow didn't start";
    w.endedAt = at || null;
    return;
  }
  w.runId = (typeof meta?.runId === "string" ? meta.runId : null) ?? /Run ID: (wf_[\w-]+)/.exec(text)?.[1] ?? w.runId;
  w.taskId = (typeof meta?.taskId === "string" ? meta.taskId : null) ?? /Task ID: (\w+)/.exec(text)?.[1] ?? w.taskId;
  if (typeof meta?.workflowName === "string" && meta.workflowName && w.name === "Workflow") w.name = meta.workflowName;
  const summary = typeof meta?.summary === "string" ? meta.summary : /Summary: ([^\n]+)/.exec(text)?.[1];
  if (summary && !w.description) w.description = summary;
  if (typeof meta?.scriptPath === "string") w.scriptPath = meta.scriptPath;
  else w.scriptPath ??= /Script file: ([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
}

/** Where a launched workflow keeps its agents' transcripts (from the launch result text). */
export function transcriptDirOf(text: string): string | null {
  return /Transcript dir: ([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Task-notification status words → the workflow's status. */
export function workflowNotified(w: WorkflowInfo, status: string, result: string | null, at: string): void {
  w.status = status === "completed" ? "done" : status === "killed" || status === "stopped" ? "stopped" : "failed";
  w.endedAt = at || w.endedAt;
  w.updatedAt = at || w.updatedAt;
  if (w.status === "failed") w.error = result ?? `Workflow ${status}`;
}

// ---------- the workflow's own files ----------

/** One agent as its transcript shows it. */
interface AgentFile {
  steps: AgentStep[];
  current: string | null;
  final: string | null;
  startedAt: string | null;
  lastAt: string | null;
  costUsd: number;
  label: string | null;
  phase: string | null;
}

/** What a workflow's files say: its journal, its agents, and the summary file once it ended. */
export interface WorkflowRun {
  journal: { agentId: string; label: string; phase: string; result?: unknown; failed?: string }[];
  agents: Map<string, AgentFile>;
  /** The summary file (status, phases, progress), once the workflow ended. */
  summary: any | null;
}

/** Cost of a transcript: each message once (Claude Code writes one line per content block, each with the usage). */
export function transcriptCost(raw: string): number {
  const byId = new Map<string, number>();
  let n = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== "assistant" || !ev.message?.usage) continue;
    const id = typeof ev.message.id === "string" ? ev.message.id : `#${n++}`;
    byId.set(id, messageCost(String(ev.message.model ?? ""), ev.message.usage));
  }
  let sum = 0;
  for (const c of byId.values()) sum += c;
  return sum;
}

/** Journal lines, skipping ones that can't be read (a half-written last line). */
export function parseJournal(raw: string): WorkflowRun["journal"] {
  const out = new Map<string, WorkflowRun["journal"][number]>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const id = typeof ev?.agentId === "string" ? ev.agentId : null;
    if (!id) continue;
    const row: WorkflowRun["journal"][number] = out.get(id) ?? { agentId: id, label: "", phase: "" };
    if (ev.type === "started") {
      if (typeof ev.label === "string") row.label = ev.label;
      if (typeof ev.phase === "string") row.phase = ev.phase;
    } else if (ev.type === "result") row.result = ev.result ?? null;
    else if (/error|fail/i.test(String(ev.type))) row.failed = typeof ev.error === "string" ? ev.error : typeof ev.message === "string" ? ev.message : "The agent failed";
    out.set(id, row);
  }
  return [...out.values()];
}

/** Reads workflow files, re-reading one only when its size/mtime change. */
export class WorkflowCache {
  private files = new Map<string, { key: string; value: any }>();

  private cached<T>(file: string, read: (raw: string) => T): T | null {
    let key: string;
    try {
      const s = statSync(file);
      key = `${s.size}:${s.mtimeMs}`;
    } catch {
      this.files.delete(file);
      return null;
    }
    const hit = this.files.get(file);
    if (hit && hit.key === key) return hit.value as T;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const value = read(raw);
    this.files.set(file, { key, value });
    return value;
  }

  /** A workflow's files (empty parts when they're missing). */
  load(sessionFile: string, runId: string): WorkflowRun {
    const base = sessionFile.replace(/\.jsonl$/, "");
    const dir = join(base, "subagents", "workflows", runId);
    const journal = this.cached(join(dir, "journal.jsonl"), parseJournal) ?? [];
    const summary = this.cached(join(base, "workflows", `${runId}.json`), (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null; // half-written: read again on the next change
      }
    });
    const agents = new Map<string, AgentFile>();
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const a = this.cached(join(dir, name), (raw) => {
        const t = parseAgentTranscript(raw);
        return { steps: t.steps, current: t.current, final: t.final, startedAt: t.startedAt, lastAt: t.lastAt, costUsd: transcriptCost(raw), label: null, phase: null } as AgentFile;
      });
      if (!a) continue;
      const meta = this.cached(join(dir, `agent-${m[1]}.meta.json`), (raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      });
      agents.set(m[1], {
        ...a,
        label: typeof meta?.description === "string" ? meta.description : null,
        phase: typeof meta?.workflowPhase === "string" ? meta.workflowPhase : null,
      });
    }
    return { journal, agents, summary };
  }

  /** Change marker for a session's workflow files ("" when there are none). */
  version(sessionFile: string): string {
    const base = sessionFile.replace(/\.jsonl$/, "");
    let size = 0, mtime = 0, n = 0;
    const add = (dir: string, deep: boolean) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = join(dir, name);
        try {
          const s = statSync(p);
          if (s.isDirectory()) {
            if (deep) add(p, false);
            continue;
          }
          size += s.size;
          mtime = Math.max(mtime, s.mtimeMs);
          n++;
        } catch {}
      }
    };
    add(join(base, "subagents", "workflows"), true);
    add(join(base, "workflows"), false);
    return n ? `${n}:${size}:${mtime}` : "";
  }
}

/** Total cost of a workflow's agents, from the transcripts in its folder (for the run's spending cap). */
export function workflowDirCost(dir: string, cache = new Map<string, { key: string; cost: number }>()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of names) {
    if (!/^agent-.+\.jsonl$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const s = statSync(file);
      const key = `${s.size}:${s.mtimeMs}`;
      let hit = cache.get(file);
      if (!hit || hit.key !== key) {
        hit = { key, cost: transcriptCost(readFileSync(file, "utf8")) };
        cache.set(file, hit);
      }
      sum += hit.cost;
    } catch {}
  }
  return sum;
}

const ms = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null);

/** Progress states (stream and summary file) → a row's status. */
export function progressStatus(state: unknown): WorkflowAgentStatus {
  const s = String(state ?? "").toLowerCase();
  if (s === "done" || s === "completed" || s === "success") return "done";
  if (/fail|error/.test(s)) return "failed";
  if (/kill|stop|cancel|abort|skip/.test(s)) return "stopped";
  if (s === "queued" || s === "pending" || s === "waiting") return "waiting";
  return "running";
}

function resultString(r: unknown): string | null {
  if (r === null || r === undefined) return null;
  if (typeof r === "string") return r;
  try {
    return "```json\n" + JSON.stringify(r, null, 2) + "\n```";
  } catch {
    return String(r);
  }
}

/**
 * The parent's view filled in with the workflow's files and the latest live progress (stream task_progress), which
 * lists agents that haven't started yet too. Files missing or half-written: what is known shows, the rest is skipped.
 */
export function withRun(w: WorkflowInfo, run: WorkflowRun | null, progress?: any[] | null): WorkflowInfo {
  const out: WorkflowInfo = { ...w, phases: [...w.phases], agents: [] };
  const summary = run?.summary ?? null;
  const live = Array.isArray(summary?.workflowProgress) ? summary.workflowProgress : Array.isArray(progress) ? progress : null;
  if (Array.isArray(summary?.phases)) {
    const titles = summary.phases.map((p: any) => (typeof p?.title === "string" ? p.title : null)).filter(Boolean) as string[];
    if (titles.length) out.phases = titles;
  } else if (live) {
    const titles = live.filter((p: any) => p?.type === "workflow_phase" && typeof p.title === "string").map((p: any) => p.title as string);
    if (titles.length) out.phases = titles;
  }
  if (typeof summary?.workflowName === "string" && out.name === "Workflow") out.name = summary.workflowName;
  if (typeof summary?.summary === "string" && !out.description) out.description = summary.summary;

  const rows = new Map<string, WorkflowAgent>();
  const order: WorkflowAgent[] = [];
  const add = (a: WorkflowAgent) => {
    if (a.agentId) rows.set(a.agentId, a);
    order.push(a);
  };
  const file = (id: string | null) => (id ? run?.agents.get(id) : undefined);
  const fromFile = (a: WorkflowAgent) => {
    const f = file(a.agentId);
    if (!f) return;
    a.costUsd = f.costUsd;
    a.stepCount = f.steps.length;
    a.startedAt ??= f.startedAt;
    a.updatedAt = f.lastAt ?? a.updatedAt;
    if (a.status === "running") a.current = f.current;
    if (a.status === "done" && !a.endedAt) a.endedAt = f.lastAt;
  };
  if (live) {
    for (const p of live) {
      if (p?.type !== "workflow_agent") continue;
      const id = typeof p.agentId === "string" ? p.agentId : null;
      const status = progressStatus(p.state);
      const started = ms(p.startedAt);
      const dur = typeof p.durationMs === "number" && p.durationMs > 0 ? p.durationMs : null;
      add({
        agentId: id, label: String(p.label ?? "Agent"), phase: typeof p.phaseTitle === "string" ? p.phaseTitle : "",
        status, startedAt: status === "waiting" ? null : started, endedAt: status !== "running" && status !== "waiting" && started && dur ? new Date(Date.parse(started) + dur).toISOString() : null,
        updatedAt: ms(p.lastProgressAt), costUsd: 0, current: null, stepCount: 0,
      });
    }
  }
  // The journal knows every agent that started, also between progress updates.
  for (const j of run?.journal ?? []) {
    const known = rows.get(j.agentId);
    const status: WorkflowAgentStatus = j.failed ? "failed" : "result" in j ? "done" : "running";
    if (known) {
      // The journal is written as things happen; progress may lag behind it.
      if ((known.status === "running" || known.status === "waiting") && status !== "running") known.status = status;
      if (!known.label && j.label) known.label = j.label;
      if (!known.phase && j.phase) known.phase = j.phase;
      continue;
    }
    add({ agentId: j.agentId, label: j.label || "Agent", phase: j.phase, status, startedAt: null, endedAt: null, updatedAt: null, costUsd: 0, current: null, stepCount: 0 });
  }
  // Transcripts with no journal line yet (its line is still being written).
  for (const [id, f] of run?.agents ?? []) {
    if (rows.has(id)) continue;
    add({ agentId: id, label: f.label ?? "Agent", phase: f.phase ?? "", status: "running", startedAt: null, endedAt: null, updatedAt: null, costUsd: 0, current: null, stepCount: 0 });
  }
  for (const a of order) fromFile(a);

  // The workflow's own end: the summary file, else the parent's notification.
  if (summary && typeof summary.status === "string") {
    const s = progressStatus(summary.status);
    if (s !== "running" && s !== "waiting") {
      out.status = s;
      const start = Date.parse(out.startedAt);
      out.endedAt ??= typeof summary.durationMs === "number" && Number.isFinite(start) ? new Date(start + summary.durationMs).toISOString() : ms(Date.parse(summary.timestamp ?? ""));
    }
  }
  if (out.status !== "running") {
    // Nothing runs once the workflow ended: rows still open were cut off.
    for (const a of order) {
      if (a.status === "running" || a.status === "waiting") {
        a.status = "stopped";
        a.current = null;
      }
    }
  }

  // Phases the script didn't list (or no meta at all): in the order their agents appear.
  for (const a of order) if (!out.phases.includes(a.phase)) out.phases.push(a.phase);
  out.agents = order;
  out.costUsd = order.reduce((s, a) => s + a.costUsd, 0);
  const last = order.map((a) => a.updatedAt).filter((t): t is string => !!t).sort().at(-1);
  if (last && last > out.updatedAt) out.updatedAt = last;
  return out;
}

/** One agent in full (steps and result), or null when the workflow has no such agent. */
export function workflowAgentDetail(w: WorkflowInfo, run: WorkflowRun | null, agentId: string): WorkflowAgentDetail | null {
  const a = w.agents.find((x) => x.agentId === agentId);
  if (!a) return null;
  const f = run?.agents.get(agentId);
  const j = run?.journal.find((x) => x.agentId === agentId);
  const result = j && "result" in j ? resultString(j.result) : a.status === "done" ? f?.final ?? null : j?.failed ?? null;
  return { ...a, steps: f?.steps ?? [], result };
}

/** No word from a running workflow for this long while the ticket isn't running: it was cut off. */
export const WORKFLOW_STALE_MS = 60_000;

/** Shown as stopped instead of spinning forever once its run is gone and it went quiet. */
export function settleWorkflow(w: WorkflowInfo, runActive: boolean, now = Date.now()): WorkflowInfo {
  if (w.status !== "running" || runActive) return w;
  const last = Date.parse(w.updatedAt);
  if (Number.isFinite(last) && now - last < WORKFLOW_STALE_MS) return w;
  return {
    ...w, status: "stopped",
    agents: w.agents.map((a) => (a.status === "running" || a.status === "waiting" ? { ...a, status: "stopped" as const, current: null } : a)),
  };
}

/** The script, for "Show script": inline in the call, else the summary file, else the file it was saved to. */
export function workflowScript(w: WorkflowInfo, run: WorkflowRun | null): string | null {
  if (w.script) return w.script;
  if (typeof run?.summary?.script === "string") return run.summary.script;
  if (w.scriptPath) {
    try {
      return readFileSync(w.scriptPath, "utf8");
    } catch {}
  }
  return null;
}
