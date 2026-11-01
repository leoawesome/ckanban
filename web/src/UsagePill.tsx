import { useEffect, useRef, useState } from "react";
import { useLayer } from "./layers";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { runStatusText } from "./boardStats";
import { costText, limitNote, resetText, shortLabel, usageTone, worstTone } from "./usage";
import type { UsageState } from "./useUsage";

/** What the status pill says about the board shown; null until its tickets have loaded. */
export interface BoardRuns {
  runs: number;
  /** Runs holding one of the board's run slots, and how many slots it has. */
  slots: number;
  maxParallel: number;
  queued: number;
  /** Huddle agents working (outside the slots). */
  agents: number;
  /** The Mac is kept awake until the work on the boards finishes. */
  awake: boolean;
}

/**
 * Header status pill: the board's runs, today's spend, and the Claude plan limit once it is near ("2 working · $37.12 today").
 * Click for the details: run slots, queue, huddle agents, plan usage bars and spend per board. Data from useUsage, shared
 * with the phone UsageBox. `board`: undefined without a board, null while its tickets load (no count is shown then).
 */
export function StatusPill({ state, board, openRequest }: { state: UsageState; board?: BoardRuns | null; openRequest?: number }) {
  const { usage, loading, load, spend, loadSpend } = state;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const now = useNow();

  // ⌘K "Usage" opens the panel.
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);

  useLayer(() => {
    setOpen(false);
    pill.current?.focus();
  }, { active: open });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const failed = !!usage && "error" in usage;
  const windows = usage && !("error" in usage) ? usage.windows : [];
  const tone = failed || !windows.length ? "ok" : worstTone(windows);
  const limit = limitNote(windows);
  const today = spend ? `${costText(spend.costUsd)} today` : null;
  const parts = [board ? runStatusText(board.runs, board.queued) : null, limit, today].filter(Boolean) as string[];
  const loadingRuns = board === null;
  const label = parts.join(" · ") || (loadingRuns ? "" : "Usage");

  return (
    <div className="usage" ref={root}>
      <button ref={pill} className={`pill usage-pill${tone === "ok" ? "" : ` ${tone}`}${loadingRuns ? " is-loading" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={loadingRuns ? `Loading the board${label ? `. ${label}` : ""}` : undefined}
        onClick={() => { setOpen((v) => !v); loadSpend(); }} title="Runs on this board, and Claude plan usage">
        {loadingRuns && <span className="pill-skeleton" aria-hidden />}
        {loadingRuns && label ? ` · ${label}` : label}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Runs and Claude plan usage">
          {board !== undefined && (
            <div className="usage-runs">
              <h4>This board</h4>
              {!board ? <p className="muted small">Loading…</p> : <>
                <div className="usage-top"><span>Run slots in use</span><b>{board.slots} of {board.maxParallel}</b></div>
                <div className="usage-sub">
                  {board.runs === 0 ? "Nothing is running." : `${board.runs} ${board.runs === 1 ? "run" : "runs"} active.`}
                  {board.queued > 0 && ` ${board.queued} queued for a free slot.`}
                  {board.agents > 0 && ` ${board.agents} huddle ${board.agents === 1 ? "agent" : "agents"} working (outside the slots).`}
                </div>
                <div className="usage-sub">At most {board.maxParallel} tickets work at the same time. Planning chats and replies don't take a slot.</div>
                {board.awake && <div className="usage-sub">Keeping the Mac awake until the work on your boards finishes.</div>}
              </>}
            </div>
          )}
          <h4>Claude plan usage</h4>
          {usage && "error" in usage && <p className="usage-error">{usage.error}</p>}
          {!usage && <p className="muted small">Loading…</p>}
          {usage && !failed && !windows.length && <p className="muted small">No usage limits reported for this account.</p>}
          {windows.map((w) => {
            const t = usageTone(w.percent);
            const reset = resetText(w.resetsAt, now);
            return (
              <div key={w.key} className="usage-row">
                <div className="usage-top"><span>{w.label}</span><b>{Math.round(w.percent)}%</b></div>
                <div className="usage-bar"><i className={t} style={{ width: `${w.percent}%` }} /></div>
                {reset && <div className="usage-sub" title={w.resetsAt ? fullTime(w.resetsAt) : undefined}>{reset}</div>}
              </div>
            );
          })}
          {spend && (
            <div className="usage-spend">
              <div className="usage-top"><span>Spent today</span><b>{costText(spend.costUsd)}</b></div>
              {spend.boards.filter((b) => b.costUsd > 0).map((b) => (
                <div key={b.slug} className="usage-sub spend-row"><span>{b.name}</span><span>{costText(b.costUsd)}</span></div>
              ))}
              <div className="usage-sub">API-equivalent cost of every board's runs and huddle agents since midnight.</div>
            </div>
          )}
          <div className="usage-foot">
            <span title={usage ? fullTime(usage.fetchedAt) : undefined}>
              {usage ? `Updated ${timeAgo(usage.fetchedAt)}` : ""}
            </span>
            <button className="btn small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Phone More sheet: Claude plan usage as compact bars; tap for reset times and today's spend. */
export function UsageBox({ state }: { state: UsageState }) {
  const { usage, loading, load, spend } = state;
  const [open, setOpen] = useState(false);
  const now = useNow();
  const failed = !!usage && "error" in usage;
  const windows = usage && !("error" in usage) ? usage.windows : [];

  return (
    <div className="usage-box">
      <div className="usage-box-head">
        <span>Claude plan usage</span>
        <span className="usage-box-updated" title={usage ? fullTime(usage.fetchedAt) : undefined}>
          {usage ? `Updated ${timeAgo(usage.fetchedAt)}` : ""}
        </span>
        <button className="btn small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
      </div>
      {usage && "error" in usage && <p className="usage-error">{usage.error}</p>}
      {!usage && <p className="muted small">Loading…</p>}
      {usage && !failed && !windows.length && <p className="muted small">No usage limits reported for this account.</p>}
      {(windows.length > 0 || spend) && (
        <button className="usage-box-body" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Hide reset times and today's spend" : "Show reset times and today's spend"}>
          {windows.map((w) => (
            <span key={w.key} className="usage-box-row">
              <span className="usage-box-label">{shortLabel(w)}</span>
              <span className="usage-bar"><i className={usageTone(w.percent)} style={{ width: `${w.percent}%` }} /></span>
              <b>{Math.round(w.percent)}%</b>
            </span>
          ))}
          {open && (
            <span className="usage-box-more">
              {windows.map((w) => {
                const reset = resetText(w.resetsAt, now);
                return reset && <span key={w.key} className="usage-sub">{shortLabel(w)}: {reset}</span>;
              })}
              {spend && <>
                <span className="usage-top usage-box-spend"><span>Spent today</span><b>{costText(spend.costUsd)}</b></span>
                {spend.boards.filter((b) => b.costUsd > 0).map((b) => (
                  <span key={b.slug} className="usage-sub spend-row"><span>{b.name}</span><span>{costText(b.costUsd)}</span></span>
                ))}
              </>}
            </span>
          )}
          <span className="usage-box-hint">{open ? "Less" : "Reset times and today's spend"}</span>
        </button>
      )}
    </div>
  );
}
