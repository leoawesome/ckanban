import { useState } from "react";
import { api, type Ticket } from "../lib/api";
import { COLUMNS } from "../features/board/columns";
import { formKey } from "../lib/drafts";
import { TrashIcon } from "./icons";
import { usePersistentState } from "../hooks/usePersistentState";
import { WaitingJobs, proposedCancel, useWaitingJobs } from "../features/schedules/WaitingJobs";

/**
 * Claude asked to delete tickets (propose_delete): runs can't delete, so the user's click does it, through the
 * same endpoint as the board's Delete. The jobs the tickets scheduled that still wait to run are listed (they keep
 * running unless "Also cancel these jobs" is ticked; Claude's cancelJobs only pre-ticks it). The outcome
 * ("Deleted …" / "Kept.") is remembered per card.
 */
export function DeleteCard({ slug, ticket, tickets, uuid, ids, reason, cancelJobs, onError }: {
  slug: string;
  /** The ticket whose chat shows the card; it can't delete itself from here. */
  ticket: Ticket;
  tickets: Ticket[];
  uuid: string;
  ids: string[];
  reason: string;
  /** Claude proposed cancelling their waiting jobs too (true: all; else job ids). */
  cancelJobs?: true | string[];
  onError: (msg: string) => void;
}) {
  const [result, setResult] = usePersistentState<string | null>(formKey(slug, ticket.id, `delete-${uuid}`), () => null, (v) => !v, (v) => typeof v === "string");
  const [busy, setBusy] = useState(false);
  const rows = ids.map((id) => ({ id, t: id === ticket.id ? undefined : tickets.find((x) => x.id === id) }));
  const found = rows.flatMap((r) => (r.t ? [r.t] : []));
  const gone = !result && !found.length;
  const waiting = useWaitingJobs(slug, found.map((t) => t.id), !result && !gone);
  const [cancelPick, setCancel] = useState<boolean | null>(null);
  const jobs = waiting.jobs ?? [];
  const cancel = cancelPick ?? proposedCancel(jobs, cancelJobs);
  const suggested = !!cancelJobs && cancelJobs !== true && jobs.some((j) => cancelJobs.includes(j.id)) && !proposedCancel(jobs, cancelJobs);
  const column = (t: Ticket) => COLUMNS.find((c) => c.id === t.status)?.label ?? t.status;

  const remove = async () => {
    setBusy(true);
    const deleted: string[] = [];
    // The whole list goes on each delete: the board cancels only the jobs of the ticket being deleted.
    const pick = cancel ? jobs.map((j) => j.id) : undefined;
    let cancelled = 0;
    try {
      for (const t of found) {
        const r = await api.deleteTicket(slug, t.id, pick);
        cancelled += r?.cancelledJobs.length ?? 0;
        deleted.push(t.id);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      const kept = jobs.length - cancelled;
      const after = !deleted.length || !jobs.length ? ""
        : cancelled ? ` Cancelled ${cancelled} job${cancelled === 1 ? "" : "s"}.` : ` ${kept} job${kept === 1 ? " still runs" : "s still run"}.`;
      setResult(deleted.length ? `Deleted ${deleted.join(", ")}.${after}` : "Kept.");
    }
  };

  return (
    <div className={`proposal delete-card${result || gone ? " done" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag"><TrashIcon size={12} /> {ids.length > 1 ? `Delete ${ids.length} tickets?` : "Delete ticket?"}</span>
      </div>
      <ul className="delete-list">
        {rows.map(({ id, t }) => (
          <li key={id}>
            {t ? <><b>{t.title}</b> <span className="muted small">{id} · {column(t)}</span></>
              : result ? <s className="muted small">{id}</s>
              : <span className="muted small">{id} · {id === ticket.id ? "this ticket, skipped" : "not on this board, skipped"}</span>}
          </li>
        ))}
      </ul>
      <div className="small">{found.length > 1 || (!found.length && ids.length > 1) ? "Their copies of the folder, saved versions and chats are removed." : "Its copy of the folder, saved versions and chat are removed."} This can't be undone.</div>
      {reason && <div className="muted small">Reason: {reason}</div>}
      {!result && !gone && <WaitingJobs state={waiting} many={found.length > 1} cancel={cancel} onCancel={setCancel} suggested={suggested} />}
      <div className="proposal-actions">
        {result ? (
          <span className={`badge ${result === "Kept." ? "" : "ok"}`}>{result}</span>
        ) : gone ? (
          <span className="muted small">None of these tickets are on the board any more.</span>
        ) : (
          <>
            <button className="btn small" disabled={busy} onClick={() => setResult("Kept.")}>Cancel</button>
            <button className="btn danger small" disabled={busy || waiting.jobs === null} onClick={remove}>{busy ? "Deleting…" : "Delete"}</button>
          </>
        )}
      </div>
    </div>
  );
}
