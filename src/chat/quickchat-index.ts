// The Ask tab's chat list: a board's quick chats newest first, kept between lists. A chat file is parsed again only
// when its mtime or size changed, and the folder isn't walked at all while its own mtime stays the same (saving a
// chat renames a new file into it, so any save or delete changes it). The daemon's own saves update the index
// directly. The list goes out in pages of 50 (the "Load older" row), so a board with thousands of chats sends little.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the index needs of a chat (QuickChat in quickchat.ts). */
export interface IndexedChat {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** Chats per page of the Ask tab's list. */
export const CHAT_PAGE = 50;

type Entry<C> = { key: string; chat: C };
type Board<C> = { dirKey: string | null; files: Map<string, Entry<C>>; sorted: C[] | null };

const statKey = (path: string): string | null => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
};

/** Newest first: last message, then created, then id (so two chats never tie and pages never overlap). */
const newer = (a: IndexedChat, b: IndexedChat) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** A page ends at a chat; the next one starts after it in this order (the cursor names the chat's place). */
export const cursorOf = (c: IndexedChat) => `${c.updatedAt}|${c.createdAt}|${c.id}`;
const parseCursor = (s: string): IndexedChat | null => {
  const [updatedAt, createdAt, id] = s.split("|");
  return updatedAt && createdAt && id ? { updatedAt, createdAt, id } : null;
};

export class ChatIndex<C extends IndexedChat> {
  private boards = new Map<string, Board<C>>();

  /** dir: the board's chats folder; parse: one chat file's chat, or null when it can't be read. */
  constructor(private dir: (slug: string) => string, private parse: (slug: string, id: string) => C | null) {}

  /** Steps of bringing the board's index up to date; yields after each file it had to look at. */
  private *steps(slug: string): Generator<void, C[]> {
    const dir = this.dir(slug);
    const dirKey = statKey(dir);
    let b = this.boards.get(slug);
    if (!b) this.boards.set(slug, (b = { dirKey: null, files: new Map(), sorted: null }));
    if (dirKey === null) {
      b.files.clear();
      b.dirKey = null;
      return (b.sorted = []);
    }
    // The folder didn't change since the last walk (or only by the daemon's own saves, already in the index).
    if (b.dirKey === dirKey) return (b.sorted ??= [...b.files.values()].map((e) => e.chat).sort(newer));
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => /^[a-z0-9]+\.json$/.test(f));
    } catch {
      names = [];
    }
    const present = new Set<string>();
    for (const f of names) {
      const id = f.slice(0, -5);
      present.add(id);
      const key = statKey(join(dir, f));
      const hit = b.files.get(id);
      if (key && hit?.key === key) continue;
      const chat = key ? this.parse(slug, id) : null;
      if (chat) b.files.set(id, { key: key!, chat });
      else b.files.delete(id);
      b.sorted = null;
      yield;
    }
    for (const id of b.files.keys()) {
      if (!present.has(id)) {
        b.files.delete(id);
        b.sorted = null;
      }
    }
    b.sorted ??= [...b.files.values()].map((e) => e.chat).sort(newer);
    // The folder's mtime from before the walk: a save during it changes the folder again, so the next list looks.
    b.dirKey = dirKey;
    return b.sorted;
  }

  /** Every chat, newest first, brought up to date now (shared: don't change it). */
  all(slug: string): C[] {
    const g = this.steps(slug);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
    }
  }

  /** The same, pausing between files (`pause` from lag.ts' pauser), so a cold board's thousands of chats don't freeze the daemon. */
  async allSliced(slug: string, pause: () => Promise<void>): Promise<C[]> {
    const g = this.steps(slug);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      await pause();
    }
  }

  /**
   * A page of chats newest first: the first `limit`, or the `limit` after the chat `before` names (cursorOf). A chat
   * that gets a message meanwhile moves above every page already sent (its place is newer), so the next page neither
   * repeats it nor skips one. next: the cursor of the page's last chat, null when no older chat is left.
   */
  page(sorted: C[], limit = CHAT_PAGE, before: string | null = null): { chats: C[]; next: string | null } {
    const n = Math.max(1, Math.min(Math.floor(limit) || CHAT_PAGE, 200));
    const after = before ? parseCursor(before) : null;
    let from = 0;
    if (after) {
      // Binary search: the first chat older than the cursor.
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (newer(sorted[mid]!, after) <= 0) lo = mid + 1;
        else hi = mid;
      }
      from = lo;
    }
    const chats = sorted.slice(from, from + n);
    return { chats, next: from + n < sorted.length && chats.length ? cursorOf(chats.at(-1)!) : null };
  }

  /**
   * After the daemon saved or deleted a chat itself (chat: null): the index takes it without walking the folder
   * again. `write` does the change; the folder's mtime before and after tell whether anything else changed in it
   * since the last walk (then the next list walks it as usual).
   */
  wrote(slug: string, id: string, write: () => void, chat: C | null): void {
    const dir = this.dir(slug);
    const b = this.boards.get(slug);
    const before = b ? statKey(dir) : null;
    write();
    if (!b) return;
    const key = chat ? statKey(join(dir, `${id}.json`)) : null;
    if (chat && key) b.files.set(id, { key, chat });
    else b.files.delete(id);
    b.sorted = null;
    b.dirKey = before !== null && before === b.dirKey ? statKey(dir) : null;
  }
}
