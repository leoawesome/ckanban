import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { afterBackSteps } from "./backEntry";
import { GUARD_MS, GUARD_NOTE, startExitGuard } from "./exitGuard";
import { anyLayerOpen } from "../lib/layers";
import { useViewportFit } from "../lib/sheet";
import { markOpened } from "../features/board/cardState";
import { setLearnedVersions } from "../lib/models";
import { api, copy, onReconnect, subscribe, waitsForSlot, type Health, type InboxItem, type Job, type McpState, type Profile, type Schedule, type Status, type Ticket } from "../lib/api";
import { avatarColor, avatarLetter } from "../features/avatar/avatar";
import { BugReportDialog } from "../features/settings/BugReportDialog";
import { AutomationsDialog } from "../features/schedules/AutomationsDialog";
import { OPEN_AUTOMATIONS_EVENT } from "../features/schedules/AutomationCard";
import { ConnectionsDialog } from "../features/connections/ConnectionsDialog";
import { HeaderMenu, type MenuItem } from "./HeaderMenu";
import { ThemePicker } from "./ThemePicker";
import { boardTags, hasTags, parseSearch, tagStyle } from "../features/board/tagText";
import { TagFilter } from "../features/board/Tags";
import { AtIcon, BellIcon, BugIcon, ChatIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, DeviceIcon, DevicesIcon, DiffIcon, GlobeIcon, FolderIcon, InboxIcon, PanelsIcon, SlidersIcon, KeyboardIcon, LinkIcon, LoopIcon, Logo, PlugIcon, PlusIcon, SearchIcon, TeamIcon, TerminalIcon } from "../components/icons";
import { Inbox, type InboxHelper } from "../features/helper/Inbox";
import { NowView } from "../features/board/NowView";
import { NotificationsDialog } from "../features/helper/NotificationsDialog";
import { DevicesDialog } from "../features/browsers/DevicesDialog";
import { BrowsersDialog } from "../features/browsers/BrowsersDialog";
import { PushHint } from "../features/helper/PushHint";
import { startPushClient } from "../features/helper/push";
import { PhoneAccessDialog } from "../features/settings/PhoneAccessDialog";
import { MoreSheet, PhoneNav, type PhoneTab } from "./PhoneNav";
import { QuickChatPane } from "../features/quickchat/QuickChat";
import { usePhone } from "../hooks/usePhone";
import { StatusPill, UsageBox } from "../features/usage/UsagePill";
import { LowDiskBanner } from "../features/disk/LowDiskBanner";
import { ClaudeSignInStrip } from "../features/claudeSignin/ClaudeSignInStrip";
import { useUsage } from "../hooks/useUsage";
import { Board, useCollapsedColumns } from "../features/board/Board";
import { doneNotDrawn, joinsBoard } from "../features/board/donePaging";
import { pruneCardMemory } from "../features/board/Card";
import { boardColumnOf, columnNeighbours, columnOrder, nextInColumn, STATUS_MENU } from "../features/board/columns";
import { ColumnPicker } from "../components/ColumnPicker";
import { setThemeChoice, type ThemeChoice } from "./theme";
import { afterBar, ticketActions } from "../features/board/ticketActions";
import { onBoard } from "../features/family/family";
import { searchBoard } from "../features/ticket/toolTickets";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { deleteTitle, parkNeedsConfirm, parkText, parkTitle, toolCount } from "../features/family/familyActions";
import { NewTicketDialog } from "../features/board/NewTicketDialog";
import { ProfileDialog } from "../features/settings/ProfileDialog";
import { SchedulesDialog } from "../features/schedules/SchedulesDialog";
import { SnippetsDialog } from "../features/board/SnippetsDialog";
import { FindLinksDialog } from "../features/ticket/FindLinksDialog";
import { Select } from "../components/Select";
import { BoardSwitcher, ShortcutsDialog } from "./Shortcuts";
import { CommandBar, type CommandAction } from "./CommandBar";
import { HintLegend, KeyHint, useHintReveal } from "../components/KeyHint";
import { teamButtonText } from "../features/huddle/huddleText";
import { TicketDrawer } from "../features/ticket/TicketDrawer";
import { clampChatWidth, COLUMN_DEFAULT } from "../features/chat/sideChatLayout";
import type { PanelId } from "./panelState";
import { usePanels, useWindowWidth } from "../hooks/usePanels";
import { PanelsButton } from "./PanelsButton";
import { toast, Toaster } from "../components/toast";
import { clearArrival, noteServerMove } from "../features/board/arrivals";
import { SampleOffer } from "../features/board/SampleOffer";

import type { HuddleSeed, TeamRequest } from "../features/team/Team";
import { liveHuddleCount, useBoardHuddles, useHuddleIdleTick } from "../features/huddle/huddle";
import { runCounts } from "../features/board/boardStats";
import { ParallelConfirm } from "../features/ticket/ParallelConfirm";
import { AvatarEditorHost } from "../features/avatar/AvatarEditor";
import { closeSteps, openDepth } from "../features/board/ticketHistory";
import { hashMoved, helperApi, messageHash, messagesRoute, MESSAGES_HASH, setHelperStatus, takeReadFromHash, useHelper } from "../features/helper/helper";
import { backToBoard, backToList, settleMessagesEntry } from "../features/chat/msgNav";
import { HelperNotice, MessagePage, MessagesHistory } from "../features/chat/Messages";
import { LAST_PROFILE, SAMPLE_OFFER, NO_VIA, sameMap, FILTERS, type FilterId, DISMISSED, readDismissed, tildePath, quiet, readLast, checkinOffer } from "./appState";
import { parseHash, hashFor, refocusCard } from "./hash";
import { useInboxActions } from "./useInboxActions";
import { useCardMoves } from "./useCardMoves";
import { useAppKeys } from "./useAppKeys";
import { useInbox } from "./useInbox";
import { useBoardData } from "./useBoardData";

// Opened from a tap on an urgent alert about one ticket: mark that message read before the first parseHash.
takeReadFromHash();

// xterm.js and highlight.js only load once the panel is opened. After an upgrade the old chunk is gone:
// reload once to get the new build instead of blanking the whole page.
// The phone's Team tab (the panel's Team on computers).
const PhoneTeam = lazy(() => import("../features/team/Team").then((m) => ({ default: m.TeamTab }), () => ({
  default: () => <div className="empty">Couldn't load Team. Reload the page.</div>,
})));
type PanelsModule = Pick<typeof import("../features/chat/SidePanels"), "default" | "PhonePanels">;
const panelsModule = (): Promise<PanelsModule> => import("../features/chat/SidePanels").then((m) => {
  sessionStorage.removeItem("ckanban.chunkReload");
  return m;
}, () => {
  if (!sessionStorage.getItem("ckanban.chunkReload")) {
    sessionStorage.setItem("ckanban.chunkReload", "1");
    location.reload();
  }
  const Failed = () => <aside className="side-panels sp-failed">Couldn't load the side panels. Reload the page.</aside>;
  return { default: Failed as unknown as PanelsModule["default"], PhonePanels: Failed as unknown as PanelsModule["PhonePanels"] };
});
const SidePanels = lazy(panelsModule);
const PhonePanels = lazy(() => panelsModule().then((m) => ({ default: m.PhonePanels })));


export function App() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [slug, setSlug] = useState<string | null>(parseHash().slug ?? readLast());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The board whose tickets are in `tickets`: until it matches the board shown, the list is still loading (not empty).
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  // The side panel column on the right (SidePanels.tsx): Terminal, Files, Changes, Team and Claude, kept per board.
  const panels = usePanels(slug);
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
  // Phones: the top bar 🔍 on the Board tab opens and closes the search and filter panel under the top bar (Done closes it
  // too and keeps the search and filters).
  const [phoneSearch, setPhoneSearch] = useState(false);
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
  // Command to type into the Terminal panel (e.g. "claude mcp login x"); n makes repeats count.
  const [panelCommand, setPanelCommand] = useState<{ text: string; n: number } | null>(null);
  // The panel to put the keyboard in, and what the Team panel should show; n makes repeats count.
  const [panelFocus, setPanelFocus] = useState<{ id: PanelId; n: number } | null>(null);
  const [teamRequest, setTeamRequest] = useState<{ team: TeamRequest; n: number } | null>(null);
  // Phones have no column: the panel shown full screen (PhonePanels), or null.
  const [phonePanel, setPhonePanel] = useState<PanelId | null>(null);
  /**
   * Opens a panel in the column (shows the column, unfolds the panel) and puts the keyboard in it; on a phone, shows
   * it full screen. team: what the Team shows (the new-teammate editor, a proposal to edit, a teammate, the huddles).
   */
  const openPanel = (id: PanelId, team?: TeamRequest) => {
    panels.open(id);
    if (team) setTeamRequest({ team, n: Date.now() });
    if (phoneRef.current) setPhonePanel(id);
    else setPanelFocus({ id, n: Date.now() });
  };
  /** The quick chats with Claude: the Ask tab on phones, the Claude panel on computers. */
  const openChat = () => (phoneRef.current ? setPhoneTab("ask") : openPanel("claude"));
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
  /** The automation Automations opens on (a saved chat card's "Open in Automations"). */
  const [automationPick, setAutomationPick] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setAutomationPick((e as CustomEvent<{ loopId?: string }>).detail?.loopId ?? null);
      setAutomationsOpen(true);
    };
    window.addEventListener(OPEN_AUTOMATIONS_EVENT, on);
    return () => window.removeEventListener(OPEN_AUTOMATIONS_EVENT, on);
  }, []);
  const [autoTick, setAutoTick] = useState(0);
  const schedulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phone = usePhone();
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // Phone home: the Now list or the board (bottom tab bar); More opens the header menu as a sheet.
  const [phoneTab, setPhoneTab] = useState<PhoneTab>("now");
  // The Ask tab's message box stays above the phone keyboard (the page takes the height the keyboard leaves).
  const appRef = useRef<HTMLDivElement>(null);
  useViewportFit(appRef, phone && phoneTab === "ask");
  const [phoneTeamRequest, setPhoneTeamRequest] = useState<(TeamRequest & { n: number }) | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [phoneAccess, setPhoneAccess] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [browsersOpen, setBrowsersOpen] = useState(false);
  // A tap on a "browser logged out" alert (#/<board>?browsers): open More, Browsers on that board.
  useEffect(() => {
    const take = () => {
      if (!/^#\/[^?]*\?(.*&)?browsers(&|=|$)/.test(location.hash)) return;
      history.replaceState(history.state, "", location.hash.replace(/\?.*$/, ""));
      setBrowsersOpen(true);
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);
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
  const {
    doneLoading, donePaged, doneUnseen, doneUnseenRef, extraIds, loadJobs, loadMoreDone, loadSchedules, loadTickets,
    refreshSchedulesSoon, setDoneUnseen, takeExtra, ticketsRef,
  } = useBoardData({
    schedulesTimer, setJobs, setLoadedSlug, setSchedules, setTickets, slugRef, tickets,
  });

  const {
    inboxHas, inboxLists, inboxMayChange, loadInbox, refreshInboxSoon, setSnoozed, snoozed,
  } = useInbox({
    inboxTimer, setInbox, setInboxLoaded,
  });

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    loadInbox();
    quiet(api.health, "tool checks", setHealth);
    quiet(api.version, "the version", setVersion);
    quiet(api.mcp, "connections", setMcp);
    // Which version each model alias means (learned from runs), for labels like "Fable (5.2)".
    api.claudeDefaults().then((d) => setLearnedVersions(d.versions)).catch(() => {});
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
    // A Messages page opened by a fresh load (a notification, a link): the list and the board go under it, so Back works.
    settleMessagesEntry(history, location.hash, null, hashFor(slugRef.current));
    setMsgRoute(messagesRoute(location.hash));
    const onHash = (e: HashChangeEvent) => {
      takeReadFromHash();
      let prev = "";
      try {
        prev = new URL(e.oldURL).hash;
      } catch {}
      settleMessagesEntry(history, location.hash, prev, hashFor(slugRef.current));
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

  // Installed app (Android's back swipe): Back on the main screen shows a note first; a second Back closes the app.
  useEffect(() => startExitGuard({
    enabled: () => window.matchMedia("(display-mode: standalone)").matches,
    atMain: () => !location.hash.startsWith("#/~") && !parseHash().ticket && !anyLayerOpen(),
    warn: () => { toast(GUARD_NOTE, { ms: GUARD_MS }); },
  }), []);

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

  // The board's cards open their ticket (stable, so the memoised cards don't redraw on every render).
  const openCard = useCallback((id: string) => openTicket(id), [openTicket]);

  // Prev/next in the drawer: replace the history entry, so one Close or Back still returns to the board.
  // fresh: start a new prev/next order from the ticket's column as the board shows it now (after Done).
  // On a phone the step may come from a sheet's pick (Move to → Done): that sheet goes back over its own history entry
  // as it closes, so the URL is replaced only after that back step, on the ticket's own entry (backEntry.ts).
  const stepTicket = useCallback((id: string, fresh = false) => {
    afterBackSteps(() => {
      stepped.current = true;
      if (fresh) setNavOrder(null);
      history.replaceState(history.state, "", hashFor(slug, id));
      setOpenId(id);
    });
  }, [slug]);

  // A huddle badge or the Team panel's Huddles list: open the ticket on its Huddle tab.
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

  inboxLists.current = { inbox, snoozed };
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
    const now = new Set(tickets.filter((t) => onBoard(t) && (t.status === "in_progress" || t.running)).map((t) => t.id));
    const ended = [...workingIds.current].some((id) => !now.has(id) && tickets.some((t) => t.id === id));
    workingIds.current = now;
    if (!ended || !document.hidden) return;
    setRanOut(true);
    clearTimeout(ranOutTimer.current);
    ranOutTimer.current = setTimeout(() => setRanOut(false), 10_000);
  }, [tickets]);
  useEffect(() => () => clearTimeout(ranOutTimer.current), []);
  // Cards remember whether each ticket was working (Card.tsx): forget tickets no longer in the list.
  useEffect(() => {
    pruneCardMemory(tickets.length, () => new Set(tickets.map((t) => t.id)));
  }, [tickets]);
  useEffect(() => {
    document.title = `${ranOut ? "✓ " : ""}${needYou ? `(${needYou}) ` : ""}ckanban`;
  }, [needYou, ranOut]);

  // Another board: its own panels; a phone's full-screen panel closes.
  useEffect(() => setPhonePanel(null), [slug]);

  // Board switching (B picker, [ ] prev/next, 1…9) leaves the open ticket: it belongs to the old board.
  const switchBoard = useCallback((to: string) => {
    if (to === slugRef.current) return;
    setOpenId(null);
    setSlug(to);
  }, []);
  const {
    live,
  } = useAppKeys({
    automationsOpen, connections, newTicket, openChat, openId, openPanel, profileDialog, profiles, schedulesOpen,
    searchRef, setBoardSwitcher, setCmdCard, setCommandBar, setInboxRequest, setMoveAsk, setNewTicket, setShortcuts,
    slug, switchBoard, tickets,
  });

  const runInTerminal = (text: string) => {
    openPanel("terminal");
    setPanelCommand({ text, n: Date.now() });
  };

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
    setDoneUnseen(0);
    doneUnseenRef.current = 0;
    ticketsRef.current = [];
    donePaged.current = new Set();
    extraIds.current = new Set();
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
        // Only events that can change who needs the user reload the Inbox. Session and huddle changes are followed by the
        // ticket's own ticket.updated (server http.ts ssePayload), which carries its new attention.
        if (e.type === "ticket.updated" ? inboxMayChange(e.profile, e.ticket) : e.type === "ticket.deleted" && inboxHas(e.profile, e.id)) refreshInboxSoon();
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
            // A finished ticket not loaded yet stays one of Done's unloaded cards.
            if (i < 0) return joinsBoard(e.ticket) ? [...ts, merged] : ts;
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
  const ticketsLoaded = !!slug && loadedSlug === slug;
  const open = tickets.find((t) => t.id === openId) ?? null;
  // The side panel column (computers): the board gets narrower; an open ticket sits between the board and the column
  // (sideChatLayout.ts: the board gives way first, then hides; the column narrows before the ticket does).
  const windowWidth = useWindowWidth();
  const columnShown = panels.state.shown && !phone && !!profile;
  const columnWidth = clampChatWidth(panels.state.width ?? COLUMN_DEFAULT, windowWidth, !!open);
  // Mounted from the first time it shows, then only hidden, so shells, drafts and scroll survive hiding it.
  const [columnSeen, setColumnSeen] = useState<string | null>(null);
  useEffect(() => {
    if (columnShown && profile) setColumnSeen(profile.slug);
  }, [columnShown, profile?.slug]);
  const topbarRef = useRef<HTMLElement>(null);
  const [topbarBottom, setTopbarBottom] = useState(0);
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTopbarBottom(Math.round(el.getBoundingClientRect().bottom)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A finished ticket opened from a link, the Inbox or ⌘K may not be loaded yet, nor its family (the Family tab and
  // chips read the board's list): fetch it with its family, once per opened ticket.
  const fetchedOpen = useRef(new Set<string>());
  useEffect(() => {
    if (!openId || !slug || !ticketsLoaded) return;
    const held = tickets.find((t) => t.id === openId);
    if ((held && held.status !== "done") || fetchedOpen.current.has(`${slug}/${openId}`)) return;
    fetchedOpen.current.add(`${slug}/${openId}`);
    const board = slug;
    api.ticketsByIds(board, [openId]).then((page) => takeExtra(board, page)).catch(() => {});
  }, [openId, slug, ticketsLoaded, open?.status, takeExtra]);
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
        const what = "preset" in seed ? `@${seed.preset}` : `the ${seed.template} squad`;
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
  /** What the side column and the phone's panel screen show: they follow the open ticket. */
  const panelProps = (p: Profile) => ({
    profile: p, pty: health?.pty ?? true, panels, ticket: open, focus: panelFocus,
    command: panelCommand, onCommandSent: () => setPanelCommand(null), teamRequest, huddles,
    // On a phone the panel covers the ticket: showing a ticket from it goes back to the board first (the panel stays open).
    onOpenHuddle: (id: string, huddleId?: string) => { setPhonePanel(null); openHuddle(id, huddleId); },
    onOpenTicket: (id: string) => { setPhonePanel(null); openTicket(id); },
    onStartHuddle: (seed: HuddleSeed) => { setPhonePanel(null); void startHuddle(seed); },
  });
  // The drawer has taken the Huddle tab request (as its first tab, or switched to it): forget it.
  useEffect(() => {
    if (huddleTab && open?.id === huddleTab.id) setHuddleTab(null);
  }, [huddleTab, open?.id]);
  const search = parseSearch(query);
  const q = search.text;
  const tagsWanted = [...new Set([...tagFilter, ...search.tags])];
  const activeFilters = FILTERS.filter((f) => filters.has(f.id));
  // Tasks have no card unless shown on the board: a search that finds a hidden one shows its main ticket's card, "via" the task.
  const visibleTickets = useMemo(() => tickets.filter((t) => onBoard(t)), [tickets]);
  const { shown: shownTickets, via: viaNow } = useMemo(() => searchBoard(tickets, (t) => !q || `${t.title}\n${t.body}`.toLowerCase().includes(q),
    (t) => hasTags(t, tagsWanted) && (!activeFilters.length || activeFilters.some((f) => f.test(t))), !!q),
  [tickets, query, tagFilter, filters]);
  // The same Map while its content is the same (one shared empty Map without a search): a new one would redraw every card.
  const viaRef = useRef<Map<string, string>>(NO_VIA);
  if (!q || !viaNow.size) viaRef.current = NO_VIA;
  else if (!sameMap(viaRef.current, viaNow)) viaRef.current = viaNow;
  const searchVia = viaRef.current;
  const filtering = !!q || tagsWanted.length > 0 || activeFilters.length > 0;
  // While Done has cards left to load, the held ones below its last loaded page (families of open work, tickets opened
  // by link) wait for their page: the column draws its top in its final order, and pages only add below (donePaging.ts).
  // A search shows every match. donePaged changes only with the tickets, so `tickets` keeps this fresh.
  const doneWaiting = useMemo(() => (!filtering && doneUnseen > 0 ? doneNotDrawn(tickets, donePaged.current) : null), [tickets, filtering, doneUnseen]);
  const boardTickets = useMemo(() => (doneWaiting?.size ? shownTickets.filter((t) => !doneWaiting.has(t.id)) : shownTickets), [shownTickets, doneWaiting]);
  // The search also finds finished tickets Done hasn't loaded (the server looks through all of them).
  const tagKey = tagsWanted.join(",");
  useEffect(() => {
    if (!slug || !ticketsLoaded || (!q && !tagKey)) return;
    const board = slug;
    const timer = setTimeout(() => {
      api.searchDone(board, q, tagKey ? tagKey.split(",") : []).then((page) => takeExtra(board, page)).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [slug, ticketsLoaded, q, tagKey, takeExtra]);
  // Prev/next walk the visible tickets of the column the drawer opened in, in its order at that time, so
  // moving the open ticket (e.g. Planning to Done) keeps Next in Planning, and the ends of the column stop
  // there. Stepping keeps that order; deleted tickets are skipped.
  const openColumn = open ? boardColumnOf(open) : null;
  const liveOrder = useMemo(() => (openColumn ? { column: openColumn, ids: columnOrder(shownTickets, openColumn) } : null), [shownTickets, openColumn]);
  const orderMissing = !!openId && !navOrder?.ids.includes(openId);
  useEffect(() => {
    if (!openId) setNavOrder(null);
    else if (!stepped.current || orderMissing) setNavOrder(liveOrder);
  }, [openId, orderMissing, tickets.length > 0]);
  // navOrder is null until the effect above runs (and whenever no ticket is open): fall back to the live order.
  const navIn = orderMissing ? liveOrder : navOrder ?? liveOrder;
  const { prev: prevId, next: nextId } = useMemo(() => (open && navIn ? columnNeighbours(navIn.ids, navIn.column, open.id, tickets) : { prev: null, next: null }),
    [open?.id, navIn, tickets]);
  // Marked Done: the next card of the column the ticket is in now. Worked out only when asked (one pass over the board).
  const shownRef = useRef(shownTickets);
  shownRef.current = shownTickets;
  const afterDone = useCallback((id: string) => nextInColumn(shownRef.current, id), []);
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

  const {
    markDone, move, parkAsk, pin, setParkAsk, togglePin, toggleStar,
  } = useCardMoves({
    live, loadTickets, setError, setTickets, slug, slugRef, tickets,
  });
  live.current = { profiles, tickets, markDone, toggleStar, togglePin, inboxCount: inbox.length + snoozed.length };

  const mcpAttention = mcp?.servers.filter((s) => s.attention).length ?? 0;
  const scheduleFails = schedules?.filter((s) => s.lastError).length ?? 0;
  // A missing Claude Code has its own red strip (ClaudeSignInStrip: checked every 10 minutes, How to fix), not this banner.
  const missing = health ? (["git", "gh"] as const).filter((k) => !health[k]) : [];
  // Every active ticket run (chat replies and Planning too); slots: the working runs, as the server counts them.
  const running = useMemo(() => runCounts(tickets, huddles), [tickets, huddles]);
  // A huddle that has sat finished-looking for hours asks "Finished?" and stops counting as live.
  useHuddleIdleTick();
  const liveHuddles = liveHuddleCount(huddles);
  // Lessons the board saved on its own since the user last looked (Team, Learned).
  const [learnedNew, setLearnedNew] = useState(0);
  useEffect(() => {
    setLearnedNew(0);
    if (!slug) return;
    const load = () => api.learnedCount(slug).then((v) => setLearnedNew(v.newCount), () => {});
    load();
    return subscribe((e) => {
      if (e.type === "learned.updated" && (e.profile === slug || e.profile === null)) load();
    });
  }, [slug]);
  const queued = useMemo(() => visibleTickets.filter((t) => t.status === "ready" || waitsForSlot(t)).length, [visibleTickets]);
  // The filter chips' counts.
  const filterCounts = useMemo(() => new Map(FILTERS.map((f) => [f.id, visibleTickets.filter(f.test).length])), [visibleTickets]);
  const knownTags = useMemo(() => boardTags(tickets), [tickets]);

  const updateKey = `update:${version?.latest}`;
  const pathKey = `path:${missing.join(",")}`;
  const folderKey = `folder:${profile?.slug}`;
  const toggleFilter = (id: FilterId) => setFilters((f) => {
    const next = new Set(f);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // Phones have no Panels button: Terminal and Files open full screen from More (Changes, Team and Claude from + Add there).
  const toolItems: MenuItem[] = phone && profile ? [
    { label: "Terminal", icon: <TerminalIcon size={14} />, onSelect: () => openPanel("terminal") },
    { label: "Files", icon: <FolderIcon size={14} />, separator: true, onSelect: () => openPanel("files") },
  ] : [];
  const menuItems: MenuItem[] = [
    ...toolItems,
          ...(profile ? [{
            label: "Schedules", icon: <ClockIcon />, onSelect: () => openSchedules(),
            title: scheduleFails ? `${scheduleFails} schedule${scheduleFails === 1 ? "" : "s"} could not start their last run`
              : "Upcoming one-time jobs and recurring tickets",
            badge: scheduleFails > 0 ? <span className="need-chip">{scheduleFails} failed</span>
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
          { label: "Devices", icon: <DevicesIcon />, onSelect: () => setDevicesOpen(true), title: "Shared devices (a phone, a WhatsApp Web tab): who uses each one and who waits" },
          { label: "Browsers", icon: <GlobeIcon />, onSelect: () => setBrowsersOpen(true), title: "Add board browsers, sign in, and pick which browsers each board uses" },
          {
            label: "Connections", icon: <PlugIcon />, onSelect: () => setConnections(true), separator: true,
            title: mcpAttention ? `${mcpAttention} MCP server${mcpAttention === 1 ? "" : "s"} failed or need you to log in again` : "Claude Code MCP servers",
            badge: mcpAttention > 0 ? <span className="need-chip">{mcpAttention} to fix</span> : null,
          },
          ...(profile ? [{ label: "Board settings", icon: <SlidersIcon />, onSelect: () => setProfileDialog("edit") }] : []),
          { label: "Phone access", icon: <DeviceIcon />, onSelect: () => setPhoneAccess(true), title: "Open this board from your phone over Tailscale" },
          {
            label: "Messages", icon: <InboxIcon />, onSelect: () => { location.hash = MESSAGES_HASH; },
            title: "Everything the helper and the board told you, in full",
            badge: helper.unread > 0 ? <span className="need-chip">{helper.unread} unread</span> : null,
          },
          { label: "Notifications", icon: <BellIcon />, onSelect: () => setNotifications(true), title: "The helper and where it reaches you: this Mac, your phone, ntfy, Telegram" },
          { label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, onSelect: () => setShortcuts(true) },
          { label: "Report a bug", icon: <BugIcon />, onSelect: () => setBugReport(true) },
  ];
  // The phone's More sheet: Search and the everyday items first; the rest fold under "More tools" (Connections stays out
  // while it needs you). Keyboard shortcuts don't apply on a phone.
  const PHONE_MAIN = ["Messages", "Notifications", "Schedules", "Automations", "Board settings"];
  const phoneMain: MenuItem[] = [
    { label: "Search", icon: <SearchIcon />, onSelect: () => setCommandBar(true), title: "Find tickets on every board, actions and boards" },
    ...PHONE_MAIN.flatMap((l) => menuItems.filter((i) => i.label === l)),
    ...(mcpAttention > 0 ? menuItems.filter((i) => i.label === "Connections") : []),
  ].map((i) => ({ ...i, separator: false }));
  const phoneRare = menuItems.filter((i) => !phoneMain.some((m) => m.label === i.label) && i.label !== "Keyboard shortcuts")
    .map((i) => ({ ...i, separator: false }));
  const menuAlert = scheduleFails > 0 || mcpAttention > 0;
  const menuFooter = version && version.version !== "dev" ? `ckanban v${version.version} · by Leo` : "by Leo";
  const {
    inboxDone, inboxSnooze, inboxSnoozeAll, openFrom,
  } = useInboxActions({
    loadInbox, loadTickets, move, openTicket, setError, setInbox, setSlug, setSnoozed, setTickets, slug, slugRef,
  });

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
    ...(cardTicket.status !== "done" || cardTicket.pinnedAt ? [{ id: "card-pin", label: cardTicket.pinnedAt ? "Unpin" : "Pin to top", hint: cardTicket.title, keys: ["P"], run: () => togglePin(cardTicket.id) }] : []),
    { id: "card-move", label: "Move to a column…", hint: cardTicket.title, keys: ["M"], run: afterBar(() => setMoveAsk(cardTicket.id)) },
    ...(cardTicket.status === "review" ? [{ id: "card-done", label: "Mark done", hint: cardTicket.title, keys: ["D"], run: afterBar(() => markDone(cardTicket.id)) }] : []),
    { id: "card-delete", label: "Delete ticket…", hint: cardTicket.title, run: afterBar(() => setDeleteAsk(cardTicket.id)) },
  ] : [];
  const boardTagNames = knownTags.map((t) => t.name);
  const commandActions: CommandAction[] = [
    ...(commandBar && openId ? ticketActions() : []),
    ...cardActions,
    ...(profile ? [
      { id: "new", label: "New ticket", keys: ["N"], icon: <PlusIcon size={14} />, run: () => setNewTicket(true) },
      { id: "dock", label: "Open terminal", keys: ["Ctrl", "`"], icon: <TerminalIcon size={14} />, hint: open?.worktree ? "in this ticket's copy" : "in the board folder", run: () => openPanel("terminal") },
      { id: "files", label: "Open files", keys: ["F"], icon: <FolderIcon size={14} />, hint: open?.worktree ? "this ticket's copy" : "browse this folder", run: () => openPanel("files") },
      { id: "changes", label: "Open changes", icon: <DiffIcon size={14} />, hint: open ? "this ticket's changes" : "of the open ticket", run: () => openPanel("changes") },
      { id: "chat", label: "Quick Claude chat", keys: ["C"], icon: <ChatIcon size={14} />, run: () => openChat() },
      ...(!phone && panels.state.open.length ? [{
        id: "panels", label: panels.state.shown ? "Hide the side panels" : "Show the side panels", icon: <PanelsIcon size={14} />, run: () => panels.toggleColumn(),
      }] : []),
    ] : []),
    ...(profile ? [
      { id: "team", label: "Open Team", keys: ["T"], icon: <TeamIcon size={14} />, hint: "teammates, squads, huddles", run: () => openPanel("team") },
      { id: "huddles", label: liveHuddles ? `Huddles (${liveHuddles} live)` : "Huddles", icon: <TeamIcon size={14} />, hint: "in Team", run: () => openPanel("team", { action: "huddles" }) },
      { id: "new-teammate", label: "New teammate…", icon: <PlusIcon size={14} />, run: () => openPanel("team", { action: "new" }) },
    ] : []),
    ...(inbox.length || snoozed.length ? [{
      id: "inbox", label: inbox.length ? `Open inbox (${inbox.length} need you)` : `Open inbox (${snoozed.length} snoozed)`, keys: ["I"],
      run: () => setInboxRequest(Date.now()),
    }] : []),
    ...(profile ? [{ id: "schedules", label: "Schedules", icon: <ClockIcon size={14} />, run: () => openSchedules() }] : []),
    ...(profile ? [{ id: "automations", label: "Automations", icon: <LoopIcon size={14} />, run: () => setAutomationsOpen(true) }] : []),
    { id: "connections", label: "Connections", icon: <PlugIcon size={14} />, run: () => setConnections(true) },
    { id: "devices", label: "Devices", icon: <DevicesIcon size={14} />, hint: "who uses each shared device", run: () => setDevicesOpen(true) },
    { id: "browsers", label: "Browsers", icon: <GlobeIcon size={14} />, hint: "board browsers, sign in, pick each board's", run: () => setBrowsersOpen(true) },
    ...(profile ? [{ id: "snippets", label: "Snippets", icon: <AtIcon size={14} />, run: () => setSnippetsOpen(true) }] : []),
    ...(profile ? [{ id: "find-links", label: "Find links", icon: <LinkIcon size={14} />, hint: "tickets that belong together", run: () => setFindLinksOpen(true) }] : []),
    { id: "usage", label: "Usage", run: () => setUsageRequest(Date.now()) },
    ...(profile ? [{ id: "settings", label: "Board settings", icon: <SlidersIcon size={14} />, run: () => setProfileDialog("edit") }] : []),
    { id: "new-board", label: "New board", icon: <PlusIcon size={14} />, run: () => setProfileDialog("new") },
    { id: "messages", label: helper.unread ? `Messages (${helper.unread} unread)` : "Messages", icon: <InboxIcon size={14} />, hint: "everything the helper told you", run: () => { location.hash = MESSAGES_HASH; } },
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
    // A phone's Messages pages draw their own header (‹ Board · Messages), so the board's top bar steps aside.
    <div ref={appRef} className={`app${phone && msgRoute ? " msg-route" : ""}`}>
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
          <span className="pill warn" title="The daemon restarts once every active run (on any board) has finished, or after 2 minutes; runs it cuts off carry on after it. Until then queued tickets, huddle wakes and Planning interviews wait; your own chat messages are answered as usual.">
            Restart pending{restart.waiting > 0 ? ` · waiting for ${restart.waiting} ${restart.waiting === 1 ? "run" : "runs"}` : ""}
          </span>
        )}
        <div className="spacer" />
        <Inbox items={inbox} snoozed={snoozed} openRequest={inboxRequest} onPick={(i) => openFrom(i.profile, i.id)}
          onMarkDone={(i) => void inboxDone(i)} onSnooze={(i, on, len) => void inboxSnooze(i, on, len)} onSnoozeAll={(l) => void inboxSnoozeAll(l)}
          helper={inboxHelper} />
        {profile && !phone && (
          <PanelsButton panels={panels} onOpen={(id) => (id === "team" && learnedNew ? openPanel("team", { action: "learned" }) : openPanel(id))}
            badges={liveHuddles > 0 || learnedNew > 0 ? {
              team: (
                <span className="tab-counts" title={teamButtonText(liveHuddles, learnedNew).title}>
                  {liveHuddles > 0 && <span className="tab-count ok">{liveHuddles} live</span>}
                  {learnedNew > 0 && <span className="tab-count">{learnedNew} new</span>}
                </span>
              ),
            } : {}} />
        )}
        {phone && phoneTab === "board" && profile ? (
          // The Board tab: 🔍 searches and filters this board; a dot says a search or filter is on while the panel is closed.
          <button className={`btn ghost phone-only topbar-icon board-search-btn${phoneSearch ? " on" : ""}`} aria-expanded={phoneSearch}
            aria-label={phoneSearch ? "Close search and filter" : filtering ? "Search and filter this board (a filter is on)" : "Search and filter this board"}
            onClick={() => {
              if (phoneSearch) { setPhoneSearch(false); searchRef.current?.blur(); }
              else { setPhoneSearch(true); requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true })); }
            }}>
            <SearchIcon size={20} />{filtering && !phoneSearch && <span className="topbar-dot" aria-hidden />}
          </button>
        ) : (
          <button className="btn ghost phone-only topbar-icon" aria-label="Search tickets and actions" onClick={() => setCommandBar(true)}><SearchIcon size={20} /></button>
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

      {/* Below the header: the board column (banners, board) and, on computers, the side panel column. */}
      <div className="app-row">
      <div className="app-col">

      <ClaudeSignInStrip />
      <LowDiskBanner />
      {version?.updateAvailable && !dismissed.has(updateKey) && (
        <div className="banner info" role="status">
          <span>ckanban v{version.latest} is available (you have v{version.version}). Run <code>ckanban update</code> in a terminal.</span>
          <button className="icon-btn" aria-label="Dismiss" title="Hide until next time" onClick={() => dismiss(updateKey)}><CloseIcon size={12} /></button>
        </div>
      )}
      {missing.length > 0 && !dismissed.has(pathKey) && (
        <div className="banner info" role="status">
          <span>
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

      {/* The page's one h1 (screen readers jump by headings); columns and Now's sections are h2 under it. */}
      {!msgRoute && profile && <h1 className="sr-only">{profile.name}</h1>}
      {msgRoute ? (
        msgRoute.id
          ? <MessagePage key={msgRoute.id} id={msgRoute.id} onBack={() => { if (backToList(history) === "replace") hashMoved(); }} onOpenTicket={openFrom} />
          : <MessagesHistory onBack={() => { if (backToBoard(history, hashFor(slug)) === "replace") hashMoved(); }} />
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
          <NowView helper={inboxHelper} inbox={inbox} tickets={tickets} slug={profile.slug} onOpen={openFrom} onMarkDone={(i) => void inboxDone(i)} onSnooze={(i, len) => void inboxSnooze(i, true, len)} onSnoozeAll={(l) => void inboxSnoozeAll(l)} onSwitchBoard={switchBoard}
            inboxLoaded={inboxLoaded} ticketsLoaded={ticketsLoaded} footer={<PushHint onSetup={() => setNotifications(true)} />} />
        ) : <>
          <div className={`board-bar${phone && !phoneSearch ? " folded" : ""}`}>
            {/* A phone puts Done beside the field; a computer lays the row out as before (display: contents). */}
            <div className="board-search-row">
            <div className={`search${tagFilter.length ? " has-tags" : ""}`}>
              <SearchIcon className="icon search-icon" />
              {tagFilter.map((g) => (
                <button key={g} className="tag-chip search-tag" style={tagStyle(g)} title={`Stop filtering by ${g}`} aria-label={`Remove tag filter ${g}`}
                  onClick={() => setTagFilter((f) => f.filter((x) => x !== g))}>
                  #{g} <CloseIcon size={12} />
                </button>
              ))}
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tagFilter.length ? "Search" : phone ? "Search this board · #tag" : "Search tickets · #tag"}
                aria-label="Search tickets on this board (#tag filters by tag)" aria-keyshortcuts="/"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); if (query || tagFilter.length) clearSearch(); else { e.currentTarget.blur(); setPhoneSearch(false); } }
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
            <button className="link-btn phone-only board-search-done" onClick={() => { setPhoneSearch(false); searchRef.current?.blur(); }}>Done</button>
            </div>
            <div className="filter-chips" role="group" aria-label="Filter tickets">
              {FILTERS.map((f) => {
                const n = filterCounts.get(f.id) ?? 0;
                if (f.id === "pr" && n === 0 && !filters.has(f.id)) return null;
                return (
                  <button key={f.id} className={`chip${filters.has(f.id) ? " on" : ""}`} aria-pressed={filters.has(f.id)} onClick={() => toggleFilter(f.id)}>
                    {f.label}{n > 0 && <span className="chip-count">{n}</span>}
                  </button>
                );
              })}
              <TagFilter tickets={tickets} picked={tagFilter} onChange={setTagFilter} />
            </div>
            <button className="link-btn phone-only board-search-all" onClick={() => setCommandBar(true)}>
              <SearchIcon size={16} />Search every board and action ›
            </button>
            {/* One live region for the whole board, always mounted so the first count is read too. */}
            <span className="sr-only" role="status">
              {filtering ? `${shownTickets.length} of ${visibleTickets.length} ticket${visibleTickets.length === 1 ? "" : "s"} match` : ""}
            </span>
            {filtering && (
              <span className="muted small desktop-only">
                <span aria-hidden>{shownTickets.length} of {visibleTickets.length} ticket{visibleTickets.length === 1 ? "" : "s"}{" · "}</span><button className="link-btn small" onClick={() => { clearSearch(); setFilters(new Set()); }}>Clear all</button>
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
          <Board tickets={boardTickets} loading={!ticketsLoaded} done={{ more: filtering ? 0 : doneUnseen + (doneWaiting?.size ?? 0), loading: doneLoading, loadMore: loadMoreDone }} filtered={filtering} onOpen={openCard} onMove={move} onPin={pin} onAdd={() => setNewTicket(true)} restartPending={restart.pending}
            collapsed={collapsed} onCollapse={setColumnCollapsed}
            slug={slug ?? undefined} jobs={jobs ?? undefined} onOpenJobs={openSchedules} via={searchVia}
            filter={filtering ? { all: visibleTickets, doneMore: doneUnseen, clear: () => { clearSearch(); setFilters(new Set()); } } : undefined} />
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
      {moreOpen && <MoreSheet items={phoneMain} rare={phoneRare} footer={menuFooter} onClose={() => setMoreOpen(false)}
        top={<UsageBox state={usage} />} bottom={<ThemePicker />} />}
      {phoneAccess && <PhoneAccessDialog onClose={() => setPhoneAccess(false)} />}
      {browsersOpen && (
        <BrowsersDialog onClose={() => setBrowsersOpen(false)}
          onOpenTicket={(board, id) => {
            setBrowsersOpen(false);
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {devicesOpen && (
        <DevicesDialog board={profile?.slug ?? null} onClose={() => setDevicesOpen(false)}
          onOpenTicket={(board, id) => {
            setDevicesOpen(false);
            if (board !== slug) switchBoard(board);
            openTicket(id, board);
          }} />
      )}
      {notifications && <NotificationsDialog profile={profile?.slug ?? null} onClose={() => setNotifications(false)} />}

      {phone && profile && phonePanel && (
        <Suspense fallback={null}>
          <PhonePanels {...panelProps(profile)} shown={phonePanel} onShow={setPhonePanel} />
        </Suspense>
      )}
      </div>
      {profile && !phone && columnSeen === profile.slug && (
        <Suspense fallback={null}>
          <SidePanels key={profile.slug} {...panelProps(profile)} width={columnWidth} ticketOpen={!!open} />
        </Suspense>
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
        <AutomationsDialog profile={profile} boards={profiles ?? []} tickets={tickets} refreshKey={autoTick} initialId={automationPick} onClose={() => { setAutomationsOpen(false); setAutomationPick(null); }}
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
        nav={{ prev: prevId, next: nextId, go: stepTicket, afterDone }} slideIn={!stepped.current}
        beside={columnShown ? { right: columnWidth, top: topbarBottom } : null}
        tabRequest={huddleTab?.id === open.id ? { tab: "huddle", n: huddleTab.n, huddleId: huddleTab.huddleId } : null}
        huddleSeed={huddleSeed?.id === open.id ? { seed: huddleSeed.seed, n: huddleSeed.n } : null}
        onOpenTeam={(r) => openPanel("team", r)} onPin={(on) => pin(open.id, on)} />}
      {profileDialog && (
        <ProfileDialog
          profile={profileDialog === "edit" ? profile : null}
          onClose={() => setProfileDialog(null)}
          onOpenTeam={() => { setProfileDialog(null); openPanel("team"); }}
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
          profile={profile}
          knownTags={knownTags}
          tickets={tickets}
          onClose={() => setNewTicket(false)}
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
      <AvatarEditorHost />
      <Toaster />
    </div>
  );
}
