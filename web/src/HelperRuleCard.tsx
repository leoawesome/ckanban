import { useState } from "react";
import { api, type HelperRuleCardState } from "./api";
import { BellIcon } from "./icons";

/**
 * Claude suggested a line for "What the helper knows about you" (propose_helper_rule in this ticket's chat or run).
 * Runs can't change the helper, so only the user's Add saves it, through the ticket's helper-rule-cards route, which
 * saves the line from this chat's transcript (the text shown here) and notes the answer on the ticket. Not now saves
 * nothing. Once answered the card says so and has nothing to click.
 */
export function HelperRuleCard({ slug, ticketId, uuid, text, reason, answered, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  /** The exact line, as it would be saved. */
  text: string;
  reason: string;
  /** What the user did with this card (the ticket's helperRuleCards), if anything. */
  answered?: HelperRuleCardState;
  onError: (msg: string) => void;
}) {
  // Which button is in flight, so only that one says so.
  const [busy, setBusy] = useState<"added" | "dismissed" | null>(null);

  const answer = async (state: "added" | "dismissed") => {
    setBusy(state);
    try {
      await api.answerHelperRuleCard(slug, ticketId, uuid, state === "added" ? { state, text } : { state });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`proposal helper-rule-card${answered ? " done" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag"><BellIcon size={12} /> Suggestion for the helper</span>
      </div>
      <div className="small">Claude suggests adding this to what the helper knows about you:</div>
      <blockquote className="hrc-line">“{text}”</blockquote>
      {reason && <div className="muted small">Reason: {reason}</div>}
      {!answered && (
        <div className="muted small">The helper reads this list to decide which alerts need you. You can remove the line any time in Notifications.</div>
      )}
      <div className="proposal-actions">
        {answered ? (
          <span className={`badge ${answered.state === "added" ? "ok" : ""}`}>
            {answered.state === "added" ? (answered.already ? "Added (it was already in the list)." : "Added.") : "Dismissed."}
          </span>
        ) : (
          <>
            <button className="btn" disabled={!!busy} onClick={() => answer("dismissed")}>{busy === "dismissed" ? "Dismissing…" : "Not now"}</button>
            <button className="btn primary" disabled={!!busy} onClick={() => answer("added")}>{busy === "added" ? "Adding…" : "Add"}</button>
          </>
        )}
      </div>
    </div>
  );
}
