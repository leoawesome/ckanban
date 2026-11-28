import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { taskStart, TASK_START_HINT } from "../ticket/taskStart";
import {
  api, onReconnect, subscribe, type Huddle, type OutputFile, type QueuedMessage, type SessionEntry, type Ticket,
} from "../../lib/api";
import { HuddleCard } from "../huddle/HuddleCard";
import { HuddleDigest } from "../huddle/HuddleDigest";
import type { TeamRequest } from "../team/Team";
import { TeammateCard } from "../team/TeammateCard";
import { SquadCard } from "../team/SquadCard";
import { AutomationCard, openAutomations } from "../schedules/AutomationCard";
import { KeysBox } from "../connections/KeysBox";
import { ContextChip } from "./ContextPanel";
import { autoGrow } from "../../lib/autoGrow";
import { branchTicket } from "../../lib/branch";
import { BranchCard } from "../board/BranchCard";
import { DeleteCard } from "../../components/DeleteCard";
import { ScheduleDeleteCard } from "../schedules/ScheduleDeleteCard";
import { HelperRuleCard } from "../helper/HelperRuleCard";
import { AgentRows } from "./AgentRow";
import { useClaudeName } from "../avatar/AvatarFace";
import { WorkflowBlocks } from "./WorkflowBlock";
import { ToolRows } from "./ToolRows";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, ClockIcon, CloseIcon, FileCodeIcon } from "../../components/icons";
import type { MenuItem } from "../../app/HeaderMenu";
import { useTypeTrigger } from "../../lib/typeTrigger";
import { useImagePaste } from "../../lib/imagePaste";
import { AttachmentChips } from "../../components/AttachmentChips";
import { ImagePickButton } from "../../components/ImagePickButton";
import { KeyHint } from "../../components/KeyHint";
import { ProposalCard } from "../family/ProposalCard";
import { QuestionsForm } from "../ticket/QuestionsForm";
import { type FormPreview, mockupPath } from "../ticket/formPreview";
import { waitingChip } from "../ticket/formSteps";
import { RecoveryBanner } from "../board/RecoveryBanner";
import { UndoBar, UndoneNote, UserMessage } from "./MessageActions";
import { SetupRow } from "../../components/SetupRow";
import { HelpCardView, HelpPending, type HelpState } from "../../app/HelpMenu";
import { StatusNoteView, useFeatureStatus } from "../ticket/StatusBlock";
import { ResultCardView } from "../files/ResultCardView";
import { byIdOf, familyOf, hiddenTool, withYouTool } from "../family/family";
import { type StepInfo, type StepMsg, useStepMessages } from "../ticket/StepMessages";
import { QuestionText } from "../ticket/QuestionText";
import { TaskCard, TaskSheet, TaskTrail, useSheet, WaitingButton } from "../ticket/TaskSheet";
import { shortNote, waitingItems, type WaitingItem } from "../ticket/taskCards";
import { useSimpler } from "../ticket/Simpler";
import { replyText, simplifiable } from "../ticket/simplifyText";
import { ClaudeFace, ErrorTurn, LetterAvatar, ReplyActions, ReplyAnnouncer, SendOrStop, StepsLine, TimeDivider, Turn, WorkingRow } from "./ConvTurn";
import { fromAutomation, fromTicket, layoutTurns, placeByTime, telegramMarks, type TurnLayout } from "./chatTurns";
import { gapOf, jumpAfterScroll, stickAfterScroll } from "./chatFollow";
import { useChatFollow } from "../../hooks/useChatFollow";
import { StallActions, stallWait } from "../../components/StallActions";
import { useSnippetPicker } from "../board/SnippetPicker";
import { useSlashCommands, useSlashPicker } from "../../components/SlashPicker";
import { filesByReply, STATUS_FILES } from "../files/fileCards";

import { expired, handoff as handoffOf, liveView, repeats, saved, withHandoff, type Handoff } from "../../lib/liveReply";
import { heldByReply, inSession, liveProgress, userAfterSaved, type Pending } from "../../lib/pendingBubbles";
import { copyFile, downloadFile } from "../../lib/share";
import { draftKey, formKey } from "../../lib/drafts";
import { fullTime, timeAgo } from "../../lib/time";
import { useNow } from "../../hooks/useNow";
import { Markdown } from "./Transcript";
import { usePersistentState } from "../../hooks/usePersistentState";
import { usePhone } from "../../hooks/usePhone";
import { enterSends } from "../../lib/enterSends";
import { reducedMotion } from "../../lib/motion";
import { keepSame, MemoBlock } from "./chatMemo";
import { recentOutputs } from "../files/outputsOnce";
import { useStop } from "./useStop";
import { WaitingCard, UserText, WakeNote, type Block, speaker, OLD_LINE_MIN_TOKENS, before, CARDS, group, HANDOFF_RETRY_MS, SENDING_RECHECK_MS, UNREADABLE, RESEND, RETRY, REFINE, ChatFiles, delivered, OPEN_REUSE_MS, SIDE_WAIT_MS, StepsWorking } from "./ChatParts";
import { useChatForms } from "./useChatForms";
import { useChatSend } from "./useChatSend";
import { useQueuedEdits } from "./useQueuedEdits";
import { useChatRewind } from "./useChatRewind";

/** A queued peer message that carries huddle messages (see the server's huddleMainPrompt). */
const HUDDLE_TAG = /<ckanban-context[^>]* huddle="/;

/** How long the chat keeps an open form in view after coming back from its preview, while cards below it load. */
const FORM_HOLD_MS = 1500;

export function Chat({ slug, ticket, tickets, onOpenTicket, onOpenTasks, onOpenOutput, onError, onPendingProposal, huddle = null, onOpenHuddle, onOpenTeam, help, onFilesChanged, contextRequest = 0, formRequest = 0, turnBar }: {
  /** A Date.now() stamp: a new one opens the Context panel (the ticket ⋯ menu's Context item). */
  contextRequest?: number;
  /** A Date.now() stamp: a new one scrolls to the open questions form (back from a preview opened from it). */
  formRequest?: number;
  slug: string;
  ticket: Ticket;
  /** The board's tickets, to tell which proposed new tickets already exist. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  /** Open the Tasks tab (the feature status and its tasks), from the "Waiting on you" line. */
  onOpenTasks?: () => void;
  /** Show a file of the ticket's outputs folder (path relative to it) in the Outputs tab. */
  onOpenOutput?: (name: string, form?: FormPreview) => void;
  onError: (m: string) => void;
  /** The newest proposal card not applied yet, as its Apply action (null when none): ⌘⇧Enter in the panel applies it. */
  /** The newest unapplied proposal's apply; start: also move the ticket to Ready. */
  onPendingProposal?: (apply: ((start: boolean) => Promise<void>) | null) => void;
  /** The ticket's huddle, to tell whether a proposed one was started. */
  huddle?: Huddle | null;
  onOpenHuddle?: () => void;
  /** Open the Team side panel: a proposed teammate's editor (Edit first) or a saved one (Open in Team). */
  onOpenTeam?: (r: TeamRequest) => void;
  /** "Help me understand" answers, shown as cards in the timeline by time. */
  help?: HelpState;
  /** A rewind put files back: the Changes tab reloads its list. */
  onFilesChanged?: () => void;
  /**
   * Phones: the "Your turn" line just above the message box (TicketDrawer). forForm: it asks to answer questions; while
   * a form is open here its button scrolls to that form (render gets showOpenForm) and the waiting chip stays hidden.
   */
  turnBar?: { forForm: boolean; render: (openForm: (() => void) | null) => ReactNode } | null;
}) {
  const claude = useClaudeName();
  const [page, setPage] = useState<{ entries: SessionEntry[]; start: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Scrolled up: offer a jump back down; "fresh" = something new arrived meanwhile.
  const [jump, setJump] = useState<{ fresh: boolean } | null>(null);
  const [showWarnDetails, setShowWarnDetails] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const phone = usePhone();
  /** The old-chat line opens the Context panel too. */
  const [contextLocal, setContextLocal] = useState(0);
  // Relative times ("3m ago") on the messages: redrawn on this tick when their text changes (blockDeps).
  useNow();
  // Sent messages not yet in the session file (the server's queue covers ones Claude hasn't read).
  // steer: sent while Claude was working, so it waits for the server queue instead of joining the timeline.
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const queued = ticket.queued ?? [];
  // Unsent text survives closing the drawer, switching tickets and reloads.
  const [draft, setDraft] = usePersistentState(draftKey(slug, ticket.id), () => "", (v) => !v.trim(), (v) => typeof v === "string");
  const images = useImagePaste(setDraft);
  const snippets = useSnippetPicker({ slug, ref: composer, setValue: setDraft });
  const commands = useSlashCommands(slug, ticket.id);
  const simpler = useSimpler(slug, ticket.id);
  const slash = useSlashPicker({ commands, ref: composer, setValue: setDraft });
  // The phone "+" sheet's Snippet and Skill type `@` / `/` at the caret and open their picker.
  const typeTrigger = useTypeTrigger(composer, setDraft, () => {
    snippets.handlers.onSelect();
    slash.handlers.onSelect();
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Text Claude is writing right now (from the run's partial-message stream); not yet in the session file.
  const [live, setLive] = useState("");
  const liveRef = useRef("");
  liveRef.current = live;
  // Replies that finished streaming but aren't in the loaded conversation yet.
  const [handoff, setHandoff] = useState<Handoff[]>([]);
  const entriesRef = useRef<SessionEntry[]>([]);
  // loadTail calls overlap (draft, activity, session watcher): a slower, older response must not win.
  const tailSeq = useRef(0);
  const tailApplied = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  // Follows new content at the bottom; the jump state is declared above.
  const { stickToBottom, lastGap, pressing, noteScroll } = useChatFollow(scroller, () => setJump((j) => (j?.fresh ? j : { fresh: true })));
  const keepOffset = useRef<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = !!ticket.running;
  // When the run last ended (null while it runs): finished replies wait for their saved copy until a little after.
  const endedAt = useRef<number | null>(running ? null : Date.now());
  const { stopping, stop } = useStop(slug, ticket, running, onError);
  const refine = REFINE(ticket.status);
  // A feature's status lives in the Tasks tab; its main chat shows one "Waiting on you" line on top while something
  // waits on the user, and the user's notes in the timeline.
  const feature = useFeatureStatus(slug, ticket, tickets);
  // A main ticket's "with you" steps talk to the user here: their messages and forms show inline, answered right here.
  const stepTalk = useStepMessages(slug, ticket, tickets);
  // A task opened in the side sheet (from its card, the waiting list or the URL): only one of this ticket's own tasks.
  const sheet = useSheet(ticket.id);
  const sheetTask = sheet.id && sheet.id !== ticket.id && familyOf(tickets, ticket.id).some((r) => r.ticket.id === sheet.id)
    ? tickets.find((t) => t.id === sheet.id) ?? null : null;
  // What opened the sheet gets the focus back when it closes (Safari doesn't focus a clicked button).
  const sheetOpener = useRef<HTMLElement | null>(null);
  const openSheet = (id: string, opener: HTMLElement) => {
    sheetOpener.current = opener;
    sheet.open(id);
  };
  useEffect(() => {
    if (sheetTask) return;
    const el = sheetOpener.current;
    sheetOpener.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, [!!sheetTask]);
  // A slow step chat or status doesn't hold the notes back for long once the conversation is in.
  const [sideWaited, setSideWaited] = useState(false);
  const pageIn = page !== null;
  useEffect(() => {
    setSideWaited(false);
    if (!pageIn) return;
    const t = setTimeout(() => setSideWaited(true), SIDE_WAIT_MS);
    return () => clearTimeout(t);
  }, [pageIn, ticket.id]);

  // Resolves to the loaded tail (null when a newer load won or there is no session).
  const loadTail = useCallback(async (): Promise<SessionEntry[] | null> => {
    if (!ticket.sessionId) {
      setPage({ entries: [], start: 0 });
      return null;
    }
    const seq = ++tailSeq.current;
    const r = await api.conversation(slug, ticket.id);
    if (seq < tailApplied.current) return null;
    tailApplied.current = seq;
    setPage((prev) => {
      if (!prev) return { entries: r.entries, start: r.start };
      // Entries that did not change keep the objects already on screen, so their blocks aren't drawn again; a
      // refresh that changed nothing keeps the page as it is (no redraw at all).
      if (r.start <= prev.start) {
        const entries = keepSame(prev.entries, r.entries);
        return entries === prev.entries && r.start === prev.start ? prev : { entries, start: r.start };
      }
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      if (idx < 0) return { entries: r.entries, start: r.start };
      const tail = prev.entries.slice(idx);
      const fresh = keepSame(tail, r.entries);
      return fresh === tail ? prev : { entries: [...prev.entries.slice(0, idx), ...fresh], start: prev.start };
    });
    return r.entries;
  }, [slug, ticket.id, ticket.sessionId]);

  const reload = useCallback(() => {
    setLoadError(null);
    loadTail().catch((e) => {
      setLoadError(e.message);
      setPage((p) => p ?? { entries: [], start: 0 });
    });
  }, [loadTail]);

  const {
    actionsOff, forkFrom, rewound, setUndo, setUndone, undo, undoRewound, undone,
  } = useChatRewind({
    composer, draft, onFilesChanged, onOpenTicket, queued, reload, running, setDraft, setPage, slug, stickToBottom,
    ticket,
  });
  useEffect(() => {
    setPage(null);
    setHandoff([]);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft, phone]);
  // The live connection came back (board restart, laptop sleep, a long freeze): updates were missed, so reload.
  useEffect(() => onReconnect(() => void loadTail().catch(() => {})), [loadTail]);
  // While a sent message still says "sending", check the conversation now and then in case its update was missed.
  const waitingToShow = pending.length > 0;
  useEffect(() => {
    if (!waitingToShow) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) loadTail().catch(() => {});
    }, SENDING_RECHECK_MS);
    return () => clearInterval(timer);
  }, [waitingToShow, loadTail]);

  // Live updates: session file changes (terminal) and run activity (board) both refresh the tail.
  useEffect(() => subscribe((e) => {
    if (e.type === "draft" && e.profile === slug && e.id === ticket.id) {
      if (e.text) setLive(e.text);
      else if (e.final) {
        // Message finished: show all of it until the saved copy is loaded, then swap without a gap.
        const h = handoffOf(e.final, entriesRef.current.length);
        setHandoff((hs) => withHandoff(hs, h));
        setLive("");
        loadTail().catch(() => {});
      } else {
        // Cleared without the finished text: keep what streamed on screen until its saved copy shows.
        if (liveRef.current) {
          const h = handoffOf(liveRef.current, entriesRef.current.length);
          setHandoff((hs) => withHandoff(hs, h));
          setLive("");
        }
        loadTail().catch(() => {}).finally(() => setLive(""));
      }
      return;
    }
    const mine = (e.type === "session.updated" || e.type === "activity") && e.profile === slug && e.id === ticket.id;
    if (!mine || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTail().catch(() => {});
    }, 700);
  }), [slug, ticket.id, loadTail]);

  // A run just finished: pick up the final message even if no more events arrive. A reply's own message that never
  // reached the session (Stop before Claude read it) can't arrive any more: drop its bubble so it doesn't stick below
  // later messages. Messages sent after this point are left alone.
  const mounted = useRef(false);
  useEffect(() => {
    // Opening the chat already loads the conversation (above): only a change of running counts here.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    endedAt.current = running ? null : Date.now();
    if (running) return;
    // A reply still streaming when the run ended stays until its saved copy shows (or briefly, if it never does).
    if (liveRef.current) {
      const h = handoffOf(liveRef.current, entriesRef.current.length);
      setHandoff((hs) => withHandoff(hs, h));
      setLive("");
    }
    const before = pendingRef.current.filter((p) => !p.steer);
    loadTail()
      .then((tail) => {
        if (!tail) return;
        const stale = before.filter((p) => !delivered(tail, p.text));
        if (stale.length) setPending((ps) => ps.filter((p) => !stale.includes(p)));
      })
      .catch(() => {})
      .finally(() => setLive(""));
  }, [running]);

  const {
    cancelEdit, discard, editable, editing, fromUser, saveEdit, setEditing,
  } = useQueuedEdits({
    composer, onError, pendingRef, queued, running, setPending, slug, ticket,
  });

  const entries = page?.entries ?? [];
  entriesRef.current = entries;
  // Messages that came from Telegram, and replies sent back there: a small mark on each.
  const tgMarks = useMemo(() => telegramMarks(entries, ticket.telegramIn, ticket.telegramOut), [entries, ticket.telegramIn, ticket.telegramOut]);
  // Finished replies still waiting for their saved copy; filtered here so both never show at once.
  const waitingHandoff = useMemo(() => handoff.filter((h) => !saved(entries, h)), [handoff, entries]);
  useEffect(() => {
    if (waitingHandoff.length !== handoff.length) setHandoff(waitingHandoff);
  }, [waitingHandoff, handoff]);
  // The saved copy lags the stream (the session file gets a message once all of it, tool calls too, has streamed):
  // poll until it shows; give up only a little after the run ended (see expired).
  const handingOff = handoff.length > 0;
  // Reply text on screen: the status line doesn't repeat an excerpt of it.
  const onScreen = useMemo(() => [
    ...waitingHandoff.map((h) => h.text),
    entries.findLast((e) => e.role === "assistant" && e.kind === "text")?.text ?? "",
  ], [waitingHandoff, entries]);
  // What the run is doing now ("Running gh"), for the live line; not when it only repeats reply text on screen.
  const activity = stopping ? "Stopping…"
    : ticket.lastActivity && ticket.lastActivity !== "Starting…" && !repeats(ticket.lastActivity, onScreen) ? ticket.lastActivity : null;
  useEffect(() => {
    if (!handingOff) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHandoff((hs) => (hs.some((h) => expired(h, now, endedAt.current)) ? hs.filter((h) => !expired(h, now, endedAt.current)) : hs));
      loadTail().catch(() => {});
    }, HANDOFF_RETRY_MS);
    return () => clearInterval(timer);
  }, [handingOff, loadTail]);
  // Output files for the cards under replies; refreshed when the end of the conversation changes or a run starts or
  // ends ("Load earlier" adds older messages only, so it doesn't refetch). Opening the chat reuses the list the ticket
  // panel just asked for.
  const [files, setFiles] = useState<OutputFile[]>([]);
  const newestUuid = entries.at(-1)?.uuid;
  const filesAsked = useRef<string | null>(null);
  useEffect(() => {
    if (!pageIn) return;
    const first = filesAsked.current !== ticket.id;
    filesAsked.current = ticket.id;
    recentOutputs(slug, ticket.id, first ? OPEN_REUSE_MS : 0).then(setFiles).catch(() => {});
  }, [slug, ticket.id, pageIn, newestUuid, running]);
  const pinned = !!ticket.main || !!feature.status;
  const cards = useMemo(() => filesByReply(entries, files, pinned ? STATUS_FILES : undefined), [entries, files, pinned]);
  // Drop optimistic bubbles once the session file contains the message.
  useEffect(() => {
    if (pending.some((p) => delivered(entries, p.text))) setPending((ps) => ps.filter((p) => !delivered(entries, p.text)));
  }, [entries, pending]);

  // Opening a ticket whose questions form waits shows the top of that form, not the bottom of the chat (once per ticket).
  const landedOn = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (page && landedOn.current !== ticket.id) {
      landedOn.current = ticket.id;
      setJump(null);
      const form = [...el.querySelectorAll<HTMLElement>(".qcard:not(.answered)")].at(-1);
      if (form) {
        el.scrollTop = el.scrollHeight;
        el.scrollTop += form.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
        stickToBottom.current = stickAfterScroll({ gap: gapOf(el), stuck: false, movedDown: false });
        lastGap.current = gapOf(el);
        return;
      }
      // Opening a chat lands at the bottom, whatever the previous ticket's chat was scrolled to.
      stickToBottom.current = true;
    }
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current && !pressing.current) el.scrollTop = el.scrollHeight;
    lastGap.current = gapOf(el);
  }, [page, pending, running, live, waitingHandoff, help?.cards.length, help?.failed]);
  // Back from a form's preview: show that open form (once it is drawn), not the bottom of the chat.
  const formShown = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !formRequest || formShown.current === formRequest) return;
    const form = [...el.querySelectorAll<HTMLElement>(".qcard:not(.answered)")].at(-1);
    if (!form) return;
    formShown.current = formRequest;
    setJump(null);
    // Cards still loading below the form would pull a chat that sits near the bottom down with them: keep the form
    // in place for a moment, until the user scrolls or touches the chat themselves.
    const until = Date.now() + FORM_HOLD_MS;
    let stop = false;
    const quit = () => { stop = true; };
    const hold = () => {
      if (stop || Date.now() > until || !form.isConnected) {
        for (const t of ["wheel", "touchstart", "mousedown", "keydown"]) el.removeEventListener(t, quit);
        return;
      }
      el.scrollTop += form.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      stickToBottom.current = false;
      lastGap.current = gapOf(el);
      requestAnimationFrame(hold);
    };
    for (const t of ["wheel", "touchstart", "mousedown", "keydown"]) el.addEventListener(t, quit, { passive: true });
    hold();
  });
  // Asking for help scrolls down to where its card appears.
  const helpBusy = help?.busy.length ?? 0;
  const helpBusyBefore = useRef(helpBusy);
  useEffect(() => {
    if (helpBusy > helpBusyBefore.current) toBottom();
    helpBusyBefore.current = helpBusy;
  }, [helpBusy]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    setJump(null);
  };

  const {
    asking, old, send, sendFresh, submit,
  } = useChatSend({
    commands, draft, images, onError, running, setDraft, setPending, setUndo, setUndone, slug, stickToBottom,
    stopping, ticket,
  });

  const loadEarlier = async () => {
    if (!page || page.start === 0) return;
    setLoadingEarlier(true);
    try {
      const r = await api.conversation(slug, ticket.id, page.start);
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setPage((prev) => ({ entries: [...r.entries, ...(prev?.entries ?? [])], start: r.start }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const {
    answerOf, answeredAfter, applyProposal, canStart, fresh, freshFor, setFresh, closeForm, counts, dismissTeammate,
    familyNote, followUpOf, formState, formWaiting, forms, isApplied, openKey, pendingProposal, presets, replacedBy,
    saveTeammate, setPresetsVersion, startedProposals,
  } = useChatForms({
    entries, onError, onOpenTicket, onPendingProposal, pending, running, slug, ticket, tickets,
  });
  const empty = page !== null && !loadError && entries.length === 0 && !pending.length && !queued.length && !running;

  // "↑ Answer N questions" over the message box while the open form is scrolled out of view.
  const openFormEl = () => [...(scroller.current?.querySelectorAll<HTMLElement>(".qcard:not(.answered)") ?? [])].at(-1);
  let openAt = -1;
  for (const [i, f] of forms) if (f.state === "open" && entries[i]?.questions?.length) openAt = i;
  const openCount = openAt >= 0 ? entries[openAt].questions!.length : null;
  const [formOnScreen, setFormOnScreen] = useState(true);
  useEffect(() => {
    const root = scroller.current;
    const form = openCount ? openFormEl() : undefined;
    if (!root || !form || typeof IntersectionObserver === "undefined") return setFormOnScreen(true);
    // On screen while at least 40px of it shows inside the log (a sliver at an edge doesn't count).
    const io = new IntersectionObserver(([e]) => setFormOnScreen(e.isIntersecting), { root, rootMargin: "-40px 0px" });
    io.observe(form);
    return () => io.disconnect();
  }, [openAt, openCount, page === null, entries.length]);
  const barForForm = !!turnBar?.forForm && !!openCount;
  const chip = waitingChip(openCount, formOnScreen, barForForm);


  // Message blocks are drawn again only when what they show changes (MemoBlock): the callbacks they hand out read the
  // latest ones through this ref.
  const latest = useRef({ forkFrom, rewound, onError, onOpenHuddle, onOpenOutput, onOpenTicket });
  latest.current = { forkFrom, rewound, onError, onOpenHuddle, onOpenOutput, onOpenTicket };
  const latestError = useCallback((m: string) => latest.current.onError(m), []);
  const ticketById = byIdOf(tickets);
  /**
   * What a block shows that can change besides its entries; null: always drawn again (cards with their own state
   * from the ticket and the board, which are few).
   */
  const blockDeps = (b: Block, old: boolean, l: TurnLayout, newest: boolean): unknown[] | null => {
    // Its "3m ago": the text, not the clock, so old messages aren't drawn again every 30 seconds.
    const first = b.kind === "entry" ? b.e : b.items[0];
    const base = [slug, ticket.id, first.at ? timeAgo(first.at) : "", old, l.start, l.lastReply, newest];
    if (b.kind === "tools") {
      const live = !old && newest && stepsLive;
      return [...base, running && !old, live, live ? activity : null, ...b.items];
    }
    if (b.kind !== "entry") return [...base, b.kind, ...b.items];
    const e = b.e;
    if (CARDS.some((k) => e[k]) || e.mockups || e.unreadable) return null;
    if (e.kind === "board" || e.commandOutput || e.peer?.automation) return [...base, e];
    if (e.huddleId) return [...base, e, !!onOpenHuddle];
    if (e.peer?.ticketId) return [...base, e, ticketById.get(e.peer.ticketId)?.title];
    if (e.role === "user") return [...base, e, actionsOff, ticket.title, counts.textAfter[b.index], commands, tgMarks.in.has(e.uuid)];
    const files = cards.get(e.uuid);
    return [...base, e, simpler.sig(e.uuid), tgMarks.out.has(e.uuid), files ? files.map((f) => `${f.name}:${f.size}`).join("|") : "",
      !!ticket.canCopyFile, !!onOpenOutput];
  };
  /** One block of the conversation; old = copied history of a branched ticket (shown dimmed); l: its place in its turn. */
  const renderBlock = (b: Block, old: boolean, l: TurnLayout, newest: boolean) => {
    const el = renderEntry(b, old, l, newest);
    if (b.kind !== "entry" || !b.e.setup) return el;
    // The setup Claude asked for (`ckanban ticket setup`): just the row.
    if (b.e.kind === "board" && !b.e.text) return <SetupRow key={b.e.uuid} setup={b.e.setup} old={old} />;
    return <Fragment key={b.e.uuid}><SetupRow setup={b.e.setup} old={old} />{el}</Fragment>;
  };
  const renderEntry = (b: Block, old: boolean, l: TurnLayout, newest: boolean) => {
          const inherited = old ? "inherited" : undefined;
          if (b.kind === "agents") {
            return (
              <Turn key={b.items[0].uuid} start={l.start} at={b.items[0].at} className={inherited}>
                <AgentRows slug={slug} ticketId={ticket.id} items={b.items} old={old} />
              </Turn>
            );
          }
          if (b.kind === "workflows") {
            return (
              <Turn key={b.items[0].uuid} start={l.start} at={b.items[0].at} className={inherited}>
                <WorkflowBlocks slug={slug} ticketId={ticket.id} items={b.items} old={old} />
              </Turn>
            );
          }
          if (b.kind === "tools") {
            return (
              <Turn key={b.items[0].uuid} start={l.start} at={b.items[0].at} className={inherited}>
                <StepsLine items={b.items} running={!old && newest && stepsLive} activity={activity}>
                  <ToolRows slug={slug} ticketId={ticket.id} live={running && !old}
                    items={b.items.map((t) => ({ key: t.uuid, label: t.text, toolUseId: t.toolUseId, error: t.error }))} />
                </StepsLine>
              </Turn>
            );
          }
          const e = b.e;
          if (e.kind === "board" && e.wake) return <WakeNote key={e.uuid} entry={e} old={old} />;
          if (e.kind === "board") {
            return <div key={e.uuid} className={`chat-note${old ? " inherited" : ""}`}>{e.text}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</div>;
          }
          if (e.huddleId) {
            return (
              <HuddleDigest key={e.uuid} text={e.text} old={old} onOpen={onOpenHuddle && (() => latest.current.onOpenHuddle?.())}
                meta={e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>} />
            );
          }
          // A message another ticket's Claude sent: on the left with that ticket's name, never as the user's.
          if (e.peer?.ticketId) {
            return (
              <Turn key={e.uuid} start={l.start} at={e.at} className={inherited}
                avatar={<LetterAvatar seed={e.peer.ticketId} name={e.peer.title || e.peer.ticketId} />}
                name={peerName(e.peer.ticketId, e.peer.title)} sub="from another ticket">
                <div className="peer-bubble"><Markdown text={e.text} /></div>
              </Turn>
            );
          }
          // A later item of an automation's thread: on the left with the automation's name, never as the user's.
          if (e.peer?.automation) {
            return (
              <Turn key={e.uuid} start={l.start} at={e.at} className={inherited}
                avatar={<LetterAvatar seed={`automation:${e.peer.automation}`} name={e.peer.automation} />}
                name={e.peer.automation} sub="from an automation">
                <div className="peer-bubble"><Markdown text={e.text} /></div>
              </Turn>
            );
          }
          if (e.role === "user") {
            const canGo = !!e.rewind && !old;
            return (
              <UserMessage key={e.uuid} at={e.at} text={e.text} className={old ? "inherited" : undefined} off={actionsOff} onError={latestError}
                fork={canGo ? { title: ticket.title, run: () => latest.current.forkFrom(e.uuid) } : undefined}
                rewind={canGo ? {
                  later: counts.textAfter[b.index],
                  preview: () => api.rewindPreview(slug, ticket.id, e.uuid),
                  apply: (files) => api.rewind(slug, ticket.id, e.uuid, files),
                  onDone: (r) => latest.current.rewound(r),
                } : undefined}>
                <UserText text={e.text} commands={commands} command={e.command} />
                {tgMarks.in.has(e.uuid) && <span className="tg-mark" title="You sent this from Telegram">via Telegram</span>}
              </UserMessage>
            );
          }
          if (e.commandOutput) {
            return (
              <div key={e.uuid} className={`conv-msg ${e.role} command-output${old ? " inherited" : ""}`}>
                <div className="conv-head">
                  <b>Claude Code</b>
                  {e.at && <time className="muted small" dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>}
                </div>
                <Markdown text={e.text} />
              </div>
            );
          }
          const shown = () => simpler.textFor(e.uuid) ?? replyText(e.text);
          return (
            <Turn key={e.uuid} start={l.start} at={e.at} className={inherited}>
              {e.text && <div className="reply-text"><Markdown text={shown()} drafts /></div>}
              {tgMarks.out.has(e.uuid) && <span className="tg-mark" title="This reply was sent to you in Telegram">sent to Telegram</span>}
              {e.text && replyText(e.text) && (
                <ReplyActions text={shown} simpler={simplifiable(e) ? simpler.link(e.uuid) : undefined}
                  newest={newest} lastOfTurn={l.lastReply} active={simpler.active(e.uuid)} />
              )}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={formState(b.index).state === "answered"} answer={answerOf(b.index)}
                  replaced={replacedBy(b.index)} closed={formState(b.index).state === "closed"} replied={formState(b.index).state === "replied"} onClose={() => closeForm(e.uuid)}
                  disabled={running} onSubmit={send}
                  onPreview={onOpenOutput && ((m, step) => onOpenOutput(mockupPath(m), { key: formKey(slug, ticket.id, openKey(b.index) ?? e.uuid), questions: e.questions!, step }))}
                  storageKey={formKey(slug, ticket.id, openKey(b.index) ?? e.uuid)} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)} started={startedProposals.has(e.uuid)}
                  onApply={() => applyProposal(e.proposal!)}
                  onApplyStart={canStart ? () => applyProposal(e.proposal!, { uuid: e.uuid }) : undefined}
                  freshChat={canStart ? { ...fresh, on: freshFor(e.uuid), onChange: (on) => setFresh(e.uuid, on) } : undefined}
                  keyHint={e === pendingProposal} followUp={followUpOf(e.proposal)} family={familyNote(e.proposal)} />
              )}
              {e.branch && (
                <BranchCard reason={e.branch.reason} here={old} running={running} onOpen={onOpenTicket}
                  branch={tickets.find((t) => t.branchedFrom === ticket.id && !!t.branchPoint && t.branchPoint.at > e.at)}
                  onBranch={() => branchTicket(slug, ticket, onOpenTicket).then(() => {}, (err) => onError(err.message))} />
              )}
              {e.deletion && (
                <DeleteCard slug={slug} ticket={ticket} tickets={tickets} uuid={e.uuid} ids={e.deletion.ids} reason={e.deletion.reason} onError={onError} />
              )}
              {e.scheduleDeletion && (
                <ScheduleDeleteCard slug={slug} ticketId={ticket.id} uuid={e.uuid} scheduleId={e.scheduleDeletion.id} reason={e.scheduleDeletion.reason}
                  answered={ticket.scheduleDeleteCards?.[e.uuid]} onError={onError}
                  deletedName={Object.values(ticket.scheduleDeleteCards ?? {}).find((c) => c.state === "deleted" && c.scheduleId === e.scheduleDeletion!.id)?.name} />
              )}
              {e.helperRule && (
                <HelperRuleCard slug={slug} ticketId={ticket.id} uuid={e.uuid} text={e.helperRule.text} reason={e.helperRule.reason}
                  answered={ticket.helperRuleCards?.[e.uuid]} onError={onError} />
              )}
              {e.teammate && (
                <TeammateCard proposal={e.teammate} presets={presets} answered={ticket.teammateCards?.[e.uuid]}
                  onSave={(scope) => saveTeammate(e.uuid, e.teammate!, scope)}
                  onEdit={onOpenTeam && ((scope, draft, isNew) => onOpenTeam({ action: "edit", draft, isNew, scope, card: { ticketId: ticket.id, uuid: e.uuid } }))}
                  onDismiss={() => dismissTeammate(e.uuid)}
                  onOpenTeam={onOpenTeam && ((name) => onOpenTeam({ action: "open", name }))} />
              )}
              {e.squad && (
                <SquadCard slug={slug} ticketId={ticket.id} uuid={e.uuid} proposal={e.squad} presets={presets} answered={ticket.squadCards?.[e.uuid]} old={old}
                  onEdit={onOpenTeam && ((draft, card) => onOpenTeam({ action: "squad", draft, card }))}
                  onOpenTeam={onOpenTeam && (() => onOpenTeam({ action: "squads" }))} onSaved={() => setPresetsVersion((n) => n + 1)} onError={onError} />
              )}
              {e.automation && (
                <AutomationCard slug={slug} ticketId={ticket.id} uuid={e.uuid} proposal={e.automation} saved={ticket.automationCards?.[e.uuid]} onOpenAutomations={openAutomations} onError={onError} />
              )}
              {e.keys && (
                <KeysBox slug={slug} ticketId={ticket.id} uuid={e.uuid} ask={e.keys} answered={ticket.keyCards?.[e.uuid]}
                  old={counts.lastKeys > b.index} onError={onError} />
              )}
              {e.huddle && (
                <HuddleCard slug={slug} ticket={ticket} tickets={tickets} uuid={e.uuid} at={e.at} roster={e.huddle.roster} reason={e.huddle.reason} template={e.huddle.template} maxCostUsd={e.huddle.maxCostUsd} topic={e.huddle.topic}
                  huddle={huddle} old={old} onOpen={() => onOpenHuddle?.()} onError={onError} />
              )}
              {e.mockups && (
                <div className="chat-mockups">
                  {e.mockups.map((m) => (
                    <button key={m} className="chat-mockup" onClick={() => onOpenOutput?.(`mockups/${m}`)} title="Preview in the Outputs tab">
                      <FileCodeIcon size={14} /> Mockup <b>{m}</b>
                    </button>
                  ))}
                </div>
              )}
              {!!cards.get(e.uuid)?.length && (
                <ChatFiles files={cards.get(e.uuid)!} canCopy={!!ticket.canCopyFile} onOpen={(n) => latest.current.onOpenOutput?.(n)}
                  onCopy={(n) => copyFile(slug, ticket.id, n)} onDownload={(n) => downloadFile(slug, ticket.id, n)} />
              )}
              {e.unreadable && (
                <div className="chat-unreadable" role="status">
                  <span>Couldn't read Claude's {UNREADABLE[e.unreadable]}.</span>
                  {e.unreadable !== "tickets" && !answeredAfter(b.index) && (
                    <button className="btn small" disabled={running} onClick={() => send(RESEND[e.unreadable as keyof typeof RESEND])}>Resend</button>
                  )}
                </div>
              )}
              {e.moved === "planning" && (
                <div className="chat-moved">
                  Moved to <b>Planning</b>: this was a planning request, so nothing was changed. Answer or refine here, then
                  drag the card to In Progress when you want Claude to do it.
                </div>
              )}
            </Turn>
          );
  };

  /** Another ticket's name on its messages: opens that ticket. */
  const peerName = (id: string, title?: string) => (
    <button type="button" className="link-btn turn-link" onClick={() => latest.current.onOpenTicket(id)}>{ticketById.get(id)?.title ?? title ?? id}</button>
  );

  // A branched ticket: a divider marks where the copied conversation ends.
  const bp = ticket.branchPoint ?? undefined;
  const branchedFrom = ticket.branchedFrom ? tickets.find((t) => t.id === ticket.branchedFrom) : undefined;
  const blocks = group(entries, bp?.at);
  // Divider before the first block after the branch point (after all of them while nothing new was said yet).
  const firstNew = bp ? blocks.findIndex((b) => !before(b.kind === "entry" ? b.e : b.items[0], bp.at)) : -1;
  const dividerAt = !bp || page === null || page.start > 0 && firstNew === 0 ? -1 : firstNew < 0 ? blocks.length : firstNew;
  // Help cards, the user's status notes, tool tickets' results, "with you" steps' messages and the board's grey notes go
  // before the first block that came after them, and only once the conversation and the steps' messages have loaded, so
  // they paint together with the messages instead of first, under the loading line.
  const blockAts = blocks.map((b) => (b.kind === "entry" ? b.e : b.items[0]).at);
  const ready = page !== null && (stepTalk.loaded && feature.loaded || sideWaited);
  const helpAt = placeByTime(help?.cards ?? [], blockAts, page, ready);
  const notesAt = placeByTime(feature.status?.saved?.notes ?? [], blockAts, page, ready);
  const resultsAt = placeByTime(ticket.results ?? [], blockAts, page, ready);
  // A step's messages in a row form one labelled block.
  type Side = { kind: "note"; at: string; ticketId: string; text: string } | { kind: "step"; at: string; step: StepInfo; msgs: StepMsg[] };
  const sideItems: ({ kind: "note"; at: string; ticketId: string; text: string } | { kind: "msg"; at: string; m: StepMsg })[] = [
    ...(ticket.boardNotes ?? []).map((n) => ({ kind: "note" as const, ...n })),
    ...stepTalk.messages.map((m) => ({ kind: "msg" as const, at: m.at, m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const sideAt = new Map<number, Side[]>();
  for (const [i, items] of placeByTime(sideItems, blockAts, page, ready)) {
    const list: Side[] = [];
    for (const it of items) {
      if (it.kind === "note") {
        // The board's note comes when a task's run ends, just after the message it is about: it goes before that
        // task's card, as its heading.
        const prev = list.at(-1);
        if (prev?.kind === "step" && prev.step.id === it.ticketId) list.splice(list.length - 1, 0, it);
        else list.push(it);
        continue;
      }
      const step = stepTalk.steps.find((x) => x.id === it.m.stepId);
      if (!step) continue;
      const prev = list.at(-1);
      if (prev?.kind === "step" && prev.step.id === step.id) prev.msgs.push(it.m);
      else list.push({ kind: "step", at: it.at, step, msgs: [it.m] });
    }
    sideAt.set(i, list);
  }
  const newestOf = new Map(stepTalk.messages.map((m) => [m.stepId, m.uuid]));
  // A task waiting on the user shows one short card where its newest message is; its earlier messages are one line each.
  // The task's chat itself opens in the side sheet.
  const sideView = (i: number) => sideAt.get(i)?.map((x) => {
    if (x.kind === "note") {
      return <div key={`note-${x.ticketId}-${x.at}`} className="chat-note board-note"><QuestionText as="span" text={shortNote(x.text, tickets.find((t) => t.id === x.ticketId)?.title)} /><span title={fullTime(x.at)}> · {timeAgo(x.at)}</span></div>;
    }
    const newest = x.msgs.some((m) => newestOf.get(x.step.id) === m.uuid);
    const open = (el: HTMLElement) => openSheet(x.step.id, el);
    return newest && x.step.waiting
      ? <TaskCard key={`step-${x.msgs[0].uuid}`} slug={slug} step={x.step} msgs={stepTalk.messages.filter((m) => m.stepId === x.step.id)} onOpen={open} onError={onError} onSent={stepTalk.reload} />
      : <TaskTrail key={`step-${x.msgs[0].uuid}`} step={x.step} msgs={x.msgs} newest={newest} onOpen={open} />;
  });
  // "N waiting on you" above the message box: waiting tasks, other tasks the status says need the user, this chat's form.
  const selfForm = (() => {
    for (const [i, f] of forms) if (f.state === "open" && entries[i]?.questions?.length) return { question: entries[i].questions![0].question };
    return null;
  })();
  const waiting: WaitingItem[] = ticket.main || feature.status ? waitingItems({
    steps: stepTalk.steps, messages: stepTalk.messages,
    needsYou: (feature.status?.facts.needsYou ?? []).map((n) => {
      const t = tickets.find((x) => x.id === n.id);
      return { id: n.id, title: t?.title ?? n.title, why: t?.userWait };
    }),
    selfForm, statusWaiting: feature.status?.saved?.waiting,
  }) : [];
  const pickWaiting = (it: WaitingItem, opener: HTMLElement) => {
    if (it.kind === "task") return openSheet(it.id, opener);
    if (it.kind === "status") return onOpenTasks?.();
    showOpenForm("center");
  };
  // Scrolls to the open questions form and rings it for a moment ("N waiting on you" and the "Answer N questions" chip).
  const showOpenForm = (block: ScrollLogicalPosition) => {
    const form = openFormEl();
    if (!form) return;
    // The ring first: its scroll margin keeps the ring in view when the form lands at the top.
    form.classList.remove("attn-flash");
    void form.offsetWidth;
    form.classList.add("attn-flash");
    form.scrollIntoView({ block, behavior: reducedMotion() ? "auto" : "smooth" });
    setTimeout(() => form.classList.remove("attn-flash"), 2200);
    form.querySelector<HTMLElement>("input, textarea, button")?.focus({ preventScroll: true });
  };
  // Turns: avatar and name line on the first row of each; time dividers after long pauses.
  const layout = layoutTurns(blocks.map((b) => {
    const first = b.kind === "entry" ? b.e : b.items[0];
    const reply = b.kind === "entry" && b.e.role === "assistant" && b.e.kind === "text" && !b.e.commandOutput && !!replyText(b.e.text);
    return { speaker: speaker(b), at: first.at, reply };
  }));
  const newestReply = layout.findLastIndex((_, i) => {
    const b = blocks[i];
    return b.kind === "entry" && b.e.role === "assistant" && b.e.kind === "text" && !b.e.commandOutput && !!replyText(b.e.text);
  });
  // Rows after the saved conversation (sent messages, the reply being written, the working row) continue Claude's turn
  // only when Claude spoke last.
  let tail = blocks.length ? speaker(blocks[blocks.length - 1]) : "";
  const tailStart = () => {
    const start = tail !== "claude";
    tail = "claude";
    return start;
  };
  const stalled = running && stallWait(ticket) ? ticket.stalled!.minutes : null;
  // While the newest block is a group of steps, its steps line is the one live line; the working row shows only before
  // the first step, between steps and replies, and when the run has gone quiet. A message of the user's shown after the
  // saved conversation (sent after Stop, sent again from unsent, or held for Claude's next step) makes those steps an
  // earlier reply's: the working row then shows under that message.
  const { stepsLive, workingRow } = liveProgress({
    running, streaming: !!live, lastBlock: blocks.at(-1)?.kind, userAfter: userAfterSaved(pending, queued, entries),
    waitingOn: !!ticket.waitingOn?.length, stalled: !!stalled,
  });
  // The user's own messages the board still holds, as bubbles at the end of the chat.
  const userQueued = queued.filter((q) => fromUser(q) && !heldByReply(q, pending) && !inSession(q, entries));
  const userBubble = (q: QueuedMessage) => {
    tail = "user";
    return (
      <div key={q.id} className="me-wrap">
      <div className={`conv-msg user pending${editable(q) ? " unsent" : ""}${editing?.id === q.id && editable(q) ? " editing" : ""}`}>
        {editing?.id === q.id && editable(q) ? (
          <>
            <textarea className="queued-edit" rows={3} autoFocus value={editing.text}
              onChange={(e) => setEditing({ id: q.id, text: e.target.value })}
              onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                } else if (enterSends(e)) {
                  e.preventDefault();
                  saveEdit();
                }
              }} />
            <div className="queued-actions">
              <button className="btn primary small" disabled={!editing.text.trim()} onClick={saveEdit}>Save<KeyHint keys="↵" /></button>
              <button className="btn ghost small" onClick={cancelEdit}>Cancel<KeyHint keys="Esc" /></button>
            </div>
          </>
        ) : (
          <>
            <UserText text={q.text} commands={commands} />
            {editable(q) && (
              <div className="queued-actions">
                <button className="btn small" onClick={() => setEditing({ id: q.id, text: q.text })}>Edit</button>
                {q.state === "unsent" && (
                  <button className="btn primary small" disabled={stopping}
                    onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                )}
                <button className="btn ghost small" onClick={() => discard(q.id)}>Discard</button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="me-meta">{q.state === "unsent" ? `not sent · ${claude} was stopped before reading it`
        : running ? (q.slash ? `queued · runs after ${claude}'s current turn` : `sent · ${claude} reads it at its next step`)
        : ticket.slotWait ? "queued · starts when the other ticket is done with the folder" : "The board restarts soon; your message is sent right after (at most 2 minutes)."}</div>
      </div>
    );
  };
  const divider = bp && (
    <div key={`branch-${bp.at}`} className="branch-divider" role="separator">
      <BranchIcon size={12} /> copied from {branchedFrom
        ? <button className="link-btn" onClick={() => onOpenTicket(branchedFrom.id)}>{branchedFrom.title}</button>
        : bp.sourceTitle} · <time dateTime={bp.at} title={fullTime(bp.at)}>{new Date(bp.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</time>
    </div>
  );

  const toolNoteMore = withYouTool(ticket)
    ? "This step talks to you in its feature's chat too; what you say here or there goes straight to it."
    : "What you say here is passed to it.";
  // The phone "+" sheet: after Photo and File, @ Snippet and / Skill (typed at the caret, the picker opens), then the
  // old-chat line when the next message re-reads a lot (it opens the Context panel).
  const plusExtras: MenuItem[] = [
    { label: "Snippet", icon: <kbd className="sheet-kbd">@</kbd>, title: "Insert a saved snippet", onSelect: () => typeTrigger("@") },
    ...(commands?.length ? [{ label: "Skill", icon: <kbd className="sheet-kbd">/</kbd>, title: "Pick a skill or command", onSelect: () => typeTrigger("/") }] : []),
    ...(old && old.tokens > OLD_LINE_MIN_TOKENS
      ? [{ label: old.phoneLine, icon: <ClockIcon />, title: `${old.title} Tap to see what fills Claude's memory.`, onSelect: () => setContextLocal(Date.now()) }]
      : []),
  ];
  return (
    <div className="chat">
      {/* A log for screen readers, but quiet: replies are announced once by ReplyAnnouncer, not chunk by chunk. */}
      <div className="chat-log" ref={scroller} role="log" aria-live="off" aria-label="Conversation"
        onScroll={(e) => {
          const { gap, movedUp } = noteScroll(e.currentTarget);
          setJump((j) => jumpAfterScroll(gap, j, movedUp));
        }}>
        {page === null && <div className="muted"><span className="spinner" /> Loading the conversation…</div>}
        {loadError && (
          <div className="banner error inline load-error" role="alert">
            Couldn't load the conversation: {loadError}{" "}
            <button className="link-btn" onClick={reload}>Retry</button>
          </div>
        )}
        {page && page.start > 0 && (
          <button className="btn ghost small load-earlier" onClick={loadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? "Loading…" : `Load earlier (${page.start} more)`}
          </button>
        )}
        {empty && (
          <div className="chat-empty">
            {ticket.tool && ticket.status === "backlog" ? (
              // A task isn't shaped in Planning: it waits for the user (Start this task) or its main ticket's plan.
              <>
                <p><b>Waiting to start.</b> {TASK_START_HINT[taskStart(ticket) ?? "waits"]}</p>
                {ticket.waitsForStart && (
                  <button className="btn" onClick={() => api.updateTicket(slug, ticket.id, { status: "ready" }).catch((e) => onError(e.message))}>
                    Start this task
                  </button>
                )}
              </>
            ) : ticket.status === "backlog" ? (
              <>
                <p><b>Parked.</b> Move it to Planning when you want Claude to help shape it: it will ask a few questions, then propose a clear title and description.</p>
                <button className="btn" onClick={() => api.updateTicket(slug, ticket.id, { status: "planning" }).catch((e) => onError(e.message))}>
                  Move to Planning
                </button>
              </>
            ) : ticket.status === "planning" ? (
              <>
                {/* Only shown if the automatic start didn't happen (e.g. session was open in a terminal). */}
                <p><b>Shape this ticket with Claude.</b> Describe your idea below, or let Claude start the interview.</p>
                <button className="btn" onClick={() => send("Help me refine this ticket. Interview me about what's unclear, then propose an improved title and description.")}>
                  Start the interview
                </button>
              </>
            ) : (
              <p className="muted">No conversation yet. Move the card to In Progress to let Claude work on it, or send a message.</p>
            )}
          </div>
        )}
        {blocks.map((b, i) => {
          const first = b.kind === "entry" ? b.e : b.items[0];
          const old = before(first, bp?.at);
          const newest = b.kind === "tools" ? i === blocks.length - 1 : i === newestReply;
          return (
            <Fragment key={first.uuid}>
              {helpAt.get(i)?.map((c) => <HelpCardView key={c.id} card={c} />)}
              {notesAt.get(i)?.map((nt) => <StatusNoteView key={nt.at} text={nt.text} />)}
              {resultsAt.get(i)?.map((r) => <ResultCardView key={`${r.ticketId}-${r.at}`} r={r} onOpenTicket={onOpenTicket} />)}
              {sideView(i)}
              {i === dividerAt && divider}
              {layout[i].divider && <TimeDivider label={layout[i].divider!} />}
              {/* Drawn again only when its deps change (see blockDeps). */}
              <MemoBlock deps={blockDeps(b, old, layout[i], newest)} render={() => renderBlock(b, old, layout[i], newest)} />
            </Fragment>
          );
        })}
        {dividerAt === blocks.length && divider}
        {helpAt.get(blocks.length)?.map((c) => <HelpCardView key={c.id} card={c} />)}
        {notesAt.get(blocks.length)?.map((nt) => <StatusNoteView key={nt.at} text={nt.text} />)}
        {resultsAt.get(blocks.length)?.map((r) => <ResultCardView key={`${r.ticketId}-${r.at}`} r={r} onOpenTicket={onOpenTicket} />)}
        {sideView(blocks.length)}
        {help && <HelpPending help={help} />}
        {/* Replies sent while Claude wasn't working are part of the timeline: plain bubbles, before Claude's reply. */}
        {pending.filter((p) => !p.steer).map((p, i) => {
          tail = "user";
          return (
            <UserMessage key={i} text={p.text} sending off={null} onError={onError}>
              <UserText text={p.text} commands={commands} />
            </UserMessage>
          );
        })}
        {ticket.interrupted?.partial && (
          <Turn start={tailStart()} className="interrupted">
            <span className="turn-pill">Cut off by a board restart · {running ? "continuing below" : "resumes when the board is back"}</span>
            <div className="reply-text"><Markdown text={ticket.interrupted.partial} drafts /></div>
          </Turn>
        )}
        {waitingHandoff.map((h) => (
          <Turn key={h.at} start={tailStart()} className="live">
            {liveView(h.text).text && <div className="reply-text"><Markdown text={liveView(h.text).text} drafts /></div>}
            {liveView(h.text).preparing && <div className="working-row preparing"><ClaudeFace mood="working" size={24} /> <span>{liveView(h.text).preparing}</span></div>}
          </Turn>
        ))}
        {live && (
          <Turn start={tailStart()} className="live">
            <div aria-busy="true">
              {liveView(live).text && <div className="reply-text writing"><Markdown text={liveView(live).text} drafts /></div>}
              {liveView(live).preparing && <div className="working-row preparing"><ClaudeFace mood="working" size={24} /> <span>{liveView(live).preparing}</span></div>}
            </div>
          </Turn>
        )}
        <ReplyAnnouncer live={!!live} />
        {running && !live && !!ticket.waitingOn?.length && <WaitingCard tasks={ticket.waitingOn} />}
        {!running && ticket.outcome === "stopped" && blocks.length > 0 && speaker(blocks[blocks.length - 1]) === "claude" && !pending.length && (
          <div className="chat-note stopped">Stopped</div>
        )}
        {pending.filter((p) => p.steer && !queued.some((q) => q.text === p.text)).map((p, i) => {
          tail = "user";
          return (
          <div key={i} className="me-wrap">
            <div className="conv-msg user pending"><UserText text={p.text} commands={commands} /></div>
            <div className="me-meta">sending…</div>
          </div>
          );
        })}
        {queued.filter((q) => q.peer && HUDDLE_TAG.test(q.text)).map((q) => {
          tail = "peer";
          return (
          <HuddleDigest key={q.id} text={q.text.split("<ckanban-context")[0].trim()} pending onOpen={onOpenHuddle}
            meta={<span className="muted small">{q.state === "queued" ? `queued · ${claude} reads this at its next step` : `not sent · ${claude} was stopped before reading it`}</span>}>
            {q.state === "unsent" && (
              <div className="queued-actions">
                <button className="btn primary small" disabled={stopping}
                  onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                <button className="btn ghost small"
                  onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
              </div>
            )}
          </HuddleDigest>
          );
        })}
        {queued.filter((q) => (q.peer && !HUDDLE_TAG.test(q.text)) || (q.from && !inSession({ ...q, text: fromTicket(q.text)?.text ?? q.text }, entries))
          || (q.automation && !inSession({ ...q, text: fromAutomation(q.text)?.text ?? q.text }, entries))).map((q) => {
          const body = q.from ? fromTicket(q.text)?.text ?? q.text : q.automation ? fromAutomation(q.text)?.text ?? q.text : q.text.split("<ckanban-context")[0].trim();
          const state = q.state === "queued" ? q.automation ? `queued · ${claude} reads this once its current reply ends` : `queued · ${claude} reads this at its next step` : `not sent · ${claude} was stopped before reading it`;
          tail = "peer";
          return (
            <Turn key={q.id} start className="pending"
              avatar={q.from ? <LetterAvatar seed={q.from.ticketId} name={q.from.title} />
                : q.automation ? <LetterAvatar seed={`automation:${q.automation.name}`} name={q.automation.name} /> : <LetterAvatar seed="board" name="Board" />}
              name={q.from ? peerName(q.from.ticketId, q.from.title) : q.automation ? `${q.automation.name} (automation)` : "From the board"} sub={state}>
              <div className="peer-bubble"><Markdown text={body} /></div>
              {q.state === "unsent" && (
                <div className="queued-actions">
                  <button className="btn primary small" disabled={stopping}
                    onClick={() => api.sendQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Send</button>
                  <button className="btn ghost small"
                    onClick={() => api.discardQueued(slug, ticket.id, q.id).catch((e) => onError(e.message))}>Discard</button>
                </div>
              )}
            </Turn>
          );
        })}
        {/* Held for Claude: sent while it works, or waiting for a slot or a restart. */}
        {userQueued.filter((q) => q.state === "queued").map(userBubble)}
        {/* Under the messages Claude is answering (the reply's own, steering ones, ones sent again after Stop). */}
        {workingRow && (
          <WorkingRow start={tailStart()} startedAt={ticket.runStartedAt} stalled={stalled} activity={activity}>
            {stalled && <StallActions slug={slug} ticket={ticket} onError={onError} small />}
          </WorkingRow>
        )}
        {/* Steps of this feature working now: live state, gone when none runs (results and questions come as their own blocks). */}
        <StepsWorking ticket={ticket} tickets={tickets} onOpenTicket={onOpenTicket} />
        {/* Left unsent by Stop: Claude isn't answering these, so they stay at the bottom until sent or discarded. */}
        {userQueued.filter((q) => q.state === "unsent").map(userBubble)}
        {!running && ticket.recovery && <RecoveryBanner slug={slug} ticket={ticket} onError={onError} />}
        {!running && !ticket.recovery && ticket.error && !ticket.error.startsWith("corrupt") && (
          <ErrorTurn error={ticket.error} onRetry={() => send(RETRY)} retryDisabled={stopping} />
        )}
        {ticket.notice && (
          <div className="banner info inline notice" role="status">
            <span>{ticket.notice}</span>
            <button className="icon-btn" aria-label="Dismiss" title="Dismiss"
              onClick={() => api.updateTicket(slug, ticket.id, { notice: null }).catch((e) => onError(e.message))}><CloseIcon size={12} /></button>
          </div>
        )}
        {/* Sticky inside the log, so it floats just above the composer. */}
        {chip && (
          <button className="form-chip" onClick={() => showOpenForm("start")} aria-label={`${chip}: scroll up to the questions form`}>
            <ArrowUpIcon size={14} /><span>{chip}</span>
          </button>
        )}
        {jump && (
          <button className={`jump-latest${jump.fresh ? " fresh" : ""}`} onClick={toBottom}
            aria-label={jump.fresh ? "New messages: jump to the latest" : "Jump to the latest message"} title={jump.fresh ? "New messages" : "Jump to latest"}>
            <ArrowDownIcon size={14} />{jump.fresh && <span>New</span>}
          </button>
        )}
      </div>

      {ticket.terminalOpen && !running && (
        <div className="composer-warn">
          Also open in your terminal: type in one place at a time.{" "}
          <button className="link-btn small" aria-expanded={showWarnDetails} onClick={() => setShowWarnDetails((v) => !v)}>
            {showWarnDetails ? "Less" : "Why?"}
          </button>
          {showWarnDetails && (
            <div className="composer-warn-more">
              Sending here works, but if you type in both places at once the two conversations can get mixed up.
            </div>
          )}
        </div>
      )}
      {hiddenTool(ticket) && (
        // Phones: one line ("In charge: <feature>"); the rest is in its tooltip.
        <div className="tool-note" role="note" title={phone ? toolNoteMore : undefined}>
          {phone ? (ticket.mainTicket
            ? <>In charge: <button className="link-btn" onClick={() => onOpenTicket?.(ticket.mainTicket!.id)}>{ticket.mainTicket.title}</button></>
            : "Its feature is in charge of this.")
          : <>{ticket.mainTicket
            ? <><button className="link-btn" onClick={() => onOpenTicket?.(ticket.mainTicket!.id)}>{ticket.mainTicket.title}</button> is in charge of this.</>
            : "Its feature is in charge of this."} {toolNoteMore}</>}
        </div>
      )}
      {undo && !running && (
        <UndoBar info={undo} off={actionsOff} onError={onError} onUndone={undoRewound}
          undo={(files) => api.undoRewind(slug, ticket.id, files)} />
      )}
      {undone && !undo && <UndoneNote line={undone} onClose={() => setUndone(null)} />}
      {waiting.length > 0 && <WaitingButton items={waiting} onPick={pickWaiting} />}
      {turnBar?.render(barForForm ? () => showOpenForm("start") : null)}
      <div className="composer">
        <textarea ref={composer} rows={phone ? 1 : 2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
          aria-label={running ? `Steer ${claude}` : `Message ${claude}`} aria-describedby={images.error ? "chat-attach-error" : undefined}
          placeholder={formWaiting && !running ? `Or reply to ${claude} here instead…` : phone
            ? running ? `Steer ${claude}…` : refine ? "Describe your idea…" : `Ask ${claude}…`
            : running ? `Steer ${claude}: it reads this at its next step, no restart…` : refine ? `Describe your idea or answer ${claude}…` : `Ask ${claude} to change or continue something…`}
          onChange={(e) => setDraft(e.target.value)}
          {...(slash.aria ?? snippets.aria ?? {})}
          onSelect={() => { snippets.handlers.onSelect(); slash.handlers.onSelect(); }}
          onBlur={() => { snippets.handlers.onBlur(); slash.handlers.onBlur(); }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (snippets.onKeyDown(e)) return;
            // ↑ in an empty composer fixes the last message Claude hasn't received yet.
            const last = queued.filter((q) => fromUser(q) && editable(q)).at(-1);
            if (e.key === "ArrowUp" && !draft && last && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              setEditing({ id: last.id, text: last.text });
              return;
            }
            if (enterSends(e)) {
              e.preventDefault();
              submit();
            }
          }} />
        {/* "/" in the ticket panel puts the cursor here (TicketDrawer.tsx); Esc leaves the box, the draft stays. */}
        <KeyHint keys="/" />
        {snippets.popup}
        {slash.popup}
        <AttachmentChips text={draft} images={images} />
        {images.error && <div className="form-error" id="chat-attach-error" role="alert">{images.error}</div>}
        {asking && old && (
          <div className="old-chat-ask" role="alert" title={old.title}>
            <span>{old.ask}</span>
            <button className="btn primary small" onClick={submit}>Send anyway</button>
            <button className="btn small" onClick={sendFresh}>Send in a fresh chat</button>
          </div>
        )}
        {/* One row: + (photo, file; on a phone also snippet, skill and the old-chat line), the Context ring, then Send.
            On a phone this row sits under the text, which gets the box's full width. */}
        <div className="composer-foot one-row">
          <ImagePickButton images={images} target={composer} disabled={stopping} merged extra={phone ? plusExtras : undefined} />
          <ContextChip slug={slug} kind="ticket" id={ticket.id} openRequest={Math.max(contextRequest, contextLocal)} quietBelow={phone ? 80 : undefined} />
          {/* The old-chat line only for a big re-read (over 100k tokens); Send still asks for any old chat. */}
          <span className="composer-meta">
            {phone ? null : old && old.tokens > OLD_LINE_MIN_TOKENS ? (
              <button className="muted small composer-hint composer-old" title={`${old.title} Click to see what fills Claude's memory.`}
                onClick={() => setContextLocal(Date.now())}>{old.line}</button>
            ) : (
              <span className="muted small composer-hint">
                {refine && "Refine mode: Claude won't change files."}
                <span className="composer-keys"> Enter to send · Shift+Enter for a new line · Esc to leave the box{queued.some((q) => fromUser(q) && editable(q)) && " · ↑ to edit your queued message"}</span>
              </span>
            )}
          </span>
          <span className="composer-actions">
            <SendOrStop running={running} hasDraft={!!draft.trim()} stopping={stopping} onStop={stop}
              send={phone
                // Phones: a round arrow, greyed out while the box is empty.
                ? <button className={`btn small send-round${draft.trim() ? " primary" : ""}`} disabled={!draft.trim() || stopping || images.uploading} onClick={submit}
                    aria-label={images.uploading ? "Uploading…" : "Send"} title={images.uploading ? "Uploading…" : "Send"}>
                    {images.uploading ? <span className="spinner" aria-hidden /> : <ArrowUpIcon size={20} />}
                  </button>
                : <button className={`btn small${draft.trim() ? " primary" : ""}`} disabled={!draft.trim() || stopping || images.uploading} onClick={submit}>{images.uploading ? "Uploading…" : "Send"}<KeyHint keys="↵" /></button>} />
          </span>
        </div>
      </div>
      {sheetTask && (
        <TaskSheet title={sheetTask.title} onClose={sheet.close} onOpenFull={() => onOpenTicket(sheetTask.id)}>
          <Chat key={sheetTask.id} slug={slug} ticket={sheetTask} tickets={tickets} onOpenTicket={onOpenTicket} onError={onError} />
        </TaskSheet>
      )}
    </div>
  );
}
