// Workflows (the Workflow tool, ultracode): reading their files into the chat block, the ultracode switch,
// stopping one, and the spending cap counting their helper agents.
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, WORKFLOW_STOPPED_TEXT } from "../src/server/board";
import { EFFORTS, runOptions, validEffort } from "../src/server/commands";
import { buildArgs } from "../src/server/runner";
import { parseSession, SessionCache } from "../src/server/session";
import {
  parseJournal, parseWorkflowMeta, settleWorkflow, transcriptCost, withRun, workflowAgentDetail, workflowDirCost, WorkflowCache, workflowScript,
  type WorkflowInfo,
} from "../src/server/workflows";
import { FAKE, board, bus, readArgs, replays, setBoard, setup, store, useBoardEnv } from "./board-env";
import { tempDir, until } from "./helpers";

useBoardEnv();

const L = (o: unknown) => JSON.stringify(o);
const SCRIPT = `export const meta = {
  name: 'audit-auth-routes',
  description: 'Review each route folder, verify each finding',
  phases: [
    { title: 'Review', detail: 'one agent per folder' },
    { title: "Verify", detail: "one agent per finding" },
  ],
}
const x = phase('Review')`;

const call = (at: string, input: object = { script: SCRIPT }) =>
  L({ type: "assistant", uuid: "a1", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "tu_wf", name: "Workflow", input }] } });
const launched = (at: string, dir = "/x/subagents/workflows/wf_1") =>
  L({
    type: "user", uuid: "u2", timestamp: at,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_wf", content: `Workflow launched in background. Task ID: wtask\nSummary: s\nTranscript dir: ${dir}\nRun ID: wf_1` }] },
    toolUseResult: { status: "async_launched", taskId: "wtask", runId: "wf_1", workflowName: "audit-auth-routes", summary: "s" },
  });
const notification = (at: string, status: string) =>
  L({ type: "queue-operation", operation: "enqueue", timestamp: at, content: `<task-notification>\n<task-id>wtask</task-id>\n<tool-use-id>tu_wf</tool-use-id>\n<status>${status}</status>\n<summary>Dynamic workflow done</summary>\n<result>ok</result>\n</task-notification>` });
const agentLine = (id: string, at: string, input: number, text = "done", stop: string | null = "end_turn") =>
  L({ type: "assistant", timestamp: at, message: { id: `m_${id}_${at}`, model: "claude-opus-5-5", stop_reason: stop, content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: 0 } } });

test("parseWorkflowMeta: name, description and phase titles in script order; a phase's own text isn't the workflow's", () => {
  expect(parseWorkflowMeta(SCRIPT)).toEqual({ name: "audit-auth-routes", description: "Review each route folder, verify each finding", phases: ["Review", "Verify"] });
  expect(parseWorkflowMeta("export const meta = { phases: [{ title: 'Only', description: 'not mine' }], name: 'n' }"))
    .toEqual({ name: "n", description: null, phases: ["Only"] });
  expect(parseWorkflowMeta("const a = 1")).toEqual({ name: null, description: null, phases: [] });
  // Cut off mid-script: what is there still reads.
  expect(parseWorkflowMeta("export const meta = { name: 'half', phases: [{ title: 'A' }").phases).toEqual(["A"]);
});

test("parseSession: a Workflow call becomes a workflow entry; launch gives its ids, the queued notification ends it", () => {
  const s = parseSession([call("2026-11-01T01:00:00Z"), launched("2026-11-01T01:00:01Z"), notification("2026-11-01T01:05:00Z", "completed")].join("\n"));
  expect(s.entries.map((e) => e.kind)).toEqual(["workflow"]);
  const w = s.entries[0].workflow!;
  expect(w).toMatchObject({
    toolUseId: "tu_wf", runId: "wf_1", taskId: "wtask", name: "audit-auth-routes", phases: ["Review", "Verify"],
    status: "done", startedAt: "2026-11-01T01:00:00Z", endedAt: "2026-11-01T01:05:00Z",
  });
  // A script saved to a file (scriptPath): the name comes from the launch result.
  const p = parseSession([call("2026-11-01T01:00:00Z", { scriptPath: "/tmp/x.js" }), launched("2026-11-01T01:00:01Z")].join("\n"));
  expect(p.entries[0].workflow).toMatchObject({ name: "audit-auth-routes", status: "running", scriptPath: "/tmp/x.js" });
  // A call that failed to start.
  const f = parseSession([call("2026-11-01T01:00:00Z"), L({ type: "user", timestamp: "2026-11-01T01:00:01Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_wf", is_error: true, content: "Script error: phase() needs a title" }] } })].join("\n"));
  expect(f.entries[0].workflow).toMatchObject({ status: "failed", error: "Script error: phase() needs a title" });
  // Killed by stop_task.
  const k = parseSession([call("2026-11-01T01:00:00Z"), launched("2026-11-01T01:00:01Z"), notification("2026-11-01T01:01:00Z", "killed")].join("\n"));
  expect(k.entries[0].workflow!.status).toBe("stopped");
});

test("parseJournal and transcriptCost skip half-written lines and count each message once", () => {
  const j = parseJournal([
    L({ type: "launched" }),
    L({ type: "started", agentId: "a1", label: "review: contacts", phase: "Review" }),
    L({ type: "result", agentId: "a1", result: { bugs: 2 } }),
    L({ type: "started", agentId: "a2", label: "review: billing", phase: "Review" }),
    '{"type":"result","agentId":"a2","res',
  ].join("\n"));
  expect(j).toEqual([{ agentId: "a1", label: "review: contacts", phase: "Review", result: { bugs: 2 } }, { agentId: "a2", label: "review: billing", phase: "Review" }]);
  // Opus 5.5: $4 per million input tokens; the same message written twice (one line per block) counts once.
  const raw = [agentLine("a", "t1", 10_000, "x", null), agentLine("a", "t1", 10_000), agentLine("a", "t2", 5_000), '{"type":"assis'].join("\n");
  expect(transcriptCost(raw)).toBeCloseTo(0.06, 6);
});

/** A session file plus a workflow folder like Claude Code writes them. */
function workflowSession() {
  const configDir = tempDir("ck-wf-");
  const projects = join(configDir, "projects", "-tmp-proj");
  const file = join(projects, "sess.jsonl");
  const dir = join(projects, "sess", "subagents", "workflows", "wf_1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [call("2026-11-01T01:00:00Z"), launched("2026-11-01T01:00:01Z", dir)].join("\n") + "\n");
  const journal = (o: object) => appendFileSync(join(dir, "journal.jsonl"), L(o) + "\n");
  const agent = (id: string, label: string, phase: string, lines: string[]) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), L({ agentType: "workflow-subagent", description: label, workflowPhase: phase }));
    writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join("\n") + "\n");
  };
  return { configDir, projects, file, dir, journal, agent };
}

test("SessionCache: a workflow's journal and agent transcripts fill in its block (live), its summary file ends it", () => {
  const f = workflowSession();
  const cache = new SessionCache({ configDir: f.configDir });
  const get = () => cache.get("sess")!.entries[0].workflow!;
  // Launched, nothing written yet: no agents, still running.
  expect(get()).toMatchObject({ status: "running", agents: [], costUsd: 0 });

  f.journal({ type: "launched" });
  f.journal({ type: "started", agentId: "a1", label: "review: contacts", phase: "Review" });
  f.journal({ type: "started", agentId: "a2", label: "review: billing", phase: "Review" });
  f.agent("a1", "review: contacts", "Review", [agentLine("a1", "2026-11-01T01:00:05Z", 50_000, "2 findings")]);
  f.agent("a2", "review: billing", "Review", [L({ type: "assistant", timestamp: "2026-11-01T01:00:06Z", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "auth" } }], usage: { input_tokens: 25_000, output_tokens: 0 } } })]);
  f.journal({ type: "result", agentId: "a1", result: { findings: 2 } });
  appendFileSync(join(f.dir, "journal.jsonl"), '{"type":"started","agentId":"a3"'); // half-written line
  let w = get();
  expect(w.status).toBe("running");
  expect(w.agents.map((a) => [a.label, a.phase, a.status])).toEqual([["review: contacts", "Review", "done"], ["review: billing", "Review", "running"]]);
  expect(w.agents[0].costUsd).toBeCloseTo(0.2, 6);
  expect(w.agents[1]).toMatchObject({ current: "Grep: auth", stepCount: 1 });
  expect(w.costUsd).toBeCloseTo(0.3, 6);
  // The Verify phase has no agents yet but still shows, in script order.
  expect(w.phases).toEqual(["Review", "Verify"]);

  // The agent's full view: its result (an object shows as JSON), steps for one still working.
  const run = cache.workflowRun("sess", "wf_1");
  expect(workflowAgentDetail(w, run, "a1")!.result).toContain('"findings": 2');
  expect(workflowAgentDetail(w, run, "a2")!.steps.map((s) => s.text)).toEqual(["Grep: auth"]);
  expect(workflowAgentDetail(w, run, "nope")).toBeNull();

  // The summary file (written when it ends): its status and phases win, rows still open are stopped.
  const base = join(f.projects, "sess", "workflows");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "wf_1.json"), '{"runId":"wf_1","status":"comp'); // half-written: ignored
  expect(get().status).toBe("running");
  writeFileSync(join(base, "wf_1.json"), L({ runId: "wf_1", status: "failed", durationMs: 60_000, script: SCRIPT, phases: [{ title: "Review" }, { title: "Verify" }] }));
  w = get();
  expect(w.status).toBe("failed");
  expect(w.endedAt).toBe("2026-11-01T01:01:00.000Z");
  expect(w.agents.map((a) => a.status)).toEqual(["done", "stopped"]);
  expect(workflowScript({ ...w, script: null }, cache.workflowRun("sess", "wf_1"))).toBe(SCRIPT);
});

test("withRun: live progress lists waiting agents too; the journal moves rows on when progress lags", () => {
  const w: WorkflowInfo = {
    toolUseId: "tu", runId: "wf_1", taskId: "t", name: "x", description: "", phases: ["Review", "Verify"], status: "running",
    startedAt: "2026-11-01T01:00:00Z", endedAt: null, updatedAt: "2026-11-01T01:00:00Z", agents: [], costUsd: 0, error: null,
  };
  const progress = [
    { type: "workflow_phase", index: 1, title: "Review" }, { type: "workflow_phase", index: 2, title: "Verify" },
    { type: "workflow_agent", label: "r1", phaseTitle: "Review", agentId: "a1", state: "progress", startedAt: Date.parse("2026-11-01T01:00:01Z") },
    { type: "workflow_agent", label: "v1", phaseTitle: "Verify", state: "queued" },
    { type: "workflow_agent", label: "v2", phaseTitle: "Verify", state: "queued" },
  ];
  const run = { journal: [{ agentId: "a1", label: "r1", phase: "Review", result: "ok" }], agents: new Map(), summary: null };
  const out = withRun(w, run, progress);
  expect(out.agents.map((a) => [a.label, a.status])).toEqual([["r1", "done"], ["v1", "waiting"], ["v2", "waiting"]]);
  expect(out.agents[0].startedAt).toBe("2026-11-01T01:00:01.000Z");
  // No files at all: what the call said still shows.
  expect(withRun(w, null)).toMatchObject({ agents: [], phases: ["Review", "Verify"], status: "running" });
});

test("settleWorkflow: a running workflow whose run is gone and went quiet shows as stopped", () => {
  const w: WorkflowInfo = {
    toolUseId: "tu", runId: null, taskId: null, name: "x", description: "", phases: [""], status: "running",
    startedAt: "2026-11-01T01:00:00Z", endedAt: null, updatedAt: "2026-11-01T01:00:00Z", costUsd: 0, error: null,
    agents: [{ agentId: "a", label: "a", phase: "", status: "running", startedAt: null, endedAt: null, updatedAt: null, costUsd: 0, current: "Bash: ls", stepCount: 1 }],
  };
  const now = Date.parse("2026-11-01T01:10:00Z");
  expect(settleWorkflow(w, true, now).status).toBe("running");
  const s = settleWorkflow(w, false, now);
  expect(s.status).toBe("stopped");
  expect(s.agents[0]).toMatchObject({ status: "stopped", current: null });
  expect(settleWorkflow(w, false, Date.parse("2026-11-01T01:00:30Z")).status).toBe("running");
});

test("workflowDirCost adds up every agent transcript in the folder; a missing folder costs nothing", () => {
  const f = workflowSession();
  f.agent("a1", "x", "R", [agentLine("a1", "t1", 10_000)]);
  f.agent("a2", "y", "R", [agentLine("a2", "t1", 15_000)]);
  writeFileSync(join(f.dir, "journal.jsonl"), L({ type: "launched" }) + "\n");
  expect(workflowDirCost(f.dir)).toBeCloseTo(0.1, 6);
  expect(workflowDirCost(join(f.dir, "missing"))).toBe(0);
  expect(new WorkflowCache().version(f.file)).not.toBe("");
});

const ULTRA = `--settings ${JSON.stringify({ ultracode: true })}`;

test("ultracode is its own switch next to the effort level; only a ticket's own work turns it on", () => {
  expect(EFFORTS).not.toContain("ultracode");
  expect(validEffort("ultracode")).toBe(false);
  // Any level with ultracode on, the ticket over the board.
  expect(runOptions({ effort: "medium", ultracode: true }, null, true)).toEqual({ effort: "medium", ultracode: true });
  expect(runOptions({ effort: null, ultracode: null }, { effort: "high", ultracode: true }, true)).toEqual({ effort: "high", ultracode: true });
  expect(runOptions({ ultracode: false }, { ultracode: true }, true).ultracode).toBe(false);
  // Planning and quick chats: never.
  expect(runOptions({ effort: "medium", ultracode: true }, null, false)).toEqual({ effort: "medium", ultracode: false });
  // The first version saved "ultracode" as the effort: xhigh with ultracode on.
  expect(runOptions({ effort: "ultracode" }, null, true)).toEqual({ effort: "xhigh", ultracode: true });
  expect(runOptions(null, { effort: "ultracode" }, false)).toEqual({ effort: "xhigh", ultracode: false });
  const args = buildArgs("s", false, null, [], undefined, undefined, null, "medium", true).join(" ");
  expect(args).toContain("--effort medium");
  expect(args).toContain(ULTRA);
  expect(buildArgs("s", false, null, [], undefined, undefined, null, "medium").join(" ")).not.toContain("--settings");
});

test("/effort medium + /effort ultracode: work runs get both, Planning chats only the effort; /effort ultracode off and default", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Big audit", body: "audit", status: "backlog", mode: "auto" });
  await board.chat("p", t.id, "/effort medium");
  await board.chat("p", t.id, "/effort ultracode");
  await board.whenIdle();
  expect(store.getTicket("p", t.id)).toMatchObject({ effort: "medium", ultracode: true });
  expect(store.getTicket("p", t.id)!.notice).toStartWith("Ultracode on for this ticket");
  await board.chat("p", t.id, "/effort");
  expect(store.getTicket("p", t.id)!.notice).toStartWith("This ticket uses effort medium, ultracode on.");
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const work = readArgs().at(-1)!.args.join(" ");
  expect(work).toContain("--effort medium");
  expect(work).toContain(ULTRA);

  await board.chat("p", t.id, "/effort ultracode off");
  expect(store.getTicket("p", t.id)).toMatchObject({ effort: "medium", ultracode: false });
  await board.chat("p", t.id, "/effort default");
  expect(store.getTicket("p", t.id)).toMatchObject({ effort: null, ultracode: null });

  // A board with ultracode on: its Planning chats keep the effort but never get ultracode.
  const p2 = store.getProfile("p")!;
  store.saveProfile({ ...p2, effort: "low", ultracode: true });
  const plan = await board.createTicket("p", { title: "Plan it", body: "x", status: "planning" });
  await board.whenIdle();
  const last = readArgs().at(-1)!;
  expect(last.prompt).toContain("Plan it");
  expect(last.args.join(" ")).toContain("--effort low");
  expect(last.args.join(" ")).not.toContain("--settings");
  expect(store.getTicket("p", plan.id)!.status).toBe("planning");
});

test("the first version's /effort ultracode (saved as the effort) still runs as xhigh with ultracode on", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Old", body: "x", status: "backlog", mode: "auto" });
  store.updateTicket("p", t.id, { effort: "ultracode" });
  await board.updateTicket("p", t.id, { status: "ready" });
  await board.whenIdle();
  const work = readArgs().at(-1)!.args.join(" ");
  expect(work).toContain("--effort xhigh");
  expect(work).toContain(ULTRA);
  // Picking a level keeps ultracode on.
  await board.chat("p", t.id, "/effort medium");
  expect(store.getTicket("p", t.id)).toMatchObject({ effort: "medium", ultracode: true });
});

test("a capped run stops once its workflow's helper agents push it past the cap, and says so", async () => {
  const p = await setup();
  store.saveProfile({ ...p, runCapUsd: 0.1 });
  setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, capPollMs: 20 }));
  process.env.FAKE_MODE = "workflow";
  process.env.FAKE_WF_DIR = tempDir("ck-wfdir-");
  process.env.FAKE_WF_AGENTS = "40";
  process.env.FAKE_WF_STEP_MS = "30";
  try {
    const t = await board.createTicket("p", { title: "Capped workflow", body: "desc", status: "ready" });
    await board.whenIdle();
    const got = store.getTicket("p", t.id)!;
    expect(got).toMatchObject({ status: "review", outcome: "blocked", error: "Stopped at $0.10 cap", capHit: { capUsd: 0.1 } });
    const note = store.listComments("p", t.id).at(-1)!.text;
    expect(note).toStartWith("Stopped at $0.10 cap: this run and its workflow's helper agents spent $");
    // It stopped early: far fewer than the 40 agents got to run.
    const spent = workflowDirCost(`${process.env.FAKE_WF_DIR}/subagents/workflows/wf_fake`);
    expect(spent).toBeGreaterThanOrEqual(0.08);
    expect(spent).toBeLessThan(0.4);
  } finally {
    delete process.env.FAKE_WF_DIR;
    delete process.env.FAKE_WF_AGENTS;
    delete process.env.FAKE_WF_STEP_MS;
  }
});

test("Stop workflow stops just the workflow and the run goes on; a CLI that can't stops the whole run", async () => {
  await setup();
  process.env.FAKE_WF_DIR = tempDir("ck-wfdir-");
  process.env.FAKE_WF_AGENTS = "200";
  process.env.FAKE_WF_STEP_MS = "20";
  try {
    process.env.FAKE_MODE = "workflow";
    const t = await board.createTicket("p", { title: "Stop me", body: "x", status: "ready" });
    await until(() => board.isRunning("p", t.id) && store.readActivity("p", t.id).some((a: any) => (a.event ?? a)?.subtype === "task_progress"));
    expect(board.workflowProgress("p", t.id, "tu_wf")).not.toBeNull();
    expect(await board.stopWorkflow("p", t.id, "wtask1")).toEqual({ stopped: "workflow" });
    await board.whenIdle();
    expect(store.getTicket("p", t.id)!.outcome).toBe("done");
    expect(store.listComments("p", t.id).some((c) => c.text === "Workflow stopped by user. The run goes on.")).toBe(true);
    expect(replays(t.id)).toContain(WORKFLOW_STOPPED_TEXT);

    process.env.FAKE_MODE = "workflow-nostop";
    const u = await board.createTicket("p", { title: "Can't stop just it", body: "x", status: "ready" });
    await until(() => board.isRunning("p", u.id) && store.readActivity("p", u.id).some((a: any) => (a.event ?? a)?.subtype === "task_progress"));
    const r = await board.stopWorkflow("p", u.id, "wtask1");
    expect(r.stopped).toBe("run");
    await board.whenIdle();
    expect(store.getTicket("p", u.id)!.outcome).toBe("stopped");
    await expect(board.stopWorkflow("p", u.id, "wtask1")).rejects.toThrow("isn't running");
  } finally {
    delete process.env.FAKE_WF_DIR;
    delete process.env.FAKE_WF_AGENTS;
    delete process.env.FAKE_WF_STEP_MS;
  }
});
