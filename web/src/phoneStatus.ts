import { COLUMNS, waitsForSlot, type Status } from "./columns";
import { HUDDLE_WORKING, type FinishMark } from "./cardState";
import type { AvatarMood } from "./avatarLook";
import { runMood } from "./avatarMood";

/** The colour of the phone header's status button. */
export type StatusTone = "ok" | "warn" | "err" | "info" | "neutral";

export interface PhoneStatus {
  label: string;
  tone: StatusTone;
  /** A run is going: the dot spins. */
  busy?: boolean;
  /** Claude's own run (not a huddle's): its face in this mood in place of the spinning dot, as on the desktop pill. */
  mood?: AvatarMood;
  /** The just-finished mark (✓, ✕ or !) shown in place of the dot. */
  icon?: string;
}

/** The ticket fields the status reads (kept free of api.ts so tests can import it). */
interface StatusTicket {
  status: Status;
  outcome?: string | null;
  running?: boolean;
  error?: string | null;
  slotWait?: { at: string } | null;
  huddleBusy?: boolean;
  autoHuddle?: { state?: string } | null;
  lastActivity?: string | null;
}

const columnLabel = (s: Status) => COLUMNS.find((c) => c.id === (s === "ready" ? "in_progress" : s))?.label ?? s;

export const attTone = (kind: string): StatusTone => (kind === "failed" || kind === "blocked" ? "err" : kind === "review" ? "ok" : "warn");

/**
 * The one label and colour a phone's ticket header shows on its status button, which also moves the ticket.
 * Same order as the desktop header: the just-finished mark, then "Your turn" (its reason), then the run's outcome,
 * else the column name in grey.
 */
export function phoneStatus(t: StatusTicket, finish: FinishMark | null, att: { kind: string; label: string } | null): PhoneStatus {
  if (finish) return { label: finish.label, tone: finish.tone === "failed" ? "err" : finish.tone, icon: finish.icon };
  if (att) return { label: att.kind === "limit" ? "Limit hit" : att.label, tone: attTone(att.kind) };
  const column = { label: columnLabel(t.status), tone: "neutral" as const };
  if (t.huddleBusy) return { label: HUDDLE_WORKING, tone: "info", busy: true };
  if (t.autoHuddle && !t.running) return t.autoHuddle.state === "waiting" ? { label: "Waiting for huddle", tone: "warn" } : { label: "Auto huddle", tone: "info", busy: true };
  if (waitsForSlot({ id: "", order: 0, ...t })) return { label: "Queued", tone: "warn" };
  if (t.status === "in_progress") return { label: "Running", tone: "info", busy: true, mood: runMood(t.lastActivity) };
  if (t.running) return { label: "Replying", tone: "info", busy: true, mood: runMood(t.lastActivity) };
  if (t.error?.startsWith("corrupt")) return { label: "Corrupt file", tone: "err" };
  if (t.status === "done") return column;
  switch (t.outcome) {
    case "blocked": return { label: "Blocked", tone: "warn" };
    case "needs_input": return { label: "Needs your input", tone: "warn" };
    case "failed": return { label: "Failed", tone: "err" };
    case "stopped": return { label: "Stopped", tone: "neutral" };
    case "limit": return { label: "Limit hit", tone: "warn" };
    case "done": return t.status === "review" ? { label: "Ready for review", tone: "ok" } : column;
    default: return column;
  }
}

/** "Answer 2 questions" as the reason after "Your turn ·": lower case first, and Review in plain words. */
export function turnReason(att: { kind: string; label: string } | null, limitLabel = ""): string {
  if (!att) return "";
  if (att.kind === "review") return "review the result";
  const label = att.kind === "limit" ? limitLabel : att.label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}
