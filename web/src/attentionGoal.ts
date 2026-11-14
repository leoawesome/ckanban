import type { DrawerTab } from "./keynav";

/**
 * Where "Your turn" leads in the ticket panel: the tab to open, what to scroll to and highlight there (the first
 * selector that matches; its newest match), and the main button's words.
 */
export interface AttentionGoal {
  button: string;
  tab: DrawerTab;
  targets: string[];
  /**
   * "ask": before the targets, look for Claude's latest reply that asks the user something (pickAsk), then the
   * feature status's saved "Waiting on you" line; the targets are the last fallback.
   */
  find?: "ask";
}

/** The thing to do for a ticket that waits on the user, or null when there is nothing to lead to. */
export function attentionGoal(att: { kind: string; label: string } | null | undefined, t: { capHit?: unknown } = {}): AttentionGoal | null {
  if (!att) return null;
  switch (att.kind) {
    case "questions":
      return { button: att.label === "Answer Claude" ? "Answer Claude" : "Answer questions", tab: "chat", targets: [".qcard:not(.answered)", ".task-card", ".reply-text"] };
    case "proposal":
      return { button: att.label, tab: "chat", targets: [".proposal:not(.applied)", ".reply-text"] };
    case "blocked":
      if (att.label === "Plan stuck") return { button: "Open plan", tab: "family", targets: [".plan-waiting", ".plan-reason", ".plan-panel"] };
      if (t.capHit) return { button: "See what Claude needs", tab: "chat", targets: [".cap-banner", ".reply-text"] };
      return { button: "See what Claude needs", tab: "chat", targets: [".reply-text", ".conv-msg"], find: "ask" };
    case "failed":
      return { button: "See what went wrong", tab: "chat", targets: [".reply-text", ".conv-msg"] };
    case "huddle":
      return { button: "Open huddle", tab: "huddle", targets: [".huddle-close-ask", ".for-you", ".hd-banner"] };
    default:
      return null;
  }
}

/** Phrases that ask the user to act even without a question mark ("Let me know which one", "Please confirm"). */
const ASK_WORDS = /\b(let me know|please (confirm|choose|pick|reply|approve|decide|answer|check|tell me|send|share)|tell me (which|whether|if|what)|(say|reply) (yes|go|with)|your call|i need (you|your)|do you want|would you like|which (one|option) do you)\b/i;

/**
 * Whether one of Claude's replies asks the user something: a sentence ending in "?" (not inside quotes or code), a
 * bold line that asks, or an ask phrase such as "let me know". text: the reply's words without code blocks; bold: the
 * text of its bold parts. A status note ("the fix is waiting for your go-ahead.") doesn't count.
 */
export function asksUser(text: string, bold: string[] = []): boolean {
  // Quoted words are examples, not questions to the user: 'it would ask "is that your size?"'.
  const plain = text.replace(/`[^`]*`/g, " ").replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, " ");
  if (/\?(?=[\s)\]*_]*(\s|$))/.test(plain)) return true;
  if (bold.some((b) => /\?\s*$/.test(b.trim()) || ASK_WORDS.test(b))) return true;
  return ASK_WORDS.test(plain);
}

/** How many of Claude's newest replies pickAsk looks at, so a long chat stays fast. */
export const ASK_LOOKBACK = 15;

/**
 * The chat item "See what Claude needs" lands on: the newest of Claude's replies that asks the user something, among
 * the replies since the user's last message (an earlier question was already answered) and at most the newest
 * ASK_LOOKBACK of them. items: the chat in order, newest last. -1 when none asks.
 */
export function pickAsk(items: ({ user: true } | { text: string; bold?: string[] })[], lookback = ASK_LOOKBACK): number {
  let seen = 0;
  for (let i = items.length - 1; i >= 0 && seen < lookback; i--) {
    const it = items[i];
    if ("user" in it) return -1;
    seen++;
    if (asksUser(it.text, it.bold)) return i;
  }
  return -1;
}
