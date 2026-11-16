// Outside-in contract: quick chats (the Ask tab: chats with Claude in the board's folder, no ticket) over HTTP, their
// files under profiles/<slug>/chats/ and their events, plus search_chat / read_chat (GET /chat/search, /chat/read)
// and who may reach which chat. User-only actions go through the phone access listener (phone.ts), as the user's own
// browser. See contracts/api.md ("Quick chats", "Profiles") and contracts/data-files.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { readJsonl } from "./files";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "ask";
const base = `/api/profiles/${SLUG}/chats`;
const chatsDir = () => join(d.home, "profiles", SLUG, "chats");

beforeAll(async () => {
  d = await startDaemon({
    // FAKE_TRANSCRIPT: replies (with a Bash call, tool id tu_ls) are saved in the transcript, so the conversation shows
    // them; FAKE_UUIDS gives each saved line a uuid (rewind and fork cut there); FAKE_EXTRA makes replies long enough
    // to simplify (25 words). FAKE_SIDE_JSON: side calls (simplify) get one JSON answer. FAKE_STREAM_DELAY: the reply streams in two
    // pieces, slower than the 120 ms draft throttle, so a `chat.draft` with text comes before the final one.
    env: {
      FAKE_TRANSCRIPT: "1", FAKE_UUIDS: "1", FAKE_SIDE_JSON: "1",
      FAKE_EXTRA: "\nI looked through the folder and found a README file that explains the project, plus a few scripts that build and test it, and nothing else of note today.", FAKE_SIDE_TEXT: "Plainly: done.", FAKE_STREAM_DELAY: "300" },
  });
  expect((await d.api("POST", "/api/profiles", { name: "Ask", path: d.project })).status).toBe(201);
  const otherDir = join(d.project, "..", "other-project");
  mkdirSync(otherDir, { recursive: true });
  expect((await d.api("POST", "/api/profiles", { name: "Other", path: otherDir })).status).toBe(201);
  writeRemoteJson(d.home, true);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

/** The user (the owner's phone, through the phone access listener). */
const user = (method: string, path: string, b?: unknown) => phone(d, method, path, b);
const idle = (id: string) => until(async () => {
  const c = (await d.api("GET", `${base}/${id}`)).data;
  return c && !c.running && c.started ? c : null;
}, 20_000, `chat ${id} to finish its reply`);
const conv = async (id: string, q = "") => (await d.api("GET", `${base}/${id}/conversation${q}`)).data;
const waitConv = (id: string, pick: (entries: any[]) => boolean, what: string) => until(async () => {
  const c = await conv(id);
  return pick(c.entries) ? c : null;
}, 20_000, what);

/** The event stream, read line by line; every `data:` message is collected until stop(). */
async function listen() {
  const ctl = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: any[] = [];
  let buf = "";
  let connected = false;
  (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.startsWith(": connected")) connected = true;
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();
  await until(() => connected, 5_000, "the event stream to connect");
  return { events, stop: () => ctl.abort() };
}

describe("who may use quick chats", () => {
  test("a run, a huddle helper or a program without the board's Origin is refused; reads are open", async () => {
    const refused = [
      await d.api("POST", base, { text: "hi" }, { "x-ckanban-run": `${SLUG}/t_x` }),
      await d.api("POST", base, { text: "hi" }, { "x-ckanban-huddle-agent": "h/x/y" }),
      await d.api("POST", base, { text: "hi" }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(403);
      expect(r.data.error).toStartWith("Quick chats is for the user only");
    }
    expect((await d.api("GET", base)).status).toBe(200);
    expect((await d.api("GET", `${base}/nope`)).status).toBe(404);
    expect((await d.api("GET", `${base}/nope`)).data).toEqual({ error: "chat not found" });
    // An unknown chat answers 404 before the user check.
    expect((await d.api("DELETE", `${base}/nope`, undefined, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(404);
    expect((await d.api("GET", "/api/profiles/nope/chats")).status).toBe(404);
    expect((await user("POST", base, { text: "   " })).status).toBe(400);
  });
});

describe("a quick chat", () => {
  let id = "";
  let sessionId = "";

  test("the first message starts a chat; events stream its reply; its files are written", async () => {
    const s = await listen();
    try {
      const made = await user("POST", base, { text: "What is in this folder?\nmore lines" });
      expect(made.status).toBe(201);
      expect(made.data).toMatchObject({
        title: "What is in this folder?", renamed: false, firstMessage: "What is in this folder?\nmore lines", ticketId: null, error: null,
      });
      expect(made.data.id).toMatch(/^[0-9a-z]{8}$/);
      expect(made.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      id = made.data.id;
      sessionId = made.data.sessionId;
      const done = await idle(id);
      expect(done).toMatchObject({ id, running: false, activity: null, waiting: 0, started: true });
      await until(() => s.events.some((e) => e.type === "chat.draft" && e.id === id && e.final), 20_000, "the final chat.draft");
      const drafts = s.events.filter((e) => e.type === "chat.draft" && e.id === id);
      expect(drafts.every((e) => e.profile === SLUG && typeof e.text === "string")).toBe(true);
      expect(drafts.some((e) => e.text.startsWith("Work ") && !e.final)).toBe(true);
      expect(drafts.at(-1).final).toContain("Work complete.");
      const updates = s.events.filter((e) => e.type === "chat.updated" && e.id === id);
      expect(updates.some((e) => e.chat?.running === true)).toBe(true);
      expect(updates.at(-1)).toMatchObject({ profile: SLUG, chat: { id, running: false } });
      expect(s.events.some((e) => e.type === "chat.activity" && e.profile === SLUG && e.id === id && "activity" in e)).toBe(true);
    } finally {
      s.stop();
    }
    // chats/<id>.json holds the chat (not the live fields); <id>.activity.jsonl its run log.
    const saved = JSON.parse(readFileSync(join(chatsDir(), `${id}.json`), "utf8"));
    expect(saved).toMatchObject({ id, sessionId, title: null, firstMessage: "What is in this folder?\nmore lines", started: true, ticketId: null });
    expect(saved.running).toBeUndefined();
    expect(saved.renamed).toBeUndefined();
    const log = readJsonl(join(chatsDir(), `${id}.activity.jsonl`));
    expect(log.length).toBeGreaterThan(0);
  }, 40_000);

  test("the list: every chat without limit; pages with limit and before", async () => {
    const all = await d.api("GET", base);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.data)).toBe(true);
    expect(all.data.find((c: any) => c.id === id)).toMatchObject({ id, title: "What is in this folder?" });
    const second = await user("POST", base, { text: "Second chat" });
    await idle(second.data.id);
    const p1 = await d.api("GET", `${base}?limit=1`);
    expect(p1.data.chats.map((c: any) => c.id)).toEqual([second.data.id]);
    expect(typeof p1.data.next).toBe("string");
    const p2 = await d.api("GET", `${base}?limit=1&before=${encodeURIComponent(p1.data.next)}`);
    expect(p2.data.chats.map((c: any) => c.id)).toEqual([id]);
    expect(p2.data.next).toBeNull();
    expect((await user("DELETE", `${base}/${second.data.id}`)).status).toBe(204);
  }, 30_000);

  test("conversation: user and assistant entries, a tool row, paging with limit and before", async () => {
    const c = await waitConv(id, (es) => es.some((e) => e.role === "assistant" && e.text.includes("Work complete.")), "the reply in the conversation");
    expect(c).toMatchObject({ start: 0, total: c.entries.length });
    expect(c.entries[0]).toMatchObject({ role: "user", kind: "text", text: "What is in this folder?\nmore lines", rewind: true });
    expect(c.entries.some((e: any) => e.kind === "tool" && e.toolUseId === "tu_ls")).toBe(true);
    const last = await conv(id, "?limit=1");
    expect(last).toMatchObject({ start: c.total - 1, total: c.total });
    expect(last.entries).toEqual([c.entries.at(-1)]);
    const first = await conv(id, "?limit=1&before=1");
    expect(first).toMatchObject({ start: 0, total: c.total });
    expect(first.entries).toEqual([c.entries[0]]);
    // Tool details: the Bash call; an unknown id is 404.
    const tool = await d.api("GET", `${base}/${id}/tool/tu_ls`);
    expect(tool.status).toBe(200);
    expect(JSON.stringify(tool.data)).toContain("ls src");
    expect((await d.api("GET", `${base}/${id}/tool/tu_nope`)).status).toBe(404);
  }, 30_000);

  test("a reply continues the same session; rename; context GET and POST", async () => {
    const r = await user("POST", `${base}/${id}/messages`, { text: "And the README?" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id, sessionId });
    expect((await d.api("POST", `${base}/${id}/messages`, { text: "x" }, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(403);
    expect((await user("POST", `${base}/${id}/messages`, { text: " " })).status).toBe(400);
    await idle(id);
    await waitConv(id, (es) => es.some((e) => e.role === "user" && e.text === "And the README?"), "the second message");
    const args = readJsonl(join(d.home, "..", "claude-args.jsonl")).filter((a) => a.args.includes(sessionId));
    expect(args.at(-1).args).toContain("--resume");

    const renamed = await user("PATCH", `${base}/${id}`, { title: "Folder tour" });
    expect(renamed.status).toBe(200);
    expect(renamed.data).toMatchObject({ title: "Folder tour", renamed: true });
    expect(JSON.parse(readFileSync(join(chatsDir(), `${id}.json`), "utf8")).title).toBe("Folder tour");
    expect((await d.api("PATCH", `${base}/${id}`, { title: "x" })).status).toBe(403);

    const ctx = await d.api("GET", `${base}/${id}/context`);
    expect(ctx.status).toBe(200);
    expect((await d.api("POST", `${base}/${id}/context`, {})).status).toBe(403);
    const fresh = await user("POST", `${base}/${id}/context`, {});
    expect(fresh.status).toBe(200);
  }, 40_000);

  test("simplify a reply with a side call; simplified lists it and the side spend is logged", async () => {
    const c = await conv(id);
    const reply = c.entries.find((e: any) => e.role === "assistant" && e.kind === "text" && e.text.includes("Work complete."));
    expect((await d.api("POST", `${base}/${id}/simplify`, { uuid: reply.uuid })).status).toBe(403);
    expect((await user("POST", `${base}/${id}/simplify`, { uuid: "nope" })).status).toBe(404);
    const s = await user("POST", `${base}/${id}/simplify`, { uuid: reply.uuid });
    expect(s.status).toBe(200);
    expect(JSON.stringify(s.data)).toContain("Plainly: done.");
    const saved = await d.api("GET", `${base}/${id}/simplified`);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.data)).toContain("Plainly: done.");
    expect(existsSync(join(chatsDir(), `${id}.simplified.json`))).toBe(true);
    expect(readJsonl(join(chatsDir(), `${id}.side-spend.jsonl`)).length).toBeGreaterThan(0);
  }, 30_000);

  test("rewind to the second message, undo it, and fork from the first", async () => {
    const c = await conv(id);
    const second = c.entries.find((e: any) => e.role === "user" && e.text === "And the README?");
    expect(second.rewind).toBe(true);
    const preview = await d.api("GET", `${base}/${id}/rewind?uuid=${second.uuid}`);
    expect(preview.status).toBe(200);
    expect(preview.data).toEqual({ blocked: null, files: null, filesReason: "quick-chat" });
    expect((await d.api("GET", `${base}/${id}/rewind?uuid=nope`)).status).toBe(404);
    expect((await d.api("POST", `${base}/${id}/rewind`, { uuid: second.uuid })).status).toBe(403);
    const before = await d.api("GET", `${base}/${id}/rewind-undo`);
    expect(before.data).toMatchObject({ available: false, messages: 0, files: 0, filesSaved: false });

    const r = await user("POST", `${base}/${id}/rewind`, { uuid: second.uuid });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ text: "And the README?", files: 0, undo: true });
    expect(r.data.messages).toBeGreaterThan(0);
    const cut = await conv(id);
    expect(cut.entries.some((e: any) => e.text === "And the README?")).toBe(false);
    const undoState = await d.api("GET", `${base}/${id}/rewind-undo`);
    expect(undoState.data).toMatchObject({ available: true, blocked: null, files: 0, filesSaved: false });
    expect(undoState.data.messages).toBeGreaterThan(0);
    expect((await d.api("POST", `${base}/${id}/rewind-undo`, {})).status).toBe(403);
    const undone = await user("POST", `${base}/${id}/rewind-undo`, {});
    expect(undone.status).toBe(200);
    await waitConv(id, (es) => es.some((e) => e.text === "And the README?"), "the undone messages back");
    expect((await d.api("GET", `${base}/${id}/rewind-undo`)).data.available).toBe(false);

    const first = (await conv(id)).entries[0];
    expect((await user("POST", `${base}/${id}/fork`, { uuid: "nope" })).status).toBe(404);
    const f = await user("POST", `${base}/${id}/fork`, { uuid: first.uuid });
    expect(f.status).toBe(201);
    expect(f.data).toMatchObject({ text: first.text, chat: { id: f.data.id } });
    expect(f.data.id).not.toBe(id);
    expect(existsSync(join(chatsDir(), `${f.data.id}.json`))).toBe(true);
  }, 40_000);

  test("stop, make ticket (also into a feature), then the chat refuses messages; delete removes its files", async () => {
    expect((await d.api("POST", `${base}/${id}/stop`, {})).status).toBe(403);
    const stopped = await user("POST", `${base}/${id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.data).toMatchObject({ id, running: false });

    const t = await user("POST", `${base}/${id}/ticket`, {});
    expect(t.status).toBe(201);
    expect(t.data.ticket).toMatchObject({ title: "Folder tour", status: "backlog", sessionId });
    expect(t.data.chat).toMatchObject({ id, ticketId: t.data.ticket.id });
    const more = await user("POST", `${base}/${id}/messages`, { text: "more" });
    expect(more.status).toBe(409);
    expect(more.data.error).toBe("This chat became a ticket. Continue it in the ticket's chat.");
    expect((await user("POST", `${base}/${id}/ticket`, {})).status).toBe(409);

    const feature = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Login work" })).data;
    const other = await user("POST", base, { text: "The login page is blank" });
    await idle(other.data.id);
    expect((await user("POST", `${base}/${other.data.id}/ticket`, { partOf: "t_nope" })).status).toBe(400);
    expect((await user("POST", `${base}/${other.data.id}/ticket`, { partOf: 5 })).status).toBe(400);
    const joined = await user("POST", `${base}/${other.data.id}/ticket`, { partOf: feature.id });
    expect(joined.status).toBe(201);
    expect(joined.data.ticket.partOf).toBe(feature.id);

    expect((await d.api("DELETE", `${base}/${id}`)).status).toBe(403);
    expect((await user("DELETE", `${base}/${id}`)).status).toBe(204);
    expect((await d.api("GET", `${base}/${id}`)).status).toBe(404);
    expect(existsSync(join(chatsDir(), `${id}.json`))).toBe(false);
    expect(existsSync(join(chatsDir(), `${id}.activity.jsonl`))).toBe(false);
  }, 40_000);
});

describe("search_chat and read_chat", () => {
  test("search a ticket's chat, read a message by its ref, and who may reach which chat", async () => {
    const tk = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Searchable" })).data;
    await d.api("POST", `/api/profiles/${SLUG}/tickets/${tk.id}/chat`, { text: "the zebra crossing is broken" });
    const sid = await until(async () => {
      const t = (await d.api("GET", `/api/profiles/${SLUG}/tickets/${tk.id}`)).data;
      return !t.running && t.runEndedAt ? t.sessionId : null;
    }, 20_000, "the chat run to end");

    const hit = await until(async () => {
      const r = await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${tk.id}&q=zebra`);
      expect(r.status).toBe(200);
      return r.data.text.includes("zebra crossing") ? r.data : null;
    }, 20_000, "the search to find the message");
    expect(hit.text).toContain(`${sid}:`);
    const ref = hit.text.match(new RegExp(`${sid}:\\d+`))![0];
    const read = await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}`);
    expect(read.status).toBe(200);
    expect(read.data.text).toContain("zebra crossing");
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}&before=1&after=1`)).status).toBe(200);

    // Errors.
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?q=x`)).status).toBe(400);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=t_nope&q=x`)).status).toBe(404);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=bad`)).status).toBe(400);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=00000000-0000-0000-0000-000000000000:1`)).status).toBe(404);

    // Reach: the ticket's own run reads its chat (and searches it without naming it); another ticket's run on the
    // board, a huddle helper and a run on another board are refused.
    const own = { "x-ckanban-run": `${SLUG}/${tk.id}` };
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?q=zebra`, undefined, own)).status).toBe(200);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}`, undefined, own)).status).toBe(200);
    const stranger = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Stranger" })).data;
    const far = await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${tk.id}&q=zebra`, undefined, { "x-ckanban-run": `${SLUG}/${stranger.id}` });
    expect(far.status).toBe(403);
    expect(far.data.error).toStartWith(`${tk.id} is out of reach`);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/read?ref=${ref}`, undefined, { "x-ckanban-run": `${SLUG}/${stranger.id}` })).status).toBe(403);
    expect((await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${tk.id}&q=zebra`, undefined, { ...own, "x-ckanban-huddle-agent": "h/x/y" })).status).toBe(403);
    const otherBoard = await d.api("GET", `/api/profiles/${SLUG}/chat/search?ticket=${tk.id}&q=zebra`, undefined, { "x-ckanban-run": `other/${stranger.id}` });
    expect(otherBoard.status).toBe(403);
  }, 40_000);
});
