/** Where a lesson the board learned came from (src/board/learn.ts). */
export interface LearnSource {
  kind: "ticket" | "huddle";
  slug: string;
  id: string;
  title: string;
  /** "you" or the agent's handle. */
  by: string;
  at: string;
  quote: string;
  key: string;
  /** A huddle's host ticket. */
  ticket?: string;
}

/** A lesson in the board's pile, seen once so far. */
export interface LearnCandidate {
  id: string;
  kind: "ticket" | "huddle";
  text: string;
  general: boolean;
  dest: { kind: "rules"; slug: string } | { kind: "notes"; role: string; scope: "general" | "repo"; slug: string };
  sources: LearnSource[];
  firstAt: string;
  lastAt: string;
  state: "watching" | "saved" | "undone" | "dropped";
}

/** A lesson the board saved, or one step of its weekly tidy, with its undo state. */
export interface LearnChange {
  id: string;
  at: string;
  kind: "saved" | "merged" | "rewrote" | "removed";
  slug: string | null;
  text: string;
  old: string[];
  why?: string;
  where: string;
  candidateId?: string;
  sources?: LearnSource[];
  undoneAt?: string | null;
}

/** The Team tab's Learned view (src/board/learner.ts). */
export interface LearnedView {
  saved: LearnChange[];
  cleaned: LearnChange[];
  watching: LearnCandidate[];
  newCount: number;
  tidyAt: string | null;
}

/** Phone access over Tailscale (src/integrations/remote.ts). local: this page is open on the Mac, not the phone. */
export interface RemoteState {
  enabled: boolean;
  url: string | null;
  host: string | null;
  allowedLogin: string | null;
  lastVisit: string | null;
  warning?: string;
  /** Live Tailscale state on the Mac while phone access is on; missing means not checked. */
  tailscale?: "running" | "stopped" | "unavailable";
  backendState?: string;
  /** Tailscale's link to the board while on and running: ok, or a problem the board couldn't fix (serveProblem says it). */
  serve?: "ok" | "missing" | "other" | "public";
  serveProblem?: string;
  qrSvg: string | null;
  local: boolean;
}

export type BugBlockId = "env" | "ticket" | "log";

/** Context a bug report attaches; the user sees it and can leave it out. */
export interface BugBlock {
  id: BugBlockId;
  label: string;
  text: string;
}

export interface BugReportResult {
  url: string | null;
  fallbackUrl: string;
  error: string | null;
  /** Local /api/attachments/ URLs of screenshots that were not uploaded. */
  screenshots: string[];
}
