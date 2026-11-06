import { useEffect, useState } from "react";
import type { Huddle, RosterEntry, Ticket } from "./api";
import { formKey } from "./drafts";
import { dollars, rosterNames } from "./huddleText";
import { applyProposedTemplate, draftError, RosterEditor, rosterDraft, startFromDraft, TemplatePicker, usePresets, useTemplates, type RosterDraft } from "./HuddleRoster";
import { usePersistentState } from "./usePersistentState";
import { CloseIcon, HuddleIcon } from "./icons";
import { TapTip } from "./TapTip";

/**
 * Claude proposed a huddle (propose_huddle): one line with who would join and the budget, Start, Edit… and ✕.
 * The roster editor opens only after Edit…; nothing runs before Start. Once started it is one line again.
 * `huddle`: the ticket's current huddle, to tell whether this proposal was started.
 */
export function HuddleCard({ slug, ticket, tickets, uuid, at, roster, reason, template, maxCostUsd, huddle, old, onOpen, onError }: {
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
  uuid: string;
  at: string;
  roster: RosterEntry[];
  reason: string;
  /** Template Claude proposed (its roster when `roster` is empty, its budget and rules). */
  template?: string;
  /** Budget Claude proposed (already capped); wins over the template's. */
  maxCostUsd?: number;
  huddle: Huddle | null;
  /** Copied history of a branched ticket: read-only. */
  old?: boolean;
  onOpen: () => void;
  onError: (m: string) => void;
}) {
  const presets = usePresets(slug);
  const templates = useTemplates(slug);
  const [draft, setDraft] = useState<RosterDraft>(() => rosterDraft(roster, maxCostUsd));
  // The proposed template, once the board's templates are in: its roster and budget, unless Claude gave them.
  useEffect(() => {
    const t = template && templates?.find((x) => x.name === template);
    if (t) setDraft((d) => (d.template ? d : applyProposedTemplate(d, t, roster, maxCostUsd)));
  }, [templates, template]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = usePersistentState(formKey(slug, ticket.id, `huddle-${uuid}`), () => false, (v) => !v, (v) => typeof v === "boolean");
  const started = !!huddle && huddle.createdAt >= at;
  const otherOpen = !!huddle && !started && huddle.status !== "closed";
  const err = draftError(draft);
  // Started: what the huddle actually got; otherwise what Claude proposed.
  const budget = started ? huddle!.maxCostUsd : maxCostUsd;

  const start = async () => {
    if (busy || err || started || otherOpen) return;
    setBusy(true);
    try {
      await startFromDraft(slug, ticket.id, draft);
      onOpen();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (dismissed && !started) {
    return (
      <div className="huddle-card-dismissed muted small">
        Huddle proposal dismissed · <button className="link-btn" onClick={() => setDismissed(false)}>Show</button>
      </div>
    );
  }
  // Who would join (the draft: Claude's roster, or its template's once loaded, plus any edits).
  const who = draft.rows.length ? rosterNames(draft.rows) : template ? `template ${template}` : "no one yet";
  const words = <><b>{started ? "Review started" : "Proposed review"}:</b> a few Claudes check the work together · {who}
    {started ? (budget != null ? ` · ${dollars(budget)} budget` : "") : ` · up to ${dollars(old ? budget ?? draft.maxCostUsd : draft.maxCostUsd)}`}</>;
  const note = started || old ? null : otherOpen ? "This ticket already has an open huddle." : err;
  return (
    <div className={`huddle-card huddle-line${started ? " started" : ""}`}>
      <div className="huddle-line-row">
        <HuddleIcon />
        {reason ? <TapTip className="huddle-line-text" tip={reason} label="Why Claude proposes it">{words}</TapTip> : <span className="huddle-line-text">{words}</span>}
        <span className="huddle-line-acts">
          {started ? (
            <>
              <span className={`badge ${{ live: "ok", stopped: "blocked", closed: "stopped" }[huddle!.status]}`}>{{ live: "Live", stopped: "Stopped", closed: "Closed" }[huddle!.status]}</span>
              <button className="btn small" onClick={onOpen}>Open huddle</button>
            </>
          ) : old ? null : (
            <>
              {otherOpen ? <button className="btn small" onClick={onOpen}>Open huddle</button> : (
                <button className="btn primary small" onClick={start} disabled={busy || !!err || presets === null}>{busy ? "Starting…" : "Start"}</button>
              )}
              <button className="btn small" aria-expanded={editing} onClick={() => setEditing((e) => !e)} disabled={busy}>{editing ? "Done" : "Edit…"}</button>
              <button className="icon-btn huddle-line-x" onClick={() => setDismissed(true)} disabled={busy} aria-label="Dismiss the proposal" title="Dismiss"><CloseIcon size={12} /></button>
            </>
          )}
        </span>
      </div>
      {old && <div className="huddle-line-note muted small">From the conversation this ticket was copied from.</div>}
      {note && <div className="huddle-line-note muted small">{note}</div>}
      {editing && !started && !old && (
        <div className="huddle-line-edit">
          <TemplatePicker templates={templates} draft={draft} setDraft={setDraft} disabled={busy} />
          <RosterEditor presets={presets} draft={draft} setDraft={setDraft} tickets={tickets} hostId={ticket.id} onEnter={start} disabled={busy} />
        </div>
      )}
    </div>
  );
}
