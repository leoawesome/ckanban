import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { attentionFor } from "../src/server/attention";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { HUDDLE_HEADER } from "../src/server/huddle-roster";
import { createServer } from "../src/server/http";
import { QUICK_CHAT_HEADER, RUN_HEADER } from "../src/server/scheduler";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

// Claude's delete_schedule in a board chat or run only shows a card; the daemon refuses a real delete from any run,
// and the user's click on the card (or the Schedules window) deletes it.

let server: ReturnType<typeof createServer>;
let store: Store;
let base: string;
/** What the guard says about the next request's client: the user's browser, or another program. */
let fromBoard = false;
/** What the guard says about a local program with no page (no Origin): outside the board (the user's own Claude) or not. */
let outside = true;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), isUserBrowser: async () => !fromBoard, isOutsideBoard: async () => outside });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  fromBoard = false;
  outside = true;
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", ...(method === "GET" ? {} : { origin: base }), ...headers },
  });

async function schedule(name = "Nightly"): Promise<string> {
  const r = await send("POST", "/profiles/p/schedules", { name, title: "T", body: "b", cron: "0 3 * * *", enabled: false });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).id;
}

async function ticket(): Promise<string> {
  const r = await send("POST", "/profiles/p/tickets", { title: "Chat", status: "backlog" });
  return ((await r.json()) as any).id;
}

test("a board run, chat or huddle helper can't delete a schedule; the user (Schedules window) can", async () => {
  const sid = await schedule();
  for (const h of [{ [RUN_HEADER]: "p/t_20261001_wxyz" }, { [HUDDLE_HEADER]: "h/x/tok" }] as Record<string, string>[]) {
    const r = await send("DELETE", `/profiles/p/schedules/${sid}`, undefined, h);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toContain("shows the user a card");
  }
  expect(store.getSchedule("p", sid)).toBeTruthy();
  expect((await send("DELETE", `/profiles/p/schedules/${sid}`)).status).toBe(204);
  expect(store.getSchedule("p", sid)).toBeNull();
});

test("a schedule delete with no page: only a program outside the board (the user's own Claude) may; a run's shell or a quick chat can't", async () => {
  const sid = await schedule("Shell target");
  const bare = (headers: Record<string, string> = {}) => fetch(`${base}/api/profiles/p/schedules/${sid}`, { method: "DELETE", headers });
  // A run's shell or a job's command (a process the daemon started), with no header at all.
  outside = false;
  const r = await bare();
  expect(r.status).toBe(403);
  expect(((await r.json()) as any).error).toContain("only the user deletes a schedule");
  // A page the user's browser didn't send (a program faking an Origin) is refused as well.
  fromBoard = true;
  expect((await send("DELETE", `/profiles/p/schedules/${sid}`)).status).toBe(403);
  fromBoard = false;
  // A quick chat's ckanban tools say so: refused even outside the board's process tree.
  outside = true;
  expect((await bare({ [QUICK_CHAT_HEADER]: "p/c_1" })).status).toBe(403);
  expect(store.getSchedule("p", sid)).toBeTruthy();
  // The user's own Claude or terminal (not started by the daemon) still deletes.
  expect((await bare()).status).toBe(204);
  expect(store.getSchedule("p", sid)).toBeNull();
});

test("run now: a huddle helper is refused, and a run can't reach another board's schedule", async () => {
  const sid = await schedule("Helpers can't");
  const tid = await ticket();
  const helper = await send("POST", `/profiles/p/schedules/${sid}/run`, {}, { [RUN_HEADER]: `p/${tid}`, [HUDDLE_HEADER]: "h/x/tok" });
  expect(helper.status).toBe(403);
  expect(((await helper.json()) as any).error).toContain("huddle participants");
  const other = await send("POST", `/profiles/p/schedules/${sid}/run`, {}, { [RUN_HEADER]: `elsewhere/${tid}` });
  expect(other.status).toBe(403);
  expect(store.readScheduleHistory("p", sid).filter((e) => e.kind === "fired" || e.kind === "skipped" || e.kind === "error")).toHaveLength(0);
});

test("run now from a board run is accepted and credited to its ticket in the history", async () => {
  const sid = await schedule("Run me");
  const tid = await ticket();
  const r = await send("POST", `/profiles/p/schedules/${sid}/run`, {}, { [RUN_HEADER]: `p/${tid}` });
  expect(r.status).toBe(200);
  const { entry } = (await r.json()) as any;
  expect(entry.trigger).toBe("manual");
  expect(entry.by).toEqual({ ticketId: tid });
  const h = (await (await send("GET", `/profiles/p/schedules/${sid}/history`)).json()) as any[];
  expect(h.find((e) => e.trigger === "manual")?.by).toEqual({ ticketId: tid });
});

test("the user's Delete on the card deletes the schedule and the card remembers it; runs can't answer it", async () => {
  const sid = await schedule("Weekly report");
  const tid = await ticket();
  const card = `/profiles/p/tickets/${tid}/schedule-delete-cards/toolu_1`;
  // From a run (header) or a program that isn't the user's browser: refused, nothing deleted.
  expect((await send("PUT", card, { state: "deleted", scheduleId: sid }, { [RUN_HEADER]: `p/${tid}` })).status).toBe(403);
  fromBoard = true;
  expect((await send("PUT", card, { state: "deleted", scheduleId: sid })).status).toBe(403);
  fromBoard = false;
  expect(store.getSchedule("p", sid)).toBeTruthy();

  const r = await send("PUT", card, { state: "deleted", scheduleId: sid });
  expect(r.status).toBe(200);
  expect(store.getSchedule("p", sid)).toBeNull();
  expect(store.getTicket("p", tid)!.scheduleDeleteCards?.toolu_1).toMatchObject({ state: "deleted", name: "Weekly report", scheduleId: sid });
  // A second click (another tab) is told it's already done.
  expect((await send("PUT", card, { state: "deleted", scheduleId: sid })).status).toBe(409);
});

test("a stale card: the schedule is already gone; Keep leaves it as it is", async () => {
  const tid = await ticket();
  const gone = await send("PUT", `/profiles/p/tickets/${tid}/schedule-delete-cards/toolu_2`, { state: "deleted", scheduleId: "s_gone" });
  expect(gone.status).toBe(404);
  expect(((await gone.json()) as any).error).toContain("no longer on the board");
  expect(store.getTicket("p", tid)!.scheduleDeleteCards?.toolu_2).toBeUndefined();

  const sid = await schedule("Keep me");
  expect((await send("PUT", `/profiles/p/tickets/${tid}/schedule-delete-cards/toolu_3`, { state: "kept" })).status).toBe(200);
  expect(store.getSchedule("p", sid)).toBeTruthy();
  expect(store.getTicket("p", tid)!.scheduleDeleteCards?.toolu_3?.state).toBe("kept");
});

test("an open schedule delete card flags the ticket as needing the user until answered or the schedule is gone", () => {
  const t = { id: "t_1", title: "Nightly run", body: "", status: "review", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" } as any;
  const s = {
    title: null, lastMessage: null, artifacts: [], updatedAt: "2026-11-12T00:00:00Z", openQuestions: 0, pendingProposal: null, pendingNewTickets: [],
    pendingTeammates: [], pendingScheduleDeletes: [{ uuid: "toolu_1", id: "s1" }],
  } as SessionSummary;
  expect(attentionFor(t, s, false, { schedules: new Set(["s1"]) })?.label).toBe("Confirm deleting a schedule");
  expect(attentionFor({ ...t, scheduleDeleteCards: { toolu_1: { state: "kept", at: "" } } }, s, false, { schedules: new Set(["s1"]) })?.label).toBe("Ready for review");
  expect(attentionFor(t, s, false, { schedules: new Set() })?.label).toBe("Ready for review");
});
