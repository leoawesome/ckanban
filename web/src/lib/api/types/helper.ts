export type AttentionKind = "stalled" | "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";
/** Why a ticket needs you (one server rule for cards, counts and the Inbox); since: when it started waiting. */
export interface Attention {
  kind: AttentionKind;
  label: string;
  since: string;
  /** On a main ticket: it comes from this kind of step wait ("failed": the card says "Step failed"). */
  step?: "questions" | "failed" | "blocked" | "limit";
}

/** What the user did with a suggested helper line: added (already: it was in the list) or Not now. */
export interface HelperRuleCardState {
  state: "added" | "dismissed";
  at: string;
  text?: string;
  already?: boolean;
}

/** A device that turned phone notifications on (src/server/push.ts). */
export interface PushDevice {
  id: string;
  label: string;
  createdAt: string;
}

/** A device the board removed because it stopped accepting notifications (until it is turned on again). */
export interface DroppedPushDevice {
  id: string;
  label: string;
  at: string;
}

/** "Needs you" notifications (src/server/notify.ts): webhook (ntfy or JSON), macOS banner, per-kind toggles. */
export type NotifyKind = "stalled" | "questions" | "proposal" | "review" | "failed" | "limit" | "blocked" | "huddle" | "reply" | "message";
export interface NotifyState {
  webhookUrl: string;
  format: "auto" | "ntfy" | "json";
  mac: boolean;
  kinds: Record<NotifyKind, boolean>;
  lastSentAt: string | null;
  lastError: string | null;
  /** A browser on this Mac gets notifications: they replace the macOS banner. */
  macBrowser: boolean;
  /** This request came from this Mac, not phone access: only the Mac turns Telegram messages back on or pairs. */
  local?: boolean;
  /** The helper groups routine waits and interrupts only for urgent ones (Settings → Helper). */
  helper: boolean;
  /** The phone push channel. */
  push: boolean;
  /** The web address channel (ntfy or JSON); the address is kept while it is off. */
  webhookOn: boolean;
  telegram: TelegramState;
  channels: ChannelState[];
  phoneReady: boolean;
  /** "I can only reach you on this Mac" until a phone channel works. */
  reachLine: string | null;
  ntfyTopicSuggestion: string;
  ntfyWarning: string;
  focusHint: string;
}

/** One channel as Settings lists it (src/server/notify.ts ChannelState). */
export interface ChannelState {
  name: "mac" | "push" | "webhook" | "telegram";
  label: string;
  on: boolean;
  ready: boolean;
  detail: string;
}

/** Telegram, never the token itself. status: off | no-token | connecting | ok | error. */
export interface TelegramState {
  on: boolean;
  tokenSet: boolean;
  tokenMasked: string;
  paired: boolean;
  chatName: string | null;
  pairedAt: string | null;
  status: string;
  error: string | null;
  botName: string | null;
  pairing: { expiresAt: string } | null;
  pairError: string | null;
  /** A typed reply that answers a ticket's question is shown back with Send and Cancel first. */
  askTyped: boolean;
  /** "Take messages from Telegram" (off: Pause here, or /lock in Telegram; only this Mac turns it back on). */
  takeMessages: boolean;
  /** When /lock in Telegram turned it off, or null. */
  lockedAt: string | null;
  /** "Spent from Telegram today" in USD. */
  spentToday: number;
  /** The front desk's daily limit (USD) and what it spent today. */
  deskCapUsd: number;
  deskSpentToday: number;
  /** "Front desk lives on": the board whose Ask tab holds the Telegram front desk. */
  frontDesk: string | null;
  boards: { slug: string; name: string }[];
}

export type NotifyPatch = Partial<Pick<NotifyState, "webhookUrl" | "format" | "mac" | "helper" | "push" | "webhookOn">> & {
  kinds?: Partial<Record<NotifyKind, boolean>>;
  telegram?: { on?: boolean; token?: string; askTyped?: boolean; takeMessages?: boolean; frontDesk?: string; deskCapUsd?: number };
}

export interface InboxItem {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  attention: Attention;
  /** Snoozed from the Inbox until then: listed apart, not counted. */
  snoozedUntil?: string;
}
