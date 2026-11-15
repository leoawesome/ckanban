import { useRef, useState } from "react";
import type { Status, Ticket } from "../lib/api";
import { boardColumnOf, menuPick, STATUS_MENU } from "../features/board/columns";
import { CheckIcon } from "./icons";
import { Modal } from "./Modal";
import { Select } from "./Select";

/** The Move to list's hints: Done says where the panel goes next. */
const hintOf = (id: Status, hint: string) => (id === "done" ? "Finished, then on to the next card in this column" : hint);

/**
 * The pill under the ticket's title: the column it sits in, in that column's colour, with ▾. A tap opens Move to, every
 * column with its hint and the current one ticked; one tap moves the ticket (`onPick` gets the status to save, as the
 * Status picker's). Phones: a bottom sheet. Desktop: a dropdown like the other Selects.
 */
export function StatusPill({ ticket, phone, onPick }: { ticket: Ticket; phone: boolean; onPick: (status: Status) => void }) {
  const here = boardColumnOf(ticket);
  const label = STATUS_MENU.find((c) => c.id === here)?.label ?? here;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pick = (id: Status) => {
    setOpen(false);
    if (id !== here) onPick(menuPick(ticket, id));
  };
  if (!phone) {
    return (
      <Select className={`status-pill sp-col-${here}`} menuClassName="status-pill-menu" menuMaxHeight={480} ariaLabel={`Column: ${label}. Move to`} value={here}
        options={STATUS_MENU.map((c) => ({ value: c.id, label: c.label, hint: hintOf(c.id, c.hint) }))} onChange={pick}
        renderValue={() => <><span className="sp-dot" aria-hidden />{label}</>}
        renderOption={(o, selected) => (
          <span className={`sp-opt sp-col-${o.value}${selected ? " current" : ""}`}>
            <span className="sp-dot" aria-hidden />
            <span className="sp-text"><span className="sp-label">{o.label}</span><span className="sp-hint">{o.hint}</span></span>
            <span className="sp-check" aria-hidden>{selected && <CheckIcon size={14} />}</span>
          </span>
        )} />
    );
  }
  return (
    <>
      <button ref={button} type="button" className={`status-pill sp-button sp-col-${here}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Column: ${label}. Move to`} onClick={() => setOpen(true)}>
        <span className="sp-dot" aria-hidden />{label}<span className="sp-chev" aria-hidden>▾</span>
      </button>
      {open && (
        <Modal title="Move to" className="status-pill-sheet" focusDialog onClose={() => { setOpen(false); button.current?.focus(); }}>
          <div className="sp-list" role="group" aria-label="Columns">
            {STATUS_MENU.map((c) => (
              <button key={c.id} type="button" className={`sp-opt sp-row sp-col-${c.id}${c.id === here ? " current" : ""}`}
                aria-current={c.id === here ? "true" : undefined} onClick={() => pick(c.id)}>
                <span className="sp-dot" aria-hidden />
                <span className="sp-text"><span className="sp-label">{c.label}</span><span className="sp-hint">{hintOf(c.id, c.hint)}</span></span>
                <span className="sp-check" aria-hidden>{c.id === here && <CheckIcon size={16} />}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
