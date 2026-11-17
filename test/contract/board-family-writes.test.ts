// Outside-in contract: the family writes that need no run (Rust port R2b, docs/rust-port-board-plan.md): features
// and sub-features, partOf links and their refusals, rounds, gather (groups, a new group, hiding cards, deep tickets
// moved up), showOnBoard, own work, plan refusals, the feature status (status.json, status.md, notes, pull
// requests), the family routes and deleting a feature's top. One script of requests, checked against any server; under
// a Rust server (CKANBAN_CONTRACT_DAEMON set) the same script also runs on Bun alone and both must answer the same and
// leave the same bytes in the data folder (ids and times aside). Nothing here starts a run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BUN_DAEMON_CMD, type Daemon, startDaemon, until } from "./daemon";

const RUST = !!process.env.CKANBAN_CONTRACT_DAEMON;
const SLUG = "fam";

interface Step {
  what: string;
  status: number;
  data: unknown;
}

async function script(d: Daemon, check: boolean): Promise<Step[]> {
  const steps: Step[] = [];
  const P = `/api/profiles/${SLUG}`;
  const call = async (what: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await d.api(method, path, body, headers);
    steps.push({ what, status: r.status, data: r.data });
    if (check) expect({ what, status: r.status < 500 }).toEqual({ what, status: true });
    return r;
  };
  const want = (r: { status: number }, s: number, what: string) => {
    if (check) expect({ what, status: r.status }).toEqual({ what, status: s });
  };
  const make = async (what: string, body: Record<string, unknown>) => {
    const r = await call(what, "POST", `${P}/tickets`, body);
    want(r, 201, what);
    return r.data as { id: string };
  };
  const T = (id: string) => `${P}/tickets/${id}`;

  want(await call("board", "POST", "/api/profiles", { name: "Fam", path: d.project }), 201, "board");

  // A feature with groups, a round, tickets two levels deep and a sub-feature.
  const top = await make("top", { title: "The feature", body: "Ship it." });
  const g1 = await make("group", { title: "Phase one", kind: "group", partOf: top.id });
  const a = await make("a", { title: "Step a", partOf: g1.id, tags: ["x"] });
  const r1 = await make("round", { title: "whatever", kind: "round", partOf: g1.id });
  if (check) expect((await d.api("GET", T(r1.id))).data).toMatchObject({ title: "Testing round 1", partOf: top.id });
  const r2 = await make("round 2", { title: "x", kind: "round", partOf: top.id });
  if (check) expect((await d.api("GET", T(r2.id))).data.title).toBe("Testing round 2");
  want(await call("too deep", "POST", `${P}/tickets`, { title: "Deep", partOf: a.id }), 400, "too deep");
  const sub = await make("sub", { title: "Sub", main: true, partOf: top.id });
  want(await call("sub under sub", "POST", `${P}/tickets`, { title: "Subsub", main: true, partOf: sub.id }), 400, "sub under sub");
  await make("sub's own", { title: "Sub's own", partOf: sub.id });

  // Links: link, unlink, loops, depth, a whole part that would go too deep.
  const loose = await make("loose", { title: "Loose" });
  const kid = await make("kid", { title: "Kid", partOf: loose.id });
  await make("grandkid", { title: "Grandkid", partOf: kid.id });
  want(await call("link into a", "PATCH", T(loose.id), { partOf: a.id }), 400, "too deep part");
  want(await call("loop", "PATCH", T(loose.id), { partOf: kid.id }), 400, "loop");
  want(await call("self", "PATCH", T(loose.id), { partOf: loose.id }), 400, "self");
  want(await call("unknown", "PATCH", T(loose.id), { partOf: "t_20000101_none" }), 400, "unknown");
  want(await call("link kid", "PATCH", T(kid.id), { partOf: top.id }), 200, "link kid");
  want(await call("unlink kid", "PATCH", T(kid.id), { partOf: null }), 200, "unlink kid");
  want(await call("relink kid", "PATCH", T(kid.id), { partOf: loose.id }), 200, "relink kid");
  want(await call("not related", "PATCH", T(loose.id), { parentSuggestion: null }), 200, "not related");

  // Gather: into the feature, a new group, hidden cards, skips, deep tickets moved up.
  const h1 = await make("h1", { title: "Hide me" });
  const gathered = await call("gather", "POST", `${T(top.id)}/gather`, {
    tickets: [{ id: kid.id, group: g1.id }, { id: loose.id }, { id: h1.id, group: "new" }, { id: "t_20000101_none" }, { id: top.id }, { id: sub.id }],
    newGroup: "Phase two", hide: true,
  });
  want(gathered, 200, "gather");
  if (check) {
    const g = gathered.data as any;
    expect(g.movedUp.length).toBeGreaterThan(0);
    expect(g.group).toMatchObject({ title: "Phase two", kind: "group" });
    expect(g.kept.map((k: any) => k.id)).toContain(sub.id);
  }
  want(await call("gather empty", "POST", `${T(top.id)}/gather`, { tickets: [] }), 400, "gather empty");
  want(await call("gather bad hide", "POST", `${T(top.id)}/gather`, { tickets: [{ id: h1.id }], hide: 1 }), 400, "bad hide");
  want(await call("show again", "PATCH", T(kid.id), { showOnBoard: true }), 200, "show again");
  want(await call("hide main", "PATCH", T(sub.id), { showOnBoard: false }), 400, "hide main");
  want(await call("hide top", "PATCH", T(top.id), { showOnBoard: false }), 400, "hide top");

  // Own work and plans without a run.
  want(await call("own work of a card", "POST", `${T(a.id)}/own-work`, {}), 400, "own work card");
  want(await call("plan start, no tasks", "POST", `${T(top.id)}/plan`, { action: "start" }), 400, "plan no tasks");
  want(await call("plan pause, no plan", "POST", `${T(top.id)}/plan`, { action: "pause" }), 400, "plan pause");
  want(await call("plan bogus", "POST", `${T(top.id)}/plan`, { action: "bogus" }), 400, "plan bogus");
  want(await call("plan start, a card", "POST", `${T(a.id)}/plan`, { action: "start" }), 400, "plan card");

  // The feature status.
  want(await call("status before", "GET", `${T(top.id)}/status`), 200, "status before");
  want(await call("status", "POST", `${T(a.id)}/status`, { goal: "  Ship the feature  ", done: "Groups made", next: "Test it", waiting: null }), 200, "status");
  want(await call("status prs", "POST", `${T(top.id)}/status`, { prs: ["https://github.com/o/r/pull/7", "https://github.com/o/r/pull/8"] }), 200, "status prs");
  want(await call("status pr note", "POST", `${T(top.id)}/status`, { prNotes: { "https://github.com/o/r/pull/7": "on staging", "https://example.com/x": "dropped" } }), 200, "pr note");
  want(await call("status clear", "POST", `${T(top.id)}/status`, { done: null, broken: "" }), 200, "status clear");
  want(await call("status long", "POST", `${T(top.id)}/status`, { broken: "word ".repeat(600) }), 200, "status long");
  want(await call("status nothing", "POST", `${T(top.id)}/status`, {}), 400, "status nothing");
  want(await call("status bad", "POST", `${T(top.id)}/status`, { next: 5 }), 400, "status bad");
  want(await call("note", "POST", `${T(top.id)}/status/notes`, { text: "  Remember the phone  " }), 200, "note");
  want(await call("note empty", "POST", `${T(top.id)}/status/notes`, { text: "   " }), 400, "note empty");
  want(await call("sub status", "POST", `${T(sub.id)}/status`, { next: "Sub's next step" }), 200, "sub status");
  want(await call("status after", "GET", `${T(top.id)}/status`), 200, "status after");
  want(await call("family", "GET", `${T(a.id)}/family`), 200, "family");
  want(await call("family view", "GET", `${T(top.id)}/family-view`), 200, "family view");

  // Landing rules without a run: who may call, a main ticket only, a summary; a plain folder only records it.
  want(await call("merge from the user", "POST", `${T(a.id)}/merge-into-main`, {}), 403, "merge user");
  want(await call("merge from a huddle", "POST", `${T(a.id)}/merge-into-main`, {}, { "x-ckanban-run": `${SLUG}/${a.id}`, "x-ckanban-huddle-agent": "qa" }), 403, "merge huddle");
  want(await call("merge not a tool", "POST", `${T(a.id)}/merge-into-main`, {}, { "x-ckanban-run": `${SLUG}/${a.id}` }), 409, "merge not tool");
  want(await call("land another run", "POST", `${T(top.id)}/land`, { summary: "x" }, { "x-ckanban-run": `${SLUG}/${a.id}` }), 403, "land other");
  want(await call("land other board", "POST", `${T(top.id)}/land`, { summary: "x" }, { "x-ckanban-run": `elsewhere/${top.id}` }), 403, "land board");
  want(await call("land a card", "POST", `${T(a.id)}/land`, { summary: "x" }), 409, "land card");
  want(await call("land no summary", "POST", `${T(top.id)}/land`, { summary: "  " }), 409, "land empty");
  const landed = await call("land", "POST", `${T(top.id)}/land`, { summary: "First milestone" });
  if (check && landed.status !== 200) expect(landed.data).toBeNull();

  // A new feature that gathers tickets; deleting a feature's top unlinks its family.
  const lone = await make("lone", { title: "Lone" });
  const nf = await call("new feature", "POST", `${P}/tickets`, { title: "New feature", main: true, gather: [{ id: lone.id, group: null }, { id: "t_20000101_none" }] });
  want(nf, 201, "new feature");
  want(await call("delete top", "DELETE", T((nf.data as any).id)), 204, "delete top");
  want(await call("lone after", "GET", T(lone.id)), 200, "lone after");
  await call("board", "GET", `${P}/tickets?scope=board`);
  return steps;
}

/** The board's ticket files (ticket.md, comments, status.json, status.md), by path under the data folder. */
function files(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(home, f)] = readFileSync(f, "utf8");
    }
  };
  const dir = join(home, "profiles", SLUG);
  if (existsSync(dir)) walk(dir);
  for (const k of Object.keys(out)) if (k.endsWith("side-spend.jsonl")) delete out[k];
  return out;
}

/** Ids and times replaced by their order of appearance, so two runs of the script compare. */
function normalize(text: string): string {
  const seen = new Map<string, string>();
  const name = (kind: string) => (m: string) => {
    if (!seen.has(m)) seen.set(m, `<${kind}${seen.size}>`);
    return seen.get(m)!;
  };
  return text
    .replace(/t_\d{8}_[a-z0-9]{4}/g, name("ticket"))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (m) => (m.startsWith("9999") ? m : "<time>"))
    .replace(/"id": ?"[0-9a-z]{8}"/g, name("id"))
    .replace(/^id: [0-9a-z]{8}$/gm, name("id"))
    .replace(/\/tmp\/[^"\n]*|\/private\/var\/[^"\n]*|\/var\/folders\/[^"\n]*/g, "<path>")
    // Bun's linker settles each new ticket the user made (R12): its marks aren't R2b's.
    .replace(/^parentChecked: true\n/gm, "")
    .replace(/^parentSuggestion: null\n/gm, "")
    .replace(/,?"parent(Checked|Suggestion)":(true|null)/g, "");
}

/** Ticket ids by their first appearance in the script's answers (the same order on both servers). */
function ticketNames(steps: Step[]): (text: string) => string {
  const names = new Map<string, string>();
  for (const m of JSON.stringify(steps).matchAll(/t_\d{8}_[a-z0-9]{4}/g)) if (!names.has(m[0])) names.set(m[0], `<t${names.size}>`);
  // familySig lists the family sorted by ticket id, which differs between the two runs: sorted again by name.
  return (text) => text.replace(/t_\d{8}_[a-z0-9]{4}/g, (m) => names.get(m) ?? m)
    .replace(/("familySig": ?")([^"]*)"/g, (_, head, sig) => `${head}${sig.split("|").sort().join("|")}"`);
}

let d: Daemon;
let steps: Step[] = [];

beforeAll(async () => {
  d = await startDaemon();
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

describe("family writes without a run", () => {
  test("the script's answers and files", async () => {
    steps = await script(d, true);
    const status = join(d.home, "profiles", SLUG, "tickets");
    const tops = readdirSync(status).filter((id) => existsSync(join(status, id, "outputs", "status.json")));
    expect(tops.length).toBe(2);
  }, 60_000);
});

describe.if(RUST)("Rust and Bun write the same", () => {
  test("the same answers and the same bytes in the data folder", async () => {
    const bun = await startDaemon({ cmd: BUN_DAEMON_CMD, env: { CKANBAN_RUST_BOARD: "0" } });
    try {
      const theirs = await script(bun, false);
      const dir = join(bun.home, "profiles", SLUG, "tickets");
      await until(() => readdirSync(dir).every((id) => readFileSync(join(dir, id, "ticket.md"), "utf8").includes("parentChecked")) || null, 15_000, "Bun's linker").catch(() => null);
      const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)])) : v;
      const [myIds, bunIds] = [ticketNames(steps), ticketNames(theirs)];
      const mine = steps.map((s) => ({ what: s.what, status: s.status, data: normalize(myIds(JSON.stringify(sorted(s.data)))) }));
      const bunSteps = theirs.map((s) => ({ what: s.what, status: s.status, data: normalize(bunIds(JSON.stringify(sorted(s.data)))) }));
      for (let i = 0; i < Math.max(mine.length, bunSteps.length); i++) expect(mine[i]).toEqual(bunSteps[i]);
      const [ours, bunFiles] = [files(d.home), files(bun.home)];
      for (const end of ["ticket.md", "comments.jsonl", "status.json", "status.md"]) {
        expect({ end, found: Object.keys(ours).some((k) => k.endsWith(end)) }).toEqual({ end, found: true });
      }
      const norm = (fs: Record<string, string>, ids: (t: string) => string) =>
        Object.fromEntries(Object.entries(fs).map(([k, v]) => [ids(k), normalize(ids(v))]).sort(([x], [y]) => x.localeCompare(y)));
      expect(norm(ours, ticketNames(steps))).toEqual(norm(bunFiles, ticketNames(theirs)));
    } finally {
      await bun.stop();
    }
  }, 120_000);
});
