import { Fragment, useEffect, useMemo, useState } from "react";
import { type SessionEntry, type Ticket } from "../../lib/api";
import { liveLine, runMood } from "../avatar/avatarMood";
import { useClaudeName } from "../avatar/AvatarFace";
import { CopyIcon, DownloadIcon, FileTextIcon, MoreIcon } from "../../components/icons";
import { MoreSheet } from "../../app/PhoneNav";
import { replyText } from "../ticket/simplifyText";
import { ClaudeFace } from "./ConvTurn";
import { wakeLabel } from "./chatTurns";
import { commandNote, messageCommand, type SlashCommand } from "./slashText";
import { norm } from "../../lib/pendingBubbles";
import { baseName, dirName } from "../../lib/share";
import { repeatsForm } from "../ticket/questionForms";
import { elapsed, fullTime, timeAgo } from "../../lib/time";
import { stepsLine, stepsLineText, stepsWorking } from "../ticket/stepsLive";
import { Markdown } from "./Transcript";
import { usePhone } from "../../hooks/usePhone";

/** File cards shown under one reply; the rest are in the Outputs tab. */
const MAX_FILE_CARDS = 8;

/** m:ss (h:mm:ss past an hour) since `iso`. */
export function clock(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const mm = String(Math.floor((s % 3600) / 60)), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Claude ended its turn to wait for background tasks; the run stays open and it resumes when they finish. */
export function WaitingCard({ tasks }: { tasks: NonNullable<Ticket["waitingOn"]> }) {
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
export function UserText({ text, commands, command }: { text: string; commands: SlashCommand[] | null; command?: string }) {
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
export function WakeNote({ entry: e, old }: { entry: SessionEntry; old: boolean }) {
  return (
    <details className={`chat-note wake-note${old ? " inherited" : ""}`}>
      <summary>{wakeLabel(e.wake ?? "")}{e.at && <span title={fullTime(e.at)}> · {timeAgo(e.at)}</span>}</summary>
      {e.text && <div className="wake-body"><Markdown text={e.text} /></div>}
    </details>
  );
}

/** tools: a run of tool calls folded into one line; agents: a run of subagent rows. */
export type Block = { kind: "entry"; e: SessionEntry; index: number } | { kind: "tools"; items: SessionEntry[] } | { kind: "agents"; items: SessionEntry[] }
  | { kind: "workflows"; items: SessionEntry[] };

/** Who a block is from, for grouping rows into turns. */
export function speaker(b: Block): string {
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
export const oldChatOk = new Map<string, string>();
/** At most this many tickets in oldChatOk (oldest out): it would otherwise grow with every old chat sent to. */
export const OLD_CHAT_OK_MAX = 200;
/** The message box's footer names an old chat only above this size; smaller ones just get the ask at Send. */
export const OLD_LINE_MIN_TOKENS = 100_000;

export const before = (e: SessionEntry, at: string | undefined) => !!at && !!e.at && e.at < at;

export const CARDS = ["questions", "proposal", "newTickets", "branch", "huddle", "deletion", "scheduleDeletion", "helperRule", "teammate", "squad", "automation", "keys"] as const;

/**
 * Tool calls (and subagents) in a row fold into one block; a branch point (splitAt) starts a new one. A reply that
 * only repeats the questions form just above it in the same run is left out: the form already says it.
 */
export function group(entries: SessionEntry[], splitAt?: string): Block[] {
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

export const HANDOFF_RETRY_MS = 500;
// A sent message shows "sending" until the loaded conversation has it. Live updates normally reload it, but they can
// be missed (a board restart, a daemon frozen on a busy Mac, a dropped connection), so while one waits the chat
// checks again this often on its own.
export const SENDING_RECHECK_MS = 3000;

export const UNREADABLE = { questions: "questions", proposal: "ticket proposal", tickets: "proposed tickets" } as const;

/** What the Resend button sends: the same content again, through the matching tool. */
export const RESEND = {
  questions: "The board couldn't read your questions. Please resend them with the ask_questions tool.",
  proposal: "The board couldn't read your ticket proposal. Please resend it with the propose_ticket tool.",
  tickets: "The board couldn't read your proposed tickets. Please resend them with the propose_tickets tool.",
} as const;

/** What Retry under a failed run sends. */
export const RETRY = "That run stopped with an error. Please try again from where you stopped.";

export const REFINE = (s: Ticket["status"]) => s === "backlog" || s === "planning";

/**
 * The files a reply wrote: one compact row each (name, size, Open; Copy file and Download behind ⋯ on a phone, beside
 * Open on a wider screen). More than two fold into one "N files" row that opens the list.
 */
export function ChatFiles({ files, canCopy, onOpen, onCopy, onDownload }: {
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
export const delivered = (entries: SessionEntry[], text: string) => entries.some((e) => e.role === "user" && norm(e.text) === norm(text));

/** Opening a chat uses the outputs list the ticket panel asked for this recently (outputsOnce.ts). */
export const OPEN_REUSE_MS = 5000;

/** How long the notes beside the conversation wait for the steps' chats and the status after the conversation is in. */
export const SIDE_WAIT_MS = 3000;

/**
 * The ticket's single conversation with Claude, like the terminal: everything in the session
 * (terminal chat, board runs, messages typed here) in one timeline, plus a box to send more.
 */
/** Stop Claude with instant feedback: "Stopping…" from the click until the run is gone. */
/**
 * A main ticket's live "Working: <step>" line while steps of its feature (or tickets the user added) work; each name
 * opens that step. One working step also shows its latest activity and how long it has run.
 */
export function StepsWorking({ ticket, tickets, onOpenTicket }: { ticket: Ticket; tickets: Ticket[]; onOpenTicket: (id: string) => void }) {
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
