import { expect, test } from "bun:test";
import { freezeAlarm, freezeCulprit } from "../src/server/lag";

const line = (ran: string) => `[lag] event loop blocked 9852ms at 2026-11-13T15:32:16.630Z (up 131s); ran: ${ran}; rss 816MB heap 86MB`;

test("the freeze alarm names what ran, waits for 2s freezes, and sends at most one per half hour", () => {
  let now = 0;
  const sent: { title: string; body: string }[] = [];
  const alarm = freezeAlarm({ now: () => now, send: (title, body) => sent.push({ title, body }) });
  alarm(1500, line("session-watcher 1500ms"));
  expect(sent).toEqual([]);
  alarm(9852, line("learner 9800ms, GET /api/spend 30ms"));
  expect(sent).toEqual([{ title: "Board froze for 9.9s", body: "During: learner 9800ms, GET /api/spend 30ms. Details in daemon.log ([lag] lines)." }]);
  now += 10 * 60_000;
  alarm(3000, line("session-watcher 3000ms"));
  alarm(2500, line("nothing tracked (GC or untracked work)"));
  expect(sent.length).toBe(1);
  now += 25 * 60_000;
  alarm(2100, line("nothing tracked (GC or untracked work)"));
  expect(sent[1]).toEqual({
    title: "Board froze for 2.1s",
    body: "During: untracked work (memory clean-up or a job without track()) (and 2 more since the last alert). Details in daemon.log ([lag] lines).",
  });
});

test("freezeCulprit reads the ran part of a lag line", () => {
  expect(freezeCulprit(line("terminal-watcher 5026ms (async)"))).toBe("terminal-watcher 5026ms (async)");
  expect(freezeCulprit("[lag] event loop blocked 300ms")).toContain("untracked work");
});
