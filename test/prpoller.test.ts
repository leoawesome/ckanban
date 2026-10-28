import { beforeEach, expect, test } from "bun:test";
import type { HostHuddle } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { checkPr, mergePr, refreshPr, type PrState } from "../src/server/prpoller";
import { parsePrStatus } from "../src/server/prstatus";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let id: string;
let summary: Partial<SessionSummary> | null;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  summary = null;
  const sessionSummary = () => summary && ({
    title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], ...summary,
  });
  board = new Board(store, new Bus(), { claudeBin: "/bin/false", sessionSummary });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  id = store.createTicket("p", { title: "x", body: "", status: "review" }).id;
  store.updateTicket("p", id, { prUrl: "https://github.com/x/y/pull/1", sessionId: "s1" });
});

test("merged PR moves ticket to done", async () => {
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
});

test("closed PR comments once and stays in review", async () => {
  await checkPr(board, store, "p", id, async () => "CLOSED");
  await checkPr(board, store, "p", id, async () => "CLOSED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  const c = store.listComments("p", id).filter((c) => c.text === "PR closed without merge.");
  expect(c.length).toBe(1);
});

test("open PR leaves ticket unchanged", async () => {
  await checkPr(board, store, "p", id, async () => "OPEN");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(store.listComments("p", id).length).toBe(0);
});

test("merged PR does not touch ticket the user moved during gh call", async () => {
  await checkPr(board, store, "p", id, async () => {
    store.updateTicket("p", id, { status: "backlog" });
    return "MERGED";
  });
  expect(store.getTicket("p", id)!.status).toBe("backlog");
});

const merged = () => store.listComments("p", id).filter((c) => c.text === "PR merged.").length;

test("merged PR keeps a ticket with uncreated proposed tickets in review, then moves it once they exist", async () => {
  summary = { pendingNewTickets: [{ title: "Fix logout", description: "" }, { title: "Fix keyboard", description: "" }] };
  for (let i = 0; i < 3; i++) await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(merged()).toBe(1);

  store.createTicket("p", { title: "Fix logout", body: "", status: "backlog", parentId: id });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");

  store.createTicket("p", { title: "Fix keyboard", body: "", status: "backlog", parentId: id });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
  expect(merged()).toBe(1);
});

test("merged PR keeps a ticket with open questions in review", async () => {
  summary = { openQuestions: 2 };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  summary = { openQuestions: 0 };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
  expect(merged()).toBe(1);
});

test("merged PR keeps a needs_input ticket in review", async () => {
  store.updateTicket("p", id, { outcome: "needs_input" });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
});

test("merged PR keeps a ticket with an unapplied proposal in review", async () => {
  summary = { pendingProposal: { title: "Better title", description: "" } };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
});

test("injected wait check decides", async () => {
  await checkPr(board, store, "p", id, async () => "MERGED", () => true);
  expect(store.getTicket("p", id)!.status).toBe("review");
  await checkPr(board, store, "p", id, async () => "MERGED", () => false);
  expect(store.getTicket("p", id)!.status).toBe("done");
});

test("merged PR keeps a ticket hosting an open huddle in review, then moves it once the huddle closes", async () => {
  let open = true;
  // Its helpers are at work, so the huddle asks nothing of the user.
  const busy: HostHuddle = { working: 2, queued: false, tagged: 0, learnings: 0, closeRequest: false, since: null };
  board.onHostHuddles(() => new Map(open ? [[id, busy]] : []));
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(merged()).toBe(1);
  open = false;
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
  expect(merged()).toBe(1);
});

const A = "https://github.com/x/y/pull/1";
const B = "https://github.com/x/voice/pull/2";
const states = (m: Record<string, PrState>) => async (url: string) => m[url] ?? null;

test("with two PRs, the card moves to Done only once both are merged or closed", async () => {
  store.updateTicket("p", id, { prs: [{ url: A, state: null }, { url: B, state: null }], prUrl: B });
  await checkPr(board, store, "p", id, states({ [A]: "MERGED", [B]: "OPEN" }));
  let t = store.getTicket("p", id)!;
  expect(t.status).toBe("review");
  expect(t.prs).toEqual([{ url: A, state: "MERGED" }, { url: B, state: "OPEN" }]);
  expect(merged()).toBe(0);
  // A merged PR is not asked about again.
  const asked: string[] = [];
  await checkPr(board, store, "p", id, async (url) => {
    asked.push(url);
    return url === B ? "CLOSED" : "OPEN";
  });
  expect(asked).toEqual([B]);
  t = store.getTicket("p", id)!;
  expect(t.status).toBe("done");
  expect(merged()).toBe(1);
});

test("the main PR moves to the newest one still open", async () => {
  store.updateTicket("p", id, { prs: [{ url: A, state: null }, { url: B, state: null }], prUrl: B });
  await checkPr(board, store, "p", id, states({ [A]: "OPEN", [B]: "MERGED" }));
  const t = store.getTicket("p", id)!;
  expect(t.prUrl).toBe(A);
  expect(t.status).toBe("review");
});

test("refresh records each PR's target branch", async () => {
  store.updateTicket("p", id, { prs: [{ url: A, state: null }, { url: B, state: null }], prUrl: B });
  const status = async (url: string) => parsePrStatus(url, { state: "OPEN", baseRefName: url === A ? "dev" : "main" });
  await refreshPr(board, store, "p", id, { status });
  const t = store.getTicket("p", id)!;
  expect(t.prs).toEqual([{ url: A, state: "OPEN", base: "dev" }, { url: B, state: "OPEN", base: "main" }]);
  expect(t.pr?.base).toBe("main");
});

test("an old ticket with only prUrl still merges to Done and gets no PR list", async () => {
  await checkPr(board, store, "p", id, async () => "MERGED");
  const t = store.getTicket("p", id)!;
  expect(t.status).toBe("done");
  expect(t.prs ?? null).toBeNull();
});

test("Merge & done with two PRs merges the main one and waits for the other", async () => {
  store.updateTicket("p", id, { prs: [{ url: A, state: "OPEN" }, { url: B, state: "OPEN" }], prUrl: B });
  const ok = (url: string) => ({ ...parsePrStatus(url, { state: "OPEN", mergeable: "MERGEABLE" }) });
  await mergePr(board, store, "p", id, { status: async (u) => ok(u), merge: async () => ({ ok: true, error: "" }) });
  let t = store.getTicket("p", id)!;
  expect(t.status).toBe("review");
  expect(t.prUrl).toBe(A);
  expect(t.prs!.find((p) => p.url === B)!.state).toBe("MERGED");
  await mergePr(board, store, "p", id, { status: async (u) => ok(u), merge: async () => ({ ok: true, error: "" }) });
  t = store.getTicket("p", id)!;
  expect(t.status).toBe("done");
});
