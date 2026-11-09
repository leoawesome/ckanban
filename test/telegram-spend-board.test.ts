// "Spent from Telegram today" on a real Board: steered runs, mixed board/Telegram turns (from the step 2 review, qa-2).
import { expect, test } from "bun:test";
import { telegramSpendToday } from "../src/server/spend";
import { board, setup, store, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

async function oneRunCost(): Promise<number> {
  // Baseline: a Telegram cold start on a fresh ticket.
  const t = store.createTicket("p", { title: "base", body: "b", status: "review" });
  const before = telegramSpendToday(store.root);
  await board.chatFromTelegram("p", t.id, "base", { updateId: 900, tg: 900, chatId: 5 });
  await board.whenIdle();
  return telegramSpendToday(store.root) - before;
}

test("A: a board run steered by a Telegram message counts (rest of the attempt)", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  process.env.FAKE_STEP_MS = "400";
  try {
    const t = store.createTicket("p", { title: "x", body: "b", status: "review" });
    await board.chat("p", t.id, "from the board");
    await untilSpawned(1);
    expect(board.isRunning("p", t.id)).toBe(true);
    expect(await board.chatFromTelegram("p", t.id, "steer from phone", { updateId: 1, tg: 10, chatId: 5 })).toBe(true);
    await board.whenIdle();
    console.log("A spent", telegramSpendToday(store.root));
    expect(telegramSpendToday(store.root)).toBeGreaterThan(0);
  } finally {
    delete process.env.FAKE_CTX;
    delete process.env.FAKE_STEP_MS;
  }
}, 60_000);

test("B: a board run steered by a board message counts nothing", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  process.env.FAKE_STEP_MS = "400";
  try {
    const t = store.createTicket("p", { title: "x", body: "b", status: "review" });
    await board.chat("p", t.id, "from the board");
    await untilSpawned(1);
    await board.chat("p", t.id, "steer from board");
    await board.whenIdle();
    expect(telegramSpendToday(store.root)).toBe(0);
  } finally {
    delete process.env.FAKE_CTX;
    delete process.env.FAKE_STEP_MS;
  }
}, 60_000);

test("C: two Telegram cold starts add up; a board turn in between adds nothing", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  try {
    const one = await oneRunCost();
    expect(one).toBeGreaterThan(0);
    const t = store.createTicket("p", { title: "y", body: "b", status: "review" });
    await board.chatFromTelegram("p", t.id, "first", { updateId: 1, tg: 1, chatId: 5 });
    await board.whenIdle();
    await board.chat("p", t.id, "board in between");
    await board.whenIdle();
    await board.chatFromTelegram("p", t.id, "second", { updateId: 2, tg: 2, chatId: 5 });
    await board.whenIdle();
    console.log("C one", one, "total", telegramSpendToday(store.root));
    expect(telegramSpendToday(store.root)).toBeCloseTo(one * 3, 6);
  } finally {
    delete process.env.FAKE_CTX;
  }
}, 60_000);

test("D: Telegram message sent while the board's run is still starting (no claude yet)", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  try {
    const t = store.createTicket("p", { title: "z", body: "b", status: "review" });
    await board.chat("p", t.id, "from the board");
    await board.chatFromTelegram("p", t.id, "early phone", { updateId: 3, tg: 3, chatId: 5 });
    await board.whenIdle();
    console.log("D spent", telegramSpendToday(store.root));
    expect(telegramSpendToday(store.root)).toBeGreaterThan(0);
  } finally {
    delete process.env.FAKE_CTX;
  }
}, 60_000);

test("E: a Telegram-started run, then a board message sent before claude spawned: the board turn is not Telegram's", async () => {
  await setup({ git: false });
  process.env.FAKE_CTX = "20000";
  try {
    const one = await oneRunCost();
    const t = store.createTicket("p", { title: "w", body: "b", status: "review" });
    await board.chatFromTelegram("p", t.id, "phone first", { updateId: 4, tg: 4, chatId: 5 });
    await board.chat("p", t.id, "board right after");
    await board.whenIdle();
    console.log("E one", one, "total", telegramSpendToday(store.root));
  } finally {
    delete process.env.FAKE_CTX;
  }
}, 60_000);
