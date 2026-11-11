// The ticket panel's "Part of" row (link, change, unlink, the board's suggestion); the whole family is in the Family
// tab (FamilyTab.tsx).
import { useMemo, useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";
import { featureRows, LINK_WORDS, parentLink, wouldLoop, type FamilyRow, type LinkHow } from "./family";
import { linkHints } from "./linkHints";
import { useLayer } from "./layers";

const columnLabel = (status: string) => COLUMNS.find((c) => c.id === status)?.label ?? status;

/** Tickets the picker offers at once. */
const PICK_MAX = 8;

/** The family as plain text, for pasting into a chat ("summarise this flight"). */
export function familyText(rows: FamilyRow<Ticket>[]): string {
  return rows.map((r) => `${"  ".repeat(r.depth)}- ${r.ticket.title} (${columnLabel(r.ticket.status)}${r.how ? `, ${LINK_WORDS[r.how]}` : ""}, ${r.ticket.id})`).join("\n");
}

/** Find a ticket to link under: the newest first, leaving out the ticket itself and its own family below it. */
function ParentPicker({ ticket, tickets, onPick, onCancel }: {
  ticket: Ticket; tickets: Ticket[]; onPick: (id: string) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const options = useMemo(() => {
    // Moving it ends its current link, so only the tickets below it are off limits.
    const unlinked = tickets.map((t) => (t.id === ticket.id ? { ...t, partOf: null, parentId: null } : t));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return tickets
      .filter((t) => t.id !== ticket.id && t.id !== parentLink(ticket)?.id && !wouldLoop(unlinked, ticket.id, t.id))
      .filter((t) => words.every((w) => t.title.toLowerCase().includes(w) || t.id.includes(w)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, PICK_MAX);
  }, [q, tickets, ticket]);
  return (
    <div className="parent-picker" onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    }}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a ticket by its title…" aria-label="Find the ticket this one is part of"
        onKeyDown={(e) => {
          if (e.key === "Enter" && options[0]) {
            e.preventDefault();
            onPick(options[0].id);
          }
        }} />
      <div className="parent-options" role="listbox">
        {options.map((t) => (
          <button key={t.id} className="parent-option" role="option" aria-selected={false} onClick={() => onPick(t.id)}>
            <span className="fam-title">{t.title}</span>
            <span className="muted small">{columnLabel(t.status)}</span>
          </button>
        ))}
        {!options.length && <span className="muted small">No matching ticket</span>}
      </div>
      <button className="mini-link" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** How the panel names a ticket's parent row, and what it explains, by how the ticket hangs on it. */
const PARENT_ROW: Record<LinkHow | "none", { key: string; title: string; gone: string }> = {
  linked: { key: "Part of", title: "The ticket this one belongs to: the tickets of one piece of work sit under one main ticket", gone: "Ticket was deleted" },
  chat: { key: "Part of", title: "This ticket was created from that ticket's chat, as part of its work", gone: "Ticket was deleted" },
  plan: { key: "From", title: "The ticket whose plan runs this one (it proposed or adopted it)", gone: "Ticket was deleted" },
  none: { key: "Part of", title: "The ticket this one belongs to: the tickets of one piece of work sit under one main ticket", gone: "" },
};

/**
 * The ticket this one hangs under ("Part of", or "From" for plan tickets) with Change and
 * Unlink, or the board's suggestion as one chip whose list offers Add it, Pick another and Not related. Moving a plan ticket
 * elsewhere ends that link too (Board.setPartOf).
 */
export function PartOfField({ slug, ticket, tickets, onOpenTicket, onError }: {
  slug: string; ticket: Ticket; tickets: Ticket[]; onOpenTicket: (id: string) => void; onError: (msg: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The suggestion chip's list (Add it / Pick another / Not related) is open.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const current = parentLink(ticket);
  const row = PARENT_ROW[current?.how ?? "none"];
  const parent = current ? tickets.find((t) => t.id === current.id) : undefined;
  // Tickets in review or done are past the point of joining a feature: no suggestion there, just "Link to a ticket…".
  const settled = ticket.status === "review" || ticket.status === "done";
  const suggested = !current && !settled && ticket.parentSuggestion ? tickets.find((t) => t.id === ticket.parentSuggestion!.id) : undefined;
  // Esc closes the open list first (the app's one Esc stack), before it closes the ticket panel.
  useLayer(() => setSuggestOpen(false), { active: suggestOpen && !!suggested && !picking });
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    // The server's refusal (too deep, a sub-feature under a sub-feature) is already in plain words.
    p.then(() => { setPicking(false); setSuggestOpen(false); }, (e) => onError((e as Error).message)).finally(() => setBusy(false));
  };
  const link = (id: string | null) => act(api.setPartOf(slug, ticket.id, id));
  const hints = linkHints(ticket, current?.how ?? null, ticket.main ? Math.max(0, featureRows(tickets, ticket.id).length - 1) : 0);
  const changeUnlink = (
    <>
      <button className="mini-link" disabled={busy} onClick={() => setPicking(true)} title={hints.change}>Change</button>
      <button className="mini-link" disabled={busy} onClick={() => link(null)} title={hints.unlink}>Unlink</button>
    </>
  );
  return (
    <>
      <div className="field-row part-of-row">
        <span className="field-key" title={row.title}>{row.key}</span>
        {picking ? null : parent ? (
          <span className="part-of-value">
            <button className="link-btn ticket-link" onClick={() => onOpenTicket(parent.id)}>{parent.title}</button>
            <span className="muted small"> ({columnLabel(parent.status)})</span>
            {changeUnlink}
          </span>
        ) : current ? (
          <span className="part-of-value"><span className="muted small">{row.gone}</span>{changeUnlink}</span>
        ) : suggested ? (
          <div className="fc part-suggest" role="group" aria-label="Suggested feature">
            <button type="button" className="fc-chip" aria-expanded={suggestOpen} title={suggested.title}
              onClick={() => setSuggestOpen((v) => !v)}>
              Suggested: <span className="fc-title">{suggested.title}</span> <span aria-hidden>▾</span>
            </button>
            {suggestOpen && (
              <div className="fc-list">
                <button type="button" className="fc-row" disabled={busy} onClick={() => link(suggested.id)}>
                  <span className="fc-row-title">Add it to this feature</span>
                  {ticket.parentSuggestion!.reason && <span className="muted small">{ticket.parentSuggestion!.reason}</span>}
                </button>
                <button type="button" className="fc-row" disabled={busy} onClick={() => { setSuggestOpen(false); setPicking(true); }}>
                  <span className="fc-row-title">Pick another feature…</span>
                </button>
                <button type="button" className="fc-row" disabled={busy} onClick={() => act(api.dismissParentSuggestion(slug, ticket.id))}>
                  <span className="fc-row-title">Not related</span>
                  <span className="muted small">Hide this suggestion</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="mini-link" disabled={busy} onClick={() => setPicking(true)} title={hints.link}>Link to a ticket…</button>
        )}
      </div>
      {ticket.tool && (
        <div className="field-row">
          <span className="field-key" title="A task has no card of its own unless you show it; its questions still go to its feature's chat">Board</span>
          <label className="show-on-board" title={ticket.showOnBoard ? "Hide its card again; it stays in its feature's task list" : `Give it its own card on the board; its questions still go to ${ticket.mainTicket?.title ?? "its feature"}`}>
            <input type="checkbox" checked={!!ticket.showOnBoard} disabled={busy}
              onChange={(e) => act(api.setShowOnBoard(slug, ticket.id, e.target.checked))} /> Show on board
          </label>
        </div>
      )}
      {picking && <ParentPicker ticket={ticket} tickets={tickets} onPick={link} onCancel={() => setPicking(false)} />}
    </>
  );
}
