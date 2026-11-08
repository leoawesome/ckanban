// Follow-up work (replaces add-on tickets): a new requirement on a ticket that already ran, started from its proposal
// card. In a feature it is a step reporting to the main ticket; a ticket on its own becomes a main ticket with it as the
// first step. Old add-on links load as plain family links.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { chatPrompt, followUpRule } from "../src/server/prompts";
import { withoutAddOn } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { familyOf, levelOf, parentLink } from "../web/src/family";
import { followUpFor, followUpPlace, followUpState } from "../web/src/followUp";
import { store, board, setup, useBoardEnv } from "./board-env";

useBoardEnv();

const done = (id: string, extra: Partial<Ticket> = {}) => store.updateTicket("p", id, { status: "done", outcome: "done", runCount: 1, ...extra });

test("moving a Review/Done ticket back to Planning or Backlog remembers where it was; moving on forgets it", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Add export", body: "Export CSV", status: "backlog" });
  done(t.id);
  let u = await board.updateTicket("p", t.id, { status: "planning" });
  expect(u.reopenedFrom).toEqual({ status: "done", outcome: "done" });
  await board.whenIdle();
  u = await board.updateTicket("p", t.id, { status: "backlog" });
  expect(u.reopenedFrom).toEqual({ status: "done", outcome: "done" });
  u = await board.updateTicket("p", t.id, { status: "review" });
  expect(u.reopenedFrom).toBeNull();
});

test("case 1: follow-up on a finished ticket in a feature is a step of the main ticket, shown under that ticket", async () => {
  await setup();
  const main = await board.createTicket("p", { title: "Exports", body: "", status: "review", main: true });
  const src = await board.createTicket("p", { title: "Add export", body: "Export CSV", status: "backlog", partOf: main.id, tags: ["ui"] });
  done(src.id);
  await board.updateTicket("p", src.id, { status: "planning" });
  await board.whenIdle();
  expect(followUpPlace(store.listTickets("p"), src.id)).toEqual({ as: "step", main: { id: main.id, title: "Exports" }, manager: main.id, partOf: src.id });

  const s = await board.followUpWork("p", src.id, { title: "Export as Excel too", body: "## Objective\nFollow-up to “Add export”" });
  expect(s).toMatchObject({ tool: true, kind: "build", parentId: main.id, partOf: src.id, madeFrom: src.id, proposedAs: "Export as Excel too", tags: ["ui"], mode: "auto" });
  expect(store.getTicket("p", main.id)!.plan).toBeTruthy();
  // The finished ticket keeps its title and description, goes back to Done, and stays a plain ticket.
  const orig = store.getTicket("p", src.id)!;
  expect(orig).toMatchObject({ title: "Add export", body: "Export CSV", status: "done", outcome: "done" });
  expect(orig.main).toBeFalsy();
  // The step sits under the finished ticket in the main ticket's family.
  const rows = familyOf(store.listTickets("p"), main.id).map((r) => [r.ticket.id, r.depth]);
  expect(rows).toEqual([[main.id, 0], [src.id, 1], [s.id, 2]]);
  // A second click returns the same step, even after its run renamed it.
  store.updateTicket("p", s.id, { title: "Excel and CSV export" });
  expect((await board.followUpWork("p", src.id, { title: "Export as Excel too", body: "x" })).id).toBe(s.id);
  expect(store.listTickets("p").filter((t) => t.madeFrom === src.id).length).toBe(1);
});

test("case 1 at the deepest level: the step goes beside the finished ticket; a group above it runs it", async () => {
  await setup();
  const main = await board.createTicket("p", { title: "Exports", body: "", status: "review", main: true });
  const group = await board.createTicket("p", { title: "Formats", body: "", status: "backlog", parentId: main.id, tool: true, kind: "group" });
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog", partOf: group.id });
  done(src.id);
  expect(levelOf(store.listTickets("p"), src.id)).toBe(2);
  const s = await board.followUpWork("p", src.id, { title: "Excel too", body: "b" });
  expect(s).toMatchObject({ tool: true, parentId: group.id, madeFrom: src.id });
  expect(s.partOf).toBeUndefined();
  expect(levelOf(store.listTickets("p"), s.id)).toBe(2);

  // Under a plain ticket at level 1 (no group): run by the main ticket, beside the finished ticket.
  const plain = await board.createTicket("p", { title: "Imports", body: "", status: "backlog", partOf: main.id });
  const deep = await board.createTicket("p", { title: "CSV import", body: "", status: "backlog", partOf: plain.id });
  done(deep.id);
  const s2 = await board.followUpWork("p", deep.id, { title: "Excel import", body: "b" });
  expect(s2).toMatchObject({ parentId: main.id, partOf: plain.id, madeFrom: deep.id });
});

test("case 2: a finished ticket on its own becomes a main ticket and the follow-up its first step", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "Export CSV", status: "backlog" });
  done(src.id);
  expect(followUpPlace(store.listTickets("p"), src.id)).toEqual({ as: "main" });
  const s = await board.followUpWork("p", src.id, { title: "Export as Excel too", body: "b", important: true });
  expect(s).toMatchObject({ tool: true, kind: "build", parentId: src.id, madeFrom: src.id, important: true });
  const now = store.getTicket("p", src.id)!;
  expect(now).toMatchObject({ main: true, title: "Add export", body: "Export CSV", status: "review" });
  expect(now.plan?.state).toBe("running");
  // From now on it is a main ticket: its card updates its own plan, no follow-up card.
  expect(followUpState(now)).toBeUndefined();
  await expect(board.followUpWork("p", src.id, { title: "More", body: "" })).rejects.toThrow("A main ticket's card updates its own plan");
});

test("an old ticket under others without a main ticket gets a plain ticket beside it", async () => {
  await setup();
  const top = await board.createTicket("p", { title: "Old plan", body: "", status: "done" });
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog", partOf: top.id });
  done(src.id);
  expect(followUpPlace(store.listTickets("p"), src.id)).toEqual({ as: "ticket", partOf: src.id });
  const f = await board.followUpWork("p", src.id, { title: "Excel too", body: "b", start: true });
  expect(f).toMatchObject({ partOf: src.id, madeFrom: src.id });
  expect(f.status).not.toBe("backlog");
  expect(f.tool).toBeFalsy();
  expect(store.getTicket("p", top.id)!.main).toBeFalsy();
});

test("followUpWork refuses an empty title, a main ticket and a step", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  done(src.id);
  await expect(board.followUpWork("p", src.id, { title: "  ", body: "" })).rejects.toThrow("title is required");
  const step = await board.createTicket("p", { title: "Step", body: "", status: "backlog", tool: true, kind: "build" });
  await expect(board.followUpWork("p", step.id, { title: "x", body: "" })).rejects.toThrow("goes through its main ticket");
});

const ticket = (p: Partial<Ticket>): Ticket => ({
  id: "t_1", title: "Add export", status: "planning", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: "", updatedAt: "", body: "Export CSV", ...p,
});

test("the planning prompt offers follow-up work only on a plain ticket that already ran, worded by where it goes", () => {
  const step = { as: "step" as const, main: { id: "m", title: "Exports" }, manager: "m", partOf: "t_1" };
  expect(followUpRule(ticket({}), step)).toBe("");
  expect(followUpRule(ticket({ runCount: 1, main: true }), step)).toBe("");
  expect(followUpRule(ticket({ runCount: 1, tool: true }), step)).toBe("");
  const inFeature = followUpRule(ticket({ status: "done", runCount: 1 }), step);
  expect(inFeature).toContain("belongs to the feature “Exports”");
  expect(inFeature).toContain("Follow-up to “Add export”");
  expect(inFeature).toContain("## Objective");
  expect(inFeature).not.toContain("add-on");
  expect(followUpRule(ticket({ runCount: 1 }), { as: "main" })).toContain("first step");
  expect(followUpRule(ticket({ status: "review", runCount: 1 }), { as: "ticket", partOf: "x" })).toContain("is waiting in Review");
  const reopened = chatPrompt(ticket({ runCount: 1, reopenedFrom: { status: "done", outcome: "done" } }), "also Excel", "refine", "/o", false, "remote", false, "", undefined, { as: "main" });
  expect(reopened).toContain("This ticket is Done and stands on its own");
  expect(reopened).toContain("off topic");
  expect(chatPrompt(ticket({ runCount: 1 }), "hi", "refine", "/o")).not.toContain("Treat a new requirement");
  expect(chatPrompt(ticket({ runCount: 1 }), "hi", "act", "/o")).toContain("off topic");
  expect(chatPrompt(ticket({ runCount: 1 }), "hi", "act", "/o")).not.toContain("add-on");
});

test("followUpState: Done/Review (also reopened), ran before, or never ran; never for a main ticket or a step", () => {
  expect(followUpState({ status: "planning", runCount: 0 })).toBeUndefined();
  expect(followUpState({ status: "backlog", runCount: 0, reopenedFrom: null })).toBeUndefined();
  expect(followUpState({ status: "planning", runCount: 1, reopenedFrom: { status: "done", outcome: "done" } })).toBe("Done");
  expect(followUpState({ status: "planning", runCount: 1, reopenedFrom: { status: "review", outcome: "done" } })).toBe("In review");
  expect(followUpState({ status: "review", runCount: 1 })).toBe("In review");
  expect(followUpState({ status: "planning", runCount: 1 })).toBeNull();
  expect(followUpState({ status: "ready", runCount: 1, reopenedFrom: { status: "done", outcome: "done" } })).toBeNull();
  expect(followUpState({ status: "review", runCount: 1, main: true })).toBeUndefined();
  expect(followUpState({ status: "done", runCount: 1, tool: true })).toBeUndefined();
});

test("followUpFor finds what a card made", () => {
  const a = { id: "a", title: "Export", madeFrom: null };
  const b = { id: "b", title: "Excel", madeFrom: "a" };
  const c = { id: "c", title: "Renamed", proposedAs: "PDF", madeFrom: "a" };
  expect(followUpFor([a, b, c], "a", " Excel ")?.id).toBe("b");
  expect(followUpFor([a, b, c], "a", "PDF")?.id).toBe("c");
  expect(followUpFor([a, b, c], "b", "Excel")).toBeUndefined();
});

// ---- Old add-on tickets on every board ----

test("withoutAddOn: an old add-on link becomes partOf + madeFrom, keeping the same parent; idempotent", () => {
  const cases: Record<string, unknown>[] = [
    { id: "x", addOnOf: "a" },
    { id: "x", addOnOf: "a", partOf: "p" },
    { id: "x", addOnOf: "a", parentId: "plan" },
    { id: "x", followUpOf: "a" },
    { id: "x", followUpOf: "a", addOnOf: "b" },
    { id: "x", addOnOf: null },
  ];
  for (const meta of cases) {
    const before = (meta.partOf ?? meta.addOnOf ?? meta.followUpOf ?? meta.parentId ?? null) as string | null;
    const out = withoutAddOn(meta);
    expect("addOnOf" in out || "followUpOf" in out).toBe(false);
    expect(parentLink(out as any)?.id ?? null).toBe(before);
    expect(withoutAddOn(out)).toEqual(out);
  }
  expect(withoutAddOn({ id: "x", addOnOf: "a" })).toEqual({ id: "x", partOf: "a", madeFrom: "a" });
  expect(withoutAddOn({ id: "x", addOnOf: "a", partOf: "p" })).toEqual({ id: "x", partOf: "p", madeFrom: "a" });
  expect(withoutAddOn({ id: "x", followUpOf: "a", addOnOf: "b" })).toEqual({ id: "x", partOf: "b", madeFrom: "b" });
  expect(withoutAddOn({ id: "x", addOnOf: null })).toEqual({ id: "x" });
  // A ticket without one is returned as is.
  const plain = { id: "y", partOf: "p" };
  expect(withoutAddOn(plain)).toBe(plain);
});

test("an add-on saved on disk loads in its family under the same ticket, its card still finds it, and saving drops the old field", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  done(src.id);
  const a = await board.createTicket("p", { title: "Excel too", body: "", status: "backlog" });
  const old = await board.createTicket("p", { title: "PDF too", body: "", status: "backlog" });
  writeFileSync(store.ticketPath("p", a.id), readFileSync(store.ticketPath("p", a.id), "utf8").replace(/^---\n/, `---\naddOnOf: ${src.id}\nproposedAs: Excel too\nstartFrom: ck/old\n`));
  writeFileSync(store.ticketPath("p", old.id), readFileSync(store.ticketPath("p", old.id), "utf8").replace(/^---\n/, `---\nfollowUpOf: ${src.id}\n`));
  for (const id of [a.id, old.id]) {
    const t = store.getTicket("p", id)!;
    expect(t).toMatchObject({ partOf: src.id, madeFrom: src.id });
    expect("addOnOf" in t || "followUpOf" in t).toBe(false);
  }
  const tickets = store.listTickets("p");
  expect(tickets.length).toBe(3);
  expect(store.getTicket("p", a.id)!.startFrom).toBe("ck/old");
  expect(familyOf(tickets, src.id).map((r) => r.ticket.id).sort()).toEqual([src.id, a.id, old.id].sort());
  expect(followUpFor(tickets, src.id, "Excel too")?.id).toBe(a.id);
  // A save writes the new fields only.
  store.updateTicket("p", a.id, { title: "Excel too!" });
  const file = readFileSync(store.ticketPath("p", a.id), "utf8");
  expect(file).not.toContain("addOnOf");
  expect(file).toContain(`partOf: ${src.id}`);
  expect(file).toContain(`madeFrom: ${src.id}`);
  // Moving it elsewhere before it started stops it building on the old ticket's work.
  const other = await board.createTicket("p", { title: "Other", body: "", status: "backlog" });
  const moved = await board.setPartOf("p", a.id, other.id);
  expect(moved).toMatchObject({ partOf: other.id, madeFrom: src.id, startFrom: null });
});

test("a ⭐ at the start of a title marks the ticket Important and leaves the star out of the title", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "⭐ Apply to OpenAI", body: "", status: "backlog" });
  expect(store.getTicket("p", t.id)).toMatchObject({ title: "Apply to OpenAI", important: true });
  const u = await board.createTicket("p", { title: "Fix login", body: "", status: "backlog" });
  expect(store.getTicket("p", u.id)!.important).toBeUndefined();
  await board.updateTicket("p", u.id, { title: "⭐ Fix login fast" });
  expect(store.getTicket("p", u.id)).toMatchObject({ title: "Fix login fast", important: true });
});

test("a second click after case 2 returns the step it made, not an error", async () => {
  await setup();
  const src = await board.createTicket("p", { title: "Add export", body: "", status: "backlog" });
  done(src.id);
  const s = await board.followUpWork("p", src.id, { title: "Excel too", body: "b" });
  expect(store.getTicket("p", src.id)!.main).toBe(true);
  expect((await board.followUpWork("p", src.id, { title: "Excel too", body: "b" })).id).toBe(s.id);
});
