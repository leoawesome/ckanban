import { expect, test } from "bun:test";
import { answers, marksDone } from "../web/src/inboxOrder";

const item = (kind: string) => ({ profile: "demo", profileName: "Demo", id: kind, title: kind, attention: { kind: kind as "review", label: kind, since: "2026-11-01T12:00:00.000Z" } });

test("review items' one button is Mark done; the rest answer or open", () => {
  expect(marksDone(item("review"))).toBe(true);
  for (const k of ["questions", "proposal", "reply", "huddle", "failed", "blocked"]) expect(marksDone(item(k))).toBe(false);
  expect(answers(item("questions"))).toBe(true);
  expect(answers(item("failed"))).toBe(false);
});
