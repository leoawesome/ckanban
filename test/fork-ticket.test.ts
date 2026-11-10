// Board: Fork from here on a ticket, Undo rewind on a ticket, and rewind / undo / fork in quick chats.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRewind } from "../src/server/rewind";
import { QuickChats } from "../src/server/quickchat";
import { parseSession } from "../src/server/session";
import { tempDir } from "./helpers";
import { board, bus, setup, store, useBoardEnv, FAKE } from "./board-env";

useBoardEnv();

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Two exchanges in session `sid`, run in `cwd`, under the temp CLAUDE_CONFIG_DIR. */
function fakeSession(configDir: string, cwd: string, sid: string): string {
  const dir = join(configDir, "projects", encode(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  const ev = (type: string, uuid: string, s: number, text: string) => ({
    type, uuid, sessionId: sid, cwd, timestamp: `2026-11-10T01:00:0${s}Z`,
    message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
  });
  writeFileSync(file, [ev("user", "u1", 0, "first"), ev("assistant", "a1", 1, "one"), ev("user", "u2", 2, "second"), ev("assistant", "a2", 3, "two")]
    .map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const texts = (file: string) => parseSession(readFileSync(file, "utf8")).entries.map((e) => e.text);

async function withConfig<T>(f: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = tempDir("ck-claude-");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await f(configDir);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}

test("forkTicket: its own card linked by branchedFrom, chat cut before the message, numbered titles, source untouched", () => withConfig(async (configDir) => {
  const p = await setup({ git: false });
  const src = await board.createTicket("p", { title: "Notes", body: "b", status: "ready" });
  await board.whenIdle();
  const s = store.getTicket("p", src.id)!;
  const file = fakeSession(configDir, p.path, s.sessionId!);
  const raw = readFileSync(file, "utf8");

  const { ticket: f1 } = await board.forkTicket("p", src.id, "u2");
  expect(f1).toMatchObject({ title: "Notes (fork)", status: "planning", branchedFrom: src.id, sessionStarted: true });
  expect(f1.parentId ?? null).toBeNull();
  const copy = join(configDir, "projects", encode(p.path), `${f1.sessionId}.jsonl`);
  expect(texts(copy)).toEqual(["first", "one"]);

  // The first message: an empty chat that starts a new session.
  const { ticket: f2 } = await board.forkTicket("p", src.id, "u1");
  expect(f2).toMatchObject({ title: "Notes (fork 2)", sessionStarted: false, freshSession: true });

  // A fork of a fork drops the old suffix.
  const { ticket: f3 } = await board.forkTicket("p", f1.id, "u1");
  expect(f3.title).toBe("Notes (fork 3)");

  await expect(board.forkTicket("p", src.id, "a1")).rejects.toThrow("can't be forked");
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect(store.getTicket("p", src.id)).toEqual(s);
}));

test("undoRewind on a ticket emptied by its rewind: the old session comes back; refused once the new one started", () => withConfig(async (configDir) => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "Notes", body: "", status: "ready" });
  await board.whenIdle();
  const sid = store.getTicket("p", t.id)!.sessionId!;
  const file = fakeSession(configDir, p.path, sid);
  const raw = readFileSync(file, "utf8");
  const entry = parseSession(raw).entries.find((e) => e.uuid === "u1")!;

  expect(await board.undoRewindBlocked("p", t.id, true)).toBe("There is no rewind to undo.");
  const r = await applyRewind({ dir: null, ticketId: t.id, entry, sessionFile: file, files: true, sessionId: sid });
  expect(r.cut.empty).toBe(true);
  const after = board.rewound("p", t.id, true, { ...r.undo, messages: 4 });
  expect(after.sessionId).not.toBe(sid);
  expect(after.rewindUndo?.newSessionId).toBe(after.sessionId);

  expect(await board.undoRewindBlocked("p", t.id, true)).toBeNull();
  expect(await board.undoRewind("p", t.id, true)).toEqual({ messages: 4, files: 0, filesRestored: false, filesReason: "unchanged" });
  expect(store.getTicket("p", t.id)).toMatchObject({ sessionId: sid, sessionStarted: true, freshSession: false, rewindUndo: null });
  expect(readFileSync(file, "utf8")).toBe(raw);
  await expect(board.undoRewind("p", t.id, true)).rejects.toThrow("no rewind to undo");

  // Rewind again, then a message starts the new session: undo would lose it.
  const r2 = await applyRewind({ dir: null, ticketId: t.id, entry, sessionFile: file, files: true, sessionId: sid });
  board.rewound("p", t.id, true, { ...r2.undo, messages: 4 });
  await board.chat("p", t.id, "start over");
  await board.whenIdle();
  expect(await board.undoRewindBlocked("p", t.id, true)).toContain("moved on");
}));

test("quick chats: fork from here, rewind (chat only) and undo", () => withConfig(async (configDir) => {
  const p = await setup({ git: false });
  const chats = new QuickChats(store, bus, board, { claudeBin: FAKE, mcp: () => "{}" });
  try {
    const c = chats.send("p", null, "first");
    await chats.idle();
    const sid = chats.get("p", c.id)!.sessionId;
    const file = fakeSession(configDir, p.path, sid);
    const raw = readFileSync(file, "utf8");
    const entries = parseSession(raw).entries;

    const f = chats.fork("p", c.id, "u2");
    expect(f).toMatchObject({ title: "first (fork)", started: true });
    expect(texts(join(configDir, "projects", encode(p.path), `${f.sessionId}.jsonl`))).toEqual(["first", "one"]);
    expect(chats.fork("p", c.id, "u1")).toMatchObject({ title: "first (fork 2)", started: false });
    expect(readFileSync(file, "utf8")).toBe(raw);

    const r = await chats.rewind("p", c.id, entries.find((e) => e.uuid === "u2")!, entries);
    expect(r).toEqual({ text: "second", restored: 0, messages: 2, files: 0, undo: true });
    expect(texts(file)).toEqual(["first", "one"]);
    expect(await chats.undoRewindBlocked("p", c.id)).toBeNull();
    expect((await chats.undoRewind("p", c.id)).messages).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(chats.get("p", c.id)!.rewindUndo).toBeNull();
  } finally {
    await chats.shutdown();
  }
}));

test("one rewind, undo or fork at a time: a second one and a message are refused while it runs", () => withConfig(async (configDir) => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "Notes", body: "", status: "ready" });
  await board.whenIdle();
  fakeSession(configDir, p.path, store.getTicket("p", t.id)!.sessionId!);
  let release!: () => void;
  const first = board.withRewind("p", t.id, () => new Promise<void>((r) => (release = r)));
  await expect(board.withRewind("p", t.id, async () => {})).rejects.toThrow("Try again in a moment");
  await expect(board.undoRewind("p", t.id, true)).rejects.toThrow("Try again in a moment");
  await expect(board.forkTicket("p", t.id, "u2")).rejects.toThrow("Try again in a moment");
  await expect(board.chat("p", t.id, "hello")).rejects.toThrow("Try again in a moment");
  expect(board.rewindBlocked("p", t.id, true)).toBeNull();
  release();
  await first;
  expect(board.rewindBlocked("p", t.id)).toBeNull();
}));

test("undo and fork are refused while Claude works", () => withConfig(async (configDir) => {
  const p = await setup({ git: false });
  const t = await board.createTicket("p", { title: "Notes", body: "", status: "ready" });
  await board.whenIdle();
  const sid = store.getTicket("p", t.id)!.sessionId!;
  const file = fakeSession(configDir, p.path, sid);
  const entry = parseSession(readFileSync(file, "utf8")).entries.find((e) => e.uuid === "u2")!;
  const r = await applyRewind({ dir: null, ticketId: t.id, entry, sessionFile: file, files: true, sessionId: sid });
  board.rewound("p", t.id, false, { ...r.undo, messages: 2 });
  process.env.FAKE_MODE = "slow";
  await board.chat("p", t.id, "go on");
  await expect(board.undoRewind("p", t.id, true)).rejects.toThrow("Claude is working");
  await expect(board.forkTicket("p", t.id, "u1")).rejects.toThrow("Claude is working");
  expect(store.listTickets("p")).toHaveLength(1);
  board.stop("p", t.id);
  await board.whenIdle();
}));
