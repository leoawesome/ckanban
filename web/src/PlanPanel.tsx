import { useState } from "react";
import { api, type Ticket } from "./api";
import { checkInsText, complete, planFinished, waitPhrase } from "./planText";

export { complete, planFinished };

const STATE_LABEL: Record<string, [string, string]> = {
  running: ["Running", "running"],
  finishing: ["Final check", "running"],
  paused: ["Paused", "stopped"],
  stuck: ["Stuck", "blocked"],
  done: ["Done", "ok"],
};

const stateOf = (plan: Ticket["plan"]): [string, string] => plan ? STATE_LABEL[plan.state] ?? [plan.state, "stopped"] : ["Not started", "stopped"];

/** Sidebar row: "Plan · 3/9 done →", with a badge while it runs or is stuck. Opens the Plan tab. */
export function PlanSummary({ ticket, children, onOpen }: { ticket: Ticket; children: Ticket[]; onOpen: () => void }) {
  const done = children.filter(complete).length;
  const state = ticket.plan?.state;
  const [label, tone] = stateOf(ticket.plan);
  return (
    <div className="field-row">
      <span className="field-key">Plan</span>
      <span className="plan-summary">
        {(state === "stuck" || state === "running" || state === "finishing" || state === "paused") && <span className={`badge ${tone}`}>{label}</span>}
        <button className="link-btn" onClick={onOpen}>{done}/{children.length} done →</button>
      </span>
    </div>
  );
}

/** Every child is done: a muted "Plan finished · 5 of 5" with Move to Done (while the planner isn't Done) and an Add more tickets link. */
export function PlanFinished({ ticket, total, onMoveToDone, onAddMore }: {
  ticket: Ticket;
  total: number;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  return (
    <div className="plan-finished" role="status">
      <span className="plan-finished-line">Plan finished · {total} of {total}</span>
      {ticket.status !== "done" && <button className="btn primary small" onClick={onMoveToDone}>Move to Done</button>}
      <button className="link-btn plan-add-more" onClick={onAddMore} title="Ask Claude in the chat for more tickets">Add more tickets</button>
    </div>
  );
}

/** The plan controls at the top of a planner's Family tab: state and Start / Pause / Resume. */
export function PlanControls({ slug, ticket, children, onOpenTicket, onError, onMoveToDone, onAddMore, countShown }: {
  slug: string;
  /** The feature's status summary above already says "N of M done": leave the count off this line. */
  countShown?: boolean;
  ticket: Ticket;
  children: Ticket[];
  onOpenTicket: (id: string) => void;
  onError: (m: string) => void;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const plan = ticket.plan ?? null;
  const done = children.filter(complete).length;
  const act = async (action: "start" | "pause" | "resume" | "done") => {
    setBusy(true);
    try {
      await api.plan(slug, ticket.id, action);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const [label, tone] = stateOf(plan);
  const finished = planFinished(children);
  // Children only the user can move on (questions, a proposal, Planning): what a stuck plan waits for.
  const waiting = children.filter((c) => c.userWait && !complete(c) && !c.running && c.status !== "in_progress");
  return (
    <section className="plan-panel">
      {/* One text line: "Plan · Running · 6 of 14 done" (the state as a coloured word, no bar; no count under the status summary, which has it). */}
      {!finished && (
        <div className="plan-head">
          <b>Plan</b> · <span className={`plan-state ${tone}`}>{label}</span>{!countShown && <> · <span>{done} of {children.length} done</span></>}
        </div>
      )}
      {!finished && plan?.state === "stuck" && waiting.length > 0 && (
        <div className="plan-waiting" role="status">
          {waiting.map((c) => (
            <div key={c.id} className="plan-waiting-row">
              <span>Waiting on you: <b>{c.title}</b> {waitPhrase(c.userWait!)}</span>
              <button className="btn primary small" onClick={() => onOpenTicket(c.id)}>Open</button>
            </div>
          ))}
        </div>
      )}
      {!finished && plan?.state === "stuck" && plan.reason && <p className="field-help plan-reason">{plan.reason}</p>}
      {finished ? (
        <PlanFinished ticket={ticket} total={children.length} onMoveToDone={onMoveToDone} onAddMore={onAddMore} />
      ) : (
        <div className="plan-actions">
          {!plan || plan.state === "done" ? (
            <button className="btn primary small" disabled={busy}
              title="Children switch to auto mode and run in dependency order; Claude is woken only when one needs a decision"
              onClick={() => act("start")}>Start plan</button>
          ) : plan.state === "paused" || plan.state === "stuck" ? (
            <button className="btn primary small" disabled={busy} onClick={() => act("resume")}>Resume plan</button>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => act("pause")}>Pause</button>
          )}
          {(plan?.state === "stuck" || plan?.state === "paused") && (
            <button className="btn small" disabled={busy} title="Close the plan as it is, without waking Claude"
              onClick={() => act("done")}>Mark plan done</button>
          )}
          {plan && <span className="muted small" title="Times the plan asked Claude to decide something">{checkInsText(plan.wakeups)}</span>}
        </div>
      )}
    </section>
  );
}
