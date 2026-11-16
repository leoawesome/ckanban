// Outside-in contract: reading and reshaping a ticket's conversation. Conversation paging, tool, agent and workflow
// details, simplify and "help me understand" (side calls answered by the fake Claude's FAKE_SIDE_JSON), context
// usage, the usage summary, rewind (preview, rewind, undo) and fork. FAKE_TRANSCRIPT makes the fake Claude save what
// it says in its session transcript, as the real CLI does. See contracts/api.md "Ticket chat, runs and conversation".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "talk";
const planDir = mkdtempSync(join(tmpdir(), "ck-contract-plan-"));
const PLAN_FILE = join(planDir, "plan.json");
const LONG = "This reply has a lot of words in it so that it can be simplified by the side call, which needs at least twenty five words in one message before it bothers at all.";
const SCRIPT = "export const meta = { name: 'review', description: 'Review', phases: [{ title: 'Review' }] }";

writeFileSync(PLAN_FILE, JSON.stringify([
  { match: "LONG", text: LONG },
  { match: "SUBAGENT", tools: [{ name: "Agent", input: { description: "Look around", prompt: "List the files", subagent_type: "Explore" } }] },
  { match: "WORKFLOW", tools: [{ name: "Workflow", input: { script: SCRIPT } }] },
]));

beforeAll(async () => {
  d = await startDaemon({ env: { FAKE_PLAN_FILE: PLAN_FILE, FAKE_TRANSCRIPT: "1", FAKE_SIDE_JSON: "1", FAKE_UUIDS: "1" } });
  expect((await d.api("POST", "/api/profiles", { name: "Talk", path: d.project })).status).toBe(201);
  writeRemoteJson(d.home, true);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(planDir, { recursive: true, force: true });
}, 30_000);

const tp = (id: string, rest = "") => `/api/profiles/${SLUG}/tickets/${id}${rest}`;
const RUN = (id: string) => ({ "x-ckanban-run": `${SLUG}/${id}` });
const sentAt = new Map<string, number>();
const chat = (id: string, text: string) => {
  sentAt.set(id, Date.now());
  return d.api("POST", tp(id, "/chat"), { text });
};
const idle = (id: string) => until(async () => {
  const t = (await d.api("GET", tp(id))).data;
  return !t.running && t.runEndedAt && Date.parse(t.runEndedAt) >= (sentAt.get(id) ?? 0) && !(t.queued ?? []).length ? t : null;
}, 20_000, `ticket ${id}'s run to end`);
const conversation = async (id: string, q = "") => (await d.api("GET", tp(id, `/conversation${q}`))).data;
/** A ticket with two turns: the message, then the reply, each saved in the transcript. */
async function twoTurns(title: string, first = "LONG one", second = "second") {
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title, body: "" })).data;
  await chat(t.id, first);
  await idle(t.id);
  await chat(t.id, second);
  await idle(t.id);
  await until(async () => (await conversation(t.id)).entries.filter((e: any) => e.role === "user").length === 2, 10_000, "both messages");
  return t;
}

describe("the conversation", () => {
  let t: any;
  beforeAll(async () => {
    t = await twoTurns("Paged");
  }, 60_000);

  test("paging: limit takes the newest entries, before goes further back, start and total say where the page is", async () => {
    const all = await conversation(t.id);
    expect(all).toMatchObject({ start: 0, total: all.entries.length, title: null });
    // Each turn: the message, a thought, two tool calls and the reply.
    expect(all.entries.length).toBe(10);
    expect(all.entries[0]).toMatchObject({ role: "user", kind: "text", text: "LONG one", rewind: true });
    // An entry's uuid is its transcript line's uuid (its position in the conversation when the line has none).
    expect(new Set(all.entries.map((e: any) => e.uuid)).size).toBe(10);
    const tool = all.entries.find((e: any) => e.kind === "tool");
    expect(tool).toMatchObject({ role: "assistant", text: "Bash: ls src", toolUseId: "tu_ls" });
    const last = await conversation(t.id, "?limit=3");
    expect(last).toMatchObject({ start: 7, total: 10 });
    expect(last.entries).toEqual(all.entries.slice(7));
    const earlier = await conversation(t.id, "?limit=3&before=7");
    expect(earlier).toMatchObject({ start: 4, total: 10 });
    expect(earlier.entries).toEqual(all.entries.slice(4, 7));
    // limit is held to 1..500.
    expect((await conversation(t.id, "?limit=0")).entries.length).toBeGreaterThan(0);
  });

  test("tool details: input and output of a call; unknown ids answer 404", async () => {
    const r = await d.api("GET", tp(t.id, "/tool/tu_ls"));
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ id: "tu_ls", name: "Bash", input: { command: "ls src" }, output: "app.ts\nlib.ts", isError: false, truncated: false });
    expect((await d.api("GET", tp(t.id, "/tool/nope"))).status).toBe(404);
    expect((await d.api("GET", tp(t.id, "/agent/nope"))).status).toBe(404);
    expect((await d.api("GET", tp(t.id, "/workflow/nope/script"))).status).toBe(404);
    expect((await d.api("GET", tp(t.id, "/workflow/nope/agent/ag1"))).status).toBe(404);
  });

  test("usage: the ticket's runs and side spend", async () => {
    const r = await d.api("GET", tp(t.id, "/usage"));
    expect(r.status).toBe(200);
    expect(r.data.runs.length).toBe(2);
    expect(r.data.runs[0]).toMatchObject({ kind: "planning", costUsd: 0.01 });
    expect(r.data.totals).toMatchObject({ costUsd: expect.any(Number) });
    expect("sideCostUsd" in r.data && "teammates" in r.data && "window" in r.data).toBe(true);
  });

  test("context: GET answers the cached state; POST is user only", async () => {
    const g = await d.api("GET", tp(t.id, "/context"));
    expect(g.status).toBe(200);
    expect(typeof g.data.state).toBe("string");
    expect((await d.api("POST", tp(t.id, "/context"), {})).status).toBe(403);
    expect((await d.api("POST", tp(t.id, "/context"), {}, RUN(t.id))).status).toBe(403);
    const p = await phone(d, "POST", tp(t.id, "/context"), {});
    expect([200, 409]).toContain(p.status);
  });

  test("simplify: a side call rewrites a long reply in plain words, saved and then answered from the cache", async () => {
    const all = await conversation(t.id);
    const reply = all.entries.find((e: any) => e.role === "assistant" && e.text.includes("lot of words"));
    expect((await d.api("POST", tp(t.id, "/simplify"), { uuid: reply.uuid }, RUN(t.id))).status).toBe(403);
    const s = await d.api("POST", tp(t.id, "/simplify"), { uuid: reply.uuid });
    expect(s.status).toBe(200);
    expect(s.data).toEqual({ text: "In plain words: it is done.", cached: false });
    expect((await d.api("POST", tp(t.id, "/simplify"), { uuid: reply.uuid })).data).toEqual({ text: "In plain words: it is done.", cached: true });
    expect((await d.api("GET", tp(t.id, "/simplified"))).data).toEqual({ [reply.uuid]: "In plain words: it is done." });
    expect((await d.api("POST", tp(t.id, "/simplify"), { uuid: "999" })).status).toBe(404);
  });

  test("help me understand: a recap card from a side call; unknown kinds are refused", async () => {
    expect((await d.api("GET", tp(t.id, "/help"))).data).toMatchObject({ cards: [], busy: [] });
    expect((await d.api("POST", tp(t.id, "/help"), { kind: "recap" }, RUN(t.id))).status).toBe(403);
    expect((await d.api("POST", tp(t.id, "/help"), { kind: "poem" })).status).toBe(400);
    const r = await d.api("POST", tp(t.id, "/help"), { kind: "recap" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ kind: "recap", text: "In plain words: it is done.", costUsd: 0.002, id: expect.any(String), at: expect.any(String) });
    const after = (await d.api("GET", tp(t.id, "/help"))).data;
    expect(after.cards).toEqual([expect.objectContaining({ kind: "recap", text: "In plain words: it is done." })]);
  });
});

test("an Agent call shows as an agent row; a Workflow call as a workflow row with its script", async () => {
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Helpers", body: "" })).data;
  await chat(t.id, "SUBAGENT then");
  await idle(t.id);
  const agent = await until(async () => (await conversation(t.id)).entries.find((e: any) => e.kind === "agent"), 10_000, "the agent row");
  expect(agent).toMatchObject({ role: "assistant" });
  expect(agent.agent).toMatchObject({ toolUseId: "tu_plan_1", description: "Look around", status: "running", steps: [] });
  const detail = await d.api("GET", tp(t.id, "/agent/tu_plan_1"));
  expect(detail.status).toBe(200);

  await chat(t.id, "WORKFLOW now");
  await idle(t.id);
  const wf = await until(async () => (await conversation(t.id)).entries.find((e: any) => e.kind === "workflow"), 10_000, "the workflow row");
  expect(wf.workflow.toolUseId).toMatch(/^tu_plan_/);
  // The chat's row never carries the script; it loads on its own.
  expect(wf.workflow.script).toBeUndefined();
  const id = wf.workflow.toolUseId;
  const script = await d.api("GET", tp(t.id, `/workflow/${id}/script`));
  expect(script.status).toBe(200);
  expect(script.data).toEqual({ script: SCRIPT });
  // Stop is refused to a run, and to a workflow that isn't running.
  expect((await d.api("POST", tp(t.id, `/workflow/${id}/stop`), {}, RUN(t.id))).status).toBe(403);
  expect((await d.api("POST", tp(t.id, `/workflow/${id}/stop`), {})).status).toBe(400);
}, 45_000);

describe("rewind and fork", () => {
  test("rewind: preview, cut the chat back to a message, then undo; a plain folder has no files to restore", async () => {
    const t = await twoTurns("Rewound");
    const all = await conversation(t.id);
    const second = all.entries.find((e: any) => e.role === "user" && e.text === "second");
    // Refused to a run, even the GETs (a quirk); unknown uuids answer 404.
    expect((await d.api("GET", tp(t.id, `/rewind?uuid=${second.uuid}`), undefined, RUN(t.id))).status).toBe(403);
    expect((await d.api("GET", tp(t.id, "/rewind-undo"), undefined, RUN(t.id))).status).toBe(403);
    expect((await d.api("GET", tp(t.id, "/rewind?uuid=nope"))).status).toBe(404);
    const preview = await d.api("GET", tp(t.id, `/rewind?uuid=${second.uuid}`));
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ blocked: null, files: null, filesReason: "no-history" });
    expect((await d.api("GET", tp(t.id, "/rewind-undo"))).data).toEqual({ available: false, blocked: "There is no rewind to undo.", messages: 0, files: 0, filesSaved: false });

    const r = await d.api("POST", tp(t.id, "/rewind"), { uuid: second.uuid });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ text: "second", undo: true, messages: expect.any(Number) });
    const cut = await until(async () => {
      const c = await conversation(t.id);
      return c.entries.some((e: any) => e.text === "second") ? null : c;
    }, 10_000, "the chat to be cut back");
    expect(cut.entries.length).toBe(5);
    const undoable = (await d.api("GET", tp(t.id, "/rewind-undo"))).data;
    expect(undoable).toMatchObject({ available: true, blocked: null });

    // Undo is user only.
    expect((await d.api("POST", tp(t.id, "/rewind-undo"), {})).status).toBe(403);
    const u = await phone(d, "POST", tp(t.id, "/rewind-undo"), {});
    expect(u.status).toBe(200);
    await until(async () => (await conversation(t.id)).entries.some((e: any) => e.text === "second"), 10_000, "the chat to come back");
  }, 60_000);

  test("fork: a new ticket with the conversation up to a message; user only", async () => {
    const t = await twoTurns("Forked");
    const second = (await conversation(t.id)).entries.find((e: any) => e.role === "user" && e.text === "second");
    expect((await d.api("POST", tp(t.id, "/fork"), { uuid: second.uuid })).status).toBe(403);
    expect((await phone(d, "POST", tp(t.id, "/fork"), { uuid: "nope" })).status).toBe(404);
    const f = await phone(d, "POST", tp(t.id, "/fork"), { uuid: second.uuid });
    expect(f.status).toBe(201);
    expect(f.data).toMatchObject({ text: "second", id: expect.any(String) });
    expect(f.data.ticket.id).not.toBe(t.id);
    expect(f.data.ticket.sessionId).not.toBe(t.sessionId);
    const forked = await until(async () => {
      const c = await conversation(f.data.ticket.id);
      return c.entries.length ? c : null;
    }, 10_000, "the fork's conversation");
    expect(forked.entries.some((e: any) => e.text === "LONG one")).toBe(true);
    expect(forked.entries.some((e: any) => e.text === "second")).toBe(false);
    expect(existsSync(join(d.home, "profiles", SLUG, "tickets", f.data.ticket.id, "ticket.md"))).toBe(true);
    expect(readFileSync(join(d.home, "profiles", SLUG, "tickets", f.data.ticket.id, "ticket.md"), "utf8")).toContain(f.data.ticket.sessionId);
  }, 60_000);
});
