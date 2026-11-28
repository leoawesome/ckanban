import { useEffect, useState } from "react";
import { api, type Job } from "../../lib/api";
import { jobDate, jobRelative } from "./jobText";

export { proposedCancel } from "./jobText";

/** Rows shown before "and N more" (a big delete keeps the confirm short). */
const SHOWN = 3;

export interface WaitingJobsState {
  /** null while loading. */
  jobs: Job[] | null;
  failed: boolean;
}

/**
 * The jobs still waiting to run that these tickets scheduled (a main ticket's tool tickets count too): deleting
 * keeps them scheduled, so every delete confirm lists them first. Off (`on` false) once the card is answered.
 */
export function useWaitingJobs(slug: string, ids: string[], on = true): WaitingJobsState {
  const key = ids.join(",");
  const [state, setState] = useState<WaitingJobsState>({ jobs: null, failed: false });
  useEffect(() => {
    if (!on || !key) { setState({ jobs: [], failed: false }); return; }
    let live = true;
    setState({ jobs: null, failed: false });
    api.waitingJobs(slug, key.split(","))
      .then((jobs) => { if (live) setState({ jobs, failed: false }); })
      .catch(() => { if (live) setState({ jobs: [], failed: true }); });
    return () => { live = false; };
  }, [slug, key, on]);
  return state;
}

/**
 * The waiting jobs a delete leaves running, and the unticked "Also cancel these jobs". Shows nothing when there
 * are none; a line when they couldn't be checked, so the delete still works.
 */
export function WaitingJobs({ state, many, cancel, onCancel, suggested }: {
  state: WaitingJobsState;
  /** Several tickets go (plural wording). */
  many: boolean;
  cancel: boolean;
  onCancel: (on: boolean) => void;
  /** Claude suggested cancelling some, not all, of them. */
  suggested?: boolean;
}) {
  const { jobs, failed } = state;
  if (failed) return <p className="muted small waiting-jobs-note">Couldn't check for jobs these tickets scheduled; any still waiting keep running.</p>;
  if (jobs === null) return <p className="muted small waiting-jobs-note"><span className="spinner" /> Checking for scheduled jobs…</p>;
  if (!jobs.length) return null;
  const rest = jobs.length - SHOWN;
  const gone = many ? "the tickets are" : "the ticket is";
  return (
    <div className="waiting-jobs">
      <div className="waiting-jobs-head">{jobs.length === 1 ? "1 job waiting to run" : `${jobs.length} jobs waiting to run`}</div>
      <ul className="waiting-jobs-list">
        {jobs.slice(0, SHOWN).map((j) => (
          <li key={j.id}>
            <span className="waiting-jobs-name">{j.name}</span>
            <span className="muted small">{jobDate(j.at)} · {jobRelative(j.at)}</span>
          </li>
        ))}
        {rest > 0 && <li className="muted small">and {rest} more</li>}
      </ul>
      <div className="small">{cancel ? `${jobs.length === 1 ? "It is" : "These are"} cancelled when ${gone} deleted.` : `${jobs.length === 1 ? "It will" : "These will"} still run after ${gone} deleted.`}</div>
      {suggested && !cancel && <div className="muted small">Claude suggested cancelling some of them.</div>}
      <label className="waiting-jobs-cancel">
        <input type="checkbox" checked={cancel} onChange={(e) => onCancel(e.target.checked)} />
        <span>{jobs.length === 1 ? "Also cancel this job" : "Also cancel these jobs"}</span>
      </label>
    </div>
  );
}
