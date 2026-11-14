// A card's costly parts (its links from Claude's comments, the tickets above it) are kept while what they come from
// is the same: a write to an unrelated ticket doesn't rebuild every card that shows other tickets.
import { afterAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const store = new Store(tempDir("ck-cardcache-"));
store.saveProfile({ name: "C", slug: "c", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
const bus = new Bus();
const sessions = new SessionCache({ configDir: tempDir("ck-claude-") });
const board = new Board(store, bus, { claudeBin: "/bin/false", sessionSummary: (id) => sessions.summary(id) });
const server = createServer({ store, bus, board, sessions, port: 0, webDir: tempDir("ck-web-") });
afterAll(() => server.stop(true));

const cards = async () => {
  const r = await fetch(`http://127.0.0.1:${server.port}/api/profiles/c/tickets?scope=board&done=20`);
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  return (b.tickets ?? b) as any[];
};

test("an unrelated write keeps a task's card parts; a change above it shows at once", async () => {
  const main = store.updateTicket("c", store.createTicket("c", { title: "Feature", body: "", status: "review" }).id, { main: true } as any);
  const task = store.updateTicket("c", store.createTicket("c", { title: "Task", body: "", status: "backlog" }).id, { tool: true, partOf: main.id } as any);
  const other = store.createTicket("c", { title: "Other", body: "", status: "backlog" });
  expect((await cards()).find((t) => t.id === task.id)?.mainTicket).toEqual({ id: main.id, title: "Feature" });

  const read: string[] = [];
  const aiComments = store.aiComments.bind(store);
  store.aiComments = ((slug: string, id: string) => (read.push(id), aiComments(slug, id))) as typeof store.aiComments;
  try {
    store.updateTicket("c", other.id, { title: "Other renamed" });
    await cards();
    expect(read).not.toContain(task.id);
    store.updateTicket("c", main.id, { title: "Feature renamed" });
    expect((await cards()).find((t) => t.id === task.id)?.mainTicket).toEqual({ id: main.id, title: "Feature renamed" });
    expect(read).toContain(task.id);
  } finally {
    store.aiComments = aiComments;
  }
});
