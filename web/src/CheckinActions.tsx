import { useState } from "react";
import { api, type Ticket } from "./api";

/** A main ticket's check-in: Keep going (counters start over) or Stop here (its running tool tickets stop). */
export function CheckinActions({ slug, ticket, onError, small }: { slug: string; ticket: Ticket; onError: (msg: string) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (action: "keep" | "stop") => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.answerCheckin(slug, ticket.id, action);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const size = small ? " small" : "";
  return (
    <div className="limit-actions" onKeyDown={(e) => e.stopPropagation()}>
      <button className={`btn primary${size}`} disabled={busy} onClick={run("keep")} title="Let its tool tickets carry on; the next check-in comes after the same amount again">Keep going</button>
      <button className={`btn${size}`} disabled={busy} onClick={run("stop")} title="Stop its running tool tickets and pause; you can talk to it in its chat">Stop here</button>
    </div>
  );
}
