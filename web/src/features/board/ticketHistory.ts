/**
 * Ticket panel history: each ticket opened from the app adds a browser history entry that remembers
 * how many tickets were opened in a row on its board (its depth). Closing goes back that many entries,
 * so it lands on the board however many tickets were opened from inside other tickets.
 */
export type TicketState = { ckDepth: number; ckBoard: string };

function asTicketState(state: unknown): TicketState | null {
  const s = state as Partial<TicketState> | null;
  return s && typeof s.ckDepth === "number" && typeof s.ckBoard === "string" ? (s as TicketState) : null;
}

/**
 * Depth of a ticket about to be opened on `board`, given the current history entry's state and board.
 * A ticket on another board starts at 0: closing it stays on its board instead of going back to the old one.
 */
export function openDepth(state: unknown, currentBoard: string | null, board: string): number {
  if (currentBoard !== board) return 0;
  const s = asTicketState(state);
  return (s && s.ckBoard === board ? s.ckDepth : 0) + 1;
}

/** Entries to go back to reach the board from the current one (0: none of them are ours to go back over). */
export function closeSteps(state: unknown, board: string | null): number {
  const s = asTicketState(state);
  return s && s.ckBoard === board ? s.ckDepth : 0;
}
