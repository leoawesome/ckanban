import { useEffect, useRef, useState, type ReactNode } from "react";
import { copy } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { stepsSummary } from "./chatTurns";
import { CheckIcon, CopyIcon } from "./icons";
import { AvatarFace, useAvatar, useClaudeName } from "./AvatarFace";
import type { AvatarMood } from "./avatarLook";
import { liveLine, runMood } from "./avatarMood";
import { elapsed, fullTime, timeAgo } from "./time";
import { toast } from "./toast";

/**
 * The chat's message layout, shared by the ticket chat and quick chats (Claude panel, phone Ask tab): a turn is an
 * avatar and a "Claude · 3m ago" name line, then the replies, steps lines and cards under it. Rows that continue a
 * turn show no avatar or name (screen readers still hear the name).
 */

/** Claude's face (the user's saved choice or the default robot); a turn's avatar rests (idle). */
export function ClaudeFace({ mood = "idle", size }: { mood?: AvatarMood; size: number }) {
  return <AvatarFace look={useAvatar("claude")} mood={mood} size={size} />;
}

/** Claude's avatar at the start of its turn: its face, at rest (the working row below shows what it is doing). */
export function ClaudeAvatar() {
  return <span className="turn-av claude" aria-hidden><ClaudeFace size={36} /></span>;
}

/** A letter avatar (another ticket, later a teammate): colour from `seed`, so it stays the same everywhere. */
export function LetterAvatar({ seed, name }: { seed: string; name: string }) {
  return <span className="turn-av" style={{ background: avatarColor(seed) }} aria-hidden>{avatarLetter(name)}</span>;
}

export function Turn({ start, avatar = <ClaudeAvatar />, name: given, sub, at, className, children }: {
  /** First row of the turn: shows the avatar and the name line. */
  start: boolean;
  avatar?: ReactNode;
  /** Missing: Claude, under the name the user gave it (useClaudeName). */
  name?: ReactNode;
  /** After the name, e.g. "from another ticket". */
  sub?: ReactNode;
  at?: string;
  className?: string;
  children: ReactNode;
}) {
  const claude = useClaudeName();
  const name = given ?? claude;
  return (
    <div className={`turn${start ? " start" : ""}${className ? ` ${className}` : ""}`}>
      {start && avatar}
      {start && (
        <div className="turn-name">
          <b>{name}</b>
          {sub && <span>{sub}</span>}
          {at && <time dateTime={at} title={fullTime(at)}>{timeAgo(at)}</time>}
        </div>
      )}
      <div className="turn-body">
        {!start && typeof name === "string" && <span className="sr-only">{name}:</span>}
        {children}
      </div>
    </div>
  );
}

/** Copies the reply as shown (or a message: label, onCopied); ✓ for a moment after. icon false: words only, "✓ Copied". */
export function CopyButton({ text, label = "Copy this reply", icon = true, onCopied }: {
  text: () => string;
  label?: string;
  icon?: boolean;
  onCopied?: () => void;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className={`act-btn${done ? " copied" : ""}`} aria-label={done ? "Copied" : label}
      onClick={async () => {
        if (!(await copy(text()))) return void toast("Couldn't copy: select the text and copy it instead", { tone: "error" });
        setDone(true);
        onCopied?.();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}>
      {icon ? <>{done ? <CheckIcon size={14} /> : <CopyIcon size={14} />} {done ? "Copied" : "Copy"}</> : done ? "✓ Copied" : "Copy"}
    </button>
  );
}

/**
 * "Copy · Say it simpler" under a reply. On a computer it shows on hover or focus (always on the newest reply); on a
 * phone, under the last reply of each turn. active: something is going on in it (simplifying, simpler version shown).
 */
export function ReplyActions({ text, simpler, newest, lastOfTurn, active }: {
  text: () => string;
  simpler?: ReactNode;
  newest?: boolean;
  lastOfTurn?: boolean;
  active?: boolean;
}) {
  return (
    <div className={`reply-actions${newest ? " newest" : ""}${lastOfTurn ? " last-of-turn" : ""}${active ? " active" : ""}`}>
      <CopyButton text={text} />
      {simpler}
    </div>
  );
}

/** Re-renders every second while `on` (live timers). */
function useSecondTick(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

/**
 * A run of tool calls: one line under the reply, "✓ Did 6 steps · last step" in plain words; click to see each step by its
 * real tool name. While the run is on its last step this is the chat's one live line: Claude's working face, "Step 3 · Running gh"
 * and how long that step has been going.
 */
export function StepsLine({ items, running, activity, old, children }: {
  items: { text: string; error?: true; at?: string }[];
  /** The run is on this step right now: Claude's working face and "Step 4 · …". */
  running: boolean;
  /** The run's live description of the current step ("Running gh"); falls back to the step's plain name. */
  activity?: string | null;
  old?: boolean;
  /** The step list (ToolRows). */
  children: ReactNode;
}) {
  useSecondTick(running);
  const s = stepsSummary(items, running, liveLine(activity, useClaudeName()));
  const since = running ? items.at(-1)?.at : undefined;
  return (
    <details className={`steps-line${old ? " inherited" : ""}${running ? " live" : ""}`}>
      <summary>
        <span className="steps-icon" aria-hidden>{running ? <ClaudeFace mood="working" size={24} /> : <CheckIcon size={14} className="icon steps-ok" />}</span>
        <span className="steps-text" role={running ? "status" : undefined} aria-live={running ? "polite" : undefined}>{s.text}</span>
        {since && <span className="working-time" title={`This step started ${fullTime(since)}`}>· {elapsed(since)}</span>}
        {s.failed > 0 && <span className="steps-failed">· {s.failed} failed</span>}
      </summary>
      {children}
    </details>
  );
}

/**
 * Claude's place while it works: its face (44px, thinking or working), what it is doing and for how long. It takes the
 * whole width under the replies, so it shows no turn avatar or name line of its own (screen readers still hear Claude's name).
 */
export function WorkingRow({ start, activity, startedAt, stalled, children }: {
  start: boolean;
  activity: string | null;
  startedAt?: string | null;
  /** No output for this many minutes: the row turns amber (children: what the user can do). */
  stalled?: number | null;
  children?: ReactNode;
}) {
  const since = startedAt ? elapsed(startedAt) : "";
  const mood = runMood(activity);
  const claude = useClaudeName();
  return (
    <Turn start={false} className={`working${start ? " start" : ""}`}>
      <div className={`working-row${stalled ? " stalled" : ""}`} role="status" aria-live="polite">
        <ClaudeFace mood={mood} size={44} />
        {stalled ? <span>No output for {stalled} min</span>
          : <span className="working-text">{mood === "working" ? activity : liveLine(activity, claude) ?? "Thinking…"}</span>}
        {since && !stalled && <span className="working-time">{since}</span>}
      </div>
      {children}
    </Turn>
  );
}

/** A run that ended with an error, on Claude's side: the first line, Retry and the full text behind Details. */
export function ErrorTurn({ error, onRetry, retryDisabled }: { error: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = error.trim().split("\n")[0].slice(0, 240);
  return (
    <Turn start className="error">
      <div className="error-line" role="alert">
        <span>The run stopped with an error: {first}</span>
        <span className="error-actions">
          {onRetry && <button type="button" className="act-btn" disabled={retryDisabled} onClick={onRetry}>Retry</button>}
          <button type="button" className="act-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Details"}</button>
        </span>
      </div>
      {open && <pre className="error-details">{error}</pre>}
    </Turn>
  );
}

export function TimeDivider({ label }: { label: string }) {
  return <div className="time-divider" role="separator"><span>{label}</span></div>;
}

/** Clicks on Stop this soon after it took Send's place are a double tap on Send, not a stop. */
const STOP_GUARD_MS = 800;

/**
 * The composer's main button: Send, or Stop while Claude works and there is nothing to send. With a draft typed during
 * a run, a small Stop sits next to Send.
 */
export function SendOrStop({ running, hasDraft, stopping, onStop, send }: {
  running: boolean;
  hasDraft: boolean;
  stopping: boolean;
  onStop: () => void;
  /** The Send button. */
  send: ReactNode;
}) {
  const alone = running && !hasDraft;
  const shownAt = useRef(0);
  useEffect(() => {
    if (alone) shownAt.current = Date.now();
  }, [alone]);
  const label = stopping ? "Stopping…" : "Stop";
  if (alone) {
    return (
      <button className="btn danger small stop-btn" disabled={stopping}
        onClick={() => Date.now() - shownAt.current >= STOP_GUARD_MS && onStop()}>
        <span aria-hidden>■</span> {label}
      </button>
    );
  }
  return (
    <>
      {running && (
        <button className="btn danger small stop-btn icon-only" disabled={stopping} onClick={onStop} aria-label={label} title={label}>
          <span aria-hidden>■</span>
        </button>
      )}
      {send}
    </>
  );
}
