import { expect, test } from "bun:test";
import { BOARD_KEEP, BOARD_MIN, boardHidesBelow, clampChatWidth, COLUMN_DEFAULT, COLUMN_MAX, COLUMN_MIN, TICKET_MIN, ticketBeside } from "../web/src/sideChatLayout";

test("clampChatWidth keeps the column within its limits", () => {
  expect(clampChatWidth(500, 1600)).toBe(500);
  expect(clampChatWidth(100, 1600)).toBe(COLUMN_MIN);
  expect(clampChatWidth(5000, 2600)).toBe(COLUMN_MAX);
  expect(clampChatWidth(450.6, 1600)).toBe(451);
});

test("clampChatWidth leaves the board its minimum, but never goes under the column's own minimum", () => {
  expect(clampChatWidth(700, 1000)).toBe(1000 - BOARD_MIN);
  expect(clampChatWidth(700, 600)).toBe(COLUMN_MIN);
});

test("clampChatWidth with a ticket open: the column narrows (to its minimum) before the ticket goes under its own", () => {
  expect(clampChatWidth(600, 1600, true)).toBe(600);
  expect(clampChatWidth(600, 1100, true)).toBe(1100 - TICKET_MIN);
  expect(clampChatWidth(600, 900, true)).toBe(COLUMN_MIN);
  // Never wider than the window can hold with a ticket beside it.
  for (const w of [721, 800, 960, 1200, 1440, 1920]) expect(clampChatWidth(9999, w, true) + Math.min(TICKET_MIN, w - COLUMN_MIN)).toBeLessThanOrEqual(w);
});

test("clampChatWidth falls back to the default for missing or broken values", () => {
  expect(clampChatWidth(0, 1600)).toBe(COLUMN_DEFAULT);
  expect(clampChatWidth(NaN, 1600)).toBe(COLUMN_DEFAULT);
});

test("ticketBeside: the board shrinks first, then hides; the ticket keeps its width", () => {
  // Plenty of room: the ticket keeps the user's width, the board the rest.
  expect(ticketBeside(1500, 800, true)).toEqual({ width: 800, boardHidden: false });
  // The board would get less than BOARD_KEEP: it hides and the ticket fills the room (no overlap, no sideways scroll).
  expect(ticketBeside(1100, 800, true)).toEqual({ width: 1100, boardHidden: true });
  expect(ticketBeside(800 + BOARD_KEEP, 800, true)).toEqual({ width: 800, boardHidden: false });
  expect(ticketBeside(800 + BOARD_KEEP - 1, 800, true)).toEqual({ width: 800 + BOARD_KEEP - 1, boardHidden: true });
  // Too narrow for the smallest ticket plus a board column: the ticket takes all of it, even under TICKET_MIN.
  expect(ticketBeside(TICKET_MIN + BOARD_KEEP - 1, 0, false)).toEqual({ width: TICKET_MIN + BOARD_KEEP - 1, boardHidden: true });
  expect(ticketBeside(401, 900, true)).toEqual({ width: 401, boardHidden: true });
});

test("ticketBeside: the default width gives way so the board keeps a column", () => {
  expect(ticketBeside(1000, 1120, false)).toEqual({ width: 1000 - BOARD_KEEP, boardHidden: false });
  expect(ticketBeside(TICKET_MIN + BOARD_KEEP, 1120, false)).toEqual({ width: TICKET_MIN, boardHidden: false });
  expect(ticketBeside(2000, 900, false)).toEqual({ width: 900, boardHidden: false });
});

test("boardHidesBelow: the window width where a ticket beside the column starts hiding the board", () => {
  expect(boardHidesBelow(COLUMN_DEFAULT)).toBe(1400);
  expect(boardHidesBelow(COLUMN_MIN)).toBe(1280);
  // At that width the default ticket just fits beside the board.
  const w = boardHidesBelow(COLUMN_DEFAULT);
  expect(ticketBeside(w - clampChatWidth(COLUMN_DEFAULT, w, true), 1120, false).boardHidden).toBe(false);
  expect(ticketBeside(w - 1 - clampChatWidth(COLUMN_DEFAULT, w - 1, true), 1120, false).boardHidden).toBe(true);
});
