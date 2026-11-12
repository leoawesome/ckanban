import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api, NotStarted, subscribe, type Huddle, type Level, type NewTicketDraft, type OutputFile, type Proposal, type QueuedMessage, type RewindResult, type SessionEntry, type TeammateProposal, type Ticket,
} from "./api";
import { HuddleCard } from "./HuddleCard";
import { HuddleDigest } from "./HuddleDigest";
import { usePresets } from "./HuddleRoster";
import type { TeamRequest } from "./Team";
import { TeammateCard } from "./TeammateCard";
import { SquadCard } from "./SquadCard";
import { AutomationCard } from "./AutomationCard";
import { KeysBox } from "./KeysBox";
import { oldChat } from "./cacheNote";
import { ContextChip } from "./ContextPanel";
import { autoGrow } from "./autoGrow";
import { branchTicket } from "./branch";
import { BranchCard } from "./BranchCard";
import { DeleteCard } from "./DeleteCard";
import { ScheduleDeleteCard } from "./ScheduleDeleteCard";
import { AgentRows } from "./AgentRow";
import { liveLine, runMood } from "./avatarMood";
import { useClaudeName } from "./AvatarFace";
import { WorkflowBlocks } from "./WorkflowBlock";
import { ToolRows } from "./ToolRows";
import { ArrowDownIcon, BranchIcon, ClockIcon, CloseIcon, CopyIcon, DownloadIcon, FileCodeIcon, FileTextIcon, MoreIcon } from "./icons";
import { MoreSheet } from "./PhoneNav";
import type { MenuItem } from "./HeaderMenu";
import { useTypeTrigger } from "./typeTrigger";
import { useImagePaste } from "./imagePaste";
import { AttachmentChips } from "./AttachmentChips";
import { ImagePickButton } from "./ImagePickButton";
import { NewTicketsCard } from "./NewTicketsCard";
import { createdFromDraft } from "./proposalMatch";
import { KeyHint } from "./KeyHint";
import { followUpFor, followUpPlace, followUpState } from "./followUp";
import { parentLink } from "./family";
import { ProposalCard, type FollowUp } from "./ProposalCard";
import { QuestionsForm } from "./QuestionsForm";
import { RecoveryBanner } from "./RecoveryBanner";
import { UndoBar, UndoneNote, UserMessage, undoFromRewind, undoFromState, type UndoInfo } from "./MessageActions";
import { draftAfterUndo } from "./messageText";
import { restoredDraft, rewindOff } from "./rewindText";
import { SetupRow } from "./SetupRow";
import { HelpCardView, HelpPending, type HelpState } from "./HelpMenu";
import { StatusNoteView, useFeatureStatus } from "./StatusBlock";
import { ResultCardView } from "./ResultCardView";
import { askClosed, familyOf, hiddenTool, withYouTool } from "./family";
import { type StepInfo, type StepMsg, useStepMessages } from "./StepMessages";
import { QuestionText } from "./QuestionText";
import { TaskCard, TaskSheet, TaskTrail, useSheet, WaitingButton } from "./TaskSheet";
import { shortNote, waitingItems, type WaitingItem } from "./taskCards";
import { useSimpler } from "./Simpler";
import { replyText, simplifiable } from "./simplifyText";
import { ClaudeFace, ErrorTurn, LetterAvatar, ReplyActions, SendOrStop, StepsLine, TimeDivider, Turn, WorkingRow } from "./ConvTurn";
import { fromAutomation, fromTicket, layoutTurns, placeByTime, telegramMarks, type TurnLayout } from "./chatTurns";
import { gapOf, jumpAfterScroll, NEAR_BOTTOM, onContentChange, stickAfterScroll, USER_CHANGE_MS } from "./chatFollow";
import { StallActions, stallWait } from "./StallActions";
import { useSnippetPicker } from "./SnippetPicker";
import { useSlashCommands, useSlashPicker } from "./SlashPicker";
import { commandNote, messageCommand, type SlashCommand } from "./slashText";
import { filesByReply, STATUS_FILES } from "./fileCards";

import { expired, handoff as handoffOf, liveView, repeats, saved, withHandoff, type Handoff } from "./liveReply";
import { heldByReply, inSession, liveProgress, norm, unsentNow, userAfterSaved, type Pending } from "./pendingBubbles";
import { baseName, copyFile, dirName, downloadFile } from "./share";
import { browserStore, draftKey, formKey, save } from "./drafts";
import { type FormState, formStates, repeatsForm } from "./questionForms";
import { elapsed, fullTime, timeAgo } from "./time";
import { stepsLine, stepsLineText, stepsWorking } from "./stepsLive";
import { useNow } from "./useNow";
import { canStartFromProposal } from "./keynav";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { usePersistentState } from "./usePersistentState";
import { usePhone } from "./usePhone";
import { enterSends } from "./enterSends";

/** File cards shown under one reply; the rest are in the Outputs tab. */
const MAX_FILE_CARDS = 8;

/** m:ss (h:mm:ss past an hour) since `iso`. */
function clock(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const mm = String(Math.floor((s % 3600) / 60)), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Claude ended its turn to wait for background tasks; the run stays open and it resumes when they finish. */
function WaitingCard({ tasks }: { tasks: NonNullable<Ticket["waitingOn"]> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="waiting-card" aria-live="polite">
      <div className="waiting-title"><span className="spinner" /> Waiting for {tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}</div>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}><span>{t.description}</span><span className="waiting-time" title={`Started ${fullTime(t.startedAt)}`}>{clock(t.startedAt, now)}</span></li>
        ))}
      </ul>
      <div className="waiting-note">Claude continues automatically when they finish.</div>
    </div>
  );
}

/** A message the user sent: a slash command shows as a chip with what runs it, anything else as markdown. */
function UserText({ text, commands, command }: { text: string; commands: SlashCommand[] | null; command?: string }) {
  const c = command ? commands?.find((x) => x.name === command) ?? null : messageCommand(text, commands);
  if (!command && !c) return <Markdown text={text} />;
  const name = command ?? c!.name;
  const args = text.trim().slice(name.length + 1).trim();
  return (
    <>
      <div className="cmd-line"><span className="cmd-chip">/{name}</span>{args && <span className="cmd-args">{args}</span>}</div>
      <div className="cmd-note">{commandNote(c)}</div>
    </>
  );
}

/** A message the board sent by itself (status refresh, tool ticket updates): one grey line that opens to the full text. */
function WakeNote({ entry: e, old }: { entry: SessionEntry; old: boolean }) {
  return (
    <details className={`chat-note wake-note${old ? " inherited" : ""}`}>
      <summary>Board update: {e.wake}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</summary>
      {e.text && <div className="wake-body"><Markdown text={e.text} /></div>}
    </details>
  );
}

/** tools: a run of tool calls folded into one line; agents: a run of subagent rows. */
type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] } | { kind: "agents"; items: SessionEntry[] }
  | { kind: "workflows"; items: SessionEntry[] };

/** Who a block is from, for grouping rows into turns. */
function speaker(b: Block): string {
  if (b.kind !== "entry") return "claude";
  const e = b.e;
  if (e.kind === "board") return "board";
  if (e.huddleId) return "huddle";
  if (e.peer?.ticketId) return `peer:${e.peer.ticketId}`;
  if (e.peer?.automation) return `automation:${e.peer.automation}`;
  if (e.role === "user") return "user";
  return e.commandOutput ? "command" : "claude";
}

/** Copied history of a branched ticket: entries from before the branch point (at = the branch time). */
/** Old chats the user already chose to send to, by ticket: the reply (cache.at) they confirmed for; asked once per old period. */
const oldChatOk = new Map<string, string>();
/** The message box's footer names an old chat only above this size; smaller ones just get the ask at Send. */
const OLD_LINE_MIN_TOKENS = 100_000;

const before = (e: SessionEntry, at: string | undefined) => !!at && !!e.at && e.at < at;

const CARDS = ["questions", "proposal", "newTickets", "branch", "huddle", "deletion", "scheduleDeletion", "teammate", "squad", "automation", "keys"] as const;

/**
 * Tool calls (and subagents) in a row fold into one block; a branch point (splitAt) starts a new one. A reply that
 * only repeats the questions form just above it in the same run is left out: the form already says it.
 */
function group(entries: SessionEntry[], splitAt?: string): Block[] {
  const out: Block[] = [];
  let form: SessionEntry["questions"] = undefined;
  entries.forEach((e, index) => {
    if (e.role === "user" || e.kind === "board") form = undefined;
    if (e.questions) form = e.questions;
    else if (form && e.role === "assistant" && e.kind === "text" && !e.commandOutput && !CARDS.some((k) => e[k]) && repeatsForm(replyText(e.text), form)) return;
    const prev = out.at(-1);
    if (e.kind === "tool" || e.kind === "agent" || e.kind === "workflow") {
      const kind = e.kind === "tool" ? "tools" : e.kind === "agent" ? "agents" : "workflows";
      if (prev?.kind === kind && before(prev.items[0], splitAt) === before(e, splitAt)) prev.items.push(e);
      else out.push({ kind, items: [e] });
    } else out.push({ kind: "entry", e, index });
  });
  return out;
}

const HANDOFF_RETRY_MS = 500;

const UNREADABLE = { questions: "questions", proposal: "ticket proposal", tickets: "proposed tickets" } as const;

/** What the Resend button sends: the same content again, through the matching tool. */
const RESEND = {
  questions: "The board couldn't read your questions. Please resend them with the ask_questions tool.",
  proposal: "The board couldn't read your ticket proposal. Please resend it with the propose_ticket tool.",
  tickets: "The board couldn't read your proposed tickets. Please resend them with the propose_tickets tool.",
} as const;

/** What Retry under a failed run sends. */
const RETRY = "That run stopped with an error. Please try again from where you stopped.";

const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

/**
 * The files a reply wrote: one compact row each (name, size, Open; Copy file and Download behind ⋯ on a phone, beside
 * Open on a wider screen). More than two fold into one "N files" row that opens the list.
 */
function ChatFiles({ files, canCopy, onOpen, onCopy, onDownload }: {
  files: { name: string; size: number }[]; canCopy: boolean;
  onOpen: (name: string) => void; onCopy: (name: string) => void; onDownload: (name: string) => void;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(files.length <= 2);
  const [menu, setMenu] = useState<string | null>(null);
  const shown = files.slice(0, MAX_FILE_CARDS);
  return (
    <div className="chat-files">
      {files.length > 2 && (
        <button className="chat-files-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <FileTextIcon size={14} /><span>{files.length} files</span><span className="fold-chev side" aria-hidden>▸</span>
        </button>
      )}
      {open && shown.map((f) => (
        <div key={f.name} className="chat-file">
          <FileTextIcon size={14} />
          <b title={f.name}>{dirName(f.name) && <span className="chat-file-dir">{dirName(f.name)}</span>}{baseName(f.name)}</b>
          <span className="muted small chat-file-size">{kb(f.size)}</span>
          <span className="chat-file-actions">
            <button className="btn small view" onClick={() => onOpen(f.name)}>Open</button>
            {phone ? (
              <button className="btn small icon-only chat-file-more" aria-label={`More for ${baseName(f.name)}`} aria-haspopup="menu"
                onClick={() => setMenu(f.name)}><MoreIcon size={16} /></button>
            ) : <>
              {canCopy && <button className="btn small" onClick={() => onCopy(f.name)}>Copy file</button>}
              <button className="btn small" onClick={() => onDownload(f.name)}>Download</button>
            </>}
          </span>
        </div>
      ))}
      {open && files.length > MAX_FILE_CARDS && (
        <button className="link-btn small chat-more-files" onClick={() => onOpen(files[MAX_FILE_CARDS].name)}>
          +{files.length - MAX_FILE_CARDS} more files in the Outputs tab
        </button>
      )}
      {menu && (
        <MoreSheet label={baseName(menu)} onClose={() => setMenu(null)} items={[
          ...(canCopy ? [{ label: "Copy file", icon: <CopyIcon />, onSelect: () => onCopy(menu) }] : []),
          { label: "Download", icon: <DownloadIcon />, onSelect: () => onDownload(menu) },
        ]} />
      )}
    </div>
  );
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether a message the user sent is in the session file yet. */
const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/** How long the notes beside the conversation wait for the steps' chats and the status after the conversation is in. */
const SIDE_WAIT_MS = 3000;

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
/** Stop Claude with instant feedback: "Stopping…" from the click until the run is gone. */
/**
 * A main ticket's live "Working: <step>" line while steps of its feature (or tickets the user added) work; each name
 * opens that step. One working step also shows its latest activity and how long it has run.
 */
function StepsWorking({ ticket, tickets, onOpenTicket }: { ticket: Ticket; tickets: Ticket[]; onOpenTicket: (id: string) => void }) {
  const steps = useMemo(() => stepsWorking(tickets, ticket), [tickets, ticket]);
  const claude = useClaudeName();
  const line = stepsLine(steps);
  if (!line) return null;
  const one = steps.length === 1 && steps[0].running ? steps[0] : null;
  return (
    <div className="steps-live" role="status" aria-live="polite" title={stepsLineText(steps.map((t) => t.title))}>
      <ClaudeFace mood={one ? runMood(one.lastActivity) : "working"} size={24} />
      <span className="steps-live-text">
        {line.lead}{" "}
        {line.shown.map((t, i) => (
          <Fragment key={t.id}>
            {i > 0 && ", "}
            <button type="button" className="link-btn" onClick={() => onOpenTicket(t.id)}>{t.title}</button>
          </Fragment>
        ))}
        {line.more > 0 && ` and ${line.more} more`}
        {one?.lastActivity && <span className="steps-live-activity"> · {liveLine(one.lastActivity, claude)}</span>}
      </span>
      {one?.runStartedAt && <span className="working-time">· {elapsed(one.runStartedAt)}</span>}
    </div>
  );
}

export function useStop(slug: string, ticket: Ticket, working: boolean, onError: (m: string) => void) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!working) setClicked(false);
  }, [working]);
  const stopping = working && (clicked || ticket.lastActivity === "Stopping…");
  const stop = () => {
    setClicked(true);
    api.stop(slug, ticket.id).catch((e) => {
      setClicked(false);
      onError(e.message);
    });
  };
  return { stopping, stop };
}

/** A queued peer message that carries huddle messages (see the server's huddleMainPrompt). */
const HUDDLE_TAG = /<ckanban-context[^>]* huddle="/;

export function Chat({ slug, ticket, tickets, onOpenTicket, onOpenTasks, onOpenOutput, onError, onPendingProposal, huddle = null, onOpenHuddle, onOpenTeam, help, onFilesChanged, contextRequest = 0 }: {
  /** A Date.now() stamp: a new one opens the Context panel (the ticket ⋯ menu's Context item). */
  contextRequest?: number;
  slug: string;
  ticket: Ticket;
  /** The board's tickets, to tell which proposed new tickets already exist. */
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  /** Open the Tasks tab (the feature status and its tasks), from the "Waiting on you" line. */
  onOpenTasks?: () => void;
  /** Show a file of the ticket's outputs folder (path relative to it) in the Outputs tab. */
  onOpenOutput?: (name: string) => void;
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
  const stickToBottom = useRef(true);
  // Bottom gap and scroll position as last seen, to tell new content below the view from a scroll.
  const lastGap = useRef(0);
  const lastTop = useRef(0);
  // The user is pressing in the chat (selecting text, dragging the scrollbar, touching): new content waits for them.
  const pressing = useRef(false);
  const held = useRef(false);
  const releasedAt = useRef(0);
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
      if (!prev || r.start <= prev.start) return { entries: r.entries, start: r.start };
      const idx = prev.entries.findIndex((e) => e.uuid === r.entries[0]?.uuid);
      return idx >= 0 ? { entries: [...prev.entries.slice(0, idx), ...r.entries], start: prev.start } : { entries: r.entries, start: r.start };
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

  // Fork from here, Rewind and Undo rewind wait while Claude works or a message waits to be sent.
  const actionsOff = rewindOff(running, queued.length);
  // The last rewind while it can be undone (the Undo bar under the chat), and what the last Undo did.
  const [undo, setUndo] = useState<UndoInfo | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Opening the chat: a rewind that can still be undone (nothing sent or run since) shows its bar again.
  useEffect(() => {
    setUndo(null);
    setUndone(null);
    if (running) return;
    let live = true;
    api.rewindUndoState(slug, ticket.id, false).then((s) => live && setUndo((u) => u ?? undoFromState(s)), () => {});
    return () => {
      live = false;
    };
  }, [slug, ticket.id]);
  // A run starting (the user's message or the board's) ends the chance to undo.
  useEffect(() => {
    if (!running) return;
    setUndo(null);
    setUndone(null);
  }, [running]);
  const rewound = (r: RewindResult) => {
    const before = draftRef.current;
    const filled = restoredDraft(r.text, before);
    setDraft(filled);
    setUndone(null);
    setUndo(r.undo ? undoFromRewind(r, filled, before) : null);
    stickToBottom.current = true;
    setPage(null);
    reload();
    onFilesChanged?.();
    composer.current?.focus();
  };
  const undoRewound = (r: { files: number }, line: string) => {
    const d = undo?.draft;
    if (d) setDraft((cur) => draftAfterUndo(cur, d.filled, d.before));
    setUndo(null);
    setUndone(line);
    stickToBottom.current = true;
    setPage(null);
    reload();
    if (r.files) onFilesChanged?.();
  };
  // Fork from here: a new ticket whose chat ends before the message; the message waits in its box.
  const forkFrom = async (uuid: string) => {
    const r = await api.forkTicket(slug, ticket.id, uuid);
    save(browserStore(), draftKey(slug, r.id), r.text);
    onOpenTicket(r.id);
    toast(r.warning ? <>Forked into <b>{r.ticket.title}</b>. {r.warning}</> : <>Forked into <b>{r.ticket.title}</b></>,
      { tone: r.warning ? "info" : "ok", ...(r.warning ? { ms: 9000 } : {}) });
    return `Forked into "${r.ticket.title}". It is open now.`;
  };
  useEffect(() => {
    setPage(null);
    setHandoff([]);
    reload();
  }, [reload]);
  useLayoutEffect(() => autoGrow(composer.current), [draft, phone]);

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
  useEffect(() => {
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

  // A message Claude hasn't received yet (not sent after Stop, or waiting for a slot or a restart): the user can
  // still edit or discard it. With Claude running it was handed over at once.
  const editable = (q: QueuedMessage) => !q.from && !q.automation && (q.state === "unsent" || (!q.peer && !running));
  // Another ticket's message: shown as that ticket's, not as the user's.
  const fromUser = (q: QueuedMessage) => !q.peer && !q.from && !q.automation;
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const discarded = useRef(new Set<string>());
  const cancelEdit = () => {
    setEditing(null);
    composer.current?.focus();
  };
  const saveEdit = async () => {
    if (!editing?.text.trim()) return;
    try {
      await api.editQueued(slug, ticket.id, editing.id, editing.text.trim());
      cancelEdit();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const discard = (msgId: string) => {
    discarded.current.add(msgId);
    api.discardQueued(slug, ticket.id, msgId).catch((e) => {
      discarded.current.delete(msgId);
      onError(e.message);
    });
  };

  // Claude read a queued message: keep its bubble until the session file shows it, so it doesn't blink out.
  const prevQueued = useRef(queued);
  useEffect(() => {
    // Peer messages show up in the session as another ticket's message, not as the user's bubble.
    const read = prevQueued.current.filter((q) => q.state === "queued" && fromUser(q) && !discarded.current.has(q.id) && !queued.some((n) => n.id === q.id)).map((q) => q.text);
    prevQueued.current = queued;
    // The reply's own message already has its plain bubble.
    if (read.length) setPending((ps) => [...ps, ...read.filter((text) => !ps.some((p) => !p.steer && p.text === text)).map((text) => ({ text, steer: false }))]);
    const unsent = unsentNow(pendingRef.current, queued);
    if (unsent.length) setPending((ps) => ps.filter((p) => !unsent.includes(p)));
  }, [ticket.queued]);

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
  // Output files for the cards under replies; refreshed whenever the conversation is.
  const [files, setFiles] = useState<OutputFile[]>([]);
  useEffect(() => {
    if (page) api.outputs(slug, ticket.id).then(setFiles).catch(() => {});
  }, [slug, ticket.id, page, running]);
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
  // Anything new at the bottom: Claude's reply, grey board notes, step cards, "asks:" blocks, the Working line, queued
  // messages, a picture finishing loading. Watching the log itself catches all of them, whatever state they come from.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      const after = gapOf(el);
      const userCaused = Date.now() - releasedAt.current < USER_CHANGE_MS;
      const what = onContentChange({ before: lastGap.current, after, stuck: stickToBottom.current, pressing: pressing.current, userCaused });
      if (userCaused && after > lastGap.current) stickToBottom.current = after < NEAR_BOTTOM;
      if (what === "scroll") el.scrollTop = el.scrollHeight;
      else if (what === "hold") held.current = true;
      else if (what === "button") setJump((j) => (j?.fresh ? j : { fresh: true }));
      lastGap.current = gapOf(el);
      lastTop.current = el.scrollTop;
    };
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("load", check, true);
    const press = () => { pressing.current = true; };
    const release = () => {
      if (!pressing.current) return;
      pressing.current = false;
      releasedAt.current = Date.now();
      if (held.current && stickToBottom.current) el.scrollTop = el.scrollHeight;
      held.current = false;
      lastGap.current = gapOf(el);
    };
    el.addEventListener("mousedown", press);
    el.addEventListener("touchstart", press, { passive: true });
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    return () => {
      mo.disconnect();
      ro.disconnect();
      el.removeEventListener("load", check, true);
      el.removeEventListener("mousedown", press);
      el.removeEventListener("touchstart", press);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, []);
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
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setJump(null);
  };

  // An old chat re-reads in full: the footer says so, and the first Send asks (Send anyway / Send in a fresh chat).
  const old = oldChat({ cache: ticket.session?.cache, running, freshSession: ticket.freshSession, now: Date.now() });
  const okKey = `${slug}/${ticket.id}`;
  const oldUnconfirmed = !!old && oldChatOk.get(okKey) !== old.at;
  const [askOld, setAskOld] = useState(false);
  const asking = askOld && oldUnconfirmed && !!draft.trim();
  /** Send or Enter in the box: asks first on an old chat; Enter (or Send) again means send anyway. */
  const submit = () => {
    if (!draft.trim() || stopping || images.uploading) return;
    if (old && oldUnconfirmed) {
      if (!asking) {
        setAskOld(true);
        return;
      }
      oldChatOk.set(okKey, old.at);
    }
    setAskOld(false);
    send(draft);
  };
  const sendingNow = useRef(new Set<string>());
  const sendFresh = () => {
    if (old) oldChatOk.set(okKey, old.at);
    setAskOld(false);
    send(draft, true);
  };

  const send = async (text: string, fresh = false) => {
    // A command goes as `/name args`, the way the server queues it and the session shows it.
    const t = messageCommand(text, commands) ? text.trim().replace(/^(\S+)\s+/, "$1 ") : text.trim();
    if (!t || stopping || images.uploading) return;
    // The same text already on its way (a double tap on a form's Send): sent once.
    if (sendingNow.current.has(t)) return;
    sendingNow.current.add(t);
    try {
      await sendOnce(t, fresh);
    } finally {
      sendingNow.current.delete(t);
    }
  };
  const sendOnce = async (t: string, fresh: boolean) => {
    images.clearError();
    stickToBottom.current = true;
    const steer = running;
    setPending((ps) => [...ps, { text: t, steer }]);
    setDraft("");
    setUndo(null);
    setUndone(null);
    try {
      const r = await api.chat(slug, ticket.id, t, fresh);
      // Steering or waiting for a slot: the server queue now shows it. A reply it started keeps its plain bubble while the
      // board holds it until Claude reads it. /clear and /model: the board ran them, nothing reaches the session.
      if ((r.queued?.some((q) => q.text === t) && (steer || !r.running)) || messageCommand(t, commands)?.source === "board") setPending((ps) => ps.filter((p) => p.text !== t));
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p.text !== t));
      setDraft(t);
      onError(e.message);
    }
  };

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

  // A reply still on its way to the session file counts too, so the form doesn't offer "Send answers" again.
  const replying = pending.some((p) => !p.steer);
  // Board updates (kind "board") never answer: a form they interrupt stays open, or is asked again below.
  const answeredAfter = (index: number) => replying || entries.slice(index + 1).some((e) => e.role === "user" && e.kind === "text" && !e.huddleId && !e.peer?.automation);
  // Forms the user closed without answering (Close question), by uuid; the newest open one also when the ticket only
  // knows a close came after its last run (it closed by itself when they answered in its task's chat).
  const closedIds = useMemo(() => new Set(Object.keys(ticket.closedForms ?? {})), [ticket.closedForms]);
  const closeLatest = !running && askClosed(ticket);
  const forms = useMemo(() => formStates(entries, replying, closedIds, closeLatest), [entries, replying, closedIds, closeLatest]);
  /** The message that answered form index: in the chat, or still on its way. */
  const answerOf = (index: number): string | undefined => {
    const f = formState(index);
    if (f.state !== "answered") return undefined;
    return f.by !== undefined ? entries[f.by]?.text : pending.find((p) => !p.steer)?.text;
  };
  const closeForm = (uuid: string) => api.closeForm(slug, ticket.id, uuid).catch((err: Error) => onError(err.message));
  const formState = (index: number): FormState => forms.get(index) ?? { state: "answered" };
  const replacedBy = (index: number) => { const f = formState(index); return f.state === "replaced" ? f : undefined; };
  /** Where an open form saves its progress: shared with the earlier forms it asks again. */
  const openKey = (index: number) => { const f = formState(index); return f.state === "open" ? f.key : undefined; };
  const isApplied = (p: Proposal) =>
    (!p.title || p.title === ticket.title) && (!p.description || p.description.trim() === ticket.body.trim()) && (!p.important || !!ticket.important) &&
    (p.partOf === undefined || (parentLink(ticket)?.id ?? null) === p.partOf);
  /** What Apply does to the ticket's family, for the card; undefined when the proposal leaves it as it is. */
  const familyNote = (p: Proposal) => {
    if (p.partOf === undefined || (parentLink(ticket)?.id ?? null) === p.partOf) return undefined;
    if (p.partOf === null) return "Apply also takes this ticket out of the work it is part of, so it is no longer one of its tasks.";
    const to = tickets.find((t) => t.id === p.partOf);
    return to ? `Apply also moves this ticket under “${to.title}”.` : undefined;
  };

  const empty = page !== null && !loadError && entries.length === 0 && !pending.length && !queued.length && !running;

  // The ticket a proposed draft became: this ticket's child with its key or proposed title (still found after a rename),
  // else any ticket on the board with that title, which counts as handled too (the server's attention rule).
  // A questions form still waits for answers: the message box offers a note instead of a second way to answer.
  const formWaiting = [...forms.values()].some((f) => f.state === "open");
  const childFor = (d: NewTicketDraft) => createdFromDraft(tickets, ticket.id, d);
  const createChild = async (d: NewTicketDraft) => {
    try {
      return await api.createTicket(slug, {
        title: d.title, body: d.description, status: "backlog", mode: "interview", parentId: ticket.id, proposedAs: d.title,
        ...(d.key ? { planKey: d.key } : {}), ...(d.dependsOn?.length ? { dependsOn: d.dependsOn } : {}),
        ...(d.needs?.length ? { needs: d.needs } : {}), ...(d.tags?.length ? { tags: d.tags } : {}), ...(d.important ? { important: true } : {}),
      });
    } catch (err: any) {
      onError(err.message);
      return null;
    }
  };

  // Proposals applied with "Apply & start work" here, so their card says the ticket moved on.
  const [startedProposals, setStartedProposals] = useState<ReadonlySet<string>>(new Set());
  // An already-planned main ticket's card offers "Apply & start work" too: moving it to Ready is the go-ahead for its plan
  // (the user asked for it after finding only Apply there; plain Apply still never starts anything).
  const canStart = canStartFromProposal({ status: ticket.status, working: ticket.status === "in_progress" || running });
  const applyProposal = async (p: Proposal, start?: { uuid: string }) => {
    const before = { title: ticket.title, body: ticket.body, important: !!ticket.important };
    try {
      // The family move first: when it can't be made (a plan sibling depends on it), nothing changes.
      if (familyNote(p)) await api.setPartOf(slug, ticket.id, p.partOf!);
      // One update, so the ticket never sits in Ready with the old text.
      await api.updateTicket(slug, ticket.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { body: p.description } : {}),
        ...(p.important ? { important: true } : {}),
        ...(start ? { status: "ready" as const } : {}),
      });
      // No Undo once it starts: Claude may already be working from the new text.
      if (start) {
        setStartedProposals((s) => new Set(s).add(start.uuid));
        return void toast("Applied to the ticket and moved to Ready", { tone: "ok" });
      }
      toast("Applied to the ticket", {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => api.updateTicket(slug, ticket.id, before).catch((err) => toast(`Undo failed: ${err.message}`, { tone: "error" })),
        },
      });
    } catch (err: any) {
      // Start was cancelled (a huddle works on the ticket): still apply the text, without starting.
      if (start && err instanceof NotStarted) return applyProposal(p);
      onError(err.message);
    }
  };

  // Teammate cards: the board's teammates tell a new one from a change; reloaded after each save.
  const [presetsVersion, setPresetsVersion] = useState(0);
  const presets = usePresets(slug, presetsVersion);
  const saveTeammate = async (uuid: string, p: TeammateProposal, scope: Level) => {
    try {
      const { why: _w, ...fields } = p;
      const saved = await api.saveHuddlePreset(slug, fields, scope);
      await api.answerTeammateCard(slug, ticket.id, uuid, { state: "saved", name: saved.name, scope });
      setPresetsVersion((n) => n + 1);
    } catch (err: any) {
      onError(err.message);
    }
  };
  const dismissTeammate = (uuid: string) => api.answerTeammateCard(slug, ticket.id, uuid, { state: "dismissed" }).then(() => {}, (err) => onError(err.message));

  // A plain ticket that already ran: proposals are follow-up work (a step of its feature, or its first step as it becomes
  // a main ticket), so this one keeps its title and description and the user keeps talking here.
  const onState = followUpState(ticket);
  const place = onState === undefined ? null : followUpPlace(tickets, ticket.id);
  const startFollowUp = async (p: Proposal, start: boolean) => {
    try {
      const f = await api.followUpWork(slug, ticket.id, { title: p.title, body: p.description, start, ...(p.important ? { important: true } : {}) });
      const runner = place?.as === "step" ? tickets.find((t) => t.id === place.manager) : place?.as === "main" ? ticket : undefined;
      const where = runner?.plan?.state === "paused" ? "Step added; it waits until you press Resume on the Plan tab"
        : place?.as === "step" ? "Step started; follow it on the feature's card"
        : place?.as === "main" ? "Step started; you keep talking here"
        : start ? "Ticket created and moved to Ready" : "Ticket created in Backlog";
      toast(where, { tone: "ok", ...(place?.as === "ticket" ? { action: { label: "Open", run: () => onOpenTicket(f.id) } } : {}) });
    } catch (err: any) {
      onError(err.message);
    }
  };
  const followUpOf = (p: Proposal): FollowUp | undefined => {
    const created = followUpFor(tickets, ticket.id, p.title);
    // A card that already started its work keeps saying so, also after it made this ticket a main ticket (its Apply
    // would otherwise overwrite the new main ticket's title and description).
    const at = place ?? (created ? followUpPlace(tickets, ticket.id) : null);
    if (!at || (onState === undefined && !created)) return undefined;
    return { state: onState ?? null, place: at, created, onCreate: (start) => startFollowUp(p, start), onOpen: onOpenTicket };
  };

  const pendingProposal = entries.findLast((e) => e.proposal && !isApplied(e.proposal) && !followUpFor(tickets, ticket.id, e.proposal.title));
  const applyPendingRef = useRef((_start: boolean) => Promise.resolve());
  applyPendingRef.current = (start) => (!pendingProposal?.proposal ? Promise.resolve()
    // ⌘⇧Enter on a follow-up card: start that work.
    : place ? startFollowUp(pendingProposal.proposal, true)
    : applyProposal(pendingProposal.proposal, start && canStart ? { uuid: pendingProposal.uuid } : undefined));
  useEffect(() => {
    onPendingProposal?.(pendingProposal ? (start) => applyPendingRef.current(start) : null);
  }, [pendingProposal?.uuid]);
  useEffect(() => () => onPendingProposal?.(null), []);

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
              <HuddleDigest key={e.uuid} text={e.text} old={old} onOpen={onOpenHuddle}
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
              <UserMessage key={e.uuid} at={e.at} text={e.text} className={old ? "inherited" : undefined} off={actionsOff} onError={onError}
                fork={canGo ? { title: ticket.title, run: () => forkFrom(e.uuid) } : undefined}
                rewind={canGo ? {
                  later: entries.slice(b.index + 1).filter((x) => x.kind === "text" && !!x.text && !x.commandOutput).length,
                  preview: () => api.rewindPreview(slug, ticket.id, e.uuid),
                  apply: (files) => api.rewind(slug, ticket.id, e.uuid, files),
                  onDone: rewound,
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
              {e.text && <div className="reply-text"><Markdown text={shown()} /></div>}
              {tgMarks.out.has(e.uuid) && <span className="tg-mark" title="This reply was sent to you in Telegram">sent to Telegram</span>}
              {e.text && replyText(e.text) && (
                <ReplyActions text={shown} simpler={simplifiable(e) ? simpler.link(e.uuid) : undefined}
                  newest={newest} lastOfTurn={l.lastReply} active={simpler.active(e.uuid)} />
              )}
              {e.questions && (
                <QuestionsForm questions={e.questions} answered={formState(b.index).state === "answered"} answer={answerOf(b.index)}
                  replaced={replacedBy(b.index)} closed={formState(b.index).state === "closed"} onClose={() => closeForm(e.uuid)}
                  disabled={running} onSubmit={send} onPreview={onOpenOutput && ((m) => onOpenOutput(`mockups/${m}`))}
                  storageKey={formKey(slug, ticket.id, openKey(b.index) ?? e.uuid)} />
              )}
              {e.proposal && (
                <ProposalCard proposal={e.proposal} applied={isApplied(e.proposal)} started={startedProposals.has(e.uuid)}
                  onApply={() => applyProposal(e.proposal!)}
                  onApplyStart={canStart ? () => applyProposal(e.proposal!, { uuid: e.uuid }) : undefined}
                  keyHint={e === pendingProposal} followUp={followUpOf(e.proposal)} family={familyNote(e.proposal)} />
              )}
              {e.newTickets && (
                <NewTicketsCard drafts={e.newTickets} created={childFor} parentId={ticket.id} onCreate={createChild} onOpen={onOpenTicket} />
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
                <AutomationCard slug={slug} ticketId={ticket.id} uuid={e.uuid} proposal={e.automation} saved={ticket.automationCards?.[e.uuid]} onError={onError} />
              )}
              {e.keys && (
                <KeysBox slug={slug} ticketId={ticket.id} uuid={e.uuid} ask={e.keys} answered={ticket.keyCards?.[e.uuid]}
                  old={entries.slice(b.index + 1).some((x) => x.role === "user" && x.kind === "text" && !x.huddleId && !x.peer?.automation)} onError={onError} />
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
                <ChatFiles files={cards.get(e.uuid)!} canCopy={!!ticket.canCopyFile} onOpen={(n) => onOpenOutput?.(n)}
                  onCopy={(n) => copyFile(slug, ticket.id, n)} onDownload={(n) => downloadFile(slug, ticket.id, n)} />
              )}
              {e.unreadable && (
                <div className="chat-unreadable" role="status">
                  <span>Couldn't read Claude's {UNREADABLE[e.unreadable]}.</span>
                  {!answeredAfter(b.index) && (
                    <button className="btn small" disabled={running} onClick={() => send(RESEND[e.unreadable!])}>Resend</button>
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
    <button type="button" className="link-btn turn-link" onClick={() => onOpenTicket(id)}>{tickets.find((x) => x.id === id)?.title ?? title ?? id}</button>
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
    const form = [...(scroller.current?.querySelectorAll<HTMLElement>(".qcard:not(.answered)") ?? [])].at(-1);
    if (!form) return;
    form.scrollIntoView({ block: "center", behavior: "smooth" });
    form.classList.remove("attn-flash");
    void form.offsetWidth;
    form.classList.add("attn-flash");
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
        : ticket.slotWait ? "queued · starts when the other ticket is done with the folder" : "The board restarts soon; your message is sent right after (at most 10 minutes)."}</div>
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
      <div className="chat-log" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = gapOf(el);
          const movedUp = el.scrollTop < lastTop.current - 2;
          stickToBottom.current = stickAfterScroll({ gap, stuck: stickToBottom.current, movedDown: el.scrollTop > lastTop.current });
          lastTop.current = el.scrollTop;
          lastGap.current = gap;
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
            {ticket.status === "backlog" ? (
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
          return (
            <Fragment key={first.uuid}>
              {helpAt.get(i)?.map((c) => <HelpCardView key={c.id} card={c} />)}
              {notesAt.get(i)?.map((nt) => <StatusNoteView key={nt.at} text={nt.text} />)}
              {resultsAt.get(i)?.map((r) => <ResultCardView key={`${r.ticketId}-${r.at}`} r={r} onOpenTicket={onOpenTicket} />)}
              {sideView(i)}
              {i === dividerAt && divider}
              {layout[i].divider && <TimeDivider label={layout[i].divider!} />}
              {renderBlock(b, before(first, bp?.at), layout[i], b.kind === "tools" ? i === blocks.length - 1 : i === newestReply)}
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
            <div className="reply-text"><Markdown text={ticket.interrupted.partial} /></div>
          </Turn>
        )}
        {waitingHandoff.map((h) => (
          <Turn key={h.at} start={tailStart()} className="live">
            {liveView(h.text).text && <div className="reply-text"><Markdown text={liveView(h.text).text} /></div>}
            {liveView(h.text).preparing && <div className="working-row preparing"><ClaudeFace mood="working" size={24} /> <span>{liveView(h.text).preparing}</span></div>}
          </Turn>
        ))}
        {live && (
          <Turn start={tailStart()} className="live">
            <div aria-live="polite">
              {liveView(live).text && <div className="reply-text writing"><Markdown text={liveView(live).text} /></div>}
              {liveView(live).preparing && <div className="working-row preparing"><ClaudeFace mood="working" size={24} /> <span>{liveView(live).preparing}</span></div>}
            </div>
          </Turn>
        )}
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
      <div className="composer">
        <textarea ref={composer} rows={phone ? 1 : 2} value={draft} disabled={stopping} className={images.dragOver ? "drop-target" : undefined} {...images.handlers}
          placeholder={formWaiting && !running ? `Or type a note to ${claude}…` : phone
            ? running ? `Steer ${claude}…` : refine ? "Describe your idea…" : `Ask ${claude}…`
            : running ? `Steer ${claude}: it reads this at its next step, no restart…` : refine ? `Describe your idea or answer ${claude}…` : `Ask ${claude} to change or continue something…`}
          onChange={(e) => setDraft(e.target.value)}
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
        {images.error && <div className="form-error">{images.error}</div>}
        {asking && old && (
          <div className="old-chat-ask" role="alert" title={old.title}>
            <span>{old.ask}</span>
            <button className="btn primary small" onClick={submit}>Send anyway</button>
            <button className="btn small" onClick={sendFresh}>Send in a fresh chat</button>
          </div>
        )}
        {/* One row: + (photo, file; on a phone also snippet, skill and the old-chat line), the Context ring, then Send. */}
        <div className="composer-foot one-row">
          <ImagePickButton images={images} target={composer} disabled={stopping} merged extra={phone ? plusExtras : undefined} />
          <ContextChip slug={slug} kind="ticket" id={ticket.id} openRequest={Math.max(contextRequest, contextLocal)} />
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
              send={<button className={`btn small${draft.trim() ? " primary" : ""}`} disabled={!draft.trim() || stopping || images.uploading} onClick={submit}>{images.uploading ? "Uploading…" : "Send"}<KeyHint keys="↵" /></button>} />
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
