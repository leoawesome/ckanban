// Fork from here (a copy of the chat cut before a message) and Undo rewind, without a server.
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forkSessionBefore, forkTitle } from "../src/server/fork";
import { run } from "../src/server/git";
import { applyRewind, applyUndo, listSnapshots, takeSnapshot, undoBlocked, UNDO_REFS, type RewindUndo } from "../src/server/rewind";
import { parseSession } from "../src/server/session";
import { tempDir } from "./helpers";

const line = (type: "user" | "assistant", uuid: string, ms: number, text: string, sid = "s1", cwd = "/w") => JSON.stringify({
  type, uuid, sessionId: sid, cwd, timestamp: new Date(ms).toISOString(),
  message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
});

const texts = (file: string) => parseSession(readFileSync(file, "utf8")).entries.map((e) => e.text);

function transcript(): { file: string; raw: string } {
  const dir = tempDir("ck-src-");
  const T = Date.parse("2026-11-10T10:00:00Z");
  const raw = ["first", "second", "third"].flatMap((t, i) => [line("user", `u${i}`, T + i * 1000, t), line("assistant", `a${i}`, T + i * 1000 + 500, `done ${t}`)]).join("\n") + "\n";
  const file = join(dir, "s1.jsonl");
  writeFileSync(file, raw);
  return { file, raw };
}

test("fork before a middle message: the copy ends just before it, under the new id; the source is unchanged", () => {
  const { file, raw } = transcript();
  const config = tempDir("ck-claude-");
  const dest = forkSessionBefore(file, "u1", { fromId: "s1", toId: "s2", fromCwd: "/w", toCwd: "/w" }, config)!;
  expect(texts(dest)).toEqual(["first", "done first"]);
  expect(readFileSync(dest, "utf8").trim().split("\n").map((l) => JSON.parse(l).sessionId)).toEqual(["s2", "s2"]);
  expect(readFileSync(file, "utf8")).toBe(raw);
});

test("fork before the first message: no session is made; a message that can't be cut at is refused", () => {
  const { file, raw } = transcript();
  const config = tempDir("ck-claude-");
  expect(forkSessionBefore(file, "u0", { fromId: "s1", toId: "s3", fromCwd: "/w", toCwd: "/w" }, config)).toBeNull();
  expect(existsSync(join(config, "projects"))).toBe(false);
  expect(() => forkSessionBefore(file, "a1", { fromId: "s1", toId: "s4", fromCwd: "/w", toCwd: "/w" }, config)).toThrow("can't be forked");
  expect(() => forkSessionBefore(file, "nope", { fromId: "s1", toId: "s4", fromCwd: "/w", toCwd: "/w" }, config)).toThrow("can't be forked");
  expect(readFileSync(file, "utf8")).toBe(raw);
});

test("fork titles number up and a fork of a fork doesn't pile up suffixes", () => {
  expect(forkTitle("Add export", [])).toBe("Add export (fork)");
  expect(forkTitle("Add export", ["Add export", "add export (fork)"])).toBe("Add export (fork 2)");
  expect(forkTitle("Add export", ["Add export (fork)", "Add export (fork 2)"])).toBe("Add export (fork 3)");
  expect(forkTitle("Add export (fork 2)", ["Add export (fork)", "Add export (fork 2)"])).toBe("Add export (fork 3)");
  expect(forkTitle("Add export (fork)", [])).toBe("Add export (fork)");
  const long = forkTitle("a".repeat(100), [], 80);
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("… (fork)")).toBe(true);
});

// ---- Undo rewind ----

async function project() {
  const dir = tempDir("ck-proj-");
  await run(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hi\n");
  await run(["git", "add", "."], dir);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], dir);
  return dir;
}

/** Three exchanges; Claude adds two.txt in the second and three.txt in the third, snapshots as the board takes them. */
async function chat(dir: string) {
  const T = Date.now() - 60_000;
  const lines: string[] = [];
  const t = ["first", "second", "third"];
  for (let i = 0; i < 3; i++) {
    await takeSnapshot(dir, "t_1", t[i], T + i * 10_000);
    lines.push(line("user", `u${i}`, T + i * 10_000 + 500, t[i]), line("assistant", `a${i}`, T + i * 10_000 + 900, `done ${t[i]}`));
    if (i === 1) writeFileSync(join(dir, "two.txt"), "from exchange 2\n");
    if (i === 2) writeFileSync(join(dir, "three.txt"), "from exchange 3\n");
  }
  const sessionFile = join(tempDir("ck-claude-"), "s1.jsonl");
  writeFileSync(sessionFile, lines.join("\n") + "\n");
  const entry = parseSession(readFileSync(sessionFile, "utf8")).entries.find((e) => e.uuid === "u1")!;
  return { sessionFile, entry, raw: readFileSync(sessionFile, "utf8") };
}

const here = { sessionId: "s1", started: true };

test("undo after a rewind with files: the chat and the files come back, and the removed messages' snapshots too", async () => {
  const dir = await project();
  const { sessionFile, entry, raw } = await chat(dir);
  // A change of the user's that no message saved: the rewind takes it away too, undo must bring it back.
  writeFileSync(join(dir, "README.md"), "edited by hand\n");
  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1" });
  expect(r.restored).toBe(3);
  expect(existsSync(join(dir, "two.txt"))).toBe(false);
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hi\n");
  expect((await listSnapshots(dir, "t_1")).length).toBe(2);
  const u: RewindUndo = { ...r.undo, messages: 4 };
  expect(u.before && u.after).toBeTruthy();
  expect(u.kept.length).toBe(1);

  expect(await undoBlocked(u, sessionFile, here, true)).toBeNull();
  const back = await applyUndo(u, sessionFile, "t_1", true);
  expect(back).toEqual({ messages: 4, files: 3, filesRestored: true, filesReason: null });
  expect(readFileSync(sessionFile, "utf8")).toBe(raw);
  expect(existsSync(`${sessionFile}.before-rewind`)).toBe(false);
  expect(readFileSync(join(dir, "two.txt"), "utf8")).toBe("from exchange 2\n");
  expect(readFileSync(join(dir, "three.txt"), "utf8")).toBe("from exchange 3\n");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("edited by hand\n");
  expect((await listSnapshots(dir, "t_1")).length).toBe(3);
  expect((await run(["git", "for-each-ref", UNDO_REFS], dir)).stdout.trim()).toBe("");
});

test("undo of a chat-only rewind restores only the chat and says so", async () => {
  const dir = await project();
  const { sessionFile, entry, raw } = await chat(dir);
  const r = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: false, sessionId: "s1" });
  expect(r.undo.before).toBeNull();
  expect(texts(sessionFile)).toEqual(["first", "done first"]);
  const back = await applyUndo(r.undo, sessionFile, "t_1", true);
  expect(back).toMatchObject({ files: 0, filesRestored: false, filesReason: "unchanged" });
  expect(readFileSync(sessionFile, "utf8")).toBe(raw);
  expect(readFileSync(join(dir, "two.txt"), "utf8")).toBe("from exchange 2\n");
});

test("undo is refused with nothing to undo, after a new message, in another session, or when files changed since", async () => {
  const dir = await project();
  const { sessionFile, entry } = await chat(dir);
  expect(await undoBlocked(null, sessionFile, here, true)).toBe("There is no rewind to undo.");
  const { undo } = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1" });

  // Files changed since the rewind: undo would overwrite them, so only chat-only undo is allowed.
  writeFileSync(join(dir, "new.txt"), "made after the rewind\n");
  expect(await undoBlocked(undo, sessionFile, here, true)).toContain("changed since the rewind");
  expect(await undoBlocked(undo, sessionFile, here, false)).toBeNull();

  // The chat went on in another session (an emptied rewind's new one started, or a fresh session).
  expect(await undoBlocked(undo, sessionFile, { sessionId: "other", started: true }, false)).toContain("moved on");
  expect(await undoBlocked({ ...undo, newSessionId: "s9" }, sessionFile, { sessionId: "s9", started: true }, false)).toContain("moved on");
  expect(await undoBlocked({ ...undo, newSessionId: "s9" }, sessionFile, { sessionId: "s9", started: false }, false)).toBeNull();

  // A new message in the cut chat: undo would lose it.
  appendFileSync(sessionFile, line("user", "u9", Date.now(), "a new question") + "\n");
  expect(await undoBlocked(undo, sessionFile, here, false)).toContain("moved on");
  expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("made after the rewind\n");
});

test("a second rewind replaces the first one's undo", async () => {
  const dir = await project();
  const { sessionFile, entry } = await chat(dir);
  const first = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1" });
  const e0 = parseSession(readFileSync(sessionFile, "utf8")).entries.find((e) => e.uuid === "u0")!;
  const second = await applyRewind({ dir, ticketId: "t_1", entry: e0, sessionFile, files: true, sessionId: "s1" });
  expect(await undoBlocked(first.undo, sessionFile, here, false)).toContain("moved on");
  expect(await undoBlocked(second.undo, sessionFile, here, true)).toBeNull();
  await applyUndo(second.undo, sessionFile, "t_1", true);
  expect(texts(sessionFile)).toEqual(["first", "done first"]);
});

test("the undo copies are dropped with the ticket's other saved copies", async () => {
  const { deleteSnapshots } = await import("../src/server/rewind");
  const dir = await project();
  const { sessionFile, entry } = await chat(dir);
  await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1" });
  expect((await run(["git", "for-each-ref", UNDO_REFS], dir)).stdout.trim()).not.toBe("");
  await deleteSnapshots(dir, "t_1");
  expect((await run(["git", "for-each-ref", "refs/ckanban/"], dir)).stdout.trim()).toBe("");
  mkdirSync(join(dir, "x"), { recursive: true });
});

test("a rewind stopped right before the cut (the chat got busy) puts the files back and keeps no undo copies", async () => {
  const { RewindRefused } = await import("../src/server/rewind");
  const dir = await project();
  const { sessionFile, entry, raw } = await chat(dir);
  writeFileSync(join(dir, "README.md"), "edited by hand\n");
  const p = applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1", still: () => "Claude is working." });
  await expect(p).rejects.toBeInstanceOf(RewindRefused);
  expect(readFileSync(sessionFile, "utf8")).toBe(raw);
  expect(readFileSync(join(dir, "two.txt"), "utf8")).toBe("from exchange 2\n");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("edited by hand\n");
  expect((await run(["git", "for-each-ref", UNDO_REFS], dir)).stdout.trim()).toBe("");
  expect((await listSnapshots(dir, "t_1")).length).toBe(3);
});

test("an undo stopped right before the chat is written back leaves the chat and the files as the rewind left them", async () => {
  const dir = await project();
  const { sessionFile, entry } = await chat(dir);
  const { undo } = await applyRewind({ dir, ticketId: "t_1", entry, sessionFile, files: true, sessionId: "s1" });
  const cut = readFileSync(sessionFile, "utf8");
  await expect(applyUndo(undo, sessionFile, "t_1", true, () => "Claude is working.")).rejects.toThrow("Claude is working.");
  expect(readFileSync(sessionFile, "utf8")).toBe(cut);
  expect(existsSync(join(dir, "two.txt"))).toBe(false);
  expect(await undoBlocked(undo, sessionFile, here, true)).toBeNull();
});
