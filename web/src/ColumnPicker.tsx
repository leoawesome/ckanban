import { useState } from "react";
import type { Status, Ticket } from "./api";
import { boardColumnOf, menuPick, STATUS_MENU } from "./columns";
import { CheckIcon } from "./icons";
import { listKey, stepIndex } from "./keynav";
import { Modal } from "./Modal";

/**
 * M on a focused board card: pick the column to move it to, like the ticket panel's Status picker.
 * ↑↓ (or J K) move, Enter picks, 1…6 picks that row, Esc closes. In Progress queues the ticket, as on the panel.
 */
export function ColumnPicker({ ticket, onPick, onClose }: { ticket: Ticket; onPick: (status: Status) => void; onClose: () => void }) {
  const here = boardColumnOf(ticket);
  const [active, setActive] = useState(() => Math.max(0, STATUS_MENU.findIndex((c) => c.id === here)));
  const pick = (i: number) => {
    const c = STATUS_MENU[i];
    if (!c) return;
    if (c.id === here) return onClose();
    onPick(menuPick(ticket, c.id));
  };
  return (
    <Modal title="Move to column" onClose={onClose}>
      <div className="form switcher">
        <p className="muted small column-picker-what">{ticket.title}</p>
        <div className="switcher-list" role="listbox" aria-label="Columns" tabIndex={0} aria-activedescendant={`cp-${STATUS_MENU[active]?.id}`}
          onKeyDown={(e) => {
            const k = listKey(e.nativeEvent);
            if (!k) return;
            e.preventDefault();
            if ("move" in k) setActive((a) => stepIndex(STATUS_MENU.length, a, k.move));
            else pick(k.pick === "active" ? active : k.pick);
          }}>
          {STATUS_MENU.map((c, i) => (
            <div key={c.id} id={`cp-${c.id}`} role="option" aria-selected={i === active}
              className={`switcher-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
              <span className="profile-body">
                <span className="profile-name">{c.label}</span>
                {c.hint && <span className="profile-path">{c.hint}</span>}
              </span>
              {c.id === here && <span className="profile-check" aria-label="Current column"><CheckIcon size={14} /></span>}
              <kbd aria-label={`Key ${i + 1}`}>{i + 1}</kbd>
            </div>
          ))}
        </div>
        <div className="muted small switcher-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> pick</span>
          <span><kbd>Enter</kbd> move</span>
          <span><kbd>1…{STATUS_MENU.length}</kbd> that column</span>
        </div>
      </div>
    </Modal>
  );
}
