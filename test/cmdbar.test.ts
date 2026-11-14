// ⌘K's ticket rows: open tickets at once, Done ones by a search on the daemon (cmdbar.ts), on a board with thousands
// of Done tickets.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandRows, type CmdRow } from "../src/server/cmdbar";
import { Store } from "../src/server/store";
import { rankTickets } from "../web/src/fuzzy";
import { tempDir } from "./helpers";

const DONE = 3000;
const WORDS = "retry upload phone layout cache spend inbox huddle schedule theme sync modal".split(" ");
const store = new Store(tempDir("ck-home-"));
for (const [slug, name] of [["a", "Alpha"], ["b", "Beta"]]) {
  store.saveProfile({ name, slug, path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
}
// Board a: DONE finished tickets (copies of one ticket file: much faster than Store writes) and 30 open ones.
const first = store.createTicket("a", { title: "x", body: "", status: "done" });
const template = readFileSync(join(store.root, "profiles", "a", "tickets", first.id, "ticket.md"), "utf8");
for (let i = 0; i < DONE + 30; i++) {
  const id = `t_20261001_${i.toString(36).padStart(4, "0")}`;
  const dir = join(store.root, "profiles", "a", "tickets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ticket.md"), template
    .replace(`id: ${first.id}`, `id: ${id}`)
    .replace("title: x", `title: Fix ${WORDS[i % WORDS.length]} ${i}`)
    .replace("status: done", `status: ${i < DONE ? "done" : "backlog"}`)
    .replace(/updatedAt: .*/, `updatedAt: '${new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()}'`));
  writeFileSync(join(dir, "comments.jsonl"), JSON.stringify({ id: `c${i}`, author: "ai", text: `Run ${i}: changed the ${WORDS[(i * 5) % WORDS.length]} code`, at: "2026-10-01T00:00:00.000Z" }) + "\n");
}
rmSync(join(store.root, "profiles", "a", "tickets", first.id), { recursive: true, force: true });
// Board b: a feature with a hidden Done tool ticket, a hidden Done tool ticket on its own, and an open ticket.
const main = store.createTicket("b", { title: "Zebra feature", body: "", status: "review" });
store.updateTicket("b", main.id, { main: true } as any);
const tool = store.createTicket("b", { title: "Zebra helper step", body: "", status: "done" });
store.updateTicket("b", tool.id, { tool: true, partOf: main.id } as any);
const loose = store.createTicket("b", { title: "Zebra loose step", body: "", status: "done" });
store.updateTicket("b", loose.id, { tool: true } as any);
const pr = store.createTicket("b", { title: "Old thing", body: "", status: "done" });
store.updateTicket("b", pr.id, { prUrl: "https://github.com/o/r/pull/4242" });

const rows = new CommandRows(store, () => false);

test("open: every ticket that isn't Done on every board, with its last result", async () => {
  const open = await rows.open();
  expect(open.every((r) => r.status !== "done")).toBe(true);
  expect(open.filter((r) => r.profile === "a")).toHaveLength(30);
  expect(open.find((r) => r.profile === "b" && r.id === main.id)?.profileName).toBe("Beta");
  expect(open.find((r) => r.id === `t_20261001_${DONE.toString(36).padStart(4, "0")}`)?.summary).toContain(`Run ${DONE}:`);
});

/** What the old bar found: every Done row ranked in the browser. */
const brute = (all: CmdRow[], q: string, current: string | null) =>
  rankTickets(all.filter((r) => r.mainTicket !== null), q, current, 20).map((h) => `${h.row.profile}/${h.row.id}`);

test(`a Done search over ${DONE} tickets gives the same best 20 the bar found ranking every row`, async () => {
  // Every Done row, as the old route built them (tool tickets with their main ticket).
  const all: CmdRow[] = [];
  for (const q of ["upload", "fix sync 12", "changed the theme", "fxupl", "pull/4242", "Zebra"]) {
    const found = await rows.searchDone(q, "a");
    if (!all.length) {
      for (const slug of ["a", "b"]) {
        for (const t of store.listTickets(slug)) {
          if (t.status !== "done") continue;
          const r = (rows as any).row({ slug, name: slug === "a" ? "Alpha" : "Beta" }, t);
          all.push((rows as any).withMain(r, t, (rows as any).byIdOf(slug)));
        }
      }
    }
    expect(found.map((r) => `${r.profile}/${r.id}`)).toEqual(brute(all, q, "a"));
    expect(found.length).toBeLessThanOrEqual(20);
  }
});

test("a hidden step is found as its main ticket; one without a main ticket isn't listed", async () => {
  const found = await rows.searchDone("Zebra", null);
  expect(found.find((r) => r.id === tool.id)?.mainTicket).toEqual({ id: main.id, title: "Zebra feature" });
  expect(found.find((r) => r.id === loose.id)).toBeUndefined();
});

test("a new result is searched at once; nothing typed finds nothing", async () => {
  expect(await rows.searchDone("  ", "a")).toEqual([]);
  expect(await rows.searchDone("kumquat", "a")).toEqual([]);
  store.addComment("b", pr.id, "ai", "Moved the kumquat parser.");
  expect((await rows.searchDone("kumquat", "a")).map((r) => r.id)).toEqual([pr.id]);
});

test("a later search reads no comment file and freezes for no more than its slices", async () => {
  await rows.searchDone("upload", "a");
  const read = store.lastAiComment.bind(store);
  let reads = 0;
  store.lastAiComment = (s: string, id: string) => (reads++, read(s, id));
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  const found = await rows.searchDone("cache", "a");
  await Bun.sleep(20);
  clearInterval(timer);
  store.lastAiComment = read;
  expect(found).toHaveLength(20);
  expect(reads).toBe(0);
  expect(worst).toBeLessThan(250);
});
