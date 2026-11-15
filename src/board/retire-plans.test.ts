// The one-time migration that retires planned tickets: old planners become main tickets, their children tool tickets.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { kindFromTitle, retireOldPlans, retirePlanPatches } from "./retire-plans";
import { Store } from "../core/store";
import type { Ticket } from "../core/types";
import { tempDir } from "../../test/support/helpers";

const T = (id: string, extra: Partial<Ticket> = {}) => ({ id, title: id, body: "", status: "backlog", createdAt: "2026-11-01T00:00:00Z", ...extra }) as Ticket;
const byId = (ps: ReturnType<typeof retirePlanPatches>) => Object.fromEntries(ps.map((p) => [p.id, p.patch]));

test("kindFromTitle: explore and review only when the title clearly says so, else build", () => {
  expect(kindFromTitle("Explore the API")).toBe("explore");
  expect(kindFromTitle("investigate slow loads")).toBe("explore");
  expect(kindFromTitle("Research: schedules")).toBe("explore");
  expect(kindFromTitle("Review the docs")).toBe("review");
  expect(kindFromTitle("Add a reviewer role")).toBe("build");
  expect(kindFromTitle("Reviewer prompt")).toBe("build");
});

test("an old planner becomes a main ticket and its children tool tickets; nothing else changes", () => {
  const ps = byId(retirePlanPatches([
    T("p", { status: "review", plan: { state: "running" } as Ticket["plan"] }),
    T("a", { parentId: "p", status: "done", dependsOn: ["b"] }),
    T("b", { parentId: "p", title: "Review the copy", status: "in_progress" }),
    T("c", { parentId: "p", kind: "test" }),
    T("lone"),
  ]));
  expect(ps).toEqual({ p: { main: true }, a: { tool: true, kind: "build" }, b: { tool: true, kind: "review" }, c: { tool: true, kind: "test" } });
});

test("main tickets, tool tickets, sub-features and their families are left alone", () => {
  expect(retirePlanPatches([
    T("m", { main: true }), T("t1", { parentId: "m", tool: true }), T("old", { parentId: "m" }),
    T("g", { parentId: "m", tool: true, kind: "group" }), T("t2", { parentId: "g", tool: true }),
    T("sub", { main: true, partOf: "m" }), T("tb", { tool: true }), T("tk", { parentId: "tb" }),
    T("p"), T("s", { parentId: "p", main: true }),
  ])).toEqual([]);
});

test("a plan inside a plan becomes a group tool ticket; its children become its tool tickets", () => {
  const ps = byId(retirePlanPatches([T("p"), T("q", { parentId: "p", status: "done" }), T("x", { parentId: "q", status: "done", title: "Explore x" })]));
  expect(ps).toEqual({ p: { main: true }, q: { tool: true, kind: "group" }, x: { tool: true, kind: "explore" } });
});

test("Backlog children of a plan that isn't under way wait to be started; a running, paused or stuck plan keeps starting its own", () => {
  for (const state of [undefined, "done"] as const) {
    const ps = byId(retirePlanPatches([T("p", state ? { plan: { state } as Ticket["plan"] } : {}), T("a", { parentId: "p" }), T("d", { parentId: "p", status: "done" })]));
    expect(ps.a).toEqual({ tool: true, kind: "build", waitsForStart: true });
    expect(ps.d).toEqual({ tool: true, kind: "build" });
  }
  for (const state of ["running", "paused", "stuck"] as const) {
    const ps = byId(retirePlanPatches([T("p", { plan: { state } as Ticket["plan"] }), T("a", { parentId: "p" })]));
    expect(ps.a).toEqual({ tool: true, kind: "build" });
  }
});

test("retireOldPlans writes only the flags, keeps unknown fields and updatedAt, and a second pass changes nothing", async () => {
  const store = new Store(tempDir("ck-retire-"));
  store.saveProfile({ name: "B", slug: "b", path: tempDir("ck-retire-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  const p = store.createTicket("b", { title: "Planner", body: "Plan body", status: "review" });
  const k = store.createTicket("b", { title: "Investigate it", body: "Kid body", status: "done", parentId: p.id });
  // A field this version doesn't know (written by a newer or older version) must survive.
  const file = store.ticketPath("b", k.id);
  writeFileSync(file, readFileSync(file, "utf8").replace("---\n", "---\nfutureField: keep me\n"));
  const before = readFileSync(file, "utf8");
  const quiet = () => Promise.resolve();
  const fresh = async () => {
    const s = new Store(store.root);
    await s.loadAllTickets();
    return s;
  };
  expect(await retireOldPlans(await fresh(), quiet)).toEqual({ b: 2 });
  const after = readFileSync(file, "utf8");
  expect(after).toContain("futureField: keep me");
  expect(after.split("\n").filter((l) => !before.includes(l))).toEqual(["tool: true", "kind: explore"]);
  const s = await fresh();
  expect(s.getTicket("b", p.id)).toMatchObject({ main: true, body: "Plan body", status: "review", updatedAt: p.updatedAt });
  expect(s.getTicket("b", k.id)).toMatchObject({ tool: true, kind: "explore", parentId: p.id, body: "Kid body", status: "done" });
  expect(s.listComments("b", p.id).at(-1)?.text).toContain("main ticket");
  expect(await retireOldPlans(s, quiet)).toEqual({});
  expect(readFileSync(file, "utf8")).toBe(after);
});
