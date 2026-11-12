import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteTitle, parkNeedsConfirm, parkText, parkTitle, runningTools, stopTitle, toolCount } from "./familyActions";
import { api, COLUMNS, safeHref, startWorkTarget, subscribe, type ClaudeSession, type Job, type Profile, type Status, type Ticket } from "./api";
import { boardColumnOf, menuPick, STATUS_MENU } from "./columns";
import { PANEL_LEAVE_MS, reducedMotion } from "./motion";
import { finishBadge, huddleBadge, outcomeBadge, useFinishMark } from "./Card";
import { featureBusy } from "./cardState";
import { JobChip } from "./Jobs";
import { CapActions } from "./CapActions";
import { capLabel, capWait } from "./capText";
import { LimitActions } from "./LimitActions";
import { StallActions, stallWait } from "./StallActions";
import { limitHint, limitLabel, limitWait } from "./limitText";
import { branchTicket } from "./branch";
import { BugReportDialog } from "./BugReportDialog";
import { Changes, useTicketDiff } from "./Changes";
import { HelpMenu, useHelp } from "./HelpMenu";
import { Chat, useStop } from "./Chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { DescriptionEditor, useDescriptionCommands } from "./DescriptionEditor";
import { BellIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, ExternalIcon, LinkIcon, PinIcon, SparkIcon } from "./icons";
import { useImagePaste } from "./imagePaste";
import { useFocusTrap, useLayer } from "./layers";
import { ticketBeside } from "./sideChatLayout";
import { takeTab } from "./pendingTab";
import { drawerTabs, escLeavesField, inDock, isStopKey, isTyping, nextStep, panelStep, stepTab, type DrawerTab } from "./keynav";
import { afterBar, provideTicketActions } from "./ticketActions";
import type { CommandAction } from "./CommandBar";
import { attentionGoal } from "./attentionGoal";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { complete, PlanFinished, planFinished, PlanSummary } from "./PlanPanel";
import { FamilyTab } from "./FamilyTab";
import { familyOf, featureRows, isFeature } from "./family";
import { Outputs } from "./Outputs";
import { PrBox } from "./PrBox";
import { PrList } from "./PrList";
import { Select } from "./Select";
import { phoneStatus } from "./phoneStatus";
import { ClaudeFace } from "./ConvTurn";
import { useShareNotices } from "./share";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { TicketMenu } from "./TicketMenu";
import { missingPctReason, UsagePanel, usageChipText, useTicketUsage } from "./UsagePanel";
import { approxPct, costText } from "./usage";
import { Markdown } from "./Transcript";
import { NeedsField } from "./Needs";
import { TagEditor } from "./Tags";
import { RunSettings, runSettingsText } from "./RunSettings";
import { oldChat } from "./cacheNote";
import { useFeatureStatus } from "./StatusBlock";
import { taskProgress } from "./tasksText";
import { boardTags } from "./tagText";
import { useHuddle, members } from "./huddle";
import { HuddlePanel } from "./HuddlePanel";
import type { HuddleSeed, TeamRequest } from "./Team";
import { StarToggle } from "./StarToggle";
import { usePhone } from "./usePhone";
import { useShrinkHeader } from "./useShrinkHeader";
import { toast } from "./toast";
import { FollowUpChip } from "./FollowUpChip";
import { PartOfField } from "./FamilyPanel";
import { FileLinksProvider } from "./FileViewer";
import { messageHash, useHelper } from "./helper";

// v2: widths saved under the old 80% default are dropped once so the new default shows.
const WIDTH_KEY = "ckanban.panelWidth.v2";
const MIN_WIDTH = 640;

/** Backdrop left visible beside the panel, so clicking it can always close the panel. */
const BACKDROP_MIN = 64;
/** Artifact and share link chips in the header; the rest are behind "+N more" (the Outputs tab). */
const LINK_CHIPS = 3;

/** The width the panel may use (the window, or the window minus the side panel column beside it) and what it leaves on its left. */
type Room = { width: number; keep: number };
const windowRoom = (): Room => ({ width: window.innerWidth, keep: BACKDROP_MIN });
/** Beside the side panel column: the room left of it; whether the board shows beside the ticket is ticketBeside's call (sideChatLayout.ts). */
const besideRoom = (columnWidth: number): Room => ({ width: window.innerWidth - columnWidth, keep: 0 });

const defaultWidth = (room: Room) => Math.round(Math.min(1120, room.width * 0.72));

/** Until the user resizes the panel, the Changes tab opens it this wide (clamped to the window): file list plus diff. */
const CHANGES_WIDTH = 1280;

/** Chat room for the default width: a comfortable reading column plus side padding. Dragging can go wider. */
const CHAT_ROOM = 800;

function clampWidth(w: number, room: Room = windowRoom()): number {
  const vw = room.width;
  // Narrow windows can't fit the minimum width plus the strip: the panel goes full width there.
  const max = vw >= MIN_WIDTH + room.keep ? vw - room.keep : vw;
  return Math.round(Math.min(Math.max(w, Math.min(MIN_WIDTH, max)), max));
}

const SIDE_KEY = "ckanban.sidebarWidth";
const SIDE_DEFAULT = 340;
const SIDE_MIN = 260;
/** The chat column always keeps at least this much room. */
const CHAT_MIN = 420;

const clampSide = (w: number, bodyWidth: number) =>
  Math.round(Math.max(SIDE_MIN, Math.min(w, bodyWidth ? bodyWidth - CHAT_MIN : w)));

/**
 * Drag the line between the details sidebar and the chat; double-click resets to 340px.
 * The preference persists per browser and is clamped to the panel's current width when shown.
 */
function useSidebarWidth(bodyRef: React.RefObject<HTMLDivElement | null>) {
  const [pref, setPref] = useState(() => {
    try {
      return Number(localStorage.getItem(SIDE_KEY)) || SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const width = clampSide(pref, bodyWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const persist = (w: number) => {
    try {
      localStorage.setItem(SIDE_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampSide(w, bodyRef.current?.clientWidth ?? 0);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    if (dragging) set(e.clientX - left);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => persist(set(SIDE_DEFAULT));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowRight" ? step : -step)));
    }
  };
  return { width, pref, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

const SPLIT_KEY = "ckanban.detailsSplit";
/** Room each side of the details' drag bar keeps: a few rows on top, the Description heading and some text below. */
const PINNED_MIN = 56;
const DESC_MIN = 96;

/** The top part's height in px for a saved share of the sidebar's height, kept inside both minimums. */
export function splitHeight(share: number, total: number): number {
  return Math.round(Math.max(PINNED_MIN, Math.min(share * total, total - DESC_MIN)));
}

/**
 * Drag the bar between the details' top part (status, PRs, family) and the description; double-click resets to the
 * natural layout (the top part as tall as its content, up to 65%). The height persists per browser as a share of the
 * sidebar's height.
 */
function useDetailsSplit(detailsRef: React.RefObject<HTMLDivElement | null>, pinnedRef: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [share, setShare] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v > 0 && v < 1 ? v : null;
    } catch {
      return null;
    }
  });
  const [total, setTotal] = useState(0);
  const [dragging, setDragging] = useState(false);
  const shareRef = useRef(share);
  shareRef.current = share;
  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTotal(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = (v: number | null) => {
    try {
      if (v === null) localStorage.removeItem(SPLIT_KEY);
      else localStorage.setItem(SPLIT_KEY, String(v));
    } catch {}
  };
  const setPx = (px: number) => {
    const h = detailsRef.current?.clientHeight ?? total;
    if (!h) return null;
    const v = splitHeight(px / h, h) / h;
    setShare(v);
    return v;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setPx(e.clientY - (detailsRef.current?.getBoundingClientRect().top ?? 0));
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(shareRef.current);
  };
  const reset = () => {
    setShare(null);
    persist(null);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.shiftKey ? 96 : 24;
    const now = pinnedRef.current?.offsetHeight ?? 0;
    persist(setPx(now + (e.key === "ArrowDown" ? step : -step)));
  };
  const height = enabled && share !== null && total ? splitHeight(share, total) : null;
  return { height, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** The width the user dragged to, or null when they never resized (or reset). */
function savedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v) return v;
  } catch {}
  return null;
}

/**
 * Drag the panel's left edge to resize, up to the window minus the backdrop strip; double-click resets.
 * Width persists per browser. Until the user resizes, the default is min(1120px, 72%) but no wider than
 * `fit` (sidebar + chat reading room), so the panel doesn't open with empty space beside the chat.
 */
function usePanelWidth(fit: number, room: Room) {
  const [pref, setPref] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  // Re-render on window resize; the width is clamped to the window on every render.
  const [, setVw] = useState(window.innerWidth);
  const width = clampWidth(pref ?? Math.min(defaultWidth(room), fit), room);
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampWidth(w, room);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) set(room.width - e.clientX);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => {
    setPref(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowLeft" ? step : -step)));
    }
  };
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, want: pref ?? Math.min(defaultWidth(room), fit), custom: pref !== null, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** Ticket view: details on the left, the chat with Claude filling the right side. */
/**
 * A run waiting on the user (usage limit, spending cap, stall): one line and its main button; "Details" opens the
 * longer explanation and the other choices.
 */
function WaitBanner({ line, details, actions }: { line: string; details: React.ReactNode; actions: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="banner warn inline limit-banner" role="status">
      <span className="limit-line">
        <strong>{line}</strong>
        <button className="link-btn limit-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Less" : "Details"}</button>
      </span>
      {actions(open)}
      {open && <div className="limit-more">{details}</div>}
    </div>
  );
}

export function TicketDrawer({ profile, ticket, tickets, onOpenTicket, onClose: closeNow, nav, slideIn = true, beside = null, tabRequest, huddleSeed, onOpenTeam, jobs = [], onOpenJobs, moveTo, onPin }: {
  profile: Profile;
  ticket: Ticket;
  /** The board's tickets, for the planner/child links. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  onClose: () => void;
  /** The other boards, and the move of this ticket to one (true when it moved): "Move to board" in the ticket menu. */
  moveTo?: { boards: { slug: string; name: string }[]; onMove: (id: string, board: { slug: string; name: string }) => Promise<boolean> };
  /** The previous/next visible ticket in board order (null at the ends or when this one isn't on the board view). */
  nav?: { prev: string | null; next: string | null; go: (id: string) => void };
  /** Slide in when opened; off when stepping from the neighbouring ticket. */
  slideIn?: boolean;
  /** The side panel column is open: the panel sits between the board and the column (right: the column's width, top: below the header). */
  beside?: { right: number; top: number } | null;
  /** Show this tab (e.g. a card's huddle badge); `n` changes for each new request. */
  tabRequest?: { tab: "huddle"; n: number; huddleId?: string } | null;
  /** The Team tab's Start huddle: fill this roster in on the Huddle tab; `n` changes for each new request. */
  huddleSeed?: { seed: HuddleSeed; n: number } | null;
  /** Open the dock's Team tab on a teammate or a proposal to edit (teammate cards). */
  onOpenTeam?: (r: TeamRequest) => void;
  /** The board's one-time scheduled jobs: this ticket's chip. */
  jobs?: Job[];
  /** The chip was clicked: open Schedules → Upcoming for this ticket. */
  onOpenJobs?: (ticketId: string) => void;
  /** 📌 Pin (true) or unpin this ticket (with the board's Undo note). */
  onPin?: (on: boolean) => void;
}) {
  // Errors from actions in this ticket show here, next to what failed, not in the page's top strip.
  const [panelError, setPanelError] = useState<string | null>(null);
  const onError = (msg: string) => setPanelError(msg);
  const slug = profile.slug;
  const children = tickets.filter((t) => t.parentId === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const branchedFrom = ticket.branchedFrom ? tickets.find((t) => t.id === ticket.branchedFrom) : undefined;
  const branches = tickets.filter((t) => t.branchedFrom === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Follow-up work asked for in this ticket's chat (steps are hidden: they open in their main ticket's Tasks tab).
  const followUps = tickets.filter((t) => t.madeFrom === ticket.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const siblings = ticket.parentId ? tickets.filter((t) => t.parentId === ticket.parentId && t.id !== ticket.id) : [];
  const deps = (ticket.dependsOn ?? []).map((ref) => siblings.find((s) => s.id === ref || s.planKey === ref) ?? ref);
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [editing, setEditing] = useState(false);
  const images = useImagePaste(setBody);
  const descCommands = useDescriptionCommands(slug, ticket.id);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  // Body the current edit started from; the server rejects the save if the file changed meanwhile.
  const [baseBody, setBaseBody] = useState(ticket.body);
  const phone = usePhone();
  const [tabPick, setTab] = useState<DrawerTab>(tabRequest?.tab ?? "chat");
  // A result card's Changes link opens the tool ticket on its Changes tab.
  useEffect(() => {
    const asked = takeTab(ticket.id);
    if (asked) setTab(asked as DrawerTab);
  }, [ticket.id]);
  // The huddle round picked in the Huddle tab (null: the default one); kept while the drawer stays on this ticket.
  const [huddlePick, setHuddlePick] = useState<string | null>(tabRequest?.huddleId ?? null);
  useEffect(() => {
    if (!tabRequest) return;
    setTab(tabRequest.tab);
    // A card badge or Start huddle shows the current round; a dock row its own.
    setHuddlePick(tabRequest.huddleId ?? null);
  }, [tabRequest?.n]);
  // Opening the ticket tells a follow-up's Claude the user looked (the server writes it at most every 5 minutes) and
  // stops its helper reminders. Sent again whenever the drawer shows it anew: it starts waiting on the user while open
  // (after a short wait, so the board has its wait on record), or the user comes back to the board's window.
  const waitingSince = ticket.attention?.since ?? null;
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === "visible") api.markSeen(slug, ticket.id).catch(() => {});
    };
    seen();
    const later = waitingSince ? setTimeout(seen, 3000) : null;
    window.addEventListener("focus", seen);
    document.addEventListener("visibilitychange", seen);
    return () => {
      if (later) clearTimeout(later);
      window.removeEventListener("focus", seen);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [slug, ticket.id, waitingSince]);
  const huddleState = useHuddle(slug, ticket.id, huddlePick);
  const familySize = useMemo(() => familyOf(tickets, ticket.id).length, [tickets, ticket.id]);
  // The badge counts the rows the Tasks tab lists: its own feature, a sub-feature once (featureRows).
  const taskRows = useMemo(() => featureRows(tickets, ticket.id).length, [tickets, ticket.id]);
  const huddle = huddleState.latest;
  // The Family tab exists while the ticket has a family (plan children included); Changes once Claude changed files (in a worktree, or in the
  // board's folder itself); Huddle once the ticket has had a huddle (or one is being started); Usage only while open
  // from the cost chip. A tab asked for (a card badge, Start huddle, the chip) shows while it is open.
  const inFolder = !ticket.worktree && !ticket.workdir && !ticket.branch && (ticket.runCount > 0 || !!ticket.sessionStarted || !!ticket.baseSha);
  const diffState = useTicketDiff(slug, ticket);
  // The tabs shown, in order ([ and ] step through them); opening one refreshes what it shows, like a click.
  const tabs = drawerTabs({
    phone, family: children.length > 0 || familySize > 1,
    changes: !!(ticket.worktree || inFolder) && (!!diffState.diff?.files.length || tabPick === "changes"),
    huddle: huddleState.list.length > 0 || tabPick === "huddle",
    usage: tabPick === "usage",
  });
  const tab = tabs.includes(tabPick) ? tabPick : "chat";
  // The Tasks tab shows the plan's progress (the feature status) for a feature's top ticket, so the sidebar's Plan row steps aside.
  const whereShown = useMemo(() => isFeature(tickets, ticket), [tickets, ticket]);
  const help = useHelp(slug, ticket, !!diffState.diff?.files.length);
  const [outputCount, setOutputCount] = useState(0);
  const ticketUsage = useTicketUsage(slug, ticket.id);
  const openTab = (t: typeof tabPick) => {
    if (t === "changes") diffState.reload();
    else if (t === "outputs") setOutputFocus(null);
    else if (t === "usage") ticketUsage.reload();
    setTab(t);
  };
  const usage = ticketUsage.usage;
  const hasUsage = !!usage?.runs.length;
  useShareNotices(ticket);
  // A file to show when the Outputs tab opens (a mockup clicked in the chat).
  const [outputFocus, setOutputFocus] = useState<string | null>(null);
  const [titleSave, setTitleSave] = useState<"saving" | "saved" | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // Closing slides the panel out and fades its backdrop before it goes (at once with reduced motion).
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  const onClose = useCallback(() => {
    if (leaveTimer.current) return;
    if (reducedMotion()) return closeNow();
    setLeaving(true);
    leaveTimer.current = setTimeout(closeNow, PANEL_LEAVE_MS);
  }, [closeNow]);
  // base: the board's ⌘K, ⌘B, N, ? and B may open their dialogs over the panel.
  const isTopLayer = useLayer(onClose, { skipInInputs: true, base: true });
  useFocusTrap(panelRef, true);
  // Esc in a text box here (the chat box, the title, a tag field) leaves the box for the panel and keeps what was typed;
  // the next Esc closes the panel. Boxes that use Esc themselves (the description editor cancels) go first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || !escLeavesField(e) || !isTopLayer() || document.querySelector(".overlay")) return;
      if (!panel.contains(e.target as Node)) return;
      e.preventDefault();
      panel.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The ⋯ menu's Context item: a stamp the chat's Context chip opens on. */
  const [contextRequest, setContextRequest] = useState(0);
  const [reportingBug, setReportingBug] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmBranch, setConfirmBranch] = useState(false);
  // "Move to board…": the dialog, and the board picked in it.
  const [moveBoard, setMoveBoard] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [picking, setPicking] = useState(false);
  const [linked, setLinked] = useState<ClaudeSession | null>(null);
  const [detailsOpen, setDetailsOpenState] = useState(() => {
    try {
      return localStorage.getItem("ckanban.detailsOpen") !== "0";
    } catch {
      return true;
    }
  });
  // Phones open on the chat full screen; the details live in the Ticket tab there instead of a sidebar.
  const setDetailsOpen = (fn: (v: boolean) => boolean) => {
    if (phone) return setTab((t) => (t === "ticket" ? "chat" : "ticket"));
    setDetailsOpenState((v) => {
      const next = fn(v);
      try {
        localStorage.setItem("ckanban.detailsOpen", next ? "1" : "0");
      } catch {}
      return next;
    });
  };
  const detailsShown = !phone && detailsOpen;
  useEffect(() => {
    // ⌘\ / Ctrl+\ toggles the details column, like a sidebar.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDetailsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phone]);
  // The title box: one line on desktop (input); on a phone a box that wraps (textarea, see the header).
  const titleRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const revertTitle = useRef(false);
  // Leaving for the neighbouring ticket: keep a title edit, and don't drop an unsaved description edit.
  const step = (id: string | null | undefined) => {
    if (!id || !nav || editing || confirmDelete || confirmStart || confirmBranch || moveBoard !== null || confirmStop || confirmPark || picking || reportingBug) return;
    if (title !== ticket.title) saveTitle();
    nav.go(id);
  };
  // Latest prev/next for the key handler below, which is bound once.
  const stepRef = useRef((_to: "prev" | "next") => {});
  stepRef.current = (to) => step(nav?.[to]);
  // Plain-key shortcuts (↑↓ J K, E) only when the panel itself has the keyboard: not typing, no menu, popup or dialog above it.
  // Not from the bottom panel either (Files, Team, Claude): its keys are its own.
  const panelKeys = (e: KeyboardEvent) => !e.isComposing && !e.defaultPrevented && !isTyping(e) && !inDock(e) && isTopLayer() && !document.querySelector(".overlay");
  const panelKeysRef = useRef(panelKeys);
  panelKeysRef.current = panelKeys;
  useEffect(() => {
    // Alt+↑ / Alt+↓ open the previous / next ticket, also while typing; plain ↑/↓ and K/J when not typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      let dir: "prev" | "next" | null = null;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) dir = e.key === "ArrowUp" ? "prev" : "next";
      else if (panelKeysRef.current(e)) dir = panelStep(e);
      if (!dir) return;
      e.preventDefault();
      stepRef.current(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const working = ticket.status === "in_progress" || !!ticket.running;
  // A main ticket whose tool tickets work: Stop stops them (and it) after a confirm.
  const familyBusy = runningTools(ticket) > 0;
  const att = working ? null : ticket.attention ?? null;
  const finish = useFinishMark(working, ticket);
  // Where "Your turn" leads: the header's reason and the main button both open it (goTo).
  const goal = attentionGoal(att, ticket);
  const ps = phoneStatus(ticket, finish, att);
  const { stopping, stop } = useStop(slug, ticket, working, (m) => setPanelError(m));
  const bodyRef = useRef<HTMLDivElement>(null);
  const side = useSidebarWidth(bodyRef);
  const detailsRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  // A main ticket's sidebar leads with "Where we are"; its original description folds under "Original brief".
  const [briefOpen, setBriefOpen] = useState(false);
  // Phones' Ticket tab: the "Status" fold (null: the default, open on a feature only).
  const [statusOpen, setStatusOpen] = useState<boolean | null>(null);
  const statusShown = statusOpen ?? whereShown;
  const briefFolded = whereShown && !briefOpen && !editing;
  const split = useDetailsSplit(detailsRef, pinnedRef, !phone && !briefFolded);
  // "Model and effort" from the ⋯ menu: its dropdowns open under the header's first row.
  const [runOpen, setRunOpen] = useState(false);
  // Scrolling the chat or huddle feed down shrinks the header to one line; scrolling up brings it back.
  const slim = useShrinkHeader(bodyRef, tab === "chat" || tab === "huddle", tab);
  // Opens fitted to the sidebar plus the chat's reading column; dragging can make it wider.
  const room = beside ? besideRoom(beside.right) : windowRoom();
  const panel = usePanelWidth((detailsShown ? side.pref : 0) + CHAT_ROOM, room);
  const { dragging, handle } = panel;
  const wide = (tab === "changes" || tab === "huddle") && !panel.custom;
  // Beside the column the board gives way first, then hides behind the ticket (ticketBeside).
  const fitted = beside ? ticketBeside(room.width, wide ? CHANGES_WIDTH : panel.want, panel.custom) : null;
  const width = fitted ? fitted.width : wide ? clampWidth(CHANGES_WIDTH, room) : panel.width;
  const boardHidden = !!fitted?.boardHidden;
  const [descScrolled, setDescScrolled] = useState(false);
  // The tab bar scrolls sideways on narrow screens: fade its right edge while tabs are hidden there,
  // and keep the open tab in view.
  const tabsRef = useRef<HTMLElement>(null);
  const [tabsMore, setTabsMore] = useState(false);
  const checkTabs = () => {
    const el = tabsRef.current;
    setTabsMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkTabs);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    const on = el?.querySelector<HTMLElement>("button.active");
    if (el && on) {
      const r = on.getBoundingClientRect();
      const n = el.getBoundingClientRect();
      if (r.left < n.left || r.right > n.right) el.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
    }
    checkTabs();
  }, [tab, tabs.length]);

  const links = (ticket.links ?? []).filter((l) => safeHref(l.url));
  const loadOutputs = () => api.outputs(slug, ticket.id).then((o) => setOutputCount(o.length)).catch(() => {});

  useEffect(() => {
    loadOutputs();
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
  }, [slug, ticket.id]);

  useEffect(() => {
    if (!ticket.workdir || !ticket.sessionId) return setLinked(null);
    api.sessions(slug).then((ss) => setLinked(ss.find((s) => s.id === ticket.sessionId) ?? null)).catch(() => {});
  }, [slug, ticket.sessionId, ticket.workdir, ticket.status]);

  useEffect(() => subscribe((e) => {
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) loadOutputs();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) {
      setBody(ticket.body);
      setBaseBody(ticket.body);
    }
  }, [ticket.body]);
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(ticket.title);
  }, [ticket.title]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const saveTitle = async () => {
    if (!title.trim()) return setTitle(ticket.title);
    if (title === ticket.title) return;
    setTitleSave("saving");
    try {
      await api.updateTicket(slug, ticket.id, { title: title.trim() });
      setTitleSave("saved");
      setTimeout(() => setTitleSave((s) => (s === "saved" ? null : s)), 1600);
    } catch (e: any) {
      setTitleSave(null);
      onError(`Title not saved: ${e.message}`);
    }
  };
  const startEdit = async () => {
    try {
      const fresh = await api.ticket(slug, ticket.id);
      setBody(fresh.body);
      setBaseBody(fresh.body);
    } catch {}
    setEditing(true);
  };
  const saveBody = () => {
    if (images.uploading) return;
    if (body === baseBody) return setEditing(false);
    api.updateTicket(slug, ticket.id, { body, expectedBody: baseBody })
      .then((t) => { setBaseBody(t.body); setEditing(false); })
      .catch((e) => onError(e.message));
  };
  // Marked Done: on to the next ticket of the column the drawer walks, or back to the board after its last one,
  // at once rather than after the save, so a close in the meantime can't be undone by a late jump.
  // The drawer may be gone when the save fails, so the error goes to the board's toast.
  // A main ticket with tool tickets: Backlog and Done hold its family, after one confirm.
  const [confirmPark, setConfirmPark] = useState<"backlog" | "done" | null>(null);
  const setStatus = (status: Status, confirmed = false) => {
    if (!confirmed && parkNeedsConfirm(ticket, status)) return setConfirmPark(status as "backlog" | "done");
    if (status !== "done" || ticket.status === "done") return act(() => api.updateTicket(slug, ticket.id, { status }));
    const title = ticket.title;
    api.updateTicket(slug, ticket.id, { status }).catch((e) => toast(<>Couldn't mark <b>{title}</b> done: {e.message}</>, { tone: "error" }));
    if (nav?.next) step(nav.next);
    else if (!editing) onClose();
  };
  const col = COLUMNS.find((c) => c.id === ticket.status);
  const statusOptions = STATUS_MENU.map((c) => ({ value: c.id, label: c.label, hint: c.hint }));
  const startTarget = startWorkTarget(ticket);
  const startWork = () => (startTarget === "planning" ? setStatus("planning") : setConfirmStart(true));
  // The chat's newest unapplied proposal (Chat reports it), so ⌘⇧Enter can apply it and start work in one go.
  const applyProposalRef = useRef<((start: boolean) => Promise<void>) | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const onPendingProposal = useCallback((apply: ((start: boolean) => Promise<void>) | null) => {
    applyProposalRef.current = apply;
    setProposalPending(!!apply);
  }, []);
  // Opens the tab the ticket waits in, scrolls to the form, card or message to act on and highlights it for a moment.
  // The chat may still be loading: it looks again on each frame for up to 3 seconds.
  const goTo = () => {
    if (!goal) return;
    openTab(goal.tab);
    const until = performance.now() + 3000;
    const find = () => {
      const main = panelRef.current?.querySelector(".panel-main");
      for (const sel of goal.targets) {
        const all = main?.querySelectorAll<HTMLElement>(sel);
        if (all?.length) return all[all.length - 1];
      }
      return null;
    };
    const land = () => {
      const el = find();
      if (!el) {
        if (performance.now() < until) requestAnimationFrame(land);
        return;
      }
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      // The keyboard lands in the form too: its first field or button (or the box itself).
      const field = el.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select, button:not(:disabled)");
      if (field) field.focus({ preventScroll: true });
      else {
        if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
      el.classList.remove("attn-flash");
      void el.offsetWidth; // restart the highlight when pressed again
      el.classList.add("attn-flash");
      setTimeout(() => el.classList.remove("attn-flash"), 2200);
    };
    requestAnimationFrame(land);
  };
  const goalOnScreen = useGoalOnScreen(panelRef, goal?.targets ?? null);
  // Every child of its plan is done: Move to Done replaces Start work.
  const finished = planFinished(children);
  // "/" (and ⌘K "Write a message"): the Chat tab, with the cursor in its message box.
  const focusComposer = () => {
    setTab("chat");
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  };
  const addMoreTickets = focusComposer;
  const next = nextStep({ status: ticket.status, working, proposalPending, planFinished: finished });
  const nextStepRef = useRef(() => {});
  nextStepRef.current = () => {
    if (next === "apply" || next === "apply-start") applyProposalRef.current?.(next === "apply-start");
    else if (next === "start") startWork();
    else if (next === "done") setStatus("done");
  };
  useEffect(() => {
    // ⌘⇧Enter / Ctrl+Shift+Enter: the ticket's next step (apply proposal & start work, Start work, Mark done), also while typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      if (document.querySelector(".overlay")) return;
      e.preventDefault();
      nextStepRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // E: edit the description; R: Refine with Claude (Backlog); S: star; P: pin / unpin; M: move to a column; [ ]: previous / next tab;
  // /: the message box.
  // Only when the panel has the keyboard.
  const letterRef = useRef<(k: string) => boolean>(() => false);
  letterRef.current = (k) => {
    if (k === "e" && !editing) {
      if (phone) setTab("ticket");
      return startEdit(), true;
    }
    if (k === "r" && !working && !editing && ticket.status === "backlog") return setStatus("planning"), true;
    if (k === "s") return toggleStar(), true;
    if (k === "p" && canPin) return togglePin(), true;
    if (k === "m") return openStatusPicker(), true;
    if (k === "/") return focusComposer(), true;
    if (k === "[" || k === "]") {
      const to = stepTab<typeof tabPick>(tabs, tab, k === "]" ? 1 : -1);
      if (to) openTab(to);
      return !!to;
    }
    return false;
  };
  // ⌘. / Ctrl+.: Stop Claude, after a confirm; also while typing.
  const stopKeyRef = useRef(() => {});
  stopKeyRef.current = () => { if ((working || familyBusy) && !stopping) setConfirmStop(true); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isStopKey(e) || document.querySelector(".overlay")) return;
      e.preventDefault();
      stopKeyRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !panelKeysRef.current(e)) return;
      if (letterRef.current(e.key.toLowerCase())) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const toggleStar = () => {
    api.updateTicket(slug, ticket.id, { important: !ticket.important }).catch((e) => onError(`Important not saved: ${e.message}`));
  };
  // 📌 Pin to the top of its column; a Done ticket can only be unpinned (the board unpins it at Done).
  const pinned = !!ticket.pinnedAt;
  const canPin = !!onPin && (pinned || ticket.status !== "done");
  const togglePin = () => onPin?.(!pinned);
  // M: open the Status picker (the header's status button on a phone with the details hidden), showing the details first if needed.
  const openStatusPicker = () => {
    const sel = phone && !detailsShown ? ".phone-status" : ".status-select";
    const open = () => {
      const trigger = panelRef.current?.querySelector<HTMLButtonElement>(`${sel} .select-trigger`);
      trigger?.focus();
      trigger?.click();
    };
    if (!detailsShown && !phone) {
      setDetailsOpen(() => true);
      requestAnimationFrame(open);
    } else open();
  };
  const cancelEdit = () => { setBody(baseBody); setEditing(false); images.clearError(); };

  // This ticket's ⌘K entries, read when the command bar opens (ticketActions.ts). Same handlers as the buttons and keys.
  const actionsRef = useRef<() => CommandAction[]>(() => []);
  actionsRef.current = () => {
    const list: CommandAction[] = [];
    const add = (id: string, label: string, run: () => void, keys?: string[], hint = "this ticket") =>
      list.push({ id: `ticket-${id}`, label, hint, keys, run: afterBar(run) });
    if (goal && !working) add("goal", "Go to what needs you", goTo, undefined, att?.label ?? "this ticket");
    add("message", "Write a message to Claude", focusComposer, ["/"]);
    if (ticket.status !== "done" && (finished || ticket.status === "review")) add("done", "Mark done", () => setStatus("done"), next === "done" ? [MOD, "Shift", "Enter"] : undefined);
    if (!working && !finished && (ticket.status === "backlog" || ticket.status === "planning")) add("start", "Start work", startWork, next === "start" ? [MOD, "Shift", "Enter"] : undefined);
    if (!working && !editing && ticket.status === "backlog") add("refine", "Refine with Claude", () => setStatus("planning"), ["R"]);
    add("star", ticket.important ? "Remove the star" : "Star as important", toggleStar, ["S"]);
    if (canPin) add("pin", pinned ? "Unpin" : "Pin to top", togglePin, ["P"]);
    add("move", "Move to a column…", openStatusPicker, ["M"]);
    if (!editing) add("edit", "Edit the description", () => letterRef.current("e"), ["E"]);
    if ((working || familyBusy) && !stopping) add("stop", familyBusy ? "Stop this ticket and its tasks…" : "Stop Claude…", () => setConfirmStop(true), [MOD, "."]);
    add("delete", "Delete ticket…", () => setConfirmDelete(true));
    return list;
  };
  useEffect(() => provideTicketActions(() => actionsRef.current()), []);

  const usageTitle = !usage ? "" : usage.totals.pctCurrentWindow === null ? missingPctReason(usage)
    : "This ticket's ≈ share of your plan's current 5-hour limit, and its API-equivalent cost";
  // On a phone the run cost joins the column's help line when it is the only result chip.
  // The column's help line: only while the ticket waits or is stuck, not while Claude works or once it is finished.
  const colHelp = !!col && !working && !familyBusy && ticket.status !== "done" && !finished;
  // What the ticket waits on, for the status pill's tooltip (the pill itself only says "Your turn").
  const attLabel = att ? (att.kind === "limit" ? limitLabel(ticket) : att.label) : "";
  const shortStatus = att ? "Your turn" : ps.label;
  const tagEditor = (
    <TagEditor tags={ticket.tags ?? []} suggested={ticket.suggestedTags ?? []} known={boardTags(tickets)}
      onChange={(tags) => api.updateTicket(slug, ticket.id, { tags }).catch((e) => onError(`Tags not saved: ${e.message}`))}
      onSuggested={(suggestedTags) => api.updateTicket(slug, ticket.id, { suggestedTags }).catch((e) => onError(`Tags not saved: ${e.message}`))} />
  );
  // Status, actions, links and the description: a sidebar on wider screens, the Ticket tab on phones.
  const details = (
    <div ref={detailsRef} className={`panel-details ${split.height !== null ? "split-set" : ""} ${split.dragging ? "splitting" : ""}`}>
      <div ref={pinnedRef} className="details-pinned" style={split.height !== null ? { height: split.height } : undefined}>
        {/* Phones: the description comes first (CSS order); everything here folds under one "Status" row, open at first
            only on a feature, whose brief is folded and whose "Where we are" is the news. */}
        {phone && (
          <button className="fold-head status-fold" aria-expanded={statusShown} onClick={() => setStatusOpen(!statusShown)}>
            <h4>Status</h4><span className="status-fold-sum">{shortStatus}</span><span className="fold-chev side" aria-hidden>▸</span>
          </button>
        )}
        {(!phone || statusShown) && <>
        {whereShown && <WhereWeAre slug={slug} ticket={ticket} tickets={tickets} onOpen={() => openTab("family")} />}
        {/* Phones: the tags live here (the header has room for the title only). */}
        {phone && (
          <div className="field-row phone-tags">
            <span className="field-key">Tags</span>
            {tagEditor}
          </div>
        )}
        {/* Phones move the ticket with the header's picker, which shows the column. */}
        {!phone && (
          <div className="field-row">
            <span className="field-key">Status</span>
            <Select className="status-select" ariaLabel="Status" value={boardColumnOf(ticket)} onChange={(s) => setStatus(menuPick(ticket, s as Status))}
              options={statusOptions} />
          </div>
        )}
        {colHelp && (
          <p className="field-help">
            {col!.claude && <SparkIcon className="icon spark" />}{col!.hint}
          </p>
        )}

        <PrList ticket={ticket} review={ticket.status === "review"} />
        {ticket.prUrl && ticket.status === "review" && <PrBox profile={profile} ticket={ticket as Ticket & { prUrl: string }} onError={onError} />}

        <div className="action-stack">
          {goal && !working && !goalOnScreen && (
            <button className="btn primary goal-btn" onClick={goTo} title={`${att!.label}: show me where`}>{goal.button}</button>
          )}
          {working && !familyBusy && <button className="btn danger" disabled={stopping} onClick={stop} title={`Stop Claude (${MOD}.)`}>{stopping ? "Stopping…" : "Stop Claude"}<KeyHint keys="⌘." /></button>}
          {familyBusy && <button className="btn danger" disabled={stopping} onClick={() => setConfirmStop(true)} title={`Stop this ticket and its running tasks (${MOD}.)`}>{stopping ? "Stopping…" : "Stop"}<KeyHint keys="⌘." /></button>}
          {finished && <PlanFinished ticket={ticket} total={children.length} onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />}
          {!working && !finished && (ticket.status === "backlog" || ticket.status === "planning") && (
            <button className={`btn ${goal ? "" : "primary"}`}
              onClick={startWork} title={`${startTarget === "planning" ? "Claude interviews you first" : "Claude works on its own"} (${proposalPending ? `${MOD}⇧Enter applies the proposal and starts` : `${MOD}⇧Enter`})`}>
              Start work{!proposalPending && <KeyHint keys="⌘⇧↵" />}
            </button>
          )}
          {!working && ticket.status === "backlog" && (
            <button className="btn" onClick={() => setStatus("planning")} title="Move to Planning: Claude interviews you (R)">
              Refine with Claude<KeyHint keys={startTarget === "planning" && !proposalPending ? "⌘⇧↵ · R" : "R"} />
            </button>
          )}
          {ticket.status === "review" && !finished && (
            <button className={`btn ${ticket.prUrl || goal ? "" : "primary"}`} onClick={() => setStatus("done")} title={`Mark done (${MOD}⇧Enter)`}>Mark done{!working && <KeyHint keys={proposalPending ? "⌘⇧↵ after Apply" : "⌘⇧↵"} />}</button>
          )}
          {ticket.source?.url && (
            <a className="btn icon-label" href={safeHref(ticket.source.url)} target="_blank" rel="noreferrer" title={ticket.source.label}>
              Open in {ticket.source.provider} <ExternalIcon size={12} />
            </a>
          )}
        </div>

        {ticket.branchedFrom && (
          <div className="field-row">
            <span className="field-key" title="This ticket started as a copy of that one's conversation and work">Copied from</span>
            {branchedFrom ? (
              <button className="link-btn ticket-link" onClick={() => onOpenTicket(branchedFrom.id)}>{branchedFrom.title}</button>
            ) : (
              <span className="muted small">Source ticket was deleted</span>
            )}
          </div>
        )}
        {branches.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="Tickets copied from this one">Copies</span>
            <span className="dep-list">
              {branches.map((b) => <button key={b.id} className="link-btn ticket-link" onClick={() => onOpenTicket(b.id)}>{b.title}</button>)}
            </span>
          </div>
        )}
        {(ticket.followUp || ticket.followUpStopped) && (
          <div className="field-row">
            <span className="field-key" title="Claude comes back to this ticket by itself at that time">Follow-up</span>
            <span><FollowUpChip slug={slug} ticket={ticket} onError={onError} /></span>
          </div>
        )}
        {followUps.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="Work asked for in this ticket's chat after it ran">Follow-up work</span>
            <span className="dep-list">
              {followUps.map((f) => <button key={f.id} className="link-btn ticket-link" onClick={() => onOpenTicket(f.id)}>{f.title}</button>)}
            </span>
          </div>
        )}
        <PartOfField slug={slug} ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} onError={onError} />
        {deps.length > 0 && (
          <div className="field-row">
            <span className="field-key" title="A running plan starts this ticket once these are done">Waits for</span>
            <span className="dep-list">
              {deps.map((d) => typeof d === "string"
                ? <span key={d} className="muted small">{d} (missing)</span>
                : <button key={d.id} className="link-btn ticket-link" onClick={() => onOpenTicket(d.id)}>{d.title}</button>)}
            </span>
          </div>
        )}

        {/* Rarely set by hand (plans and update_ticket set it), so only shown once the ticket has needs. */}
        {!!ticket.needs?.length && <NeedsField slug={slug} ticket={ticket} onError={onError} />}

        {children.length > 0 && !whereShown && <PlanSummary ticket={ticket} children={children} onOpen={() => setTab("family")} />}

        {!!links.length && (
          <div className="result-chips" aria-label="Results">
            {links.slice(0, LINK_CHIPS).map((l) => (
              <a key={l.url} className="result-chip" href={safeHref(l.url)} target="_blank" rel="noreferrer"
                title={l.source === "share" ? `Share link: ${l.url}` : l.url}>
                {l.source === "share" ? <LinkIcon size={12} /> : <ExternalIcon size={12} />} {l.label}
              </a>
            ))}
            {links.length > LINK_CHIPS && (
              <button className="result-chip" onClick={() => { setOutputFocus(null); setTab("outputs"); }} title="All links are in the Outputs tab">
                +{links.length - LINK_CHIPS} more
              </button>
            )}
          </div>
        )}
        <OldChatNote slug={slug} ticket={ticket} working={working} feature={whereShown} onError={onError} />
        </>}
      </div>

      {!phone && !briefFolded && (
        <div className="details-split" role="separator" aria-orientation="horizontal" aria-label="Resize the description"
          aria-valuenow={split.height ?? undefined} tabIndex={0} title="Drag to resize · double-click to reset" {...split.handle} />
      )}
      <section className={`details-desc ${descScrolled && !editing ? "scrolled" : ""}${briefFolded ? " brief-folded" : ""}`}>
        <div className="section-head">
          {whereShown ? (
            <button className="fold-head brief-toggle" aria-expanded={!briefFolded} onClick={() => setBriefOpen((v) => !v)} disabled={editing}>
              <h4>Original brief</h4><span className="fold-chev side" aria-hidden>▸</span>
            </button>
          ) : <h4>Description</h4>}
          {!editing && !briefFolded && <button className="btn ghost small" onClick={startEdit} title="Edit the description (E)">Edit<KeyHint keys="E" /></button>}
        </div>
        {briefFolded ? null : editing ? (
          <div className="desc-edit">
            <DescriptionEditor slug={slug} ticketId={ticket.id} value={body} setValue={setBody} images={images} inputRef={bodyInput} autoFocus fill
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) saveBody();
                else if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); cancelEdit(); panelRef.current?.focus({ preventScroll: true }); }
              }} />
            <div className="form-actions">
              <button className="btn ghost" onClick={cancelEdit} title="Cancel (Esc)">Cancel<KeyHint keys="Esc" /></button>
              <button className="btn primary" disabled={images.uploading} onClick={saveBody} title={`Save (${MOD}Enter)`}>{images.uploading ? "Uploading…" : "Save"}<KeyHint keys="⌘↵" /></button>
            </div>
          </div>
        ) : (
          <div className="desc-scroll" onScroll={(e) => setDescScrolled(e.currentTarget.scrollTop > 0)}>
            {body.trim() ? (
              <div className="body-view" onDoubleClick={startEdit}><Markdown text={body} commands={descCommands} /></div>
            ) : (
              <div className="muted small">No description yet. {ticket.status === "planning" ? "Claude can propose one in the chat." : ""}</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
  // The title box's handlers, shared by the desktop input and the phone textarea.
  const titleProps = {
    value: title, "aria-label": "Title",
    // A phone's box wraps, but the title stays one line: a new line (pasted) becomes a space.
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setTitle(e.target.value.replace(/\s*\n\s*/g, " ")),
    // Esc's blur runs with this render's title, so it is told to skip the save.
    onBlur: () => { if (revertTitle.current) revertTitle.current = false; else saveTitle(); },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Enter saves (on blur) and gives the keyboard back to the panel; Esc reverts, then leaves the same way (see above).
      if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); panelRef.current?.focus({ preventScroll: true }); }
      else if (e.key === "Escape") { revertTitle.current = true; setTitle(ticket.title); e.currentTarget.blur(); }
    },
  };
  // Phones: one button says the state and moves the ticket (desktop keeps the chip and its own column picker).
  const statusButton = (
    <Select className={`phone-status tone-${ps.tone}`} ariaLabel={`${att ? `Your turn: ${att.label}` : ps.label}. Move to column`} value={boardColumnOf(ticket)}
      onChange={(s) => setStatus(menuPick(ticket, s as Status))}
      renderValue={() => <>{ps.mood
        ? <span className="ps-face" aria-hidden><ClaudeFace mood={ps.mood} size={24} /></span>
        : <span className={`ps-dot${ps.busy ? " busy" : ""}${ps.icon ? " mark" : ""}`} aria-hidden>{ps.icon}</span>}<span className="ps-label">{shortStatus}</span></>}
      menuMaxHeight={Infinity} // all columns fit on a phone screen; only scroll when the screen is too short
      options={statusOptions}
      footer={att && goal ? [{ label: goal.button, icon: <ChevronRightIcon size={12} />, onSelect: goTo }] : undefined} />
  );
  // The tab bar's buttons: every tab is in the bar, which scrolls sideways when they don't fit.
  const costChip = usage && hasUsage ? (
    <button className="head-cost" onClick={() => openTab("usage")} title={`${usageChipText(usage)}. ${usageTitle}`}>{costText(usage.totals.costUsd)}</button>
  ) : null;
  const tabLabel: Record<DrawerTab, React.ReactNode> = {
    ticket: "Ticket",
    chat: <>Chat {working && <span className="dot" />}</>,
    family: children.length > 0 ? (
      <>Tasks<span className={`tab-count ${ticket.plan?.state === "stuck" ? "warn" : children.every(complete) ? "ok" : ""}`}>
        {children.filter(complete).length}/{children.length}
      </span></>
    ) : <>Tasks<span className="tab-count">{taskRows}</span></>,
    huddle: (
      <>
        Huddle{huddle && huddle.status !== "closed" && <span className={`tab-count${huddle.status === "live" ? " ok" : ""}`}>{members(huddle).length}</span>}
        {huddle && huddle.status !== "closed" && !!huddle.forYou && (
          <span className="for-you-pill" title={`${huddle.forYou} ${huddle.forYou === 1 ? "message tags" : "messages tag"} you`}>{huddle.forYou}</span>
        )}
        {huddle?.status === "live" && huddle.participants.some((p) => p.status === "working") && <span className="dot" />}
      </>
    ),
    changes: <>Changes{!!diffState.diff?.files.length && <span className="tab-count">{diffState.diff.files.length}</span>}</>,
    outputs: <>Outputs{outputCount + links.length > 0 && <span className="tab-count">{outputCount + links.length}</span>}</>,
    usage: <>Usage{usage && hasUsage && usage.totals.pctCurrentWindow !== null && <span className="tab-count">{approxPct(usage.totals.pctCurrentWindow).replace(" ", "")}</span>}</>,
  };
  return (
    <FileLinksProvider slug={slug} ticketId={ticket.id} panel={panelRef}>
    <div className={`drawer-wrap${slideIn ? "" : " no-fade"}${leaving ? " leaving" : ""}${beside ? " beside-panels" : ""}`}
      style={beside ? { right: beside.right, top: beside.top } : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panelRef} className={`panel ${dragging ? "resizing" : ""} ${slideIn ? "" : "no-slide"}${slim ? " head-slim" : ""}${leaving ? " leaving" : ""}`} role="dialog" aria-modal="true" aria-label={ticket.title} style={{ width }} tabIndex={-1}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />

        <header className="panel-head">
          {/* Row 1: the title, its tags, the helper's note, then the buttons. */}
          <div className="head-row1">
            {phone && <button className="icon-btn phone-back" onClick={onClose} aria-label="Back to the board"><ChevronLeftIcon size={20} /></button>}
            {!phone && boardHidden && (
              <button className="btn ghost small icon-label board-back" onClick={onClose} title="The window is too narrow for the board beside this ticket and the side panels: close the ticket to see the board">
                <ChevronLeftIcon size={14} /> Board
              </button>
            )}
            {!phone && <button className={`icon-btn sidebar-toggle ${detailsShown ? "on" : ""}`} onClick={() => setDetailsOpen((v) => !v)}
              aria-label={detailsShown ? "Hide details" : "Show details"} aria-pressed={detailsShown}
              title={`${detailsShown ? "Hide" : "Show"} details (⌘\\)`}>
              <KeyHint keys="⌘\" />
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <rect x="2" y="3" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <line x1="7" y1="3.5" x2="7" y2="14.5" stroke="currentColor" strokeWidth="1.5" />
                {detailsShown && <rect x="2.75" y="3.75" width="3.5" height="10.5" rx="1.5" fill="currentColor" opacity="0.35" />}
              </svg>
            </button>}
            <StarToggle on={!!ticket.important} onChange={toggleStar} keyHint="S" />
            {canPin && (
              <button type="button" className={`icon-btn pin-toggle${pinned ? " on" : ""}`} aria-pressed={pinned} aria-label={pinned ? "Unpin" : "Pin to top"}
                title={pinned ? "Pinned to the top of its column. Click to unpin (P)" : "Pin to the top of its column (P)"} onClick={togglePin}>
                <PinIcon size={16} />
                <KeyHint keys="P" />
              </button>
            )}
            {/* One line, cut short; the whole title is in its tooltip. Phones: the title has a row of its own (below). */}
            {!phone && <input ref={titleRef} className="title-input" title={title} {...titleProps} />}
            {!phone && tagEditor}
            {!phone && <HelperIcon slug={slug} ticketId={ticket.id} />}
            <span className="save-state" aria-live="polite">
              {titleSave === "saving" && <span className="muted small">Saving…</span>}
              {titleSave === "saved" && <span className="saved small"><CheckIcon size={12} /> Saved</span>}
            </span>
            <span className="head-spacer" />
            {/* Phones: the cost sits up here, so every tab fits on the row below. */}
            {phone && costChip}
            {phone && statusButton}
            <JobChip jobs={jobs} ticketId={ticket.id} onOpen={onOpenJobs} />
            {phone && <HelperIcon slug={slug} ticketId={ticket.id} />}
            <HelpMenu help={help} phone={phone} onAsk={(kind) => { setTab("chat"); void help.ask(kind); }} />
            {nav && (
              <span className="ticket-nav">
                <button className="icon-btn" disabled={!nav.prev || editing} onClick={() => step(nav.prev)} aria-label="Previous ticket"
                  title={editing ? "Save or cancel the description first" : "Previous ticket (↑ or K)"}><ChevronUpIcon size={16} /></button>
                <button className="icon-btn" disabled={!nav.next || editing} onClick={() => step(nav.next)} aria-label="Next ticket"
                  title={editing ? "Save or cancel the description first" : "Next ticket (↓ or J)"}><ChevronDownIcon size={16} /></button>
                <KeyHint keys="↑↓ J K" />
              </span>
            )}
            <TicketMenu ticket={ticket} working={working} onPin={canPin ? togglePin : undefined} live={!!(ticket.terminalOpen || linked?.live)}
              runSettings={{ value: runSettingsText(profile, ticket), onOpen: () => setRunOpen(true) }}
              linkedLabel={ticket.workdir && ticket.sessionId ? (linked ? sessionLabel(linked) : ticket.sessionId.slice(0, 8)) : null}
              boardCap={profile.runCapUsd ?? null}
              onCap={(usd) => api.updateTicket(slug, ticket.id, { runCapUsd: usd })}
              onBranch={() => setConfirmBranch(true)}
              onMoveToBoard={moveTo?.boards.length ? () => setMoveBoard(moveTo.boards[0].slug) : undefined}
              onPickSession={() => setPicking(true)}
              onUnlink={() => act(() => api.linkSession(slug, ticket.id, null))}
              onCheckPr={() => act(() => api.checkPr(slug, ticket.id))}
              onReportBug={() => setReportingBug(true)}
              onHuddle={tabs.includes("huddle") ? undefined : () => setTab("huddle")}
              onContext={() => { setTab("chat"); setContextRequest(Date.now()); }}
              onDelete={() => setConfirmDelete(true)} />
            {!phone && <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><CloseIcon /><KeyHint keys="Esc" /></button>}
          </div>
          {runOpen && <RunPopover profile={profile} ticket={ticket} onError={onError} onClose={() => setRunOpen(false)} />}
          {/* Phones: the whole title on a row of its own, up to two lines, then cut. It folds away while the chat scrolls
              down (useShrinkHeader); the tabs below stay. The box sits over the text, so a tap types straight into it. */}
          {phone && (
            <div className="head-title-wrap" aria-hidden={slim || undefined}><div className="head-title">
              <div className="phone-title">
                <span className="phone-title-text" aria-hidden>{title || ticket.title}</span>
                <textarea ref={titleRef} className="title-input" rows={1} tabIndex={slim ? -1 : undefined} {...titleProps} />
              </div>
            </div></div>
          )}
          {/* Row 2: the tabs, then the short status (desktop) and the cost. On desktop it folds away while the chat
              scrolls down (useShrinkHeader); on a phone it stays and the title row folds instead. */}
          <div className="head-row2-wrap" aria-hidden={(slim && !phone) || undefined}><div className="head-row2">
            <nav ref={tabsRef} className={`tabs${tabsMore ? " more-right" : ""}`} role="tablist" aria-label="Ticket" onScroll={checkTabs}>
              {tabs.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} tabIndex={slim && !phone ? -1 : undefined} onClick={() => openTab(t)}>{tabLabel[t]}</button>
              ))}
            </nav>
            <span className="head-spacer" />
            {!phone && <>
              {/* Only the short status; what it waits on is in the tooltip (and in the chat's waiting list). */}
              {finish ? finishBadge(finish) : att && goal ? (
                <button className={`your-turn inline go att-${att.kind}`} onClick={goTo} title={`${attLabel}: show me where`} aria-label={`Your turn: ${attLabel}. Show me where`}>
                  <span className="yt-dot" aria-hidden /><span className="yt-label">Your turn</span>
                </button>
              ) : att && (
                <span className={`your-turn inline att-${att.kind}`} title={attLabel}>
                  <span className="yt-dot" aria-hidden /><span className="yt-label">Your turn</span>
                </span>
              )}
              {!finish && !att && !featureBusy(ticket) && (ticket.huddleBusy ? huddleBadge(ticket) : outcomeBadge(ticket))}
            </>}
            {!phone && costChip}
          </div></div>
        </header>

        <div ref={bodyRef} className={`panel-body ${detailsShown ? "" : "details-closed"} ${side.dragging ? "resizing" : ""}`}
          style={{ "--side-w": `${side.width}px` } as React.CSSProperties}>
          {!phone && details}

          {detailsShown && (
            <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize details"
              aria-valuenow={side.width} tabIndex={0} title="Drag to resize · double-click to reset" {...side.handle} />
          )}

          <div className="panel-main">
            {panelError && (
              <div className="banner error inline panel-error" role="alert">
                <span>{panelError}</span>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setPanelError(null)}><CloseIcon /></button>
              </div>
            )}
            {limitWait(ticket) && (
              <WaitBanner line={limitLabel(ticket)}
                details={<>{limitHint(ticket)}{ticket.limit?.message && <span className="muted small">{ticket.limit.message}</span>}</>}
                actions={(open) => <LimitActions slug={slug} ticket={ticket} onError={onError} small secondary={open} />} />
            )}
            {capWait(ticket) && (
              <WaitBanner line={ticket.capHit ? `Spent its ${costText(ticket.capHit.capUsd)} budget` : capLabel(ticket)}
                details="The run spent its budget before it finished. Continue the same conversation with more, or change the cap in ⋯."
                actions={() => <CapActions slug={slug} ticket={ticket} onError={onError} small />} />
            )}
            {stallWait(ticket) && (
              <WaitBanner line={`Stalled · no output for ${ticket.stalled!.minutes} min`}
                details="A tool call may be stuck, or it's just a long step. Nothing is killed unless you choose to."
                actions={(open) => <StallActions slug={slug} ticket={ticket} onError={onError} small secondary={open} />} />
            )}
            {tab === "ticket" ? (
              <div className={`panel-ticket ${editing ? "editing" : ""}`}>{details}</div>
            ) : tab === "family" ? (
              <div className="panel-scroll panel-plan">
                <FamilyTab slug={slug} profile={profile} ticket={ticket} tickets={tickets} planChildren={children} onOpenTicket={onOpenTicket} onError={onError}
                  onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />
              </div>
            ) : tab === "huddle" ? (
              <HuddlePanel slug={slug} ticket={ticket} tickets={tickets} state={huddleState} onError={onError} seed={huddleSeed ?? null} onSelect={setHuddlePick}
                onOpenOutput={(name) => { setOutputFocus(name); setTab("outputs"); }}
                onOpenChat={() => setTab("chat")} onOpenTicket={onOpenTicket} onOpenTeam={onOpenTeam} />
            ) : tab === "changes" ? (
              <Changes slug={slug} ticket={ticket} state={diffState} onSent={() => setTab("chat")} onError={onError} />
            ) : tab === "usage" ? (
              <div className="panel-scroll panel-usage"><UsagePanel usage={usage} error={ticketUsage.error} /></div>
            ) : tab === "outputs" ? (
              <div className="panel-scroll panel-outputs"><Outputs slug={slug} ticket={ticket} onCount={setOutputCount} focus={outputFocus} /></div>
            ) : (
              <Chat slug={slug} ticket={ticket} tickets={tickets} contextRequest={contextRequest} onOpenTicket={onOpenTicket} onError={onError} onPendingProposal={onPendingProposal} onFilesChanged={diffState.reload}
                onOpenTasks={tabs.includes("family") ? () => openTab("family") : undefined}
                huddle={huddle} onOpenHuddle={() => setTab("huddle")} onOpenTeam={onOpenTeam} help={help}
                onOpenOutput={(name) => { setOutputFocus(name); setTab("outputs"); }} />
            )}
          </div>
        </div>

        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {ticket.error?.startsWith("corrupt") && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {confirmStart && (
          <ConfirmDialog title="Start work?" confirmLabel="Start work" busyLabel="Starting…" tone="primary"
            onCancel={() => setConfirmStart(false)}
            onConfirm={async () => { await api.updateTicket(slug, ticket.id, { status: "ready" }); setConfirmStart(false); }}>
            <p>Claude will work on this on its own. When working: <b>{ticket.mode === "interview" ? "Interview me first" : "Just do it"}</b>.</p>
          </ConfirmDialog>
        )}
        {confirmStop && (
          <ConfirmDialog title={stopTitle(ticket)} confirmLabel={familyBusy ? "Stop all" : "Stop Claude"} busyLabel="Stopping…"
            onCancel={() => setConfirmStop(false)}
            onConfirm={async () => {
              if (familyBusy) await api.stop(slug, ticket.id);
              else if (working) stop();
              setConfirmStop(false);
            }}>
            {familyBusy
              ? <p>Its running tasks stop now and queued ones don't start. Tickets you added to the feature keep going. {`$${ticket.familyCard!.costUsd.toFixed(2)}`} spent so far.</p>
              : <p>Claude stops working on this ticket now. You can start it again later.</p>}
          </ConfirmDialog>
        )}
        {confirmPark && (
          <ConfirmDialog title={parkTitle(ticket, confirmPark)} confirmLabel={confirmPark === "done" ? "Move to Done" : "Move to Backlog"} busyLabel="Moving…" tone="primary"
            onCancel={() => setConfirmPark(null)}
            onConfirm={() => { const to = confirmPark; setConfirmPark(null); setStatus(to, true); }}>
            <p>{parkText(ticket)}</p>
          </ConfirmDialog>
        )}
        {confirmBranch && (
          <ConfirmDialog title="Try another direction?" confirmLabel="Copy ticket" busyLabel="Copying…" tone="primary"
            onCancel={() => setConfirmBranch(false)}
            onConfirm={async () => { await branchTicket(slug, ticket, onOpenTicket); setConfirmBranch(false); }}>
            <p>Creates a copy of this ticket in Planning with this conversation{ticket.branch ? " and the work it has saved so far" : ""}. Take the copy in another direction; this ticket stays as it is.</p>
          </ConfirmDialog>
        )}
        {moveBoard !== null && moveTo && (
          <ConfirmDialog title="Move to another board?" confirmLabel="Move ticket" busyLabel="Moving…" tone="primary"
            onCancel={() => setMoveBoard(null)}
            onConfirm={async () => {
              const target = moveTo.boards.find((b) => b.slug === moveBoard);
              if (target && await moveTo.onMove(ticket.id, target)) onClose();
              else setMoveBoard(null);
            }}>
            <p>Sends <b>{ticket.title}</b> to the Backlog of another board. Only the title, description and tags come along; chat and comments stay behind, and it leaves this board.</p>
            <Select ariaLabel="Board to move to" value={moveBoard} onChange={setMoveBoard}
              options={moveTo.boards.map((b) => ({ value: b.slug, label: b.name }))} />
          </ConfirmDialog>
        )}
        {reportingBug && (
          <BugReportDialog ticket={{ profile: slug, id: ticket.id, title: ticket.title }} onClose={() => setReportingBug(false)} />
        )}
        {confirmDelete && (
          <ConfirmDialog title={deleteTitle(ticket)} confirmLabel={toolCount(ticket) ? "Delete all" : "Delete ticket"} busyLabel="Deleting…" onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => { await api.deleteTicket(slug, ticket.id); onClose(); }}>
            {toolCount(ticket) > 0
              ? <p>Work that isn't merged is lost. Their copies of the folder go too; tickets you added to the feature stay, unlinked.</p>
              : <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>}
            {ticket.worktree && <p className="muted">Its copy of the folder is removed if it has no unsaved changes. Its saved versions and any pull request stay.</p>}
          </ConfirmDialog>
        )}
      </aside>
    </div>
    </FileLinksProvider>
  );
}

/**
 * What the helper did about this ticket's open wait ("Urgent: Phone 14:02; reminders stopped when you opened this",
 * "In the 16:00 summary: ..."), the same line as the Inbox's, while the helper is on: a small bell next to the title with
 * the line as its tooltip. It opens the alert's message when there is one.
 */
function HelperIcon({ slug, ticketId }: { slug: string; ticketId: string }) {
  const { status } = useHelper();
  const key = `${slug}/${ticketId}`;
  const line = status?.on ? status.lines[key] : undefined;
  if (!line) return null;
  const msg = status?.lineMsg?.[key];
  const cls = `icon-btn helper-icon${line.startsWith("Urgent") ? " urgent" : ""}`;
  return msg
    ? <a className={cls} href={messageHash(msg)} title={`${line} · open the message`} aria-label={`${line}. Open the message`}><BellIcon size={14} /></a>
    : <span className={cls} role="img" tabIndex={0} title={line} aria-label={line}><BellIcon size={14} /></span>;
}

/** "Model and effort" from the ⋯ menu: the dropdowns under the header's first row, with Done (Esc closes too). */
function RunPopover({ profile, ticket, onError, onClose }: { profile: Profile; ticket: Ticket; onError: (m: string) => void; onClose: () => void }) {
  useLayer(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".select-trigger")?.focus()); }, []);
  return (
    <div className="run-popover" ref={ref} role="group" aria-label="Model and effort for this ticket">
      <span className="field-key">Model and effort</span>
      <RunSettings profile={profile} ticket={ticket} onError={onError} startOpen />
      <button className="btn small" onClick={onClose}>Done</button>
    </div>
  );
}

/**
 * Whether the form, card or message the ticket waits on (attentionGoal's targets, not the message box it falls back to)
 * is on screen in the panel: the sidebar's "Answer questions" button hides meanwhile. Re-checked as the chat changes.
 */
function useGoalOnScreen(panelRef: React.RefObject<HTMLElement | null>, targets: string[] | null): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const key = targets?.join("|") ?? "";
  useEffect(() => {
    setOnScreen(false);
    const panel = panelRef.current;
    const sels = (targets ?? []).filter((t) => t !== ".reply-text");
    if (!panel || !sels.length || typeof IntersectionObserver === "undefined") return;
    let watched: Element | null = null;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === watched) setOnScreen(e.isIntersecting);
    });
    const find = () => {
      const main = panel.querySelector(".panel-main");
      for (const sel of sels) {
        const all = main?.querySelectorAll(sel);
        if (all?.length) return all[all.length - 1];
      }
      return null;
    };
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = find();
      if (el === watched) return;
      if (watched) io.unobserve(watched);
      watched = el;
      if (el) io.observe(el);
      else setOnScreen(false);
    };
    check();
    const mo = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    mo.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      mo.disconnect();
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [panelRef, key]);
  return onScreen;
}

/** The feature's "Where we are" at the top of a main ticket's sidebar: progress, what is done, what waits, what's next. */
function WhereWeAre({ slug, ticket, tickets, onOpen }: { slug: string; ticket: Ticket; tickets: Ticket[]; onOpen: () => void }) {
  const { status } = useFeatureStatus(slug, ticket, tickets);
  if (!status) return null;
  const { done, total } = taskProgress(status.facts);
  const saved = status.saved;
  return (
    <section className="where-we-are" aria-label="Where we are">
      <div className="section-head">
        <h4>Where we are</h4>
        <button className="mini-link" onClick={onOpen} title="The whole status and every task, in the Tasks tab">Tasks ▸</button>
      </div>
      {total > 0 && <div className="wwa-count muted small">{done} of {total} tasks done</div>}
      {saved?.done && <p className="wwa-line">{saved.done}</p>}
      {saved?.waiting && <p className="wwa-line"><b>Waiting on you:</b> {saved.waiting}</p>}
      {saved?.next && <p className="wwa-line"><b>Next:</b> {saved.next}</p>}
      {!saved && <p className="wwa-line muted small">No status written yet.</p>}
    </section>
  );
}

/** The chat is old (cacheNote.ts): the next message re-reads it all. Fresh chat starts a new session; the status stays. */
function OldChatNote({ slug, ticket, working, feature, onError }: { slug: string; ticket: Ticket; working: boolean; feature: boolean; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  // Re-checked every minute: a chat turns old an hour (or 5 minutes) after Claude's last reply.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const old = oldChat({ cache: ticket.session?.cache, running: working, freshSession: ticket.freshSession, now });
  if (!old) return null;
  const fresh = async () => {
    setBusy(true);
    try {
      await api.freshChat(slug, ticket.id);
    } catch (e: any) {
      onError(`Fresh chat not started: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="old-chat-note" title={old.title}>
      <span>{old.line}</span>
      <button className="btn small" disabled={busy} onClick={fresh}
        title={`Your next message starts a new chat: Claude starts from ${feature ? "the status" : "the ticket and its last result"}. The chat history${feature ? ", status" : ""} and outputs stay.`}>
        {busy ? "Starting…" : feature ? "Fresh chat (keeps status)" : "Fresh chat"}
      </button>
    </div>
  );
}
