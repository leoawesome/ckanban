import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { fakes, harness } from "./fake-chrome";
import { tempDir } from "./helpers";

// The board browser routes: a run, its shell or any other program can list them and restart one a run is using,
// never remove one (its logins), add, rename, open or close it.

let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;
let userBrowser = true;

beforeAll(async () => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false", browserDeps: harness(store.root).deps });
  mkdirSync(join(store.root, "browsers", "fatt-interior-whatsapp"), { recursive: true });
  await board.boardBrowsers.init();
  server = createServer({ store, bus: new Bus(), board, port: 0, webDir: tempDir("ck-web-"), isUserBrowser: async () => userBrowser });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  for (const f of fakes.splice(0)) if (!f.closed) f.quit();
});

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${base}/api/board-browsers${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("only the user's browser on the board changes board browsers; a run's shell can't remove one", async () => {
  const folder = join(store.root, "browsers", "fatt-interior-whatsapp");
  // A run's shell: no Origin, no run header.
  expect((await call("DELETE", "/fatt-interior-whatsapp")).status).toBe(403);
  expect((await call("POST", "", {}, { name: "X" })).status).toBe(403);
  expect((await call("POST", "/fatt-interior-whatsapp/open")).status).toBe(403);
  // With the board's Origin but from another program.
  userBrowser = false;
  expect((await call("DELETE", "/fatt-interior-whatsapp", { origin: base })).status).toBe(403);
  // A board run.
  userBrowser = true;
  expect((await call("PATCH", "/fatt-interior-whatsapp", { origin: base, "x-ckanban-run": "p/t_1" }, { name: "Y" })).status).toBe(403);
  expect(existsSync(folder)).toBe(true);
  // Anyone may list.
  const list = (await (await call("GET", "")).json()) as { boardBrowsers: { id: string }[] };
  expect(list.boardBrowsers.map((b: any) => b.id)).toEqual(["fatt-interior-whatsapp"]);
  // Restart only for a browser a run is using.
  expect((await call("POST", "/fatt-interior-whatsapp/ensure")).status).toBe(409);
  await board.boardBrowsers.acquire("p/t_1", ["fatt-interior-whatsapp"]);
  expect((await call("POST", "/fatt-interior-whatsapp/ensure")).status).toBe(200);
  board.boardBrowsers.release("p/t_1");
  // The user, from the board.
  expect((await call("PATCH", "/fatt-interior-whatsapp", { origin: base }, { name: "Shop" })).status).toBe(200);
  expect((await call("DELETE", "/fatt-interior-whatsapp", { origin: base })).status).toBe(200);
  expect(existsSync(folder)).toBe(false);
});
