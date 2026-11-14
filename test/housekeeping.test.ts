import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../src/server/atomic";
import { sweepTempFiles, trimDaemonLog } from "../src/server/housekeeping";
import { tempDir } from "./helpers";

test("atomicWrite leaves no temp file when the write fails", () => {
  const dir = tempDir();
  // The target is a folder: the rename fails after the temp file was written.
  mkdirSync(join(dir, "taken"));
  writeFileSync(join(dir, "taken", "x"), "");
  expect(() => atomicWrite(join(dir, "taken"), "hello")).toThrow();
  expect(readdirSync(dir)).toEqual(["taken"]);
  atomicWrite(join(dir, "ok.json"), "{}");
  expect(readdirSync(dir).sort()).toEqual(["ok.json", "taken"]);
});

test("sweepTempFiles removes atomic-write temp files older than a day, and nothing else", async () => {
  const root = tempDir();
  const ticket = join(root, "profiles", "p", "tickets", "t_1");
  mkdirSync(join(ticket, "outputs", "copy", "deep"), { recursive: true });
  mkdirSync(join(root, "browsers"));
  const old = new Date(Date.now() - 2 * 86_400_000);
  const files = {
    oldTop: join(root, "session-summaries.json.tmp-aaytjssg"),
    oldTicket: join(ticket, "ticket.md.tmp-b8r5tv7x"),
    oldOutput: join(ticket, "outputs", "status.md.tmp-q8ma4m8t"),
    fresh: join(ticket, "ticket.md.tmp-zzzzzzzz"),
    notOurs: join(ticket, "notes.tmp-old"),
    inCopy: join(ticket, "outputs", "copy", "deep", "x.tmp-abcdefgh"),
    browser: join(root, "browsers", "Profile.tmp-abcdefgh"),
    keep: join(ticket, "ticket.md"),
  };
  for (const f of Object.values(files)) writeFileSync(f, "");
  for (const k of ["oldTop", "oldTicket", "oldOutput", "notOurs", "inCopy", "browser", "keep"] as const) utimesSync(files[k], old, old);
  expect(await sweepTempFiles(root)).toBe(3);
  expect(Object.entries(files).filter(([, f]) => existsSync(f)).map(([k]) => k).sort()).toEqual(["browser", "fresh", "inCopy", "keep", "notOurs"]);
});

test("trimDaemonLog moves a log over the limit to .1 (keeping two) and empties it in place", async () => {
  const dir = tempDir();
  const log = join(dir, "daemon.log");
  writeFileSync(log, "small\n");
  expect(await trimDaemonLog(log, { maxBytes: 100 })).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("small\n");
  for (const n of [1, 2, 3]) {
    writeFileSync(log, `round ${n} ${"x".repeat(200)}\n`);
    expect(await trimDaemonLog(log, { maxBytes: 100 })).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("");
  }
  expect(readFileSync(`${log}.1`, "utf8")).toStartWith("round 3");
  expect(readFileSync(`${log}.2`, "utf8")).toStartWith("round 2");
  expect(existsSync(`${log}.3`)).toBe(false);
  expect(await trimDaemonLog(join(dir, "missing.log"))).toBe(false);
});
