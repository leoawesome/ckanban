import { type McpState, type Profile, type Schedule, type Ticket } from "../lib/api";
import { toast } from "../components/toast";
import { hasOpenPr } from "../features/board/boardStats";

export const LAST_PROFILE = "ckanban.profile";
/** Board slug the sample ticket is offered on, until it is started or dismissed. */
export const SAMPLE_OFFER = "ckanban.sample-offer";

/** Board filter chips; several on = tickets matching any of them. */
export const NO_VIA = new Map<string, string>();
export const sameMap = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

export const FILTERS = [
  { id: "you", label: "Needs you", test: (t: Ticket) => !!t.attention },
  { id: "running", label: "Running", test: (t: Ticket) => t.status === "in_progress" || !!t.running },
  // Only shown while a ticket on the board has one (a plain folder never does).
  { id: "pr", label: "Review link", test: hasOpenPr },
] as const;
export type FilterId = (typeof FILTERS)[number]["id"];

export const DISMISSED = "ckanban.dismissedBanners";
export function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED) ?? "[]"));
  } catch {
    return new Set();
  }
}

export const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Background load: retry once after a few seconds, then say so (quietly) instead of failing silently. */
/** The Inbox's safety reload while the page is shown (live updates may miss a main ticket's change). */
export const INBOX_SAFETY_MS = 60_000;
/** Least time between two live-update reloads of the Inbox (see refreshInboxSoon). */
export const INBOX_GAP_MS = 3000;

export function quiet<T>(load: () => Promise<T>, what: string, set: (v: T) => void) {
  load().then(set).catch(() => {
    setTimeout(() => load().then(set).catch(() => toast(`Couldn't load ${what}. It will retry when the connection comes back.`, { tone: "error" })), 3000);
  });
}

export function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

/**
 * The one-time offer to set up proactive check-ins: what Claude could check (e.g. "Slack and Linear"), when a connected
 * Claude server for messages, issues, code or a calendar exists, the board has no check-in schedule yet and the user
 * hasn't dismissed it. Null: don't offer.
 */
export function checkinOffer(profile: Profile, mcp: McpState | null, schedules: Schedule[] | null): string | null {
  if (profile.checkinOfferDismissed || !mcp || !schedules) return null;
  if (schedules.some((s) => s.quiet || s.tags?.includes("check-in"))) return null;
  const found: string[] = [];
  for (const [re, name] of [[/slack/i, "Slack"], [/linear/i, "Linear"], [/github/i, "GitHub"], [/gmail/i, "Gmail"], [/calendar/i, "your calendar"]] as const) {
    if (mcp.servers.some((x) => x.status === "connected" && re.test(x.name)) && !found.includes(name)) found.push(name);
  }
  if (!found.length) return null;
  return found.length === 1 ? found[0] : `${found.slice(0, -1).join(", ")} and ${found.at(-1)}`;
}
