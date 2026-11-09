// How a card shows its state: which "Your turn" dots pulse, sign-in errors, the mark a finished run leaves.
// No imports from ./api: the server's tests import this file, and api.ts needs the browser's types.
interface AttentionLike { kind: string; since: string }

/** Kinds where Claude is stopped until you act. Review and proposals can wait, so they never pulse. */
const URGENT: ReadonlySet<string> = new Set(["questions", "blocked", "failed", "limit", "stalled"]);
/** How long a new urgent item keeps pulsing. */
export const FRESH_MS = 30 * 60_000;

/**
 * Pulse only an urgent item that became your turn in the last 30 minutes and that you haven't opened since.
 * openedAt: when you last opened the ticket (ISO), if ever.
 */
export function shouldPulse(att: AttentionLike | null | undefined, now: number, openedAt?: string | null): boolean {
  if (!att || !URGENT.has(att.kind)) return false;
  const since = Date.parse(att.since);
  if (!Number.isFinite(since) || now - since > FRESH_MS) return false;
  return !(openedAt && Date.parse(openedAt) >= since);
}

// When each ticket was last opened, kept in this browser.
const KEY = "ck-opened";
const MAX = 300;
let cache: Record<string, string> | null = null;
function load(): Record<string, string> {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) || "{}") ?? {}; } catch { cache = {}; }
  return cache!;
}
export function openedAt(id: string): string | null {
  return load()[id] ?? null;
}
export function markOpened(id: string, at = new Date().toISOString()) {
  const all = load();
  all[id] = at;
  const ids = Object.keys(all);
  if (ids.length > MAX) for (const old of ids.sort((a, b) => all[a].localeCompare(all[b])).slice(0, ids.length - MAX)) delete all[old];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: stays in memory */ }
}

/** Claude Code's own sign-in errors, which arrive as if they were Claude's last message. */
const SIGN_IN = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;
export function signInError(text: string | null | undefined): boolean {
  return !!text && SIGN_IN.test(text);
}

export type FinishMark = { icon: "✓" | "✕" | "!"; tone: "ok" | "failed" | "warn"; label: string };
/** The mark a run leaves for a moment when it ends: ✓ finished, ✕ failed, ! stopped and needs you. */
export function finishMark(t: { outcome?: string | null }): FinishMark {
  switch (t.outcome) {
    case "failed": return { icon: "✕", tone: "failed", label: "Failed" };
    case "blocked": case "needs_input": case "limit": case "stopped": return { icon: "!", tone: "warn", label: "Stopped" };
    default: return { icon: "✓", tone: "ok", label: "Finished" };
  }
}

/** Chips shown before the rest fold into "+N". */
export const MAX_EXTRA_CHIPS = 2;
/** Split extra chips into the ones shown and how many fold away. */
export function foldChips<T>(chips: T[], max = MAX_EXTRA_CHIPS): { shown: T[]; more: number } {
  if (chips.length <= max) return { shown: chips, more: 0 };
  return { shown: chips.slice(0, max), more: chips.length - max };
}

/** After this long without a new step, a running card says it has gone quiet (the stall watchdog takes over at 20m). */
export const QUIET_MS = 3 * 60_000;

/**
 * How long ago the run's last step was, for the card's activity line: "4s", "2m", and quiet once 3 minutes pass.
 * Null without a time.
 */
export function stepAge(lastActivityAt: string | null | undefined, now: number): { text: string; quiet: boolean } | null {
  const at = lastActivityAt ? Date.parse(lastActivityAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return { text, quiet: now - at >= QUIET_MS };
}

/** A main card's family summary, as far as these rules go (main-ticket.ts FamilyCard). */
interface FamilyLike { tools: number; toolsDone?: number; running: string[]; working?: string[] }

/** Every family ticket working now (tool tickets and tickets the user added); older servers sent tool tickets only. */
export const familyWorkingNames = (f: FamilyLike): string[] => f.working ?? f.running;

interface CardLike<F extends FamilyLike, A extends { kind: string }> {
  status: string; main?: boolean; running?: boolean; attention?: A | null; familyCard?: F | null; stepsRunning?: number;
}

/**
 * A main ticket's feature works (a family ticket runs) while its own run doesn't: its own last outcome (Stopped, Failed,
 * Blocked) is stale then, so the card and the panel header hide that pill. One rule for both so they can't drift.
 */
export function featureBusy(t: { main?: boolean; running?: boolean; familyCard?: FamilyLike | null }): boolean {
  const f = t.main ? t.familyCard ?? null : null;
  return !!f && familyWorkingNames(f).length > 0 && !t.running;
}

/**
 * How a card shows its feature. ownWorking: its own run works. fc: the family summary a main card shows (with a step,
 * or a ticket of its feature working). familyWorks: a ticket of its feature works and the card isn't parked in Backlog
 * or Done, or one of its steps runs there (columns.ts familyBusy): the blue stripe and working line, no "Your turn" strip and no "D done" hint.
 */
export function cardFamily<F extends FamilyLike, A extends { kind: string }>(t: CardLike<F, A>, ownWorking: boolean) {
  const f = t.main ? t.familyCard ?? null : null;
  const fc = f && (f.tools >= 1 || familyWorkingNames(f).length > 0) ? f : null;
  const busy = featureBusy(t);
  const familyWorks = busy && ((t.status !== "done" && t.status !== "backlog") || !!t.stepsRunning);
  const working = ownWorking || familyWorks;
  // While its feature works it isn't the user's turn to check a result; strips that need the user stay.
  const att = familyWorks && (t.attention?.kind === "review" || t.attention?.kind === "reply") ? null : t.attention ?? null;
  return { fc, busy, familyWorks, working, att, doneHint: t.status === "review" && !working };
}

/** Progress in words on the main card: "7 of 16 tasks" (finished tool tickets of all of them). */
export function stepsText(f: FamilyLike): string {
  return `${f.toolsDone ?? 0} of ${f.tools} task${f.tools === 1 ? "" : "s"}`;
}

/**
 * The card's attention strip label: "Task failed" when a failed step put it there, "Needs you · n" for steps waiting
 * on the user, "Needs you" while the feature still works (never "Your turn" then), else "Your turn".
 */
export function attentionLabel(att: { kind: string; step?: string }, stepsWaiting: number, familyWorks: boolean): string {
  if (att.kind === "failed" && att.step === "failed") return "Task failed";
  if (stepsWaiting > 0) return `Needs you · ${stepsWaiting}`;
  return familyWorks ? "Needs you" : "Your turn";
}

/** The card's muted line names the steps only while some are done and some aren't (not at 0, not when all are done). */
export function stepsShown(f: FamilyLike): boolean {
  const done = f.toolsDone ?? 0;
  return f.tools > 0 && done > 0 && done < f.tools;
}

/** The card's cost turns red when the ticket's last run stopped at its per-run spending cap (the cap is per run,
 *  so the total of all runs is never compared with it). A new run clears capHit. */
export function overCap(t: { capHit?: { capUsd: number; at: string } | null }): boolean {
  return !!t.capHit;
}

/** Cards in Backlog and Done skip the "Claude: …" preview (parked or finished, nothing to follow). */
export function previewShown(column: string): boolean {
  return column !== "backlog" && column !== "done";
}

/** A ticket's own huddle at work (http.ts huddleLine): helpers working now and in the huddle, and its open findings. */
export interface HuddleLine { working: number; helpers: number; findings: number }

/** The short label a working huddle gets where there is room for one word or two: the phone status and the panel header. */
export const HUDDLE_WORKING = "Huddle working";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The card's huddle line: "Huddle: 6 helpers working, 4 findings so far", or "2 of 6 helpers working" when only some
 * are mid-reply. With nobody mid-reply yet (a wake on its way), it counts the helpers in the huddle.
 */
export function huddleLineText(h: HuddleLine): string {
  const helpers = Math.max(h.helpers, h.working);
  const who = h.working > 0 && h.working < helpers ? `${h.working} of ${helpers} helpers working` : `${plural(helpers || 1, "helper")} working`;
  return `Huddle: ${who}${h.findings > 0 ? `, ${plural(h.findings, "finding")} so far` : ""}`;
}

/**
 * The huddle line a card shows, or null: only while its huddle works, its own run doesn't, nothing needs the user and
 * no feature line takes the spot. The card then gets the blue stripe of a working card.
 */
export function cardHuddleLine(t: { huddleBusy?: boolean; huddleLine?: HuddleLine | null }, o: { working: boolean; needsYou: boolean }): string | null {
  if (!t.huddleBusy || o.working || o.needsYou) return null;
  return huddleLineText(t.huddleLine ?? { working: 0, helpers: 0, findings: 0 });
}
