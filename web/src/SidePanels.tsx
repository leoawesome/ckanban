import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Huddle, Profile, Ticket } from "./api";
import { Changes, useTicketDiff } from "./Changes";
import { ConfirmDialog } from "./ConfirmDialog";
import { FilesView } from "./FilesView";
import {
  ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, CloseIcon, MaximizeIcon, MoreIcon, PlusIcon, RestoreIcon,
} from "./icons";
import { isNewChatKey, isTyping } from "./keynav";
import { KeyHint } from "./KeyHint";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { QuickChatPane } from "./QuickChat";
import { isMac } from "./Shortcuts";
import { clampChatWidth, COLUMN_MIN } from "./sideChatLayout";
import { useClaudeName } from "./AvatarFace";
import { PANELS, panelLabel, resizePair, shareOf, whereHint, type PanelId } from "./panelState";
import { TeamTab, type HuddleSeed, type TeamRequest } from "./Team";
import { TerminalView } from "./TerminalView";
import { toast } from "./toast";
import type { Panels } from "./usePanels";

/** What the column and the phone's panel screen need from the App. */
export interface PanelsProps {
  profile: Profile;
  /** The daemon can run a terminal (Bun 1.3.5+). */
  pty: boolean;
  panels: Panels;
  /** The ticket open in the ticket panel: Terminal and Files work in its copy of the folder, Changes shows its changes. */
  ticket: Ticket | null;
  /** Put the keyboard in this panel; `n` changes for each request. */
  focus: { id: PanelId; n: number } | null;
  /** Typed into the Terminal and run (e.g. from Connections); `n` changes for each new request. */
  command: { text: string; n: number } | null;
  onCommandSent: () => void;
  /** What the Team shows (the new-teammate editor, the huddles…); `n` changes for each new request. */
  teamRequest: { team: TeamRequest; n: number } | null;
  huddles: Huddle[];
  onOpenHuddle: (ticketId: string, huddleId?: string) => void;
  onOpenTicket: (id: string) => void;
  onStartHuddle: (seed: HuddleSeed) => void;
}

/** Where the keyboard lands when a panel opens (the Terminal focuses itself): the first match in its body. */
const FOCUS_ON_OPEN: Record<Exclude<PanelId, "terminal">, string[]> = {
  files: [".tree-row.selected", ".tree-row", ".file-filter input"],
  changes: [".changes-file.on", ".changes-file", "button"],
  team: ["[role=tablist] [aria-selected=true]", "button"],
  claude: [".qc-main textarea:not([disabled])", ".qc-main input:not([disabled])", ".qc-main button"],
};
/** A panel never gets shorter than its header plus a few lines while dragging a divider. */
const MIN_PANEL_PX = 90;
/** Terminals kept connected (hidden) for the folders visited last, so switching back shows the same screen at once. */
const KEEP_TERMINALS = 4;

/**
 * Focuses the first match of `selectors` in `root()` once the panel's content is there. Content may still be loading
 * (and re-render, dropping focus to the page): for a moment, look again on each frame, and focus again when focus fell
 * back to the page. Focus the user moved elsewhere is left alone.
 */
function useLandFocus(n: number | null | undefined, root: () => HTMLElement | null | undefined, selectors: () => string[] | null) {
  useEffect(() => {
    if (!n) return;
    const sels = selectors();
    if (!sels) return;
    const until = performance.now() + 1500;
    let frame = 0;
    let landed = false;
    const land = () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!landed || lost) {
        const el = root();
        const hit = el ? sels.map((s) => el.querySelector<HTMLElement>(s)).find(Boolean) : null;
        if (hit) {
          hit.focus({ preventScroll: true });
          landed = true;
        }
      }
      if (performance.now() < until) frame = requestAnimationFrame(land);
    };
    frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [n]);
}

/**
 * The side panel column on the right (computers): the open panels stacked top to bottom. Drag its left edge to change
 * its width, the line between two panels to share their height; click a header to fold a panel, ⤢ to fill the column
 * with it. App keeps it mounted once shown (hidden, not unmounted, when the Panels button hides it), so shells, drafts
 * and scroll survive. Closing a panel or hiding the column never stops anything: shells and Claude replies keep running.
 */
export default function SidePanels(props: PanelsProps & { width: number; ticketOpen: boolean }) {
  const { panels, width, ticketOpen } = props;
  const { open, shown, folded } = panels.state;
  const claude = useClaudeName();
  const column = useRef<HTMLElement>(null);
  const [max, setMax] = useState<PanelId | null>(null);
  // A maximised panel that closed or folded gives the column back to the others.
  const maxed = max && open.includes(max) && !folded.includes(max) ? max : null;
  // Opening (or focusing) another panel while one fills the column shows that one instead.
  useEffect(() => {
    if (props.focus && maxed && props.focus.id !== maxed) setMax(null);
  }, [props.focus?.n]);

  // Width: drag the left edge (or ←/→ on it, Shift for bigger steps); double-click resets. Saved when the drag ends.
  const [drag, setDrag] = useState<number | null>(null);
  const shownWidth = drag ?? width;
  const edge = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDrag(width);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (drag !== null) setDrag(clampChatWidth(window.innerWidth - e.clientX, window.innerWidth, ticketOpen));
    },
    onPointerUp: () => {
      if (drag === null) return;
      panels.setWidth(drag);
      setDrag(null);
    },
    onDoubleClick: () => panels.setWidth(null),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = e.shiftKey ? 120 : 40;
      panels.setWidth(clampChatWidth(width + (e.key === "ArrowLeft" ? step : -step), window.innerWidth, ticketOpen));
    },
  };
  useEffect(() => {
    if (drag === null) return;
    const stop = () => setDrag(null);
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, [drag !== null]);

  // The line between two panels: shares their combined height (panelState.ts resizePair).
  const sections = useRef<Partial<Record<PanelId, HTMLElement | null>>>({});
  const pairDrag = useRef<{ a: PanelId; b: PanelId; y: number; aPx: number; bPx: number; aShare: number; bShare: number } | null>(null);
  const startPair = (a: PanelId, b: PanelId, y: number) => {
    const aPx = sections.current[a]?.getBoundingClientRect().height ?? 0;
    const bPx = sections.current[b]?.getBoundingClientRect().height ?? 0;
    pairDrag.current = { a, b, y, aPx, bPx, aShare: shareOf(panels.state, a), bShare: shareOf(panels.state, b) };
  };
  const movePair = (delta: number) => {
    const d = pairDrag.current;
    if (!d) return;
    const [sa, sb] = resizePair(d.aShare, d.bShare, d.aPx, d.bPx, delta, MIN_PANEL_PX);
    panels.setShares({ [d.a]: sa, [d.b]: sb });
  };

  // Esc in the column (not in the Terminal, where Esc belongs to the shell): first leaves a text box, keeping what was
  // typed; then hides the column. The keyboard goes back to the ticket panel when one is open.
  const onEsc = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing || (e.target as HTMLElement).closest(".xterm")) return;
    e.preventDefault();
    if (isTyping(e)) return column.current?.focus({ preventScroll: true });
    const panel = document.querySelector<HTMLElement>(".drawer-wrap .panel");
    panels.hide();
    panel?.focus({ preventScroll: true });
  };

  const visible = (id: PanelId) => shown && !folded.includes(id) && (!maxed || maxed === id);
  return (
    <aside ref={column} className={`side-panels${drag !== null ? " resizing" : ""}`} style={{ width: shownWidth }} hidden={!shown}
      aria-label="Side panels" tabIndex={-1} onKeyDown={onEsc}>
      <div className="side-panels-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panels" tabIndex={0}
        aria-valuenow={shownWidth} aria-valuemin={COLUMN_MIN} title="Drag (or ←→) to resize · double-click to reset" {...edge}
        onPointerCancel={edge.onPointerUp} />
      {open.map((id, i) => {
        const prev = open[i - 1];
        const divider = !!prev && !maxed && !folded.includes(prev) && !folded.includes(id);
        return (
          <Fragment key={id}>
            {divider && (
              <div className="sp-divider" role="separator" aria-orientation="horizontal" tabIndex={0}
                aria-label={`Share the height between ${panelLabel(prev, claude)} and ${panelLabel(id, claude)}`} title="Drag (or ↑↓) to share the height"
                onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startPair(prev, id, e.clientY); }}
                onPointerMove={(e) => pairDrag.current && movePair(e.clientY - pairDrag.current.y)}
                onPointerUp={() => (pairDrag.current = null)} onPointerCancel={() => (pairDrag.current = null)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  startPair(prev, id, 0);
                  movePair((e.key === "ArrowDown" ? 1 : -1) * (e.shiftKey ? 120 : 40));
                  pairDrag.current = null;
                }} />
            )}
            <PanelFrame id={id} props={props} first={i === 0} last={i === open.length - 1} maxed={maxed === id}
              hidden={!!maxed && maxed !== id} visible={visible(id)}
              onMax={() => {
                if (maxed === id) return setMax(null);
                if (folded.includes(id)) panels.fold(id);
                setMax(id);
              }}
              sectionRef={(el) => { sections.current[id] = el; }} />
          </Fragment>
        );
      })}
    </aside>
  );
}

/** One panel in the column: its header (title, where it works, ⋯, maximise, close) and its content. */
function PanelFrame({ id, props, first, last, maxed, hidden, visible, onMax, sectionRef }: {
  id: PanelId;
  props: PanelsProps;
  first: boolean;
  last: boolean;
  maxed: boolean;
  hidden: boolean;
  visible: boolean;
  onMax: () => void;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const { panels, ticket } = props;
  const label = panelLabel(id, useClaudeName());
  const folded = panels.state.folded.includes(id);
  const where = whereHint(id, ticket);
  const body = useRef<HTMLDivElement>(null);
  const actions = usePanelActions(id, props);
  const focusN = props.focus?.id === id ? props.focus.n : null;
  useLandFocus(id === "terminal" ? null : focusN, () => body.current, () => (id === "terminal" ? null : FOCUS_ON_OPEN[id]));
  const bodyId = `sp-body-${id}`;
  return (
    <section ref={sectionRef} className={`sp-panel${folded ? " folded" : ""}${maxed ? " maxed" : ""}`} hidden={hidden} aria-label={`${label} panel`}
      style={folded || maxed ? undefined : { flexGrow: shareOf(panels.state, id) }} data-panel={id}>
      <div className="sp-head">
        <button className="sp-title" aria-expanded={!folded} aria-controls={bodyId} onClick={() => panels.fold(id)}
          title={`${folded ? "Unfold" : "Fold"} ${label}${where ? ` · works in the ${where}${ticket && where === "ticket copy" ? ` of “${ticket.title}”` : ""}` : ""}`}>
          {folded ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
          <span className="sp-label">{label}</span>
          {where && <span className="sp-where">{where}</span>}
        </button>
        <PanelMenu label={label} items={[
          ...actions.menu,
          ...(!first ? [{ label: "Move up", onSelect: () => panels.move(id, -1) }] : []),
          ...(!last ? [{ label: "Move down", onSelect: () => panels.move(id, 1) }] : []),
        ]} />
        <button className="icon-btn sp-icon" onClick={onMax} aria-pressed={maxed} aria-label={maxed ? `Restore ${label}` : `Maximise ${label}`}
          title={maxed ? "Show the other panels again" : "Fill the column with this panel"}>
          {maxed ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button className="icon-btn sp-icon" onClick={() => panels.close(id)} aria-label={`Close ${label}`}
          title={`Close ${label}${id === "terminal" ? ". The shell keeps running." : id === "claude" ? `. ${label}'s replies keep running.` : ""}`}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="sp-body" id={bodyId} ref={body} hidden={folded}>
        <PanelBody id={id} props={props} visible={visible} phone={false} extra={actions} />
      </div>
      {actions.dialogs}
    </section>
  );
}

type MenuItem = { label: string; onSelect: () => void };

/** A panel's own actions: in its ⋯ menu (Restart the shell, Refresh…) and the counters its content reacts to. */
function usePanelActions(id: PanelId, props: PanelsProps) {
  const [restart, setRestart] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [team, setTeam] = useState<{ team: TeamRequest; n: number } | null>(null);
  const menu: MenuItem[] = id === "terminal" && props.pty ? [{ label: "Restart the shell…", onSelect: () => setConfirmRestart(true) }]
    : id === "files" ? [{ label: "Refresh", onSelect: () => setRefresh((n) => n + 1) }]
    : id === "team" ? [
      { label: "Huddles", onSelect: () => setTeam({ team: { action: "huddles" }, n: Date.now() }) },
      { label: "New teammate…", onSelect: () => setTeam({ team: { action: "new" }, n: Date.now() }) },
    ] : [];
  const folder = props.ticket?.worktree ? "this ticket's copy of the folder" : "the board folder";
  return {
    restart, refresh, team, menu,
    dialogs: confirmRestart ? (
      <ConfirmDialog title="Restart the shell?" confirmLabel="Restart" busyLabel="Restarting…"
        onCancel={() => setConfirmRestart(false)} onConfirm={() => { setConfirmRestart(false); setRestart((n) => n + 1); }}>
        <p>Stops whatever is running in this terminal and starts a fresh shell in {folder}.</p>
      </ConfirmDialog>
    ) : null,
  };
}

/** The ⋯ menu in a panel's header. */
function PanelMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setOpen(false);
    button.current?.focus();
  }, { active: open });
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  if (!items.length) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className="sp-more" ref={root}>
      <button ref={button} className="icon-btn sp-icon" aria-label={`More for ${label}`} title="More" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <MoreIcon size={14} />
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="sp-menu" role="menu" onKeyDown={onKey}>
            {items.map((it) => (
              <button key={it.label} role="menuitem" className="menu-item" onClick={() => { setOpen(false); it.onSelect(); }}>
                <span className="menu-label">{it.label}</span>
              </button>
            ))}
          </div>
        </MenuSheet>
      )}
    </div>
  );
}

/** A panel's content. `visible`: on screen (not folded, hidden or behind another one). */
function PanelBody({ id, props, visible, phone, extra }: {
  id: PanelId;
  props: PanelsProps;
  visible: boolean;
  phone: boolean;
  extra: ReturnType<typeof usePanelActions>;
}) {
  const { profile, ticket } = props;
  const slug = profile.slug;
  // Terminal and Files work in the open ticket's copy of the folder, else the board folder.
  const folder = ticket?.worktree ? ticket.id : null;
  if (id === "terminal") {
    if (!props.pty) return <PtyUnsupported />;
    return <TerminalPanel slug={slug} folder={folder} active={visible} focus={props.focus?.id === "terminal" ? props.focus.n : 0}
      restart={extra.restart} command={props.command} onCommandSent={props.onCommandSent} />;
  }
  if (id === "files") return <FilesView key={`${slug}:${folder ?? ""}`} slug={slug} ticket={folder} refreshSignal={extra.refresh} narrow />;
  if (id === "changes") {
    if (!ticket) return <Empty>Open a ticket to see its changes.</Empty>;
    return <ChangesPanel key={ticket.id} slug={slug} ticket={ticket} />;
  }
  if (id === "team") {
    const request = extra.team && (!props.teamRequest || extra.team.n > props.teamRequest.n) ? extra.team : props.teamRequest;
    return (
      <TeamTab key={slug} slug={slug} boardName={profile.name} active={visible} openTicket={ticket ? { id: ticket.id, title: ticket.title } : null}
        onOpenHuddle={props.onOpenHuddle} onOpenTicket={props.onOpenTicket} request={request ? { ...request.team, n: request.n } : null}
        onStartHuddle={props.onStartHuddle} huddles={props.huddles} />
    );
  }
  return phone
    ? <QuickChatPane key={slug} profile={profile} phone onOpenTicket={props.onOpenTicket} />
    : <ClaudePanel key={slug} profile={profile} active={visible} onOpenTicket={props.onOpenTicket} />;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="sp-empty">{children}</div>;
}

function PtyUnsupported() {
  return (
    <Empty>
      The terminal needs Bun 1.3.5 or newer on the machine running the board. Run <code>brew upgrade bun</code>, then <code>ckanban restart</code>.
    </Empty>
  );
}

/**
 * Terminals for the folders visited last: the open ticket's copy or the board folder. Switching tickets hides one and
 * shows (or connects) the other; nothing is stopped, the shells keep running on the server (one per folder), and a
 * folder visited long ago reconnects to its still-running shell, which replays its recent output.
 */
function TerminalPanel({ slug, folder, active, focus, restart, command, onCommandSent }: {
  slug: string;
  /** The ticket whose copy the shell runs in; null: the board folder. */
  folder: string | null;
  active: boolean;
  focus: number;
  restart: number;
  command: { text: string; n: number } | null;
  onCommandSent: () => void;
}) {
  const key = folder ?? "";
  const [kept, setKept] = useState<string[]>([key]);
  const list = kept.includes(key) ? kept : [key, ...kept].slice(0, KEEP_TERMINALS);
  if (list !== kept) setKept(list);
  // Restart and focus requests go to the terminal shown when they're made, never to one shown later.
  const [restarts, setRestarts] = useState<Record<string, number>>({});
  const [focusFor, setFocusFor] = useState<{ key: string; n: number }>({ key, n: 0 });
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (restart) setRestarts((r) => ({ ...r, [keyRef.current]: (r[keyRef.current] ?? 0) + 1 }));
  }, [restart]);
  useEffect(() => {
    if (focus) setFocusFor({ key: keyRef.current, n: focus });
  }, [focus]);
  return (
    <div className="sp-terminals">
      {list.map((k) => (
        <div key={`${slug}:${k}`} className="sp-terminal" hidden={k !== key}>
          <TerminalView slug={slug} ticket={k || null} active={active && k === key} focusSignal={focusFor.key === k ? focusFor.n : 0}
            restartSignal={restarts[k] ?? 0} command={k === key ? command : null} onCommandSent={onCommandSent} />
        </div>
      ))}
    </div>
  );
}

/** The open ticket's changes, the same view as its Changes tab (one pane at a time in the column). */
function ChangesPanel({ slug, ticket }: { slug: string; ticket: Ticket }) {
  const diff = useTicketDiff(slug, ticket);
  return (
    <div className="sp-changes">
      <Changes slug={slug} ticket={ticket} state={diff} compact
        onSent={() => toast("Comments sent to Claude in the ticket's chat.", { tone: "ok" })}
        onError={(msg) => toast(msg, { tone: "error" })} />
    </div>
  );
}

/**
 * The quick chats with Claude in the board folder (QuickChatPane, no ticket): what used to be the side chat. Past chats
 * slide in over the conversation when asked; ⌘⇧O starts a new chat while the panel shows. Hiding it never stops Claude.
 */
function ClaudePanel({ profile, active, onOpenTicket }: { profile: Profile; active: boolean; onOpenTicket: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const historyBtn = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState(false);
  const closeHistory = (focusButton = false) => {
    setHistory(false);
    if (focusButton) historyBtn.current?.focus({ preventScroll: true });
  };
  // Esc closes the list first: a layer on top of everything (ticket panel included) while it is open.
  useLayer(() => closeHistory(true), { active: history });
  useEffect(() => {
    if (!history) return;
    const list = root.current?.querySelector<HTMLElement>(".qc-list");
    // The keyboard goes to the open chat's row (or the first one).
    list?.querySelector<HTMLElement>(".qc-row.cur, .qc-row")?.focus({ preventScroll: true });
    // Picking a chat (or New chat) in the list closes it; so does a click anywhere outside it but the Chats button.
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".qc-row")) setHistory(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list?.contains(t) && !historyBtn.current?.contains(t)) setHistory(false);
    };
    list?.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      list?.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [history]);
  // New chat: the list's own New chat button (the list may be hidden).
  const newChat = () => {
    root.current?.querySelector<HTMLElement>(".qc-list .qc-new")?.click();
    setHistory(false);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".qc-main textarea:not([disabled])")?.focus({ preventScroll: true }));
  };
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isNewChatKey(e)) return;
      e.preventDefault();
      newChatRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  return (
    <div ref={root} className={`claude-panel${history ? " history-open" : ""}`}>
      <div className="claude-panel-bar">
        <button ref={historyBtn} className={`btn ghost small icon-label${history ? " on" : ""}`} onClick={() => setHistory((o) => !o)}
          aria-expanded={history} aria-pressed={history} title="Past chats in this folder" aria-label="Past chats">
          <ClockIcon size={14} /> Chats
        </button>
        <div className="spacer" />
        <button className="btn ghost small icon-label" onClick={newChat} title={`Start a new chat (${isMac ? "⌘⇧O" : "Ctrl+Shift+O"})`}>
          <PlusIcon size={14} /> New chat<KeyHint keys="⌘⇧O" />
        </button>
      </div>
      <div className="claude-panel-body">
        <QuickChatPane profile={profile} phone={false} onOpenTicket={onOpenTicket} />
      </div>
    </div>
  );
}

/**
 * Phones: no column. The panel shown fills the screen, with Back (to the board, the panels stay open) and Close (this
 * panel), and a row of chips to switch between the open panels plus "+ Add".
 */
export function PhonePanels(props: PanelsProps & { shown: PanelId; onShow: (id: PanelId | null) => void }) {
  const { panels, shown, onShow, ticket } = props;
  const claude = useClaudeName();
  const open = panels.state.open.includes(shown) ? panels.state.open : [...panels.state.open, shown];
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useLayer(() => (adding ? setAdding(false) : onShow(null)), { skipInInputs: true });
  useEffect(() => {
    if (!adding) return;
    const away = (e: MouseEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAdding(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [adding]);
  const close = () => {
    const rest = open.filter((p) => p !== shown);
    panels.close(shown);
    onShow(rest[Math.max(0, open.indexOf(shown) - 1)] ?? null);
  };
  const closed = PANELS.filter((p) => !open.includes(p.id));
  const where = whereHint(shown, ticket);
  return (
    <div className="phone-panels" role="dialog" aria-modal="true" aria-label={`${panelLabel(shown, claude)} panel`}>
      <div className="pp-top">
        <button className="icon-btn pp-btn" onClick={() => onShow(null)} aria-label="Back to the board"><ChevronLeftIcon size={20} /></button>
        <b className="pp-title">{panelLabel(shown, claude)}</b>
        <button className="icon-btn pp-btn" onClick={close} aria-label={`Close ${panelLabel(shown, claude)}`}><CloseIcon size={20} /></button>
      </div>
      <div className="pp-chips" role="tablist" aria-label="Open panels">
        {open.map((id) => (
          <button key={id} role="tab" aria-selected={id === shown} className={`chip${id === shown ? " on" : ""}`} onClick={() => onShow(id)}>{panelLabel(id, claude)}</button>
        ))}
        {closed.length > 0 && (
          <div className="pp-add" ref={addRef}>
            <button className="chip" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>+ Add</button>
            {adding && (
              <MenuSheet onClose={() => setAdding(false)}>
                <div className="sp-menu" role="menu">
                  {closed.map((p) => (
                    <button key={p.id} role="menuitem" className="menu-item" onClick={() => { setAdding(false); panels.open(p.id); onShow(p.id); }}>
                      <span className="menu-label">{panelLabel(p.id, claude)}</span>
                    </button>
                  ))}
                </div>
              </MenuSheet>
            )}
          </div>
        )}
      </div>
      {where && <div className="pp-where">{where}{ticket && where === "ticket copy" ? ` · ${ticket.title}` : ""}</div>}
      <div className="pp-body">
        {open.map((id) => <PhonePane key={id} id={id} props={props} visible={id === shown} />)}
      </div>
    </div>
  );
}

function PhonePane({ id, props, visible }: { id: PanelId; props: PanelsProps; visible: boolean }) {
  const actions = usePanelActions(id, props);
  return (
    <div className="pp-pane" hidden={!visible}>
      <PanelBody id={id} props={props} visible={visible} phone extra={actions} />
      {actions.dialogs}
    </div>
  );
}
