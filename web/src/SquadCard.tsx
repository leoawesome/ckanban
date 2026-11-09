import { useState } from "react";
import { api, type HuddlePreset, type HuddleTemplate, type Level, type SquadCardRef, type SquadCardState, type SquadDraft, type SquadProposal } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { isNameTaken, personChips, personHandle, squadSavedText, squadSummary } from "./squadText";

type Saved = { squad: HuddleTemplate; teammates: { created: string[]; reused: string[] } };

/**
 * Saving a squad card: api.saveSquad, and when a squad of that name exists, a "Replace it?" dialog before saving again
 * with replace. `confirm` is the dialog to render (null when none).
 */
export function useSquadSave(slug: string, card: SquadCardRef | undefined, onSaved: (out: Saved, scope: Level) => void, onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const [taken, setTaken] = useState<{ squad: SquadDraft; scope: Level; message: string } | null>(null);
  const save = async (squad: SquadDraft, scope: Level, replace = false) => {
    setBusy(true);
    try {
      const out = await api.saveSquad(slug, squad, scope, card, replace);
      setTaken(null);
      onSaved(out, scope);
    } catch (e) {
      const m = (e as Error).message;
      if (!replace && isNameTaken(m)) setTaken({ squad, scope, message: m });
      else onError(m);
    } finally {
      setBusy(false);
    }
  };
  const confirm = taken && (
    <ConfirmDialog title={`Replace the squad “${taken.squad.label || taken.squad.name}”?`} confirmLabel="Replace it" busyLabel="Saving…" tone="primary"
      onCancel={() => setTaken(null)} onConfirm={() => save(taken.squad, taken.scope, true)}>
      <p>A squad named <b className="mono">{taken.squad.name}</b> already exists. Replacing it changes that squad for every huddle started from it later. To keep both, cancel and use Edit first to give this one another name.</p>
    </ConfirmDialog>
  );
  return { busy, save, confirm };
}

/**
 * A squad card (the mockup d-claude-card): name, what it's for and the budget, the people as chips (host marked, new
 * teammates marked, mode and model), a fold-out with the host rules and each person's focus, and Save for this board,
 * Save for all boards, Edit first and Dismiss. The same card for Claude's propose_squad and for "Save as squad…".
 */
export function SquadCardView({ proposal, presets, kicker, busy, dismissed, dismissLabel = "Dismiss", onSave, onEdit, onDismiss }: {
  proposal: SquadProposal;
  /** The board's teammates (null while loading): which people would be new. */
  presets: HuddlePreset[] | null;
  /** The small line on top ("Squad proposed by Claude"). */
  kicker: string;
  busy?: boolean;
  dismissed?: boolean;
  dismissLabel?: string;
  onSave: (scope: Level) => void;
  onEdit?: () => void;
  onDismiss?: () => void;
}) {
  const s = proposal.squad;
  const names = presets ? new Set(presets.map((p) => p.name)) : null;
  const modes = new Map((presets ?? []).map((p) => [p.name, p.mode]));
  const chips = personChips(s.roster, proposal.newTeammates, names, (n) => modes.get(n));
  const focus = s.roster.filter((e) => e.focus?.trim());
  const summary = squadSummary(s);
  return (
    <div className={`proposal squad-card${dismissed ? " done" : ""}`}>
      <span className="proposal-tag">{kicker}</span>
      <div className="proposal-title">{s.label || s.name}</div>
      {summary && <div className="sqc-why">{summary}</div>}
      <div className="sqc-chips">
        {chips.map((c) => (
          <span key={c.key} className={`sqc-chip${c.host ? " host" : c.isNew ? " new" : ""}`} title={c.title}>
            @{c.handle}{c.host && " (host)"}{c.isNew && " · new teammate"}
            {c.extra && <span className="sqc-extra"> · {c.extra}</span>}
          </span>
        ))}
      </div>
      {(s.hostRules.trim() || focus.length > 0 || s.report.trim()) && (
        <details className="sqc-more">
          <summary>How the host runs it, and each person's focus</summary>
          {s.hostRules.trim() && <div className="sqc-rules">{s.hostRules.trim()}</div>}
          {focus.length > 0 && (
            <ul className="sqc-focus">
              {focus.map((e, i) => <li key={i}><b>@{personHandle(e)}</b>: {e.focus!.trim()}</li>)}
            </ul>
          )}
          {s.report.trim() && <div className="sqc-report"><b>Report:</b> {s.report.trim()}</div>}
        </details>
      )}
      {proposal.why && <div className="sqc-note">{proposal.why}</div>}
      <div className="proposal-actions sqc-actions">
        {dismissed ? (
          <span className="badge">Dismissed</span>
        ) : (
          <>
            <button className="btn small primary" disabled={busy} onClick={() => onSave("board")}>Save for this board</button>
            <button className="btn small" disabled={busy} onClick={() => onSave("global")}>Save for all boards</button>
            {onEdit && <button className="btn small" disabled={busy} onClick={onEdit}>Edit first</button>}
            {onDismiss && <button className="btn small ghost" disabled={busy} onClick={onDismiss}>{dismissLabel}</button>}
          </>
        )}
      </div>
    </div>
  );
}

/** A saved squad card, as a saved teammate card: what was saved and where, and Open in Team. */
export function SquadSavedView({ label, scope, teammates, onOpenTeam }: {
  label: string;
  scope?: Level;
  teammates?: { created: string[]; reused: string[] };
  onOpenTeam?: () => void;
}) {
  return (
    <div className="proposal squad-card applied">
      <span className="proposal-tag">Squad saved</span>
      <div className="proposal-actions">
        <span className="badge ok">{squadSavedText(label, scope, teammates)}</span>
        {onOpenTeam && <button className="btn small ghost" onClick={onOpenTeam}>Open in Team</button>}
      </div>
    </div>
  );
}

/** Claude's propose_squad card in a ticket chat: saved or dismissed on the ticket (squadCards). */
export function SquadCard({ slug, ticketId, uuid, proposal, presets, answered, old, onEdit, onOpenTeam, onSaved, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  proposal: SquadProposal;
  presets: HuddlePreset[] | null;
  answered?: SquadCardState;
  /** Copied history of a branched ticket: read-only. */
  old?: boolean;
  onEdit?: (draft: SquadDraft, card: SquadCardRef) => void;
  onOpenTeam?: () => void;
  /** Saved (the ticket update marks the card): the chat reloads its teammates, new ones included. */
  onSaved?: () => void;
  onError: (m: string) => void;
}) {
  const card = { ticketId, uuid };
  const { busy, save, confirm } = useSquadSave(slug, card, () => onSaved?.(), onError);
  const [dismissing, setDismissing] = useState(false);
  if (answered?.state === "saved") {
    return <SquadSavedView label={answered.name ?? proposal.squad.label} scope={answered.scope} teammates={answered.teammates} onOpenTeam={onOpenTeam} />;
  }
  const dismiss = () => {
    setDismissing(true);
    api.answerSquadCard(slug, ticketId, uuid, { state: "dismissed" }).catch((e) => onError(e.message)).finally(() => setDismissing(false));
  };
  return (
    <>
      <SquadCardView proposal={proposal} presets={presets} kicker="Squad proposed by Claude" busy={busy || dismissing || old}
        dismissed={answered?.state === "dismissed"}
        onSave={(scope) => save(proposal.squad, scope)}
        onEdit={onEdit && !old ? () => onEdit(proposal.squad, card) : undefined}
        onDismiss={old ? undefined : dismiss} />
      {confirm}
    </>
  );
}
