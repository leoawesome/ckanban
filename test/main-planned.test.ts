// A main ticket that is already planned (family or written status) doesn't get the "propose an improved ticket"
// invitation in Planning: its plan goes into the status, and propose_ticket only updates the ticket (plain Apply never starts work).
import { expect, test } from "bun:test";
import { plannedMain } from "../web/src/family";
import { mainPlanned } from "../src/server/main-ticket";
import { chatPrompt, TICKET_FORMAT, type MainRole } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { board, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

const role = (planned?: string): MainRole => ({ kind: "main", repo: "remote", branch: null, inPlace: false, ...(planned ? { planned } : {}) });
const ticket = (extra: Partial<Ticket> = {}) => ({ id: "t1", title: "Cloudflare", body: "## Goal\nMove DNS.", status: "planning", runCount: 0, tags: [], main: true, ...extra }) as Ticket;

test("plannedMain: a family or a written status counts; an empty family and plain tickets don't", () => {
  const main = { id: "m", title: "M", status: "planning", main: true, createdAt: "2026-11-08T00:00:00Z" } as Ticket;
  expect(plannedMain([main], main)).toBeNull();
  expect(mainPlanned([main], main)).toBeNull();
  const step = { id: "s", title: "S", status: "backlog", parentId: "m", tool: true, createdAt: "2026-11-08T00:01:00Z" } as Ticket;
  expect(plannedMain([main, step], main)).toBe("family");
  expect(mainPlanned([main, step], main)).toContain("family");
  const written = { ...main, statusAt: "2026-11-08T00:00:00Z" };
  expect(plannedMain([written], written)).toBe("status");
  expect(mainPlanned([written], written)).toContain("status");
  const plain = { ...written, main: false };
  expect(plannedMain([plain, { ...step, parentId: "m" }], plain)).toBeNull();
});

test("Planning prompt: a planned main ticket gets the keep-it rule instead of TICKET_FORMAT; unplanned and plain tickets keep it", () => {
  const planned = chatPrompt(ticket(), "", "refine", "/o", false, "remote", false, "", role("it already has tickets in its family"));
  expect(planned).not.toContain(TICKET_FORMAT);
  expect(planned).not.toContain("propose the polished ticket");
  expect(planned).not.toContain("propose the improved ticket");
  expect(planned).toContain("This main ticket is already planned (it already has tickets in its family)");
  expect(planned).toContain("update_status");
  expect(planned).toContain("keep its current title and description, word for word, and add or adjust only what changed");
  expect(planned).toContain("applying it never starts work");

  const fresh = chatPrompt(ticket({ body: "dns" }), "", "refine", "/o", false, "remote", false, "", role());
  expect(fresh).toContain(TICKET_FORMAT);
  expect(fresh).toContain("propose the polished ticket");
  expect(fresh).not.toContain("already planned");

  const plain = chatPrompt(ticket({ main: false }), "", "refine", "/o");
  expect(plain).toContain(TICKET_FORMAT);
  expect(plain).not.toContain("already planned");
});

test("the board decides: a hand-written main ticket gets the proposal card; one with a step or a written status doesn't", async () => {
  await setup();
  const mk = (title: string) => board.createTicket("p", { title, body: "Goal.", status: "backlog", mode: "auto", main: true })
    .then((t) => store.updateTicket("p", t.id, { status: "planning", refineStarted: true }));
  const fresh = await mk("Fresh");
  const withStep = await mk("With step");
  await board.createTicket("p", { title: "Look", body: "## Objective\nLook.", status: "backlog", mode: "auto", parentId: withStep.id, tool: true, kind: "explore" });
  const withStatus = await mk("With status");
  board.updateStatus("p", withStatus.id, { goal: "Move DNS to Cloudflare", next: "Agree the cut-over day" });

  await board.chat("p", fresh.id, "msg-fresh");
  await board.chat("p", withStep.id, "msg-step");
  await board.chat("p", withStatus.id, "msg-status");
  await untilSpawned(3);
  await board.whenIdle();
  const prompt = (text: string) => readArgs().find((a) => a.prompt.includes(text))!.prompt;
  expect(prompt("msg-fresh")).toContain(TICKET_FORMAT);
  expect(prompt("msg-step")).not.toContain(TICKET_FORMAT);
  expect(prompt("msg-step")).toContain("already planned (it already has tickets in its family)");
  expect(prompt("msg-status")).not.toContain(TICKET_FORMAT);
  expect(prompt("msg-status")).toContain("already planned (its \"Where we are\" status is already written)");
  // The user's title and description are untouched.
  expect(store.getTicket("p", withStep.id)!.title).toBe("With step");
}, 60_000);
