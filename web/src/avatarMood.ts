// Which mood an avatar face shows (AvatarFace.tsx), from state the board already has. One place, so every screen agrees:
// running with no tool in progress is thinking, running a tool is working, waiting on the user's answer is waiting,
// finished is done, failed (or stopped with an error) is failed, anything else idle. Where a screen can't tell thinking
// from working, it says working.
import type { AvatarMood } from "./avatarLook";
import type { FamilyState } from "./family";
import type { FinishMark } from "./cardState";

/** The server's live line right after a message is sent (src/server/board.ts THINKING_LINE), and the one tickets
 * saved before it ("Claude is replying…"). Both are a fixed marker: liveLine shows them with the user's name for Claude. */
export const THINKING_LINE = "Claude is thinking…";
const THINKING_LINES = new Set([THINKING_LINE, "Claude is replying…"]);

/** The run has no step yet: it is thinking about its reply (the marker line, old or new). */
export const isThinkingLine = (activity: string | null | undefined): boolean => !!activity && THINKING_LINES.has(activity);

/** A live line as shown: the thinking marker becomes "<name> is thinking…", anything else is shown as it is. */
export function liveLine(activity: string, name: string): string;
export function liveLine(activity: string | null | undefined, name: string): string | null;
export function liveLine(activity: string | null | undefined, name: string): string | null {
  if (!activity) return activity ?? null;
  return isThinkingLine(activity) ? `${name} is thinking…` : activity;
}

/** Live lines that aren't a tool step: the run is starting, thinking or stopping. Shown quietly (no step line on cards). */
export const isQuietLine = (activity: string | null | undefined): boolean => !!activity && (activity === "Starting…" || activity === "Stopping…" || isThinkingLine(activity));

/** A running ticket or chat: working while its live line names a step ("Running gh"), else thinking. */
export function runMood(activity: string | null | undefined): AvatarMood {
  return activity && !isQuietLine(activity) ? "working" : "thinking";
}

/** The word a running card shows next to the face ("Thinking 12s", "Working 48s"), so the two moods read apart. */
export function runWord(mood: AvatarMood): string {
  return mood === "working" ? "Working" : "Thinking";
}

/** Kinds of "your turn" where Claude waits on the user's answer (not a failure, a limit or work to check). */
const WAITS_ON_YOU = new Set(["questions", "proposal", "reply", "huddle", "blocked"]);

/** A card waiting on the user: Claude's waiting face stays next to the "your turn" words; null for the other kinds. */
export function attentionMood(kind: string): AvatarMood | null {
  return WAITS_ON_YOU.has(kind) ? "waiting" : null;
}

/** The mark a run leaves for a moment when it ends (Card.tsx useFinishMark): done, failed, or waiting when it stopped for the user. */
export function finishMood(m: Pick<FinishMark, "tone">): AvatarMood {
  return m.tone === "ok" ? "done" : m.tone === "failed" ? "failed" : "waiting";
}

/** A huddle participant. The user is always idle (their face is a person, not a state). */
export function participantMood(p: { kind?: string | null; status?: string | null; lastActivity?: string | null; error?: string | null }, closed = false): AvatarMood {
  if (p.kind === "human") return "idle";
  switch (p.status) {
    case "working": return closed ? "idle" : p.lastActivity ? "working" : "thinking";
    case "failed": return "failed";
    case "stopped": return p.error ? "failed" : "idle";
    case "blocked": return closed ? "idle" : "waiting";
    case "done": return "done";
    default: return "idle";
  }
}

/** A subagent or workflow row: thinking until its first step runs. */
export function agentMood(status: string, current?: string | null): AvatarMood {
  switch (status) {
    case "running": return current ? "working" : "thinking";
    case "done": return "done";
    case "failed": return "failed";
    default: return "idle";
  }
}

/** A row in a feature's Tasks list (the list knows the state, not whether a tool runs: working). */
export function familyMood(st: FamilyState): AvatarMood {
  switch (st) {
    case "working": return "working";
    case "needs_you": case "in_review": return "waiting";
    // A test that found a problem still finished its work: the row's words say what it found.
    case "done": case "passed": case "problem": return "done";
    case "failed": return "failed";
    default: return "idle";
  }
}
