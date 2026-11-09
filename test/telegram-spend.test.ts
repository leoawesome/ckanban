// "Spent from Telegram today": a run a Telegram message started counts; one typed on the board doesn't.
import { expect, test } from "bun:test";
import { addTelegramSpend, telegramSpendToday } from "../src/server/spend";
import { board, setup, store, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

test("the ledger adds up per local day and ignores nothing-spent turns", () => {
  const root = tempDir("ck-tgs-");
  const day = new Date(2026, 10, 9, 12);
  expect(telegramSpendToday(root, day)).toBe(0);
  addTelegramSpend(root, 0.4, day);
  addTelegramSpend(root, 0, day);
  addTelegramSpend(root, Number.NaN, day);
  addTelegramSpend(root, 1, new Date(2026, 10, 9, 23, 59));
  addTelegramSpend(root, 2, new Date(2026, 10, 10, 0, 1));
  expect(telegramSpendToday(root, day)).toBeCloseTo(1.4);
  expect(telegramSpendToday(root, new Date(2026, 10, 10, 9))).toBeCloseTo(2);
});

test("a ticket run started from Telegram adds its cost; a run typed on the board doesn't", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  try {
    const t = store.createTicket("p", { title: "Deploy", body: "b", status: "review" });
    await board.chat("p", t.id, "from the board");
    await board.whenIdle();
    expect(telegramSpendToday(store.root)).toBe(0);
    expect(await board.chatFromTelegram("p", t.id, "from the phone", { updateId: 1, tg: 10, chatId: 5 })).toBe(true);
    await board.whenIdle();
    const spent = telegramSpendToday(store.root);
    expect(spent).toBeGreaterThan(0);
    // Another board message afterwards adds nothing more.
    await board.chat("p", t.id, "again from the board");
    await board.whenIdle();
    expect(telegramSpendToday(store.root)).toBe(spent);
  } finally {
    delete process.env.FAKE_CTX;
  }
}, 30_000);
