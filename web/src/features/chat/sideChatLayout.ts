/**
 * How the side panel column (SidePanels.tsx) shares the window with the board and the ticket panel on computers.
 * Left to right: the board, the ticket panel (when open), the column. As the window narrows the board gives way first
 * (down to BOARD_KEEP beside a ticket, then it hides behind the ticket); the column narrows to COLUMN_MIN before the
 * ticket goes under TICKET_MIN; nothing ever scrolls the page sideways. Pure, so the numbers are tested
 * (test/sideChatLayout.test.ts). Phones (720px and under) have no column (PhonePanels).
 */

export const COLUMN_DEFAULT = 440;
export const COLUMN_MIN = 320;
export const COLUMN_MAX = 900;
/** With no ticket open, the board keeps at least this much beside the column (it scrolls sideways inside it). */
export const BOARD_MIN = 400;

/** The ticket panel's narrowest width (TicketDrawer's MIN_WIDTH) while the window allows it. */
export const TICKET_MIN = 640;
/** Beside a ticket the board shows only while it keeps at least about one column; narrower, it hides. */
export const BOARD_KEEP = 320;

/**
 * The column's width for a wanted width: within COLUMN_MIN…COLUMN_MAX, leaving the board BOARD_MIN, or with a ticket
 * open leaving the ticket TICKET_MIN. When even that doesn't fit, the column stays at COLUMN_MIN and the ticket narrows.
 */
export function clampChatWidth(w: number, windowWidth: number, ticketOpen = false): number {
  const room = windowWidth - (ticketOpen ? TICKET_MIN : BOARD_MIN);
  const max = Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, room));
  const want = Number.isFinite(w) && w > 0 ? w : COLUMN_DEFAULT;
  return Math.round(Math.min(max, Math.max(COLUMN_MIN, want)));
}

/**
 * The ticket panel beside the column: `room` is the window minus the column, `want` the ticket's width (the user's,
 * when `custom`; else the default, which first gives up space so the board keeps BOARD_KEEP). The board shrinks first;
 * once it would be narrower than BOARD_KEEP it hides and the ticket fills the room.
 */
export function ticketBeside(room: number, want: number, custom: boolean): { width: number; boardHidden: boolean } {
  const full = { width: Math.max(0, Math.round(room)), boardHidden: true };
  if (room < TICKET_MIN + BOARD_KEEP) return full;
  let w = Math.max(TICKET_MIN, Math.min(Number.isFinite(want) ? want : TICKET_MIN, room));
  if (!custom) w = Math.min(w, room - BOARD_KEEP);
  if (room - w < BOARD_KEEP) return full;
  return { width: Math.round(w), boardHidden: false };
}

/** The widest window at which a ticket beside a column of this width hides the board (the board shows from one px wider). */
export const boardHidesBelow = (column: number) => column + TICKET_MIN + BOARD_KEEP;
