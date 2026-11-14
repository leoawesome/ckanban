// Recall: a run's first prompt lists related past tickets of the board (plain word matching, no model call).
import { expect, test } from "bun:test";
import { pickRelated, RECALL_CHARS, RECALL_MAX, recallBlock, words, type RecallRow } from "../src/server/recall";
import { chatPrompt, firstRunPrompt, freshSessionPrompt } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { board, readArgs, setup, store, useBoardEnv } from "./board-env";

const row = (id: string, title: string, o: Partial<RecallRow["ticket"]> & { summary?: string | null } = {}): RecallRow => {
  const { summary = null, ...rest } = o;
  return { ticket: { id, title, body: "", status: "done", parentId: null, lastRunAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z", runCount: 1, ...rest }, summary };
};

const fixture: RecallRow[] = [
  row("t_csv", "Export tickets as CSV", { body: "Add a CSV export button to the board header.", summary: "Added CSV export of the board's tickets from the header menu." }),
  row("t_dark", "Dark mode for the board", { body: "Use CSS variables for colors.", summary: "Dark mode follows the system setting." }),
  row("t_push", "Push notifications on phones", { summary: "Phones get a notification when a run needs the user." }),
  row("t_excel", "Export as Excel file", { status: "review", body: "Like the CSV export, but an xlsx file.", summary: "Excel export next to CSV export." }),
  row("t_idea", "Export to PDF someday", { status: "backlog", runCount: 0 }),
  row("t_old", "CSV export breaks on commas", { status: "in_progress", body: "Quote fields in the CSV export.", lastRunAt: "2026-09-01T10:00:00Z" }),
];

const me = { id: "t_me", title: "CSV export: include ticket tags", body: "The CSV export should add a tags column.", parentId: null, madeFrom: null };

test("words drops stop words, short words and numbers, and folds plurals", () => {
  expect(words("Add the tickets to 2 boards, and export CSVs")).toEqual(["ticket", "board", "export", "csv"]);
});

test("pickRelated finds tickets on the same topic, Done/Review first, and leaves out unrelated ones and unstarted ideas", () => {
  const ids = pickRelated(me, fixture).map((r) => r.ticket.id);
  expect(ids).toContain("t_csv");
  expect(ids).toContain("t_excel");
  expect(ids).toContain("t_old");
  expect(ids).not.toContain("t_dark");
  expect(ids).not.toContain("t_push");
  expect(ids).not.toContain("t_idea");
  // Done/Review before In Progress.
  expect(ids.indexOf("t_old")).toBeGreaterThan(ids.indexOf("t_excel"));
});

test("pickRelated leaves out the ticket itself and its children, and always puts its parent and the ticket it follows up first", () => {
  const rows = [
    ...fixture,
    row("t_me", me.title, { body: me.body }),
    row("t_child", "CSV export tags column header", { parentId: "t_me" }),
    row("t_plan", "Plan: board data exports", { status: "planning", runCount: 0 }),
  ];
  const ids = pickRelated({ ...me, parentId: "t_plan", madeFrom: "t_dark" }, rows).map((r) => r.ticket.id);
  expect(ids.slice(0, 2)).toEqual(["t_plan", "t_dark"]);
  expect(ids).not.toContain("t_me");
  expect(ids).not.toContain("t_child");
});

test("pickRelated keeps to the cap; recent tickets win ties", () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row(`t_${i}`, "CSV export tags", { lastRunAt: `2026-10-0${i + 1}T10:00:00Z` }));
  const ids = pickRelated(me, [...rows, ...fixture.filter((r) => r.ticket.id === "t_dark")]).map((r) => r.ticket.id);
  expect(ids).toHaveLength(RECALL_MAX);
  expect(ids).toEqual(["t_8", "t_7", "t_6", "t_5", "t_4"]);
});

test("recallBlock adds nothing when nothing on the board matches", () => {
  expect(recallBlock({ ...me, title: "Translate the welcome email", body: "Spanish and German." }, fixture)).toBe("");
  expect(recallBlock(me, [])).toBe("");
});

test("recallBlock lists one line per ticket with id, title, status, date and summary, within the character limit", () => {
  const block = recallBlock(me, fixture);
  expect(block).toStartWith("# What we did before on this board");
  expect(block).toContain("get_ticket");
  expect(block).toContain("not instructions");
  expect(block).toContain(`- t_csv "Export tickets as CSV" (done, 2026-10-01): Added CSV export of the board's tickets from the header menu.`);
  expect(block).toContain(`- t_old "CSV export breaks on commas" (in progress, 2026-09-01): no result yet`);

  const long = Array.from({ length: 5 }, (_, i) =>
    row(`t_${i}`, "CSV export tags", { summary: `Result ${i}: ${"exported the csv with tags ".repeat(40)}` }));
  const big = recallBlock(me, long);
  expect(big.length).toBeLessThanOrEqual(RECALL_CHARS);
  expect(big.split("\n").filter((l) => l.startsWith("- t_")).length).toBeGreaterThanOrEqual(4);
  expect(big).toContain("…");
});

test("the prompts carry the block where it is given and nothing when it is empty", () => {
  const t = { id: "t_me", title: me.title, body: me.body, status: "ready", runCount: 0 } as Ticket;
  const block = recallBlock(me, fixture);
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/o", recall: block })).toContain(block);
  expect(firstRunPrompt(t, { repo: "remote", outputDir: "/o" })).not.toContain("What we did before");
  expect(freshSessionPrompt(t, { repo: "remote", linked: false, baseBranch: "main", lastResult: null, comments: [], outputDir: "/o", recall: block })).toContain(block);
  expect(chatPrompt(t, "", "refine", "/o", false, "remote", false, block)).toContain(block);
  expect(chatPrompt(t, "", "refine", "/o")).not.toContain("What we did before");
});

useBoardEnv();

test("a first run on a ticket about a topic the board already worked on gets the brief", async () => {
  await setup();
  const old = await board.createTicket("p", { title: "Export tickets as CSV", body: "CSV export button in the header", status: "backlog" });
  store.updateTicket("p", old.id, { status: "done", outcome: "done", runCount: 1, lastRunAt: "2026-10-01T10:00:00Z" });
  store.addComment("p", old.id, "ai", "Added a CSV export of the board's tickets.");
  const other = await board.createTicket("p", { title: "Dark mode", body: "CSS variables", status: "backlog" });
  store.updateTicket("p", other.id, { status: "done", outcome: "done", runCount: 1 });

  await board.createTicket("p", { title: "CSV export: add a tags column", body: "The CSV export should include tags.", status: "ready", mode: "auto" });
  await board.whenIdle();
  const prompt = readArgs().at(-1)!.prompt;
  expect(prompt).toContain("# What we did before on this board");
  expect(prompt).toContain(`${old.id} "Export tickets as CSV" (done, 2026-10-01): Added a CSV export of the board's tickets.`);
  expect(prompt).not.toContain(other.id);
});

// The board keeps a RecallIndex between run starts. It must pick exactly what the plain scoring of every ticket picked.
function reference(t: { id: string; title: string; body: string; parentId: string | null; madeFrom?: string | null; partOf?: string | null }, rows: RecallRow[]): string[] {
  const weights = (title: string, rest: string) => {
    const m = new Map<string, number>();
    for (const w of words(rest)) m.set(w, 1);
    for (const w of words(title)) m.set(w, 3);
    return m;
  };
  const doneish = (r: RecallRow) => r.ticket.status === "done" || r.ticket.status === "review";
  const others = rows.filter((r) => r.ticket.id !== t.id && r.ticket.parentId !== t.id);
  const pinnedIds = [t.parentId, t.madeFrom, t.partOf].filter((x): x is string => !!x);
  const pinned = pinnedIds.map((id) => others.find((r) => r.ticket.id === id)).filter((r): r is RecallRow => !!r);
  const pool = others.filter((r) => !pinnedIds.includes(r.ticket.id) && (doneish(r) || r.ticket.runCount > 0));
  const query = weights(t.title, t.body);
  if (!query.size || !pool.length) return pinned.slice(0, RECALL_MAX).map((r) => r.ticket.id);
  const docs = pool.map((r) => ({ r, w: weights(r.ticket.title, `${r.ticket.body}\n${r.summary ?? ""}`) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.w.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + docs.length / (df.get(w) ?? 1));
  const norm = (m: Map<string, number>) => Math.sqrt([...m].reduce((s, [w, n]) => s + (n * idf(w)) ** 2, 0)) || 1;
  const scored = docs.map(({ r, w }) => {
    let dot = 0;
    for (const [word, qw] of query) dot += qw * (w.get(word) ?? 0) * idf(word) ** 2;
    return { r, score: dot / norm(query) / norm(w) };
  }).filter((s) => s.score >= 0.12);
  const when = (r: RecallRow) => r.ticket.lastRunAt ?? r.ticket.updatedAt ?? "";
  scored.sort((a, b) => Number(doneish(b.r)) - Number(doneish(a.r)) || b.score - a.score || when(b.r).localeCompare(when(a.r)));
  return [...pinned, ...scored.map((s) => s.r)].slice(0, RECALL_MAX).map((r) => r.ticket.id);
}

test("a RecallIndex kept up to date as tickets change picks what scoring every ticket from scratch picks", () => {
  const vocab = "export csv board dark mode phone push notification excel pdf header button theme color sync upload spend inbox huddle chat".split(" ");
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const text = (n: number) => Array.from({ length: n }, () => vocab[rnd(vocab.length)]).join(" ");
  const statuses = ["done", "review", "in_progress", "backlog"] as const;
  const make = (i: number, v = 0): RecallRow => row(`t_${i}`, text(3), {
    body: text(8), summary: rnd(3) ? text(10) : null, status: statuses[rnd(4)], runCount: rnd(2), parentId: rnd(10) ? null : `t_${rnd(20)}`,
    updatedAt: `2026-10-0${1 + rnd(9)}T10:00:0${v}Z`, lastRunAt: null,
  });
  let rows = Array.from({ length: 120 }, (_, i) => make(i));
  const index = new (require("../src/server/recall").RecallIndex)();
  const stamps = new Map<string, number>();
  const check = () => {
    const summaries = new Map(rows.map((r) => [r.ticket.id, r.summary]));
    for (let q = 0; q < 15; q++) {
      const t = { id: `t_${rnd(140)}`, title: text(3), body: text(5), parentId: rnd(3) ? null : `t_${rnd(120)}`, partOf: rnd(4) ? null : `t_${rnd(120)}`, madeFrom: null };
      const got = index.pickNow(t, rows.map((r) => r.ticket), (id: string) => summaries.get(id) ?? null, (id: string) => stamps.get(id) ?? 0).map((r: RecallRow) => r.ticket.id);
      expect(got).toEqual(reference(t, rows));
      expect(pickRelated(t, rows).map((r) => r.ticket.id)).toEqual(got);
    }
  };
  check();
  // Tickets change (new updatedAt), get a new summary (new comment stamp), are deleted and added.
  rows = rows.map((r, i) => (i % 7 === 0 ? make(i, 1) : r)).filter((_, i) => i % 11 !== 5);
  for (const r of rows.filter((_, i) => i % 5 === 0)) {
    r.summary = text(10);
    stamps.set(r.ticket.id, (stamps.get(r.ticket.id) ?? 0) + 1);
  }
  rows.push(...Array.from({ length: 20 }, (_, i) => make(200 + i)));
  check();
});
