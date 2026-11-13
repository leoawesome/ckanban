import { expect, test } from "bun:test";
import { childrenByParent, type FamilyTicket } from "../web/src/family";

const t = (id: string, createdAt: string, link: Partial<FamilyTicket> = {}): FamilyTicket => ({ id, title: id, status: "backlog", createdAt, ...link });
const kids = (m: ReturnType<typeof childrenByParent>, id: string) => (m.get(id) ?? []).map((c) => `${c.ticket.id}:${c.how}`);

test("childrenByParent lists children oldest first and reuses its answer for the same tickets", () => {
  const top = t("top", "2026-11-01T00:00:00.000Z");
  const b = t("b", "2026-11-03T00:00:00.000Z", { partOf: "top" });
  const a = t("a", "2026-11-02T00:00:00.000Z", { parentId: "top" });
  const c = t("c", "2026-11-02T00:00:00.000Z", { partOf: "top", partOfVia: "chat" });
  const all = [top, b, a, c];
  const first = childrenByParent(all);
  expect(kids(first, "top")).toEqual(["a:plan", "c:chat", "b:linked"]);
  // A new array of the same tickets (the Store hands out copies): the same answer, not sorted again.
  expect(childrenByParent([...all])).toBe(first);
  // A ticket changed in place (the UI's tickets aren't frozen): made again.
  b.partOf = null;
  const second = childrenByParent(all);
  expect(second).not.toBe(first);
  expect(kids(second, "top")).toEqual(["a:plan", "c:chat"]);
  // Another ticket list: made again.
  expect(kids(childrenByParent([top, a]), "top")).toEqual(["a:plan"]);
  // Frozen tickets (the server's) are compared by identity alone.
  const frozen = all.map((x) => Object.freeze({ ...x }));
  const third = childrenByParent(frozen);
  expect(childrenByParent([...frozen])).toBe(third);
  expect(kids(third, "top")).toEqual(["a:plan", "c:chat"]);
});
