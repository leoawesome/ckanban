import { expect, test } from "bun:test";
import { BUILTIN_TEMPLATES, FRESH_HELPER_CHECK, FRESH_READER_CHECK, PLAN_REVIEW_READ } from "../src/server/huddle-templates";
import { planProposal } from "../src/server/plan-proposal";
import { autoHuddleRule, chatPrompt, huddleMainPrompt, planningPrompt, TICKETS_FORMAT } from "../src/server/prompts";
import type { SessionEntry } from "../src/server/session";
import type { Huddle, HuddleParticipant, Ticket } from "../src/server/types";

const T = { id: "t_1", title: "Settings", body: "Old description" };
const e = (x: Partial<SessionEntry>): SessionEntry => ({ uuid: crypto.randomUUID(), at: "", role: "assistant", kind: "text", text: "", ...x });

test("planProposal: latest proposal and child tickets, no chat text", () => {
  const md = planProposal(T, [
    e({ role: "user", text: "secret chat words" }),
    e({ proposal: { title: "Old", description: "stale" } }),
    e({ text: "I think this is great, chat chatter" }),
    e({ proposal: { title: "New parent", description: "## Goal\nparent goal" } }),
    e({ newTickets: [{ key: "a", title: "Ticket A", description: "do A" }, { key: "b", title: "Ticket B: improve the settings", description: "improve", dependsOn: ["a"] }] }),
  ]);
  expect(md).toContain("New parent");
  expect(md).toContain("parent goal");
  expect(md).not.toContain("stale");
  expect(md).toContain("## Child ticket a: Ticket A");
  expect(md).toContain("## Child ticket b: Ticket B: improve the settings");
  expect(md).toContain("Depends on: a");
  expect(md).not.toContain("secret chat words");
  expect(md).not.toContain("chat chatter");
  expect(md).not.toContain("Old description");
});

test("planProposal: nothing proposed falls back to the ticket's title and description", () => {
  const md = planProposal(T, [e({ role: "user", text: "hello" }), e({ text: "chatter" })]);
  expect(md).toContain("Nothing was proposed");
  expect(md).toContain("## Ticket: Settings");
  expect(md).toContain("Old description");
  expect(md).not.toContain("chatter");
});

const role = (tpl: string, handle: string) => BUILTIN_TEMPLATES.find((t) => t.name === tpl)!.roster.find((r) => r.handle === handle)!.prompt!;

test("plan review reads the proposal file, never the chat; roles carry fresh-reader and reuse lines", () => {
  expect(PLAN_REVIEW_READ).toContain("huddles/<huddle id>/proposal.md");
  expect(PLAN_REVIEW_READ).toContain("don't read the ticket's chat log or Claude's session files");
  expect(PLAN_REVIEW_READ).toContain("ticket key");
  expect(role("plan-review", "qa")).toContain(FRESH_READER_CHECK);
  expect(FRESH_READER_CHECK).toContain("2-3 plain sentences");
  expect(FRESH_READER_CHECK).toContain("MUST finding");
  expect(FRESH_READER_CHECK).toContain("what happens on failure");
  for (const p of [role("plan-review", "codebase"), role("design-review", "architect")]) {
    expect(p).toContain("git grep");
    expect(p).toContain("existing one");
  }
});

test("fresh helper before propose_tickets shares the fresh-reader wording", () => {
  expect(FRESH_HELPER_CHECK).toContain(FRESH_READER_CHECK);
  expect(TICKETS_FORMAT).toContain(FRESH_HELPER_CHECK);
  expect(FRESH_HELPER_CHECK).toContain("Agent tool");
  expect(FRESH_HELPER_CHECK).toContain("no chat text");
  expect(FRESH_HELPER_CHECK).toContain("One check per proposal");
});

test("planning chats push back; reviewer briefs stay neutral", () => {
  const t = { id: "t_1", title: "X", body: "Y", tags: [] } as unknown as Ticket;
  for (const p of [planningPrompt(t, "/tmp/t.md"), chatPrompt(t, "", "refine", "/tmp/out")]) {
    expect(p).toContain("lead with what is wrong, missing or risky");
    expect(p).toContain("don't praise their ideas");
  }
  const rule = autoHuddleRule({ body: "" });
  expect(rule).toContain("Don't say the work is correct, done or safe");
  expect(rule).toContain("what changed, what to check and where");
});

test("plan review findings come back as one form with at most 6 questions", () => {
  const main = { handle: "main", role: "Main", prompt: "" } as HuddleParticipant;
  const h = { id: "h_1", participants: [main], host: "skeptic", findings: [] } as unknown as Huddle;
  const p = huddleMainPrompt(h, main, "digest", true, true);
  expect(p).toContain("at most 6 questions");
  expect(p).toContain("No findings: say the review found nothing to change; no form");
  expect(p).toContain("Only COULD findings");
  expect(p).toContain('"Fix it"');
  expect(p).toContain('"Make a follow-up ticket"');
  expect(p).toContain("propose_tickets");
  // Outside Planning: unchanged.
  expect(huddleMainPrompt(h, main, "digest", true, false)).not.toContain("at most 6 questions");
});
