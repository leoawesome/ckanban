// The Rust Telegram's shared fixtures (rust/board/tests/fixtures/telegram.json): inputs for Telegram's and the front
// desk's pure text rules (cuts, the token scrub, forwarded senders, report parts, form texts, which front desk
// requests are held, the day's chat), with Bun's answer in `expect`, worked out in the time zone the file names. This
// test checks Bun still gives exactly those answers; `cargo test -p ckanban-board --test telegram` checks Rust does.
// After a deliberate change to Bun's code: `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-telegram-fixtures.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "telegram.json");
const RUNNER = resolve(import.meta.dir, "support", "rust-telegram-cases.ts");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const TZ = "America/Los_Angeles";
const H = 3600_000;
const DAYS = ["2026-03-07T12:00:00-08:00", "2026-03-08T12:00:00-07:00", "2026-11-01T12:00:00-08:00", "2026-11-17T12:00:00-08:00"].map(Date.parse);
const TOKEN = "123456789:AAHabcdefghijklmnopqrstuvwxyz012345";

function cases(): { fn: string; args: unknown[] }[] {
  const out: { fn: string; args: unknown[] }[] = [];
  const add = (fn: string, ...args: unknown[]) => out.push({ fn, args });
  for (const t of [`fetch failed: https://api.telegram.org/bot${TOKEN}/getUpdates`, "bot12345:abcdefghijklmnopqrstuvwxyz and bot1:x", "plain", `${TOKEN} twice ${TOKEN}`]) for (const k of [TOKEN, ""]) add("scrub", t, k);
  for (const t of [TOKEN, "", "abc"]) add("maskToken", t);
  for (const [b, tail] of [["short", ""], ["x".repeat(5000), "\n\nAnswer on your Mac."], [`${"y".repeat(4094)}👍🏽z`, ""], ["a".repeat(4096), ""], ["a".repeat(4097), "tail"]]) add("telegramText", b, tail);
  for (const t of ["/lock", " /LOCK@my_bot now", "/locked", "lock", "/lock@", null, 5, "", "/waiting"]) add("isLock", t);
  for (const m of [
    { text: "x" },
    { forward_origin: { type: "user", sender_user: { first_name: "Ann", last_name: "Lee", username: "ann" } } },
    { forward_origin: { type: "user", sender_user: { username: "only_user" } } },
    { forward_origin: { type: "hidden_user", sender_user_name: "Hidden Person" } },
    { forward_origin: { type: "chat", sender_chat: { title: "A group" } } },
    { forward_origin: { type: "channel", chat: { title: "News" } } },
    { forward_origin: { type: "hidden_user" } },
    { forward_from: { first_name: "Old", last_name: "" } },
    { forward_sender_name: "Legacy" },
    { forward_from_chat: { title: "Chan" } },
    { forward_origin: { type: "user", sender_user: { first_name: "N".repeat(100) } } },
  ]) add("forwardedFrom", m);
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i} ${"words ".repeat(20)}`).join("\n");
  for (const [head, text] of [["Fix login (Kanban):", "Done.\nCKANBAN_RESULT: {\"status\":\"done\"}"], ["H:", "a\n\n\n\nb"], ["", ""], ["", "CKANBAN_RESULT: x"], ["T (B):", long], ["", "z".repeat(9000)], ["", `${"e".repeat(4094)}👍🏽${"f".repeat(10)}`]]) {
    for (const [parts, max, link] of [[3, 4096, null], [2, 300, "https://mac.ts.net/#/b/t"], [8, 4096, null], [1, 100, null]] as const) add("reportParts", head, text, parts, max, link);
  }
  add("cutTail", null);
  add("cutTail", "https://x/#/b");
  for (let n = 0; n <= 9; n++) add("rowsOf", Array.from({ length: n }, (_, i) => i));
  const qs = [
    { question: "Which colour?", options: [{ label: "Red", description: "Warm\n  and bold", recommended: true }, { label: "Blue" }] },
    { question: "Which sizes?", multiSelect: true, options: [{ label: "S" }, { label: "M", description: "" }, { label: "L" }] },
    { question: "Anything else?", options: [] },
  ];
  const form = (answers: unknown[]) => ({ chatId: 1, board: "b", ticketId: "t", key: "k", questions: qs, answers, msgs: [null, null, null], prompts: [], alertTg: 5 });
  const forms = [
    form([{ picked: [], other: "" }, { picked: [], other: "" }, { picked: [], other: "" }]),
    form([{ picked: ["Red"], other: "" }, { picked: ["S", "L"], other: "  " }, { picked: [], other: `typed\nanswer ${"long ".repeat(150)}` }]),
  ];
  for (const f of forms) {
    for (let i = 0; i < 3; i++) add("questionText", f, i, "❓ Kanban: \"Pick\" asks 3 questions");
    add("formMessage", f);
  }
  for (const [m, p, b] of [
    ["GET", "/api/profiles/b/tickets", null], ["POST", "/api/profiles/b/tickets", { title: "x" }], ["POST", "/api/profiles/b/tickets", { status: "backlog" }],
    ["POST", "/api/profiles/b/tickets", { status: "ready" }], ["POST", "/api/profiles/b/tickets", { main: true }], ["POST", "/api/profiles/b/tickets", { gather: ["t1"] }],
    ["POST", "/api/profiles/b/tickets", { gather: [] }], ["PATCH", "/api/profiles/b/tickets/t1", { status: "ready" }], ["PATCH", "/api/profiles/b/tickets/t1", { title: "y" }],
    ["PATCH", "/api/profiles/b/tickets/t1", ["status"]], ["DELETE", "/api/profiles/b/tickets/t1", null], ["POST", "/api/profiles/b/tickets/t1/stop", null],
    ["POST", "/api/profiles/b/tickets/t1/chat", { text: "hi" }], ["POST", "/api/profiles/b/tickets/t1/plan", null], ["POST", "/api/profiles/b/tickets/t1/comments", { text: "c" }],
    ["POST", "/api/profiles/b/tickets/t1/snooze", {}], ["POST", "/api/profiles/b//tickets//t1//stop", null], ["POST", "/api/profiles/b/%74ickets/t1/stop", null],
    ["POST", "/api/profiles/b/%E0%A4%A/x", {}], ["DELETE", "/api/profiles/b/schedules/s1", null], ["POST", "/api/profiles/b/jobs/j1/cancel", null],
    ["POST", "/api/profiles/b/schedules/s1/run", null], ["POST", "/api/profiles/b/jobs/j1/run", null], ["POST", "/api/profiles/b/schedules", { name: "n" }],
    ["PATCH", "/api/profiles/b/jobs/j1", { at: "x" }], ["PATCH", "/api/profiles/b/schedules/s1/history", {}], ["POST", "/api/notify", {}],
    ["DELETE", "/api/profiles/b", null], ["POST", "/api/profiles", { name: "x" }], ["HEAD", "/api/x", null], ["OPTIONS", "/api/x", null], ["PUT", "/api/profiles/b/tickets/t1", {}],
  ] as const) add("heldKind", m, p, b);
  for (const d of DAYS) for (const h of [0, 5, 23]) add("dayTitle", d + h * H);
  for (const d of DAYS) for (const [last, end] of [[-1, "07:00"], [-5, "07:00"], [-10, "06:15"], [-0.5, "23:00"], [-3, "bad"]] as const) {
    for (const off of [0, 2, 6, 13]) add("dayEnded", d + last * H, d + off * H, { start: "22:00", end });
  }
  add("dayEnded", Number.NaN, DAYS[0], { start: "22:00", end: "07:00" });
  for (const s of [0, 1.234, 2.5, 0.005, 10]) add("deskPaused", s);
  add("briefing", true);
  add("briefing", false);
  return out;
}

function bunAnswers(list: { fn: string; args: unknown[] }[]): string[] {
  const p = Bun.spawnSync(["bun", RUNNER], { stdin: Buffer.from(JSON.stringify(list)), env: { ...process.env, TZ } });
  if (p.exitCode !== 0) throw new Error(`fixture runner failed: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

describe("Rust Telegram fixtures: Bun gives the answers they record", () => {
  test("every case", () => {
    const list = cases();
    const answers = bunAnswers(list);
    const text = `{"tz":${JSON.stringify(TZ)},"cases":[\n${list.map((c, i) => JSON.stringify({ ...c, expect: answers[i] })).join(",\n")}\n]}\n`;
    if (UPDATE) {
      writeFileSync(FILE, text);
      return;
    }
    const was = JSON.parse(readFileSync(FILE, "utf8"));
    expect(was.cases.length).toBe(list.length);
    for (let i = 0; i < list.length; i++) expect({ i, fn: list[i].fn, got: answers[i] }).toEqual({ i, fn: was.cases[i].fn, got: was.cases[i].expect });
  }, 60_000);
});
