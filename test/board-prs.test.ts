// A ticket's PRs: replies to its huddle that report a result, and several PRs on one ticket.
import { afterEach, expect, test } from "bun:test";
import { store, board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

afterEach(() => {
  delete process.env.FAKE_PRS;
});

/** A Review card that already ran, waiting on questions (like a ticket whose huddle is reviewing the work). */
async function reviewCard() {
  const t = await board.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { outcome: "needs_input", prUrl: null, runCount: 1 });
  return t;
}

test("a huddle reply that reports a PR saves it, posts its summary and sets the outcome", async () => {
  await setup();
  const t = await reviewCard();
  process.env.FAKE_PR = "https://github.com/x/y/pull/9";
  await board.chat("p", t.id, "@main the review is done, land it", { peer: true });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.prUrl).toBe("https://github.com/x/y/pull/9");
  expect(got.prs).toEqual([{ url: "https://github.com/x/y/pull/9", state: null }]);
  expect(got.outcome).toBe("done");
  expect(got.status).toBe("review");
  // A reply is not new work: the run count stays.
  expect(got.runCount).toBe(1);
  expect(store.listComments("p", t.id).at(-1)).toMatchObject({ author: "ai", text: "fake done" });
});

test("a huddle reply without a result line changes nothing", async () => {
  await setup();
  const t = await reviewCard();
  process.env.FAKE_MODE = "noresult";
  await board.chat("p", t.id, "@main what about the retry?", { peer: true });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.prUrl).toBeNull();
  expect(got.prs ?? null).toBeNull();
  expect(got.outcome).toBe("needs_input");
  expect(store.listComments("p", t.id).filter((c) => c.author === "ai")).toEqual([]);
});

test("a planner's huddle reply doesn't take PRs", async () => {
  await setup();
  const t = await reviewCard();
  store.updateTicket("p", t.id, { plan: { state: "running", maxConcurrent: 1, wakeups: 0, startedAt: new Date().toISOString(), originalCount: 1, inbox: [], seen: {}, retries: {}, awaiting: null } });
  await board.chat("p", t.id, "@main done?", { peer: true });
  await board.whenIdle();
  expect(store.getTicket("p", t.id)!.prUrl).toBeNull();
});

test("two runs that report different PRs leave both on the ticket", async () => {
  await setup();
  process.env.FAKE_PR = "https://github.com/x/y/pull/1";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  process.env.FAKE_PR = "https://github.com/x/voice/pull/2";
  await board.chat("p", t.id, "also fix the voice repo");
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.prs!.map((p) => p.url)).toEqual(["https://github.com/x/y/pull/1", "https://github.com/x/voice/pull/2"]);
  // The newest open PR is the main one.
  expect(got.prUrl).toBe("https://github.com/x/voice/pull/2");
});

test("one run can report several PRs at once, without duplicates", async () => {
  await setup();
  process.env.FAKE_PR = "https://github.com/x/y/pull/4";
  process.env.FAKE_PRS = "https://github.com/x/y/pull/3,https://github.com/x/y/pull/4";
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  await board.whenIdle();
  const got = store.getTicket("p", t.id)!;
  expect(got.prs!.map((p) => p.url)).toEqual(["https://github.com/x/y/pull/3", "https://github.com/x/y/pull/4"]);
  expect(got.prUrl).toBe("https://github.com/x/y/pull/4");
});
