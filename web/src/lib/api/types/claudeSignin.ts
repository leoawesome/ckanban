// Kept apart from board.ts (no imports), so the sign-in strip's unit tests type-check without the browser globals.

/** Claude Code's own sign-in on the Mac, as the board last checked it (`claude auth status`, every 10 minutes). */
export interface ClaudeSignInStatus {
  checked: boolean;
  checkedAt: string | null;
  loggedIn: boolean | null;
  /** `authMethod` from `claude auth status`: "claude.ai" (a Claude account, which runs out), "api_key", "third_party"... */
  authMethod?: string | null;
  /** Only for a Claude account sign-in (other ways in don't run out here). */
  expiresAt: string | null;
  /** Whole days until it runs out (rounded up, 0 once it has). */
  daysLeft: number | null;
  /** What the strip at the top of the board shows; "missing": the board can't find Claude Code on the Mac. */
  warning: "missing" | "signed-out" | "expiring" | null;
  /** With "missing" only: the full path of the board's own program, for when `ckanban` isn't found in Terminal. */
  ckanbanPath?: string | null;
}

/**
 * A sign-in started from the board. `url` is only in the answers to the user's own start. Start, paste and cancel
 * answer the asking sheet's own sign-in: once another tab or device started a newer one, it is "failed" with the
 * words "This sign-in was replaced…" (and `startedAt` null).
 */
export interface ClaudeSignInLogin {
  id: number;
  state: "starting" | "waiting" | "checking" | "done" | "failed";
  url: string | null;
  error: string | null;
  startedAt: string | null;
}

/** `GET /api/claude-signin`, the answers of start, paste and cancel, and the `claude-signin.updated` event's `state`. */
export interface ClaudeSignInState {
  status: ClaudeSignInStatus;
  login: ClaudeSignInLogin | null;
}
