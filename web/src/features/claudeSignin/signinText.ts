import type { ClaudeSignInStatus } from "../../lib/api/types/claudeSignin";

export type Strip = { tone: "warn" | "err"; text: string };

/** The strip at the top of the board: yellow a few days before Claude's sign-in runs out, red once it is signed out. */
export function stripOf(s: ClaudeSignInStatus | null | undefined): Strip | null {
  if (!s?.checked) return null;
  if (s.warning === "signed-out") return { tone: "err", text: "Claude is signed out, so tasks can't run." };
  if (s.warning !== "expiring") return null;
  const d = s.daysLeft ?? 0;
  const when = d <= 0 ? "today" : d === 1 ? "in 1 day" : `in ${d} days`;
  return { tone: "warn", text: `Claude's sign-in on your Mac runs out ${when}.` };
}

/** A pasted code must be whole: Claude's codes have a # in the middle. Null when it looks right. */
export function codeProblem(code: string): string | null {
  const c = code.trim();
  if (!c) return "Paste the code first.";
  if (!c.includes("#") || /\s/.test(c)) return "That isn't the whole code. Copy all of it, including the # in the middle.";
  return null;
}
