import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, PanelsIcon } from "./icons";
import { useLayer } from "./layers";
import { PANELS, panelLabel, type PanelId } from "./panelState";
import { useClaudeName } from "./AvatarFace";
import type { Panels } from "./usePanels";

/**
 * The top bar's Panels button: the main part shows or hides the side column (with how many panels are open); the ▾
 * part opens a menu of checkboxes, one per panel (Terminal, Files, Changes, Team, Claude), which stays open while
 * picking. `badges`: extras shown on a panel's row and on the button (Team: live huddles, new lessons).
 */
export function PanelsButton({ panels, onOpen, badges = {} }: {
  panels: Panels;
  /** Checking a panel opens it in the column (and puts the keyboard in it). */
  onOpen: (id: PanelId) => void;
  badges?: Partial<Record<PanelId, ReactNode>>;
}) {
  const { open, shown } = panels.state;
  const claude = useClaudeName();
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setMenu(false);
    caret.current?.focus();
  }, { active: menu });
  useEffect(() => {
    if (!menu) return;
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[role=menuitemcheckbox]")?.focus());
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(root.current?.querySelectorAll<HTMLElement>(".panels-menu [role^=menuitem]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") setMenu(false);
  };
  const count = open.length;
  const extra = Object.entries(badges).filter(([id]) => !(shown && open.includes(id as PanelId))).map(([, b]) => b);
  return (
    <div className="panels-btn tool-group" ref={root} role="group" aria-label="Side panels">
      <button className={`btn ghost icon-label${shown ? " on" : ""}`} aria-pressed={shown}
        onClick={() => (count ? panels.toggleColumn() : setMenu(true))}
        title={count ? `${shown ? "Hide" : "Show"} the side panels (${count} open). Hiding them keeps shells and chats running.` : "Choose side panels to open"}
        aria-label={count ? `Side panels, ${count} open` : "Side panels"}>
        <PanelsIcon /><span className="label">Panels</span>
        {count > 0 && <span className="panels-count" aria-hidden>{count}</span>}
        {extra.length > 0 && <span className="tab-counts">{extra}</span>}
      </button>
      <button ref={caret} className="btn ghost panels-caret" aria-haspopup="menu" aria-expanded={menu} aria-label="Choose panels" title="Choose panels"
        onClick={() => setMenu((m) => !m)}>
        <ChevronDownIcon size={12} />
      </button>
      {menu && (
        <div className="inbox-menu panels-menu" role="menu" aria-label="Side panels" onKeyDown={onKey}>
          {PANELS.map((p) => {
            const on = open.includes(p.id);
            return (
              <button key={p.id} role="menuitemcheckbox" aria-checked={on} className="menu-item"
                onClick={() => (on ? panels.close(p.id) : onOpen(p.id))}>
                <span className={`panels-check${on ? " on" : ""}`} aria-hidden>{on && <CheckIcon size={12} />}</span>
                <span className="menu-label">{panelLabel(p.id, claude)}</span>
                {badges[p.id]}
                {p.keys && <kbd>{p.keys}</kbd>}
              </button>
            );
          })}
          <div className="menu-sep" role="separator" />
          <button role="menuitem" className="menu-item" disabled={!count} onClick={() => { panels.toggleColumn(); setMenu(false); }}>
            <span className="panels-check" aria-hidden />
            <span className="menu-label">{shown ? "Hide the column" : "Show the column"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
