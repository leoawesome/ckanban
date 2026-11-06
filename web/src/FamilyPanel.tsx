// The ticket panel's "Part of" row (link, change, unlink, the board's suggestion); the whole family is in the Family
// tab (FamilyTab.tsx).
import { useMemo, useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";
import { LINK_WORDS, parentLink, wouldLoop, type FamilyRow, type LinkHow } from "./family";

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
    const unlinked = tickets.map((t) => (t.id === ticket.id ? { ...t, partOf: null, addOnOf: null, parentId: null } : t));
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
  linked: { key: "Part of", title: "The ticket this one belongs to: tickets of one piece of work hang together in a family", gone: "Ticket was deleted" },
  chat: { key: "Part of", title: "This ticket was created from that ticket's chat, as part of its work", gone: "Ticket was deleted" },
  "add-on": { key: "Add-on to", title: "This ticket is a new requirement on that one, which keeps its own title and description", gone: "Original ticket was deleted" },
  plan: { key: "From", title: "The planner ticket whose plan runs this one (it proposed or adopted it)", gone: "Planner ticket was deleted" },
  none: { key: "Part of", title: "The ticket this one belongs to: tickets of one piece of work hang together in a family", gone: "" },
};

/** What Unlink also ends, so the user knows before clicking. */
const UNLINK_NOTE: Partial<Record<LinkHow, string>> = {
  plan: "Takes it out of its family and out of that ticket's plan",
  "add-on": "Takes it out of its family; it stops being an add-on to that ticket",
};

/**
 * The ticket this one hangs under ("Part of", or "Add-on to" / "From" for add-ons and plan tickets) with Change and
 * Unlink, or the board's suggestion with Link, Not related and Pick another. Moving a plan ticket or an add-on
 * elsewhere ends that link too (Board.setPartOf).
 */
export function PartOfField({ slug, ticket, tickets, onOpenTicket, onError }: {
  slug: string; ticket: Ticket; tickets: Ticket[]; onOpenTicket: (id: string) => void; onError: (msg: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The suggestion row: why (a tap on the question, or hover), and ✕'s other choices.
  const [why, setWhy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const current = parentLink(ticket);
  const row = PARENT_ROW[current?.how ?? "none"];
  const parent = current ? tickets.find((t) => t.id === current.id) : undefined;
  const suggested = !current && ticket.parentSuggestion ? tickets.find((t) => t.id === ticket.parentSuggestion!.id) : undefined;
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => setPicking(false), (e) => onError(`Couldn't change the link: ${(e as Error).message}`)).finally(() => setBusy(false));
  };
  const link = (id: string | null) => act(api.setPartOf(slug, ticket.id, id));
  const changeUnlink = (
    <>
      <button className="mini-link" disabled={busy} onClick={() => setPicking(true)}
        title={current && UNLINK_NOTE[current.how] ? `Put it under another ticket. ${UNLINK_NOTE[current.how]}` : "Put it under another ticket"}>Change</button>
      <button className="mini-link" disabled={busy} onClick={() => link(null)} title={(current && UNLINK_NOTE[current.how]) ?? "Takes it out of its family"}>Unlink</button>
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
          <span className="part-of-value part-suggest">
            {declining ? (
              <>
                <button className="mini-link" disabled={busy} onClick={() => setPicking(true)}>Pick another…</button>
                <button className="mini-link" disabled={busy} onClick={() => act(api.dismissParentSuggestion(slug, ticket.id))}>Not related</button>
                <button className="mini-link" onClick={() => setDeclining(false)}>Cancel</button>
              </>
            ) : (
              <>
                <button className="link-btn part-suggest-q" aria-expanded={ticket.parentSuggestion!.reason ? why : undefined}
                  title={ticket.parentSuggestion!.reason || undefined} onClick={() => setWhy((v) => !v)}>
                  Add to “{suggested.title}”?
                </button>
                <button className="mini-link part-suggest-add" disabled={busy} onClick={() => link(suggested.id)}>Add</button>
                <button className="icon-btn part-suggest-x" aria-label="Other choices: pick another ticket, or not related" title="Pick another or not related"
                  onClick={() => setDeclining(true)}>✕</button>
              </>
            )}
          </span>
        ) : (
          <button className="mini-link" disabled={busy} onClick={() => setPicking(true)}>Link to a ticket…</button>
        )}
      </div>
      {picking && <ParentPicker ticket={ticket} tickets={tickets} onPick={link} onCancel={() => setPicking(false)} />}
      {suggested && !picking && !declining && why && ticket.parentSuggestion!.reason && (
        <div className="parent-suggest-why">{ticket.parentSuggestion!.reason} <span className="muted">({columnLabel(suggested.status)})</span></div>
      )}
    </>
  );
}
