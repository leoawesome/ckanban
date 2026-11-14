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

test("a run's live activity event goes out without its long strings; the stored log keeps them", async () => {
  const store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  const tabs = new AbortController();
  try {
    store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
    const t = store.createTicket("p", { title: "x", body: "", status: "backlog" });
    let got = "";
    const r = await fetch(`http://127.0.0.1:${server.port}/api/events`, { signal: tabs.signal });
    const reader = r.body!.getReader();
    void (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        got += dec.decode(value);
      }
    })();
    await until(() => got.includes("connected"));
    const big = "x".repeat(500 * 1024);
    const event = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: big }] } };
    bus.emit({ type: "activity", profile: "p", id: t.id, run: 1, event });
    bus.emit({ type: "activity", profile: "p", id: t.id, run: 1, event: { type: "result", subtype: "success", result: "Done." } });
    await until(() => got.includes('"result"'));
    const lines = got.split("\n\n").filter((l) => l.includes('"activity"'));
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeLessThan(3000);
    const sent = JSON.parse(lines[0].slice(6));
    // The page reads the event's type (Chat.tsx, UsagePanel.tsx): the shape stays, only the long text is cut.
    expect(sent.event.type).toBe("user");
    expect(sent.event.message.content[0].tool_use_id).toBe("tu1");
    expect(sent.event.message.content[0].content).toStartWith("x".repeat(2000) + "… (");
    expect(JSON.parse(lines[1].slice(6)).event).toEqual({ type: "result", subtype: "success", result: "Done." });
    // The event itself (what the board and the activity log use) is untouched.
    expect(event.message.content[0].content).toBe(big);
  } finally {
    tabs.abort();
    server.stop(true);
  }
});
