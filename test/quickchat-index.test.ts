// The Ask tab's chat list in pages of 50 ("Load older"), from an index kept between lists (quickchat-index.ts).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../src/server/store";
import { ChatIndex, cursorOf, type IndexedChat } from "../src/server/quickchat-index";
import { tempDir } from "./helpers";

type Chat = IndexedChat & { title: string };
const CHATS = 3000;
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

function bigFolder() {
  const root = tempDir("ck-chats-");
  const dir = join(root, "chats");
  mkdirSync(dir, { recursive: true });
  // Every tenth chat shares its updatedAt with the one before, so ties are paged too.
  for (let i = 0; i < CHATS; i++) {
    const t = at(i - (i % 10 === 1 ? 1 : 0));
    writeFileSync(join(dir, `c${i}.json`), JSON.stringify({ id: `c${i}`, title: `Chat ${i}`, createdAt: at(i), updatedAt: t }));
  }
  writeFileSync(join(dir, "c1.activity.jsonl"), "{}\n");
  let parsed = 0;
  const index = new ChatIndex<Chat>(() => dir, (_s, id) => {
    parsed++;
    try {
      return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    } catch {
      return null;
    }
  });
  return { dir, index, parsed: () => parsed };
}

/** Every page from the first, following next, as the Ask tab's "Load older" does. */
function allPages(index: ChatIndex<Chat>, between?: (page: number) => void) {
  const seen: string[] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const p = index.page(index.all("b"), 50, next);
    expect(p.chats.length).toBeLessThanOrEqual(50);
    seen.push(...p.chats.map((c) => c.id));
    next = p.next;
    pages++;
    between?.(pages);
  } while (next);
  return { seen, pages };
}

test(`${CHATS} chats come 50 at a time, newest first, with no gaps or doubles`, () => {
  const { index } = bigFolder();
  const first = index.page(index.all("b"));
  expect(first.chats).toHaveLength(50);
  expect(first.chats[0]!.id).toBe(`c${CHATS - 1}`);
  const { seen, pages } = allPages(index);
  expect(pages).toBe(CHATS / 50);
  expect(new Set(seen).size).toBe(CHATS);
  // Newest first (ties by created, then id).
  const sorted = index.all("b");
  for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1]!.updatedAt >= sorted[i]!.updatedAt).toBe(true);
});

test("a chat that gets a message between pages moves to the top and isn't sent twice; none is skipped", () => {
  const { dir, index } = bigFolder();
  const write = (id: string, updatedAt: string) =>
    index.wrote("b", id, () => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: id, createdAt: at(0), updatedAt })), { id, title: id, createdAt: at(0), updatedAt });
  const shown = new Set<string>();
  const { seen } = allPages(index, (page) => {
    // After page 3: a chat further down gets a message (the page already has the top; the event moves it there).
    if (page === 3) write("c100", at(99_999));
    // After page 5: a chat already shown gets one too.
    if (page === 5) write(`c${CHATS - 1}`, at(100_000));
  });
  for (const id of seen) {
    expect(shown.has(id)).toBe(false);
    shown.add(id);
  }
  // c100 moved above the pages already sent: the only chat not paged (the page gets it from the live event).
  expect(seen).not.toContain("c100");
  expect(seen).toHaveLength(CHATS - 1);
  expect(index.page(index.all("b")).chats.slice(0, 2).map((c) => c.id)).toEqual([`c${CHATS - 1}`, "c100"]);
});

test("a second list reads no chat file; a changed, added or deleted file is picked up", () => {
  const { dir, index, parsed } = bigFolder();
  index.all("b");
  expect(parsed()).toBe(CHATS);
  index.all("b");
  expect(parsed()).toBe(CHATS);
  // Changed by something else (its mtime and size), a new one, a deleted one.
  writeFileSync(join(dir, "c5.json"), JSON.stringify({ id: "c5", title: "Renamed by hand", createdAt: at(5), updatedAt: at(50_000) }));
  utimesSync(join(dir, "c5.json"), new Date(), new Date(Date.now() + 5000));
  writeFileSync(join(dir, "cnew.json"), JSON.stringify({ id: "cnew", title: "New", createdAt: at(60_000), updatedAt: at(60_000) }));
  rmSync(join(dir, "c7.json"));
  const list = index.all("b");
  expect(parsed()).toBe(CHATS + 2);
  expect(list.map((c) => c.id).slice(0, 2)).toEqual(["cnew", "c5"]);
  expect(list.find((c) => c.id === "c7")).toBeUndefined();
  expect(list).toHaveLength(CHATS);
});

test("the daemon's own save and delete update the index without reading the folder again", () => {
  const { dir, index, parsed } = bigFolder();
  index.all("b");
  const c = { id: "c3", title: "Saved", createdAt: at(3), updatedAt: at(70_000) };
  // As QuickChats.save does: a temp file renamed over the chat's file.
  index.wrote("b", "c3", () => atomicWrite(join(dir, "c3.json"), JSON.stringify(c)), c);
  index.wrote("b", "c9", () => rmSync(join(dir, "c9.json")), null);
  const list = index.all("b");
  expect(list[0]).toEqual(c);
  expect(list.find((x) => x.id === "c9")).toBeUndefined();
  expect(parsed()).toBe(CHATS);
});

test("a cursor goes on after its chat even if that chat is gone", () => {
  const { index } = bigFolder();
  const sorted = index.all("b");
  const cut = cursorOf(sorted[49]!);
  const p = index.page(sorted.filter((_, i) => i !== 49), 50, cut);
  expect(p.chats[0]!.id).toBe(sorted[50]!.id);
});

test("the sliced walk freezes for no more than its slices on a cold folder", async () => {
  const { index } = bigFolder();
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  const { pauser } = await import("../src/server/lag");
  const list = await index.allSliced("b", pauser());
  await Bun.sleep(20);
  clearInterval(timer);
  expect(list).toHaveLength(CHATS);
  expect(worst).toBeLessThan(250);
});
