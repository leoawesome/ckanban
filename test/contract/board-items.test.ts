// Outside-in contract: tags, attachments, ticket links, cards and board ordering, the board list answers
// (/api/profiles/:slug/tickets scopes, /api/tickets, /api/inbox) and the event stream messages these actions send.
// Checks the answers, the files the daemon writes (contracts/data-files.md) and the errors. See contracts/api.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile } from "./files";
import { schemaProblems } from "./schema";

let d: Daemon;
const SLUG = "items";
const P = `/api/profiles/${SLUG}`;

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Items", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const ticketDir = (id: string, slug = SLUG) => join(d.home, "profiles", slug, "tickets", id);
const meta = (id: string, slug = SLUG) => parseTicketFile(readFileSync(join(ticketDir(id, slug), "ticket.md"), "utf8")).meta;
const ticket = async (id: string) => (await d.api("GET", `${P}/tickets/${id}`)).data;
const newTicket = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await d.api("POST", `${P}/tickets`, { title, ...extra });
  expect(r.status).toBe(201);
  return r.data;
};
/** A request with a raw body (uploads): status, headers and the body as bytes. */
const raw = async (method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}) => {
  const res = await fetch(d.url + path, { method, body, headers });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
};
const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const attachmentsDir = () => join(d.home, "attachments");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Reads the event stream in the background; `messages()` are the parsed `data:` lines so far. */
async function listen() {
  const ctl = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const pump = (async () => {
    try {
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        text += dec.decode(c.value, { stream: true });
      }
    } catch {}
  })();
  await until(() => text.startsWith(": connected"), 5_000, "the event stream to open");
  const messages = () => text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return {
    messages,
    wait: (what: string, fn: (e: any) => boolean) => until(() => messages().find(fn), 5_000, what),
    close: async () => {
      ctl.abort();
      await pump;
    },
  };
}

describe("tags", () => {
  test("stored normalized: trimmed, lowercase, no #, dashes for spaces, 24 chars, no repeats, at most 10", async () => {
    const t = await newTicket("Tagged", { tags: ["#UI Work", "ui-work", "  Backend  ", "a-very-long-tag-name-that-goes-on-and-on", "", "###"] });
    expect(t.tags).toEqual(["ui-work", "backend", "a-very-long-tag-name-tha"]);
    expect(meta(t.id).tags).toEqual(["ui-work", "backend", "a-very-long-tag-name-tha"]);
    // Block-style YAML list in the file.
    expect(readFileSync(join(ticketDir(t.id), "ticket.md"), "utf8")).toContain("\ntags:\n  - ui-work\n  - backend\n");

    const many = await d.api("PATCH", `${P}/tickets/${t.id}`, { tags: Array.from({ length: 14 }, (_, i) => `t${i}`) });
    expect(many.status).toBe(200);
    expect(many.data.tags).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    // Not a list: left as it was.
    expect((await d.api("PATCH", `${P}/tickets/${t.id}`, { tags: "x" })).data.tags).toHaveLength(10);
    const suggested = await d.api("PATCH", `${P}/tickets/${t.id}`, { suggestedTags: ["#New One"] });
    expect(suggested.data.suggestedTags).toEqual(["new-one"]);
    expect(meta(t.id).suggestedTags).toEqual(["new-one"]);
  });

  test("scope=list filters by tags; clearing them writes an empty list", async () => {
    const a = await newTicket("Has alpha", { tags: ["alpha"] });
    const b = await newTicket("Has beta", { tags: ["beta"] });
    const ids = (await d.api("GET", `${P}/tickets?scope=list&tags=alpha`)).data.tickets.map((t: any) => t.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    const cleared = await d.api("PATCH", `${P}/tickets/${a.id}`, { tags: [] });
    expect(cleared.data.tags).toEqual([]);
    expect(meta(a.id).tags).toEqual([]);
  });
});

describe("attachments", () => {
  let url: string;
  let name: string;

  test("POST an image: 201 {url, path}; the bytes are stored under attachments/<32 hex>.<ext>", async () => {
    const up = await raw("POST", "/api/attachments", PNG, { "content-type": "image/png" });
    expect(up.status).toBe(201);
    const body = json(up.bytes);
    expect(Object.keys(body).sort()).toEqual(["path", "url"]);
    expect(body.url).toMatch(/^\/api\/attachments\/[0-9a-f]{32}\.png$/);
    name = body.url.split("/").pop();
    url = body.url;
    expect(body.path).toBe(join(attachmentsDir(), name));
    expect(new Uint8Array(readFileSync(body.path))).toEqual(PNG);
  });

  test("GET serves it with its type and safe headers; download and name set content-disposition", async () => {
    const got = await raw("GET", url);
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(PNG);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
    expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(got.headers.get("content-disposition")).toBeNull();
    const dl = await raw("GET", `${url}?download&name=My%20pic.png`);
    expect(dl.headers.get("content-disposition")).toBe("attachment; filename=\"My pic.png\"; filename*=UTF-8''My%20pic.png");
    const named = await raw("GET", `${url}?name=My%20pic.png`);
    expect(named.headers.get("content-disposition")).toBe("inline; filename=\"My pic.png\"; filename*=UTF-8''My%20pic.png");
    const info = await d.api("GET", `${url}/info`);
    expect(info).toMatchObject({ status: 200, data: { size: PNG.length } });
  });

  test("other files: the extension comes from x-file-name; text is served as plain text", async () => {
    const md = await raw("POST", "/api/attachments", "# notes\n", { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("notes v2.md") });
    expect(md.status).toBe(201);
    expect(json(md.bytes).url).toMatch(/^\/api\/attachments\/[0-9a-f]{32}\.md$/);
    const html = await raw("POST", "/api/attachments", "<script>alert(1)</script>", { "content-type": "application/octet-stream", "x-file-name": "page.html" });
    expect(html.status).toBe(201);
    const served = await raw("GET", json(html.bytes).url);
    expect(served.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
  });

  test("refused uploads: type, kind of file, empty, fake bytes, over 25 MB", async () => {
    const unsupported = "this kind of file can't be attached (images, PDF, Word, Excel, PowerPoint, text and code files can)";
    const plain = await raw("POST", "/api/attachments", "hi", { "content-type": "text/plain", "x-file-name": "x.txt" });
    expect([plain.status, json(plain.bytes)]).toEqual([415, { error: unsupported }]);
    const exe = await raw("POST", "/api/attachments", "MZ", { "content-type": "application/octet-stream", "x-file-name": "x.exe" });
    expect([exe.status, json(exe.bytes)]).toEqual([415, { error: unsupported }]);
    const empty = await raw("POST", "/api/attachments", new Uint8Array(0), { "content-type": "image/png" });
    expect([empty.status, json(empty.bytes)]).toEqual([400, { error: "file is empty" }]);
    const pdf = await raw("POST", "/api/attachments", "not a pdf", { "content-type": "application/octet-stream", "x-file-name": "a.pdf" });
    expect([pdf.status, json(pdf.bytes)]).toEqual([400, { error: "file is not a valid PDF file" }]);
    const big = await raw("POST", "/api/attachments", new Uint8Array(25 * 1024 * 1024 + 1).fill(0x41), { "content-type": "application/octet-stream", "x-file-name": "a.txt" });
    expect([big.status, json(big.bytes)]).toEqual([413, { error: "file is larger than 25 MB" }]);
    // Exactly 25 MB is allowed.
    const max = await raw("POST", "/api/attachments", new Uint8Array(25 * 1024 * 1024).fill(0x41), { "content-type": "application/octet-stream", "x-file-name": "a.txt" });
    expect(max.status).toBe(201);
  }, 30_000);

  test("names that aren't generated ones are 404; there is no list or delete route", async () => {
    for (const path of ["/api/attachments/..%2Fconfig.json", `/api/attachments/${"0".repeat(32)}.png`, "/api/attachments/abc.png", `/api/attachments/${"0".repeat(32)}.png/info`]) {
      const r = await raw("GET", path);
      expect([path, r.status, json(r.bytes)]).toEqual([path, 404, { error: "attachment not found" }]);
    }
    for (const [m, path] of [["GET", "/api/attachments"], ["DELETE", url], ["PUT", url], ["GET", `${url}/other`]]) {
      const r = await raw(m, path);
      expect([m, path, r.status, json(r.bytes)]).toEqual([m, path, 404, { error: "not found" }]);
    }
  });

  test("deleting a ticket deletes the attachments its description refers to, and only those", async () => {
    const keep = json((await raw("POST", "/api/attachments", PNG, { "content-type": "image/png" })).bytes).url.split("/").pop();
    const t = await newTicket("Has a picture", { body: `see ![pic](${url})` });
    expect(existsSync(join(attachmentsDir(), name))).toBe(true);
    expect((await d.api("DELETE", `${P}/tickets/${t.id}`)).status).toBe(204);
    expect(existsSync(join(attachmentsDir(), name))).toBe(false);
    expect(readdirSync(attachmentsDir())).toContain(keep);
  });
});

describe("ticket links", () => {
  test("claude.ai artifact links in Claude's comments show in the view's links, newest first", async () => {
    const t = await newTicket("Linky");
    expect(t.links).toEqual([]);
    // Claude's result summaries are `ai` comments (comments.jsonl); an artifact URL in one is a link, labelled by its
    // Markdown text when it has one.
    const line = (id: string, text: string, at: string) => JSON.stringify({ id, author: "ai", text, at }) + "\n";
    appendFileSync(join(ticketDir(t.id), "comments.jsonl"),
      line("c1", "Done: https://claude.ai/artifact/aaa-111", "2026-11-15T08:00:00.000Z")
      + line("c2", "See [the chart](https://claude.ai/code/artifact/bbb-222).", "2026-11-15T09:00:00.000Z"));
    // The card's links are re-read after the daemon's own next comment write (an outside append alone isn't seen).
    expect((await d.api("POST", `${P}/tickets/${t.id}/comments`, { text: "user note" })).status).toBe(201);
    const links = await until(async () => {
      const l = (await ticket(t.id)).links;
      return l.length === 2 ? l : null;
    }, 5_000, "the links");
    expect(links).toEqual([
      { url: "https://claude.ai/code/artifact/bbb-222", label: "the chart", at: "2026-11-15T09:00:00.000Z", source: "result" },
      { url: "https://claude.ai/artifact/aaa-111", label: "claude.ai artifact", at: "2026-11-15T08:00:00.000Z", source: "result" },
    ]);
  });
});

describe("cards and board ordering", () => {
  test("new Backlog cards go on top; Ready appends; order, pinned and important are saved", async () => {
    const o1 = await newTicket("Order one");
    const o2 = await newTicket("Order two");
    expect(o2.order).toBeLessThan(o1.order);
    expect(meta(o1.id).order).toBe(o1.order);
    const top = (await d.api("GET", `${P}/tickets?scope=board`)).data.tickets.filter((t: any) => t.status === "backlog");
    expect(top[0].id).toBe(o2.id);

    const moved = await d.api("PATCH", `${P}/tickets/${o1.id}`, { order: -1000 });
    expect(moved.data.order).toBe(-1000);
    expect(meta(o1.id).order).toBe(-1000);
    expect((await d.api("GET", `${P}/tickets?scope=board`)).data.tickets[0].id).toBe(o1.id);

    const pinned = await d.api("PATCH", `${P}/tickets/${o2.id}`, { pinned: true, important: true });
    expect(pinned.status).toBe(200);
    expect(pinned.data.important).toBe(true);
    expect(typeof pinned.data.pinnedAt).toBe("string");
    expect(meta(o2.id)).toMatchObject({ important: true, pinnedAt: pinned.data.pinnedAt });
    expect(await d.api("PATCH", `${P}/tickets/${o2.id}`, { pinned: "yes" })).toMatchObject({ status: 400, data: { error: "pinned must be true or false" } });
    expect(await d.api("PATCH", `${P}/tickets/${o2.id}`, { important: 1 })).toMatchObject({ status: 400, data: { error: "important must be true or false" } });
    expect(await d.api("PATCH", `${P}/tickets/${o2.id}`, { status: "sideways" })).toMatchObject({ status: 400, data: { error: "invalid status sideways" } });

    // Done: doneAt set, the pin cleared.
    const done = await d.api("PATCH", `${P}/tickets/${o2.id}`, { status: "done" });
    expect(done.data.status).toBe("done");
    const m = meta(o2.id);
    expect(typeof m.doneAt).toBe("string");
    expect(m.pinnedAt ?? null).toBeNull();
    const { meta: front, body } = parseTicketFile(readFileSync(join(ticketDir(o2.id), "ticket.md"), "utf8"));
    expect(schemaProblems("ticket.schema.json", { ...front, body }, o2.id)).toEqual([]);
  });

  test("a run may not reorder cards: order is dropped from a run's change", async () => {
    const t = await newTicket("Not by a run");
    // A run without rights is refused outright.
    const r = await d.api("PATCH", `${P}/tickets/${t.id}`, { order: 5 }, { "x-ckanban-run": `${SLUG}/t_20000101_none` });
    expect(r.status).toBe(403);
    expect(meta(t.id).order).toBe(t.order);
  });

  test("scopes: count, board with done, done pages, ids, search; bad scope or status", async () => {
    const count = (await d.api("GET", `${P}/tickets?scope=count`)).data;
    expect(Object.keys(count).sort()).toEqual(["doneTotal", "open", "total"]);
    expect(count.doneTotal).toBeGreaterThanOrEqual(1);
    expect(count.total).toBe(count.open + count.doneTotal);

    const board0 = (await d.api("GET", `${P}/tickets?scope=board`)).data;
    expect(Object.keys(board0).sort()).toEqual(expect.arrayContaining(["doneTotal", "tickets"]));
    expect(board0.tickets.every((t: any) => t.status !== "done")).toBe(true);
    const board1 = (await d.api("GET", `${P}/tickets?scope=board&done=1`)).data;
    expect(board1.tickets.filter((t: any) => t.status === "done")).toHaveLength(1);
    expect(board1.doneTotal).toBe(count.doneTotal);

    const done = (await d.api("GET", `${P}/tickets?scope=done&limit=1`)).data;
    expect(done.tickets).toHaveLength(1);
    expect(done.tickets[0].status).toBe("done");
    expect(done.doneTotal).toBe(count.doneTotal);

    const a = await newTicket("Findable zebra");
    const ids = (await d.api("GET", `${P}/tickets?scope=ids&ids=${a.id},t_20000101_none`)).data;
    expect(ids.tickets.map((t: any) => t.id)).toEqual([a.id]);
    // search looks in Done only.
    expect((await d.api("GET", `${P}/tickets?scope=search&q=zebra`)).data.tickets).toEqual([]);
    await d.api("PATCH", `${P}/tickets/${a.id}`, { status: "done" });
    const search = (await d.api("GET", `${P}/tickets?scope=search&q=zebra`)).data;
    expect(search.tickets.map((t: any) => t.id)).toEqual([a.id]);

    expect(await d.api("GET", `${P}/tickets?scope=bogus`)).toMatchObject({ status: 400, data: { error: "scope must be board, done, search, ids, list or count" } });
    const status = await d.api("GET", `${P}/tickets?scope=list&status=bogus`);
    expect(status.status).toBe(400);
    expect(status.data.error).toStartWith("status must be one of ");
    // No scope: every ticket as a plain array.
    const all = (await d.api("GET", `${P}/tickets`)).data;
    expect(Array.isArray(all)).toBe(true);
    expect(all.map((t: any) => t.id)).toContain(a.id);
  });
});

describe("board lists across boards", () => {
  test("GET /api/tickets: one light row per ticket, long texts capped at 4000", async () => {
    const t = await newTicket("Long one", { body: "x".repeat(5000) });
    const rows = (await d.api("GET", "/api/tickets")).data;
    const row = rows.find((r: any) => r.id === t.id);
    expect(Object.keys(row).sort()).toEqual(["body", "id", "prUrl", "profile", "profileName", "running", "status", "summary", "title", "updatedAt"]);
    expect(row).toMatchObject({ profile: SLUG, profileName: "Items", title: "Long one", status: "backlog", running: false, summary: "", prUrl: null });
    expect(row.body).toHaveLength(4000);
  });

  test("scope=open leaves out Done; scope=done finds Done by words; another scope is 400", async () => {
    const open = (await d.api("GET", "/api/tickets?scope=open")).data;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((r: any) => r.status !== "done")).toBe(true);
    const t = await newTicket("Quokka finished", { body: "about quokkas" });
    await d.api("PATCH", `${P}/tickets/${t.id}`, { status: "done" });
    const done = (await d.api("GET", "/api/tickets?scope=done&q=quokka")).data;
    expect(done.map((r: any) => r.id)).toEqual([t.id]);
    expect(done[0]).toMatchObject({ profile: SLUG, status: "done", title: "Quokka finished" });
    expect(await d.api("GET", "/api/tickets?scope=bogus")).toMatchObject({ status: 400, data: { error: "scope must be open or done" } });
  });

  test("GET /api/inbox: a finished work run waits for review; snooze keeps it with snoozedUntil; unsnooze clears it", async () => {
    // Created in Ready, a ticket starts work at once; the fake Claude finishes it and it waits in Review.
    const t = await newTicket("Review me", { body: "do it", status: "ready" });
    await until(async () => {
      const v = await ticket(t.id);
      return v.status === "review" && !v.running;
    }, 20_000, "the work run to finish in review");
    const entry = await until(async () => (await d.api("GET", "/api/inbox")).data.find((r: any) => r.id === t.id), 10_000, "the inbox entry");
    expect(Object.keys(entry).sort()).toEqual(["attention", "id", "profile", "profileName", "title"]);
    expect(entry).toMatchObject({ profile: SLUG, profileName: "Items", title: "Review me", attention: { kind: "review", label: "Ready for review" } });

    const snoozed = await d.api("POST", `${P}/tickets/${t.id}/snooze`, { hours: 2 });
    expect(snoozed.status).toBe(200);
    expect(snoozed.data.attention).toBeNull();
    const later = (await d.api("GET", "/api/inbox")).data.find((r: any) => r.id === t.id);
    expect(later.attention.kind).toBe("review");
    expect(Date.parse(later.snoozedUntil) - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(await d.api("POST", `${P}/tickets/${t.id}/snooze`, { hours: 0 })).toMatchObject({ status: 400, data: { error: "hours must be between 0 and 720" } });
    expect((await d.api("POST", `${P}/tickets/${t.id}/snooze`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);

    expect((await d.api("DELETE", `${P}/tickets/${t.id}/snooze`)).status).toBe(200);
    const back = (await d.api("GET", "/api/inbox")).data.find((r: any) => r.id === t.id);
    expect(back.snoozedUntil).toBeUndefined();
    // A ticket that doesn't need the user has nothing to snooze.
    const idle = await newTicket("Idle");
    expect(await d.api("POST", `${P}/tickets/${idle.id}/snooze`, {})).toMatchObject({ status: 409, data: { error: "this ticket doesn't need you, nothing to snooze" } });
  }, 40_000);
});

describe("event stream", () => {
  test("create, change, comment and delete send ticket.updated (the TicketView) and ticket.deleted", async () => {
    const s = await listen();
    try {
      const t = await newTicket("Streamed");
      const created = await s.wait("ticket.updated for the new ticket", (e) => e.type === "ticket.updated" && e.ticket?.id === t.id);
      expect(created.profile).toBe(SLUG);
      // The ticket is the TicketView, not the bare file.
      expect(created.ticket).toMatchObject({ id: t.id, title: "Streamed", status: "backlog", running: false });
      expect(Array.isArray(created.ticket.links)).toBe(true);

      await d.api("PATCH", `${P}/tickets/${t.id}`, { tags: ["streamed"] });
      await s.wait("ticket.updated with the tag", (e) => e.type === "ticket.updated" && e.ticket?.id === t.id && e.ticket.tags?.includes("streamed"));
      await d.api("PATCH", `${P}/tickets/${t.id}`, { pinned: true });
      await s.wait("ticket.updated with the pin", (e) => e.type === "ticket.updated" && e.ticket?.id === t.id && typeof e.ticket.pinnedAt === "string");

      expect((await d.api("DELETE", `${P}/tickets/${t.id}`)).status).toBe(204);
      const gone = await s.wait("ticket.deleted", (e) => e.type === "ticket.deleted" && e.id === t.id);
      expect(gone).toEqual({ type: "ticket.deleted", profile: SLUG, id: t.id });
    } finally {
      await s.close();
    }
  });

  test("moving a ticket to another board sends ticket.deleted for the old one and ticket.updated on the new board", async () => {
    mkdirSync(join(d.project, "elsewhere"), { recursive: true });
    expect((await d.api("POST", "/api/profiles", { name: "Elsewhere", path: join(d.project, "elsewhere") })).status).toBe(201);
    const t = await newTicket("Traveller", { tags: ["trip"] });
    const s = await listen();
    try {
      const moved = await d.api("POST", `${P}/tickets/${t.id}/move`, { board: "elsewhere" });
      expect(moved.status).toBe(201);
      expect(moved.data).toMatchObject({ title: "Traveller", tags: ["trip"], status: "backlog" });
      expect(meta(moved.data.id, "elsewhere").tags).toEqual(["trip"]);
      await s.wait("ticket.deleted on the old board", (e) => e.type === "ticket.deleted" && e.profile === SLUG && e.id === t.id);
      await s.wait("ticket.updated on the new board", (e) => e.type === "ticket.updated" && e.profile === "elsewhere" && e.ticket?.id === moved.data.id);
    } finally {
      await s.close();
    }
  });
});
