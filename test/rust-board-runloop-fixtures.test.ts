// The R7a run loop rules' shared fixtures (rust/board/tests/fixtures/runloop.json): inputs for the pure rules of
// src/board/board-types.ts (chatFor, takesSlot, hasText, replayText, sessionMissing...), commandText
// (src/chat/commands.ts), src/usage/limit.ts (parseReset, dayKey, clockTime), src/schedules/followup.ts (parseDelay,
// followUpTime, the log) and parseAt/formatAt (src/schedules/jobs.ts), with Bun's answer in `expect` (JSON text).
// Local time is pinned to the file's zone (America/New_York), so DST days read the same on every Mac.
//
// This test builds the table, works out Bun's answers and checks the file holds exactly them; `cargo test -p
// ckanban-board --test runloop_rules` checks Rust gives the same. After a deliberate change to that Bun code:
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-runloop-fixtures.test.ts`, then make `cargo test` pass again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVITY_THROTTLE_MS, ANSWER_PREFIX, ANSWER_REPEAT_MS, AUTO_FRESH_NOTE, DRAFT_THROTTLE_MS, FOLDER_WAIT, INSTALLING, RESTART_HOLD_TEXT,
  RESTART_MAX_WAIT_MS, REWINDING, SESSION_OPEN_MSG, STALL_RESTART_TEXT, TELEGRAM_KEEP, THINKING_LINE, WORKFLOW_CAP_POLL_MS, WORKFLOW_STOPPED_TEXT,
  autoHuddleActivity, chatFor, chatModeFor, claudeSetupHint, hasText, recoveryFor, reopenable, replayText, sessionMissing, sigChanges, takesSlot,
} from "../src/board/board-types";
import { commandText } from "../src/chat/commands";
import { AUTO_CONTINUE_PER_DAY, CONTINUE_DELAY_MS, CONTINUE_TEXT, clockTime, dayKey, nextFullHour, parseReset } from "../src/usage/limit";
import {
  FOLLOW_UP_LATE_MS, FOLLOW_UP_LOG_KEEP, FOLLOW_UP_MAX_MS, FOLLOW_UP_MIN_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX,
  followUpSpend, followUpTime, logFollowUp, parseDelay,
} from "../src/schedules/followup";
import { formatAt, parseAt } from "../src/schedules/jobs";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "runloop.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const TZ = "America/New_York";
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));
/** A result or the thrown error's message. */
const attempt = (f: () => unknown) => {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const iso = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString());

/** A chat in the key order Rust's Chat::to_json writes (only the keys set; a missing outcome reads null). */
function canon(c: any): any {
  const out: any = { text: c.text, mode: c.mode };
  if (c.raw) out.raw = true;
  if (c.returnTo !== undefined) out.returnTo = c.returnTo;
  if (c.quiet) out.quiet = true;
  if (c.from) out.from = { status: c.from.status, outcome: c.from.outcome ?? null };
  if (c.user) out.user = true;
  if (c.slash) out.slash = c.slash;
  if (c.hostWake) out.hostWake = true;
  if (c.followUp) out.followUp = true;
  if (c.nudge) out.nudge = true;
  return out;
}

// ---- The table ----

const STATUSES = ["backlog", "planning", "ready", "in_progress", "review", "done"];
const tickets: any[] = [];
for (const status of STATUSES) {
  tickets.push({ status, outcome: null });
  tickets.push({ status, outcome: "done", tool: true });
}
tickets.push({ status: "review", outcome: "needs_input" }, { status: "done", outcome: "blocked", tool: false });
const messages: any[] = [
  { text: "hi" }, { text: "hi", peer: true }, { text: "hi", fromPlanner: true }, { text: "/x", slash: "prompt" }, { text: "/compact", slash: "local" },
  { text: "/compact", slash: "local", fromPlanner: true }, { text: "wake", hostWake: true }, { text: "later", followUp: true },
  { text: "both", followUp: true, hostWake: true, peer: true }, { text: "p", peer: true, slash: "local" }, { text: "e", slash: "" },
];

const events: any[] = [
  { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "  \n " }] } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", name: "Bash" }] } },
  { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "sub" }] } },
  { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "top" }] } },
  { type: "assistant", parent_tool_use_id: "", message: { content: [{ type: "text", text: "empty parent" }] } },
  { type: "assistant", message: { content: "plain string" } },
  { type: "assistant", message: { content: [{ type: "text", text: 5 }] } },
  { type: "user", isReplay: true, message: { content: "typed text" } },
  { type: "user", isReplay: true, message: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } },
  { type: "user", isReplay: true, message: { content: [{ type: "text", text: 7 }, { type: "text" }, { type: "text", text: null }] } },
  { type: "user", isReplay: true, message: { content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet </command-args>" } },
  { type: "user", isReplay: true, message: { content: "<command-name>compact</command-name><command-args></command-args>" } },
  { type: "user", isReplay: false, message: { content: "not a replay" } },
  { type: "user", message: { content: "no flag" } },
  { type: "user", isReplay: true, message: { content: { odd: true } } },
  { type: "user", isReplay: 1, message: {} },
  { type: "result", result: "done" },
  null,
];

const commandTexts = [
  "<command-name>/model</command-name><command-args>opus</command-args>",
  "  <command-message>x</command-message><command-name> /effort </command-name><command-args>\n high \n</command-args>",
  "hello <command-name>/x</command-name>",
  "<command-name></command-name>",
  "<command-name>/a b</command-name>",
  "<command-args>only</command-args>",
  "<command-name>/multi</command-name><command-args>line one\nline two</command-args><command-args>second</command-args>",
  "",
];

const errors = [
  "No conversation found with session ID: abc", "no CONVERSATION found with session id", "Error: spawn claude ENOENT\nfailed to start the claude process",
  "Failed To Start: Claude", "Executable not found in $PATH: \"claude\"", "executable not found in $path: claude", "Please run /login · API key",
  "failed to start\nclaude", "something else", "", SESSION_OPEN_MSG,
];

// A fixed "now" for the time rules: mid-afternoon New York time, and days around the DST changes and the year's end.
const NOWS = [
  "2026-11-17T19:20:00.000Z", "2026-03-08T05:30:00.000Z", "2026-03-07T12:00:00.000Z", "2026-11-01T04:30:00.000Z", "2026-10-31T23:00:00.000Z",
  "2026-12-30T15:00:00.000Z", "2026-07-01T03:59:59.999Z", "2026-11-17T04:59:30.000Z",
];
const RESETS = [
  "You've hit your individual spend limit · run /usage-credits to raise it · your session limit resets 4am (Asia/Kuala_Lumpur)",
  "… your session limit resets 12:30am (Asia/Kuala_Lumpur)", "Claude AI usage limit reached|1760000000", "5-hour limit reached ∙ resets 3pm",
  "resets 16:00", "resets 4:05pm", "Weekly limit reached · resets Oct 14, 9am", "resets Jan 2, 9am", "resets on Mar 8 at 2:30am",
  "resets at 12pm", "resets 12am", "resets 5", "resets 25:00", "resets 9:75am", "resets 3am (America/Los_Angeles)", "resets 3am (Nowhere/Else)",
  "resets 7pm (Europe/London)", "resets 2:30am", "resets 1:30am", "RESETS 10PM (UTC)", "resets 6am (+08:00)", "no time here", "resets 9am (asia/tokyo)",
  "resets December 31, 11pm", "resets Feb 30, 1am", "| 1234567890", "|12345678901", "resets 11:59pm (Pacific/Kiritimati)", "Resets 3 PM",
];

const DELAYS = ["30m", "4h", "2d", "1w", "1d 6h", "90 minutes", "1.5h", "2 hours and 30 min", "3d,4h", "  45 MINS ", "1 hr", "2hrs", "0m", "5ms", "m", "", "10", "1d6h30m", "2 weeks", "1e3m", "1.h", "999999999999999999999d"];
const ATS: unknown[] = [
  "2026-11-20 09:00", "2026-11-20T09:00", "2026-11-20 9:05:30", "2026-02-31 10:00", "2026-11-20 25:00", "2026-03-08 02:30", "2026-11-01 01:30",
  "2026-11-20T09:00Z", "2026-11-20T09:00:00.5+05:30", "2026-11-20T09:00+0530", "2026-02-31T10:00Z", "2026-11-20T24:00Z", "2026-11-20T24:30Z",
  "0050-01-01 10:00", "tomorrow", "", "  2026-12-01 08:00  ", 5, null, { at: 1 }, "2026-11-20 09:00:60", "2026-13-01 10:00",
];

function buildGroups(): Record<string, any[]> {
  const g: Record<string, any[]> = {};
  g.chatModeFor = [...STATUSES, "odd"].map((status) => ({ status, expect: j(chatModeFor(status as any)) }));
  g.chatFor = tickets.flatMap((t) => messages.map((msg) => ({ ticket: t, msg, expect: j(canon(chatFor(t, msg))) })));
  const chats = g.chatFor.map((c) => JSON.parse(c.expect));
  chats.push({ text: "x", mode: "act", returnTo: "review" }, { text: "x", mode: "act", returnTo: "review", followUp: true });
  g.takesSlot = [null, ...chats.filter((c, i) => chats.findIndex((d) => JSON.stringify(d) === JSON.stringify(c)) === i)].flatMap((chat) =>
    [false, true].map((noEdit) => ({ chat, noEdit, expect: j(takesSlot(chat ?? undefined, noEdit)) })));
  g.hasText = events.map((ev) => ({ ev, expect: j(hasText(ev)) }));
  g.replayText = events.map((ev) => ({ ev, expect: j(replayText(ev)) }));
  g.commandText = commandTexts.map((text) => ({ text, expect: j(commandText(text)) }));
  g.sessionMissing = [
    ...errors.map((error) => ({ error, events: [] })),
    { error: "x", events: [{ type: "result", errors: ["No conversation found with session ID: 1"] }] },
    { error: "x", events: [{ type: "result", errors: [5, "nope"] }, { type: "assistant", errors: ["No conversation found with session ID"] }] },
    { error: "x", events: [{ type: "result", errors: "No conversation found with session ID" }] },
  ].map((c) => ({ ...c, expect: j(sessionMissing(c.error, c.events)) }));
  g.claudeSetupHint = errors.map((error) => ({ error, expect: j(claudeSetupHint(error)) }));
  g.recoveryFor = [...errors, null].map((error) => ({ error, expect: j(recoveryFor(error)) }));
  g.autoHuddleActivity = [{ state: "waiting" }, { state: "running" }, {}].map((a) => ({ a, expect: j(autoHuddleActivity(a as any)) }));
  g.reopenable = STATUSES.map((status) => ({ status, expect: j(reopenable(status as any)) }));
  const rows = [{ id: "t_a", title: "Alpha" }, { id: "t_b", title: "Beta" }];
  g.sigChanges = [
    ["t_a:ready::|t_b:ready::", "t_a:review:done:|t_b:ready::"],
    ["t_a:ready::", "t_a:done:done:passed|t_c:ready::"],
    ["t_a:ready::|t_b:ready::", "t_b:in_progress::"],
    ["", "t_a:backlog::"],
    ["t_a:x", "t_a:"],
    ["noColon|t_a:ready", "noColon|t_a:ready|t_a:done"],
    ["t_a:ready::", "t_a:ready::"],
  ].map(([before, after]) => ({ before, after, rows, expect: j(sigChanges(before, after, rows as any)) }));
  g.parseReset = NOWS.flatMap((now) => RESETS.map((text) => ({ text, now, expect: j(iso(parseReset(text, new Date(now)))) })));
  g.nextFullHour = NOWS.map((now) => ({ now, expect: j(iso(nextFullHour(new Date(now)))) }));
  g.dayKey = NOWS.map((now) => ({ at: now, expect: j(dayKey(new Date(now))) }));
  g.clockTime = NOWS.flatMap((now) => [0, 3600_000, 19 * 3600_000, 20 * 3600_000, 3 * 86400_000].map((plus) => {
    const at = new Date(new Date(now).getTime() + plus).toISOString();
    return { at, now, expect: j(clockTime(new Date(at), new Date(now))) };
  }));
  g.parseDelay = DELAYS.map((v) => ({ v, expect: j(parseDelay(v)) }));
  g.parseAt = ATS.map((v) => ({ v, expect: j(attempt(() => iso(parseAt(v)))) }));
  g.formatAt = [...NOWS, "2026-03-08T07:05:00.000Z", "2026-01-01T04:59:00.000Z"].map((at) => ({ at, expect: j(formatAt(at)) }));
  const fu: { after: string | null; at: string | null }[] = [
    { after: "4h", at: null }, { after: null, at: "2026-11-20 09:00" }, { after: "4h", at: "2026-11-20 09:00" }, { after: null, at: null },
    { after: "  ", at: "  " }, { after: "soon", at: null }, { after: "30s", at: null }, { after: "1m", at: null }, { after: "0.5m", at: null },
    { after: "366d", at: null }, { after: "367d", at: null }, { after: "53w", at: null }, { after: "999999999999999999999d", at: null },
    { after: null, at: "2026-11-17 14:20" }, { after: null, at: "2026-11-17 14:21" }, { after: null, at: "2026-11-17 14:22" },
    { after: null, at: "2028-01-01 00:00" }, { after: null, at: "nope" }, { after: null, at: "2026-11-20T09:00Z" }, { after: "\"q\"", at: null },
  ];
  g.followUpTime = fu.map((input) => ({ ...input, now: NOWS[0], expect: j(attempt(() => iso(followUpTime(input, new Date(NOWS[0]))))) }));
  const log = Array.from({ length: 52 }, (_, i) => ({ at: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, kind: i % 3 ? "set" : "woke", ...(i % 6 ? {} : { costUsd: i / 10 }) }));
  g.logFollowUp = [[], log.slice(0, 3), log.slice(0, 49), log.slice(0, 50), log].map((l) => ({ log: l, e: { at: "x", kind: "missed" }, expect: j(logFollowUp(l as any, { at: "x", kind: "missed" } as any)) }));
  g.followUpSpend = [[], log.slice(0, 7), log, [{ kind: "woke", costUsd: 0.1 }, { kind: "woke", costUsd: 0.2 }, { kind: "woke" }]].map((l) => ({ log: l, expect: j(followUpSpend(l as any)) }));
  g.constants = [{
    expect: j({
      THINKING_LINE, INSTALLING, FOLDER_WAIT, STALL_RESTART_TEXT, RESTART_MAX_WAIT_MS, DRAFT_THROTTLE_MS, ACTIVITY_THROTTLE_MS, ANSWER_REPEAT_MS,
      ANSWER_PREFIX, SESSION_OPEN_MSG, REWINDING, AUTO_FRESH_NOTE, WORKFLOW_STOPPED_TEXT, WORKFLOW_CAP_POLL_MS, RESTART_HOLD_TEXT, TELEGRAM_KEEP,
      CONTINUE_TEXT, CONTINUE_DELAY_MS, AUTO_CONTINUE_PER_DAY, FOLLOW_UP_MIN_MS, FOLLOW_UP_LATE_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX,
      FOLLOW_UP_MAX_MS, FOLLOW_UP_LOG_KEEP,
    }),
  }];
  return g;
}

let tzBefore: string | undefined;
beforeAll(() => {
  tzBefore = process.env.TZ;
  process.env.TZ = TZ;
});
afterAll(() => {
  if (tzBefore === undefined) delete process.env.TZ;
  else process.env.TZ = tzBefore;
});

describe("Rust board run loop fixtures: Bun gives the answers they record", () => {
  test("the file is up to date", () => {
    // Local time really is the table's zone (Bun reads TZ when it changes).
    expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(240);
    const doc = { tz: TZ, groups: buildGroups() };
    if (UPDATE) {
      // One case per line: the file stays readable in a diff.
      const groups = Object.entries(doc.groups).map(([g, cases]) => `  ${JSON.stringify(g)}: [\n${cases.map((c) => `   ${JSON.stringify(c)}`).join(",\n")}\n  ]`).join(",\n");
      writeFileSync(FILE, `{\n "tz": ${JSON.stringify(TZ)},\n "groups": {\n${groups}\n }\n}\n`);
      return;
    }
    expect(doc).toEqual(JSON.parse(readFileSync(FILE, "utf8")));
  });
});
