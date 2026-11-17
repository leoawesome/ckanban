// The Rust helper's shared fixtures (rust/board/tests/fixtures/helper.json): inputs for the helper's pure rules
// (text lines, night rules, the decision checks, summaries, the Messages list, wait records, notify settings) and two
// store scripts (the bytes of waits.json and messages.json after each step), with Bun's answer in `expect`, worked out
// in the time zone the file names. This test checks Bun still gives exactly those answers; `cargo test -p
// ckanban-board --test helper` checks Rust does. After a deliberate change to Bun's helper code:
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-helper-fixtures.test.ts`, then make the Rust test pass again.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "helper.json");
const RUNNER = resolve(import.meta.dir, "support", "rust-helper-cases.ts");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const TZ = "America/Los_Angeles";

const H = 3600_000;
// Around the US DST changes (8 Mar and 1 Nov 2026) and an ordinary day.
const DAYS = ["2026-03-07T12:00:00-08:00", "2026-03-08T12:00:00-07:00", "2026-10-31T12:00:00-07:00", "2026-11-01T12:00:00-08:00", "2026-11-17T12:00:00-08:00"].map(Date.parse);
const NIGHTS = [{ start: "22:00", end: "07:00" }, { start: "23:30", end: "06:15" }, { start: "01:00", end: "05:00" }, { start: "7:00", end: "7:00" }, { start: "bad", end: "08:00" }];
const ON = ["mac", "push", "telegram"];
const CHANNELS = ["mac", "webhook", "push", "telegram"];

function cases(): { fn: string; args: unknown[] }[] {
  const out: { fn: string; args: unknown[] }[] = [{ fn: "system", args: [] }];
  const add = (fn: string, ...args: unknown[]) => out.push({ fn, args });
  for (const s of ["", "  a \n b ", "x".repeat(120), "abc def ghi jkl", `${"word ".repeat(30)}end`, "emoji 👍🏽 here and more text to cut", "tab\tand nbsp"]) for (const n of [4, 10, 110]) add("cut", s, n);
  for (const t of DAYS) for (let h = 0; h < 24; h += 5) add("clockTime", new Date(t + h * H + 7 * 60_000).toISOString());
  for (const r of [
    { kind: "questions", question: "Which name?\nSecond line", label: "Answer 2 questions" },
    { kind: "questions", question: "\n\n  ", label: "Answer 1 question" },
    { kind: "questions", question: "Answer 1 question", label: "Answer 1 question" },
    { kind: "review", question: "Ready", label: "Ready for review" },
    { kind: "questions", question: `${"long ".repeat(40)}?`, label: "x" },
  ]) add("directLabel", r);
  for (const n of [1, 4]) for (const r of [null, "2026-11-17T19:05:00.000Z"]) add("usageLimitLine", n, r);
  for (const l of ["6 tickets wait on you: docs copy", "5 wait on you - pricing", "3 need you, review", "2 new for you: x", "1 ticket needs your answer: billing", "Nothing counted here", "", "12 are waiting — copy", "4 Product Hunt runs wait on you: replies"]) for (const n of [0, 1, 3]) add("summaryLine", n, l);
  const steps = [{ sentAt: "a" }, { sentAt: "b", skipped: true }, { sentAt: "c" }, {}, {}];
  for (let i = 0; i < steps.length; i++) add("reminderCount", steps, i);
  for (const t of ["a\n\nNext: I'll remind you on phone\n\nRight call? Tap", "only", "a\n\nNo reminders planned: this is the only alert.", "Next: I'll remind you", "x\n\nb\n\nRight call? y"]) add("reminderBody", t);
  for (const [c, later] of [["push", ["mac"]], ["mac", ["push"]], ["telegram", []], ["webhook", ["telegram", "push"]]] as const) add("stepChain", c, later, ON);
  for (const n of [1, 3]) add("keptQuietLine", n, "12:41");
  for (const t of ["Prep: Standup at 9:30", "prep: board meeting at 14.05", "Prep: late at 23:59", "Prep: none", "Prep: bad at 25:00", "Not prep at 10:00", "PREP: x at 7:05 tomorrow"]) for (const d of DAYS) add("meetingTime", t, new Date(d + 3 * H).toISOString());
  for (const f of [0, 1, 2, 3, 5, 6, 9]) add("backoffMs", f);
  for (const v of ["7:00", "07:00", "22:30", "24:00", "7:0", " 6:15 ", "19:59", "007:00", "", "1:60"]) add("hm", v);
  for (const t of DAYS) for (let h = -12; h < 24; h += 1.5) for (const n of NIGHTS) {
    const ms = t + h * H;
    add("inNight", ms, n);
    add("nightEnd", ms, n);
    add("morningDigestAt", ms, n);
    add("lastNightEnd", ms, n);
    add("lookBeforeDigest", ms, n);
  }
  for (const t of DAYS) for (const last of [null, t - 4 * H, t - H, t - 10 * H, t - 0.5 * H]) for (const n of NIGHTS.slice(0, 3)) add("summaryAllowedAt", last, t, n);
  for (const w of ["mac", "webhook", "push", "telegram", "sms"]) for (const on of [ON, ["webhook"], [], ["telegram"]]) add("channelFor", w, CHANNELS, on);
  for (const st of [{ checkin: true }, { pendingReminders: true }, { stopped: "got-it" }, { stopped: "expired" }, { opened: true }, { alerted: true }, {}]) {
    add("urgentRefusal", { open: true, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null, ...st });
  }
  for (const t of ['{"a":1}', '```json\n{"sends":[]}\n```', "``` {\"x\":2} ```", "not json", "  [1,2] "]) add("parseDecision", t);
  // checkDecision: a few wait states, channels, nights.
  const items: [string, unknown][] = [
    ["a", { open: true, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null }],
    ["b", { open: true, snoozed: false, checkin: false, told: true, pendingReminders: false, stopped: null }],
    ["c", { open: true, snoozed: true, checkin: false, told: false, pendingReminders: false, stopped: null }],
    ["d", { open: false, snoozed: false, checkin: false, told: false, pendingReminders: false, stopped: null }],
    ["e", { open: true, snoozed: false, checkin: false, told: false, pendingReminders: true, stopped: null }],
    ["checkin:p/t1", { open: true, snoozed: false, checkin: true, told: false, pendingReminders: false, stopped: null }],
  ];
  const decisions: unknown[] = [
    { sends: [], nextWakeIn: 30, notes: "n", log: "l" },
    { sends: [{ level: "urgent", oneLine: "Billing twice", why: "customers", itemKeys: ["a", "b", "zz", "a"], escalation: [{ channel: "push", afterMin: 2 }, { channel: "telegram", afterMin: 3 }, { channel: "webhook", afterMin: 200 }] }], nextWakeIn: 0, notes: "x".repeat(4100), log: "did" },
    { sends: [{ level: "summary", oneLine: "", why: "w", itemKeys: ["b"], escalation: [] }, { level: "summary", oneLine: "docs", why: "", itemKeys: ["a", "c", "d", "checkin:p/t1"], escalation: [], followed: [0, 0, 1, 9, -1, "x", 2, 3] }], nextWakeIn: 5000, notes: 5, log: "" },
    { sends: [{ level: "loud", itemKeys: ["a"] }, { level: "urgent", oneLine: "x", why: "", itemKeys: ["e", "checkin:p/t1"], escalation: [] }, { level: "urgent", oneLine: "y", why: "", itemKeys: ["a"], escalation: [{ channel: "mac", afterMin: 0 }, { channel: "mac", afterMin: 1 }, { channel: "mac", afterMin: 1 }, { channel: "push", afterMin: 50 }, { channel: "mac", afterMin: 60 }, { channel: "mac", afterMin: 70 }, { channel: "mac", afterMin: 80 }], followed: "no" }], nextWakeIn: 12.5, notes: "", log: "l" },
    { sends: "nope", nextWakeIn: 1 },
    { sends: [], nextWakeIn: "5" },
    null,
  ];
  const feedback = ["pricing is always urgent", "  ", "never docs", "fourth"];
  for (const d of decisions) for (const t of [DAYS[4], DAYS[4] + 11 * H]) for (const opt of [null, true]) for (const on of [ON, []]) {
    add("checkDecision", d, { now: t, items, channels: CHANNELS, on, night: NIGHTS[0], nightOptIn: opt, feedback });
  }
  // Summaries.
  for (const t of ["Product Hunt replies 2026-11-09 10:20", "Daily check 2026-11-09", "Plain title", "x 2026-1-9", " Trim me  2026-11-09T7:05 "]) add("titleStem", t);
  const now = DAYS[4];
  const it = (k: string, board: string, title: string, label: string, sinceH: number) => ({ key: k, board, boardName: board.toUpperCase(), ticketId: `t_${k}`, title, label, since: new Date(now - sinceH * H).toISOString() });
  const fresh = [it("1", "p", "Product Hunt replies 2026-11-09 10:20", "Ready for review", 2), it("2", "p", "Product Hunt replies 2026-11-10 10:20", "Ready for review", 1), it("3", "q", "Docs", "Answer 1 question", 5), it("4", "p", "Old one", "Ready", 100), it("5", "p", "Product Hunt replies 2026-11-11 10:20", "Failed", 3)];
  add("collapseRuns", fresh);
  for (const d of DAYS) add("shortDate", new Date(d).toISOString());
  add("shortDate", "2026-09-03T10:00:00.000Z");
  const still = [it("6", "q", "Waiting", "Ready", 30), it("7", "p", "Very old", "Ready", 200)];
  for (const boards of [true, false]) {
    add("buildSummary", { headline: "3 new for you: docs", fresh, still, checkins: [it("c1", "p", "Prep: x at 9:00", "prep ready", 1)], olderCheckins: 2, notes: ["first", "offer"], boards, now });
    add("buildSummary", { headline: "1 new for you", fresh: fresh.slice(2, 3), still: [], checkins: [], olderCheckins: 0, notes: [], boards, now });
  }
  for (const d of DAYS) add("weekStart", d);
  const recs = [
    { toldAt: new Date(DAYS[4] - 7 * 24 * H).toISOString(), toldVia: "helper", reminders: [] },
    { toldAt: new Date(DAYS[4] - 6 * 24 * H).toISOString(), toldVia: "digest", reminders: [] },
    { toldAt: null, toldVia: null, reminders: [{ channel: "push", dueAt: "x", sentAt: new Date(DAYS[4] - 5 * 24 * H).toISOString() }, { channel: "mac", dueAt: "x", sentAt: new Date(DAYS[4] - 5 * 24 * H + H).toISOString(), failed: true }] },
    { toldAt: new Date(DAYS[4] - 2 * H).toISOString(), toldVia: "helper", reminders: [] },
  ];
  add("weekRecapLine", recs, { "2026-11-10": 1.234, "2026-11-12": 4.5 }, DAYS[4]);
  add("weekRecapLine", [], {}, DAYS[4]);
  add("weekRecapLine", [], { "2026-11-11": 0.004 }, DAYS[4]);
  // The Messages list.
  const msg = (id: string, at: number, level: string, oneLine: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ id, at: new Date(at).toISOString(), level, oneLine, text: "t", why: null, items, sends: [], readAt: null, ...extra });
  const item = (title: string, ticketId = "t_1", board = "p", boardName = "Product") => ({ key: `${board}/${ticketId}|review`, board, boardName, ticketId, title, question: "q" });
  const list = [
    msg("m9", now, "summary", "3 new for you: docs, pricing", [item("Docs")], { summary: { new: [{ key: "p/t_1|review" }], still: [], stillCount: 0, oldestAt: null, checkins: [], olderCheckins: 0, notes: [], grouped: false } }),
    msg("m8", now - 60_000, "pause", "Helper can't run", []),
    msg("m7", now - 90_000, "fallback", "2 tickets wait on you", [item("A", "t_2"), item("B", "t_3")]),
    msg("m6", now - 2 * H, "urgent", "Ready for review: Docs", [item("Docs")], { readAt: "r", tapped: { how: "got-it", at: "x" } }),
    msg("m5", now - 3 * H, "routine", "Kept quiet", [item("t_20261117_abcd", "t_20261117_abcd")], { held: true }),
    msg("m4", now - 4 * H, "direct", "Something", [item("", "t_4"), item("", "t_5", "q", "")], { readAt: "r" }),
    msg("m3", now - 5 * H, "digest", "no colon here", [item("X"), item("Y", "t_6"), item("Z", "t_7"), item("W", "t_8")]),
    msg("m2", now - 6 * H, "test", "Practice", [], { practice: true }),
    msg("m1", now - 7 * H, "pause", "held pause", [], { held: true }),
  ];
  for (const m of list) {
    add("rowLines", m);
    add("toRow", m, ["m9", "m7"]);
  }
  const needs = ["m9", "m8", "m7", "m4"];
  for (const tab of ["needs", "all", "summaries", "quiet"]) {
    for (const limit of [2, 30]) {
      add("pageOf", list, { tab, limit }, needs);
      add("pageOf", list, { tab, limit, before: { at: list[2].at, id: "m7" } }, needs);
      add("pageOf", list, { tab, limit, before: { at: new Date(now - 2.5 * H).toISOString(), id: "gone" } }, needs);
      add("pageOf", list, { tab, limit, after: { at: list[5].at, id: "m4" } }, needs);
      add("pageOf", list, { tab, limit, after: { at: new Date(now - 4.5 * H).toISOString(), id: "gone" } }, needs);
    }
    for (const m of [list[0], list[3], list[4], list[7]]) add("nearOf", list, m, tab, needs, "m6,m2");
  }
  add("needsShown", list, needs);
  add("needsShown", list, ["m8", "m7", "m9"]);
  add("needsYouIds", list, { "p/t_1|review": "p/t_1|review", "p/t_2|review": "p/t_2|review" });
  const many = Array.from({ length: 520 }, (_, i) => msg(`k${i}`, now - i * H, i % 3 ? "direct" : "routine", "x", [], i % 3 ? {} : { held: true }));
  add("trimMessages", many.slice().reverse(), now);
  // Wait records.
  add("normalizeRecords", { "p/t|review": { board: "p", ticketId: "t", extra: 1, reminders: [{ channel: "mac", dueAt: "d" }, { channel: 1 }, null] }, bad: null, nob: { ticketId: "t" }, "p/u|q:1": { board: "p", ticketId: "u", kind: "questions", since: "", queuedAt: "2026-11-17T10:00:00.000Z", toldAt: 5, closedAt: "c" } });
  for (const q of ["Which one?", "  which   ONE? ", "Ünïcode ÄÖ question", ""]) add("questionHash", q);
  for (const [k, q] of [["questions", "Which?"], ["questions", null], ["message", "hello"], ["review", "x"], ["message", ""]] as const) add("waitIdentity", k, q);
  const wr = (key: string, queuedH: number, extra: Record<string, unknown> = {}) => ({ key, board: "p", ticketId: "t", kind: "review", question: "", label: "", since: "s", queuedAt: new Date(now - queuedH * H).toISOString(), toldAt: null, toldVia: null, fallbackAt: null, digestAt: null, reminders: [], closedAt: null, ...extra });
  const all = [wr("p/t|review", 1), wr("p/t|review#s1", 5, { messageId: "m_old" }), wr("p/t|review#s2", 3, { reminders: [{ channel: "mac", dueAt: "d", messageId: "m_rem" }] }), wr("p/t|other", 2)];
  for (const [id, atH] of [["m_old", 0], ["m_rem", 0], ["m_new", 0.5], ["m_new", 4], ["m_new", 10]] as const) add("recordForMessage", all, "p/t|review", { id, at: new Date(now - atH * H).toISOString() });
  // Notify settings as read from the file.
  for (const raw of [
    null, {}, { webhookUrl: " https://ntfy.sh/x ", format: "ntfy", mac: false, kinds: { reply: true, review: "no", bogus: true }, helper: false },
    { webhookUrl: "ftp://x" }, { webhookUrl: "not a url" },
    { telegram: { on: true, token: " 123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234 ", chatId: 42, chatName: "x".repeat(130), pairedAt: "p", lockedAt: "l", briefedAt: "b", deskCapUsd: 3.456, frontDesk: "my-board", takeMessages: false, askTyped: false } },
    { telegram: { deskCapUsd: 500, frontDesk: "Bad Board", chatId: 1.5 } }, { telegram: { deskCapUsd: -1, frontDesk: null } },
  ]) add("normalizeSettings", raw);
  // Store scripts: the files' bytes after each step.
  const nw = (ticketId: string, identity: string, extra: Record<string, unknown> = {}) => ({ board: "p", ticketId, kind: "review", identity, question: "Ready?", label: "Ready for review", since: "2026-11-17T09:00:00.000Z", ...extra });
  add("storeScript", "waits", [
    { op: "add", w: nw("t1", "review") },
    { op: "add", w: nw("t2", "q:abc", { kind: "questions", urgent: true, why: "money" }), advance: 1000 },
    { op: "add", w: nw("t1", "review", { urgent: true, why: "late" }) },
    { op: "notifyUser", board: "p", ticketId: "t1", advance: 500 },
    { op: "markTold", keys: ["p/t1|review"], via: "helper", messageId: "m_x" },
    { op: "update", key: "p/t2|q:abc", patch: { reminders: [{ channel: "push", dueAt: "2026-11-17T10:00:01.000Z", sentAt: "2026-11-17T10:00:01.000Z", messageId: "m_y" }, { channel: "mac", dueAt: "2026-11-17T10:05:00.000Z" }], remindUntil: "2026-11-17T12:00:00.000Z", stepsUsed: 0 } },
    { op: "stop", key: "p/t2|q:abc", why: "got-it", advance: 2000 },
    { op: "unclaim", prev: [{ key: "p/t1|review", toldAt: null, toldVia: null, fallbackAt: "f", digestAt: "d" }] },
    { op: "opened", board: "p", ticketId: "t1" },
    { op: "close", keys: ["p/t1|review", "p/t2|q:abc"], why: "answered", advance: 60_000 },
    { op: "add", w: nw("t1", "review"), advance: 1000 },
    { op: "add", w: nw("t3", "message", { kind: "message" }), o: { seeded: true } },
    { op: "add", w: nw("t4", "review"), o: { told: "restart" } },
    { op: "opened", board: "p", ticketId: "t3" },
    { op: "rekey", from: "p/t4|review", w: nw("t4", "q:new", { kind: "questions", question: "New?" }) },
    { op: "first", v: true },
    { op: "first", v: false },
    { op: "add", w: nw("t5", "review"), advance: 8 * 24 * H },
  ]);
  add("storeScript", "messages", [
    { op: "madd", m: { level: "urgent", oneLine: "one", text: "full", items: [item("Docs")] } },
    { op: "madd", m: { level: "summary", oneLine: "two", text: "t2", why: "w", summary: { new: [], still: [] }, nightAsk: true, heldOvernight: "Held overnight: x" }, advance: 1000 },
    { op: "madd", m: { level: "routine", oneLine: "held", text: "h", held: true, practice: true } },
    { op: "msends", id: "m_1", sends: [{ channel: "push", at: "a", ok: true, devices: 2, error: null }] },
    { op: "mtap", id: "m_1", how: "got-it", advance: 500 },
    { op: "mread", id: "m_2" },
    { op: "madd", m: { level: "direct", oneLine: "three", text: "t3" } },
    { op: "mreadall", advance: 100 },
  ]);
  return out;
}

function bunAnswers(list: { fn: string; args: unknown[] }[]): string[] {
  const p = Bun.spawnSync(["bun", RUNNER], { stdin: Buffer.from(JSON.stringify(list)), env: { ...process.env, TZ } });
  if (p.exitCode !== 0) throw new Error(`fixture runner failed: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

describe("Rust helper fixtures: Bun gives the answers they record", () => {
  test("every case", () => {
    const list = cases();
    const answers = bunAnswers(list);
    const doc = { tz: TZ, cases: list.map((c, i) => ({ ...c, expect: answers[i] })) };
    // One case per line: small diffs, a file that stays readable.
    const text = `{"tz":${JSON.stringify(TZ)},"cases":[\n${doc.cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;
    if (UPDATE) {
      writeFileSync(FILE, text);
      return;
    }
    const was = JSON.parse(readFileSync(FILE, "utf8"));
    expect(was.cases.length).toBe(doc.cases.length);
    for (let i = 0; i < doc.cases.length; i++) {
      expect({ i, fn: doc.cases[i].fn, got: doc.cases[i].expect }).toEqual({ i, fn: was.cases[i].fn, got: was.cases[i].expect });
    }
  }, 60_000);
});
