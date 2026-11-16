// Outside-in contract: boards (profiles), tickets (create, read, update, move, delete) and the ticket chat, through
// HTTP and the CLI, checking the files the daemon writes in its data folder. See contracts/api.md and
// contracts/data-files.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";

let d: Daemon;
const SLUG = "contract";

beforeAll(async () => {
  d = await startDaemon();
  const r = await d.api("POST", "/api/profiles", { name: "Contract", path: d.project });
  expect(r.status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const ticketDir = (slug: string, id: string) => join(d.home, "profiles", slug, "tickets", id);

describe("boards (profiles)", () => {
  test("POST /api/profiles makes a slug from the name and writes profile.json", async () => {
    const list = await d.api("GET", "/api/profiles");
    expect(list.status).toBe(200);
    const p = list.data.find((x: any) => x.slug === SLUG);
    expect(p).toMatchObject({ name: "Contract", slug: SLUG, path: d.project, pathExists: true, running: 0 });
    expect(typeof p.createdAt).toBe("string");
    const file = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "profile.json"), "utf8"));
    expect(file).toMatchObject({ name: "Contract", slug: SLUG, path: d.project, baseBranch: "", model: null });
    expect(file.pathExists).toBeUndefined();
    const one = await d.api("GET", `/api/profiles/${SLUG}`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({ slug: SLUG, name: "Contract" });
  });

  test("a board whose folder is missing is refused", async () => {
    const r = await d.api("POST", "/api/profiles", { name: "Contract", path: d.project + "/sub-not-there" });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("path is not a directory");
  });

  test("bad input and unknown boards", async () => {
    expect((await d.api("POST", "/api/profiles", { path: d.project })).status).toBe(400);
    const missing = await d.api("GET", "/api/profiles/nope");
    expect(missing.status).toBe(404);
    expect(typeof missing.data.error).toBe("string");
  });

  test("`ckanban profiles` lists the board", async () => {
    const r = await d.cli(["profiles"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${SLUG}  (Contract, ${d.project})`);
  });

  test("requests from another site are refused", async () => {
    const r = await d.api("POST", "/api/profiles", { name: "X", path: d.project }, { origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(r.text).toBe("forbidden");
  });
});

describe("tickets", () => {
  test("create, read, update, move and delete over HTTP", async () => {
    const created = await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "First ticket", body: "Do the thing.", tags: ["Post"] });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect(id).toMatch(/^t_\d{8}_[a-z0-9]{4}$/);
    expect(created.data).toMatchObject({ title: "First ticket", body: "Do the thing.", status: "backlog", mode: "interview", running: false });

    // The ticket file: YAML front matter, then the body.
    const file = join(ticketDir(SLUG, id), "ticket.md");
    expect(existsSync(file)).toBe(true);
    const saved = parseTicketFile(readFileSync(file, "utf8"));
    expect(saved.meta).toMatchObject({ id, title: "First ticket", status: "backlog", mode: "interview" });
    expect(saved.body).toBe("Do the thing.");

    const got = await d.api("GET", `/api/profiles/${SLUG}/tickets/${id}`);
    expect(got.status).toBe(200);
    expect(got.data).toMatchObject({ id, title: "First ticket" });

    const patched = await d.api("PATCH", `/api/profiles/${SLUG}/tickets/${id}`, { title: "Renamed", body: "New body." });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ id, title: "Renamed", body: "New body." });
    expect(parseTicketFile(readFileSync(file, "utf8"))).toMatchObject({ meta: { title: "Renamed" }, body: "New body." });

    // Move between columns (a status change that starts no run).
    const done = await d.api("PATCH", `/api/profiles/${SLUG}/tickets/${id}`, { status: "done" });
    expect(done.status).toBe(200);
    expect(done.data.status).toBe("done");
    expect(parseTicketFile(readFileSync(file, "utf8")).meta.status).toBe("done");

    const listed = await d.api("GET", `/api/profiles/${SLUG}/tickets?scope=list&status=done`);
    expect(listed.status).toBe(200);
    expect(listed.data.tickets.map((t: any) => t.id)).toContain(id);

    const del = await d.api("DELETE", `/api/profiles/${SLUG}/tickets/${id}`);
    expect(del.status).toBe(204);
    expect(existsSync(ticketDir(SLUG, id))).toBe(false);
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets/${id}`)).status).toBe(404);
  });

  test("move a Backlog ticket to another board", async () => {
    const other = d.project + "/other";
    await Bun.write(join(other, "README.md"), "other\n");
    const b = await d.api("POST", "/api/profiles", { name: "Other board", path: other });
    expect(b.status).toBe(201);
    expect(b.data.slug).toBe("other-board");
    const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Travels" })).data;
    const moved = await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/move`, { board: "other-board" });
    expect(moved.status).toBe(201);
    expect(moved.data.title).toBe("Travels");
    expect(existsSync(join(ticketDir("other-board", moved.data.id), "ticket.md"))).toBe(true);
    expect(existsSync(ticketDir(SLUG, t.id))).toBe(false);
    expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${moved.data.id}/move`, { board: "nope" })).status).toBe(404);
  });

  test("validation errors", async () => {
    const noTitle = await d.api("POST", `/api/profiles/${SLUG}/tickets`, { body: "x" });
    expect(noTitle.status).toBe(400);
    expect(noTitle.data.error).toBe("title is required");
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets?scope=bogus`)).status).toBe(400);
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets?scope=list&status=bogus`)).status).toBe(400);
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets/t_20000101_none`)).status).toBe(404);
  });

  test("the CLI creates, shows, updates, moves, lists and deletes tickets", async () => {
    const created = await d.cli(["ticket", "create", "--title", "From the CLI", "--body", "cli body", "--json"]);
    expect(created.code).toBe(0);
    const t = JSON.parse(created.stdout);
    expect(t).toMatchObject({ title: "From the CLI", body: "cli body", status: "backlog" });

    const shown = await d.cli(["ticket", "show", t.id]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(t.id);
    expect(shown.stdout).toContain("From the CLI");

    const upd = await d.cli(["ticket", "update", t.id, "--title", "CLI renamed", "--tags", "alpha,beta"]);
    expect(upd.code).toBe(0);
    const meta = parseTicketFile(readFileSync(join(ticketDir(SLUG, t.id), "ticket.md"), "utf8")).meta;
    expect(meta.title).toBe("CLI renamed");
    expect(meta.tags).toEqual(["alpha", "beta"]);

    expect((await d.cli(["ticket", "move", t.id, "review"])).code).toBe(0);
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}`)).data.status).toBe("review");

    const list = await d.cli(["ticket", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`^${t.id}  \\[review[^\\]]*\\]  CLI renamed  \\(#alpha #beta\\)$`, "m"));

    const bad = await d.cli(["ticket", "move", t.id, "sideways"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr.length).toBeGreaterThan(0);

    expect((await d.cli(["ticket", "delete", t.id])).code).toBe(0);
    expect(existsSync(ticketDir(SLUG, t.id))).toBe(false);
  }, 60_000); // Runs the CLI six times; one start takes seconds on a busy Mac.
});

describe("ticket chat", () => {
  test("a message starts a run on the fake Claude; the run log and the conversation can be read back", async () => {
    const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Chatty", body: "talk" })).data;
    const sent = await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/chat`, { text: "hello from the contract" });
    expect(sent.status).toBe(202);
    // A message to a Backlog ticket opens its Planning chat.
    expect(sent.data).toMatchObject({ id: t.id, status: "planning" });

    const ended = await until(async () => {
      const r = await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}`);
      return r.data.sessionId && r.data.runEndedAt && !r.data.running ? r.data : null;
    }, 20_000, "the chat run to end");
    expect(ended.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // The conversation is read from Claude's own session transcript, which the daemon picks up a moment later.
    const conv = await until(async () => {
      const r = await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}/conversation`);
      expect(r.status).toBe(200);
      return r.data.entries.some((e: any) => e.role === "user" && e.text === "hello from the contract") ? r.data : null;
    }, 20_000, "the conversation to show the message");
    expect(conv).toMatchObject({ start: 0, total: conv.entries.length });

    const act = await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}/activity`);
    expect(act.status).toBe(200);
    expect(Array.isArray(act.data.entries)).toBe(true);
    expect("before" in act.data).toBe(true);
    const events = act.data.entries.map((e: any) => e.event?.type);
    expect(events).toContain("ckanban_run");
    expect(events).toContain("system");

    // activity.jsonl: one {run, at, event} object per line.
    const lines = readJsonl(join(ticketDir(SLUG, t.id), "activity.jsonl"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(typeof l.run).toBe("number");
      expect(typeof l.at).toBe("string");
      expect(typeof l.event?.type).toBe("string");
    }
    expect(lines.some((l: any) => l.event.type === "user" && JSON.stringify(l.event).includes("hello from the contract"))).toBe(true);

    expect((await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/chat`, { text: "  " })).status).toBe(400);
    expect((await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}/activity?before=-1`)).status).toBe(400);
  });

  test("comments: POST adds one, GET pages them, comments.jsonl holds them", async () => {
    const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Commented" })).data;
    const c = await d.api("POST", `/api/profiles/${SLUG}/tickets/${t.id}/comments`, { text: "a note" });
    expect(c.status).toBe(201);
    expect(c.data).toMatchObject({ author: "user", text: "a note" });
    const page = await d.api("GET", `/api/profiles/${SLUG}/tickets/${t.id}/comments?last=20`);
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.data)).toContain("a note");
    const lines = readJsonl(join(ticketDir(SLUG, t.id), "comments.jsonl"));
    expect(lines.at(-1)).toMatchObject({ id: c.data.id, author: "user", text: "a note" });
    expect(typeof lines.at(-1).at).toBe("string");
  });
});
