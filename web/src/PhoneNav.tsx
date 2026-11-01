import type { ReactNode } from "react";
import type { MenuItem } from "./HeaderMenu";
import { BoardIcon, ChatIcon, MoreIcon, NowIcon, TeamIcon } from "./icons";
import { useLayer } from "./layers";

export type PhoneTab = "now" | "board" | "ask" | "team";

/** Bottom tab bar on phones (≤720px): Now · Board · Ask · Team · More (Schedules is in More). */
export function PhoneNav({ tab, onTab, needYou, liveHuddles, teamAlert, onMore, moreAlert }: {
  tab: PhoneTab;
  onTab: (t: PhoneTab) => void;
  needYou: number;
  /** Live huddles on this board: a count on Team. */
  liveHuddles: number;
  /** Lessons the board saved since the user last looked: a dot on Team. */
  teamAlert: boolean;
  onMore: () => void;
  moreAlert: boolean;
}) {
  const item = (label: string, icon: ReactNode, on: boolean, onClick: () => void, badge?: ReactNode) => (
    <button className={`pn-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={onClick}>
      <span className="pn-icon">{icon}{badge}</span>
      <span className="pn-label">{label}</span>
    </button>
  );
  return (
    <nav className="phone-nav" aria-label="Sections">
      {item("Now", <NowIcon size={20} />, tab === "now", () => onTab("now"), needYou > 0 && <span className="pn-badge">{needYou}</span>)}
      {item("Board", <BoardIcon size={20} />, tab === "board", () => onTab("board"))}
      {item("Ask", <ChatIcon size={20} />, tab === "ask", () => onTab("ask"))}
      {item("Team", <TeamIcon size={20} />, tab === "team", () => onTab("team"),
        liveHuddles > 0 ? <span className="pn-badge" title={`${liveHuddles} live ${liveHuddles === 1 ? "huddle" : "huddles"}`}>{liveHuddles}</span> : teamAlert && <span className="pn-dot" />)}
      {item("More", <MoreIcon size={20} />, false, onMore, moreAlert && <span className="pn-dot" />)}
    </nav>
  );
}

/** More: the header menu as a bottom sheet, plus whatever the phone top bar has no room for. */
export function MoreSheet({ items, footer, onClose, label = "More", top, bottom }: {
  items: MenuItem[];
  footer?: string | null;
  onClose: () => void;
  label?: string;
  /** Shown above the items (the phone More sheet's usage box). */
  top?: ReactNode;
  /** Shown below the items, above the footer (the theme choice). */
  bottom?: ReactNode;
}) {
  useLayer(onClose);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="menu" aria-label={label}>
        <span className="sheet-grip" aria-hidden />
        {top}
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={`sheet-item${it.separator ? " sep" : ""}${it.danger ? " danger" : ""}`} title={it.title}
            onClick={() => { onClose(); it.onSelect(); }}>
            {it.icon}<span className="sheet-label">{it.label}</span>{it.badge}
          </button>
        ))}
        {bottom}
        {footer && <div className="sheet-foot muted small">{footer}</div>}
      </div>
    </div>
  );
}
