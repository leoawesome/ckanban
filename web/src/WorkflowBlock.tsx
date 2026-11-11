import { useEffect, useState } from "react";
import { api, type SessionEntry, type WorkflowAgent, type WorkflowAgentDetail, type WorkflowAgentStatus, type WorkflowInfo } from "./api";
import { duration, fullTime } from "./time";
import { toast } from "./toast";
import { ToolRow } from "./ToolRows";
import { ClaudeFace } from "./ConvTurn";
import { Markdown } from "./Transcript";
import { costText } from "./usage";

/** Agent rows and scripts the user opened; module-level so they stay open across live refreshes. */
const opened = new Set<string>();
const scripts = new Set<string>();

const STATUS_LABEL: Record<WorkflowAgentStatus, string> = { waiting: "waiting", running: "running", done: "done", failed: "failed", stopped: "stopped" };
/** Waiting agents in a phase beyond this many fold into one "N more waiting" row. */
const WAITING_SHOWN = 2;

/** Workflows Claude started in a row of the conversation, one block each. */
export function WorkflowBlocks({ slug, ticketId, items, old }: { slug: string; ticketId: string; items: SessionEntry[]; old: boolean }) {
  return (
    <div className={`workflows${old ? " inherited" : ""}`}>
      {items.map((e) => e.workflow && <WorkflowBlock key={e.uuid} slug={slug} ticketId={ticketId} w={e.workflow} />)}
    </div>
  );
}

/** "3 of 7 helper agents done" plus how many failed or stopped. */
export function workflowCounts(w: WorkflowInfo): { done: number; ended: number; total: number } {
  const done = w.agents.filter((a) => a.status === "done").length;
  const ended = w.agents.filter((a) => a.status === "done" || a.status === "failed" || a.status === "stopped").length;
  return { done, ended, total: w.agents.length };
}

function WorkflowBlock({ slug, ticketId, w }: { slug: string; ticketId: string; w: WorkflowInfo }) {
  const running = w.status === "running";
  const now = useTicker(running);
  const [showScript, setShowScript] = useState(() => scripts.has(w.toolUseId));
  const [script, setScript] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const { done, ended, total } = workflowCounts(w);
  const time = duration(w.startedAt, w.endedAt ? new Date(w.endedAt).getTime() : running ? now : new Date(w.updatedAt).getTime());
  const pct = total ? Math.round((ended / total) * 100) : 0;

  useEffect(() => {
    if (!showScript || script !== null) return;
    api.workflowScript(slug, ticketId, w.toolUseId).then((r) => setScript(r.script)).catch((e) => setScript(`Couldn't load the script: ${(e as Error).message}`));
  }, [showScript]);

  const toggleScript = () => {
    if (showScript) scripts.delete(w.toolUseId);
    else scripts.add(w.toolUseId);
    setShowScript(!showScript);
  };
  const stop = () => {
    setStopping(true);
    api.stopWorkflow(slug, ticketId, w.toolUseId)
      .then((r) => toast(r.stopped === "workflow" ? "Workflow stopped. The run goes on." : `Claude Code couldn't stop just the workflow${r.error ? ` (${r.error})` : ""}, so the whole run stopped.`))
      .catch((e) => toast(`Couldn't stop the workflow: ${(e as Error).message}`, { tone: "error" }))
      .finally(() => setStopping(false));
  };

  return (
    <div className={`workflow ${w.status}`}>
      <div className="wf-head">
        <StatusIcon status={w.status} />
        <span className="wf-name">{w.name}</span>
        <span className={`agent-pill ${w.status}`}>{w.status === "running" ? "running" : w.status}</span>
        <span className="wf-meta" title={`Started ${fullTime(w.startedAt)}`}>
          {total ? `${done} of ${total} helper agents done` : running ? "Starting…" : "No helper agents"} · {time} · {costText(w.costUsd)}{running ? " so far" : ""}
        </span>
      </div>
      {w.description && <div className="wf-desc">{w.description}</div>}
      <div className="wf-bar" aria-label={`${pct}% of helper agents finished`}><i style={{ width: `${pct}%` }} /></div>
      {w.error && <div className="agent-result error wf-error">{w.error}</div>}
      <div className="wf-phases">
        {w.phases.map((p) => <Phase key={p || "-"} slug={slug} ticketId={ticketId} w={w} title={p} agents={w.agents.filter((a) => a.phase === p)} now={now} />)}
      </div>
      {showScript && <pre className="wf-script">{script ?? "Loading…"}</pre>}
      <div className="wf-foot">
        <button className="btn small" onClick={toggleScript}>{showScript ? "Hide script" : "Show script"}</button>
        {running && w.taskId && <button className="btn small" onClick={stop} disabled={stopping}>{stopping ? "Stopping…" : "Stop workflow"}</button>}
        {total > 0 && <span className="wf-hint">Click a helper agent to see what it did</span>}
      </div>
    </div>
  );
}

function Phase({ slug, ticketId, w, title, agents, now }: { slug: string; ticketId: string; w: WorkflowInfo; title: string; agents: WorkflowAgent[]; now: number }) {
  const done = agents.filter((a) => a.status === "done").length;
  const active = agents.some((a) => a.status === "running");
  const waiting = agents.filter((a) => a.status === "waiting");
  const folded = waiting.length > WAITING_SHOWN ? waiting.slice(WAITING_SHOWN) : [];
  const shown = agents.filter((a) => !folded.includes(a));
  const allDone = agents.length > 0 && done === agents.length;
  return (
    <div className="wf-phase">
      <div className="wf-ph">
        <span className={`wf-ph-icon${allDone ? " done" : active ? " running" : ""}`} aria-hidden>{allDone ? "✓" : active ? "●" : "○"}</span>
        {title || "Helper agents"}
        <span className="wf-ph-count">{agents.length ? `${done} of ${agents.length} done` : "not started"}</span>
      </div>
      {shown.map((a, i) => <AgentLine key={a.agentId ?? `${title}:${i}`} slug={slug} ticketId={ticketId} w={w} a={a} now={now} />)}
      {folded.length > 0 && (
        <div className="wf-ag wf-more"><span className="agent-pill waiting">waiting</span>{folded.length} more</div>
      )}
    </div>
  );
}

function AgentLine({ slug, ticketId, w, a, now }: { slug: string; ticketId: string; w: WorkflowInfo; a: WorkflowAgent; now: number }) {
  const key = `${w.toolUseId}/${a.agentId}`;
  const [open, setOpen] = useState(() => !!a.agentId && opened.has(key));
  const [detail, setDetail] = useState<WorkflowAgentDetail | null>(null);
  const running = a.status === "running";
  // Loaded when opened, and again while the agent keeps working or once it ends.
  useEffect(() => {
    if (!open || !a.agentId) return;
    api.workflowAgent(slug, ticketId, w.toolUseId, a.agentId).then(setDetail).catch(() => {});
  }, [open, a.stepCount, a.status]);

  const toggle = () => {
    if (!a.agentId) return;
    if (open) opened.delete(key);
    else opened.add(key);
    setOpen(!open);
  };
  const end = a.endedAt ? new Date(a.endedAt).getTime() : running ? now : a.updatedAt ? new Date(a.updatedAt).getTime() : null;
  const time = a.startedAt && end ? duration(a.startedAt, end) : null;
  const right = [time, a.costUsd > 0 || a.status === "done" ? costText(a.costUsd) : null].filter(Boolean).join(" · ");
  return (
    <>
      <div className={`wf-ag${a.agentId ? " openable" : ""}${open ? " open" : ""}`} onClick={toggle} role={a.agentId ? "button" : undefined}
        tabIndex={a.agentId ? 0 : undefined} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
        <span className={`agent-pill ${a.status}`}>{STATUS_LABEL[a.status]}</span>
        <span className="wf-ag-label">{a.label}</span>
        {running && a.current && !open && <span className="wf-ag-now" title={a.current}>{a.current}</span>}
        {right && <span className="wf-ag-meta">{right}</span>}
      </div>
      {open && (
        <div className="wf-ag-body">
          {!detail ? <div className="agent-empty">Loading…</div> : (
            <>
              {detail.result ? (
                <div className={`agent-result${a.status === "failed" ? " error" : ""}`}><h6>{a.status === "failed" ? "Error" : "Result"}</h6><Markdown text={detail.result} /></div>
              ) : detail.steps.length > 0 ? (
                <ul className="agent-steps">
                  {detail.steps.map((s, i) => s.kind === "text"
                    ? <li key={i} className="txt">{s.text}</li>
                    : (
                      <li key={i} className="tool">
                        <ToolRow slug={slug} ticketId={ticketId} live={running}
                          item={{ key: s.id ?? `${key}:${i}`, label: s.text, toolUseId: s.id, error: s.error, current: running && i === detail.steps.length - 1 && s.text === a.current }} />
                      </li>
                    ))}
                </ul>
              ) : (
                <div className="agent-empty">{running ? "Starting…" : a.status === "stopped" ? "It stopped before it did anything." : "No steps recorded."}</div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** A running workflow shows Claude's working face; finished ones keep their mark. */
function StatusIcon({ status }: { status: WorkflowInfo["status"] }) {
  if (status === "running") return <span className="agent-icon face" role="img" aria-label="running"><ClaudeFace mood="working" size={16} /></span>;
  return <span className={`agent-icon ${status}`} aria-hidden>{status === "done" ? "✓" : status === "failed" ? "✕" : "■"}</span>;
}

/** Ticks every second while `on`, for the running timers. */
function useTicker(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
