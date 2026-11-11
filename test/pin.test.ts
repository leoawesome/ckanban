// 📌 Pinned tickets: pinning sets pinnedAt, it survives a reload, and every move to Done clears it.
import { expect, test } from "bun:test";
import { Store } from "../src/server/store";
import { store, board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

test("pinned true sets pinnedAt, false clears it, and the pin is saved with the ticket", async () => {
  await setup({ git: false });
  const t = await board.createTicket("p", { title: "Focus", body: "", status: "review" });
  expect(t.pinnedAt).toBeUndefined();
  const pinned = await board.updateTicket("p", t.id, { pinned: true });
  expect(typeof pinned.pinnedAt).toBe("string");
  expect(Number.isNaN(Date.parse(pinned.pinnedAt!))).toBe(false);
  // A fresh store reads it back from disk (as after a restart).
  expect(new Store(store.root).getTicket("p", t.id)!.pinnedAt).toBe(pinned.pinnedAt);
  const unpinned = await board.updateTicket("p", t.id, { pinned: false });
  expect(unpinned.pinnedAt).toBeNull();
});

test("moving a pinned ticket to another column keeps the pin; moving it to Done clears it", async () => {
  await setup({ git: false });
  const t = await board.createTicket("p", { title: "Focus", body: "", status: "review" });
  const pinned = await board.updateTicket("p", t.id, { pinned: true });
  const back = await board.updateTicket("p", t.id, { status: "backlog" });
  expect(back.pinnedAt).toBe(pinned.pinnedAt);
  const done = await board.updateTicket("p", t.id, { status: "done" }, { byUser: true });
  expect(done.status).toBe("done");
  expect(done.pinnedAt).toBeNull();
});

test("the store clears the pin on any save that reaches Done (a run finishing, the CLI, MCP all save through it)", async () => {
  await setup({ git: false });
  const t = await board.createTicket("p", { title: "Focus", body: "", status: "in_progress" });
  store.updateTicket("p", t.id, { pinnedAt: "2026-11-11T10:00:00.000Z" });
  expect(store.getTicket("p", t.id)!.pinnedAt).toBe("2026-11-11T10:00:00.000Z");
  const done = store.updateTicket("p", t.id, { status: "done", outcome: "done" });
  expect(done.pinnedAt).toBeNull();
  expect(store.getTicket("p", t.id)!.pinnedAt).toBeNull();
  // Pinning a ticket that is already in Done doesn't stick either.
  expect(store.updateTicket("p", t.id, { pinnedAt: "2026-11-11T11:00:00.000Z" }).pinnedAt).toBeNull();
});
