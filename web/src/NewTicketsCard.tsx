import { useState } from "react";
import type { NewTicketDraft as Draft, Ticket } from "./api";
import { COLUMNS } from "./columns";
import { ImportantStar } from "./StarToggle";
import { TagChip } from "./Tags";
import { Markdown } from "./Transcript";

export { sameTitle } from "./proposalMatch";

/** Tickets a planner's chat proposed; Create adds each to Backlog, linked to the planner. */
export function NewTicketsCard({ drafts, created, parentId, onCreate, onOpen }: {
  drafts: Draft[];
  /** The ticket a draft already is (matched by key or proposed title, see createdFromDraft): the planner's child, or any ticket on the board with that title. */
  created: (d: Draft) => Ticket | undefined;
  /** The planner: a match that isn't its child is "Already on the board". */
  parentId?: string;
  onCreate: (d: Draft) => Promise<Ticket | null>;
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  // Bridges the gap until the new ticket arrives over SSE, so a fast second click can't create it twice.
  const [made, setMade] = useState<Map<number, Ticket>>(new Map());
  const createdAt = (d: Draft, i: number) => created(d) ?? made.get(i);
  const missing = drafts.map((d, i) => ({ d, i })).filter(({ d, i }) => !createdAt(d, i));
  const toggle = (set: Set<number>, i: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(i);
    else next.delete(i);
    return next;
  };

  const create = async (d: Draft, i: number) => {
    if (busy.has(i)) return;
    setBusy((b) => toggle(b, i, true));
    try {
      const t = await onCreate(d);
      if (t) setMade((m) => new Map(m).set(i, t));
    } finally {
      setBusy((b) => toggle(b, i, false));
    }
  };
  // One at a time, so the tickets land in Backlog in the proposed order.
  const createAll = async () => {
    for (const { d, i } of missing) await create(d, i);
  };

  return (
    <div className={`proposal new-tickets ${missing.length ? "" : "applied"}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed tickets · {drafts.length}</span>
        {missing.length > 1 && (
          <button className="btn primary small" disabled={busy.size > 0} onClick={createAll}>
            {busy.size > 0 ? "Creating…" : `Create all ${missing.length}`}
          </button>
        )}
      </div>
      {drafts.map((d, i) => {
        const t = createdAt(d, i);
        return (
          <div key={i} className={`new-ticket ${t ? "applied" : ""}`}>
            <div className="new-ticket-head">
              <button className="link-btn new-ticket-title" aria-expanded={open.has(i)}
                onClick={() => setOpen((o) => toggle(o, i, !o.has(i)))}>
                {open.has(i) ? "▾" : "▸"} {d.important && <ImportantStar />}{d.title}
              </button>
              {t ? (
                t.parentId === parentId || made.get(i) === t ? (
                  <button className="link-btn small" onClick={() => onOpen(t.id)} title={t.title === d.title ? undefined : `Now “${t.title}”`}>
                    Created, in {COLUMNS.find((c) => c.id === t.status)?.label ?? t.status}, open
                  </button>
                ) : (
                  <button className="link-btn small" onClick={() => onOpen(t.id)} title={`“${t.title}” is already a ticket on this board`}>Already on the board, open</button>
                )
              ) : (
                <button className="btn small" disabled={busy.has(i)} onClick={() => create(d, i)}>
                  {busy.has(i) ? "Creating…" : "Create"}
                </button>
              )}
            </div>
            {!!d.dependsOn?.length && (
              <span className="muted small">After: {d.dependsOn.map((k) => drafts.find((x) => x.key === k)?.title ?? k).join(", ")}</span>
            )}
            {!!d.needs?.length && <span className="muted small">Needs: {d.needs.join(", ")} (one ticket at a time)</span>}
            {!!d.tags?.length && <span className="draft-tags">{d.tags.map((g) => <TagChip key={g} name={g} />)}</span>}
            {open.has(i) && d.description && <div className="proposal-body"><Markdown text={d.description} /></div>}
          </div>
        );
      })}
      <span className="muted small">
        {missing.length ? "Each lands in Backlog, linked to this ticket. Nothing starts until you move it or start the plan."
          : drafts.every((d, i) => createdAt(d, i)?.parentId === parentId) ? "All created. Press Start plan in the details to run them in order, unattended."
          : "Nothing left to create: each one is already a ticket on the board."}
      </span>
    </div>
  );
}
