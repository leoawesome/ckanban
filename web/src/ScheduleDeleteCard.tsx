import { useEffect, useState } from "react";
import { api, subscribe, type Schedule, type ScheduleDeleteCardState } from "./api";
import { TrashIcon } from "./icons";
import { when } from "./SchedulesDialog";

/**
 * Claude asked to delete a schedule (delete_schedule in this ticket's chat or run): runs and chats can't delete one, so
 * the user's Delete click does it (through the ticket's schedule-delete-cards route, which notes the answer on the
 * ticket). Keep leaves the schedule as it is. A schedule that is already gone shows as such, with nothing to click.
 */
export function ScheduleDeleteCard({ slug, ticketId, uuid, scheduleId, reason, answered, deletedName, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  scheduleId: string;
  reason: string;
  /** What the user did with this card (the ticket's scheduleDeleteCards), if anything. */
  answered?: ScheduleDeleteCardState;
  /** The schedule's name from another card in this chat that deleted it. */
  deletedName?: string;
  onError: (msg: string) => void;
}) {
  // undefined: loading; null: not on the board (any more).
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);
  // The schedule's name as last seen: once it is gone (another card deleted it) the card still names it.
  const [lastName, setLastName] = useState<string | null>(null);
  // Which button is in flight, so only that one says so.
  const [busy, setBusy] = useState<"deleted" | "kept" | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const show = (s: Schedule | null) => {
    setSchedule(s);
    if (s) setLastName(s.name);
  };
  useEffect(() => {
    if (answered) return;
    let live = true;
    const load = () => api.schedules(slug).then((ss) => {
      if (!live) return;
      setLoadFailed(false);
      show(ss.find((s) => s.id === scheduleId) ?? null);
    }).catch(() => live && setLoadFailed(true));
    load();
    const off = subscribe((e) => {
      if (e.type === "schedule.updated" && e.profile === slug && e.id === scheduleId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [slug, scheduleId, !!answered]);

  const answer = async (state: "deleted" | "kept") => {
    setBusy(state);
    try {
      await api.answerScheduleDeleteCard(slug, ticketId, uuid, state === "deleted" ? { state, scheduleId } : { state });
    } catch (e) {
      onError((e as Error).message);
      // Gone meanwhile (deleted in Schedules, say): show it as gone instead of a button that can't work.
      api.schedules(slug).then((ss) => show(ss.find((s) => s.id === scheduleId) ?? null)).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const gone = !answered && schedule === null;
  const name = answered?.name ?? schedule?.name ?? lastName ?? deletedName;
  return (
    <div className={`proposal delete-card sched-delete-card${answered || gone ? " done" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag"><TrashIcon size={12} /> Delete schedule?</span>
      </div>
      <div className="sdc-what">
        {name ? <b>{answered?.state === "deleted" ? <s>{name}</s> : name}</b> : <span className="muted small">Schedule {scheduleId}</span>}
        {schedule && !answered && (
          <span className="muted small">
            {schedule.summary} · {schedule.enabled && schedule.nextRunAt ? `next run ${when(schedule.nextRunAt)}` : "paused"}
          </span>
        )}
      </div>
      {!answered && !gone && (
        <div className="small">Tickets it already made stay. This can't be undone; to stop it for a while instead, pause it in Schedules.</div>
      )}
      {reason && <div className="muted small">Reason: {reason}</div>}
      <div className="proposal-actions">
        {answered ? (
          <span className={`badge ${answered.state === "deleted" ? "ok" : ""}`}>{answered.state === "deleted" ? "Deleted." : "Kept."}</span>
        ) : gone ? (
          <span className="muted small">This schedule is no longer on the board.</span>
        ) : (
          <>
            {loadFailed && !schedule && <span className="muted small">Couldn't load this schedule. Check that the board is running, then reopen this chat.</span>}
            <button className="btn small" disabled={!!busy || !schedule} onClick={() => answer("kept")}>{busy === "kept" ? "Keeping…" : "Keep"}</button>
            <button className="btn danger small" disabled={!!busy || !schedule} onClick={() => answer("deleted")}>{busy === "deleted" ? "Deleting…" : "Delete"}</button>
          </>
        )}
      </div>
    </div>
  );
}
