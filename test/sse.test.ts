import { expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir, until } from "./helpers";

test("a ticket change is built once and sent the same to every open tab", async () => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  const tabs = new AbortController();
  try {
    store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
    const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
    const got: string[] = ["", ""];
    for (const i of [0, 1]) {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/events`, { signal: tabs.signal });
      const reader = r.body!.getReader();
      void (async () => {
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          got[i] += dec.decode(value);
        }
      })();
    }
    await until(() => got.every((g) => g.includes("connected")));
    // view() asks the board for its huddles once per build.
    let builds = 0;
    const hosts = board.hostHuddles.bind(board);
    board.hostHuddles = (slug: string) => (builds++, hosts(slug));
    bus.emit({ type: "ticket.updated", profile: "p", ticket: t });
    await until(() => got.every((g) => g.includes('"ticket.updated"')));
    expect(builds).toBe(1);
    const event = (g: string) => g.split("\n\n").find((l) => l.includes('"ticket.updated"'));
    expect(event(got[0])).toBe(event(got[1]));
    expect(JSON.parse(event(got[0])!.slice(6)).ticket).toMatchObject({ id: t.id, running: false });
  } finally {
    tabs.abort();
    server.stop(true);
  }
});
