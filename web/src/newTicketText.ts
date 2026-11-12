// Plain helpers for the New ticket form, kept apart from the component so tests can import them.

/** The quiet line in the New ticket form when the new ticket will be a main ticket (http.ts: top level, not added to a feature, not continuing a Claude Code chat). */
export const MAIN_HINT = "You talk to this ticket. For bigger work Claude splits it into tasks that run on their own, and the Tasks tab shows the progress.";
export const mainHint = (partOf: string | undefined, sessionId: string | undefined) => (partOf || sessionId ? null : MAIN_HINT);

/** A model as the New ticket chip says it: "Sonnet" for an alias, a full id as it is. */
export const modelWord = (m: string) => {
  const a = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(m.trim());
  return a ? a[1][0].toUpperCase() + a[1].slice(1).toLowerCase() + (a[2] ? " (1M)" : "") : m;
};

/** The New ticket form's small chip: only what runs ("Opus · high", "Default model"), and whether both are the board's. */
export function runsOn(o: { model: string; effort: string; boardModel: string | null; boardEffort: string | null }): { what: string; boardDefault: boolean } {
  const m = o.model || o.boardModel;
  const e = o.effort || o.boardEffort;
  return { what: [m ? modelWord(m) : "Default model", e].filter(Boolean).join(" · "), boardDefault: !o.model && !o.effort };
}
