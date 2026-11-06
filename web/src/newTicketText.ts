// Plain helpers for the New ticket form, kept apart from the component so tests can import them.

/** The quiet line in the New ticket form when the new ticket will be a main ticket (http.ts: top level, not added to a feature, not continuing a Claude Code chat). */
export const MAIN_HINT = "You talk to this ticket. For bigger work Claude splits it into steps that run on their own, and \u201cWhere we are\u201d at the top shows the progress.";
export const mainHint = (partOf: string | undefined, sessionId: string | undefined) => (partOf || sessionId ? null : MAIN_HINT);
