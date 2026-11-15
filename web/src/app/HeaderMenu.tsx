import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "../components/icons";
import { useLayer } from "../lib/layers";
import { MenuSheet } from "../components/MenuSheet";
import { ThemePicker } from "./ThemePicker";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  hint?: string;
  /** Right-aligned extra, e.g. a count or a need-chip. */
  badge?: ReactNode;
  title?: string;
  /** Draw a divider after this item. */
  separator?: boolean;
  /** Destructive (red), e.g. Stop agents in the huddle's phone sheet. */
  danger?: boolean;
}

/** "⋯" overflow menu at the end of the top bar for things you need now and then. ↑↓ move, Esc closes. */
export function HeaderMenu({ items, footer, alert, keyHint, label = "More", theme = true }: {
  items: MenuItem[]; footer?: string | null; alert?: boolean; keyHint?: ReactNode;
  /** The button's name (e.g. "Chat actions"). */
  label?: string;
  /** The theme picker at the end (the top bar's menu only). */
  theme?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setOpen(false);
    button.current?.focus();
  }, { active: open });

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem], [role=menuitemradio]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="header-menu" ref={root}>
      <button ref={button} className="icon-btn more-btn" aria-label={alert ? `${label} (something needs attention)` : label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <MoreIcon size={16} />
        {alert && <span className="more-dot" aria-hidden />}
        {keyHint}
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="inbox-menu header-menu-list" role="menu" ref={menu} onKeyDown={onKey}>
            {items.map((it) => (
              <Fragment key={it.label}>
                <button role="menuitem" className={`menu-item${it.danger ? " danger" : ""}`} title={it.title} onClick={() => { setOpen(false); it.onSelect(); }}>
                  <span className="menu-icon" aria-hidden>{it.icon}</span>
                  <span className="menu-label">{it.label}</span>
                  {it.badge}
                  {it.hint && <kbd>{it.hint}</kbd>}
                </button>
                {it.separator && <div className="menu-sep" role="separator" />}
              </Fragment>
            ))}
            {theme && <ThemePicker />}
            {footer && <div className="menu-footer muted small">{footer}</div>}
          </div>
        </MenuSheet>
      )}
    </div>
  );
}
