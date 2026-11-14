import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES_NOTE, IMAGES_NOTE } from "../src/server/attachments";
import { Bus, type BusEvent } from "../src/server/events";
import { SessionCache, SessionParser, findSessionFile, startSessionWatcher, summaryTag, fromTicket, fromTicketText, parseNewTickets, parseProposal, parseSession, pollSessionsSliced, scanSessionFiles, scanSessionFilesAsync } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

const L = (o: unknown) => JSON.stringify(o);
const user = (text: any, at: string, extra: object = {}) =>
  L({ type: "user", uuid: `u${at}`, timestamp: at, message: { role: "user", content: text }, ...extra });
const asst = (content: any[], at: string, extra: object = {}) =>
  L({ type: "assistant", uuid: `a${at}`, timestamp: at, message: { role: "assistant", content }, ...extra });

const RAW = [
  L({ type: "custom-title", customTitle: "flight proposal." }),
  user("<command-name>/clear</command-name>", "2026-09-29T01:00:00Z"),
  user("Draft the flight proposal", "2026-09-29T01:00:01Z"),
  asst([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it." }], "2026-09-29T01:00:02Z"),
  asst([{ type: "tool_use", id: "t1", name: "Artifact", input: { action: "publish", file_path: "/x/flight-autopilot.html" } }], "2026-09-29T01:00:03Z"),
  user([{ type: "tool_result", tool_use_id: "t1", content: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 1)" }], "2026-09-29T01:00:04Z"),
  user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 2)" }] }], "2026-09-29T01:00:05Z"),
  asst([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ls -la" } }], "2026-09-29T01:00:06Z"),
  asst([{ type: "text", text: "sidechain noise" }], "2026-09-29T01:00:07Z", { isSidechain: true }),
  user("looks good, ship it", "2026-09-29T01:00:08Z"),
  "garbage line",
].join("\n");

test("parseSession: timeline, artifacts deduped, last message", () => {
  const s = parseSession(RAW);
  expect(s.title).toBe("flight proposal.");
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "text", "Draft the flight proposal"],
    ["assistant", "text", "On it."],
    ["assistant", "tool", "Artifact: /x/flight-autopilot.html"],
    ["assistant", "tool", "Bash: ls -la"],
    ["user", "text", "looks good, ship it"],
  ]);
  expect(s.artifacts).toEqual([
    { url: "https://claude.ai/artifact/EHESGk3", label: "flight-autopilot", at: "2026-09-29T01:00:04Z" },
  ]);
  expect(s.lastMessage).toEqual({ role: "user", text: "looks good, ship it", at: "2026-09-29T01:00:08Z" });
});

test("parseSession lists pages published by the artifact helper, not other Bash output", () => {
  const out = "Published /o/claude-surfaces.html at https://claude.ai/artifact/NJd6w5oY7";
  const raw = [
    asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "'/bun' '/src/cli.ts' artifact publish /o/claude-surfaces.html --url x" } }], "2026-09-29T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "b1", content: out }], "2026-09-29T01:00:02Z"),
    asst([{ type: "tool_use", id: "b2", name: "Bash", input: { command: "grep -r Published ~/.claude/projects" } }], "2026-09-29T01:00:03Z"),
    user([{ type: "tool_result", tool_use_id: "b2", content: "Published /y/other.html at https://claude.ai/artifact/Other1" }], "2026-09-29T01:00:04Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts).toEqual([
    { url: "https://claude.ai/artifact/NJd6w5oY7", label: "claude-surfaces", at: "2026-09-29T01:00:02Z" },
  ]);
});

test("parseSession falls back to ai-title and handles empty", () => {
  expect(parseSession(L({ type: "ai-title", aiTitle: "Auto name" })).title).toBe("Auto name");
  const empty = parseSession("");
  expect(empty.entries).toEqual([]);
  expect(empty.lastMessage).toBeNull();
});

test("findSessionFile + cache reparses only on change", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-some-folder");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(file, user("hi", "2026-09-29T01:00:00Z") + "\n");
  expect(findSessionFile("11111111-2222-3333-4444-555555555555", { configDir })).toBe(file);
  expect(findSessionFile("nope", { configDir })).toBeNull();
  const cache = new SessionCache({ configDir });
  const a = cache.get("11111111-2222-3333-4444-555555555555")!;
  expect(cache.get("11111111-2222-3333-4444-555555555555")).toBe(a);
  appendFileSync(file, asst([{ type: "text", text: "hello" }], "2026-09-29T01:00:01Z") + "\n");
  expect(cache.get("11111111-2222-3333-4444-555555555555")!.lastMessage!.text).toBe("hello");
});

test("cache keeps only recent and running parses; an evicted session is parsed again in full on its next get", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-some-folder");
  mkdirSync(dir, { recursive: true });
  const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `${id(i)}.jsonl`), user(`hi ${i}`, "2026-09-29T01:00:00Z") + "\n");
  appendFileSync(join(dir, `${id(0)}.jsonl`), asst([{ type: "text", text: "hello 0" }], "2026-09-29T01:00:01Z") + "\n");
  // Sessions written to in the last minutes count as running and are never dropped.
  const live = new SessionCache({ configDir });
  const kept = live.get(id(0))!;
  for (let i = 1; i < 40; i++) live.get(id(i));
  expect(live.get(id(0))).toBe(kept);
  // An hour later they're idle: past the 30 most recently used, the oldest parse is dropped.
  const cache = new SessionCache({ configDir }, () => Date.now() + 3_600_000);
  const first = cache.get(id(0))!;
  expect(first.entries.length).toBe(2);
  for (let i = 1; i < 40; i++) cache.get(id(i));
  expect(cache.get(id(39))).toBe(cache.get(id(39)));
  const again = cache.get(id(0))!;
  expect(again).not.toBe(first);
  expect(again).toEqual(first);
  expect(again.lastMessage!.text).toBe("hello 0");
  // Still parsed incrementally after the re-parse.
  appendFileSync(join(dir, `${id(0)}.jsonl`), asst([{ type: "text", text: "more" }], "2026-09-29T01:00:02Z") + "\n");
  expect(cache.get(id(0))!.entries.length).toBe(3);
});

test("pollSessionsSliced emits session.updated when a linked session file changes", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, user("first", "2026-09-29T01:00:00Z") + "\n");
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const cache = new SessionCache({ configDir });
  const state = new Map<string, string>();
  await pollSessionsSliced(store, bus, cache, state);
  expect(seen.length).toBe(1);
  await pollSessionsSliced(store, bus, cache, state);
  expect(seen.length).toBe(1);
  appendFileSync(file, asst([{ type: "text", text: "reply" }], "2026-09-29T01:00:01Z") + "\n");
  await pollSessionsSliced(store, bus, cache, state);
  expect(seen.length).toBe(2);
  const e = seen[1] as any;
  expect(e).toMatchObject({ type: "session.updated", profile: "p", id: t.id });
  expect(e.session.lastMessage.text).toBe("reply");
});

test("parseSession hides board instructions and extracts questions + proposals", () => {
  const raw = [
    user('<ckanban-context note="Board started work on the ticket">\nYou are an agent...\n</ckanban-context>', "2026-09-29T02:00:00Z"),
    user('I want to build a habit tracker\n\n<ckanban-context>\nrefine rules\n</ckanban-context>', "2026-09-29T02:00:01Z"),
    asst([{ type: "text", text: 'A few questions:\n<ckanban-questions>\n[{"question":"Who uses it?","options":[{"label":"Just me"},{"label":"Friends","description":"shared","recommended":true}],"multiSelect":false}]\n</ckanban-questions>' }], "2026-09-29T02:00:02Z"),
    user("My answers:\n- Who uses it? → Friends", "2026-09-29T02:00:03Z"),
    asst([{ type: "text", text: 'Here is the ticket:\n<ckanban-ticket>{"title":"Habit tracker MVP","description":"## Goal\\nTrack habits"}</ckanban-ticket>' }], "2026-09-29T02:00:04Z"),
    asst([{ type: "text", text: "<ckanban-questions>not json</ckanban-questions>" }], "2026-09-29T02:00:05Z"),
  ].join("\n");
  const s = parseSession(raw);
  expect(s.entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "board", "Board started work on the ticket"],
    ["user", "text", "I want to build a habit tracker"],
    ["assistant", "text", "A few questions:"],
    ["user", "text", "My answers:\n- Who uses it? → Friends"],
    ["assistant", "text", "Here is the ticket:"],
    ["assistant", "text", "<ckanban-questions>not json</ckanban-questions>"],
  ]);
  expect(s.entries[2].questions).toEqual([
    { question: "Who uses it?", multiSelect: false, options: [
      { label: "Just me", description: undefined, recommended: false },
      { label: "Friends", description: "shared", recommended: true },
    ] },
  ]);
  expect(s.entries[4].proposal).toEqual({ title: "Habit tracker MVP", description: "## Goal\nTrack habits" });
  expect(s.lastMessage!.text).toBe("<ckanban-questions>not json</ckanban-questions>");
});

test("parseSession shows messages sent mid-turn (queued_command attachments) as user messages", () => {
  const queued = (prompt: unknown, at: string, commandMode = "prompt") =>
    L({ type: "attachment", uuid: `q${at}`, timestamp: at, attachment: { type: "queued_command", prompt, commandMode } });
  const raw = [
    user("Build it", "2026-10-01T02:00:00Z"),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 5" } }], "2026-10-01T02:00:01Z"),
    queued([{ type: "text", text: "Is it cron?\n\n<ckanban-context note=\"\">\n(Sent while you were working.)\n</ckanban-context>" }], "2026-10-01T02:00:02Z"),
    queued("<task-notification>\n<task-id>x</task-id>\n</task-notification>", "2026-10-01T02:00:03Z", "task-notification"),
    asst([{ type: "text", text: "Done. Your question: it is the daemon's own timer." }], "2026-10-01T02:00:04Z"),
  ].join("\n");
  expect(parseSession(raw).entries.map((e) => [e.role, e.kind, e.text])).toEqual([
    ["user", "text", "Build it"],
    ["assistant", "tool", "Bash: sleep 5"],
    ["user", "text", "Is it cron?"],
    ["assistant", "text", "Done. Your question: it is the daemon's own timer."],
  ]);
});

test("parseSession: open questions and pending proposal reset after the user replies", () => {
  const q = '<ckanban-questions>[{"question":"A?","options":[{"label":"x"}]},{"question":"B?","options":[{"label":"y"}]}]</ckanban-questions>';
  const p = '<ckanban-ticket>{"title":"T2","description":"D2"}</ckanban-ticket>';
  const asked = parseSession([asst([{ type: "text", text: q }], "1")].join("\n"));
  expect(asked.openQuestions).toBe(2);
  const answered = parseSession([asst([{ type: "text", text: q }], "1"), user("answers", "2")].join("\n"));
  expect(answered.openQuestions).toBe(0);
  const proposed = parseSession([user("answers", "2"), asst([{ type: "text", text: p }], "3")].join("\n"));
  expect(proposed.pendingProposal).toEqual({ title: "T2", description: "D2" });
  const after = parseSession([asst([{ type: "text", text: p }], "3"), user("ok", "4")].join("\n"));
  expect(after.pendingProposal).toBeNull();
});

test("artifacts only come from the Artifact tool, not from text quoted in other tool output", () => {
  const raw = [
    asst([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "grep Published other.jsonl" } }], "2026-09-29T03:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "b1", content: "Published /x/flight-autopilot.html at https://claude.ai/artifact/EHESGk3 (Version 1)" }], "2026-09-29T03:00:01Z"),
    asst([{ type: "tool_use", id: "a1", name: "Artifact", input: { file_path: "/y/board.html" } }], "2026-09-29T03:00:02Z"),
    user([{ type: "tool_result", tool_use_id: "a1", content: "Published /y/board.html at https://claude.ai/artifact/Mine123 (Version 1)" }], "2026-09-29T03:00:03Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts.map((a) => a.label)).toEqual(["board"]);
});

test("move marker is hidden from text and exposed as moved", () => {
  const s = parseSession(asst([{ type: "text", text: 'Top 5:\n1. a\n<ckanban-move to="planning"/>' }], "2026-09-29T04:00:00Z"));
  expect(s.entries[0].text).toBe("Top 5:\n1. a");
  expect(s.entries[0].moved).toBe("planning");
});

test("move marker on a blocked reply shows no move: the board kept the card", () => {
  const tag = '<ckanban-move to="planning"/>';
  const result = (status: string) => `CKANBAN_RESULT: {"status":"${status}","prUrl":null,"summary":"x"}`;
  const blocked = parseSession(asst([{ type: "text", text: `Fixes A-H.\n${tag}\n${result("blocked")}` }], "2026-09-29T04:00:00Z"));
  expect(blocked.entries[0].moved).toBeUndefined();
  expect(blocked.entries[0].text).not.toContain("ckanban-move");
  const done = parseSession(asst([{ type: "text", text: `Fixes A-H.\n${tag}\n${result("done")}` }], "2026-09-29T04:00:00Z"));
  expect(done.entries[0].moved).toBe("planning");
  // The result line in a later block of the same reply still counts; the next user message ends the reply.
  const split = parseSession([
    asst([{ type: "text", text: `Fixes A-H.\n${tag}` }], "2026-09-29T04:00:00Z"),
    asst([{ type: "text", text: result("blocked") }], "2026-09-29T04:00:01Z"),
    user("Ideas?", "2026-09-29T04:01:00Z"),
    asst([{ type: "text", text: `Some ideas.\n${tag}` }], "2026-09-29T04:01:01Z"),
  ].join("\n"));
  expect(split.entries.map((e) => e.moved)).toEqual([undefined, undefined, undefined, "planning"]);
});

test("stay marker is hidden from text", () => {
  const s = parseSession(asst([{ type: "text", text: "Proposed 1 ticket.\n<ckanban-stay/>" }], "2026-09-29T04:00:00Z"));
  expect(s.entries[0].text).toBe("Proposed 1 ticket.");
});

test("parseSession: <ckanban-tickets> becomes newTickets, stripped from the text", () => {
  const block = '<ckanban-tickets>[{"title":"A","description":"## Goal\\nDo A"},{"title":"B"},{"description":"no title"}]</ckanban-tickets>';
  const s = parseSession(asst([{ type: "text", text: `Here is the split.\n\n${block}\n\nApply what you like.` }], "1"));
  const e = s.entries[0];
  expect(e.text).toBe("Here is the split.\n\n\n\nApply what you like.");
  expect(e.newTickets).toEqual([{ title: "A", description: "## Goal\nDo A" }, { title: "B", description: "" }]);
  expect(e.proposal).toBeUndefined();
  expect(s.pendingNewTickets).toHaveLength(2);
  expect(parseSession([asst([{ type: "text", text: block }], "1"), user("thanks", "2")].join("\n")).pendingNewTickets).toEqual([]);
  // Only the block: the board still has something to show as the last message.
  expect(parseSession(asst([{ type: "text", text: block }], "1")).lastMessage!.text).toBe("Proposed 2 new tickets");
});

test("parseSession: invalid <ckanban-tickets> JSON stays visible text", () => {
  const bad = "<ckanban-tickets>[{title: A}]</ckanban-tickets>";
  const e = parseSession(asst([{ type: "text", text: `x ${bad}` }], "1")).entries[0];
  expect(e.newTickets).toBeUndefined();
  expect(e.text).toContain(bad);
});

test("parseSession: ticket proposal and new tickets in one reply", () => {
  const text = '<ckanban-ticket>{"title":"Planner","description":"D"}</ckanban-ticket>\n<ckanban-tickets>[{"title":"Child","description":"C"}]</ckanban-tickets>';
  const e = parseSession(asst([{ type: "text", text }], "1")).entries[0];
  expect(e.proposal).toEqual({ title: "Planner", description: "D" });
  expect(e.newTickets).toEqual([{ title: "Child", description: "C" }]);
  expect(e.text).toBe("");
});

test("parseSession: proposed tickets keep key and dependsOn", () => {
  const block = '<ckanban-tickets>[{"key":"api","title":"API","description":"d"},{"key":"ui","title":"UI","dependsOn":["api", 3, ""]}]</ckanban-tickets>';
  expect(parseSession(asst([{ type: "text", text: block }], "1")).entries[0].newTickets).toEqual([
    { key: "api", title: "API", description: "d" },
    { key: "ui", title: "UI", description: "", dependsOn: ["api"] },
  ]);
});

test("parseSession: chat blocks survive wrong, missing or quoted closing tags", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const json = '{"title":"T","description":"D"}';
  for (const text of [
    `Here:\n<ckanban-ticket>${json}</ckanban-ticket>`,
    `Here:\n<ckanban-ticket>${json}</parameter>`,
    `Here:\n<ckanban-ticket>${json}`,
    "Here:\n<ckanban-ticket>\n```json\n" + json + "\n```\n</ckanban-ticket>",
  ]) {
    const e = entry(text);
    expect(e.proposal).toEqual({ title: "T", description: "D" });
    expect(e.text).toBe("Here:");
    expect(e.unreadable).toBeUndefined();
  }
  expect(entry(`<ckanban-ticket>${json}</ckanban-ticket>\n\nApply it, then move it to Ready.`).text).toBe("Apply it, then move it to Ready.");
  // A closing tag and braces quoted inside the description don't end the block early.
  const quoted = '{"title":"Parser","description":"Stop at </ckanban-ticket> {not here} or \\"]\\" either"}';
  const q = entry(`<ckanban-ticket>${quoted}</ckanban-ticket> after`);
  expect(q.proposal).toEqual({ title: "Parser", description: 'Stop at </ckanban-ticket> {not here} or "]" either' });
  expect(q.text).toBe("after");
  // ckanban-ticket never grabs a ckanban-tickets block.
  const t = entry('<ckanban-tickets>[{"title":"A"}]</parameter>');
  expect(t.newTickets).toEqual([{ title: "A", description: "" }]);
  expect(t.proposal).toBeUndefined();
});

test("parseSession: unreadable chat blocks stay visible and are flagged", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const bad = entry('<ckanban-ticket>{"title": "T", oops}</ckanban-ticket>');
  expect(bad.proposal).toBeUndefined();
  expect(bad.unreadable).toBe("proposal");
  expect(bad.text).toContain("oops");
  const cut = entry('<ckanban-questions>[{"question":"A?"');
  expect(cut.unreadable).toBe("questions");
  expect(entry("<ckanban-tickets>[{title: A}]</ckanban-tickets>").unreadable).toBe("tickets");
  expect(entry("plain reply").unreadable).toBeUndefined();
});

test("parseSession: prose mentioning the opening tag before the real block still parses", () => {
  const entry = (text: string) => parseSession(asst([{ type: "text", text }], "1")).entries[0];
  const e = entry('I will send a <ckanban-ticket> block now, and `<ckanban-ticket>{oops}` was a typo.\n<ckanban-ticket>{"title":"T","description":"D"}</ckanban-ticket>');
  expect(e.proposal).toEqual({ title: "T", description: "D" });
  expect(e.unreadable).toBeUndefined();
  expect(e.text).toContain("I will send a <ckanban-ticket> block now");
  expect(e.text).not.toContain('"title":"T"');
  // Only broken occurrences: still flagged.
  const bad = entry('See <ckanban-questions> below.\n<ckanban-questions>[{"question": oops}]</ckanban-questions>');
  expect(bad.questions).toBeUndefined();
  expect(bad.unreadable).toBe("questions");
});

test("parseSession: planning tool calls become forms and cards keyed by the tool_use id", () => {
  const questions = [{ question: "Color?", options: [{ label: "Red", recommended: true }, { label: "Blue", mockup: "a-blue.html" }], multiSelect: false }];
  const raw = [
    user("plan it", "2026-10-04T01:00:00Z"),
    asst([
      { type: "text", text: "A few questions:" },
      { type: "tool_use", id: "toolu_bad", name: "mcp__ckanban__ask_questions", input: { questions: [{ ...questions[0], options: [{ label: "Red", recommended: true }, { label: "Blue", recommended: true }] }] } },
    ], "2026-10-04T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: [{ type: "text", text: "question 1: mark exactly one option recommended (found 2)" }] }], "2026-10-04T01:00:02Z"),
    asst([{ type: "tool_use", id: "toolu_q", name: "mcp__ckanban__ask_questions", input: { questions } }], "2026-10-04T01:00:03Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_q", content: [{ type: "text", text: "Shown to the user as a form." }] }], "2026-10-04T01:00:04Z"),
  ].join("\n");
  const s = parseSession(raw);
  // The errored call doesn't render; no tool label line for the card calls.
  expect(s.entries.map((e) => [e.uuid, e.kind])).toEqual([["u2026-10-04T01:00:00Z", "text"], ["a2026-10-04T01:00:01Z", "text"], ["toolu_q", "text"]]);
  const q = s.entries[2];
  expect(q.role).toBe("assistant");
  expect(q.text).toBe("");
  expect(q.questions).toEqual([{ question: "Color?", multiSelect: false, options: [
    { label: "Red", description: undefined, recommended: true }, { label: "Blue", description: undefined, recommended: false, mockup: "a-blue.html" },
  ] }]);
  expect(s.openQuestions).toBe(1);
  expect(s.lastMessage?.text).toBe("Asked 1 question");

  const more = parseSession([
    raw,
    user("Red", "2026-10-04T01:00:05Z"),
    asst([
      { type: "tool_use", id: "toolu_p", name: "mcp__ckanban__propose_ticket", input: { title: " Fix chat ", description: "## Goal" } },
      { type: "tool_use", id: "toolu_t", name: "propose_tickets", input: { tickets: [{ key: "api", title: "API", description: "A" }, { key: "ui", title: "UI", description: "B", dependsOn: ["api"] }] } },
    ], "2026-10-04T01:00:06Z"),
  ].join("\n"));
  const p = more.entries.find((e) => e.uuid === "toolu_p")!;
  expect(p.proposal).toEqual({ title: "Fix chat", description: "## Goal" });
  const t = more.entries.find((e) => e.uuid === "toolu_t")!;
  expect(t.newTickets).toEqual([{ key: "api", title: "API", description: "A" }, { key: "ui", title: "UI", description: "B", dependsOn: ["api"] }]);
  expect(more.entries.some((e) => e.kind === "tool")).toBe(false);
  expect(more.pendingProposal).toEqual({ title: "Fix chat", description: "## Goal" });
  expect(more.pendingNewTickets).toHaveLength(2);
  expect(more.openQuestions).toBe(0);
});

test("parseSession: propose_branch shows a Branch card", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_b", name: "mcp__ckanban__propose_branch", input: { reason: " Try SQLite " } }], "2026-10-06T01:00:00Z"));
  expect(s.entries).toEqual([{ uuid: "toolu_b", at: "2026-10-06T01:00:00Z", role: "assistant", kind: "text", text: "", branch: { reason: "Try SQLite" } }]);
  expect(s.lastMessage?.text).toBe("Offered to branch this ticket");
  expect(parseSession(asst([{ type: "tool_use", id: "b2", name: "propose_branch", input: {} }], "1")).entries[0].branch).toEqual({ reason: "" });
});

test("parseSession: propose_delete shows a delete card; a refused call shows none", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_d", name: "mcp__ckanban__propose_delete", input: { ids: [" t_1 ", "t_2", "t_1", 3], reason: " replaced " } }], "2026-10-10T01:00:00Z"));
  expect(s.entries).toEqual([{ uuid: "toolu_d", at: "2026-10-10T01:00:00Z", role: "assistant", kind: "text", text: "", deletion: { ids: ["t_1", "t_2"], reason: "replaced" } }]);
  expect(s.lastMessage?.text).toBe("Asked to delete 2 tickets");
  const refused = parseSession([
    asst([{ type: "tool_use", id: "toolu_own", name: "mcp__ckanban__propose_delete", input: { ids: ["t_9"], reason: "x" } }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_own", is_error: true, content: [{ type: "text", text: "t_9 is this chat's own ticket" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(refused.entries.some((e) => e.deletion)).toBe(false);
  expect(parseSession(asst([{ type: "tool_use", id: "x", name: "propose_delete", input: { ids: [] } }], "1")).entries[0].kind).toBe("tool");
});

test("parseSession: delete_schedule shows a schedule delete card that waits until answered; a refused call shows none", () => {
  const s = parseSession([
    asst([{ type: "tool_use", id: "toolu_s", name: "mcp__ckanban__delete_schedule", input: { id: " s1 ", reason: " replaced " } }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_s", content: [{ type: "text", text: "Nothing is deleted yet" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(s.entries[0]).toEqual({ uuid: "toolu_s", at: "2026-10-10T01:00:00Z", role: "assistant", kind: "text", text: "", scheduleDeletion: { id: "s1", reason: "replaced" } });
  expect(s.lastMessage?.text).toBe("Asked to delete a schedule");
  expect(s.pendingScheduleDeletes).toEqual([{ uuid: "toolu_s", id: "s1" }]);
  const refused = parseSession([
    asst([{ type: "tool_use", id: "toolu_x", name: "mcp__ckanban__delete_schedule", input: { id: "nope" } }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: [{ type: "text", text: "no schedule nope" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(refused.entries.some((e) => e.scheduleDeletion)).toBe(false);
  expect(refused.pendingScheduleDeletes).toEqual([]);
});

test("parseSession: propose_teammate shows a teammate card; refused or broken calls show none; pending until the user's next message", () => {
  const input = { name: "WA Watcher", role: " WhatsApp responder ", prompt: " Draft replies. ", model: "", mode: "tagged", workspace: "shared", canEdit: false, why: " No teammate watches a web inbox. " };
  const s = parseSession(asst([{ type: "tool_use", id: "toolu_t", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"));
  expect(s.entries).toEqual([{
    uuid: "toolu_t", at: "2026-10-10T01:00:00Z", role: "assistant", kind: "text", text: "",
    teammate: { name: "wa-watcher", role: "WhatsApp responder", prompt: "Draft replies.", model: null, mode: "tagged", workspace: "shared", canEdit: false, why: "No teammate watches a web inbox." },
  }]);
  expect(s.lastMessage?.text).toBe("Proposed teammate @wa-watcher");
  expect(s.pendingTeammates).toEqual(["toolu_t"]);
  // Fields Claude left out stay out (an existing teammate keeps its values for them).
  expect(parseSession(asst([{ type: "tool_use", id: "t2", name: "propose_teammate", input: { name: "qa", prompt: "p", why: "w" } }], "1")).entries[0].teammate).toEqual({ name: "qa", prompt: "p", why: "w" });
  const refused = parseSession([
    asst([{ type: "tool_use", id: "toolu_bad", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"),
    user([{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: [{ type: "text", text: "nope" }] }], "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(refused.entries.some((e) => e.teammate)).toBe(false);
  for (const bad of [{ name: "x", prompt: "p" }, { name: "you", prompt: "p", why: "w" }, { name: "x", prompt: "p", why: "w", mode: "loud" }]) {
    expect(parseSession(asst([{ type: "tool_use", id: "x", name: "propose_teammate", input: bad }], "1")).entries[0].kind).toBe("tool");
  }
  const answered = parseSession([
    asst([{ type: "tool_use", id: "toolu_t", name: "mcp__ckanban__propose_teammate", input }], "2026-10-10T01:00:00Z"),
    user("thanks", "2026-10-10T01:00:01Z"),
  ].join("\n"));
  expect(answered.pendingTeammates).toEqual([]);
});

test("parseSession: an unreadable planning tool call falls back to a tool line", () => {
  const s = parseSession(asst([{ type: "tool_use", id: "x", name: "mcp__ckanban__propose_tickets", input: { tickets: "nope" } }], "1"));
  expect(s.entries[0].kind).toBe("tool");
});

test("parseSession lists pages published by the publish_artifact MCP tool", () => {
  const raw = [
    asst([{ type: "tool_use", id: "m1", name: "mcp__ckanban__publish_artifact", input: { html: "<p>x</p>" } }], "2026-10-06T01:00:01Z"),
    user([{ type: "tool_result", tool_use_id: "m1", content: [{ type: "text", text: "Published /o/artifacts/plan.html at https://claude.ai/artifact/Plan123" }] }], "2026-10-06T01:00:02Z"),
  ].join("\n");
  expect(parseSession(raw).artifacts).toEqual([{ url: "https://claude.ai/artifact/Plan123", label: "plan", at: "2026-10-06T01:00:02Z" }]);
});

test("parseSession: huddle digests are huddle entries, not the user's; Claude's reply to them doesn't need the user", () => {
  const digest = "[#1] (system) Huddle started\n\n[#2] @qa-1: @main look";
  const raw = [
    user("hi", "2026-10-10T01:00:00Z"),
    asst([{ type: "text", text: "Hello" }], "2026-10-10T01:00:01Z"),
    user(`${digest}\n\n<ckanban-context note="Huddle messages" huddle="h_abc">\nrules\n</ckanban-context>`, "2026-10-10T01:00:02Z"),
  ].join("\n");
  const s = parseSession(raw);
  const e = s.entries.at(-1)!;
  expect(e).toMatchObject({ role: "user", kind: "text", text: digest, huddleId: "h_abc", peer: { dir: "in", ticketId: null } });
  expect(s.lastMessage).toMatchObject({ role: "user", from: "huddle" });
  const replied = parseSession(`${raw}\n${asst([{ type: "text", text: "Posted in the huddle." }], "2026-10-10T01:00:03Z")}`);
  expect(replied.lastMessage).toMatchObject({ role: "assistant", peerReply: true });
  expect(parseSession(RAW).lastMessage?.from).toBeUndefined();
});

test("parseSession: a message another ticket sent (chat_ticket) is tagged with that ticket, not shown as the user's", () => {
  const sent = fromTicketText("t_20261020_y0i0", "Post #006", "Job for #006 is queued.\n\nOver to you.");
  const raw = [
    asst([{ type: "tool_use", id: "q1", name: "mcp__ckanban__ask_questions", input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } }], "2026-10-25T01:00:00Z"),
    user(`${sent}\n\n<ckanban-context note="">\nrules\n</ckanban-context>`, "2026-10-25T01:00:01Z"),
    // Steered while Claude worked: saved as a queued_command attachment.
    L({ type: "attachment", uuid: "att1", timestamp: "2026-10-25T01:00:02Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: `${fromTicketText("t_1", "Plan", "and one more")}\n\n<ckanban-context note="">x</ckanban-context>` } }),
  ].join("\n");
  const s = parseSession(raw);
  expect(s.entries.at(-2)).toMatchObject({ role: "user", kind: "text", text: "Job for #006 is queued.\n\nOver to you.", peer: { dir: "in", ticketId: "t_20261020_y0i0", title: "Post #006" } });
  expect(s.entries.at(-2)!.huddleId).toBeUndefined();
  expect(s.entries.at(-1)).toMatchObject({ text: "and one more", peer: { dir: "in", ticketId: "t_1", title: "Plan" } });
  // Still answers Claude's questions (a planner answers its child's questions this way) and isn't a huddle message.
  expect(s.openQuestions).toBe(0);
  expect(s.lastMessage?.from).toBeUndefined();
  // The user's own message, even one that mentions a ticket, stays theirs.
  expect(parseSession(user("Message from ticket t_1 about X", "2026-10-25T01:00:03Z")).entries[0].peer).toBeUndefined();
  expect(fromTicket(sent)).toEqual({ ticketId: "t_20261020_y0i0", title: "Post #006", text: "Job for #006 is queued.\n\nOver to you." });
});

test("parseSession: a propose_huddle card with a template and no roster", () => {
  const raw = [
    asst([{ type: "tool_use", id: "h1", name: "mcp__ckanban__propose_huddle", input: { template: "design-review", reason: "Review the feature" } }], "2026-10-10T01:00:00Z"),
    asst([{ type: "tool_use", id: "h2", name: "mcp__ckanban__propose_huddle", input: { template: "design-review", roster: [{ preset: "qa" }] } }], "2026-10-10T01:00:01Z"),
    asst([{ type: "tool_use", id: "h3", name: "mcp__ckanban__propose_huddle", input: { reason: "no roster, no template" } }], "2026-10-10T01:00:02Z"),
  ].join("\n");
  const cards = parseSession(raw).entries.filter((e: any) => e.huddle).map((e: any) => e.huddle);
  expect(cards).toEqual([
    { roster: [], reason: "Review the feature", template: "design-review" },
    { roster: [{ preset: "qa" }], reason: "", template: "design-review" },
  ]);
});

test("proposed tickets: important, or a ⭐ before the title, marks them Important and the star leaves the title", () => {
  expect(parseNewTickets([{ key: "a", title: "⭐ Apply to OpenAI", description: "x" }, { key: "b", title: "Plain", description: "y", important: true }, { key: "c", title: "Other", description: "z" }]))
    .toEqual([
      { key: "a", title: "Apply to OpenAI", description: "x", important: true },
      { key: "b", title: "Plain", description: "y", important: true },
      { key: "c", title: "Other", description: "z" },
    ]);
  expect(parseProposal({ title: "⭐ Fix login", description: "d" })).toEqual({ title: "Fix login", description: "d", important: true });
  expect(parseProposal({ title: "Fix login", description: "d" })).toEqual({ title: "Fix login", description: "d" });
});

test("parseSession shows a message with attachments as typed, without the note for Claude", () => {
  const path = "/Users/me/.claude-kanban/attachments/0123456789abcdef0123456789abcdef.png";
  const raw = [
    user(`what is this? ![image](${path})\n\n${IMAGES_NOTE}`, "2026-09-29T03:00:00Z"),
    user(`read this [a.pdf](/x/a.pdf)\n\n${FILES_NOTE}`, "2026-09-29T03:00:01Z"),
  ].join("\n");
  expect(parseSession(raw).entries.map((e) => e.text)).toEqual([`what is this? ![image](${path})`, "read this [a.pdf](/x/a.pdf)"]);
});

test("a session file missing for a while is searched for less often", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-555555555555";
  let now = 0;
  const cache = new SessionCache({ configDir }, () => now);
  expect(cache.file(sid)).toBeNull();
  // A new run's file shows up seconds later: found at once.
  writeFileSync(join(dir, `${sid}.jsonl`), user("hi", "2026-09-29T01:00:00Z") + "\n");
  now = 2_000;
  expect(cache.file(sid)).toBe(join(dir, `${sid}.jsonl`));

  const gone = "99999999-2222-3333-4444-555555555555";
  now = 10_000;
  expect(cache.file(gone)).toBeNull();
  now += 5 * 60_000;
  expect(cache.file(gone)).toBeNull();
  // Missing for 5 minutes: not searched again for a minute.
  writeFileSync(join(dir, `${gone}.jsonl`), user("back", "2026-09-29T01:00:00Z") + "\n");
  now += 30_000;
  expect(cache.file(gone)).toBeNull();
  now += 30_000;
  expect(cache.file(gone)).toBe(join(dir, `${gone}.jsonl`));
});

test("session summaries are kept on disk: a new cache answers without reading an unchanged transcript", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "21111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, user("first", "2026-09-29T01:00:00Z") + "\n");
  const summaryFile = join(tempDir(), "session-summaries.json");
  const a = new SessionCache({ configDir }, Date.now, summaryFile);
  expect(a.summary(sid)?.lastMessage?.text).toBe("first");
  a.flushSummaries();

  // After a restart: the stored summary is used while the transcript is unchanged (even if unreadable now).
  const b = new SessionCache({ configDir }, Date.now, summaryFile);
  let reads = 0;
  const get = b.get.bind(b);
  (b as any).parsed = (id: string) => (reads++, get(id));
  expect(b.summary(sid)?.lastMessage?.text).toBe("first");
  expect(reads).toBe(0);

  // The transcript grew: read again.
  appendFileSync(file, user("second", "2026-09-29T01:00:01Z") + "\n");
  expect(b.summary(sid)?.lastMessage?.text).toBe("second");
  expect(reads).toBe(1);
});

test("the summaries file is written only when a summary in it changed", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-w");
  mkdirSync(dir, { recursive: true });
  const sid = "31111111-2222-3333-4444-555555555555";
  writeFileSync(join(dir, `${sid}.jsonl`), user("first", "2026-09-29T01:00:00Z") + "\n");
  const summaryFile = join(tempDir(), "session-summaries.json");
  const a = new SessionCache({ configDir }, Date.now, summaryFile);
  a.summary(sid);
  a.flushSummaries();
  const written = statSync(summaryFile).mtimeMs;
  // After a restart, the same day: the saved summary is used, nothing new to write.
  const b = new SessionCache({ configDir }, Date.now, summaryFile);
  b.summary(sid);
  rmSync(summaryFile);
  b.flushSummaries();
  expect(existsSync(summaryFile)).toBe(false);
  // A new summary: written.
  appendFileSync(join(dir, `${sid}.jsonl`), user("second", "2026-09-29T01:00:01Z") + "\n");
  b.summary(sid);
  b.flushSummaries();
  expect(existsSync(summaryFile)).toBe(true);
  expect(written).toBeGreaterThan(0);
});

test("saved summaries of deleted transcripts and of sessions unused for 30 days are dropped at the next write", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-s");
  mkdirSync(dir, { recursive: true });
  const [kept, gone, unused] = ["61111111-2222-3333-4444-555555555555", "62111111-2222-3333-4444-555555555555", "63111111-2222-3333-4444-555555555555"];
  for (const id of [kept, gone, unused]) writeFileSync(join(dir, `${id}.jsonl`), user(`hello ${id}`, "2026-09-29T01:00:00Z") + "\n");
  const summaryFile = join(tempDir(), "session-summaries.json");
  let now = Date.UTC(2026, 9, 1);
  const a = new SessionCache({ configDir }, () => now, summaryFile);
  for (const id of [kept, gone, unused]) a.summary(id);
  a.flushSummaries();
  expect(Object.keys(JSON.parse(readFileSync(summaryFile, "utf8")).items).length).toBe(3);

  // A restart 20 days later: one is opened, one transcript is deleted.
  now += 20 * 86_400_000;
  const b = new SessionCache({ configDir }, () => now, summaryFile);
  rmSync(join(dir, `${gone}.jsonl`));
  b.summary(kept);
  b.flushSummaries();
  expect(Object.keys(JSON.parse(readFileSync(summaryFile, "utf8")).items).sort()).toEqual([kept, unused].sort());
  // 15 more days: the one nobody opened for 35 days goes.
  now += 15 * 86_400_000;
  b.summary(kept);
  b.flushSummaries();
  expect(Object.keys(JSON.parse(readFileSync(summaryFile, "utf8")).items)).toEqual([kept]);
});

test("summaries made by older code are shown until warm() has made them again, and survive a restart meanwhile", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-s");
  mkdirSync(dir, { recursive: true });
  const [same, differs, grown] = ["31111111-2222-3333-4444-555555555555", "32111111-2222-3333-4444-555555555555", "33111111-2222-3333-4444-555555555555"];
  for (const id of [same, differs, grown]) writeFileSync(join(dir, `${id}.jsonl`), user(`hello ${id}`, "2026-09-29T01:00:00Z") + "\n");
  const summaryFile = join(tempDir(), "session-summaries.json");
  const a = new SessionCache({ configDir }, Date.now, summaryFile);
  for (const id of [same, differs, grown]) a.summary(id);
  a.flushSummaries();
  // The file as older code left it: another tag, one summary that the new code makes differently, and no `cache` field.
  const saved = JSON.parse(readFileSync(summaryFile, "utf8"));
  saved.tag = saved.tag.replace(/[^:]+$/, "older");
  saved.items[differs].s.lastMessage.text = "as the old code read it";
  for (const id of [same, differs, grown]) delete saved.items[id].s.cache;
  writeFileSync(summaryFile, JSON.stringify(saved));
  appendFileSync(join(dir, `${grown}.jsonl`), user("more", "2026-09-29T01:00:01Z") + "\n");

  const b = new SessionCache({ configDir }, Date.now, summaryFile);
  let reads = 0;
  const parsed = (b as any).parsed.bind(b);
  (b as any).parsed = (id: string) => (reads++, parsed(id));
  // Unchanged transcripts: the older summary, without reading; fields it lacks are filled in.
  expect(b.summary(differs)?.lastMessage?.text).toBe("as the old code read it");
  expect(b.summary(same)).toEqual(a.summary(same));
  expect(reads).toBe(0);
  // A transcript that changed since is read.
  expect(b.summary(grown)?.lastMessage?.text).toBe("more");
  expect(reads).toBe(1);

  // A restart before the warm-up: the older summaries are still there.
  b.flushSummaries();
  const c = new SessionCache({ configDir }, Date.now, summaryFile);
  expect(c.summary(differs)?.lastMessage?.text).toBe("as the old code read it");

  // The warm-up: ready() needs no reading (every session has something to show); then each older one is made again.
  const remade: string[] = [];
  const done = c.warm([same, differs, grown], 0, (id) => remade.push(id));
  await c.ready();
  expect(c.summary(differs)?.lastMessage?.text).toBe("as the old code read it");
  await done;
  expect(remade).toEqual([differs]);
  expect(c.summary(differs)?.lastMessage?.text).toBe(`hello ${differs}`);
  c.flushSummaries();
  const after = JSON.parse(readFileSync(summaryFile, "utf8"));
  expect(after.stale).toBeUndefined();
  expect(Object.keys(after.items).sort()).toEqual([same, differs, grown].sort());

  // Another format number: the old summaries are dropped, not shown.
  after.tag = "1:dev:older";
  writeFileSync(summaryFile, JSON.stringify(after));
  const d = new SessionCache({ configDir }, Date.now, summaryFile);
  expect((d as any).storedSummaries().stale).toBeUndefined();
});

test("the summaries' tag changes with the code that makes them, not with other server files", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "session.ts"), 'import { a } from "./a";\nimport type { T } from "./typesonly";\nexport const s = a;\n');
  writeFileSync(join(dir, "a.ts"), 'import {\n  b,\n} from "./b";\nexport const a = b;\n');
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "typesonly.ts"), "export type T = 1;\n");
  writeFileSync(join(dir, "http.ts"), "export const h = 1;\n");
  const tag = summaryTag(dir);
  writeFileSync(join(dir, "http.ts"), "export const h = 2;\n");
  writeFileSync(join(dir, "typesonly.ts"), "export type T = 2;\n");
  expect(summaryTag(dir)).toBe(tag);
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  expect(summaryTag(dir)).not.toBe(tag);
});

test("the session watcher's first pass only takes stock: no session.updated until a transcript changes", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "31111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, user("first", "2026-09-29T01:00:00Z") + "\n");
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid });
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const stop = startSessionWatcher(store, bus, new SessionCache({ configDir }), 20);
  try {
    await Bun.sleep(120);
    expect(seen).toEqual([]);
    appendFileSync(file, asst([{ type: "text", text: "reply" }], "2026-09-29T01:00:01Z") + "\n");
    await Bun.sleep(120);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ type: "session.updated", profile: "p", id: t.id });
  } finally {
    stop();
  }
});

test("SessionParser: feeding a transcript in pieces (split mid-line and mid-character) gives the same result as parsing it whole", () => {
  const raw = [
    RAW,
    user("ünïcödé 🎉 message", "2026-09-29T01:00:09Z"),
    asst([{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "Look around", subagent_type: "Explore" } }], "2026-09-29T01:00:10Z"),
    user([{ type: "tool_result", tool_use_id: "ag1", content: "found it" }], "2026-09-29T01:00:11Z"),
    asst([{ type: "tool_use", id: "q1", name: "mcp__ckanban__ask_questions", input: { questions: [{ question: "A or B?", options: ["A", "B"] }] } }], "2026-09-29T01:00:12Z"),
    asst([{ type: "text", text: "Last words ✓" }], "2026-09-29T01:00:13Z"),
  ].join("\n") + "\n";
  const whole = parseSession(raw);
  const bytes = Buffer.from(raw);
  for (const size of [1, 7, 50, 333]) {
    const p = new SessionParser();
    for (let i = 0; i < bytes.length; i += size) {
      p.feed(bytes.subarray(i, i + size));
      // Reading the result midway doesn't change what comes after.
      if (i % (size * 3) === 0) p.result();
    }
    expect(p.result()).toEqual(whole);
  }
});

test("SessionParser: a result read earlier doesn't change when more lines arrive", () => {
  const p = new SessionParser();
  p.feed(Buffer.from(asst([{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "Look" } }], "2026-09-29T01:00:00Z") + "\n"));
  const before = p.result();
  const copy = structuredClone(before);
  p.feed(Buffer.from(user([{ type: "tool_result", tool_use_id: "ag1", content: "done", is_error: true }], "2026-09-29T01:00:01Z") + "\n"));
  expect(p.result().entries[0].agent!.status).toBe("failed");
  expect(before).toEqual(copy);
});

test("SessionCache reads only what was appended, keeps a half-written line, and starts over when the file shrinks or is replaced", () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-inc");
  mkdirSync(dir, { recursive: true });
  const sid = "41111111-2222-3333-4444-555555555555";
  const file = join(dir, `${sid}.jsonl`);
  const lines = [
    user("hi", "2026-09-29T01:00:00Z"),
    asst([{ type: "text", text: "hello" }], "2026-09-29T01:00:01Z"),
    asst([{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }], "2026-09-29T01:00:02Z"),
    user([{ type: "tool_result", tool_use_id: "t9", content: "oops", is_error: true }], "2026-09-29T01:00:03Z"),
    asst([{ type: "text", text: "done ✓" }], "2026-09-29T01:00:04Z"),
  ];
  const cache = new SessionCache({ configDir });
  writeFileSync(file, lines[0] + "\n");
  expect(cache.get(sid)).toEqual(parseSession(lines[0] + "\n"));
  let text = lines[0] + "\n";
  for (const l of lines.slice(1)) {
    // Half a line first (cut inside a multi-byte character when there is one), then the rest.
    const b = Buffer.from(l + "\n");
    const cut = l.includes("✓") ? Buffer.from(l.slice(0, l.indexOf("✓"))).length + 1 : Math.floor(b.length / 2);
    appendFileSync(file, b.subarray(0, cut));
    expect(cache.get(sid)).toEqual(parseSession(text));
    appendFileSync(file, b.subarray(cut));
    text += l + "\n";
    expect(cache.get(sid)).toEqual(parseSession(text));
  }
  expect(cache.get(sid)!.lastMessage!.text).toBe("done ✓");
  expect(cache.get(sid)!.entries.find((e) => e.toolUseId === "t9")!.error).toBe(true);
  // A last line with no newline yet but complete is read, like a whole parse does.
  appendFileSync(file, asst([{ type: "text", text: "no newline" }], "2026-09-29T01:00:05Z"));
  expect(cache.get(sid)!.lastMessage!.text).toBe("no newline");
  // Shrunk (rewritten shorter): parsed again from the start.
  writeFileSync(file, lines[1] + "\n");
  expect(cache.get(sid)).toEqual(parseSession(lines[1] + "\n"));
  // Replaced by a new file of the same size or bigger: parsed again from the start.
  const other = join(dir, "tmp.jsonl");
  writeFileSync(other, lines[4] + "\n" + lines[0] + "\n");
  renameSync(other, file);
  expect(cache.get(sid)).toEqual(parseSession(lines[4] + "\n" + lines[0] + "\n"));
});

test("SessionCache.warm parses many transcripts without blocking the event loop for long, then summaries are ready", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-warm");
  mkdirSync(dir, { recursive: true });
  const ids: string[] = [];
  const big = Array.from({ length: 3000 }, (_, i) => asst([{ type: "text", text: `line ${i} ${"x".repeat(300)}` }], `2026-09-29T01:${String(i % 60).padStart(2, "0")}:00Z`)).join("\n") + "\n";
  for (let i = 0; i < 20; i++) {
    const sid = `5111111${i.toString(16)}-2222-3333-4444-555555555555`;
    ids.push(sid);
    writeFileSync(join(dir, `${sid}.jsonl`), big);
  }
  const cache = new SessionCache({ configDir });
  // Timers get to run while it works: it pauses between steps instead of parsing all 20 files (24MB) in one go.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const done = cache.warm(ids, 0);
  expect(cache.settled()).toBe(done);
  await cache.ready();
  // No older summaries to make again: the second round has nothing to read.
  for (const id of ids) expect((cache as any).items.get(id).offset).toBe(Buffer.byteLength(big));
  await done;
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(5);
  // Every transcript was read to the end, so summaries need no more reading.
  for (const id of ids) expect((cache as any).items.get(id).offset).toBe(Buffer.byteLength(big));
  for (const id of ids) expect(cache.summary(id)!.lastMessage!.text).toBe(`line 2999 ${"x".repeat(300)}`);
});

test("pollSessionsSliced announces changed sessions, pausing between tickets", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const store = new Store(tempDir());
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const sid = `11111111-2222-3333-4444-55555555555${i}`;
    writeFileSync(join(dir, `${sid}.jsonl`), user(`hi ${i}`, "2026-09-29T01:00:00Z") + "\n");
    const t = store.createTicket("p", { title: `t${i}`, body: "", status: "review" });
    store.updateTicket("p", t.id, { sessionId: sid });
    ids.push(t.id);
  }
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const cache = new SessionCache({ configDir });
  const state = new Map<string, string>();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const owners: string[] = [];
  await pollSessionsSliced(store, bus, cache, state, true, (sid, key) => sid && owners.push(key), 0);
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(0);
  expect(seen.map((e) => (e as any).id).sort()).toEqual([...ids].sort());
  expect(owners.length).toBe(4);
  await pollSessionsSliced(store, bus, cache, state, true, undefined, 0);
  expect(seen.length).toBe(4);
  appendFileSync(join(dir, "11111111-2222-3333-4444-555555555552.jsonl"), asst([{ type: "text", text: "reply" }], "2026-09-29T01:00:01Z") + "\n");
  await pollSessionsSliced(store, bus, cache, state, true, undefined, 0);
  expect(seen.length).toBe(5);
  expect((seen[4] as any).id).toBe(ids[2]);
});

test("scanSessionFilesAsync finds the same files as scanSessionFiles", async () => {
  const configDir = tempDir();
  for (let d = 0; d < 20; d++) {
    const dir = join(configDir, "projects", `-p${d}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `s${d}.jsonl`), "");
    writeFileSync(join(dir, "notes.txt"), "");
  }
  // The same id in two folders: the first listed wins in both.
  writeFileSync(join(configDir, "projects", "-p7", "s3.jsonl"), "");
  const sync = scanSessionFiles({ configDir });
  const async = await scanSessionFilesAsync({ configDir }, 3);
  expect(async.size).toBe(20);
  expect([...async.entries()].sort()).toEqual([...sync.entries()].sort());
  expect(await scanSessionFilesAsync({ configDir: join(configDir, "nope") })).toEqual(new Map());
});

test("readIn reads a changed transcript in chunks, pausing between them, and skips one whose saved summary holds", async () => {
  const configDir = tempDir();
  const dir = join(configDir, "projects", "-f");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-3333-4444-666666666666";
  const lines = [user("first", "2026-09-29T01:00:00Z")];
  // Over 2 MB: more than one chunk.
  for (let i = 0; i < 40; i++) lines.push(asst([{ type: "text", text: `${i} ${"y".repeat(60_000)}` }], "2026-09-29T01:00:01Z"));
  lines.push(asst([{ type: "text", text: "last" }], "2026-09-29T01:00:02Z"));
  writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  const cache = new SessionCache({ configDir }, Date.now, join(tempDir(), "summaries.json"));
  let pauses = 0;
  await cache.readIn(sid, async () => void pauses++);
  expect(pauses).toBeGreaterThan(1);
  expect(cache.summary(sid)!.lastMessage!.text).toBe("last");
  cache.flushSummaries();
  const again = new SessionCache({ configDir }, Date.now, cache["summaryFile"]);
  let more = 0;
  await again.readIn(sid, async () => void more++);
  expect(more).toBe(0);
});
