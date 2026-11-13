import { describe, expect, test } from "bun:test";
import { directLabel } from "../src/server/helper/core";
import { lastNightEnd, SUMMARY_GAP_MS, summaryAllowedAt } from "../src/server/helper/decide";
import { buildSummary, collapseRuns, STALE_MS, titleStem, type SummaryInput } from "../src/server/helper/summary";

const DAY = (h: number, m = 0, d = 9) => new Date(2026, 10, d, h, m).getTime();
const NIGHT = { start: "22:00", end: "07:00" };
const iso = (ms: number) => new Date(ms).toISOString();
const item = (o: Partial<SummaryInput> & { ticketId: string; title: string }): SummaryInput => ({
  key: `kanban/${o.ticketId}|review`, board: "kanban", boardName: "kanban", label: "Ready for review", since: iso(DAY(10)), ...o,
});

describe("summary text", () => {
  test("runs of one repeating schedule merge into one row; other titles stay", () => {
    expect(titleStem("Product Hunt replies 2026-11-09 10:20")).toBe("Product Hunt replies");
    expect(titleStem("Plan posts 2026-11-09")).toBe("Plan posts");
    expect(titleStem("Docs")).toBeNull();
    const rows = collapseRuns([
      item({ ticketId: "a", title: "Product Hunt replies 2026-11-09 08:20", since: iso(DAY(8, 21)) }),
      item({ ticketId: "p", title: "Plan posts 2026-11-09", label: "Post #018, Tue 10 Nov 21:00" }),
      item({ ticketId: "b", title: "Product Hunt replies 2026-11-09 09:20", since: iso(DAY(9, 21)) }),
      item({ ticketId: "c", title: "Product Hunt replies 2026-11-09 10:20", since: iso(DAY(10, 21)) }),
    ]);
    expect(rows.map((r) => [r.title, r.label, r.ticketId, r.count])).toEqual([
      ["Product Hunt replies", "3 runs ready for review", "c", 3],
      ["Plan posts 2026-11-09", "Post #018, Tue 10 Nov 21:00", "p", undefined],
    ]);
    // Different needs: counted, not described.
    expect(collapseRuns([item({ ticketId: "a", title: "X 2026-11-09" }), item({ ticketId: "b", title: "X 2026-11-10", label: "Answer Claude" })])[0].label).toBe("2 runs wait on you");
  });

  test("new rows only, still waiting counted in one line, items older than 3 days counted, no links, no why", () => {
    const now = DAY(11, 22);
    const { text, view } = buildSummary({
      headline: "4 wait on you: new review",
      fresh: [item({ ticketId: "n", title: "Docs", label: "Which tone?" }), item({ ticketId: "o", title: "Old", since: iso(now - STALE_MS - 1) })],
      still: [item({ ticketId: "s1", title: "S1", since: iso(new Date(2026, 9, 12, 9).getTime()) }), item({ ticketId: "s2", title: "S2" })],
      checkins: [], olderCheckins: 0, notes: [], boards: false, now,
    });
    expect(text).toBe("4 wait on you: new review\n\n- Docs: Which tone?\n\n1 more still waits on you, oldest from 9 Nov.\n+2 older in Inbox");
    expect(text).not.toContain("http");
    expect(view.new.map((r) => r.ticketId)).toEqual(["n"]);
    // Older than 3 days: counted only, never listed (they stay in the Inbox).
    expect(view.still.map((r) => r.ticketId)).toEqual(["s2"]);
    expect(view).toMatchObject({ stillCount: 1, olderCount: 2, oldestAt: iso(DAY(10)), grouped: false });
  });

  test("only older waits besides the new ones: no still line, just '+N older in Inbox'", () => {
    const now = DAY(11, 22);
    const old = (id: string) => item({ ticketId: id, title: id, since: iso(now - STALE_MS - 3600_000) });
    const { text, view } = buildSummary({
      headline: "1 new for you: copy question",
      fresh: [item({ ticketId: "n", title: "Pricing", label: "Approve the copy?" })],
      still: Array.from({ length: 17 }, (_, i) => old(`o${i}`)),
      checkins: [], olderCheckins: 0, notes: [], boards: false, now,
    });
    expect(text).toBe("1 new for you: copy question\n\n- Pricing: Approve the copy?\n\n+17 older in Inbox");
    expect(view).toMatchObject({ stillCount: 0, still: [], olderCount: 17, oldestAt: null });
  });

  test("two or more boards: rows under a board heading, not a board name on every row", () => {
    const { text } = buildSummary({
      headline: "3 wait on you: two reviews",
      fresh: [
        item({ ticketId: "a", title: "Incident", board: "rb", boardName: "rocketbots" }),
        item({ ticketId: "b", title: "Docs" }),
        item({ ticketId: "c", title: "Hotfix", board: "rb", boardName: "rocketbots" }),
      ],
      still: [], checkins: [], olderCheckins: 0, notes: ["This is your first summary."], boards: true, now: DAY(12),
    });
    expect(text).toBe("3 wait on you: two reviews\n\nrocketbots\n- Incident: Ready for review\n- Hotfix: Ready for review\n\nkanban\n- Docs: Ready for review\n\nThis is your first summary.");
  });

  test("a question's label is its first line, with no '(+N more)'", () => {
    expect(directLabel({ kind: "questions", question: "Post #018?\nline 2\nline 3", label: "Answer 1 question" })).toBe("Post #018?");
  });
});

describe("summary cadence", () => {
  test("at most one routine summary every 3 hours in the daytime; the morning one is never held", () => {
    expect(summaryAllowedAt(null, DAY(10), NIGHT)).toBeNull();
    expect(summaryAllowedAt(DAY(10), DAY(11), NIGHT)).toBe(DAY(10) + SUMMARY_GAP_MS);
    expect(summaryAllowedAt(DAY(10), DAY(13), NIGHT)).toBeNull();
    // Last one at 21:00, now 7:30 the next morning (inside 3 hours of nothing, but a night ended): allowed.
    expect(lastNightEnd(DAY(7, 30, 10), NIGHT)).toBe(DAY(7, 0, 10));
    expect(lastNightEnd(DAY(6, 0, 10), NIGHT)).toBe(DAY(7, 0, 9));
    expect(summaryAllowedAt(DAY(6, 50, 10), DAY(7, 30, 10), NIGHT)).toBeNull();
    expect(summaryAllowedAt(DAY(7, 10, 10), DAY(7, 30, 10), NIGHT)).toBe(DAY(10, 10, 10));
    // No night set: just the gap.
    expect(summaryAllowedAt(DAY(10), DAY(11), { start: "00:00", end: "00:00" })).toBe(DAY(13));
  });
});

describe("message page words", () => {
  test("board links on their own line are left out of the page; other text stays", async () => {
    const { withoutLinks, stillWaitingLine } = await import("../web/src/helperText");
    const old = "Pricing\nStop it?\nhttps://mac.ts.net/#/kb/t_1\n\n- Docs (kanban): Ready\n  https://mac.ts.net/#/kanban/t_2\n\nSee https://ckanban.dev for more";
    expect(withoutLinks(old)).toBe("Pricing\nStop it?\n\n- Docs (kanban): Ready\n\nSee https://ckanban.dev for more");
    expect(stillWaitingLine({ stillCount: 27, oldestAt: new Date(2026, 9, 12).toISOString(), new: [{} as any] })).toBe("27 more still wait on you, oldest from 12 Oct.");
  });
});

describe("Inbox snooze lengths", () => {
  test("a week and until-unsnoozed ends, and how the Snoozed section says them", async () => {
    const { snoozeUntil, snoozeBody, snoozeEndText, snoozeForever, SNOOZE_FOREVER } = await import("../web/src/snooze");
    const { SNOOZE_FOREVER: server } = await import("../src/server/attention");
    expect(SNOOZE_FOREVER).toBe(server);
    const now = new Date(2026, 10, 9, 12).getTime();
    expect(snoozeUntil("day", now)).toBe(new Date(now + 24 * 3600_000).toISOString());
    expect(snoozeUntil("week", now)).toBe(new Date(now + 7 * 24 * 3600_000).toISOString());
    expect(snoozeUntil("forever", now)).toBe(SNOOZE_FOREVER);
    expect([snoozeBody("day"), snoozeBody("week"), snoozeBody("forever")]).toEqual([{}, { hours: 168 }, { forever: true }]);
    expect(snoozeForever(SNOOZE_FOREVER)).toBe(true);
    expect(snoozeEndText(SNOOZE_FOREVER, now)).toBe("until you unsnooze");
    expect(snoozeEndText(snoozeUntil("week", now), now)).toBe("until 16 Nov");
    expect(snoozeEndText(new Date(Date.now() + 5 * 3600_000).toISOString())).toBe("back in 5h");
  });
});
