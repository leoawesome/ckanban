import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RewindResult, RewindUndoState, UndoRewindResult } from "./api";
import { CopyButton } from "./ConvTurn";
import { copyText, forkPoints, forkTitle, rewoundLine, undoneLine } from "./messageText";
import { RewindConfirm, type RewindPreview } from "./Rewind";
import { sentTime } from "./time";

/** Rewind on a message: what the confirmation asks first and what going back does. */
export interface RewindSpec {
  /** Messages after this one that would be removed. */
  later: number;
  preview: () => Promise<RewindPreview>;
  apply: (files: boolean) => Promise<RewindResult>;
  onDone: (r: RewindResult) => void;
}

/** Fork from here: the chat's title (for "<title> (fork)") and the call that makes and opens the fork. */
export interface ForkSpec {
  title: string;
  /** A quick chat: the fork is a new chat, not a new ticket. */
  chat?: boolean;
  /** Makes the fork, fills its box and opens it; resolves to what is announced. */
  run: () => Promise<string>;
}

/**
 * One of the user's messages: the bubble, then a row under it with the sent time, Copy, Fork from here and Rewind
 * (on a computer the buttons show on hover or focus; on a phone always). Fork and Rewind open their confirmation under
 * the row. sending: not in the chat yet, the row says "sending" and has no buttons.
 */
export function UserMessage({ at, text, sending, className, bubbleClass, off, fork, rewind, onError, children }: {
  at?: string;
  /** What Copy copies (pasted images become "[image]"). */
  text: string;
  sending?: boolean;
  className?: string;
  bubbleClass?: string;
  /** Why Fork and Rewind are off now (a run is going), or null. */
  off: string | null;
  fork?: ForkSpec;
  rewind?: RewindSpec;
  onError: (m: string) => void;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<"fork" | "rewind" | null>(null);
  const [said, setSaid] = useState("");
  const sayTimer = useRef<ReturnType<typeof setTimeout>>();
  const forkBtn = useRef<HTMLButtonElement>(null);
  const rewindBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(sayTimer.current), []);
  useEffect(() => {
    if (off) setPanel(null);
  }, [off]);
  const say = (m: string) => {
    setSaid(m);
    clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(""), 4000);
  };
  const close = () => {
    const back = panel === "fork" ? forkBtn.current : rewindBtn.current;
    setPanel(null);
    back?.focus();
  };
  const time = at ? sentTime(at) : null;
  return (
    <div className={`me-wrap user-msg${panel ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <div className={`conv-msg user${bubbleClass ? ` ${bubbleClass}` : ""}`}>{children}</div>
      <div className="me-actions">
        {sending ? <span className="msg-time">sending</span> : (
          <>
            {time?.text && <time className="msg-time" dateTime={at} title={time.title}>{time.text}</time>}
            <CopyButton text={() => copyText(text)} label="Copy this message" icon={false} onCopied={() => say("Copied")} />
            {fork && (
              <button ref={forkBtn} type="button" className="act-btn" disabled={!!off} aria-expanded={panel === "fork"} aria-label="Fork from here"
                title={off ?? (fork.chat ? "Start a new chat from just before this message" : "Start a new ticket from just before this message")}
                onClick={() => setPanel((p) => (p === "fork" ? null : "fork"))}>
                Fork<span className="msg-long"> from here</span>
              </button>
            )}
            {rewind && (
              <button ref={rewindBtn} type="button" className="act-btn" disabled={!!off} aria-expanded={panel === "rewind"} aria-label="Rewind to before this message"
                title={off ?? "Go back to before this message"} onClick={() => setPanel((p) => (p === "rewind" ? null : "rewind"))}>
                ⟲ Rewind
              </button>
            )}
          </>
        )}
        <span className="sr-only" role="status">{said}</span>
      </div>
      {panel === "fork" && fork && <ForkConfirm fork={fork} onClose={close} onError={onError} onDone={say} />}
      {panel === "rewind" && rewind && (
        <RewindConfirm later={rewind.later} preview={rewind.preview} onClose={close}
          onError={(m) => {
            setPanel(null);
            onError(m);
          }}
          apply={async (files) => {
            const r = await rewind.apply(files);
            setPanel(null);
            rewind.onDone(r);
          }} />
      )}
    </div>
  );
}

/** "Start "<title> (fork)" from here?" with what forking keeps and what it doesn't. */
function ForkConfirm({ fork, onClose, onError, onDone }: { fork: ForkSpec; onClose: () => void; onError: (m: string) => void; onDone: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(await fork.run());
      onClose();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rewind-confirm fork-confirm" role="group" aria-label="Fork from here" onKeyDown={(e) => e.key === "Escape" && !busy && (e.stopPropagation(), onClose())}>
      <b>Start "{forkTitle(fork.title)}" from here?</b>
      <ul>{forkPoints(!!fork.chat).map((p) => <li key={p}>{p}</li>)}</ul>
      <div className="rewind-actions">
        <button type="button" className="btn small primary" disabled={busy} onClick={go}>{busy ? "Forking…" : "Fork"}</button>
        <button type="button" className="btn small" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** The last rewind, while it can be undone: what it took back, and what the box held before it filled it. */
export interface UndoInfo {
  messages: number;
  files: number;
  /** The box's text after the rewind filled it, and before (null: not known, e.g. after a reload). */
  draft: { filled: string; before: string } | null;
}

export const undoFromRewind = (r: RewindResult, filled: string, before: string): UndoInfo =>
  ({ messages: r.messages, files: r.files, draft: { filled, before } });

/** After a reload: the last rewind can still be undone (the chat is as it left it), so the bar shows again. */
export const undoFromState = (s: RewindUndoState): UndoInfo | null =>
  (s.available && !s.blocked ? { messages: s.messages, files: s.files, draft: null } : null);

/**
 * "Rewound: N messages and M files went back." with Undo rewind, under the chat. Stays until the next message, a run or
 * another rewind (the chat clears `info`). Undo may ask to bring back the chat only, when files changed since.
 */
export function UndoBar({ info, off, undo, onUndone, onError }: {
  info: UndoInfo;
  off: string | null;
  /** files false: the chat only. */
  undo: (files: boolean) => Promise<UndoRewindResult>;
  /** Undo worked: say `line`, reload the chat. */
  onUndone: (r: UndoRewindResult, line: string) => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The server refused the files ("… Undo the chat only?"): its words, and the chat-only button.
  const [chatOnly, setChatOnly] = useState<string | null>(null);
  const go = async (files: boolean) => {
    setBusy(true);
    try {
      const r = await undo(files);
      onUndone(r, undoneLine(r, info.files));
    } catch (e: any) {
      const m: string = e.message ?? String(e);
      if (files && /chat only\?$/.test(m)) setChatOnly(m);
      else onError(m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="undo-bar" role="group" aria-label="Undo rewind">
      <span role="status">{chatOnly ?? rewoundLine(info.messages, info.files)}</span>
      <span className="undo-actions">
        {chatOnly ? (
          <>
            <button type="button" className="btn small" disabled={busy || !!off} title={off ?? undefined} onClick={() => go(false)}>{busy ? "Undoing…" : "Undo the chat only"}</button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => setChatOnly(null)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn small" disabled={busy || !!off} title={off ?? "Put back the chat and files as they were just before the rewind"} onClick={() => go(true)}>
            {busy ? "Undoing…" : "Undo rewind"}
          </button>
        )}
      </span>
    </div>
  );
}

/** What the last Undo did, in the bar's place until the next message or run. */
export function UndoneNote({ line, onClose }: { line: string; onClose: () => void }) {
  return (
    <div className="undo-bar done" role="status">
      <span>{line}</span>
      <button type="button" className="btn small ghost" aria-label="Hide this note" onClick={onClose}>OK</button>
    </div>
  );
}
