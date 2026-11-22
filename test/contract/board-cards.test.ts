// Outside-in contract: card routes (who may answer them), seen, follow-up set and cancel, own-work, board PATCH and
// DELETE, and paging the Done column of a board with many Done tickets. See contracts/api.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { schemaProblems } from "./schema";

let d: Daemon;
const SLUG = "cards";
const P = `/api/profiles/${SLUG}`;

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Cards", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const ticketDir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const meta = (id: string) => parseTicketFile(readFileSync(join(ticketDir(id), "ticket.md"), "utf8")).meta;
const newTicket = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await d.api("POST", `${P}/tickets`, { title, ...extra });
  expect(r.status).toBe(201);
  return r.data;
};
const userOnly = (what: string) =>
  `${what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board.`;

describe("card routes", () => {
  test("user-only cards refuse a request that isn't from the user's browser", async () => {
    const t = await newTicket("Carded");
    const cases: [string, string, string][] = [
      ["PUT", "automation-cards", "Answering an automation card"],
      ["PUT", "closed-forms", "Closing a question"],
      ["PUT", "schedule-delete-cards", "Deleting a schedule"],
      ["PUT", "helper-rule-cards", "Adding to what the helper knows about you"],
      ["POST", "key-cards", "Saving keys"],
    ];
    for (const [m, card, what] of cases) {
      for (const headers of [{}, { origin: d.url }, { "x-ckanban-run": `${SLUG}/${t.id}` }] as Record<string, string>[]) {
        const r = await d.api(m, `${P}/tickets/${t.id}/${card}/u1`, { state: "added", loopId: "x", keys: { A: "b" } }, headers);
        expect([card, r.status, r.data]).toEqual([card, 403, { error: userOnly(what) }]);
      }
    }
  });

  test("squad and teammate cards: the user's answer is saved by card id; a run or huddle helper is refused", async () => {
    const t = await newTicket("Team cards");
    const squad = await d.api("PUT", `${P}/tickets/${t.id}/squad-cards/s1`, { state: "saved", name: "Reviewers" });
    expect(squad.status).toBe(200);
    expect(squad.data.squadCards.s1).toMatchObject({ state: "saved", name: "Reviewers" });
    const mate = await d.api("PUT", `${P}/tickets/${t.id}/teammate-cards/m1`, { state: "dismissed" });
    expect(mate.data.teammateCards.m1).toMatchObject({ state: "dismissed" });
    expect(meta(t.id)).toMatchObject({ squadCards: { s1: { state: "saved", name: "Reviewers" } }, teammateCards: { m1: { state: "dismissed" } } });
    expect(typeof meta(t.id).squadCards.s1.at).toBe("string");
    expect(await d.api("PUT", `${P}/tickets/${t.id}/squad-cards/s1`, { state: "saved" }, { "x-ckanban-run": `${SLUG}/${t.id}` }))
      .toMatchObject({ status: 403, data: { error: "only the user answers squad cards" } });
    expect(await d.api("PUT", `${P}/tickets/${t.id}/teammate-cards/m1`, { state: "saved" }, { "x-ckanban-huddle-agent": "tok" }))
      .toMatchObject({ status: 403, data: { error: "only the user answers teammate cards" } });
    expect((await d.api("PUT", `${P}/tickets/${t.id}/squad-cards/s2`, { state: "maybe" })).status).toBe(400);
  });
});

describe("seen, follow-ups and own-work", () => {
  test("POST .../seen stamps seenAt; a run may not", async () => {
    const t = await newTicket("Seen");
    const r = await d.api("POST", `${P}/tickets/${t.id}/seen`, {});
    expect(r.status).toBe(200);
    expect(typeof r.data.seenAt).toBe("string");
    expect(meta(t.id).seenAt).toBe(r.data.seenAt);
    expect(await d.api("POST", `${P}/tickets/${t.id}/seen`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` }))
      .toMatchObject({ status: 403, data: { error: "only the user's board marks a ticket seen" } });
  });

  test("follow-up: set by the ticket's own run (201, saved in ticket.md, an ai comment), stopped with DELETE", async () => {
    const t = await newTicket("Follow me");
    const set = await d.api("POST", `${P}/tickets/${t.id}/follow-up`, { after: "2h", note: "Check the reply", cancelOnReply: false }, { "x-ckanban-run": `${SLUG}/${t.id}` });
    expect(set.status).toBe(201);
    expect(set.data.followUp).toMatchObject({ note: "Check the reply", cancelOnReply: false });
    expect(Date.parse(set.data.followUp.dueAt) - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(meta(t.id).followUp).toEqual(set.data.followUp);
    expect(readJsonl(join(ticketDir(t.id), "comments.jsonl")).at(-1)).toMatchObject({ author: "ai" });
    expect(readJsonl(join(ticketDir(t.id), "comments.jsonl")).at(-1).text).toStartWith("Follow-up set for ");
    const { meta: front, body } = parseTicketFile(readFileSync(join(ticketDir(t.id), "ticket.md"), "utf8"));
    expect(schemaProblems("ticket.schema.json", { ...front, body }, t.id)).toEqual([]);

    expect(await d.api("POST", `${P}/tickets/${t.id}/follow-up`, { after: "2h", note: "x" }, { "x-ckanban-run": `${SLUG}/t_20000101_none` }))
      .toMatchObject({ status: 403, data: { error: "a run can only set or stop follow-ups on its own ticket" } });
    expect(await d.api("POST", `${P}/tickets/${t.id}/follow-up`, { after: "2h" }))
      .toMatchObject({ status: 400, data: { error: "note is required: why you come back, and what to check then" } });

    const stop = await d.api("DELETE", `${P}/tickets/${t.id}/follow-up`, { reason: "Got it" });
    expect(stop.status).toBe(200);
    expect(stop.data.followUp ?? null).toBeNull();
    expect(meta(t.id).followUp ?? null).toBeNull();
    // Stopping again is still 200.
    expect((await d.api("DELETE", `${P}/tickets/${t.id}/follow-up`)).status).toBe(200);
  });

  test("own-work: a main ticket already is; a work run may not", async () => {
    const t = await newTicket("Own");
    expect(await d.api("POST", `${P}/tickets/${t.id}/own-work`, {})).toMatchObject({ status: 400, data: { error: "\"Own\" is already its own work" } });
    expect(await d.api("POST", `${P}/tickets/${t.id}/own-work`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` }))
      .toMatchObject({ status: 403, data: { error: "making a task its own work works from a chat, in a reply to a message the user typed there" } });
  });
});

describe("Done paging on a board with many Done tickets", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 45; i++) {
      const t = await newTicket(`Finished ${i}`);
      expect((await d.api("PATCH", `${P}/tickets/${t.id}`, { status: "done" })).status).toBe(200);
      ids.push(t.id);
    }
  }, 60_000);

  test("scope=done pages of 20 by default, by offset or after a cursor, with doneTotal", async () => {
    const first = (await d.api("GET", `${P}/tickets?scope=done`)).data;
    expect(first.tickets).toHaveLength(20);
    expect(first.doneTotal).toBeGreaterThanOrEqual(45);
    // The newest Done first.
    expect(first.tickets[0].id).toBe(ids.at(-1));
    const second = (await d.api("GET", `${P}/tickets?scope=done&offset=20`)).data;
    const cursor = (await d.api("GET", `${P}/tickets?scope=done&after=${first.tickets.at(-1).id}`)).data;
    expect(cursor.tickets.map((t: any) => t.id)).toEqual(second.tickets.map((t: any) => t.id));
    const seen = new Set([...first.tickets, ...second.tickets].map((t: any) => t.id));
    expect(seen.size).toBe(40);
    const small = (await d.api("GET", `${P}/tickets?scope=done&limit=5&offset=40`)).data;
    expect(small.tickets.length).toBeLessThanOrEqual(5);
    expect(small.tickets.every((t: any) => !seen.has(t.id) && t.status === "done")).toBe(true);
  });

  test("scope=board brings the first N Done; after gives doneHead; scope=list pages Done with next", async () => {
    const b = (await d.api("GET", `${P}/tickets?scope=board&done=3`)).data;
    expect(b.tickets.filter((t: any) => t.status === "done")).toHaveLength(3);
    expect(b.doneHead).toBeUndefined();
    const head = (await d.api("GET", `${P}/tickets?scope=board&done=3&after=${ids.at(-1)}`)).data;
    expect(typeof head.doneHead).toBe("string");
    const gone = (await d.api("GET", `${P}/tickets?scope=board&done=3&after=t_20000101_none`)).data;
    expect(gone.doneHead).toBeNull();

    const page = (await d.api("GET", `${P}/tickets?scope=list&status=done&limit=10`)).data;
    expect(page.tickets).toHaveLength(10);
    expect(Object.keys(page).sort()).toEqual(expect.arrayContaining(["doneLeft", "matched", "next", "tickets", "total"]));
    expect(typeof page.next).toBe("string");
    const more = (await d.api("GET", `${P}/tickets?scope=list&status=done&limit=10&after=${page.next}`)).data;
    expect(more.tickets.some((t: any) => page.tickets.some((p: any) => p.id === t.id))).toBe(false);
  });
});

describe("board PATCH and DELETE", () => {
  test("PATCH saves the settings in profile.json; bad values 400; a run may not change the cap", async () => {
    const r = await d.api("PATCH", P, { model: "opus", effort: "high", runCapUsd: 5 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ slug: SLUG, model: "opus", effort: "high", runCapUsd: 5 });
    const file = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "profile.json"), "utf8"));
    expect(file).toMatchObject({ model: "opus", effort: "high", runCapUsd: 5 });
    expect(schemaProblems("profile.schema.json", file, "profile.json")).toEqual([]);
    const effort = await d.api("PATCH", P, { effort: "max-ish" });
    expect(effort.status).toBe(400);
    expect(effort.data.error).toStartWith("\"max-ish\" is not an effort level.");
    expect(await d.api("PATCH", P, { workspace: "x" })).toMatchObject({ status: 400, data: { error: "workspace must be \"worktree\" or \"folder\"" } });
    expect(await d.api("PATCH", P, { runCapUsd: 9 }, { "x-ckanban-run": `${SLUG}/t_1` }))
      .toMatchObject({ status: 403, data: { error: "only the user can change the board's spending cap" } });
    expect((await d.api("PATCH", "/api/profiles/nope", { model: "opus" })).status).toBe(404);
  });

  test("folderTurns (One ticket at a time in my folder): missing is off, PATCH saves it as true or false", async () => {
    const before = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "profile.json"), "utf8"));
    expect(before.folderTurns).toBeUndefined();
    const on = await d.api("PATCH", P, { folderTurns: true });
    expect(on).toMatchObject({ status: 200, data: { folderTurns: true } });
    const file = JSON.parse(readFileSync(join(d.home, "profiles", SLUG, "profile.json"), "utf8"));
    expect(file.folderTurns).toBe(true);
    expect(schemaProblems("profile.schema.json", file, "profile.json")).toEqual([]);
    expect(await d.api("PATCH", P, { folderTurns: false })).toMatchObject({ status: 200, data: { folderTurns: false } });
  });

  test("DELETE removes the board and its folder; then it is 404", async () => {
    const del = await d.api("DELETE", P);
    expect(del.status).toBe(204);
    expect(existsSync(join(d.home, "profiles", SLUG))).toBe(false);
    expect(await d.api("GET", P)).toMatchObject({ status: 404, data: { error: `board ${SLUG} not found` } });
    expect((await d.api("DELETE", P)).status).toBe(404);
    expect((await d.api("GET", "/api/profiles")).data.some((p: any) => p.slug === SLUG)).toBe(false);
  });
});
