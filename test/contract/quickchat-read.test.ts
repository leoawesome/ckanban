// Outside-in contract: reading quick chats saved before the start, and who may change them. Chats and a transcript are
// written as files before the daemon starts (no runs, no phone access), so the same file passes with the board in Bun
// and with the board in Rust (`bun run test:contract:rust-board`). Sending, stopping and the rest of a chat's life are
// in quickchat.test.ts. See contracts/api.md "Quick chats" and contracts/data-files.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";

let d: Daemon;
const SLUG = "asking";
const base = `/api/profiles/${SLUG}/chats`;
const S1 = "44444444-4444-4444-8444-444444444444";
let chatsDir = "";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const chat = (id: string, fields: Record<string, unknown>) => ({
  id, sessionId: S1, title: null, firstMessage: null, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z",
  started: true, ticketId: null, error: null, ...fields,
});
const saved: Record<string, string> = {};

beforeAll(async () => {
  d = await startDaemon({
    before: ({ home, claudeDir, project }) => {
      mkdirSync(join(home, "profiles", SLUG), { recursive: true });
      writeFileSync(join(home, "profiles", SLUG, "profile.json"), JSON.stringify({ name: "Asking", slug: SLUG, path: project, createdAt: "2026-11-01T09:00:00.000Z" }, null, 2) + "\n");
      chatsDir = join(home, "profiles", SLUG, "chats");
      mkdirSync(chatsDir, { recursive: true });
      const chats = [
        chat("aaa1", { firstMessage: "## What is [here](http://x)?\nmore", updatedAt: "2026-11-01T12:00:00.000Z" }),
        chat("bbb2", { title: "Renamed one", firstMessage: "hello", updatedAt: "2026-11-01T11:00:00.000Z", extra: { kept: 1 } }),
        chat("ccc3", { firstMessage: null, started: false, error: "claude exited with code 1" }),
      ];
      for (const c of chats) writeFileSync(join(chatsDir, `${c.id}.json`), (saved[c.id] = JSON.stringify(c, null, 2) + "\n"));
      writeFileSync(join(chatsDir, "notes.txt"), "not a chat");
      writeFileSync(join(chatsDir, "Bad.json"), "{}");
      const transcripts = join(claudeDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, `${S1}.jsonl`), [
        line({ type: "user", uuid: "q1", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "what is here?" } }),
        line({ type: "assistant", uuid: "q2", timestamp: "2026-11-01T10:00:01.000Z", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "tu_ls", name: "Bash", input: { command: "ls src" } }] } }),
        line({ type: "user", uuid: "q3", timestamp: "2026-11-01T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_ls", content: "app.ts" }] } }),
        line({ type: "assistant", uuid: "q4", timestamp: "2026-11-01T10:00:03.000Z", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "A small app." }] } }),
      ].join(""));
    },
  });
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

describe("reading quick chats", () => {
  test("the list: every chat newest first, with its live fields; pages with limit and before", async () => {
    const all = await d.api("GET", base);
    expect(all.status).toBe(200);
    expect(all.data.map((c: any) => c.id)).toEqual(["aaa1", "bbb2", "ccc3"]);
    expect(all.data[0]).toEqual({
      id: "aaa1", sessionId: S1, firstMessage: "## What is [here](http://x)?\nmore", createdAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-01T12:00:00.000Z", started: true, ticketId: null, error: null,
      title: "What is here?", renamed: false, running: false, activity: null, waiting: 0,
    });
    expect(all.data[1]).toMatchObject({ title: "Renamed one", renamed: true, extra: { kept: 1 } });
    expect(all.data[2]).toMatchObject({ title: "New chat", error: "claude exited with code 1" });
    const p1 = await d.api("GET", `${base}?limit=2`);
    expect(p1.data.chats.map((c: any) => c.id)).toEqual(["aaa1", "bbb2"]);
    expect(p1.data.next).toBe("2026-11-01T11:00:00.000Z|2026-11-01T09:00:00.000Z|bbb2");
    const p2 = await d.api("GET", `${base}?limit=2&before=${encodeURIComponent(p1.data.next)}`);
    expect(p2.data).toEqual({ chats: [all.data[2]], next: null });
    expect((await d.api("GET", `${base}?limit=abc`)).data.chats).toHaveLength(3);
  });

  test("one chat; unknown chats and boards are 404", async () => {
    const one = await d.api("GET", `${base}/bbb2`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({ id: "bbb2", title: "Renamed one" });
    expect(await d.api("GET", `${base}/nope`)).toMatchObject({ status: 404, data: { error: "chat not found" } });
    expect((await d.api("GET", `${base}/Bad`)).status).toBe(404);
    expect(await d.api("GET", "/api/profiles/nope/chats")).toMatchObject({ status: 404, data: { error: "board nope not found" } });
    expect((await d.api("GET", `${base}/bbb2/nothing`)).status).toBe(404);
  });

  test("conversation pages and a tool call's details", async () => {
    const c = await d.api("GET", `${base}/aaa1/conversation`);
    expect(c.status).toBe(200);
    expect(c.data).toMatchObject({ start: 0, total: c.data.entries.length });
    expect(c.data.entries[0]).toMatchObject({ role: "user", text: "what is here?" });
    expect(c.data.entries.some((e: any) => e.kind === "tool" && e.toolUseId === "tu_ls")).toBe(true);
    const last = await d.api("GET", `${base}/aaa1/conversation?limit=1`);
    expect(last.data).toEqual({ entries: [c.data.entries.at(-1)], start: c.data.total - 1, total: c.data.total });
    const first = await d.api("GET", `${base}/aaa1/conversation?limit=1&before=1`);
    expect(first.data).toEqual({ entries: [c.data.entries[0]], start: 0, total: c.data.total });
    const tool = await d.api("GET", `${base}/aaa1/tool/tu_ls`);
    expect(tool.status).toBe(200);
    expect(JSON.stringify(tool.data)).toContain("ls src");
    expect(await d.api("GET", `${base}/aaa1/tool/tu_nope`)).toMatchObject({ status: 404, data: { error: "tool call not found" } });
  });
});

describe("who may change quick chats", () => {
  test("a run, a huddle helper or a program is refused; unknown chats are 404 first; bad requests are refused", async () => {
    const refusals = [
      await d.api("POST", base, { text: "hi" }),
      await d.api("POST", base, { text: "hi" }, { "x-ckanban-run": `${SLUG}/t_x` }),
      await d.api("POST", base, { text: "hi" }, { "x-ckanban-huddle-agent": "h/x/y" }),
      await d.api("POST", `${base}/aaa1/messages`, { text: "hi" }),
      await d.api("PATCH", `${base}/aaa1`, { title: "x" }),
      await d.api("POST", `${base}/aaa1/stop`, {}),
      await d.api("DELETE", `${base}/aaa1`),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.data.error).toStartWith("Quick chats is for the user only");
    }
    expect((await d.api("DELETE", `${base}/nope`, undefined, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(404);
    expect((await d.api("PATCH", `${base}/nope`, { title: "x" })).status).toBe(404);
    // Another site's page can't change anything (403 before the route), and only JSON bodies are taken.
    const foreign = await d.api("POST", base, { text: "hi" }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.text).toBe("forbidden");
    const plain = await fetch(`${d.url}${base}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
    expect(plain.status).toBe(415);
    // Nothing changed on disk.
    for (const [id, text] of Object.entries(saved)) expect(readFileSync(join(chatsDir, `${id}.json`), "utf8")).toBe(text);
  });
});
