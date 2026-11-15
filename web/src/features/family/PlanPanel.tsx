import { useState } from "react";
import { api, type Ticket } from "../../lib/api";
import { checkInsText, complete, planDone, waitPhrase } from "./planText";

export { planDone };

const STATE_LABEL: Record<string, [string, string]> = {
  running: ["Running", "running"],
  finishing: ["Final check", "running"],
  paused: ["Paused", "stopped"],
  stuck: ["Stuck", "blocked"],
  done: ["Done", "ok"],
};

const stateOf = (plan: Ticket["plan"]): [string, string] => plan ? STATE_LABEL[plan.state] ?? [plan.state, "stopped"] : ["Not started", "stopped"];

/** Every task of a main ticket is done: a muted "Plan finished · 5 of 5" with Move to Done (while it isn't Done) and an Add more tasks link. */
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
      <button className="link-btn plan-add-more" onClick={onAddMore} title="Ask Claude in the chat for more tasks">Add more tasks</button>
    </div>
  );
}

/** The plan controls at the top of a main ticket's Tasks tab: state and Start / Pause / Resume. */
export function PlanControls({ slug, ticket, tasks, onOpenTicket, onError, onMoveToDone, onAddMore, countShown }: {
  slug: string;
  /** The feature's status summary above already says "N of M done": leave the count off this line. */
  countShown?: boolean;
  ticket: Ticket;
  /** The tasks under it (tasksUnder): nested groups' tasks counted once, the groups themselves not. */
  tasks: Ticket[];
  onOpenTicket: (id: string) => void;
  onError: (m: string) => void;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const plan = ticket.plan ?? null;
  const { finished, done, total } = planDone(tasks);
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
  // Tasks only the user can move on (questions, a proposal, Planning): what a stuck plan waits for.
  const waiting = tasks.filter((c) => c.userWait && !complete(c) && !c.running && c.status !== "in_progress");
  return (
    <section className="plan-panel">
      {/* One text line: "Plan · Running · 6 of 14 done" (the state as a coloured word, no bar; no count under the status summary, which has it). */}
      {!finished && (
        <div className="plan-head">
          <b>Plan</b> · <span className={`plan-state ${tone}`}>{label}</span>{!countShown && <> · <span>{done} of {total} done</span></>}
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
        <PlanFinished ticket={ticket} total={total} onMoveToDone={onMoveToDone} onAddMore={onAddMore} />
      ) : (
        <div className="plan-actions">
          {!plan || plan.state === "done" ? (
            <button className="btn primary small" disabled={busy}
              title="Its tasks run in order on their own; Claude is woken only when one needs a decision"
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
