import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { api, type Ticket } from "../../lib/api";
import { deleteTitle, toolCount } from "../family/familyActions";
import { WaitingJobs, useWaitingJobs } from "../schedules/WaitingJobs";

/**
 * The board card's and the ticket's own "Delete ticket": lists the jobs it (and a main ticket's tasks) scheduled that
 * are still waiting, which keep running unless "Also cancel these jobs" is ticked.
 */
export function DeleteTicketDialog({ slug, ticket, onCancel, onDeleted }: {
  slug: string;
  ticket: Ticket;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const waiting = useWaitingJobs(slug, [ticket.id]);
  const [cancel, setCancel] = useState(false);
  const tools = toolCount(ticket);
  const working = ticket.status === "in_progress" || !!ticket.running;
  return (
    <ConfirmDialog title={deleteTitle(ticket)} confirmLabel={tools ? "Delete all" : "Delete ticket"} busyLabel="Deleting…" onCancel={onCancel}
      // Wait for the job check, so nothing scheduled goes unseen.
      confirmDisabled={waiting.jobs === null}
      onConfirm={async () => {
        await api.deleteTicket(slug, ticket.id, cancel ? (waiting.jobs ?? []).map((j) => j.id) : undefined);
        onDeleted();
      }}>
      {tools > 0
        ? <p>Work that isn't merged is lost. Their copies of the folder go too; tickets you added to the feature stay, unlinked.</p>
        : <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>}
      {ticket.worktree && <p className="muted">Its copy of the folder is removed if it has no unsaved changes. Its saved versions and any pull request stay.</p>}
      <WaitingJobs state={waiting} many={tools > 0} cancel={cancel} onCancel={setCancel} />
    </ConfirmDialog>
  );
}
