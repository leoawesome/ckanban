import { expect, test } from "bun:test";
import { BOARD_MIN, CHAT_DEFAULT, CHAT_MAX, CHAT_MIN, clampChatWidth, initialChatOpen, ticketPlacement } from "../web/src/sideChatLayout";

test("clampChatWidth keeps the chat within its limits", () => {
  expect(clampChatWidth(500, 1600)).toBe(500);
  expect(clampChatWidth(100, 1600)).toBe(CHAT_MIN);
  expect(clampChatWidth(5000, 2400)).toBe(CHAT_MAX);
  expect(clampChatWidth(450.6, 1600)).toBe(451);
});

test("clampChatWidth leaves the board its minimum, but never goes under the chat's own minimum", () => {
  expect(clampChatWidth(700, 1000)).toBe(1000 - BOARD_MIN);
  expect(clampChatWidth(700, 600)).toBe(CHAT_MIN);
});

test("clampChatWidth falls back to the default for missing or broken values", () => {
  expect(clampChatWidth(0, 1600)).toBe(CHAT_DEFAULT);
  expect(clampChatWidth(NaN, 1600)).toBe(CHAT_DEFAULT);
});

test("ticketPlacement: beside on wide windows, cover on narrow ones or with a wide chat", () => {
  expect(ticketPlacement(1440, CHAT_DEFAULT)).toBe("beside");
  expect(ticketPlacement(1920, 700)).toBe("beside");
  expect(ticketPlacement(1399, 340)).toBe("cover");
  expect(ticketPlacement(1280, CHAT_DEFAULT)).toBe("cover");
  // Wide window, but the chat is so wide the board would lose its last column.
  expect(ticketPlacement(1500, 600)).toBe("cover");
});

test("initialChatOpen: the saved choice, else a bottom panel left open on Claude", () => {
  const from = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  expect(initialChatOpen(from({}))).toBe(false);
  expect(initialChatOpen(from({ "ckanban.sideChat.open": "1" }))).toBe(true);
  expect(initialChatOpen(from({ "ckanban.sideChat.open": "0", "ckanban.dock.open": "1", "ckanban.dock.tab": "claude" }))).toBe(false);
  expect(initialChatOpen(from({ "ckanban.dock.open": "1", "ckanban.dock.tab": "claude" }))).toBe(true);
  expect(initialChatOpen(from({ "ckanban.dock.open": "0", "ckanban.dock.tab": "claude" }))).toBe(false);
  expect(initialChatOpen(from({ "ckanban.dock.open": "1", "ckanban.dock.tab": "files" }))).toBe(false);
});
