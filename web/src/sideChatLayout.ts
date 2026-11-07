/**
 * The quick Claude chat as a side panel on the right (computers only): its width limits and how it shares
 * the window with the ticket panel. Pure, so the numbers are tested (test/sideChatLayout.test.ts).
 */

export const CHAT_WIDTH_KEY = "ckanban.sideChat.width";
export const CHAT_OPEN_KEY = "ckanban.sideChat.open";

export const CHAT_DEFAULT = 440;
export const CHAT_MIN = 340;
export const CHAT_MAX = 760;
/** The board always keeps at least this much beside the chat (it scrolls sideways inside it). */
export const BOARD_MIN = 400;

/** The ticket panel's narrowest width (TicketDrawer's MIN_WIDTH). */
export const TICKET_MIN = 640;
/** With the ticket beside the chat, the board keeps at least about one column. */
export const BOARD_KEEP = 320;
/** Windows narrower than this never put the ticket beside the chat (the ticket covers it instead). */
export const BESIDE_MIN_WINDOW = 1400;

/** The chat's width for a wanted width, within its limits and leaving the board BOARD_MIN. */
export function clampChatWidth(w: number, windowWidth: number): number {
  const max = Math.max(CHAT_MIN, Math.min(CHAT_MAX, windowWidth - BOARD_MIN));
  const want = Number.isFinite(w) && w > 0 ? w : CHAT_DEFAULT;
  return Math.round(Math.min(max, Math.max(CHAT_MIN, want)));
}

/**
 * Where an opened ticket goes while the chat is open: "beside" between the board and the chat (all three
 * visible) when the window fits the chat, the narrowest ticket panel and a board column; otherwise "cover",
 * over the chat (which stays mounted underneath and shows again when the ticket closes).
 */
export function ticketPlacement(windowWidth: number, chatWidth: number): "beside" | "cover" {
  return windowWidth >= BESIDE_MIN_WINDOW && windowWidth - chatWidth >= TICKET_MIN + BOARD_KEEP ? "beside" : "cover";
}

/**
 * Whether the chat starts open. Before the side panel, the chat was the bottom panel's Claude item: a panel
 * left open on it opens the side chat now (and the bottom panel stays closed).
 */
export function initialChatOpen(get: (key: string) => string | null): boolean {
  const saved = get(CHAT_OPEN_KEY);
  if (saved !== null) return saved === "1";
  return get("ckanban.dock.open") === "1" && get("ckanban.dock.tab") === "claude";
}
