import { useEffect, useRef, useState } from "react";
import type { Huddle, Profile } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import { TeamTab, type HuddleSeed, type TeamRequest } from "./Team";
import { CloseIcon, RefreshIcon } from "./icons";
import { TerminalView } from "./TerminalView";
import { isTyping } from "./keynav";

/** The quick Claude chat lives in its own side panel now (SideChat.tsx). */
export type DockTab = "terminal" | "files" | "team";
const TAB_KEY = "ckanban.dock.tab";
/** Each item keeps its own height under `${HEIGHT_KEY}.<item>`; the old shared height seeds them. */
const HEIGHT_KEY = "ckanban.dock.height";
const MIN_HEIGHT = 140;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export const DOCK_ITEMS: Record<DockTab, { label: string; height: number }> = {
  terminal: { label: "Terminal", height: 280 },
  files: { label: "Files", height: 400 },
  team: { label: "Team", height: 340 },
};
const isTab = (v: string | null): v is DockTab => !!v && v in DOCK_ITEMS;
/** The item shown when the panel opens without a request: the last one open (the old Huddles tab now lives in Team;
 * the old Claude item is the side chat, so a panel last left on it opens the Terminal). */
export function lastDockTab(): DockTab {
  const t = stored(TAB_KEY);
  return t === "huddles" ? "team" : isTab(t) ? t : "terminal";
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Where the keyboard lands when an item opens (the Terminal focuses itself): the first match in its pane. */
const FOCUS_ON_OPEN: Record<Exclude<DockTab, "terminal">, string[]> = {
  files: [".tree-row.selected", ".tree-row", ".file-filter input"],
  team: ["[role=tablist] [aria-selected=true]", "button"],
};
const clampHeight = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 120, h)));
const storedHeight = (tab: DockTab) => clampHeight(Number(stored(`${HEIGHT_KEY}.${tab}`)) || Number(stored(HEIGHT_KEY)) || DOCK_ITEMS[tab].height);

/**
 * Bottom panel for the selected profile's folder. It shows one item at a time, picked by the header buttons:
 * an interactive shell, a read-only file browser or the Team (teammates, templates, huddles). The quick Claude
 * chat is a side panel (SideChat.tsx). Hiding an item or the panel never stops it: the shell keeps running on the server.
 */
export default function Dock({ profile, pty, onClose, command, onCommandSent, tabRequest, onTabChange, onOpenTicket, huddles = [], onOpenHuddle, openTicket = null, onStartHuddle }: {
  profile: Profile;
  pty: boolean;
  onClose: () => void;
  /** Typed into the shell and run (e.g. from Connections); `n` changes for each new request. */
  command?: { text: string; n: number } | null;
  onCommandSent?: () => void;
  /** Show this item (e.g. from a header button or shortcut); `n` changes for each new request. team: what the Team shows. */
  tabRequest?: { tab: DockTab; n: number; team?: TeamRequest } | null;
  /** The shown item, so the header buttons can show which one is open. */
  onTabChange?: (tab: DockTab) => void;
  onOpenTicket?: (id: string) => void;
  /** The board's huddles (kept live by the App), for the Team's Huddles view. */
  huddles?: Huddle[];
  /** Open a ticket's Huddle tab; with huddleId, on that huddle (an earlier round). */
  onOpenHuddle?: (ticketId: string, huddleId?: string) => void;
  /** The ticket open in the drawer (the Team's Start huddle goes there). */
  openTicket?: { id: string; title: string } | null;
  /** The Team's Start huddle: a roster with a teammate, or a template. */
  onStartHuddle?: (seed: HuddleSeed) => void;
}) {
  const [tab, setTab] = useState<DockTab>(() => tabRequest?.tab ?? lastDockTab());
  const [heights, setHeights] = useState(() => Object.fromEntries((Object.keys(DOCK_ITEMS) as DockTab[]).map((t) => [t, storedHeight(t)])) as Record<DockTab, number>);
  const height = heights[tab];
  const setHeight = (f: (h: number) => number) => setHeights((hs) => {
    const h = f(hs[tab]);
    store(`${HEIGHT_KEY}.${tab}`, String(h));
    return { ...hs, [tab]: h };
  });
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const drag = useRef<{ y: number; h: number } | null>(null);
  // The Team stays mounted once shown, so its editor and selection survive switching items.
  const [teamSeen, setTeamSeen] = useState(false);
  useEffect(() => {
    if (tab === "team") setTeamSeen(true);
  }, [tab]);

  useEffect(() => {
    store(TAB_KEY, tab);
    onTabChange?.(tab);
  }, [tab]);
  useEffect(() => {
    if (command) setTab("terminal");
  }, [command?.n]);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest?.n]);
  // Opening Files or Team (its button, its key, ⌘K) puts the keyboard in it. Its content may still be loading
  // (and re-render, dropping focus to the page): for a moment, look again on each frame, and focus again when focus fell
  // back to the page. Focus the user moved elsewhere is left alone.
  const panes = useRef<Partial<Record<DockTab, HTMLDivElement | null>>>({});
  useEffect(() => {
    const want = tabRequest?.tab;
    if (!want || want === "terminal") return;
    const until = performance.now() + 1500;
    let frame = 0;
    let landed = false;
    const land = () => {
      const pane = panes.current[want];
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!landed || lost) {
        const el = pane && !pane.hidden ? FOCUS_ON_OPEN[want].map((sel) => pane.querySelector<HTMLElement>(sel)).find(Boolean) : null;
        if (el) {
          el.focus({ preventScroll: true });
          landed = true;
        }
      }
      if (performance.now() < until) frame = requestAnimationFrame(land);
    };
    frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [tabRequest?.n]);
  // Esc (focus in the panel, not in the Terminal, where Esc belongs to the shell): first leaves a text box, keeping what
  // was typed; then hides the panel. The keyboard goes back to the ticket panel when one is open.
  const section = useRef<HTMLElement>(null);
  const onEsc = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing || (e.target as HTMLElement).closest(".xterm")) return;
    e.preventDefault();
    if (isTyping(e)) return section.current?.focus({ preventScroll: true });
    const panel = document.querySelector<HTMLElement>(".drawer-wrap .panel");
    onClose();
    panel?.focus({ preventScroll: true });
  };

  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setHeight((h) => clampHeight(h + (e.key === "ArrowUp" ? step : -step)));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = clampHeight(drag.current.h + drag.current.y - e.clientY);
    setHeight(() => h);
  };
  const onPointerUp = () => (drag.current = null);

  const label = DOCK_ITEMS[tab].label;
  return (
    <section ref={section} className="dock" style={{ height }} aria-label={label} tabIndex={-1} onKeyDown={onEsc}>
      <div className="dock-resize" role="separator" aria-orientation="horizontal" aria-label={`Resize ${label} panel`} tabIndex={0}
        aria-valuenow={height} aria-valuemin={MIN_HEIGHT}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onHandleKey}
        onDoubleClick={() => setHeight(() => clampHeight(DOCK_ITEMS[tab].height))} title={`Drag (or ↑↓) to resize · double-click to reset. ${label} keeps its own height.`} />
      <div className="dock-head">
        <span className="dock-title">{label}</span>
        {tab !== "team" && <span className="dock-path" title={profile.path}>{tildePath(profile.path)}</span>}
        <div className="spacer" />
        {tab === "terminal" && pty && (
          <button className="btn ghost small" onClick={() => setConfirmRestart(true)} title="Kill this shell and start a new one">
            Restart
          </button>
        )}
        {tab === "files" && (
          <button className="btn ghost small icon-label" onClick={() => setRefresh((n) => n + 1)}><RefreshIcon size={12} /> Refresh</button>
        )}
        <button className="icon-btn" onClick={onClose} title={`Hide ${label} (Esc${tab === "terminal" ? " outside the shell" : ""}). The shell keeps running.`} aria-label={`Hide ${label}`}>
          <CloseIcon />
        </button>
      </div>
      <div className="dock-body">
        <div className="dock-pane" hidden={tab !== "terminal"} ref={(el) => { panes.current.terminal = el; }}>
          {pty ? (
            <TerminalView key={profile.slug} slug={profile.slug} active={tab === "terminal"} restartSignal={restart} command={command ?? null} onCommandSent={onCommandSent} />
          ) : (
            <PtyUnsupported />
          )}
        </div>
        <div className="dock-pane" hidden={tab !== "files"} ref={(el) => { panes.current.files = el; }}>
          <FilesView key={profile.slug} slug={profile.slug} refreshSignal={refresh} />
        </div>
        <div className="dock-pane" hidden={tab !== "team"} ref={(el) => { panes.current.team = el; }}>
          {teamSeen && (
            <TeamTab key={profile.slug} slug={profile.slug} boardName={profile.name} active={tab === "team"} openTicket={openTicket} onOpenHuddle={onOpenHuddle} onOpenTicket={onOpenTicket}
              request={tabRequest?.tab === "team" && tabRequest.team ? { ...tabRequest.team, n: tabRequest.n } : null}
              onStartHuddle={(seed) => onStartHuddle?.(seed)} huddles={huddles} />
          )}
        </div>
      </div>
      {confirmRestart && (
        <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
          onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
          <p>Stops whatever is running in this terminal and starts a fresh shell in <code>{tildePath(profile.path)}</code>.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PtyUnsupported() {
  return (
    <div className="empty small">
      The terminal needs Bun 1.3.5 or newer on the machine running the daemon. Upgrade Bun
      (<code>bun upgrade</code> or <code>brew upgrade bun</code>), then run <code>ckanban restart</code>.
    </div>
  );
}
