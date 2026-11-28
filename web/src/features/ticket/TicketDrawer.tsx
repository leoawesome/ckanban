import { useKeyboardFit } from "../../lib/sheet";
import { hashIsTicket, readTabLink } from "./tabLink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setCoveredFrom } from "../board/cardMotion";
import { deleteTitle, parkNeedsConfirm, parkText, parkTitle, runningTools, stopTitle, toolCount } from "../family/familyActions";
import { api, COLUMNS, safeHref, startWorkTarget, type ClaudeSession, type Job, type Profile, type Status, type Ticket } from "../../lib/api";
import { boardColumnOf, menuPick, STATUS_MENU } from "../board/columns";
import { StatusPill } from "../../components/StatusPill";
import { PANEL_LEAVE_MS, reducedMotion } from "../../lib/motion";
import { finishBadge, huddleBadge, outcomeBadge, useFinishMark } from "../board/Card";
import { featureBusy } from "../board/cardState";
import { JobChip } from "../schedules/Jobs";
import { CapActions } from "../../components/CapActions";
import { capLabel, capWait } from "../usage/capText";
import { LimitActions } from "../../components/LimitActions";
import { StallActions, stallWait } from "../../components/StallActions";
import { limitHint, limitLabel, limitWait } from "../usage/limitText";
import { branchTicket } from "../../lib/branch";
import { BugReportDialog } from "../settings/BugReportDialog";
import { Changes } from "../files/Changes";
import { HelpMenu } from "../../app/HelpMenu";
import { Chat } from "../chat/Chat";
import { useStop } from "../chat/useStop";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DescriptionEditor, useDescriptionCommands } from "./DescriptionEditor";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronUpIcon, CloseIcon, ExternalIcon, LinkIcon, PinIcon, SparkIcon } from "../../components/icons";
import { useImagePaste } from "../../lib/imagePaste";
import { useFocusTrap, useLayer } from "../../lib/layers";
import { ticketBeside } from "../chat/sideChatLayout";
import { takeTab } from "../../lib/pendingTab";
import { escLeavesField, isStopKey, nextStep, stepTab, type DrawerTab } from "../../app/keynav";
import { afterBar, provideTicketActions } from "../board/ticketActions";
import type { CommandAction } from "../../app/CommandBar";
import { attentionGoal } from "../board/attentionGoal";
import { KeyHint } from "../../components/KeyHint";
import { MOD } from "../../app/Shortcuts";
import { PlanFinished, planDone } from "../family/PlanPanel";
import { FamilyTab } from "../family/FamilyTab";
import { familyOf, featureRows, runsTasks, taskTally, tasksUnder } from "../family/family";
import { Outputs } from "../files/Outputs";
import { PrBox } from "./PrBox";
import { PrList } from "./PrList";
import { Select } from "../../components/Select";
import { attTone, phoneStatus, turnReason } from "./phoneStatus";
import { ClaudeFace } from "../chat/ConvTurn";
import { useClaudeName } from "../avatar/AvatarFace";
import { SessionPicker, sessionLabel } from "../../components/SessionPicker";
import { TicketMenu } from "./TicketMenu";
import { missingPctReason, UsagePanel, usageChipText } from "../usage/UsagePanel";
import { approxPct, costText } from "../usage/usage";
import { Markdown } from "../chat/Transcript";
import { NeedsField } from "../helper/Needs";
import { TagEditor } from "../board/Tags";
import { runSettingsText } from "./RunSettings";
import { boardTags } from "../board/tagText";
import { useHuddle, members } from "../huddle/huddle";
import { HuddlePanel } from "../huddle/HuddlePanel";
import type { HuddleSeed, TeamRequest } from "../team/Team";
import { StarToggle } from "../../components/StarToggle";
import { usePhone } from "../../hooks/usePhone";
import { useShrinkHeader } from "../../hooks/useShrinkHeader";
import { toast } from "../../components/toast";
import { FollowUpChip } from "./FollowUpChip";
import { PartOfField } from "../family/FamilyPanel";
import { taskStart, TASK_START_HINT } from "./taskStart";
import { FileLinksProvider } from "../files/FileViewer";
import { TicketSheet } from "./TicketSheet";
import { WaitBanner, HelperIcon, RunPopover, useGoalOnScreen, WhereWeAre, OldChatNote } from "./DrawerParts";
import { LINK_CHIPS, windowRoom, besideRoom, CHANGES_WIDTH, CHAT_ROOM, clampWidth, useSidebarWidth, useDetailsSplit, usePanelWidth } from "./drawerLayout";
import { useGoTo } from "./useGoTo";
import { useDrawerSync } from "./useDrawerSync";
import { usePanelKeys } from "./usePanelKeys";
import { useDrawerTabs } from "./useDrawerTabs";

/** Ticket view: details on the left, the chat with Claude filling the right side. */
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
  /** afterDone: the ticket to open once this one is marked Done (the next card of its current column), null to close. */
  nav?: { prev: string | null; next: string | null; go: (id: string, fresh?: boolean) => void; afterDone?: (id: string) => string | null };
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
  const claude = useClaudeName();
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
  // A link may name the tab (and the Outputs file) to open on: #/<board>/<ticket>?tab=outputs&file=… (tabLink.ts).
  const [linked0] = useState(() => (hashIsTicket(location.hash, ticket.id) ? readTabLink(location.hash) : { tab: null, file: null }));
  const [tabPick, setTab] = useState<DrawerTab>(tabRequest?.tab ?? (linked0.tab as DrawerTab | null) ?? "chat");
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
  // The badge counts tasks like the status's "N of M done" and the Tasks list head (taskTally over the feature's rows).
  const featRows = useMemo(() => featureRows(tickets, ticket.id), [tickets, ticket.id]);
  // What its plan runs: the tasks under it, counted by the same rule (a nested group's own row isn't a task). A main
  // ticket's are its feature's tasks, a group's the ones inside it; the badge then says the plan's numbers.
  const ownTasks = useMemo(() => (runsTasks(ticket) ? tasksUnder(featRows, ticket.id) : []), [featRows, ticket]);
  const plan = useMemo(() => planDone(ownTasks), [ownTasks]);
  const tally = useMemo(() => (runsTasks(ticket) ? plan : taskTally(featRows)), [ticket, plan, featRows]);
  const huddle = huddleState.latest;
  const {
    backToChat, diffState, formRequest, hasUsage, help, onTabKey, openOutput, openTab, outputCount, outputFocus, outputFrom, setLinkFile, setOutputCount,
    setOutputFocus, tab, tabs, ticketUsage, usage, whereShown,
  } = useDrawerTabs({
    children, familySize, huddleState, linked0, phone, setTab, slug, tabPick, ticket, tickets,
  });
  const [titleSave, setTitleSave] = useState<"saving" | "saved" | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // Phones: the panel fits above the keyboard, so the header and the message box both stay in view (as dialogs do).
  const wrapRef = useRef<HTMLDivElement>(null);
  useKeyboardFit(wrapRef, panelRef);
  // The board under this ticket pauses its card motion (cardMotion.ts): the part the panel covers, all of it on a phone.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    // offsetLeft ignores the slide-in transform; the backdrop it is measured in is the fixed wrap.
    const update = () => setCoveredFrom((el.parentElement?.getBoundingClientRect().left ?? 0) + el.offsetLeft);
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    window.addEventListener("resize", update);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); setCoveredFrom(null); };
  }, []);
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
  // The title box (desktop; phones rename in the details sheet).
  const titleRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const revertTitle = useRef(false);
  // Leaving for the neighbouring ticket: keep a title edit, and don't drop an unsaved description edit.
  const step = (id: string | null | undefined, fresh = false) => {
    if (!id || !nav || editing || confirmDelete || confirmStart || confirmBranch || moveBoard !== null || confirmStop || confirmPark || picking || reportingBug) return;
    if (title !== ticket.title) saveTitle();
    nav.go(id, fresh);
  };
  const { panelKeysRef } = usePanelKeys({ isTopLayer, nav, step });
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
  // Phones: scrolling the chat down folds the status pill row under the title away (the tab row always stays);
  // scrolling up brings it back. A new tab or ticket starts with the row shown.
  const slim = useShrinkHeader(bodyRef, phone && tab === "chat", `${tab}:${ticket.id}`);
  // Phones: the details sheet under the header's title ("move": opened by M, the keyboard on the current column).
  const [sheet, setSheet] = useState<null | "open" | "move">(null);
  useEffect(() => setSheet(null), [ticket.id]);
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
  const {
    checkTabs, links, tabsMore, tabsRef,
  } = useDrawerSync({
    editing, setBaseBody, setBody, setLinked, setOutputCount, setTitle, slug, tab, tabs, ticket, titleRef,
  });
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
  // Marked Done: on to the next ticket of the column the ticket is in now (in the board's current order, not the column
  // the panel opened in), with prev/next starting over from there, or back to the board after that column's last one,
  // at once rather than after the save, so a close in the meantime can't be undone by a late jump.
  // The drawer may be gone when the save fails, so the error goes to the board's toast.
  // A main ticket with tool tickets: Backlog and Done hold its family, after one confirm.
  const [confirmPark, setConfirmPark] = useState<"backlog" | "done" | null>(null);
  const setStatus = (status: Status, confirmed = false) => {
    if (!confirmed && parkNeedsConfirm(ticket, status)) return setConfirmPark(status as "backlog" | "done");
    if (status !== "done" || ticket.status === "done") return act(() => api.updateTicket(slug, ticket.id, { status }));
    const title = ticket.title;
    api.updateTicket(slug, ticket.id, { status }).catch((e) => toast(<>Couldn't mark <b>{title}</b> done: {e.message}</>, { tone: "error" }));
    const next = nav?.afterDone ? nav.afterDone(ticket.id) : nav?.next;
    if (next) step(next, true);
    else if (!editing) onClose();
  };
  const col = COLUMNS.find((c) => c.id === ticket.status);
  // A task (tool ticket) isn't shaped in Planning: no Planning column, no Refine with Claude.
  const isTask = !!ticket.tool;
  const statusOptions = STATUS_MENU.filter((c) => !(isTask && c.id === "planning")).map((c) => ({ value: c.id, label: c.label, hint: c.hint }));
  // A task in Backlog: "start" waits for the user (Start this task), "waits" is started by its main ticket's plan.
  const taskWait = taskStart(ticket);
  const startTarget = startWorkTarget(ticket);
  const startWork = () => (startTarget === "planning" ? setStatus("planning") : setConfirmStart(true));
  // The chat's newest unapplied proposal (Chat reports it), so ⌘⇧Enter can apply it and start work in one go.
  const applyProposalRef = useRef<((start: boolean) => Promise<void>) | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const onPendingProposal = useCallback((apply: ((start: boolean) => Promise<void>) | null) => {
    applyProposalRef.current = apply;
    setProposalPending(!!apply);
  }, []);
  const { goTo } = useGoTo({ goal, openTab, panelRef, slug, tabs, ticket, whereShown });
  const goalOnScreen = useGoalOnScreen(panelRef, goal?.targets ?? null);
  // Every task of a main ticket's plan is done: Move to Done replaces Start work.
  const finished = runsTasks(ticket) && plan.finished;
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
    else if (next === "start" && taskWait !== "waits") startWork();
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
    if (k === "r" && !working && !editing && !isTask && ticket.status === "backlog") return setStatus("planning"), true;
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
    if (phone) return setSheet("move");
    const open = () => {
      const trigger = panelRef.current?.querySelector<HTMLButtonElement>(".status-select .select-trigger");
      trigger?.focus();
      trigger?.click();
    };
    if (!detailsShown) {
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
    if (!working && !finished && taskWait !== "waits" && (ticket.status === "backlog" || ticket.status === "planning")) add("start", isTask ? "Start this task" : "Start work", startWork, next === "start" ? [MOD, "Shift", "Enter"] : undefined);
    if (!working && !editing && !isTask && ticket.status === "backlog") add("refine", "Refine with Claude", () => setStatus("planning"), ["R"]);
    add("star", ticket.important ? "Remove the star" : "Star as important", toggleStar, ["S"]);
    if (canPin) add("pin", pinned ? "Unpin" : "Pin to top", togglePin, ["P"]);
    add("move", "Move to a column…", openStatusPicker, ["M"]);
    if (!editing) add("edit", "Edit the description", () => letterRef.current("e"), ["E"]);
    if ((working || familyBusy) && !stopping) add("stop", familyBusy ? "Stop this ticket and its tasks…" : `Stop ${claude}…`, () => setConfirmStop(true), [MOD, "."]);
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
          <h3 className="sec-h status-fold-h"><button className="fold-head status-fold" aria-expanded={statusShown} onClick={() => setStatusOpen(!statusShown)}>
            <span className="fold-title">Status</span><span className="status-fold-sum">{shortStatus}</span><span className="fold-chev side" aria-hidden>▸</span>
          </button></h3>
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
            {taskWait ? TASK_START_HINT[taskWait] : <>{col!.claude && <SparkIcon className="icon spark" />}{col!.hint}</>}
          </p>
        )}

        <PrList ticket={ticket} review={ticket.status === "review"} />
        {ticket.prUrl && ticket.status === "review" && <PrBox profile={profile} ticket={ticket as Ticket & { prUrl: string }} onError={onError} />}

        <div className="action-stack">
          {goal && !working && !goalOnScreen && (
            <button className="btn primary goal-btn" onClick={goTo} title={`${att!.label}: show me where`}>{goal.button}</button>
          )}
          {working && !familyBusy && <button className="btn danger outline" disabled={stopping} onClick={stop} title={`Stop ${claude} (${MOD}.)`}>{stopping ? "Stopping…" : `Stop ${claude}`}<KeyHint keys="⌘." /></button>}
          {familyBusy && <button className="btn danger outline" disabled={stopping} onClick={() => setConfirmStop(true)} title={`Stop this ticket and its running tasks (${MOD}.)`}>{stopping ? "Stopping…" : "Stop"}<KeyHint keys="⌘." /></button>}
          {finished && <PlanFinished ticket={ticket} total={plan.total} onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />}
          {!working && !finished && taskWait !== "waits" && (ticket.status === "backlog" || ticket.status === "planning") && (
            <button className={`btn ${goal ? "" : "primary"}`}
              onClick={startWork} title={`${isTask ? "Claude works on it now, like its main ticket's other tasks" : startTarget === "planning" ? "Claude interviews you first" : "Claude works on its own"} (${proposalPending ? `${MOD}⇧Enter applies the proposal and starts` : `${MOD}⇧Enter`})`}>
              {isTask ? "Start this task" : "Start work"}{!proposalPending && <KeyHint keys="⌘⇧↵" />}
            </button>
          )}
          {!working && !isTask && ticket.status === "backlog" && (
            <button className="btn" onClick={() => setStatus("planning")} title="Move to Planning: Claude interviews you (R)">
              Refine with Claude<KeyHint keys={startTarget === "planning" && !proposalPending ? "⌘⇧↵ · R" : "R"} />
            </button>
          )}
          {ticket.status === "review" && !finished && (
            <button className={`btn ${ticket.prUrl || goal || familyBusy ? "" : "primary"}`} onClick={() => setStatus("done")} title={`Mark done (${MOD}⇧Enter)`}>Mark done{!working && <KeyHint keys={proposalPending ? "⌘⇧↵ after Apply" : "⌘⇧↵"} />}</button>
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
            <h3 className="sec-h"><button className="fold-head brief-toggle" aria-expanded={!briefFolded} onClick={() => setBriefOpen((v) => !v)} disabled={editing}>
              <span className="fold-title">Original brief</span><span className="fold-chev side" aria-hidden>▸</span>
            </button></h3>
          ) : <h3 className="sec-h">Description</h3>}
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
  // The desktop title box's handlers.
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
  // Phones: the title on one line with the status in words under it ("● Your turn · review the result"); a tap opens
  // the details sheet (move, cost, memory, pin, alerts, rename, help). The title shrinks first, then the reason; the
  // status word itself is never cut.
  const reason = turnReason(att, attLabel);
  const statusMark = ps.mood
    ? <span className="pw-face" aria-hidden><ClaudeFace mood={ps.mood} size={18} /></span>
    : <span className={`pw-dot${ps.busy ? " busy" : ""}${ps.icon ? " mark" : ""}`} aria-hidden>{ps.icon}</span>;
  const phoneWho = (
    <button type="button" className={`phone-who tone-${ps.tone}`} onClick={() => setSheet("open")} aria-haspopup="dialog"
      aria-label={`${title || ticket.title}. ${shortStatus}${reason ? `: ${reason}` : ""}. Ticket details and move to a column`}>
      <b className="pw-title">{title || ticket.title}</b>
      <span className="pw-status">{statusMark}<span className="pw-word">{shortStatus}</span>
        {reason && <span className="pw-reason">· {reason}</span>}<span className="pw-chev" aria-hidden>▾</span></span>
    </button>
  );
  // The column pill under the title: one tap opens Move to (the same setStatus path as the Status picker and the sheet).
  const pill = <StatusPill ticket={ticket} phone={phone} onPick={(s) => setStatus(s)} />;
  // Phones, under the title: the pill and the status in words. While the chat is scrolled down (head-slim) this row folds
  // away and the status shows under the title instead.
  const phonePillRow = (
    <div className="head-pill-wrap" aria-hidden={slim || undefined}><div className={`head-pill-row tone-${ps.tone}`}>
      {pill}
      <span className="pw-status">{statusMark}<span className="pw-word">{shortStatus}</span>{reason && <span className="pw-reason">· {reason}</span>}</span>
    </div></div>
  );
  // Phones, Chat tab: while the ticket waits on the user (and Claude isn't working), one slim line above the message
  // box says what for, with its one button (the same handlers as the Ticket tab's).
  const turnAction = !att || working ? null : goal ? { label: goal.button, run: goTo }
    : ticket.status === "review" && !finished ? { label: "Mark done", run: () => setStatus("done") } : null;
  // For questions, the chat hands in its own "show the open form" (the chip's), so the bar replaces the chip.
  const turnBar = phone && turnAction ? {
    forForm: att!.kind === "questions",
    render: (openForm: (() => void) | null) => (
      <div className={`turn-bar tone-${attTone(att!.kind)}`} role="status">
        <span className="turn-bar-text"><b>Your turn:</b> {reason}</span>
        <button type="button" className="btn small turn-bar-btn" onClick={openForm ?? turnAction.run}>{turnAction.label}</button>
      </div>
    ),
  } : null;
  const rename = async (t: string) => {
    await api.updateTicket(slug, ticket.id, { title: t });
    setTitle(t);
  };
  // The tab bar's buttons: every tab is in the bar, which scrolls sideways when they don't fit.
  const costChip = usage && hasUsage ? (
    <button className="head-cost" onClick={() => openTab("usage")} title={`${usageChipText(usage)}. ${usageTitle}`}>{costText(usage.totals.costUsd)}</button>
  ) : null;
  // A count over 99 shows as "99+" so the last tab still fits at phone width (the full number is in the title).
  const tabCount = (n: number) => (n > 99 ? "99+" : String(n));
  const tabLabel: Record<DrawerTab, React.ReactNode> = {
    ticket: "Ticket",
    chat: <>Chat {working && <span className="dot" />}</>,
    family: tally.total > 0 ? (
      <>Tasks<span className={`tab-count ${ticket.plan?.state === "stuck" ? "warn" : tally.done === tally.total ? "ok" : ""}`}
        title={`${tally.done} of ${tally.total} tasks done`}>{tabCount(tally.done)}/{tabCount(tally.total)}</span></>
    ) : <>Tasks</>,
    huddle: (
      <>
        Huddle{huddle && huddle.status !== "closed" && <span className={`tab-count${huddle.status === "live" ? " ok" : ""}`}>{members(huddle).length}</span>}
        {huddle && huddle.status !== "closed" && !!huddle.forYou && (
          <span className="for-you-pill" title={`${huddle.forYou} ${huddle.forYou === 1 ? "message tags" : "messages tag"} you`}>{huddle.forYou}</span>
        )}
        {huddle?.status === "live" && huddle.participants.some((p) => p.status === "working") && <span className="dot" />}
      </>
    ),
    changes: <>Changes{!!diffState.diff?.files.length && <span className="tab-count" title={`${diffState.diff.files.length} files`}>{tabCount(diffState.diff.files.length)}</span>}</>,
    outputs: <>Outputs{outputCount + links.length > 0 && <span className="tab-count" title={`${outputCount + links.length} outputs`}>{tabCount(outputCount + links.length)}</span>}</>,
    usage: <>Usage{usage && hasUsage && usage.totals.pctCurrentWindow !== null && <span className="tab-count">{approxPct(usage.totals.pctCurrentWindow).replace(" ", "")}</span>}</>,
  };
  return (
    <FileLinksProvider slug={slug} ticketId={ticket.id} panel={panelRef}>
    <div ref={wrapRef} className={`drawer-wrap${slideIn ? "" : " no-fade"}${leaving ? " leaving" : ""}${beside ? " beside-panels" : ""}`}
      style={beside ? { right: beside.right, top: beside.top } : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={panelRef} className={`panel ${dragging ? "resizing" : ""} ${slideIn ? "" : "no-slide"}${slim ? " head-slim" : ""}${leaving ? " leaving" : ""}`} role="dialog" aria-modal="true" aria-label={ticket.title} style={{ width }} tabIndex={-1}>
        <div className="drawer-resize" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...handle} />

        <header className="panel-head">
          {/* The page's heading for screen readers (the visible title is a field on desktop, a button on phones). */}
          <h2 className="sr-only">{ticket.title}</h2>
          {/* Row 1: the title, its tags, the helper's note, then the buttons. */}
          <div className="head-row1">
            {phone && <button className="icon-btn phone-back" onClick={onClose} aria-label="Back to the board"><ChevronLeftIcon size={20} /></button>}
            {phone && phoneWho}
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
            {!phone && <StarToggle on={!!ticket.important} onChange={toggleStar} keyHint="S" />}
            {!phone && canPin && (
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
            {!phone && <span className="head-spacer" />}
            <JobChip jobs={jobs} ticketId={ticket.id} onOpen={onOpenJobs} />
            {/* Phones: cost, alerts, help, pin and moving the ticket are in the details sheet (the title opens it). */}
            {!phone && <HelpMenu help={help} phone={false} onAsk={(kind) => { setTab("chat"); void help.ask(kind); }} />}
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
          {phone && phonePillRow}
          {runOpen && <RunPopover profile={profile} ticket={ticket} onError={onError} onClose={() => setRunOpen(false)} />}
          {/* Row 2: the tabs, then the short status (desktop) and the cost. Always shown, so a tab is one click away
              however far the chat is scrolled. */}
          <div className="head-row2">
            <nav ref={tabsRef} className={`tabs${tabsMore ? " more-right" : ""}`} role="tablist" aria-label="Ticket" onScroll={checkTabs}>
              {tabs.map((t) => (
                <button key={t} id={`ticket-tab-${t}`} role="tab" aria-selected={tab === t} aria-controls="ticket-tabpanel" className={tab === t ? "active" : ""}
                  tabIndex={tab !== t ? -1 : 0} onClick={() => openTab(t)} onKeyDown={onTabKey}>{tabLabel[t]}</button>
              ))}
            </nav>
            <span className="head-spacer" />
            {!phone && <>
              {pill}
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
          </div>
        </header>

        <div ref={bodyRef} className={`panel-body ${detailsShown ? "" : "details-closed"} ${side.dragging ? "resizing" : ""}`}
          id="ticket-tabpanel" role="tabpanel" aria-labelledby={`ticket-tab-${tab}`}
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
              <div className="panel-scroll panel-tasks">
                <FamilyTab slug={slug} profile={profile} ticket={ticket} tickets={tickets} planTasks={ownTasks} onOpenTicket={onOpenTicket} onError={onError}
                  onMoveToDone={() => setStatus("done")} onAddMore={addMoreTickets} />
              </div>
            ) : tab === "huddle" ? (
              <HuddlePanel slug={slug} ticket={ticket} tickets={tickets} state={huddleState} onError={onError} seed={huddleSeed ?? null} onSelect={setHuddlePick}
                onOpenOutput={(name) => openOutput(name)}
                onOpenChat={() => setTab("chat")} onOpenTicket={onOpenTicket} onOpenTeam={onOpenTeam} />
            ) : tab === "changes" ? (
              <Changes slug={slug} ticket={ticket} state={diffState} onSent={() => setTab("chat")} onError={onError} />
            ) : tab === "usage" ? (
              <div className="panel-scroll panel-usage"><UsagePanel usage={usage} error={ticketUsage.error} /></div>
            ) : tab === "outputs" ? (
              <div className="panel-scroll panel-outputs"><Outputs slug={slug} ticket={ticket} onCount={setOutputCount} focus={outputFocus} from={outputFrom} onBackToChat={backToChat} onOpenFile={(name) => setLinkFile({ id: ticket.id, name })} /></div>
            ) : (
              <Chat slug={slug} ticket={ticket} tickets={tickets} contextRequest={contextRequest} onOpenTicket={onOpenTicket} onError={onError} onPendingProposal={onPendingProposal} onFilesChanged={diffState.reload}
                onOpenTasks={tabs.includes("family") ? () => openTab("family") : undefined}
                huddle={huddle} onOpenHuddle={() => setTab("huddle")} onOpenTeam={onOpenTeam} help={help}
                onOpenOutput={openOutput} formRequest={formRequest} turnBar={turnBar} />
            )}
          </div>
        </div>

        {sheet && (
          <TicketSheet slug={slug} ticketId={ticket.id} title={title || ticket.title} tone={ps.tone} focusMove={sheet === "move"} onClose={() => setSheet(null)}
            status={<span>{shortStatus}{reason && <span className="ts-reason">: {reason}</span>}</span>}
            columns={statusOptions} current={boardColumnOf(ticket)} onMove={(s) => setStatus(menuPick(ticket, s as Status))}
            goal={att && goal && !working ? { label: goal.button, onGo: goTo } : null}
            cost={usage && hasUsage ? costText(usage.totals.costUsd) : null} onCost={() => openTab("usage")}
            onContext={() => { setTab("chat"); setContextRequest(Date.now()); }}
            pin={canPin ? { on: pinned, toggle: togglePin } : null} star={{ on: !!ticket.important, toggle: toggleStar }}
            help={help} onHelp={(kind) => { setTab("chat"); void help.ask(kind); }} onRename={rename} />
        )}
        {picking && (
          <SessionPicker slug={slug} folder={profile.path} currentTicketId={ticket.id} onClose={() => setPicking(false)}
            onPick={(s) => act(async () => { await api.linkSession(slug, ticket.id, s.id); setPicking(false); })} />
        )}
        {ticket.error?.startsWith("corrupt") && <div className="banner error inline"><pre>{ticket.error}</pre></div>}
        {confirmStart && (
          <ConfirmDialog title={isTask ? "Start this task?" : "Start work?"} confirmLabel={isTask ? "Start task" : "Start work"} busyLabel="Starting…" tone="primary"
            onCancel={() => setConfirmStart(false)}
            onConfirm={async () => { await api.updateTicket(slug, ticket.id, { status: "ready" }); setConfirmStart(false); }}>
            {isTask
              ? <p>Claude works on it now on its own and reports to its main ticket, like its other tasks.</p>
              : <p>Claude will work on this on its own. When working: <b>{ticket.mode === "interview" ? "Interview me first" : "Just do it"}</b>.</p>}
          </ConfirmDialog>
        )}
        {confirmStop && (
          <ConfirmDialog title={stopTitle(ticket, claude)} confirmLabel={familyBusy ? "Stop all" : `Stop ${claude}`} busyLabel="Stopping…"
            onCancel={() => setConfirmStop(false)}
            onConfirm={async () => {
              if (familyBusy) await api.stop(slug, ticket.id);
              else if (working) stop();
              setConfirmStop(false);
            }}>
            {familyBusy
              ? <p>Its running tasks stop now and queued ones don't start. Tickets you added to the feature keep going. {`$${ticket.familyCard!.costUsd.toFixed(2)}`} spent so far.</p>
              : <p>{claude} stops working on this ticket now. You can start it again later.</p>}
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
