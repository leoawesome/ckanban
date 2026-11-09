// Squads (huddle templates to the user): host rules, the topic, the generic-squad call, propose_squad cards and saving them.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callTool, type ToolContext } from "../src/mcp-server";
import { cleanTemplates, templateBrief, templateFromInput } from "../src/server/huddle-templates";
import { huddleAgentSystemPrompt, squadHostRules } from "../src/server/prompts";
import { parseSession } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { GENERIC_SQUAD_SYSTEM, genericSquadPrompt, parseGenericSquad, squadSavePlan, squadSetup } from "../src/server/squad";
import { reviewHuddleRequest, summaryFile } from "../src/server/huddle-roster";
import type { Huddle } from "../src/server/types";
import { agentCtx, api, client, host, huddles, idle, postJson, store, text, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

const RULES = "1. Post the open points with no names.\n2. Round 1: everyone answers each point.\n3. Missing round: anything left out?\n4. Final call: nobody marks done before the host's final call.";

const squadInput = {
  name: "plan-critique", label: "Plan critique", description: "Critics attack a plan from several angles.", hostRules: RULES, maxCostUsd: 60,
  roster: [
    { handle: "facilitator", preset: "facilitator", host: true, mode: "monitor", focus: "Run the steps." },
    { handle: "skeptic", preset: "breaker", mode: "monitor", focus: "What breaks." },
    { handle: "journey", role: "User journey walker", prompt: "Walk every path a real user takes, step by step.", mode: "monitor" },
    { handle: "research", preset: "researcher", model: "sonnet", mode: "tagged" },
  ],
};

// ---- Format ----

test("hostRules: saved with a squad, and old template files (no hostRules) load unchanged as \"\"", () => {
  const t = templateFromInput(squadInput);
  expect(t.hostRules).toBe(RULES);
  // An old huddle-templates.json entry, written before squads had host rules.
  const old = { name: "bug-bash", label: "Bug bash", description: "", roster: [{ preset: "qa", count: 2 }], rounds: 1, maxCostUsd: 8, report: "" };
  expect(cleanTemplates([old])).toEqual([{ ...old, hostRules: "" }]);
  writeFileSync(join(store.root, "huddle-templates.json"), JSON.stringify([old]));
  expect(store.listHuddleTemplates(null)).toEqual([{ ...old, hostRules: "" }]);
  // An edit that leaves hostRules out keeps them.
  expect(templateFromInput({ name: "plan-critique", label: "New label" }, t).hostRules).toBe(RULES);
  // ~2,000 characters of host rules plus six people with focus text fit.
  const big = templateFromInput({
    name: "big", hostRules: "r".repeat(2000),
    roster: Array.from({ length: 6 }, (_, i) => ({ role: `Role ${i}`, prompt: "p".repeat(1500), focus: "f".repeat(1500) })),
  });
  expect(big.hostRules.length).toBe(2000);
  expect(() => templateFromInput({ name: "x", roster: [{ preset: "qa" }], hostRules: 5 })).toThrow("hostRules must be text");
});

// ---- Topic ----

test("topic: reaches the pinned brief and the host's instructions; with none, the host ticket is the topic", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const r = await postJson("/huddle-templates", { ...squadInput, scope: "board" });
  expect(r.status).toBe(201);
  const started = await postJson("/huddles", { ticketId: t.id, roster: [], squad: "plan-critique", topic: "Should the helper watch the inbox or poll it?" });
  expect(started.status).toBe(201);
  const h = (await started.json()) as Huddle;
  expect(h).toMatchObject({ template: "plan-critique", topic: "Should the helper watch the inbox or poll it?", hostRules: RULES, host: "facilitator", maxCostUsd: 60 });
  expect(h.brief!.text).toContain("Topic: Should the helper watch the inbox or poll it?");
  expect(h.brief!.text).toContain("Host rules (how this huddle runs):\n1. Post the open points");
  const saved = store.getHuddle("p", h.id)!;
  const hostP = saved.participants.find((p) => p.handle === "facilitator")!;
  const sys = huddleAgentSystemPrompt(saved, hostP, t, "/out", "/work");
  expect(sys).toContain("## How this huddle runs (squad plan-critique)");
  expect(sys).toContain(RULES);
  expect(sys).toContain("## Topic\nShould the helper watch the inbox or poll it?\nYour first post is about this topic");
  // Helpers don't get the host's section.
  expect(huddleAgentSystemPrompt(saved, saved.participants.find((p) => p.handle === "skeptic")!, t, "/out", "/work")).not.toContain("## How this huddle runs");
  await huddles.stopAll("p", h.id);
  await idle();
  huddles.close("p", h.id);
  // No topic: the host ticket's title and description.
  const h2 = huddles.create("p", t.id, [], { template: "plan-critique" });
  expect(h2.topic).toBeUndefined();
  expect(h2.brief!.text).toContain(`Topic: ${t.title}`);
  expect(squadHostRules(h2, t)).toContain(`## Topic\n${t.title}`);
  await huddles.stopAll("p", h2.id);
  await idle();
  huddles.close("p", h2.id);
  // A squad without host rules and no topic keeps its old brief.
  expect(templateBrief(templateFromInput({ name: "x", roster: [{ preset: "qa" }] }), 5)).not.toContain("Topic");
  expect(() => huddles.create("p", t.id, [], { template: "plan-critique", topic: "x".repeat(2001) })).toThrow("topic is too long");
}, 60_000);

test("propose_huddle takes squad (or the older template) and a topic; the Start card carries the topic", async () => {
  const t = await host();
  const ctx: ToolContext = { client, cwd: "/", env: { CKANBAN_TICKET: `p/${t.id}` } };
  expect((await callTool("propose_huddle", { squad: "design-review", topic: "Review the upload flow" }, ctx)).isError).toBeUndefined();
  expect((await callTool("propose_huddle", { template: "design-review" }, ctx)).isError).toBeUndefined();
  const bad = await callTool("propose_huddle", { squad: "nope" }, ctx);
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("unknown squad");
  expect((await callTool("propose_huddle", { squad: "design-review", topic: "x".repeat(2001) }, ctx)).isError).toBe(true);
  const line = (input: object) => JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-09T00:00:00Z", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__ckanban__propose_huddle", input }] } });
  expect(parseSession(line({ squad: "design-review", topic: "Review the upload flow", reason: "r" })).entries.find((e) => e.huddle)!.huddle)
    .toEqual({ roster: [], reason: "r", template: "design-review", topic: "Review the upload flow" });
  expect(parseSession(line({ template: "design-review", reason: "r" })).entries.find((e) => e.huddle)!.huddle!.template).toBe("design-review");
  // A ticket's "## Review huddle" section may name a squad.
  expect(reviewHuddleRequest("## Review huddle\nSquad: auto-review\nBudget: ~$10")).toMatchObject({ template: "auto-review", maxCostUsd: 10 });
  expect(reviewHuddleRequest("## Review huddle\nTemplate: auto-review")).toMatchObject({ template: "auto-review" });
});

// ---- Generic-squad call ----

/** A huddle like h_oifve4n4: a facilitator host with rules mixed into a long point list, critics, a researcher on sonnet. */
async function sourceHuddle(): Promise<Huddle> {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [
    { handle: "facilitator", preset: "facilitator", host: true, focus: "People marked done too early. (1) Post the point list P1-P17 about src/server/notify.ts. (2) Round 1." },
    { handle: "journey", role: "User journey walker", prompt: "Walk every path a real user takes. Don't mark yourself done until the host's final call.", focus: "Walk Telegram setup.", mode: "monitor" },
    { handle: "research", preset: "researcher", model: "sonnet", focus: "How alert tools do it." },
  ], { maxCostUsd: 60 });
  await huddles.stopAll("p", h.id);
  await idle();
  return store.getHuddle("p", h.id)!;
}

test("generic squad: the setup leaves out @main and @you and keeps each person's own prompt, focus, mode, model and flags", async () => {
  const h = await sourceHuddle();
  const presets = new Map(huddles.presets("p").map((p) => [p.name, p]));
  const setup = squadSetup(h, presets);
  expect(setup.maxCostUsd).toBe(60);
  expect(setup.roster.map((e) => e.handle)).toEqual(["facilitator", "journey", "research"]);
  expect(setup.roster[0]).toMatchObject({ preset: "facilitator", host: true, lead: true, mode: "monitor" });
  // A preset's own prompt isn't repeated; a role with no preset keeps its whole prompt.
  expect(setup.roster[0].prompt).toBeUndefined();
  expect(setup.roster[1]).toMatchObject({ role: "User journey walker", prompt: expect.stringContaining("Walk every path"), mode: "monitor" });
  expect(setup.roster[2]).toMatchObject({ preset: "researcher", model: "sonnet" });
  const prompt = genericSquadPrompt({ setup, brief: "VERDICT: 5/5", learnings: ["@journey ended done: walked every path"], source: { kind: "chat", text: "[#1] @facilitator: P1..." } });
  expect(prompt).toContain("\"handle\": \"journey\"");
  expect(prompt).toContain("# Pinned brief at the end\nVERDICT: 5/5");
  expect(prompt).toContain("- @journey ended done");
  expect(prompt).toContain("# The end of the huddle's chat");
  expect(GENERIC_SQUAD_SYSTEM).toContain("Make it generic");
  expect(GENERIC_SQUAD_SYSTEM).toContain("hostRules");
  huddles.close("p", h.id);
}, 60_000);

test("generic squad: one side call (summary file first), retried once on bad JSON, charged to the host ticket; saves nothing", async () => {
  const h = await sourceHuddle();
  const summary = join(store.outputsPath("p", h.hostTicket), summaryFile(h.id));
  mkdirSync(dirname(summary), { recursive: true });
  writeFileSync(summary, "# Huddle summary\nAll five voted yes.");
  const calls: SideCallInput[] = [];
  const answers: SideCallResult[] = [
    { ok: true, text: "Sure! here it is", costUsd: 0.01, model: "sonnet" },
    { ok: true, text: "```json\n" + JSON.stringify({ ...squadInput, name: "plan-critique" }) + "\n```", costUsd: 0.02, model: "sonnet" },
  ];
  const call = async (i: SideCallInput) => (calls.push(i), answers.shift()!);
  const before = store.listHuddleTemplates("p").length;
  const r = await huddles.genericSquad("p", h.id, call);
  expect(calls.length).toBe(2);
  expect(calls[0].prompt).toContain("# The huddle's summary\n# Huddle summary\nAll five voted yes.");
  expect(calls[1].prompt).toContain("Your last answer couldn't be used");
  expect(r.error).toBeNull();
  expect(r.costUsd).toBeCloseTo(0.03);
  expect(r.proposal!.squad).toMatchObject({ name: "plan-critique", hostRules: RULES, maxCostUsd: 60 });
  expect(r.proposal!.newTeammates).toEqual([{ index: 2, name: "journey", role: "User journey walker" }]);
  expect(r.setup.roster.map((e) => e.handle)).toEqual(["facilitator", "journey", "research"]);
  // Charged to the host ticket's side ledger; nothing saved.
  expect(store.listHuddleTemplates("p").length).toBe(before);
  const ledger = await Bun.file(store.sideSpendPath("p", h.hostTicket)).text();
  expect(ledger).toContain("\"kind\":\"squad\"");
  // Two bad answers: a clear error and the setup for the filled-in editor.
  const bad = await huddles.genericSquad("p", h.id, async () => ({ ok: true, text: "{not json", costUsd: 0, model: "sonnet" }));
  expect(bad.proposal).toBeNull();
  expect(bad.error).toContain("couldn't be read twice");
  expect(bad.setup.roster.length).toBe(3);
  const failed = await huddles.genericSquad("p", h.id, async () => ({ ok: false, error: "timed out" }));
  expect(failed.error).toContain("timed out");
  // An unknown preset in the answer is refused like a saved squad would be.
  expect(() => parseGenericSquad(JSON.stringify({ name: "x", roster: [{ preset: "nope" }] }), ["qa"])).toThrow("unknown preset");
  huddles.close("p", h.id);
}, 60_000);

test("generic squad route: the user only; runs and huddle agents are refused", async () => {
  const h = await sourceHuddle();
  expect((await postJson(`/huddles/${h.id}/generic-squad`, {}, { "x-ckanban-run": `p/${h.hostTicket}` })).status).toBe(403);
  huddles.close("p", h.id);
}, 60_000);

// ---- Cards and saving ----

test("save plan: a person with no preset becomes a new teammate; an existing one of that name is used as is", () => {
  const presets = new Map(huddles.presets("p").map((p) => [p.name, p]));
  const plan = squadSavePlan(squadInput, presets);
  expect(plan.create.map((p) => p.name)).toEqual(["journey"]);
  expect(plan.create[0]).toMatchObject({ role: "User journey walker", prompt: "Walk every path a real user takes, step by step.", mode: "monitor" });
  expect(plan.squad.roster[2]).toEqual({ handle: "journey", preset: "journey", mode: "monitor" });
  const taken = new Map<string, { name: string }>([...presets, ["journey", { name: "journey" }]]);
  const plan2 = squadSavePlan(squadInput, taken);
  expect(plan2.create).toEqual([]);
  expect(plan2.reused).toEqual(["journey"]);
});

test("save plan: two different people with the same name get two teammates; the same person twice shares one", () => {
  const presets = new Map(huddles.presets("p").map((p) => [p.name, p]));
  const plan = squadSavePlan({ name: "x", roster: [
    { role: "Walker", prompt: "Walk the web app." }, { role: "walker", prompt: "Walk the phone app." }, { role: "Walker", prompt: "Walk the web app." },
  ] }, presets);
  expect(plan.create.map((p) => [p.name, p.prompt])).toEqual([["walker", "Walk the web app."], ["walker-2", "Walk the phone app."]]);
  expect(plan.squad.roster.map((e) => e.preset)).toEqual(["walker", "walker-2", "walker"]);
});

test("save for all boards: a teammate only this board has is neither reused nor replaced; the squad starts on another board", async () => {
  const board = { name: "walker", role: "Mine", prompt: "My board walker.", model: null, mode: "tagged" as const, lead: false, canEdit: false, workspace: "shared" as const };
  store.saveHuddlePresets("p", [board]);
  const r = await postJson("/squads", { scope: "global", squad: { name: "g-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] } });
  expect(r.status).toBe(201);
  expect(((await r.json()) as any).teammates).toEqual({ created: ["walker-2"], reused: [] });
  // The board's own teammate is untouched, and the squad only names teammates every board has.
  expect(store.listHuddlePresets("p")).toEqual([board]);
  expect(store.listHuddlePresets(null).find((p) => p.name === "walker-2")).toMatchObject({ role: "Walker", prompt: "Walk." });
  expect(store.listHuddleTemplates(null).find((s) => s.name === "g-squad")!.roster).toEqual([{ handle: "walker", preset: "walker-2" }]);
  // A squad for all boards can't point at a board-only teammate by preset either.
  expect((await postJson("/squads", { scope: "global", squad: { name: "g2", roster: [{ preset: "walker" }] } })).status).toBe(400);
  // Saved for this board, the board's teammate is used as is.
  const b = await postJson("/squads", { scope: "board", squad: { name: "b-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] } });
  expect(((await b.json()) as any).teammates).toEqual({ created: [], reused: ["walker"] });
});

test("propose_squad: a card in a ticket chat; saving it makes new teammates, never overwrites one, and only the user saves", async () => {
  const t = await host();
  const ctx: ToolContext = { client, cwd: "/", env: { CKANBAN_TICKET: `p/${t.id}` } };
  const shown = await callTool("propose_squad", { ...squadInput, why: "The plan review worked; reuse it." }, ctx);
  expect(shown.isError).toBeUndefined();
  expect(text(shown)).toContain("Shown to the user");
  expect((await callTool("propose_squad", { ...squadInput }, ctx)).isError).toBe(true);
  // The card from the transcript marks the person who would become a new teammate.
  const line = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-09T00:00:00Z", message: { content: [{ type: "tool_use", id: "tu9", name: "mcp__ckanban__propose_squad", input: { ...squadInput, why: "reuse it" } }] } });
  const parsed = parseSession(line);
  const card = parsed.entries.find((e) => e.squad)!;
  expect(card.squad!.newTeammates).toEqual([{ index: 2, name: "journey", role: "User journey walker" }]);
  expect(parsed.pendingSquads).toEqual(["tu9"]);
  // Runs and huddle agents can't save squads (or the teammates in them).
  const body = { squad: card.squad!.squad, scope: "board", card: { ticketId: t.id, uuid: "tu9" } };
  expect((await postJson("/squads", body, { "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect((await postJson("/squads", body, { "x-ckanban-huddle-agent": "h_x/qa/token" })).status).toBe(403);
  expect((await postJson("/huddle-templates", squadInput, { "x-ckanban-run": `p/${t.id}` })).status).toBe(403);
  expect(store.listHuddlePresets("p").some((p) => p.name === "journey")).toBe(false);
  // An existing teammate "journey" is used as is, never overwritten.
  store.saveHuddlePresets("p", [{ name: "journey", role: "Mine", prompt: "My own journey prompt.", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared" }]);
  const r = await postJson("/squads", body);
  expect(r.status).toBe(201);
  const out = (await r.json()) as { squad: { name: string; roster: { preset?: string }[] }; teammates: { created: string[]; reused: string[] } };
  expect(out.teammates).toEqual({ created: [], reused: ["journey"] });
  expect(out.squad.roster[2].preset).toBe("journey");
  expect(store.listHuddlePresets("p").find((p) => p.name === "journey")!.prompt).toBe("My own journey prompt.");
  expect(store.getTicket("p", t.id)!.squadCards!.tu9).toMatchObject({ state: "saved", name: "plan-critique", scope: "board", teammates: { created: [], reused: ["journey"] } });
  // Same name again: refused unless replace.
  expect((await postJson("/squads", { ...body, card: undefined })).status).toBe(409);
  // A new name with a new role: the teammate is made at the same scope (all boards here).
  const other = { ...squadInput, name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk it." }] };
  const g = await postJson("/squads", { squad: other, scope: "global" });
  expect(g.status).toBe(201);
  expect(((await g.json()) as any).teammates).toEqual({ created: ["walker"], reused: [] });
  expect(store.listHuddlePresets(null).find((p) => p.name === "walker")).toMatchObject({ role: "Walker", prompt: "Walk it." });
  expect(store.listHuddleTemplates(null).find((s) => s.name === "walk-squad")!.roster).toEqual([{ handle: "walker", preset: "walker" }]);
  // Dismissing a card.
  expect((await api(`/tickets/${t.id}/squad-cards/tu10`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "dismissed" }) })).status).toBe(200);
  expect(store.getTicket("p", t.id)!.squadCards!.tu10.state).toBe("dismissed");
  expect((await api(`/tickets/${t.id}/squad-cards/tu11`, { method: "PUT", headers: { "content-type": "application/json", "x-ckanban-run": `p/${t.id}` }, body: JSON.stringify({ state: "dismissed" }) })).status).toBe(403);
}, 60_000);

test("propose_squad from a huddle agent waits under Learnings; only the user saves it", async () => {
  const t = await host();
  process.env.FAKE_STEP_MS = "50";
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  const r = await callTool("propose_squad", { ...squadInput, name: "agent-squad", why: "This setup worked." }, agentCtx(h, "reviewer"));
  expect(r.isError).toBeUndefined();
  expect(text(r)).toContain("under the huddle's Learnings");
  const l = store.getHuddle("p", h.id)!.learnings!.find((x) => x.squad)!;
  expect(l).toMatchObject({ status: "pending", from: "reviewer", target: "agent-squad" });
  // One waiting squad per agent.
  expect((await callTool("propose_squad", { ...squadInput, name: "agent-squad-2", why: "again" }, agentCtx(h, "reviewer"))).isError).toBe(true);
  // The agent can't save it.
  expect((await postJson(`/huddles/${h.id}/learnings/${l.id}/save`, {}, { "x-ckanban-huddle-agent": "x" })).status).toBe(403);
  expect(store.listHuddleTemplates(null).some((s) => s.name === "agent-squad")).toBe(false);
  // The user saves it (scope general: all boards), with its new teammate.
  const saved = await postJson(`/huddles/${h.id}/learnings/${l.id}/save`, {});
  expect(saved.status).toBe(200);
  expect(store.listHuddleTemplates(null).some((s) => s.name === "agent-squad")).toBe(true);
  expect(store.listHuddlePresets(null).some((p) => p.name === "journey")).toBe(true);
  expect(store.getHuddle("p", h.id)!.learnings!.find((x) => x.id === l.id)!.status).toBe("saved");
  await huddles.stopAll("p", h.id);
}, 60_000);
