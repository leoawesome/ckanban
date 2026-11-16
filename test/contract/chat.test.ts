// Outside-in contract: a ticket's chat beyond one message. Questions forms (the ask_questions tool and the older
// <ckanban-questions> block) and their answers, Close question, proposals (propose_ticket) and Apply, follow-up work,
// mockup blocks saved to outputs, a message sent while a run works (it steers the run), the streamed reply (`draft`
// events), slash commands and the Planning chat. The fake Claude's FAKE_PLAN_FILE makes a turn call tools or add text
// when its message contains a marker. See contracts/api.md ("Ticket chat, runs and conversation", "Ticket cards").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "chat";
const planDir = mkdtempSync(join(tmpdir(), "ck-contract-plan-"));
const PLAN_FILE = join(planDir, "plan.json");
const ARGS = () => join(d.home, "..", "claude-args.jsonl");

const QUESTIONS = [
  { question: "Which colour?", context: "The header uses it.", options: [{ label: "Red", recommended: true }, { label: "Blue", description: "calmer", mockup: "b-blue.html" }], multiSelect: false },
  { question: "Which pages?", options: [{ label: "Board" }, { label: "Chat" }], multiSelect: true },
];
const MOCKUP = '<ckanban-mockup name="b-blue.html"><html><body style="background:blue">Blue</body></html></ckanban-mockup>';

writeFileSync(PLAN_FILE, JSON.stringify([
  { match: "ASK-TOOL", status: "questions", tools: [{ name: "mcp__ckanban__ask_questions", input: { questions: QUESTIONS, urgent: true, why: "The plan waits on it." } }] },
  { match: "ASK-BLOCK", status: "questions", text: `Two things first.\n<ckanban-questions>${JSON.stringify(QUESTIONS)}</ckanban-questions>` },
  { match: "BAD-BLOCK", text: "<ckanban-questions>[{not json</ckanban-questions>" },
  { match: "PROPOSE", tools: [{ name: "mcp__ckanban__propose_ticket", input: { title: "⭐ Blue header", description: "## Goal\nMake the header blue." } }] },
  { match: "MOCKUP", text: `Here is the idea.\n${MOCKUP}` },
]));

beforeAll(async () => {
  d = await startDaemon({
    // FAKE_STEP_MS: each run takes a few hundred ms (so a second message arrives while it works); FAKE_STREAM_DELAY:
    // its reply streams in two pieces with a pause (draft events).
    env: { FAKE_PLAN_FILE: PLAN_FILE, FAKE_STEP_MS: "150", FAKE_STREAM_DELAY: "300" },
    before: ({ project }) => {
      // A project command: offered in the / picker and sent to Claude as `/hello args`.
      mkdirSync(join(project, ".claude", "commands"), { recursive: true });
      writeFileSync(join(project, ".claude", "commands", "hello.md"), "---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS\n");
    },
  });
  expect((await d.api("POST", "/api/profiles", { name: "Chat", path: d.project })).status).toBe(201);
  // User-only actions go through the phone access listener (phone.ts), as the user's own browser.
  writeRemoteJson(d.home, true);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(planDir, { recursive: true, force: true });
}, 30_000);

const tp = (id: string, rest = "") => `/api/profiles/${SLUG}/tickets/${id}${rest}`;
const ticketDir = (id: string) => join(d.home, "profiles", SLUG, "tickets", id);
const newTicket = async (title: string, extra: Record<string, unknown> = {}) => (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title, body: "", ...extra })).data;
/** When each ticket was last sent a chat message (idle() waits for a run that ended after it). */
const sentAt = new Map<string, number>();
const chat = (id: string, text: string, headers?: Record<string, string>) => {
  sentAt.set(id, Date.now());
  return d.api("POST", tp(id, "/chat"), { text }, headers);
};
const idle = (id: string) => until(async () => {
  const t = (await d.api("GET", tp(id))).data;
  return !t.running && t.runEndedAt && Date.parse(t.runEndedAt) >= (sentAt.get(id) ?? 0) && !(t.queued ?? []).length ? t : null;
}, 20_000, `ticket ${id}'s run to end`);
const conversation = async (id: string) => (await d.api("GET", tp(id, "/conversation"))).data;
/** Waits until the conversation has an entry matching `pick`. */
const entry = (id: string, pick: (e: any) => boolean, what: string) => until(async () => (await conversation(id)).entries.find(pick), 20_000, what);
const ticketFile = (id: string) => parseTicketFile(readFileSync(join(ticketDir(id), "ticket.md"), "utf8"));
/** The fake Claude's starts for one ticket's session. */
const runsOf = async (id: string) => {
  const sid = (await d.api("GET", tp(id))).data.sessionId;
  return runsStarted().filter((r) => r.args.includes(sid));
};
const runsStarted = () => (existsSync(ARGS()) ? readFileSync(ARGS(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The event stream: collects every `data:` message until stopped. */
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

describe("questions forms", () => {
  test("ask_questions shows as a form with its urgency; the answer is a chat message that starts a new run", async () => {
    const t = await newTicket("Pick a colour");
    expect((await chat(t.id, "Plan it ASK-TOOL")).status).toBe(202);
    const form = await entry(t.id, (e) => e.questions, "the questions form");
    expect(form).toMatchObject({ role: "assistant", kind: "text", ask: { urgent: true, why: "The plan waits on it." } });
    expect(form.uuid).toContain("tu_plan_");
    expect(form.questions).toEqual([
      { question: "Which colour?", context: "The header uses it.", multiSelect: false, options: [{ label: "Red", recommended: true }, { label: "Blue", description: "calmer", recommended: false, mockup: "b-blue.html" }] },
      { question: "Which pages?", multiSelect: true, options: [{ label: "Board", recommended: false }, { label: "Chat", recommended: false }] },
    ]);
    // The ticket now waits on the user: its card says so and its session summary holds the open form.
    const asked = await idle(t.id);
    expect(asked.attention).toMatchObject({ kind: "questions", label: "Answer 2 questions" });
    expect(asked.session).toMatchObject({ openQuestions: 2, openFormId: form.uuid });
    expect(asked.session.openForm).toEqual(form.questions);

    // The web form sends its answers as one message starting "My answers:"; the same answer twice is sent once.
    const answer = "My answers:\n- Which colour? → Red\n- Which pages? → Board, Chat";
    expect((await chat(t.id, answer)).status).toBe(202);
    expect((await chat(t.id, answer)).status).toBe(202);
    const answered = await idle(t.id);
    await Bun.sleep(300);
    const runs = await runsOf(t.id);
    expect(runs.length).toBe(2);
    expect(runs[1].args).toContain("--resume");
    expect(runs[1].prompt).toContain(answer);
    expect(answered.attention?.kind).not.toBe("questions");
    await entry(t.id, (e) => e.role === "user" && e.text === answer, "the answer in the conversation");
  }, 45_000);

  test("Close question marks the form closed on the ticket; unknown or repeated closes are refused", async () => {
    const t = await newTicket("Close me");
    await chat(t.id, "ASK-TOOL please");
    const form = await entry(t.id, (e) => e.questions, "the questions form");
    await idle(t.id);
    // User only: a run's header is refused.
    expect((await d.api("PUT", tp(t.id, `/closed-forms/${form.uuid}`), {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    // A program without the board's Origin is refused too; the user's browser (here: the owner's phone) closes it.
    expect((await d.api("PUT", tp(t.id, `/closed-forms/${form.uuid}`), {})).status).toBe(403);
    const closed = await phone(d, "PUT", tp(t.id, `/closed-forms/${form.uuid}`), {});
    expect(closed.status).toBe(200);
    expect(closed.data.closedForms[form.uuid]).toEqual({ at: expect.any(String), by: "user", run: expect.any(String) });
    expect(ticketFile(t.id).meta.closedForms).toHaveProperty(form.uuid);
    expect(closed.data.attention?.kind).not.toBe("questions");
    // Closing it again changes nothing and answers 200.
    expect((await phone(d, "PUT", tp(t.id, `/closed-forms/${form.uuid}`), {})).status).toBe(200);
    // An id that is no form of this chat answers 409 (the 404 in api.md is only for a ticket without a chat).
    expect((await phone(d, "PUT", tp(t.id, "/closed-forms/no-such-form"), {})).status).toBe(409);
  }, 30_000);

  test("the older <ckanban-questions> block becomes a form and leaves the text; a broken block stays visible", async () => {
    const t = await newTicket("Block form");
    await chat(t.id, "ASK-BLOCK now");
    const form = await entry(t.id, (e) => e.questions, "the block form");
    expect(form.questions.map((q: any) => q.question)).toEqual(["Which colour?", "Which pages?"]);
    expect(form.text).not.toContain("ckanban-questions");
    expect(form.text).toContain("Two things first.");
    await idle(t.id);

    const u = await newTicket("Broken block");
    await chat(u.id, "BAD-BLOCK");
    const bad = await entry(u.id, (e) => e.unreadable, "the unreadable block");
    expect(bad.unreadable).toBe("questions");
    expect(bad.text).toContain("<ckanban-questions>");
    expect(bad.questions).toBeUndefined();
    await idle(u.id);
  }, 45_000);
});

describe("proposals", () => {
  test("propose_ticket shows a proposal; Apply is a PATCH of the ticket's title, body and star", async () => {
    const t = await newTicket("Header colour");
    await chat(t.id, "PROPOSE something");
    const p = await entry(t.id, (e) => e.proposal, "the proposal");
    // A ⭐ before the title is the important flag, left out of the title.
    expect(p.proposal).toEqual({ title: "Blue header", description: "## Goal\nMake the header blue.", important: true });
    await idle(t.id);

    // Apply (the web card): one PATCH; "Apply & start work" adds status ready.
    const applied = await d.api("PATCH", tp(t.id), { title: p.proposal.title, body: p.proposal.description, important: true });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ title: "Blue header", body: "## Goal\nMake the header blue.", important: true });
    const file = ticketFile(t.id);
    expect(file.meta).toMatchObject({ title: "Blue header", important: true });
    expect(file.body.trim()).toBe("## Goal\nMake the header blue.");
  }, 30_000);

  test("follow-up work from a proposal card on a ticket that ran: a new ticket; a run can't start it", async () => {
    // The user's own new ticket is always a main ticket (main: false changes nothing), and a main ticket's card adds
    // steps itself (400 below); a task of a feature (partOf) gets follow-up work as a new step of that feature.
    const feature = await newTicket("The feature");
    const t = await newTicket("Already ran", { main: false, partOf: feature.id });
    expect(t.main).toBeFalsy();
    await chat(t.id, "PROPOSE more");
    await idle(t.id);
    const refused = await d.api("POST", tp(t.id, "/follow-up-work"), { title: "Next bit", body: "More." }, { "x-ckanban-run": `${SLUG}/${t.id}` });
    expect(refused.status).toBe(403);
    const made = await d.api("POST", tp(t.id, "/follow-up-work"), { title: "Next bit", body: "More.", start: false });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ title: "Next bit", body: "More." });
    expect(made.data.mainTicket ?? made.data.partOf).toBeTruthy();
    expect(made.data.id).not.toBe(t.id);
    expect(existsSync(join(ticketDir(made.data.id), "ticket.md"))).toBe(true);
    expect((await d.api("POST", tp(t.id, "/follow-up-work"), { body: "no title" })).status).toBe(400);
    expect((await newTicket("Asked not to be main", { main: false })).main).toBe(true);
    const onMain = await d.api("POST", tp(feature.id, "/follow-up-work"), { title: "Next bit", body: "More." });
    expect(onMain.status).toBe(400);
    expect(onMain.data.error).toBe("A main ticket's card updates its own plan: it adds new work as steps itself.");
  }, 30_000);
});

test("a mockup block in a Planning reply is saved to outputs/mockups and listed on the entry", async () => {
  const t = await newTicket("Mockups");
  await chat(t.id, "MOCKUP please");
  const e = await entry(t.id, (x) => x.mockups, "the mockup entry");
  expect(e.mockups).toEqual(["b-blue.html"]);
  expect(e.text).toContain("Here is the idea.");
  expect(e.text).not.toContain("<ckanban-mockup");
  const done = await idle(t.id);
  const file = join(done.outputDir, "mockups", "b-blue.html");
  await until(() => existsSync(file), 10_000, "the mockup file");
  expect(readFileSync(file, "utf8")).toBe('<html><body style="background:blue">Blue</body></html>\n');
  const outputs = await d.api("GET", tp(t.id, "/outputs"));
  expect(outputs.status).toBe(200);
  expect(JSON.stringify(outputs.data)).toContain("b-blue.html");
  const served = await d.api("GET", tp(t.id, "/outputs/mockups/b-blue.html"));
  expect(served.status).toBe(200);
  expect(served.text).toContain("background:blue");
}, 30_000);

describe("chat while a run works", () => {
  test("a second message is queued on the ticket and steers the run; Claude reads it at its next step", async () => {
    const t = await newTicket("Steer me");
    await chat(t.id, "start working");
    await until(async () => (await d.api("GET", tp(t.id))).data.running, 10_000, "the run to start");
    const sent = await chat(t.id, "also check the footer");
    expect(sent.status).toBe(202);
    // Saved on the ticket until Claude reads it (ticket.md `queued`).
    expect(sent.data.queued).toEqual(expect.arrayContaining([expect.objectContaining({ text: "also check the footer", state: "queued", id: expect.any(String), at: expect.any(String) })]));
    await idle(t.id);
    expect((await runsOf(t.id)).length).toBe(1);
    const lines = readJsonl(join(ticketDir(t.id), "activity.jsonl"));
    expect(lines.some((l: any) => JSON.stringify(l.event).includes("Steered:") && JSON.stringify(l.event).includes("also check the footer"))).toBe(true);
  }, 30_000);

  test("queued messages: unknown ids answer 404; Stop from a run of another ticket is refused", async () => {
    const t = await newTicket("Queue edits");
    expect((await d.api("PATCH", tp(t.id, "/queued/nope"), { text: "x" })).status).toBe(404);
    expect((await d.api("DELETE", tp(t.id, "/queued/nope"))).status).toBe(404);
    expect((await d.api("POST", tp(t.id, "/queued/nope"), {})).status).toBe(404);
    const stop = await d.api("POST", tp(t.id, "/stop"), {});
    expect(stop.status).toBe(200);
    expect(stop.data).toMatchObject({ stopped: false });
  });
});

test("drafts: the reply streams as `draft` events, then a final one; `ticket.updated` and `activity` events come too", async () => {
  const s = await listen();
  try {
    const t = await newTicket("Streamed reply");
    await chat(t.id, "stream it");
    await idle(t.id);
    await until(() => s.events.some((e) => e.type === "draft" && e.id === t.id && e.final), 10_000, "the final draft event");
    const drafts = s.events.filter((e) => e.type === "draft" && e.id === t.id);
    expect(drafts.every((e) => e.profile === SLUG && typeof e.text === "string")).toBe(true);
    expect(drafts.some((e) => e.text.startsWith("Work "))).toBe(true);
    expect(drafts.at(-1)).toMatchObject({ text: "" });
    expect(drafts.at(-1).final).toContain("Work complete.");
    expect(s.events.some((e) => e.type === "ticket.updated" && e.ticket?.id === t.id && e.ticket.running)).toBe(true);
    expect(s.events.some((e) => e.type === "activity" && e.profile === SLUG && e.id === t.id)).toBe(true);
  } finally {
    s.stop();
  }
}, 30_000);

describe("slash commands", () => {
  test("GET /commands lists the built-ins and the project's own commands", async () => {
    const t = await newTicket("Commands");
    const r = await d.api("GET", tp(t.id, "/commands"));
    expect(r.status).toBe(200);
    const by = new Map(r.data.map((c: any) => [c.name, c]));
    expect(by.get("compact")).toMatchObject({ kind: "builtin", source: "claude" });
    expect(by.get("context")).toMatchObject({ kind: "builtin", source: "claude" });
    expect(by.get("model")).toMatchObject({ kind: "builtin", source: "board" });
    expect(by.get("effort")).toMatchObject({ kind: "builtin", source: "board" });
    expect(by.get("hello")).toMatchObject({ kind: "command", source: "project", description: "Say hello" });
  });

  test("/model and /effort are the board's own: they set the ticket and leave a notice, no run starts", async () => {
    const t = await newTicket("Model switch");
    const m = await chat(t.id, "/model sonnet");
    expect(m.status).toBe(202);
    expect(m.data).toMatchObject({ model: "sonnet", running: false });
    expect(m.data.notice).toContain("Model set to sonnet");
    expect(ticketFile(t.id).meta.model).toBe("sonnet");
    const e = await chat(t.id, "/effort high");
    expect(e.data).toMatchObject({ effort: "high" });
    // A refused command answers 500 with the reason (a quirk: the board's plain error isn't mapped to 400).
    const bad = await chat(t.id, "/model nonsense");
    expect(bad.status).toBe(500);
    expect(bad.data.error).toStartWith('"nonsense" is not a model name.');
    expect((await chat(t.id, "/effort huge")).status).toBe(500);
    // Commands that would switch Claude Code's session are refused.
    const clear = await chat(t.id, "/clear");
    expect(clear.status).toBe(500);
    expect(clear.data.error).toContain("/clear isn't available here");
    await Bun.sleep(200);
    expect(await runsOf(t.id)).toEqual([]);
    // The next run gets the model.
    await chat(t.id, "go on");
    await idle(t.id);
    const args = (await runsOf(t.id)).at(-1).args as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  }, 30_000);

  test("a project command is sent to Claude as `/name args` and shows as a command in the conversation", async () => {
    const t = await newTicket("Hello command");
    expect((await chat(t.id, "/hello world")).status).toBe(202);
    await idle(t.id);
    expect((await runsOf(t.id)).at(-1).prompt).toBe("/hello world");
  }, 30_000);
});

test("the Planning chat: a Backlog ticket moves to Planning and its run can't edit files or start huddles", async () => {
  const t = await newTicket("Plan only");
  const sent = await chat(t.id, "let's plan");
  expect(sent.data.status).toBe("planning");
  await idle(t.id);
  const args = (await runsOf(t.id)).at(-1).args as string[];
  const disallowed = args[args.indexOf("--disallowedTools") + 1].split(",");
  expect(disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "mcp__ckanban__start_huddle"]));
  expect(ticketFile(t.id).meta.status).toBe("planning");
  // The terminal command for the same Planning conversation.
  const cmd = await d.api("POST", tp(t.id, "/planning-command"), {});
  expect(cmd.status).toBe(200);
  expect(cmd.data.command).toContain(t.sessionId ?? (await d.api("GET", tp(t.id))).data.sessionId);
}, 30_000);
