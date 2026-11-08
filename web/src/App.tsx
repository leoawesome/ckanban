import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markOpened } from "./cardState";
import { api, copy, COLUMNS, onReconnect, subscribe, waitsForSlot, type Health, type InboxItem, type Job, type McpState, type Profile, type Schedule, type Status, type Ticket } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { BugReportDialog } from "./BugReportDialog";
import { AutomationsDialog } from "./AutomationsDialog";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { HeaderMenu, type MenuItem } from "./HeaderMenu";
import { ThemePicker } from "./ThemePicker";
import { boardTags, hasTags, parseSearch, tagStyle } from "./tagText";
import { TagFilter } from "./Tags";
import { AtIcon, BellIcon, BugIcon, ChatIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, DeviceIcon, FolderIcon, GearIcon, KeyboardIcon, LinkIcon, LoopIcon, Logo, PlugIcon, PlusIcon, SearchIcon, TeamIcon, TerminalIcon } from "./icons";
import { Inbox, type InboxHelper } from "./Inbox";
import { NowView } from "./NowView";
import { NotificationsDialog } from "./NotificationsDialog";
import { DevicesDialog } from "./DevicesDialog";
import { PushHint } from "./PushHint";
import { startPushClient } from "./push";
import { PhoneAccessDialog } from "./PhoneAccessDialog";
import { MoreSheet, PhoneNav, type PhoneTab } from "./PhoneNav";
import { askInChat, QuickChatPane } from "./QuickChat";
import { TOOLS_IN_MENU_QUERY, useMedia, usePhone } from "./usePhone";
import { StatusPill, UsageBox } from "./UsagePill";
import { useUsage } from "./useUsage";
import { onlyBaseLayers } from "./layers";
import { Board, useCollapsedColumns } from "./Board";
import { boardColumnOf, columnNeighbours, columnOrder, STATUS_MENU } from "./columns";
import { ColumnPicker } from "./ColumnPicker";
import { setThemeChoice, type ThemeChoice } from "./theme";
import { afterBar, ticketActions } from "./ticketActions";
import { hiddenTool } from "./family";
import { searchBoard } from "./toolTickets";
import { ConfirmDialog } from "./ConfirmDialog";
import { deleteTitle, parkNeedsConfirm, parkText, parkTitle, toolCount } from "./familyActions";
import { NewTicketDialog } from "./NewTicketDialog";
import { ProfileDialog } from "./ProfileDialog";
import { SchedulesDialog } from "./SchedulesDialog";
import { SnippetsDialog } from "./SnippetsDialog";
import { FindLinksDialog } from "./FindLinksDialog";
import { Select } from "./Select";
import { BoardSwitcher, ShortcutsDialog } from "./Shortcuts";
import { CommandBar, type CommandAction } from "./CommandBar";
import { boardDigit, cardDir, cardKey, inDock, isBoardPickerKey, isInboxKey, isTyping, isUndoKey, panelBoardKey, stepBoard, stepCard, type CardPos } from "./keynav";
import { HintLegend, KeyHint, useHintReveal } from "./KeyHint";
import { teamButtonText } from "./huddleText";
import { TicketDrawer } from "./TicketDrawer";
import { SideChat, useChatWidth } from "./SideChat";
import { CHAT_OPEN_KEY, initialChatOpen, ticketPlacement } from "./sideChatLayout";
import { toast, Toaster, undoLatest } from "./toast";
import { clearArrival, noteServerMove } from "./arrivals";
import { SampleOffer } from "./SampleOffer";

import type { DockTab } from "./Dock";
import type { HuddleSeed, TeamRequest } from "./Team";
import { liveHuddleCount, useBoardHuddles, useHuddleIdleTick } from "./huddle";
import { hasOpenPr, runCounts } from "./boardStats";
import { ParallelConfirm } from "./ParallelConfirm";
import { closeSteps, openDepth } from "./ticketHistory";
import { helperApi, messageHash, messagesRoute, MESSAGES_HASH, setHelperStatus, useHelper } from "./helper";
import { HelperNotice, MessagePage, MessagesHistory } from "./Messages";

// xterm.js and highlight.js only load once the panel is opened. After an upgrade the old chunk is gone:
// reload once to get the new build instead of blanking the whole page.
// The phone's Team tab (the panel's Team on computers).
const PhoneTeam = lazy(() => import("./Team").then((m) => ({ default: m.TeamTab }), () => ({
  default: () => <div className="empty">Couldn't load Team. Reload the page.</div>,
})));
const Dock = lazy(() => import("./Dock").then((m) => {
  sessionStorage.removeItem("ckanban.chunkReload");
  return m;
}, () => {
  if (!sessionStorage.getItem("ckanban.chunkReload")) {
    sessionStorage.setItem("ckanban.chunkReload", "1");
    location.reload();
  }
  return { default: () => <div className="dock dock-failed">Couldn't load the terminal panel. Reload the page.</div> };
}));
const DOCK_OPEN = "ckanban.dock.open";

const LAST_PROFILE = "ckanban.profile";
/** Board slug the sample ticket is offered on, until it is started or dismissed. */
const SAMPLE_OFFER = "ckanban.sample-offer";

/**
 * URL hash is the source of truth for what's open: #/<profile> or #/<profile>/<ticketId>. Pages that aren't a board
 * start with "~" (#/~messages, helper.ts) and leave the board and ticket as they are.
 */
function parseHash(): { slug: string | null; ticket: string | null } {
  if (location.hash.startsWith("#/~")) return { slug: null, ticket: null };
  let path = location.hash.replace(/^#/, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  const [, slug, ticket] = path.split("/");
  return { slug: slug || null, ticket: ticket || null };
}

function hashFor(slug: string | null, ticket?: string | null): string {
  if (!slug) return "#/";
  return `#/${encodeURIComponent(slug)}${ticket ? `/${encodeURIComponent(ticket)}` : ""}`;
}

/** Cards on screen, per expanded column, in board order. */
function cardGrid(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>(".board > .column:not(.collapsed)")]
    .map((c) => [...c.querySelectorAll<HTMLElement>(".column-body > .sortable-card")]);
}

function focusedCard(grid: HTMLElement[][]): CardPos | null {
  const el = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card");
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].findIndex((c) => c === el);
    if (row >= 0) return { col, row };
  }
  return null;
}

/** The board card that has the keyboard, if any (its ticket id). */
function focusedCardId(): string | null {
  return (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card")?.getAttribute("data-ticket") ?? null;
}

/** Give a card the keyboard again by ticket id (after it moved to another column, its element is a new one). */
function refocusCard(id: string) {
  setTimeout(() => {
    const el = [...document.querySelectorAll<HTMLElement>(".sortable-card")].find((c) => c.dataset.ticket === id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function focusCard(pos: CardPos | null, grid = cardGrid()) {
  const col = pos && grid[pos.col];
  const el = col && col[Math.min(pos.row, col.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Board filter chips; several on = tickets matching any of them. */
const FILTERS = [
  { id: "you", label: "Needs you", test: (t: Ticket) => !!t.attention },
  { id: "running", label: "Running", test: (t: Ticket) => t.status === "in_progress" || !!t.running },
  { id: "pr", label: "Has PR", test: hasOpenPr },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DISMISSED = "ckanban.dismissedBanners";
function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) ?? "[]"));
  } catch {
    return new Set();
  }
}

const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Background load: retry once after a few seconds, then say so (quietly) instead of failing silently. */
/** Least time between two live-update reloads of the Inbox (see refreshInboxSoon). */
const INBOX_GAP_MS = 3000;

function quiet<T>(load: () => Promise<T>, what: string, set: (v: T) => void) {
  load().then(set).catch(() => {
    setTimeout(() => load().then(set).catch(() => toast(`Couldn't load ${what}. It will retry when the connection comes back.`, { tone: "error" })), 3000);
  });
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

/**
 * The one-time offer to set up proactive check-ins: what Claude could check (e.g. "Slack and Linear"), when a connected
 * Claude server for messages, issues, code or a calendar exists, the board has no check-in schedule yet and the user
 * hasn't dismissed it. Null: don't offer.
 */
function checkinOffer(profile: Profile, mcp: McpState | null, schedules: Schedule[] | null): string | null {
  if (profile.checkinOfferDismissed || !mcp || !schedules) return null;
  if (schedules.some((s) => s.quiet || s.tags?.includes("check-in"))) return null;
  const found: string[] = [];
  for (const [re, name] of [[/slack/i, "Slack"], [/linear/i, "Linear"], [/github/i, "GitHub"], [/gmail/i, "Gmail"], [/calendar/i, "your calendar"]] as const) {
    if (mcp.servers.some((x) => x.status === "connected" && re.test(x.name)) && !found.includes(name)) found.push(name);
  }
  if (!found.length) return null;
  return found.length === 1 ? found[0] : `${found.slice(0, -1).join(", ")} and ${found.at(-1)}`;
}

export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(parseHash().slug ?? readLast());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The board whose tickets are in `tickets`: until it matches the board shown, the list is still loading (not empty).
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      // A panel left on the old Claude item opens as the side chat instead (initialChatOpen).
      return localStorage.getItem(DOCK_OPEN) === "1" && localStorage.getItem("ckanban.dock.tab") !== "claude";
    } catch {
      return false;
    }
  });
  // The quick Claude chat on computers: a side panel on the right (SideChat.tsx); chatFocus: put the keyboard in it.
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return initialChatOpen((k) => localStorage.getItem(k));
    } catch {
      return false;
    }
  });
  const [chatFocus, setChatFocus] = useState(0);
  const chatWidth = useChatWidth();
  const [openId, setOpenId] = useState<string | null>(parseHash().ticket);
  // The Messages pages (#/~messages, #/~messages/<id>): shown in place of the board, under the same top bar.
  const [msgRoute, setMsgRoute] = useState(() => messagesRoute(location.hash));
  const helper = useHelper();
  // Close went Back over the tickets opened in a row: if it lands on a ticket we didn't open (a pasted link), show the board instead.
  const closing = useRef(false);
  // The open ticket was reached with prev/next: the drawer stays put instead of sliding in again.
  const stepped = useRef(false);
  // Column and ticket order prev/next follow, frozen when the drawer opens (see below).
  const [navOrder, setNavOrder] = useState<{ column: Status; ids: string[] } | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [query, setQuery] = useState("");
  // Tags picked by clicking a card's tag chip, shown as chips in the search box (typed #tags stay in the query).
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  useEffect(() => setTagFilter([]), [slug]);
  const clearSearch = () => { setQuery(""); setTagFilter([]); };
  const searchRef = useRef<HTMLInputElement>(null);
  const inboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileDialog, setProfileDialog] = useState<"new" | "edit" | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const [sampleFor, setSampleForState] = useState(() => { try { return localStorage.getItem(SAMPLE_OFFER); } catch { return null; } });
  const setSampleFor = (v: string | null) => {
    setSampleForState(v);
    try { if (v) localStorage.setItem(SAMPLE_OFFER, v); else localStorage.removeItem(SAMPLE_OFFER); } catch {}
  };
  const setError = (msg: string) => toast(msg, { tone: "error" });
  const [filters, setFilters] = useState<Set<FilterId>>(new Set());
  const { collapsed, setColumnCollapsed } = useCollapsedColumns();
  // A focused card's M (Move to column) and ⌘K Delete ticket…; cmdCard: the card focused when ⌘K opened.
  const [moveAsk, setMoveAsk] = useState<string | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const [cmdCard, setCmdCard] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [shortcuts, setShortcuts] = useState(false);
  useHintReveal(); // its legend, <HintLegend />, sits at the top of the JSX below
  const [bugReport, setBugReport] = useState(false);
  // ⌘K command bar; the inbox and usage popovers open from it too (n makes repeats count).
  const [commandBar, setCommandBar] = useState(false);
  const [inboxRequest, setInboxRequest] = useState(0);
  const [usageRequest, setUsageRequest] = useState(0);
  // Plan usage and today's spend: the header pill on computers, the More sheet on phones.
  const usage = useUsage();
  const [boardSwitcher, setBoardSwitcher] = useState(false);
  // Command to type into the dock's terminal (e.g. "claude mcp login x"); n makes repeats count.
  const [dockCommand, setDockCommand] = useState<{ text: string; n: number } | null>(null);
  // Item the bottom panel should show (Terminal, Files, Claude or Team); n makes repeats count.
  const [dockTab, setDockTab] = useState<{ tab: DockTab; n: number; team?: TeamRequest } | null>(null);
  // Item the open panel shows (reported by the panel), for the header buttons' on state.
  const [dockShown, setDockShown] = useState<DockTab | null>(null);
  const shownItem = dockOpen ? dockShown : null;
  /** team: what the Team shows (the new-teammate editor, a proposal to edit, a teammate, the huddles). */
  const openDockOn = (tab: DockTab, team?: TeamRequest) => {
    setDockOpen(true);
    setDockTab({ tab, n: Date.now(), ...(team ? { team } : {}) });
  };
  /** A header button or its key: shows that item in the panel, or hides the panel when it already shows it. */
  const toggleDock = (tab: DockTab) => (shownItem === tab ? setDockOpen(false) : openDockOn(tab));
  /** The quick chats with Claude: the Ask tab on phones, the side chat on computers. */
  const openChat = () => {
    if (phoneRef.current) return setPhoneTab("ask");
    setChatOpen(true);
    setChatFocus(Date.now());
  };
  /** C and the header's Claude button: open the side chat, or hide it when it is open. */
  const toggleChat = () => (chatOpen ? setChatOpen(false) : openChat());
  const [mcp, setMcp] = useState<McpState | null>(null);
  const [connections, setConnections] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // One-time scheduled jobs (Schedules → Upcoming, the chip on the ticket that scheduled them); jobFilter: one ticket's only.
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const openSchedules = useCallback((ticketId: string | null = null) => {
    setJobFilter(ticketId);
    setSchedulesOpen(true);
  }, []);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [findLinksOpen, setFindLinksOpen] = useState(false);
  // Automations (this board) and the board's passes in Connections: they fetch for themselves and refetch when this
  // counter moves (the server says an automation or a pass changed).
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [autoTick, setAutoTick] = useState(0);
  const schedulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phone = usePhone();
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // Phone home: the Now list or the board (bottom tab bar); More opens the header menu as a sheet.
  const [phoneTab, setPhoneTab] = useState<PhoneTab>("now");
  const [phoneTeamRequest, setPhoneTeamRequest] = useState<(TeamRequest & { n: number }) | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [phoneAccess, setPhoneAccess] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  // Phone notifications: tell the daemon while the board is on screen here, open tapped notifications' tickets.
  useEffect(() => startPushClient(), []);
  const [version, setVersion] = useState<{ version: string; latest: string | null; updateAvailable: boolean } | null>(null);

  const loadProfiles = useCallback(async () => {
    const ps = await api.profiles();
    setProfiles(ps);
    setSlug((cur) => (cur && ps.some((p) => p.slug === cur) ? cur : ps[0]?.slug ?? null));
  }, []);

  const slugRef = useRef(slug);
  slugRef.current = slug;
  // A late answer for a board no longer shown is dropped (it would show that board's cards here).
  const loadTickets = useCallback((board: string) => api.tickets(board).then((list) => {
    if (slugRef.current !== board) return;
    setTickets(list);
    setLoadedSlug(board);
  }), []);
  const loadSchedules = useCallback((board: string) => api.schedules(board).then((list) => {
    // Ignore a late answer for a board we already left.
    if (slugRef.current === board) setSchedules(list);
  }).catch(() => {}), []);
  const loadJobs = useCallback((board: string) => api.jobs(board).then((list) => {
    if (slugRef.current === board) setJobs(list);
  }).catch(() => {}), []);
  // Fires and ticket changes move "next run", "running" and errors: refetch for the computed fields.
  const refreshSchedulesSoon = useCallback((board: string) => {
    if (schedulesTimer.current) return;
    schedulesTimer.current = setTimeout(() => {
      schedulesTimer.current = null;
      loadSchedules(board);
    }, 300);
  }, [loadSchedules]);

  const [snoozed, setSnoozed] = useState<InboxItem[]>([]);
  const loadInbox = useCallback(() => quiet(api.inbox, "the inbox", (list) => {
    setInbox(list.filter((i) => !i.snoozedUntil));
    setSnoozed(list.filter((i) => i.snoozedUntil));
    setInboxLoaded(true);
  }), []);
  // Live updates refresh the Inbox, but at most one request at a time and one every INBOX_GAP_MS: the Inbox looks at
  // every ticket on every board, and with several runs going, ticket updates arrive many times a second (each one
  // used to reload it, which kept the daemon busy and the whole board slow).
  const inboxBusy = useRef(false);
  const inboxAgain = useRef(false);
  const inboxLast = useRef(0);
  const refreshInboxSoon = useCallback(() => {
    if (inboxBusy.current) {
      inboxAgain.current = true;
      return;
    }
    if (inboxTimer.current) return;
    const wait = Math.max(400, inboxLast.current + INBOX_GAP_MS - Date.now());
    inboxTimer.current = setTimeout(() => {
      inboxTimer.current = null;
      inboxBusy.current = true;
      inboxAgain.current = false;
      inboxLast.current = Date.now();
      const done = () => {
        inboxBusy.current = false;
        if (inboxAgain.current) refreshInboxSoon();
      };
      api.inbox().then((list) => {
        setInbox(list.filter((i) => !i.snoozedUntil));
        setSnoozed(list.filter((i) => i.snoozedUntil));
        setInboxLoaded(true);
      }).catch(() => {}).finally(done);
    }, wait);
  }, []);

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    loadInbox();
    quiet(api.health, "tool checks", setHealth);
    quiet(api.version, "the version", setVersion);
    quiet(api.mcp, "connections", setMcp);
  }, [loadProfiles, loadInbox]);
  // First visit with no boards yet: open New board straight away (it lists recent Claude Code folders).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (profiles?.length !== 0 || autoOpened.current) return;
    autoOpened.current = true;
    setProfileDialog("new");
  }, [profiles]);

  // Browser Back/Forward and pasted links drive the open board and ticket.
  useEffect(() => {
    const onHash = () => {
      setMsgRoute(messagesRoute(location.hash));
      if (location.hash.startsWith("#/~")) return;
      const h = parseHash();
      if (h.slug) setSlug(h.slug);
      setOpenId(h.ticket);
      stepped.current = false;
    };
    const onPop = () => {
      if (!closing.current) return;
      closing.current = false;
      const h = parseHash();
      if (!h.ticket) return;
      history.replaceState(null, "", hashFor(h.slug));
      setOpenId(null);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // Keep the URL in step with the board shown (replace, so switching boards doesn't pile up history).
  useEffect(() => {
    if (slug && !location.hash.startsWith("#/~") && parseHash().slug !== slug) history.replaceState(null, "", hashFor(slug, openId));
  }, [slug]);

  const openTicket = useCallback((id: string, board = slug) => {
    if (!board) return;
    const target = hashFor(board, id);
    if (location.hash === target) return;
    const ckDepth = openDepth(history.state, parseHash().slug, board);
    location.hash = target;
    history.replaceState({ ckDepth, ckBoard: board }, "", target);
  }, [slug]);

  // Prev/next in the drawer: replace the history entry, so one Close or Back still returns to the board.
  const stepTicket = useCallback((id: string) => {
    stepped.current = true;
    history.replaceState(history.state, "", hashFor(slug, id));
    setOpenId(id);
  }, [slug]);

  // A huddle badge or the dock's Huddles list: open the ticket on its Huddle tab.
  const [huddleTab, setHuddleTab] = useState<{ id: string; n: number; huddleId?: string } | null>(null);
  const openHuddle = useCallback((id: string, huddleId?: string) => {
    setHuddleTab({ id, n: Date.now(), huddleId });
    if (id !== openId) openTicket(id);
  }, [openId, openTicket]);
  const huddles = useBoardHuddles(slug);
  // The Team tab's Start huddle: the drawer's ticket (or a new one) opens on its Huddle tab with this roster filled in.
  const [huddleSeed, setHuddleSeed] = useState<{ id: string; seed: HuddleSeed; n: number } | null>(null);

  // Close always shows the board: Back over every ticket opened in a row (browser Back still steps through them).
  const closeTicket = useCallback(() => {
    const steps = closeSteps(history.state, slug);
    if (steps > 0) {
      closing.current = true;
      history.go(-steps);
    } else {
      history.replaceState(null, "", hashFor(slug));
      setOpenId(null);
    }
  }, [slug]);

  // After the daemon restarts or the laptop wakes, events were missed: reload everything.
  // A pending daemon restart holds new runs on every board: show it so queued cards don't look stuck.
  const [restart, setRestart] = useState({ pending: false, waiting: 0 });
  useEffect(() => { api.restartState().then(setRestart).catch(() => {}); }, []);
  // The daemon keeps the Mac awake while work runs (board setting): said quietly in the running pill's tooltip.
  const [awake, setAwake] = useState(false);
  useEffect(() => { api.awakeState().then((s) => setAwake(s.held)).catch(() => {}); }, []);

  useEffect(() => onReconnect(() => {
    api.restartState().then(setRestart).catch(() => {});
    api.awakeState().then((s) => setAwake(s.held)).catch(() => {});
    loadProfiles().catch(() => {});
    loadInbox();
    api.mcp().then(setMcp).catch(() => {});
    if (slug) {
      loadTickets(slug).catch(() => {});
      loadSchedules(slug);
      loadJobs(slug);
    }
  }), [slug, loadProfiles, loadInbox, loadSchedules, loadJobs, loadTickets]);

  const needYou = inbox.length;
  // A snooze ends by itself: reload when the first one runs out (the server only counts it again then).
  useEffect(() => {
    if (!snoozed.length) return;
    const first = Math.min(...snoozed.map((i) => Date.parse(i.snoozedUntil!)));
    const timer = setTimeout(() => {
      loadInbox();
      if (slugRef.current) loadTickets(slugRef.current).catch(() => {});
    }, Math.min(Math.max(first - Date.now(), 0) + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [snoozed, loadInbox]);
  // A run that ends while this tab is hidden puts ✓ in the tab title for 10 seconds.
  const [ranOut, setRanOut] = useState(false);
  const workingIds = useRef<Set<string>>(new Set());
  const ranOutTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const now = new Set(tickets.filter((t) => !hiddenTool(t) && (t.status === "in_progress" || t.running)).map((t) => t.id));
    const ended = [...workingIds.current].some((id) => !now.has(id) && tickets.some((t) => t.id === id));
    workingIds.current = now;
    if (!ended || !document.hidden) return;
    setRanOut(true);
    clearTimeout(ranOutTimer.current);
    ranOutTimer.current = setTimeout(() => setRanOut(false), 10_000);
  }, [tickets]);
  useEffect(() => () => clearTimeout(ranOutTimer.current), []);
  useEffect(() => {
    document.title = `${ranOut ? "✓ " : ""}${needYou ? `(${needYou}) ` : ""}ckanban`;
  }, [needYou, ranOut]);

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_OPEN, dockOpen ? "1" : "0");
    } catch {}
  }, [dockOpen]);
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? "1" : "0");
    } catch {}
  }, [chatOpen]);
  // An item request is one-shot: reopening the panel later shows the user's last item.
  useEffect(() => {
    if (!dockOpen) setDockTab(null);
  }, [dockOpen]);

  // Board switching (B picker, [ ] prev/next, 1…9) leaves the open ticket: it belongs to the old board.
  const switchBoard = useCallback((to: string) => {
    if (to === slugRef.current) return;
    setOpenId(null);
    setSlug(to);
  }, []);
  // Latest values for the window key handler below, which is bound once per dialog state.
  const live = useRef({ profiles, tickets, markDone: (_id: string) => {}, toggleStar: (_id: string) => {}, inboxCount: 0 });

  // Shortcuts: N new ticket, / search, ? cheatsheet, Ctrl+` Terminal, F Files, C Claude, T Team (each toggles its item in the bottom panel),
  // ⌘K command bar (tickets on every board, actions, boards), I the Inbox, U the newest toast's Undo,
  // B or ⌘B board picker, [ ] previous / next board, 1…9 board N, J/K/H/L or arrows select a card;
  // on a focused card S stars, M moves to a column, D marks a Review card done.
  // With a ticket panel open (and it has the keyboard) only N, ?, B, U, ⌘K and ⌘B; single keys stay quiet while typing
  // and inside the bottom panel. Esc is handled by the panel and dialogs (one layer at a time, see layers.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        if (slug) toggleDock("terminal");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Works without a board too, and over the ticket panel (its own entries join the list); a second ⌘K closes the bar.
        const free = onlyBaseLayers();
        setCmdCard(focusedCardId());
        setCommandBar((o) => (o ? false : free));
        return;
      }
      const boards = live.current.profiles ?? [];
      if (isBoardPickerKey(e)) {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Like ⌘K: works from a text field and over the ticket panel too, and a second ⌘B closes the picker.
        const free = onlyBaseLayers();
        setBoardSwitcher((o) => (o ? false : free && boards.length > 0));
        return;
      }
      const at = boards.findIndex((p) => p.slug === slug);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || inDock(e)) return;
      // U: the newest toast's Undo (Moved…, Snoozed…), from the board, the ticket panel or the open Inbox; not over a dialog.
      if (isUndoKey(e)) {
        if (!document.querySelector(".overlay") && undoLatest()) e.preventDefault();
        return;
      }
      if (profileDialog || newTicket || connections || schedulesOpen || automationsOpen || !onlyBaseLayers() || document.querySelector(".overlay")) return;
      if (openId) {
        // The ticket panel has the keyboard (nothing above it, nothing typed into): N, ? and B still work.
        const k = e.defaultPrevented ? null : panelBoardKey(e);
        if (!k) return;
        e.preventDefault();
        if (k === "new") { if (slug) setNewTicket(true); }
        else if (k === "shortcuts") setShortcuts(true);
        else if (boards.length) setBoardSwitcher(true);
        return;
      }
      // Plain 1…9 (Alt+digit is taken by Chrome's tab switching); the ticket panel's questions form uses digits too.
      const digit = e.shiftKey || e.isComposing ? null : boardDigit(e.code);
      if (digit !== null) {
        if (!boards[digit]) return;
        e.preventDefault();
        switchBoard(boards[digit].slug);
        return;
      }
      const dir = e.shiftKey && e.key.startsWith("Arrow") ? null : cardDir(e.key);
      if (dir) {
        // A picked-up card (Space) moves with the arrows instead: leave those to the drag.
        if (!slug || e.defaultPrevented || document.querySelector(".sortable-card[aria-pressed='true']")) return;
        // Arrows on a focused button or menu trigger belong to it; J/K/H/L work from anywhere.
        const focus = document.activeElement;
        if (e.key.startsWith("Arrow") && focus && focus !== document.body && !focus.closest(".sortable-card")) return;
        const grid = cardGrid();
        const next = stepCard(grid.map((c) => c.length), focusedCard(grid), dir);
        if (!next) return;
        e.preventDefault();
        focusCard(next, grid);
        return;
      }
      // S, M and D on a focused card (elsewhere they do nothing).
      const card = cardKey(e);
      const cardId = card && focusedCardId();
      if (card && cardId) {
        e.preventDefault();
        if (card === "star") live.current.toggleStar(cardId);
        else if (card === "move") setMoveAsk(cardId);
        else live.current.markDone(cardId);
        return;
      }
      if (isInboxKey(e)) {
        if (!live.current.inboxCount) return;
        e.preventDefault();
        setInboxRequest(Date.now());
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (slug) (phoneRef.current ? openChat() : toggleChat());
      } else if (e.key === "f" || e.key === "F") {
        if (!slug || phoneRef.current) return;
        e.preventDefault();
        toggleDock("files");
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        if (slug) toggleDock("team");
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (boards.length) setBoardSwitcher(true);
      } else if (e.key === "[" || e.key === "]") {
        const to = boards[stepBoard(boards.length, at, e.key === "]" ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        switchBoard(to.slug);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, schedulesOpen, automationsOpen, slug, switchBoard, dockOpen, dockShown, chatOpen]);

  const runInTerminal = useCallback((text: string) => {
    setDockOpen(true);
    setDockCommand({ text, n: Date.now() });
  }, []);

  const dismiss = (key: string) => setDismissed((d) => {
    const next = new Set(d).add(key);
    try {
      sessionStorage.setItem(DISMISSED, JSON.stringify([...next]));
    } catch {}
    return next;
  });

  // The remembered board may be gone (deleted, or another ckanban on this port): wait until the board list confirms it.
  const slugKnown = !!slug && !!profiles?.some((p) => p.slug === slug);
  useEffect(() => {
    if (!slug || !slugKnown) return;
    try {
      localStorage.setItem(LAST_PROFILE, slug);
    } catch {}
    setTickets([]);
    setLoadedSlug(null);
    setSchedules(null);
    setJobs(null);
    loadTickets(slug).catch((e) => setError(e.message));
    loadSchedules(slug);
    loadJobs(slug);
  }, [slug, slugKnown, loadSchedules, loadJobs, loadTickets]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "mcp.updated") {
          setMcp(e.state);
          return;
        }
        if (e.type === "integration.updated" || (e.type === "loop.updated" && e.profile === slug)) {
          setAutoTick((n) => n + 1);
          return;
        }
        if (e.type === "restart.updated") {
          setRestart({ pending: e.pending, waiting: e.waiting });
          return;
        }
        if (e.type === "awake.updated") {
          setAwake(e.held);
          return;
        }
        // An urgent message (or its reminder) from the helper: a toast on the board that opens the message.
        if (e.type === "helper.message") {
          if ((e.level === "urgent" || e.level === "reminder") && messagesRoute(location.hash)?.id !== e.id) {
            toast(<><b>Urgent:</b> {e.oneLine}</>, { tone: "error", ms: 20_000, action: { label: "Open", run: () => { location.hash = messageHash(e.id); } } });
          }
          return;
        }
        if (e.type === "profile.updated") {
          loadProfiles().catch(() => {});
          refreshInboxSoon();
          return;
        }
        if (e.type === "ticket.updated" || e.type === "ticket.deleted" || e.type === "session.updated" || e.type === "huddle.updated") refreshInboxSoon();
        if (e.type === "schedule.updated" && e.profile === slug) refreshSchedulesSoon(slug);
        if (e.type === "job.updated" && e.profile === slug) {
          const job = e.job;
          setJobs((js) => (js ? [...js.filter((j) => j.id !== e.id), ...(job ? [job] : [])] : js));
        }
        if (e.type === "ticket.updated" && e.profile === slug && e.ticket.scheduleId) refreshSchedulesSoon(slug);
        if (e.type === "ticket.updated" && e.profile === slug) {
          setTickets((ts) => {
            const i = ts.findIndex((t) => t.id === e.ticket.id);
            const merged = { ...ts[i], ...e.ticket };
            if (i < 0) return [...ts, merged];
            // Claude moved it to another column (the board's own moves already show it there): show the move.
            if (boardColumnOf(ts[i]) !== boardColumnOf(merged)) noteServerMove(merged.id, boardColumnOf(merged));
            const next = ts.slice();
            next[i] = merged;
            return next;
          });
        }
        if (e.type === "session.updated" && e.profile === slug) {
          setTickets((ts) => ts.map((t) => (t.id === e.id ? { ...t, session: e.session } : t)));
        }
        if (e.type === "ticket.deleted" && e.profile === slug) {
          setTickets((ts) => ts.filter((t) => t.id !== e.id));
        }
      }),
    [slug, loadProfiles, refreshInboxSoon, refreshSchedulesSoon],
  );

  const profile = useMemo(() => profiles?.find((p) => p.slug === slug) ?? null, [profiles, slug]);
  const open = tickets.find((t) => t.id === openId) ?? null;
  // The side chat (computers): the board and the bottom panel get narrower. A ticket opens between the board and the
  // chat on wide windows, over the chat on narrow ones; the chat stays mounted either way (ticketPlacement).
  const sideChat = chatOpen && !phone && !!profile;
  const besideTicket = sideChat && ticketPlacement(chatWidth.windowWidth, chatWidth.width) === "beside";
  const topbarRef = useRef<HTMLElement>(null);
  const [topbarBottom, setTopbarBottom] = useState(0);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTopbarBottom(Math.round(el.getBoundingClientRect().bottom)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Opening a ticket (or having it open when it starts waiting) stops its "Your turn" pulse.
  useEffect(() => {
    if (openId) markOpened(openId);
  }, [openId, open?.attention?.since]);
  // The open ticket isn't "new" on the board, even when Claude moves it while you read it.
  useEffect(() => {
    if (openId) clearArrival(openId);
  }, [openId, open?.status]);

  /** Start huddle from the Team tab: on the ticket open in the drawer, else on a new ticket in Planning. No picker. */
  const startHuddle = async (seed: HuddleSeed) => {
    if (!profile) return;
    let id = open?.id;
    if (!id) {
      try {
        const what = "preset" in seed ? `@${seed.preset}` : `the ${seed.template} template`;
        const t = await api.createTicket(profile.slug, {
          title: "preset" in seed ? `Huddle with @${seed.preset}` : `Huddle: ${seed.template}`,
          body: `Started from the Team tab: a huddle with ${what}. Say what it should work on.`, status: "planning",
        });
        setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
        id = t.id;
      } catch (e) {
        toast(`Couldn't create the ticket: ${(e as Error).message}`, { tone: "error" });
        return;
      }
    }
    setHuddleSeed({ id, seed, n: Date.now() });
    openHuddle(id);
  };
  // The drawer has taken the Huddle tab request (as its first tab, or switched to it): forget it.
  useEffect(() => {
    if (huddleTab && open?.id === huddleTab.id) setHuddleTab(null);
  }, [huddleTab, open?.id]);
  const search = parseSearch(query);
  const q = search.text;
  const tagsWanted = [...new Set([...tagFilter, ...search.tags])];
  const activeFilters = FILTERS.filter((f) => filters.has(f.id));
  // Tool tickets have no card: a search that finds one shows its main ticket's card, "via" the tool ticket.
  const visibleTickets = useMemo(() => tickets.filter((t) => !hiddenTool(t)), [tickets]);
  const { shown: shownTickets, via: searchVia } = useMemo(() => searchBoard(tickets, (t) => !q || `${t.title}\n${t.body}`.toLowerCase().includes(q),
    (t) => hasTags(t, tagsWanted) && (!activeFilters.length || activeFilters.some((f) => f.test(t))), !!q),
  [tickets, query, tagFilter, filters]);
  const filtering = !!q || tagsWanted.length > 0 || activeFilters.length > 0;
  // Prev/next walk the visible tickets of the column the drawer opened in, in its order at that time, so
  // moving the open ticket (e.g. Planning to Done) keeps Next in Planning, and the ends of the column stop
  // there. Stepping keeps that order; deleted tickets are skipped.
  const liveOrder = open ? { column: boardColumnOf(open), ids: columnOrder(shownTickets, boardColumnOf(open)) } : null;
  const orderMissing = !!openId && !navOrder?.ids.includes(openId);
  useEffect(() => {
    if (!openId) setNavOrder(null);
    else if (!stepped.current || orderMissing) setNavOrder(liveOrder);
  }, [openId, orderMissing, tickets.length > 0]);
  // navOrder is null until the effect above runs (and whenever no ticket is open): fall back to the live order.
  const navIn = orderMissing ? liveOrder : navOrder ?? liveOrder;
  const { prev: prevId, next: nextId } = open && navIn ? columnNeighbours(navIn.ids, navIn.column, open.id, tickets) : { prev: null, next: null };
  const perBoard = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inbox) m.set(i.profile, (m.get(i.profile) ?? 0) + 1);
    return m;
  }, [inbox]);

  // Without an order the server puts the ticket where a column entry goes (e.g. top of Done).
  // "Move to board" in the ticket menu: the other boards; the ticket leaves this board and shows up in the target's Backlog.
  const moveTo = useMemo(() => ({
    boards: (profiles ?? []).filter((p) => p.slug !== slug).map((p) => ({ slug: p.slug, name: p.name })),
    onMove: async (id: string, to: { slug: string; name: string }) => {
      try {
        const t = await api.moveTicketToBoard(slug!, id, to.slug);
        toast(<>Moved <b>{t.title}</b> to {to.name}. It is in that board's Backlog.</>);
        return true;
      } catch (e: any) {
        toast(e.message, { tone: "error" });
        return false;
      }
    },
  }), [profiles, slug]);

  // A feature card (main ticket with tool tickets) dragged to Backlog or Done: one confirm first (familyActions.ts).
  const [parkAsk, setParkAsk] = useState<{ id: string; status: "backlog" | "done"; order?: number } | null>(null);
  const move = async (id: string, status: Status, order?: number, undo = true, confirmed = false) => {
    const board = slug!;
    const before = tickets.find((t) => t.id === id);
    if (!confirmed && before && parkNeedsConfirm(before, status)) {
      setParkAsk({ id, status: status as "backlog" | "done", order });
      return;
    }
    // You moved it yourself: it isn't "new" where it lands.
    clearArrival(id);
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, ...(order === undefined ? {} : { order }) } : t)));
    try {
      await api.updateTicket(board, id, order === undefined ? { status } : { status, order });
      if (undo && before && before.status !== status) {
        const label = COLUMNS.find((c) => c.id === status)?.label ?? status;
        toast(<>Moved <b>{before.title}</b> to {label}</>, {
          action: { label: "Undo", run: () => { if (slugRef.current === board) move(id, before.status, before.order, false); } },
        });
      }
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      loadTickets(board).catch(() => {});
    }
  };

  // D on a focused Review card; focus stays at the same spot on the board for the next key.
  const markDone = (id: string) => {
    if (tickets.find((t) => t.id === id)?.status !== "review") return;
    const pos = focusedCard(cardGrid());
    void move(id, "done");
    setTimeout(() => focusCard(pos));
  };
  // S on a focused card: star / unstar (shows at once, the server confirms).
  const toggleStar = (id: string) => {
    const t = tickets.find((x) => x.id === id);
    const board = slug;
    if (!t || !board) return;
    const important = !t.important;
    setTickets((ts) => ts.map((x) => (x.id === id ? { ...x, important } : x)));
    api.updateTicket(board, id, { important }).catch((e) => {
      setError(`Couldn't ${important ? "star" : "unstar"} the ticket: ${e.message}`);
      loadTickets(board).catch(() => {});
    });
  };
  live.current = { profiles, tickets, markDone, toggleStar, inboxCount: inbox.length + snoozed.length };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const scheduleFails = schedules?.filter((s) => s.lastError).length ?? 0;
  const missing = health ? (["claude", "git", "gh"] as const).filter((k) => !health[k]) : [];
  // Every active ticket run (chat replies and Planning too); slots: the working runs, as the server counts them.
  const running = runCounts(tickets, huddles);
  // A huddle that has sat finished-looking for hours asks "Finished?" and stops counting as live.
  useHuddleIdleTick();
  const liveHuddles = liveHuddleCount(huddles);
  // Lessons the board saved on its own since the user last looked (Team, Learned).
  const [learnedNew, setLearnedNew] = useState(0);
  useEffect(() => {
    setLearnedNew(0);
    if (!slug) return;
    const load = () => api.learned(slug).then((v) => setLearnedNew(v.newCount), () => {});
    load();
    return subscribe((e) => {
      if (e.type === "learned.updated" && (e.profile === slug || e.profile === null)) load();
    });
  }, [slug]);
  const queued = visibleTickets.filter((t) => t.status === "ready" || waitsForSlot(t)).length;
  const ticketsLoaded = !!slug && loadedSlug === slug;
  // Mid width (not a phone): the tool buttons live in ⋯ so New ticket always fits.
  const toolsInMenu = useMedia(TOOLS_IN_MENU_QUERY) && !phone;

  const updateKey = `update:${version?.latest}`;
  const pathKey = `path:${missing.join(",")}`;
  const folderKey = `folder:${profile?.slug}`;
  const toggleFilter = (id: FilterId) => setFilters((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toolItems: MenuItem[] = toolsInMenu && profile ? [
    { label: "Terminal", icon: <TerminalIcon size={14} />, onSelect: () => openDockOn("terminal") },
    { label: "Files", icon: <FolderIcon size={14} />, onSelect: () => openDockOn("files") },
    { label: "Quick Claude chat", icon: <ChatIcon size={14} />, onSelect: () => openChat() },
    {
      label: "Team", icon: <TeamIcon size={14} />, separator: true,
      onSelect: () => (learnedNew ? openDockOn("team", { action: "learned" }) : openDockOn("team")),
      badge: liveHuddles > 0 ? <span className="tab-count ok">{liveHuddles} live</span> : learnedNew > 0 ? <span className="tab-count">{learnedNew} new</span> : undefined,
    },
  ] : [];
  const menuItems: MenuItem[] = [
    ...toolItems,
          ...(profile ? [{
            label: "Schedules", icon: <ClockIcon />, onSelect: () => openSchedules(),
            title: scheduleFails ? `${scheduleFails} schedule${scheduleFails === 1 ? "" : "s"} could not start their last run`
              : "Upcoming one-time jobs and recurring tickets",
            badge: scheduleFails > 0 ? <span className="need-chip">{scheduleFails}</span>
              : schedules && schedules.length > 0 ? <span className="muted small">{schedules.filter((s) => s.enabled).length} active</span> : null,
          }, {
            label: "Automations", icon: <LoopIcon />, onSelect: () => setAutomationsOpen(true),
            title: "Check a service on a timer, without Claude, and turn new items into tickets on this board",
          }, {
            label: "Snippets", icon: <AtIcon />, onSelect: () => setSnippetsOpen(true),
            title: "Reusable prompt text: type @name in a ticket or the chat to insert it",
          }, {
            label: "Find links", icon: <LinkIcon />, onSelect: () => setFindLinksOpen(true),
            title: "Claude suggests which tickets belong together (part of one piece of work); you pick the links to make",
          }] : []),
          { label: "Devices", icon: <DeviceIcon />, onSelect: () => setDevicesOpen(true), title: "Shared devices (a phone, a WhatsApp Web tab): who uses each one and who waits" },
          {
            label: "Connections", icon: <PlugIcon />, onSelect: () => setConnections(true), separator: true,
            title: mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers",
            badge: mcpAttention > 0 ? <span className="need-chip">{mcpAttention}</span> : null,
          },
          ...(profile ? [{ label: "Board settings", icon: <GearIcon />, onSelect: () => setProfileDialog("edit") }] : []),
          { label: "Phone access", icon: <DeviceIcon />, onSelect: () => setPhoneAccess(true), title: "Open this board from your phone over Tailscale" },
          {
            label: "Messages", icon: <BellIcon />, onSelect: () => { location.hash = MESSAGES_HASH; },
            title: "Everything the helper and the board told you, in full",
            badge: helper.unread > 0 ? <span className="need-chip">{helper.unread} new</span> : null,
          },
          { label: "Notifications", icon: <BellIcon />, onSelect: () => setNotifications(true), title: "The helper and where it reaches you: this Mac, your phone, ntfy, Telegram" },
          { label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, onSelect: () => setShortcuts(true) },
          { label: "Report a bug", icon: <BugIcon />, onSelect: () => setBugReport(true) },
  ];
  const menuAlert = scheduleFails > 0 || mcpAttention > 0 || (toolItems.length > 0 && learnedNew > 0);
  const menuFooter = version && version.version !== "dev" ? `ckanban v${version.version} · by Leo` : "by Leo";
  // Inbox triage on any board: the entry leaves the list (and the counts) at once, the server confirms.
  const inboxDone = async (i: InboxItem) => {
    setInbox((l) => l.filter((x) => x !== i));
    setSnoozed((l) => l.filter((x) => x !== i));
    if (i.profile === slug) return move(i.id, "done").finally(loadInbox);
    try {
      const before = await api.ticket(i.profile, i.id).catch(() => null);
      await api.updateTicket(i.profile, i.id, { status: "done" });
      toast(<>Moved <b>{i.title}</b> to Done</>, before && before.status !== "done" ? {
        action: {
          label: "Undo",
          run: () => void api.updateTicket(i.profile, i.id, { status: before.status, order: before.order }).then(loadInbox,
            (e: any) => setError(`Couldn't move the ticket back: ${e.message}`)),
        },
      } : undefined);
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      loadInbox();
    }
  };
  const inboxSnooze = async (i: InboxItem, on: boolean) => {
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    if (on) {
      setInbox((l) => l.filter((x) => x !== i));
      setSnoozed((l) => [...l, { ...i, snoozedUntil: until }]);
    } else {
      setSnoozed((l) => l.filter((x) => x !== i));
      setInbox((l) => [...l, { ...i, snoozedUntil: undefined }]);
    }
    if (i.profile === slug) setTickets((ts) => ts.map((t) => (t.id === i.id ? { ...t, attention: on ? null : i.attention, snoozed: on ? { attention: i.attention, until } : null } : t)));
    try {
      const t = await (on ? api.snooze(i.profile, i.id) : api.unsnooze(i.profile, i.id));
      const merge = (t: Ticket) => { if (i.profile === slugRef.current) setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...t } : x))); };
      if (on) toast(<>Snoozed <b>{i.title}</b> for a day</>, { action: { label: "Undo", run: () => void api.unsnooze(i.profile, i.id).then((t) => { merge(t); loadInbox(); }, () => {}) } });
      merge(t);
    } catch (e: any) {
      setError(`Couldn't ${on ? "snooze" : "unsnooze"} the ticket: ${e.message}`);
      if (i.profile === slugRef.current) loadTickets(i.profile).catch(() => {});
    }
    loadInbox();
  };
  /** Snooze all (the Inbox's Older group): each for a day, one toast with one Undo. */
  const inboxSnoozeAll = async (list: InboxItem[]) => {
    if (!list.length) return;
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    const keys = new Set(list.map((i) => `${i.profile}/${i.id}`));
    const hit = (x: InboxItem) => keys.has(`${x.profile}/${x.id}`);
    setInbox((l) => l.filter((x) => !hit(x)));
    setSnoozed((l) => [...l.filter((x) => !hit(x)), ...list.map((i) => ({ ...i, snoozedUntil: until }))]);
    const here = new Map(list.filter((i) => i.profile === slug).map((i) => [i.id, i]));
    if (here.size) setTickets((ts) => ts.map((t) => {
      const i = here.get(t.id);
      return i ? { ...t, attention: null, snoozed: { attention: i.attention, until } } : t;
    }));
    const done = await Promise.allSettled(list.map((i) => api.snooze(i.profile, i.id)));
    const ok = list.filter((_, n) => done[n].status === "fulfilled");
    if (ok.length < list.length) setError(`Couldn't snooze ${list.length - ok.length} of ${list.length} tickets.`);
    if (ok.length) {
      toast(<>Snoozed {ok.length} {ok.length === 1 ? "ticket" : "tickets"} for a day</>, {
        action: {
          label: "Undo",
          run: () => void Promise.allSettled(ok.map((i) => api.unsnooze(i.profile, i.id))).then(() => {
            loadInbox();
            if (slugRef.current) loadTickets(slugRef.current).catch(() => {});
          }),
        },
      });
    }
    if (slug) loadTickets(slug).catch(() => {});
    loadInbox();
  };

  const openFrom = (board: string, id: string) => {
    if (board !== slug) setSlug(board);
    openTicket(id, board);
  };

  // The helper's part of the Inbox and the phone view (helper.ts): status, "Messages, N new", Should have pinged me.
  const inboxHelper: InboxHelper | undefined = helper.status ? {
    status: helper.status,
    unread: helper.unread,
    onOpenMessages: () => { location.hash = MESSAGES_HASH; },
    onShouldHavePinged: (i) => void helperApi.shouldHavePinged(i.profile, i.id).then(
      () => toast("Thanks. I noted that you want to hear about these sooner.", { tone: "ok" }),
      (e) => toast((e as Error).message, { tone: "error" }),
    ),
    onNoticeSeen: () => void helperApi.noticeSeen().then(setHelperStatus, () => {}),
  } : undefined;

  // ⌘K actions run the same handlers as their buttons, keys and menu items. An open ticket's own entries come first
  // (ticketActions.ts); with a card focused on the board, that card's.
  const cardTicket = !openId && cmdCard ? tickets.find((t) => t.id === cmdCard) ?? null : null;
  const cardActions: CommandAction[] = cardTicket ? [
    { id: "card-star", label: cardTicket.important ? "Remove the star" : "Star as important", hint: cardTicket.title, keys: ["S"], run: () => toggleStar(cardTicket.id) },
    { id: "card-move", label: "Move to a column…", hint: cardTicket.title, keys: ["M"], run: afterBar(() => setMoveAsk(cardTicket.id)) },
    ...(cardTicket.status === "review" ? [{ id: "card-done", label: "Mark done", hint: cardTicket.title, keys: ["D"], run: afterBar(() => markDone(cardTicket.id)) }] : []),
    { id: "card-delete", label: "Delete ticket…", hint: cardTicket.title, run: afterBar(() => setDeleteAsk(cardTicket.id)) },
  ] : [];
  const boardTagNames = boardTags(tickets).map((t) => t.name);
  const commandActions: CommandAction[] = [
    ...(commandBar && openId ? ticketActions() : []),
    ...cardActions,
    ...(profile ? [
      { id: "new", label: "New ticket", keys: ["N"], run: () => setNewTicket(true) },
      { id: "dock", label: "Open terminal", keys: ["Ctrl", "`"], icon: <TerminalIcon size={14} />, run: () => openDockOn("terminal") },
      { id: "files", label: "Open files", keys: ["F"], icon: <FolderIcon size={14} />, hint: "browse this folder", run: () => openDockOn("files") },
      { id: "chat", label: "Quick Claude chat", keys: ["C"], icon: <ChatIcon size={14} />, run: () => openChat() },
    ] : []),
    ...(profile ? [
      { id: "team", label: "Open Team", keys: ["T"], icon: <TeamIcon size={14} />, hint: "teammates, templates, huddles", run: () => openDockOn("team") },
      { id: "huddles", label: liveHuddles ? `Huddles (${liveHuddles} live)` : "Huddles", icon: <TeamIcon size={14} />, hint: "in Team", run: () => openDockOn("team", { action: "huddles" }) },
      { id: "new-teammate", label: "New teammate…", run: () => openDockOn("team", { action: "new" }) },
    ] : []),
    ...(inbox.length || snoozed.length ? [{
      id: "inbox", label: inbox.length ? `Open inbox (${inbox.length} need you)` : `Open inbox (${snoozed.length} snoozed)`, keys: ["I"],
      run: () => setInboxRequest(Date.now()),
    }] : []),
    ...(profile ? [{ id: "schedules", label: "Schedules", icon: <ClockIcon size={14} />, run: () => openSchedules() }] : []),
    ...(profile ? [{ id: "automations", label: "Automations", icon: <LoopIcon size={14} />, run: () => setAutomationsOpen(true) }] : []),
    { id: "connections", label: "Connections", icon: <PlugIcon size={14} />, run: () => setConnections(true) },
    { id: "devices", label: "Devices", icon: <DeviceIcon size={14} />, hint: "who uses each shared device", run: () => setDevicesOpen(true) },
    ...(profile ? [{ id: "snippets", label: "Snippets", icon: <AtIcon size={14} />, run: () => setSnippetsOpen(true) }] : []),
    ...(profile ? [{ id: "find-links", label: "Find links", icon: <LinkIcon size={14} />, hint: "tickets that belong together", run: () => setFindLinksOpen(true) }] : []),
    { id: "usage", label: "Usage", run: () => setUsageRequest(Date.now()) },
    ...(profile ? [{ id: "settings", label: "Board settings", icon: <GearIcon size={14} />, run: () => setProfileDialog("edit") }] : []),
    { id: "new-board", label: "New board", run: () => setProfileDialog("new") },
    { id: "messages", label: helper.unread ? `Messages (${helper.unread} new)` : "Messages", hint: "everything the helper told you", run: () => { location.hash = MESSAGES_HASH; } },
    { id: "notifications", label: "Notifications", icon: <BellIcon size={14} />, hint: "on your phone when a ticket needs you", run: () => setNotifications(true) },
    { id: "phone", label: "Phone access", icon: <DeviceIcon size={14} />, hint: "open the board from your phone", run: () => setPhoneAccess(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", keys: ["?"], icon: <KeyboardIcon size={14} />, run: () => setShortcuts(true) },
    { id: "bug", label: "Report a bug", icon: <BugIcon size={14} />, run: () => setBugReport(true) },
    // Listed once something is typed: the board's filters (the chips), its tags, folding columns, and the theme.
    ...(profile && !phone ? [
      ...FILTERS.map((f) => ({ id: `filter-${f.id}`, label: `${filters.has(f.id) ? "Stop filtering" : "Filter"}: ${f.label}`, searchOnly: true, run: () => toggleFilter(f.id) })),
      ...boardTagNames.map((g) => ({
        id: `tag-${g}`, label: `${tagFilter.includes(g) ? "Stop filtering by tag" : "Filter by tag"}: #${g}`, searchOnly: true,
        run: () => setTagFilter((f) => (f.includes(g) ? f.filter((x) => x !== g) : [...f, g])),
      })),
      ...(filtering ? [{ id: "filter-clear", label: "Clear search and filters", searchOnly: true, run: () => { clearSearch(); setFilters(new Set()); } }] : []),
      ...STATUS_MENU.map((c) => ({
        id: `column-${c.id}`, label: `${collapsed.has(c.id) ? "Expand" : "Collapse"} column: ${c.label}`, searchOnly: true,
        run: () => setColumnCollapsed(c.id, !collapsed.has(c.id)),
      })),
    ] : []),
    ...(["system", "light", "dark"] as ThemeChoice[]).map((v) => ({
      id: `theme-${v}`, label: `Theme: ${v === "system" ? "System" : v === "light" ? "Light" : "Dark"}`, searchOnly: true, run: () => setThemeChoice(v),
    })),
  ];

  return (
    <div className="app">
      <HintLegend />
      <header className="topbar" ref={topbarRef}>
        <div className="brand">
          <KeyHint keys="⌘K" />
          <Logo />
          <span className="brand-name">ckanban</span>
          {!profiles?.length && <span className="brand-tagline">Kanban for Claude Code</span>}
        </div>
        {profiles && profiles.length > 0 && (
          <Select
            className="profile-select"
            ariaLabel="Board"
            value={slug ?? ""}
            onChange={(v) => {
              // Picking a board on a Messages page goes to that board.
              if (msgRoute) location.hash = hashFor(v);
              setSlug(v);
            }}
            menuClassName="profile-menu"
            menuMaxHeight={440}
            options={profiles.map((p) => ({ value: p.slug, label: p.name, hint: tildePath(p.path) }))}
            renderOption={(o, selected) => (
              <>
                <span className="profile-avatar" style={{ background: avatarColor(o.value) }} aria-hidden>{avatarLetter(String(o.label))}</span>
                <span className="profile-body">
                  <span className="profile-row">
                    <span className="profile-name">{o.label}</span>
                    {!!perBoard.get(o.value) && <span className="need-chip">{perBoard.get(o.value)} need you</span>}
                  </span>
                  <span className="profile-path" title={profiles.find((p) => p.slug === o.value)?.path}>{o.hint}</span>
                </span>
                <span className="profile-check" aria-hidden>{selected && <CheckIcon size={14} />}</span>
              </>
            )}
            renderValue={() => profile?.name}
            badge={<KeyHint keys="⌘B" />}
            footer={[
              ...(profile ? [{
                label: "Copy folder path",
                icon: <CopyIcon size={12} />,
                onSelect: () => { copy(profile.path).then(() => toast(<>Copied <code>{tildePath(profile.path)}</code></>, { tone: "ok" })); },
              }] : []),
              { label: "New board…", onSelect: () => setProfileDialog("new") },
            ]}
          />
        )}
        <StatusPill state={usage} openRequest={usageRequest}
          board={!profile ? undefined : !ticketsLoaded ? null : { ...running, queued, awake }} />
        {restart.pending && (
          <span className="pill warn" title="The daemon restarts once every active run (on any board) has finished. Until then nothing new starts: queued tickets, chat replies and Planning interviews wait.">
            Restart pending{restart.waiting > 0 ? ` · waiting for ${restart.waiting} ${restart.waiting === 1 ? "run" : "runs"}` : ""}
          </span>
        )}
        <div className="spacer" />
        <Inbox items={inbox} snoozed={snoozed} openRequest={inboxRequest} onPick={(i) => openFrom(i.profile, i.id)}
          onMarkDone={(i) => void inboxDone(i)} onSnooze={(i, on) => void inboxSnooze(i, on)} onSnoozeAll={(l) => void inboxSnoozeAll(l)}
          helper={inboxHelper} />
        {profile && !toolsInMenu && (
          <div className="tool-group" role="group" aria-label="Tools">
            <button className={`btn ghost icon-label${shownItem === "terminal" ? " on" : ""}`} onClick={() => toggleDock("terminal")}
              aria-pressed={shownItem === "terminal"} title="A terminal in this folder (Ctrl+`). Hiding it keeps the shell running." aria-label="Terminal">
              <TerminalIcon /><span className="label">Terminal</span><KeyHint keys="Ctrl+`" />
            </button>
            <button className={`btn ghost icon-label${shownItem === "files" ? " on" : ""}`} onClick={() => toggleDock("files")}
              aria-pressed={shownItem === "files"} title="Browse the files in this folder (F)" aria-label="Files">
              <FolderIcon /><span className="label">Files</span><KeyHint keys="F" />
            </button>
            <button className={`btn ghost icon-label${sideChat ? " on" : ""}`} onClick={toggleChat}
              aria-pressed={sideChat} title="Quick chat with Claude in this folder, no ticket needed, in a panel beside the board (C)" aria-label="Quick Claude chat">
              <ChatIcon /><span className="label">Claude</span><KeyHint keys="C" />
            </button>
            <button className={`btn ghost icon-label${shownItem === "team" ? " on" : ""}`} onClick={() => (learnedNew && shownItem !== "team" ? openDockOn("team", { action: "learned" }) : toggleDock("team"))}
              aria-pressed={shownItem === "team"} title={teamButtonText(liveHuddles, learnedNew).title} aria-label={teamButtonText(liveHuddles, learnedNew).label}>
              <TeamIcon /><span className="label">Team</span>
              {(liveHuddles > 0 || learnedNew > 0) && (
                <span className="tab-counts">
                  {liveHuddles > 0 && <span className="tab-count ok">{liveHuddles} live</span>}
                  {learnedNew > 0 && <span className="tab-count">{learnedNew} new</span>}
                </span>
              )}
              <KeyHint keys="T" />
            </button>
          </div>
        )}
        {profile && (
          <button className="btn primary phone-only topbar-icon" aria-label="New ticket" onClick={() => setNewTicket(true)}><PlusIcon size={20} /></button>
        )}
        {profile && (
          <button className={`btn desktop-only${openId ? "" : " primary"}`} onClick={() => setNewTicket(true)} title="New ticket (N)">
            New ticket<KeyHint keys="N" />
          </button>
        )}
        <HeaderMenu alert={menuAlert} items={menuItems} footer={menuFooter} />
      </header>

      {/* Below the header: the board column (banners, board, bottom panel) and, on computers, the side chat. */}
      <div className="app-row">
      <div className="app-col">

      {version?.updateAvailable && !dismissed.has(updateKey) && (
        <div className="banner info" role="status">
          <span>ckanban v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(updateKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {missing.length > 0 && !dismissed.has(pathKey) && (
        <div className={`banner ${missing.includes("claude") ? "warn" : "info"}`} role="status">
          <span>
            {missing.includes("claude") && (
              <>
                <b>Claude Code</b> isn't installed, or the board can't find it, so tickets can't run. Install it from{" "}
                <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>, sign in, then reload this page.
                {" "}If this message stays, run <code>ckanban install</code> in Terminal.{" "}
              </>
            )}
            {missing.includes("git") && <><b>git</b> isn't installed: tickets still run, editing the board folder directly instead of a copy per ticket. </>}
            {missing.includes("gh") && (
              <>
                <b>gh</b> (GitHub CLI) is optional: tickets run without it; it is only needed to open and track pull requests.
                {" "}To add it: <code>brew install gh</code>, then <code>gh auth login</code> (<a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>).
              </>
            )}
          </span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(pathKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {profile && profile.pathExists === false && !dismissed.has(folderKey) && (
        <div className="banner warn" role="status">
          <span>Board folder <code>{profile.path}</code> does not exist. Tickets will not be picked up.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(folderKey)}><CloseIcon size={12} /></button>
        </div>
      )}

      {profile && checkinOffer(profile, mcp, schedules) && (
        <div className="banner info" role="status">
          <span>
            Want Claude to check {checkinOffer(profile, mcp, schedules)} every work hour and tell you what needs you? Hours with nothing new leave no ticket.
          </span>
          <button className="btn small primary" onClick={async () => {
            try {
              const t = await api.checkinSetup(profile.slug);
              openTicket(t.id);
            } catch {}
          }}>Set it up</button>
          <button className="btn small ghost" onClick={() => { api.updateProfile(profile.slug, { checkinOfferDismissed: true }).catch(() => {}); }}>No thanks</button>
          <button className="icon-btn" aria-label="Dismiss" title="Don't offer again on this board"
            onClick={() => { api.updateProfile(profile.slug, { checkinOfferDismissed: true }).catch(() => {}); }}><CloseIcon size={12} /></button>
        </div>
      )}

      {helper.status?.notice && !msgRoute && (
        <HelperNotice status={helper.status} onSettings={() => setNotifications(true)}
          onSeen={() => void helperApi.noticeSeen().then(setHelperStatus, () => {})} />
      )}

      {msgRoute ? (
        msgRoute.id
          ? <MessagePage key={msgRoute.id} id={msgRoute.id} onBack={() => { location.hash = MESSAGES_HASH; }} onOpenTicket={openFrom} />
          : <MessagesHistory onBack={() => { location.hash = hashFor(slug); }} />
      ) : profiles === null ? (
        <div className="empty"><span className="spinner" /> Loading boards…</div>
      ) : !profile ? (
        <div className="empty">
          <h2>No boards yet</h2>
          <p>A board works on one folder on your Mac.</p>
          <button className="btn primary" onClick={() => setProfileDialog("new")}>
            Create board
          </button>
        </div>
      ) : (
        phone && phoneTab === "ask" ? (
          <QuickChatPane key={profile.slug} profile={profile} phone onOpenTicket={(id) => openTicket(id)} />
        ) : phone && phoneTab === "team" ? (
          <main className="phone-team">
            <Suspense fallback={<div className="empty"><span className="spinner" /> Loading Team…</div>}>
              <PhoneTeam key={profile.slug} slug={profile.slug} boardName={profile.name} active openTicket={null} request={phoneTeamRequest}
                onOpenHuddle={openHuddle} onOpenTicket={(id) => openTicket(id)} onStartHuddle={(seed) => void startHuddle(seed)} huddles={huddles} />
            </Suspense>
          </main>
        ) : phone && phoneTab === "now" ? (
          <NowView helper={inboxHelper} inbox={inbox} tickets={tickets} slug={profile.slug} onOpen={openFrom} onMarkDone={(i) => void inboxDone(i)} onSnooze={(i) => void inboxSnooze(i, true)} onSnoozeAll={(l) => void inboxSnoozeAll(l)} onSwitchBoard={switchBoard}
            inboxLoaded={inboxLoaded} ticketsLoaded={ticketsLoaded} footer={<PushHint onSetup={() => setNotifications(true)} />} />
        ) : <>
          <div className="board-bar">
            <div className={`search${tagFilter.length ? " has-tags" : ""}`}>
              <SearchIcon className="icon search-icon" />
              {tagFilter.map((g) => (
                <button key={g} className="tag-chip search-tag" style={tagStyle(g)} title={`Stop filtering by ${g}`} aria-label={`Remove tag filter ${g}`}
                  onClick={() => setTagFilter((f) => f.filter((x) => x !== g))}>
                  #{g} <CloseIcon size={12} />
                </button>
              ))}
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tagFilter.length ? "Search" : "Search tickets · #tag"}
                aria-label="Search tickets on this board (#tag filters by tag)" aria-keyshortcuts="/"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); if (query || tagFilter.length) clearSearch(); else e.currentTarget.blur(); }
                  else if (e.key === "Backspace" && !query && tagFilter.length) setTagFilter((f) => f.slice(0, -1));
                }} />
              {query || tagFilter.length ? (
                <button className="search-clear" aria-label="Clear search" title="Clear (Esc)"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => { clearSearch(); searchRef.current?.focus(); }}>
                  <CloseIcon size={12} />
                </button>
              ) : <kbd className="search-kbd" aria-hidden>/</kbd>}
              <KeyHint keys="/" />
            </div>
            <div className="filter-chips" role="group" aria-label="Filter tickets">
              {FILTERS.map((f) => {
                const n = visibleTickets.filter(f.test).length;
                return (
                  <button key={f.id} className={`chip${filters.has(f.id) ? " on" : ""}`} aria-pressed={filters.has(f.id)} onClick={() => toggleFilter(f.id)}>
                    {f.label}{n > 0 && <span className="chip-count">{n}</span>}
                  </button>
                );
              })}
              <TagFilter tickets={tickets} picked={tagFilter} onChange={setTagFilter} />
            </div>
            {filtering && (
              <span className="muted small" aria-live="polite">
                {shownTickets.length} of {visibleTickets.length} ticket{visibleTickets.length === 1 ? "" : "s"}
                {" · "}<button className="link-btn small" onClick={() => { clearSearch(); setFilters(new Set()); }}>Clear all</button>
              </span>
            )}
          </div>
          {sampleFor === profile.slug && (
            <SampleOffer slug={profile.slug} onDismiss={() => setSampleFor(null)}
              onStarted={(t) => {
                setSampleFor(null);
                setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
                openTicket(t.id);
              }} />
          )}
          <Board tickets={shownTickets} loading={!ticketsLoaded} filtered={filtering} onOpen={(id) => openTicket(id)} onMove={move} onAdd={() => setNewTicket(true)} restartPending={restart.pending}
            collapsed={collapsed} onCollapse={setColumnCollapsed}
            slug={slug ?? undefined} jobs={jobs ?? undefined} onOpenJobs={openSchedules} via={searchVia} />
        </>
      )}
      {phone && profile && (
        <PhoneNav tab={phoneTab} needYou={perBoard.get(profile.slug) ?? 0} liveHuddles={liveHuddles} teamAlert={learnedNew > 0}
          onTab={(t) => {
            // Team opens on what is new: live huddles first, then lessons the board saved.
            if (t === "team" && phoneTab !== "team") setPhoneTeamRequest(liveHuddles ? { action: "huddles", n: Date.now() } : learnedNew ? { action: "learned", n: Date.now() } : null);
            setPhoneTab(t);
          }}
          onMore={() => setMoreOpen(true)} moreAlert={mcpAttention > 0 || scheduleFails > 0} />
      )}
      {moreOpen && <MoreSheet items={menuItems.filter((i) => i.label !== "Keyboard shortcuts")} footer={menuFooter} onClose={() => setMoreOpen(false)}
        top={<UsageBox state={usage} />} bottom={<ThemePicker />} />}
      {phoneAccess && <PhoneAccessDialog onClose={() => setPhoneAccess(false)} />}
      {devicesOpen && (
        <DevicesDialog board={profile?.slug ?? null} onClose={() => setDevicesOpen(false)}
          onOpenTicket={(board, id) => {
            setDevicesOpen(false);
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {notifications && <NotificationsDialog profile={profile?.slug ?? null} onClose={() => setNotifications(false)} />}

      {dockOpen && profile && (
        <Suspense fallback={null}>
          <Dock profile={profile} pty={health?.pty ?? true} onClose={() => setDockOpen(false)} command={dockCommand}
            onCommandSent={() => setDockCommand(null)} tabRequest={dockTab} onTabChange={setDockShown} onOpenTicket={(id) => openTicket(id)}
            huddles={huddles} onOpenHuddle={openHuddle} openTicket={open ? { id: open.id, title: open.title } : null} onStartHuddle={startHuddle} />
        </Suspense>
      )}
      </div>
      {sideChat && profile && (
        <SideChat profile={profile} chat={chatWidth} onClose={() => setChatOpen(false)} onOpenTicket={(id) => openTicket(id)}
          focusRequest={chatFocus} covered={!!open && !besideTicket} />
      )}
      </div>

      {connections && (
        <ConnectionsDialog state={mcp} refreshKey={autoTick} onClose={() => setConnections(false)}
          board={profile ? { slug: profile.slug, name: profile.name } : null}
          onRunInTerminal={profile && health?.pty !== false ? (cmd) => { setConnections(false); runInTerminal(cmd); } : undefined} />
      )}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      {bugReport && <BugReportDialog onClose={() => setBugReport(false)} />}
      {boardSwitcher && profiles && (
        <BoardSwitcher profiles={profiles} current={slug} needYou={perBoard} onClose={() => setBoardSwitcher(false)}
          onPick={(s) => { setBoardSwitcher(false); switchBoard(s); }} />
      )}
      {commandBar && (
        <CommandBar profiles={profiles ?? []} current={profile?.slug ?? null} tickets={tickets} needYou={perBoard} actions={commandActions}
          onClose={() => setCommandBar(false)} onSwitchBoard={switchBoard}
          onOpenTicket={(board, id) => {
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {schedulesOpen && profile && (
        <SchedulesDialog profile={profile} schedules={schedules} jobs={jobs} jobFilter={jobFilter} onJobFilter={setJobFilter} tickets={tickets} onClose={() => setSchedulesOpen(false)}
          onOpenTicket={(id) => { setSchedulesOpen(false); openTicket(id); }} />
      )}
      {automationsOpen && profile && (
        <AutomationsDialog profile={profile} boards={profiles ?? []} refreshKey={autoTick} onClose={() => setAutomationsOpen(false)}
          onOpenTicket={(id) => { setAutomationsOpen(false); openTicket(id); }}
          onOpenConnections={() => { setAutomationsOpen(false); setConnections(true); }} />
      )}
      {snippetsOpen && profile && <SnippetsDialog profile={profile} onClose={() => setSnippetsOpen(false)} />}
      {parkAsk && (() => {
        const t = tickets.find((x) => x.id === parkAsk.id);
        if (!t) return null;
        return (
          <ConfirmDialog title={parkTitle(t, parkAsk.status)} confirmLabel={parkAsk.status === "done" ? "Move to Done" : "Move to Backlog"} tone="primary"
            onCancel={() => setParkAsk(null)}
            onConfirm={() => { const a = parkAsk; setParkAsk(null); void move(a.id, a.status, a.order, true, true); }}>
            <p>{parkText(t)}</p>
          </ConfirmDialog>
        );
      })()}
      {moveAsk && (() => {
        const t = tickets.find((x) => x.id === moveAsk);
        if (!t) return null;
        return (
          <ColumnPicker ticket={t} onClose={() => setMoveAsk(null)}
            onPick={(status) => {
              setMoveAsk(null);
              void move(t.id, status);
              // The card has the keyboard again in its new column (unless a confirm asks first).
              if (!parkNeedsConfirm(t, status)) refocusCard(t.id);
            }} />
        );
      })()}
      {deleteAsk && profile && (() => {
        const t = tickets.find((x) => x.id === deleteAsk);
        if (!t) return null;
        const working = t.status === "in_progress" || !!t.running;
        return (
          <ConfirmDialog title={deleteTitle(t)} confirmLabel={toolCount(t) ? "Delete all" : "Delete ticket"} busyLabel="Deleting…" onCancel={() => setDeleteAsk(null)}
            onConfirm={async () => {
              await api.deleteTicket(profile.slug, t.id);
              setTickets((ts) => ts.filter((x) => x.id !== t.id));
              setDeleteAsk(null);
            }}>
            {toolCount(t) > 0
              ? <p>Work that isn't merged is lost. Their copies of the folder go too; tickets you added to the feature stay, unlinked.</p>
              : <p>Removes the ticket and its board history.{working ? " Claude will be stopped." : ""}</p>}
            {t.worktree && <p className="muted">Its copy of the folder is removed if it has no unsaved changes. Its saved versions and any pull request stay.</p>}
          </ConfirmDialog>
        );
      })()}
      {findLinksOpen && profile && <FindLinksDialog slug={profile.slug} tickets={tickets} onClose={() => setFindLinksOpen(false)} />}
      {open && profile && <TicketDrawer key={open.id} profile={profile} ticket={open} tickets={tickets} onOpenTicket={openTicket} onClose={closeTicket} moveTo={moveTo}
        jobs={jobs ?? []} onOpenJobs={openSchedules}
        nav={{ prev: prevId, next: nextId, go: stepTicket }} slideIn={!stepped.current}
        beside={besideTicket ? { right: chatWidth.width, top: topbarBottom } : null}
        tabRequest={huddleTab?.id === open.id ? { tab: "huddle", n: huddleTab.n, huddleId: huddleTab.huddleId } : null}
        huddleSeed={huddleSeed?.id === open.id ? { seed: huddleSeed.seed, n: huddleSeed.n } : null}
        onOpenTeam={(r) => { closeTicket(); openDockOn("team", r); }} />}
      {profileDialog && (
        <ProfileDialog
          profile={profileDialog === "edit" ? profile : null}
          onClose={() => setProfileDialog(null)}
          onOpenTeam={() => { setProfileDialog(null); openDockOn("team"); }}
          onSaved={(p) => {
            // The first board gets the sample ticket offer.
            if (profileDialog === "new" && profiles?.length === 0) { setSampleFor(p.slug); setPhoneTab("board"); }
            setProfileDialog(null);
            loadProfiles().then(() => setSlug(p.slug));
          }}
          onDeleted={() => {
            if (sampleFor === profile?.slug) setSampleFor(null);
            setProfileDialog(null);
            setSlug(null);
            loadProfiles();
          }}
        />
      )}
      {newTicket && profile && (
        <NewTicketDialog
          slug={profile.slug}
          folder={profile.path}
          knownTags={boardTags(tickets)}
          tickets={tickets}
          onClose={() => setNewTicket(false)}
          onAskInChat={(text) => {
            askInChat(profile.slug, text);
            setNewTicket(false);
            openChat();
          }}
          onCreate={async (input) => {
            const t = await api.createTicket(profile.slug, input);
            setTickets((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
            setNewTicket(false);
            // Planning starts the interview immediately: open the ticket so the questions are in view.
            if (t.status === "planning") openTicket(t.id);
          }}
        />
      )}
      <ParallelConfirm />
      <Toaster />
    </div>
  );
}
