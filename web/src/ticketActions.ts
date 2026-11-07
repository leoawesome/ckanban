import type { CommandAction } from "./CommandBar";

/**
 * The open ticket panel's own ⌘K entries (Go to what needs you, Mark done, Delete ticket…). The panel provides them
 * while it is open; App reads them when the command bar opens, so they always reflect the ticket as it is then.
 */
let provider: (() => CommandAction[]) | null = null;

/** Called by the ticket panel; returns the cleanup that removes them again. */
export function provideTicketActions(fn: () => CommandAction[]): () => void {
  provider = fn;
  return () => {
    if (provider === fn) provider = null;
  };
}

export function ticketActions(): CommandAction[] {
  return provider?.() ?? [];
}

/**
 * Runs an action once the command bar has closed and given focus back, so a picker or confirm it opens keeps the
 * focus (the bar's focus trap returns focus as it unmounts).
 */
export const afterBar = (run: () => void) => () => void setTimeout(run, 0);
