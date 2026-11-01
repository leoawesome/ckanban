// Rewind's saved copies of the folder: removed when their ticket is deleted or done, never another ticket's;
// and a copy that takes too long is skipped instead of holding up the message.
import { expect, test } from "bun:test";
import { run } from "../src/server/git";
import { listSnapshots, takeSnapshot } from "../src/server/rewind";
import { board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

const refs = async (dir: string) =>
  (await run(["git", "for-each-ref", "--format=%(refname)", "refs/ckanban/rewind/"], dir)).stdout.split("\n").filter(Boolean);

test("deleting or finishing a ticket removes its saved copies and leaves the others", async () => {
  const p = await setup();
  const a = await board.createTicket("p", { title: "A", body: "", status: "backlog" });
  const b = await board.createTicket("p", { title: "B", body: "", status: "backlog" });
  const c = await board.createTicket("p", { title: "C", body: "", status: "backlog" });
  for (const t of [a, b, c]) {
    expect(await takeSnapshot(p.path, t.id, "first")).not.toBeNull();
    expect(await takeSnapshot(p.path, t.id, "second", Date.now() + 1)).not.toBeNull();
  }
  expect((await refs(p.path)).length).toBe(6);

  await board.deleteTicket("p", a.id);
  expect(await listSnapshots(p.path, a.id)).toEqual([]);
  expect((await listSnapshots(p.path, b.id)).length).toBe(2);

  await board.updateTicket("p", b.id, { status: "done" });
  for (let i = 0; i < 50 && (await listSnapshots(p.path, b.id)).length; i++) await Bun.sleep(20);
  expect(await listSnapshots(p.path, b.id)).toEqual([]);
  expect((await listSnapshots(p.path, c.id)).length).toBe(2);

  await board.deleteTicket("p", c.id);
  expect(await refs(p.path)).toEqual([]);
});

test("a copy that runs past its time limit is skipped and leaves nothing behind", async () => {
  const p = await setup();
  expect(await takeSnapshot(p.path, "t_slow", "hello", Date.now(), 1)).toBeNull();
  await Bun.sleep(50);
  expect(await refs(p.path)).toEqual([]);
});

test("the copy starts from the folder's own index: same files, real index untouched, only the folder's own changes count", async () => {
  const { makeRepo } = await import("./helpers");
  const repo = await makeRepo();
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { changesSince } = await import("../src/server/rewind");
  const sub = join(repo, "app");
  mkdirSync(sub);
  writeFileSync(join(sub, "a.txt"), "a\n");
  writeFileSync(join(repo, "outside.txt"), "o\n");
  await run(["git", "add", "-A"], repo);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "two"], repo);
  writeFileSync(join(sub, "a.txt"), "a staged\n");
  await run(["git", "add", "app/a.txt"], repo);
  const index = readFileSync(join(repo, ".git", "index"));

  const ref = await takeSnapshot(sub, "t_seed", "hello");
  expect(ref).not.toBeNull();
  expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
  expect((await run(["git", "show", `${ref}:app/a.txt`], repo)).stdout).toBe("a staged\n");

  // Claude edits the folder; the user changes and stages a file outside it.
  writeFileSync(join(sub, "b.txt"), "b\n");
  writeFileSync(join(repo, "outside.txt"), "changed\n");
  await run(["git", "add", "outside.txt"], repo);
  expect(await changesSince(sub, ref!)).toEqual([{ path: "app/b.txt", status: "A" }]);
});
