// Outside-in contract: the board's writes that need no run (Rust port R2a, docs/rust-port-board-plan.md): boards
// POST/PATCH/DELETE, tickets created, changed, moved between columns and boards, deleted; comments, snooze, seen, the
// chat's squad and teammate cards, attachments, avatars and snippets; a saved key masked in answers and in the
// comments file. One script of requests, checked against any server; under a Rust server (CKANBAN_CONTRACT_DAEMON
// set) the same script also runs on Bun alone and both must answer the same and leave the same bytes in the data
// folder (ids and times aside). Nothing here starts a run: no ticket goes to Ready or Planning.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { dropRunTemp, Golden } from "./golden";

const SLUG = "writes";
const SECRET = "sntrys_SECRET_value_9d1c42aa";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A board key saved before the start: every answer and every comment written must hide it. */
function seed(home: string): void {
  const at = "2026-11-01T08:00:00.000Z";
  const pass = { id: "k1", kind: "key", name: "Sentry", claudeName: null, envName: "SENTRY_TOKEN", board: SLUG, secret: SECRET, status: "connected", error: null, createdAt: at, savedAt: at };
  const f = join(home, "automation-passes.json");
  writeFileSync(f, JSON.stringify({ version: 1, passes: [pass] }, null, 2) + "\n");
  chmodSync(f, 0o600);
}

interface Step {
  what: string;
  status: number;
  data: unknown;
}

/**
 * The script: every request in order, with the answers. `check` runs the concrete expectations (any server); the
 * answers come back for the comparison with Bun.
 */
async function script(d: Daemon, check: boolean): Promise<Step[]> {
  const steps: Step[] = [];
  const P = `/api/profiles/${SLUG}`;
  const call = async (what: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await d.api(method, path, body, headers);
    steps.push({ what, status: r.status, data: r.data });
    if (check) expect(r.text.includes(SECRET)).toBe(false);
    return r;
  };
  const expectStatus = (r: { status: number }, s: number, what: string) => {
    if (check) expect({ what, status: r.status }).toEqual({ what, status: s });
  };

  // Boards.
  expectStatus(await call("board", "POST", "/api/profiles", { name: "Writes", path: d.project, effort: "high" }), 201, "board");
  expectStatus(await call("board no name", "POST", "/api/profiles", { path: d.project }), 400, "board no name");
  expectStatus(await call("board same folder", "POST", "/api/profiles", { name: "Again", path: d.project }), 400, "board same folder");
  expectStatus(await call("board bad effort", "POST", "/api/profiles", { name: "X", path: d.project, effort: "huge" }), 400, "bad effort");
  const other = join(d.project, "other");
  await Bun.write(join(other, "README.md"), "other\n");
  expectStatus(await call("other board", "POST", "/api/profiles", { name: "Other board", path: other }), 201, "other board");
  const patched = await call("board patch", "PATCH", P, { name: "Writes 2", copyFiles: [" .env ", ".env", ""], stallMinutes: 30, runCapUsd: 0, freshChatTokens: 1234.6, taskModels: { build: { model: "sonnet", effort: "low" }, review: { model: "fable", effort: "high" } }, claudeAiConnectors: "none", ultracode: true });
  expectStatus(patched, 200, "board patch");
  if (check) expect(patched.data).toMatchObject({ name: "Writes 2", copyFiles: [".env"], stallMinutes: 30, runCapUsd: null, freshChatTokens: 1235, taskModels: { build: { model: "sonnet", effort: "low" } }, claudeAiConnectors: "none", ultracode: true });
  expectStatus(await call("board bad stall", "PATCH", P, { stallMinutes: 1.5 }), 400, "bad stall");
  expectStatus(await call("board run cap from a run", "PATCH", P, { runCapUsd: 3 }, { "x-ckanban-run": `${SLUG}/t_20000101_none` }), 403, "cap from run");

  // Tickets.
  const a = await call("create A", "POST", `${P}/tickets`, { title: "⭐ First ticket", body: `Uses ${SECRET} somewhere`, tags: ["UI", "#ui", "Big Thing"], needs: [" Phone ", "phone"] });
  expectStatus(a, 201, "create A");
  if (check) expect(a.data).toMatchObject({ title: "First ticket", important: true, tags: ["ui", "big-thing"], needs: ["phone"], status: "backlog", mode: "interview", main: true, body: "Uses *** somewhere" });
  const A = `${P}/tickets/${a.data.id}`;
  const b = await call("create B", "POST", `${P}/tickets`, { title: "Second", status: "review", mode: "auto", important: true });
  const B = `${P}/tickets/${b.data.id}`;
  const c = await call("create C", "POST", `${P}/tickets`, { title: "Travels", body: "goes elsewhere", tags: ["trip"] });
  const C = `${P}/tickets/${c.data.id}`;
  expectStatus(await call("create no title", "POST", `${P}/tickets`, { body: "x" }), 400, "no title");
  expectStatus(await call("create bad kind", "POST", `${P}/tickets`, { title: "k", kind: "nope" }), 400, "bad kind");
  expectStatus(await call("create bad model", "POST", `${P}/tickets`, { title: "m", model: "gpt" }), 400, "bad model");
  expectStatus(await call("create under another", "POST", `${P}/tickets`, { title: "u", parentId: a.data.id }), 400, "under another");

  expectStatus(await call("rename A", "PATCH", A, { title: "Renamed", body: "New body.", expectedBody: `Uses ${SECRET} somewhere` }), 200, "rename A");
  expectStatus(await call("stale body", "PATCH", A, { body: "x", expectedBody: "not it" }), 409, "stale body");
  expectStatus(await call("tags A", "PATCH", A, { tags: ["Alpha", "beta"], suggestedTags: ["beta", "gamma"] }), 200, "tags A");
  expectStatus(await call("pin A", "PATCH", A, { pinned: true }), 200, "pin A");
  expectStatus(await call("order A", "PATCH", A, { order: 7 }), 200, "order A");
  const done = await call("A to done", "PATCH", A, { status: "done" });
  if (check) expect(done.data).toMatchObject({ status: "done", pinnedAt: null });
  const back = await call("A to backlog", "PATCH", A, { status: "backlog" });
  if (check) expect(back.data.reopenedFrom).toEqual({ status: "done", outcome: null });
  expectStatus(await call("A settings", "PATCH", A, { important: false, mode: "auto", notice: null, runCapUsd: 2, model: "opus", effort: "high", ultracode: true }), 200, "A settings");
  expectStatus(await call("bad status", "PATCH", A, { status: "sideways" }), 400, "bad status");
  expectStatus(await call("bad pinned", "PATCH", A, { pinned: "yes" }), 400, "bad pinned");
  expectStatus(await call("bad parentId", "PATCH", A, { parentId: "x" }), 400, "bad parentId");
  expectStatus(await call("model from a run", "PATCH", A, { model: "opus" }, { "x-ckanban-run": `${SLUG}/${b.data.id}` }), 403, "model from run");
  expectStatus(await call("change from an idle run", "PATCH", A, { title: "x" }, { "x-ckanban-run": `${SLUG}/${b.data.id}` }), 403, "idle run");
  expectStatus(await call("own ticket from its run", "PATCH", B, { title: "x" }, { "x-ckanban-run": `${SLUG}/${b.data.id}` }), 403, "own run");
  expectStatus(await call("star from its own run", "PATCH", B, { important: false }, { "x-ckanban-run": `${SLUG}/${b.data.id}` }), 200, "own star");
  expectStatus(await call("unknown ticket", "PATCH", `${P}/tickets/t_20000101_none`, { title: "x" }), 404, "unknown ticket");

  // Comments: masked as they are saved.
  const note = await call("comment", "POST", `${A}/comments`, { text: `  see ${SECRET}  ` });
  expectStatus(note, 201, "comment");
  if (check) expect(note.data).toMatchObject({ author: "user", text: "see ***" });
  expectStatus(await call("empty comment", "POST", `${A}/comments`, { text: " " }), 400, "empty comment");
  await call("comment 2", "POST", `${A}/comments`, { text: "second" });
  const page = await call("comments page", "GET", `${A}/comments?last=1`);
  if (check) expect(page.data).toMatchObject({ earlier: 1, total: 2, comments: [{ text: "second" }] });
  await call("all comments", "GET", `${A}/comments`);

  // Inbox snooze (B waits in Review), seen, cards.
  expectStatus(await call("snooze idle", "POST", `${A}/snooze`, {}), 409, "snooze idle");
  expectStatus(await call("snooze bad hours", "POST", `${B}/snooze`, { hours: 9999 }), 400, "snooze hours");
  const snoozed = await call("snooze B", "POST", `${B}/snooze`, { forever: true });
  expectStatus(snoozed, 200, "snooze B");
  if (check) expect(snoozed.data.snooze.until).toBe("9999-12-31T23:59:59.000Z");
  expectStatus(await call("unsnooze B", "DELETE", `${B}/snooze`), 200, "unsnooze B");
  expectStatus(await call("snooze from a run", "POST", `${B}/snooze`, {}, { "x-ckanban-run": `${SLUG}/${a.data.id}` }), 403, "snooze run");
  const seen = await call("seen B", "POST", `${B}/seen`, {});
  if (check) expect(typeof seen.data.seenAt).toBe("string");
  expectStatus(await call("squad card", "PUT", `${A}/squad-cards/s1`, { state: "saved", name: " Crew ", scope: "board" }), 200, "squad card");
  expectStatus(await call("teammate card", "PUT", `${A}/teammate-cards/m1`, { state: "dismissed" }), 200, "teammate card");
  expectStatus(await call("bad card", "PUT", `${A}/squad-cards/s2`, { state: "maybe" }), 400, "bad card");
  expectStatus(await call("card from a run", "PUT", `${A}/teammate-cards/m2`, { state: "saved" }, { "x-ckanban-run": `${SLUG}/${b.data.id}` }), 403, "card run");

  // Move C to the other board; then B (Review) can't move.
  const moved = await call("move C", "POST", `${C}/move`, { board: "other-board" });
  expectStatus(moved, 201, "move C");
  expectStatus(await call("move B", "POST", `${B}/move`, { board: "other-board" }), 400, "move B");
  expectStatus(await call("move nowhere", "POST", `${B}/move`, { board: "nope" }), 404, "move nowhere");

  // Attachments: a pasted image, referenced by a ticket that is then deleted (the file goes with it).
  const res = await fetch(`${d.url}/api/attachments`, { method: "POST", body: PNG, headers: { "content-type": "image/png" } });
  const up = { status: res.status, data: await res.json() as any };
  steps.push({ what: "upload", status: up.status, data: up.data });
  expectStatus(up, 201, "upload");
  const name = String(up.data.url).split("/").pop()!;
  const got = await fetch(`${d.url}${up.data.url}?name=${encodeURIComponent("my [pic].png")}`);
  if (check) {
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-disposition")).toBe(`inline; filename="my (pic).png"; filename*=UTF-8''my%20(pic).png`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  }
  await call("attachment info", "GET", `${up.data.url}/info`);
  const pic = await call("create D", "POST", `${P}/tickets`, { title: "Has a picture", body: `![shot](/api/attachments/${name})` });
  expectStatus(await call("delete D", "DELETE", `${P}/tickets/${pic.data.id}`), 204, "delete D");
  if (check) expect(existsSync(join(d.home, "attachments", name))).toBe(false);
  expectStatus(await call("delete B from a run", "DELETE", B, undefined, { "x-ckanban-run": `${SLUG}/${a.data.id}` }), 403, "delete from run");
  expectStatus(await call("delete B", "DELETE", B), 204, "delete B");
  expectStatus(await call("B is gone", "GET", B), 404, "B gone");

  // Avatars and snippets.
  expectStatus(await call("avatar", "PUT", "/api/avatars/qa", { face: "cat", color: "#AABBCC", accessory: "crown" }), 200, "avatar");
  expectStatus(await call("claude name", "PUT", "/api/avatars/claude/name", { name: "  Clawd " }), 200, "claude name");
  expectStatus(await call("avatar from a run", "PUT", "/api/avatars/qa", { face: "cat" }, { "x-ckanban-run": `${SLUG}/${a.data.id}` }), 403, "avatar run");
  await call("avatars", "GET", "/api/avatars");
  const sn = await call("snippet", "POST", "/api/snippets", { name: "@greet", text: "hello", scope: SLUG });
  expectStatus(sn, 201, "snippet");
  expectStatus(await call("snippet again", "POST", "/api/snippets", { name: "greet", text: "x", scope: SLUG }), 409, "snippet twice");
  await call("snippet global", "POST", "/api/snippets", { name: "bye", text: "bye now" });
  expectStatus(await call("snippet patch", "PATCH", `/api/snippets/${sn.data.id}`, { text: "hello there" }), 200, "snippet patch");
  await call("snippets", "GET", `/api/snippets?profile=${SLUG}`);

  // The other board goes, with its own snippets.
  await call("other snippet", "POST", "/api/snippets", { name: "away", text: "gone soon", scope: "other-board" });
  expectStatus(await call("delete other board", "DELETE", "/api/profiles/other-board"), 204, "delete board");
  expectStatus(await call("other board gone", "GET", "/api/profiles/other-board"), 404, "board gone");
  if (check) expect(JSON.stringify((await d.api("GET", "/api/snippets")).data)).not.toContain("gone soon");
  await call("tickets", "GET", `${P}/tickets`);
  return steps;
}

/** The data files the writes leave, by path under the data folder (what Bun and Rust must both write). */
function files(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(home, f)] = readFileSync(f, "utf8");
    }
  };
  for (const sub of ["profiles", "attachments"]) if (existsSync(join(home, sub))) walk(join(home, sub));
  for (const f of ["avatars.json", "snippets.json"]) if (existsSync(join(home, f))) out[f] = readFileSync(join(home, f), "utf8");
  // The board's own parent suggestions (R12, a side call in Bun) aren't part of R2a.
  for (const k of Object.keys(out)) if (k.endsWith("side-spend.jsonl")) delete out[k];
  return out;
}

/** Ids, times and generated names replaced by their order of appearance, so two runs of the script compare. */
function normalize(text: string): string {
  const seen = new Map<string, string>();
  const name = (kind: string) => (m: string) => {
    if (!seen.has(m)) seen.set(m, `<${kind}${seen.size}>`);
    return seen.get(m)!;
  };
  return dropRunTemp(text)
    .replace(/t_\d{8}_[a-z0-9]{4}/g, name("ticket"))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (m) => (m.startsWith("9999") ? m : "<time>"))
    .replace(/[0-9a-f]{32}\.png/g, name("file"))
    .replace(/"id": ?"[0-9a-z]{8}"/g, name("id"))
    .replace(/^id: [0-9a-z]{8}$/gm, name("id"))
    .replace(/\/tmp\/[^"\n]*|\/private\/var\/[^"\n]*|\/var\/folders\/[^"\n]*/g, "<path>")
    // Bun's linker settles each new ticket (R12): its marks aren't R2a's.
    .replace(/^parentChecked: true\n/gm, "")
    .replace(/^parentSuggestion: null\n/gm, "")
    .replace(/,?"parent(Checked|Suggestion)":(true|null)/g, "");
}

let d: Daemon;
let steps: Step[] = [];

beforeAll(async () => {
  d = await startDaemon({ before: ({ home }) => seed(home) });
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

describe("board writes without a run", () => {
  test("the script's answers, files and masking", async () => {
    steps = await script(d, true);
    // Saved keys never reach a ticket's files: the body and the comments hold *** instead.
    const dir = join(d.home, "profiles", SLUG, "tickets");
    for (const id of readdirSync(dir)) {
      for (const f of readdirSync(join(dir, id))) expect(readFileSync(join(dir, id, f), "utf8")).not.toContain(SECRET);
    }
    const comments = readdirSync(dir).flatMap((id) => (existsSync(join(dir, id, "comments.jsonl")) ? [readFileSync(join(dir, id, "comments.jsonl"), "utf8")] : []));
    expect(comments.join("")).toContain('"text":"see ***"');
  }, 60_000);
});

describe("writes as Bun's did", () => {
  test("the same answers and the same bytes in the data folder as Bun (golden/board-writes.json)", async () => {
    const golden = new Golden("board-writes");
    {
      const theirs = steps;
      // Answers by value (key order isn't part of the API); the files below are compared byte for byte.
      const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)])) : v;
      for (const s of theirs) golden.match(`step ${s.what}`, { what: s.what, status: s.status, data: normalize(JSON.stringify(sorted(s.data))) });
      const fs = files(d.home);
      // Tickets, comments, the board, avatars and snippets are all in the comparison.
      for (const end of ["ticket.md", "comments.jsonl", "profile.json", "avatars.json", "snippets.json"]) {
        expect({ end, found: Object.keys(fs).some((k) => k.endsWith(end)) }).toEqual({ end, found: true });
      }
      const norm = Object.entries(fs).map(([k, v]) => [normalize(k), normalize(v)] as const).sort(([x], [y]) => x.localeCompare(y));
      golden.match("files", norm.map(([k]) => k));
      for (const [k, v] of norm) golden.match(`file ${k}`, v);
      golden.done();
    }
  }, 120_000);
});
