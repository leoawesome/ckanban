import { expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

function setup() {
  const store = new Store(tempDir("ck-home-"));
  const board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  const p = { name: "Rights", slug: "rights", path: tempDir("ck-proj-"), baseBranch: "main", maxParallel: 3, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  const mk = (title: string) => store.createTicket(p.slug, { title, body: "", status: "backlog" });
  // A run in progress on the ticket, as Board.start registers it (no claude here).
  const fakeRun = (id: string, chat?: object) =>
    (board as any).runs.set(`${p.slug}/${id}`, { slug: p.slug, id, stopRequested: false, targetStatus: null, promise: Promise.resolve(), ...(chat ? { chat } : {}) });
  return { store, board, slug: p.slug, mk, fakeRun };
}

test("only an active work run or chat reply gets runner rights: not Planning chats, peer replies or stopping runs", () => {
  const { board, slug, mk, fakeRun } = setup();
  const work = mk("Work");
  const refine = mk("Planning");
  const peer = mk("Peer");
  const chat = mk("Chat");
  const idle = mk("Idle");
  fakeRun(work.id);
  fakeRun(refine.id, { text: "", mode: "refine", user: true });
  fakeRun(peer.id, { text: "q", mode: "act", raw: true, quiet: true });
  fakeRun(chat.id, { text: "do it", mode: "act", user: true });
  expect(board.runnerRights(slug, work.id)?.id).toBe(work.id);
  expect(board.runnerRights(slug, chat.id)?.id).toBe(chat.id);
  expect(board.runnerRights(slug, refine.id)).toBeNull();
  expect(board.runnerRights(slug, peer.id)).toBeNull();
  expect(board.runnerRights(slug, idle.id)).toBeNull();
  (board as any).runs.get(`${slug}/${work.id}`).stopRequested = true;
  expect(board.runnerRights(slug, work.id)).toBeNull();
});

test("runs started by runs: no limit on how many or how deep; only a ticket that keeps restarting its starter is refused", () => {
  const { store, board, slug, mk, fakeRun } = setup();
  const a = mk("A");
  fakeRun(a.id);
  // A run the user started: what it starts is one level deep, and one run may start any number of tickets.
  expect(board.runStart(slug, a.id)).toEqual({ ticketId: a.id, depth: 1, chain: [a.id] });
  for (let i = 0; i < 12; i++) expect(board.runStart(slug, a.id, mk(`K${i}`).id).depth).toBe(1);

  // Deep chains are fine: A → B → C → D → E → F.
  let prev = a.id;
  for (const title of ["B", "C", "D", "E", "F"]) {
    const t = mk(title);
    board.markStartedBy(slug, t.id, board.runStart(slug, prev, t.id));
    prev = t.id;
  }
  expect(store.getTicket(slug, prev)!.startedBy!.depth).toBe(5);

  // A loop: B (started by A) starts A, A starts B again, then B can't start A a third time.
  const b = mk("B2");
  board.markStartedBy(slug, b.id, board.runStart(slug, a.id, b.id));
  board.markStartedBy(slug, a.id, board.runStart(slug, b.id, a.id));
  board.markStartedBy(slug, b.id, board.runStart(slug, a.id, b.id));
  expect(() => board.runStart(slug, b.id, a.id)).toThrow("keep starting each other");
  // Old startedBy records (no chain) still work.
  board.markStartedBy(slug, b.id, { ticketId: a.id, depth: 7 });
  expect(board.runStart(slug, b.id, a.id)).toEqual({ ticketId: b.id, depth: 8, chain: [a.id, b.id] });
  // The user starts it again: the chain starts over.
  board.markStartedBy(slug, b.id, null);
  expect(store.getTicket(slug, b.id)!.startedBy).toBeNull();
  expect(board.runStart(slug, b.id).depth).toBe(1);
});
