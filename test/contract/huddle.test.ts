// Outside-in contract: teammates (huddle presets), squads (huddle templates and POST /squads) and huddles (start from a
// roster or a squad, posts from the user, a helper and the host ticket's run, findings, hand-ins, close, the budget
// stop), with the files under the data folder and the event stream. See contracts/api.md ("Team" and "Huddles") and
// contracts/data-files.md ("Core: huddles", "Core: board knowledge").
//
// Huddle helpers run on the fake Claude: each turn ends at once and reports $0.01 (its total_cost_usd), so a budget
// under that stops the huddle after the first turn. A helper proves who it is with `<huddle id>/<handle>/<token>` in
// x-ckanban-huddle-agent (its run gets it in CKANBAN_HUDDLE_AGENT); the token is only in the huddle's file on disk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { readJsonl } from "./files";

let d: Daemon;
const SLUG = "huddle";
const base = `/api/profiles/${SLUG}`;
const RUN = "x-ckanban-run";
const AGENT = "x-ckanban-huddle-agent";

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Huddle", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const boardFile = (name: string) => join(d.home, "profiles", SLUG, name);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const huddleFile = (hid: string) => join(d.home, "profiles", SLUG, "huddles", `${hid}.json`);
const messagesFile = (hid: string) => join(d.home, "profiles", SLUG, "huddles", `${hid}.messages.jsonl`);
/** A participant as saved on disk (with its token). */
const onDisk = (hid: string, handle: string) => readJson(huddleFile(hid)).participants.find((p: any) => p.handle === handle);
const newTicket = async (title: string) => (await d.api("POST", `${base}/tickets`, { title, body: "Host of a huddle." })).data;

/** Reads the event stream until `pred` matches one of its `data:` messages. */
async function events() {
  const ctl = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ctl.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: any[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();
  return {
    seen,
    wait: (pred: (e: any) => boolean, what: string) => until(() => seen.find(pred), 15_000, what),
    close: async () => {
      ctl.abort();
      await pump;
    },
  };
}

describe("teammates (huddle presets)", () => {
  test("built-ins, a board teammate, moving it to every board, and delete", async () => {
    const list = await d.api("GET", `${base}/huddle-presets`);
    expect(list.status).toBe(200);
    expect(list.data.find((p: any) => p.name === "reviewer")).toMatchObject({ name: "reviewer", builtin: true, source: "builtin", base: null });

    const made = await d.api("POST", `${base}/huddle-presets`, { name: "Walker", role: "Walker", prompt: "Walk the app." });
    expect(made.status).toBe(201);
    const walker = { name: "walker", role: "Walker", prompt: "Walk the app.", model: null, mode: "tagged", workspace: "shared", lead: false, canEdit: false };
    expect(made.data).toEqual({ ...walker, source: "board", base: null, builtin: false });
    // profiles/<slug>/huddle-presets.json: a pretty JSON array ending with a newline.
    const text = readFileSync(boardFile("huddle-presets.json"), "utf8");
    expect(JSON.parse(text)).toEqual([walker]);
    expect(text).toBe(JSON.stringify([walker], null, 2) + "\n");

    // Saved for every board: the global file gets it and the board's own copy goes.
    const moved = await d.api("PUT", `${base}/huddle-presets/walker`, { prompt: "Walk it again.", scope: "global" });
    expect(moved.status).toBe(200);
    expect(moved.data).toMatchObject({ name: "walker", prompt: "Walk it again.", source: "global" });
    expect(readJson(join(d.home, "huddle-presets.json"))).toEqual([{ ...walker, prompt: "Walk it again." }]);
    expect(readJson(boardFile("huddle-presets.json"))).toEqual([]);

    // A lead without a mode starts in monitor mode; canEdit puts it in its own copy of the folder.
    const lead = await d.api("POST", `${base}/huddle-presets`, { name: "fixer-lead", prompt: "Fix and lead.", lead: true, canEdit: true });
    expect(lead.data).toMatchObject({ name: "fixer-lead", role: "Fixer lead", mode: "monitor", lead: true, canEdit: true, workspace: "own" });

    expect((await d.api("POST", `${base}/huddle-presets`, { name: "nope" })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddle-presets`, { name: "you", prompt: "x" })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddle-presets`, { name: "x", prompt: "x", scope: "everywhere" })).status).toBe(400);
    // Runs and huddle agents can't save or delete teammates.
    expect((await d.api("POST", `${base}/huddle-presets`, { name: "x", prompt: "x" }, { [RUN]: `${SLUG}/t_1` })).status).toBe(403);
    expect((await d.api("DELETE", `${base}/huddle-presets/walker`, undefined, { [AGENT]: "h_x/qa/tok" })).status).toBe(403);

    const del = await d.api("DELETE", `${base}/huddle-presets/walker`);
    expect(del.status).toBe(200);
    expect(del.data.reset).toBe(false);
    expect(del.data.presets.some((p: any) => p.name === "walker")).toBe(false);
    expect(readJson(join(d.home, "huddle-presets.json"))).toEqual([]);
    expect((await d.api("DELETE", `${base}/huddle-presets/walker`)).status).toBe(404);
    // A built-in can only be changed: deleting it is 409; deleting its board override resets it.
    expect((await d.api("DELETE", `${base}/huddle-presets/reviewer`)).status).toBe(409);
    expect((await d.api("PUT", `${base}/huddle-presets/reviewer`, { prompt: "Review my way." })).data).toMatchObject({ source: "board", base: "builtin", builtin: true });
    const reset = await d.api("DELETE", `${base}/huddle-presets/reviewer`);
    expect(reset.data.reset).toBe(true);
    expect(reset.data.presets.find((p: any) => p.name === "reviewer").source).toBe("builtin");
    expect((await d.api("DELETE", `${base}/huddle-presets/fixer-lead`)).status).toBe(200);
  });
});

describe("squads (huddle templates)", () => {
  test("save, change and delete a squad; POST /squads makes its teammates and refuses a taken name", async () => {
    const list = await d.api("GET", `${base}/huddle-templates`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.data.every((t: any) => typeof t.name === "string" && Array.isArray(t.roster) && "source" in t)).toBe(true);

    const made = await d.api("POST", `${base}/huddle-templates`, { name: "Pair", roster: [{ preset: "reviewer" }], maxCostUsd: 5 });
    expect(made.status).toBe(201);
    const pair = { name: "pair", label: "Pair", description: "", roster: [{ preset: "reviewer" }], rounds: null, maxCostUsd: 5, report: "", hostRules: "" };
    expect(made.data).toEqual({ ...pair, source: "board", base: null, builtin: false });
    const text = readFileSync(boardFile("huddle-templates.json"), "utf8");
    expect(text).toBe(JSON.stringify([pair], null, 2) + "\n");

    const changed = await d.api("PUT", `${base}/huddle-templates/pair`, { description: "Two eyes." });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ name: "pair", description: "Two eyes.", maxCostUsd: 5 });

    expect((await d.api("POST", `${base}/huddle-templates`, { name: "empty" })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddle-templates`, { name: "x", roster: [{ preset: "no-such-teammate" }] })).status).toBe(400);
    expect((await d.api("POST", `${base}/huddle-templates`, pair, { [AGENT]: "h_x/qa/tok" })).status).toBe(403);

    // POST /squads: people with no teammate become teammates at the same scope.
    const squad = { name: "walk-squad", roster: [{ handle: "walker", role: "Walker", prompt: "Walk." }] };
    const saved = await d.api("POST", `${base}/squads`, { squad, scope: "board" });
    expect(saved.status).toBe(201);
    expect(saved.data.teammates).toEqual({ created: ["walker"], reused: [] });
    expect(saved.data.squad).toMatchObject({ name: "walk-squad", roster: [{ handle: "walker", preset: "walker" }] });
    expect(readJson(boardFile("huddle-presets.json")).find((p: any) => p.name === "walker")).toMatchObject({ role: "Walker", prompt: "Walk." });
    expect(readJson(boardFile("huddle-templates.json")).some((t: any) => t.name === "walk-squad")).toBe(true);
    const again = await d.api("POST", `${base}/squads`, { squad, scope: "board" });
    expect(again.status).toBe(409);
    const replaced = await d.api("POST", `${base}/squads`, { squad: { ...squad, description: "v2" }, scope: "board", replace: true });
    expect(replaced.status).toBe(201);
    expect(replaced.data.teammates).toEqual({ created: [], reused: ["walker"] });
    expect(replaced.data.squad.description).toBe("v2");
    expect((await d.api("POST", `${base}/squads`, { squad, card: { nope: 1 } })).status).toBe(400);
    expect((await d.api("POST", `${base}/squads`, { squad, replace: true, card: { ticketId: "t_missing", uuid: "u1" } })).status).toBe(404);
    expect((await d.api("POST", `${base}/squads`, { squad }, { [RUN]: `${SLUG}/t_1` })).status).toBe(403);

    // A squad card in a ticket's chat is marked saved.
    const t = await newTicket("Card host");
    const carded = await d.api("POST", `${base}/squads`, { squad, replace: true, card: { ticketId: t.id, uuid: "tu_9" } });
    expect(carded.status).toBe(201);
    const after = (await d.api("GET", `${base}/tickets/${t.id}`)).data;
    expect(after.squadCards.tu_9).toMatchObject({ state: "saved", name: "walk-squad", scope: "board", teammates: { created: [], reused: ["walker"] } });

    const del = await d.api("DELETE", `${base}/huddle-templates/pair`);
    expect(del.status).toBe(200);
    expect(del.data.reset).toBe(false);
    expect(del.data.templates.some((x: any) => x.name === "pair")).toBe(false);
    expect((await d.api("DELETE", `${base}/huddle-templates/pair`)).status).toBe(404);
  });
});

describe("huddles", () => {
  test("start from a roster: answers, files, posts from the user, a helper and the host's run, findings, close, events", async () => {
    const ev = await events();
    try {
      const t = await newTicket("Roster host");
      expect((await d.api("POST", `${base}/huddles`, {})).status).toBe(400);
      expect((await d.api("POST", `${base}/huddles`, { ticketId: t.id }, { [RUN]: `${SLUG}/${t.id}` })).status).toBe(403);
      expect((await d.api("POST", `${base}/huddles`, { ticketId: "t_missing", roster: [{ preset: "reviewer" }] })).status).toBe(404);
      expect((await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "no-such" }] })).status).toBe(400);
      expect((await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }], maxCostUsd: -1 })).status).toBe(400);

      const started = await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }], topic: "The login page" });
      expect(started.status).toBe(201);
      const h = started.data;
      expect(h.id).toMatch(/^h_[a-z0-9_]+$/i);
      expect(h).toMatchObject({
        hostTicket: t.id, hostTitle: "Roster host", status: "live", maxCostUsd: 20, findings: [], invited: [], template: null,
        topic: "The login page", brief: { text: "Topic: The login page", by: "you" }, summary: null,
      });
      expect(h.participants.map((p: any) => [p.handle, p.kind])).toEqual([["you", "human"], ["main", "ticket-main"], ["reviewer", "agent"]]);
      // Tokens never leave the daemon; they are in the file on disk.
      expect(started.text).not.toContain("token");
      const saved = readJson(huddleFile(h.id));
      expect(saved).toMatchObject({ id: h.id, hostTicket: t.id, status: "live" });
      expect(typeof onDisk(h.id, "reviewer").token).toBe("string");
      expect(readFileSync(huddleFile(h.id), "utf8").endsWith("}\n")).toBe(true);
      const first = readJsonl(messagesFile(h.id))[0];
      expect(first).toMatchObject({ seq: 1, from: "system", kind: "system" });
      expect(first.text).toStartWith(`Huddle started on ticket ${t.id} "Roster host"`);
      expect((await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }] })).status).toBe(409);

      await ev.wait((e) => e.type === "huddle.updated" && e.profile === SLUG && e.huddle?.id === h.id, "huddle.updated");
      await ev.wait((e) => e.type === "huddle.message" && e.huddleId === h.id && e.message?.seq === 1, "huddle.message");
      // huddle.updated is followed by a ticket.updated for the host.
      await ev.wait((e) => e.type === "ticket.updated" && e.ticket?.id === t.id, "ticket.updated for the host");
      expect(JSON.stringify(ev.seen)).not.toContain('"token"');

      const one = await d.api("GET", `${base}/huddles/${h.id}`);
      expect(one.status).toBe(200);
      expect(one.data).toMatchObject({ huddle: { id: h.id }, you: "you", hasMore: false });
      expect(one.data.messages[0].seq).toBe(1);
      expect((await d.api("GET", `${base}/huddles/h_nosuch`)).status).toBe(404);
      const byTicket = await d.api("GET", `${base}/huddles?ticket=${t.id}`);
      expect(byTicket.status).toBe(200);
      expect(byTicket.data.map((x: any) => x.id)).toEqual([h.id]);
      expect((await d.api("GET", `${base}/huddles?open=1`)).data.some((x: any) => x.id === h.id)).toBe(true);

      // The user posts (no headers): @you, mentions parsed.
      const mine = await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "hello @reviewer" });
      expect(mine.status).toBe(201);
      expect(mine.data).toMatchObject({ from: "you", text: "hello @reviewer", mentions: ["reviewer"], kind: "message" });
      expect(mine.data.id).toMatch(/^m_/);
      expect(readJsonl(messagesFile(h.id)).at(-1)).toEqual(mine.data);
      await ev.wait((e) => e.type === "huddle.message" && e.message?.id === mine.data.id, "the user's message event");
      expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "  " })).status).toBe(400);
      expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "x".repeat(2001) })).status).toBe(400);

      // A helper proves who it is with its token; the host ticket's run is @main.
      const token = onDisk(h.id, "reviewer").token;
      const asReviewer = { [RUN]: `${SLUG}/${t.id}`, [AGENT]: `${h.id}/reviewer/${token}` };
      const helper = await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "@main looks fine", kind: "finding" }, asReviewer);
      expect(helper.status).toBe(201);
      expect(helper.data).toMatchObject({ from: "reviewer", kind: "finding", mentions: ["main"] });
      const asCurrent = await d.api("GET", `${base}/huddles/current`, undefined, asReviewer);
      expect(asCurrent.data).toMatchObject({ huddle: { id: h.id }, you: "reviewer" });
      expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "x" }, { [AGENT]: `${h.id}/reviewer/wrong` })).status).toBe(403);
      expect((await d.api("POST", `${base}/huddles/h_other/messages`, { text: "x" }, asReviewer)).status).toBe(403);
      const main = await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "noted" }, { [RUN]: `${SLUG}/${t.id}` });
      expect(main.data).toMatchObject({ from: "main" });
      expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "x" }, { [RUN]: `${SLUG}/t_stranger` })).status).toBe(403);
      expect((await d.api("GET", `${base}/huddles/current`)).status).toBe(400);
      // A helper (not a lead) can't change the findings or close the huddle.
      expect((await d.api("POST", `${base}/huddles/${h.id}/findings`, { action: "add", text: "x" }, asReviewer)).status).toBe(403);
      expect((await d.api("POST", `${base}/huddles/${h.id}/close`, {}, asReviewer)).status).toBe(403);

      // Findings: the user adds and resolves; anyone lists.
      const added = await d.api("POST", `${base}/huddles/${h.id}/findings`, { action: "add", text: "The button is hidden on phones" });
      expect(added.status).toBe(200);
      expect(added.data).toEqual([{ id: "f1", text: "The button is hidden on phones", by: "you", status: "open", resolvedBy: null, at: expect.any(String) }]);
      expect((await d.api("POST", `${base}/huddles/${h.id}/findings`, { action: "add" })).status).toBe(400);
      const resolved = await d.api("POST", `${base}/huddles/${h.id}/findings`, { action: "resolve", id: "f1" });
      expect(resolved.data[0]).toMatchObject({ id: "f1", status: "resolved", resolvedBy: "you" });
      expect((await d.api("POST", `${base}/huddles/${h.id}/findings`, { action: "resolve", id: "f9" })).status).toBe(404);
      expect((await d.api("POST", `${base}/huddles/${h.id}/findings`, {}, asReviewer)).data).toEqual(resolved.data);
      expect(readJson(huddleFile(h.id)).findings).toEqual(resolved.data);
      const texts = readJsonl(messagesFile(h.id)).map((m: any) => m.text);
      expect(texts).toContain("@you pinned finding f1: The button is hidden on phones");
      expect(texts).toContain("@you resolved finding f1.");

      const brief = await d.api("PUT", `${base}/huddles/${h.id}/brief`, { text: "Goal: ship it." });
      expect(brief.data.brief).toMatchObject({ text: "Goal: ship it.", by: "you" });
      expect((await d.api("PUT", `${base}/huddles/${h.id}/brief`, { text: "x" }, asReviewer)).status).toBe(403);

      // Close: the user's alone; the history stays, read-only, and the board writes a summary.
      const closed = await d.api("POST", `${base}/huddles/${h.id}/close`, {});
      expect(closed.status).toBe(200);
      expect(closed.data.status).toBe("closed");
      expect(typeof closed.data.closedAt).toBe("string");
      expect(readJson(huddleFile(h.id))).toMatchObject({ status: "closed", closedAt: closed.data.closedAt });
      expect(readJsonl(messagesFile(h.id)).some((m: any) => m.text === "Huddle closed by @you. The history stays, read-only.")).toBe(true);
      expect((await d.api("POST", `${base}/huddles/${h.id}/messages`, { text: "late" })).status).toBe(409);
      // The host never ran, so the board writes the summary itself, in the host's outputs folder.
      const summary = join(d.home, "profiles", SLUG, "tickets", t.id, "outputs", "huddles", h.id, "summary.md");
      await until(() => existsSync(summary), 15_000, "the huddle summary");
      expect(readFileSync(summary, "utf8")).toStartWith("# Huddle summary\n");
      expect((await d.api("GET", `${base}/huddles/${h.id}`)).data.huddle.summary).toBe(`huddles/${h.id}/summary.md`);
      expect((await d.api("GET", `${base}/huddles?open=1`)).data.some((x: any) => x.id === h.id)).toBe(false);
      await ev.wait((e) => e.type === "huddle.updated" && e.huddle?.id === h.id && e.huddle.status === "closed", "the closed huddle's event");
    } finally {
      await ev.close();
    }
  }, 60_000);

  test("start from a squad; a helper that changes files hands in, the user rejects and accepts", async () => {
    const tpl = await d.api("POST", `${base}/huddle-templates`, { name: "fixers", roster: [{ handle: "fixer", role: "Fixer", prompt: "Fix it.", canEdit: true }], maxCostUsd: 7 });
    expect(tpl.status).toBe(201);
    const t = await newTicket("Squad host");
    const started = await d.api("POST", `${base}/huddles`, { ticketId: t.id, squad: "fixers" });
    expect(started.status).toBe(201);
    const h = started.data;
    expect(h).toMatchObject({ template: "fixers", maxCostUsd: 7 });
    expect(typeof h.brief.text).toBe("string");
    expect(h.participants.find((p: any) => p.handle === "fixer")).toMatchObject({ kind: "agent", canEdit: true, workspace: "own" });
    expect((await d.api("POST", `${base}/huddles`, { ticketId: t.id, squad: "no-such-squad" })).status).toBe(404);

    // Its copy of the folder is made when its first run starts.
    const copy: string = await until(() => onDisk(h.id, "fixer")?.copy?.dir, 20_000, "the helper's copy of the folder");
    await until(() => readJson(huddleFile(h.id)).participants.find((p: any) => p.handle === "fixer").status !== "working", 20_000, "the helper's turn to end");
    const as = { [RUN]: `${SLUG}/${t.id}`, [AGENT]: `${h.id}/fixer/${onDisk(h.id, "fixer").token}` };

    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "nothing yet" }, as)).status).toBe(409);
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "x" })).status).toBe(400);
    writeFileSync(join(copy, "first.txt"), "one\n");
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "  " }, as)).status).toBe(400);
    const c1 = await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "Added first.txt" }, as);
    expect(c1.status).toBe(201);
    expect(c1.data).toMatchObject({ id: "c1", from: "fixer", summary: "Added first.txt", status: "waiting" });
    expect(c1.data.files).toEqual([expect.objectContaining({ path: "first.txt", change: "added" })]);
    expect(readJsonl(messagesFile(h.id)).at(-1)).toMatchObject({ from: "fixer", kind: "handin", handIn: "c1" });
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "again" }, as)).status).toBe(409);
    // The helper can't decide on its own hand-in.
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins/c1/accept`, {}, as)).status).toBe(403);

    const rejected = await d.api("POST", `${base}/huddles/${h.id}/hand-ins/c1/reject`, { reason: "Not this file" });
    expect(rejected.status).toBe(200);
    expect(rejected.data).toMatchObject({ id: "c1", status: "rejected", by: "you", reason: "Not this file" });
    expect(existsSync(join(d.project, "first.txt"))).toBe(false);
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins/c1/accept`, {})).status).toBe(409);
    expect((await d.api("POST", `${base}/huddles/${h.id}/hand-ins/c9/accept`, {})).status).toBe(404);

    writeFileSync(join(copy, "second.txt"), "two\n");
    const c2 = await d.api("POST", `${base}/huddles/${h.id}/hand-ins`, { summary: "Added second.txt" }, as);
    expect(c2.status).toBe(201);
    expect(c2.data.id).toBe("c2");
    const accepted = await d.api("POST", `${base}/huddles/${h.id}/hand-ins/c2/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.data).toMatchObject({ id: "c2", status: "accepted", by: "you" });
    // A plain folder (no version history): the files land in the board's folder itself.
    expect(readFileSync(join(d.project, "second.txt"), "utf8")).toBe("two\n");
    expect(readJson(huddleFile(h.id)).handIns.map((x: any) => [x.id, x.status])).toEqual([["c1", "rejected"], ["c2", "accepted"]]);

    expect((await d.api("POST", `${base}/huddles/${h.id}/close`, {})).data.status).toBe("closed");
  }, 60_000);

  test("the budget stops the huddle; stop, resume with more budget and close are the user's", async () => {
    const t = await newTicket("Budget host");
    const started = await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }], maxCostUsd: 0.005 });
    expect(started.status).toBe(201);
    const h = started.data;
    // The helper's first turn reports $0.01: over the $0.005 cap.
    const stopped = await until(async () => {
      const r = (await d.api("GET", `${base}/huddles/${h.id}`)).data.huddle;
      return r.status === "stopped" ? r : null;
    }, 20_000, "the budget stop");
    expect(stopped).toMatchObject({ stopReason: "budget", maxCostUsd: 0.005 });
    expect(stopped.participants.find((p: any) => p.handle === "reviewer")).toMatchObject({ status: "stopped" });
    expect(stopped.participants.find((p: any) => p.handle === "reviewer").costUsd).toBeGreaterThanOrEqual(0.01);
    const stopLine = readJsonl(messagesFile(h.id)).findLast((m: any) => m.kind === "system" && m.text.startsWith("■ Paused at the $0.01 budget"));
    expect(stopLine).toMatchObject({ from: "system", mentions: ["you"] });
    expect(readJson(huddleFile(h.id))).toMatchObject({ status: "stopped", stopReason: "budget" });

    const helper = { [RUN]: `${SLUG}/${t.id}`, [AGENT]: `${h.id}/reviewer/${onDisk(h.id, "reviewer").token}` };
    for (const a of ["stop", "resume", "close"]) expect((await d.api("POST", `${base}/huddles/${h.id}/${a}`, {}, helper)).status).toBe(403);
    const resumed = await d.api("POST", `${base}/huddles/${h.id}/resume`, { addBudgetUsd: 5 });
    expect(resumed.status).toBe(200);
    expect(resumed.data.status).toBe("live");
    expect(resumed.data.maxCostUsd).toBeCloseTo(5.005, 6);
    const stop = await d.api("POST", `${base}/huddles/${h.id}/stop`, {});
    expect(stop.status).toBe(200);
    expect(stop.data.status).toBe("stopped");
    expect((await d.api("POST", `${base}/huddles/${h.id}/close`, {})).data.status).toBe("closed");
  }, 60_000);
});
