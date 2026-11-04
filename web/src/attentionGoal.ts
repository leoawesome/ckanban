import type { DrawerTab } from "./keynav";

/**
 * Where "Your turn" leads in the ticket panel: the tab to open, what to scroll to and highlight there (the first
 * selector that matches; its newest match), and the main button's words.
 */
export interface AttentionGoal {
  button: string;
  tab: DrawerTab;
  targets: string[];
}

/** The thing to do for a ticket that waits on the user, or null when there is nothing to lead to. */
export function attentionGoal(att: { kind: string; label: string } | null | undefined, t: { capHit?: unknown } = {}): AttentionGoal | null {
  if (!att) return null;
  switch (att.kind) {
    case "questions":
      return { button: att.label === "Answer Claude" ? "Answer Claude" : "Answer questions", tab: "chat", targets: [".qcard:not(.answered)", ".reply-text"] };
    case "proposal":
      return { button: att.label, tab: "chat", targets: [".proposal:not(.applied)", ".reply-text"] };
    case "blocked":
      if (att.label === "Plan stuck") return { button: "Open plan", tab: "family", targets: [".plan-waiting", ".plan-reason", ".plan-panel"] };
      if (t.capHit) return { button: "See what Claude needs", tab: "chat", targets: [".cap-banner", ".reply-text"] };
      return { button: "See what Claude needs", tab: "chat", targets: [".reply-text", ".conv-msg"] };
    case "failed":
      return { button: "See what went wrong", tab: "chat", targets: [".reply-text", ".conv-msg"] };
    case "huddle":
      return { button: "Open huddle", tab: "huddle", targets: [".huddle-close-ask", ".for-you", ".hd-banner"] };
    default:
      return null;
  }
}
