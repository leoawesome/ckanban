import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { RUN_HEADER } from "../src/server/scheduler";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

// "Fresh chat (keeps status)" in the ticket panel: POST .../fresh-chat starts a new Claude session for the next
// message. Chat history (comments, earlier sessions), status, column and outputs stay.
let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  server = createServer({ store, bus: new Bus(), board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const send = (u: string, b: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });

test("fresh-chat swaps the session id only, keeps history and column, and is idempotent", async () => {
  const p = (await (await send(`${base}/api/profiles`, { name: "fc", path: tempDir("ck-p-") })).json()) as any;
  const t = (await (await send(`${base}/api/profiles/${p.slug}/tickets`, { title: "x", body: "the task", status: "review" })).json()) as any;
  store.addComment(p.slug, t.id, "user", "an earlier message");
  store.updateTicket(p.slug, t.id, { sessionId: "old-session", sessionStarted: true });
  const before = store.getTicket(p.slug, t.id)!;

  const r = await send(`${base}/api/profiles/${p.slug}/tickets/${t.id}/fresh-chat`);
  expect(r.status).toBe(200);
  const got = store.getTicket(p.slug, t.id)!;
  expect(got.sessionId).not.toBe("old-session");
  expect(got.sessionStarted).toBe(false);
  expect(got.freshSession).toBe(true);
  expect(got.earlierSessions?.map((s) => s.sessionId)).toEqual(["old-session"]);
  expect(got.status).toBe(before.status);
  expect(got.title).toBe("x");
  expect(got.body).toBe("the task");
  const texts = store.listComments(p.slug, t.id).map((c) => c.text);
  expect(texts).toContain("an earlier message");
  expect(texts.some((c) => c.startsWith("Started a fresh chat"))).toBe(true);

  // A second click before any message changes nothing more.
  await send(`${base}/api/profiles/${p.slug}/tickets/${t.id}/fresh-chat`);
  const again = store.getTicket(p.slug, t.id)!;
  expect(again.sessionId).toBe(got.sessionId);
  expect(again.earlierSessions?.length).toBe(1);
});

test("a run can't start a fresh chat for the user", async () => {
  const p = (await (await send(`${base}/api/profiles`, { name: "fc2", path: tempDir("ck-p-") })).json()) as any;
  const t = (await (await send(`${base}/api/profiles/${p.slug}/tickets`, { title: "y", body: "", status: "review" })).json()) as any;
  store.updateTicket(p.slug, t.id, { sessionId: "keep-me", sessionStarted: true });
  const r = await send(`${base}/api/profiles/${p.slug}/tickets/${t.id}/fresh-chat`, {}, { [RUN_HEADER]: `${p.slug}/${t.id}` });
  expect(r.status).toBe(403);
  expect(store.getTicket(p.slug, t.id)!.sessionId).toBe("keep-me");
});
