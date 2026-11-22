// Outside-in contract: runs on a board whose folder has version history (a temp git repo with a temp bare remote, and
// a second temp repo without a remote), on the fake Claude's per-ticket scripts: a ticket gets its own copy of the
// folder (a worktree on branch ck/<id>-<title slug>), a tool ticket starts from its main ticket's copy and merges into
// it (merge_into_main, POST .../merge-into-main), and the main ticket lands its copy (land_milestone, POST .../land):
// push plus a pull request with a remote, a merge into the project folder without one. See contracts/api.md ("Ticket
// cards, family, plans and work") and contracts/data-files.md ("Outside the data folder").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { parseTicketFile, readJsonl } from "./files";
import { events, running, Scripts, scriptDir, settled, sh, view } from "./runs";
import { schemaProblems } from "./schema";

let d: Daemon;
let s: Scripts;
let root: string;
let remote: string;
let local: string;
let ev: Awaited<ReturnType<typeof events>>;
const SLUG = "git";
const LOCAL = "local";
const PR = "https://github.com/test/repo/pull/42";

/** A repo on main with one commit and a committer of its own (the temp HOME has no git config). */
function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], dir);
  sh(["git", "config", "user.name", "Contract"], dir);
  sh(["git", "config", "user.email", "contract@example.com"], dir);
  if (!existsSync(join(dir, "README.md"))) writeFileSync(join(dir, "README.md"), "# Contract test project\n");
  sh(["git", "add", "-A"], dir);
  sh(["git", "commit", "-q", "-m", "first"], dir);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ck-contract-rungit-"));
  s = new Scripts(scriptDir(root));
  remote = join(root, "remote.git");
  local = join(root, "local", "project");
  sh(["git", "init", "-q", "--bare", "-b", "main", remote], root);
  initRepo(local);
  const ghLog = join(root, "gh-calls.jsonl");
  d = await startDaemon({
    env: { FAKE_SCRIPT_DIR: s.dir, GH_LOG: ghLog, GH_STATE: join(root, "gh-state") },
    // gh: `pr create` opens a fake pull request; `pr view` answers from GH_STATE (OPEN unless the file says otherwise);
    // `pr merge` marks it MERGED; everything else is "not logged in" (no GitHub is ever reached).
    stubs: {
      gh: `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args: a, cwd: process.cwd() }) + "\\n");
const state = () => (fs.existsSync(process.env.GH_STATE) ? fs.readFileSync(process.env.GH_STATE, "utf8").trim() : "OPEN");
if (a[0] === "pr" && a[1] === "create") { console.log("${PR}"); process.exit(0); }
if (a[0] === "pr" && a[1] === "view" && a.includes("-q")) { console.log(state()); process.exit(0); }
if (a[0] === "pr" && a[1] === "view") {
  console.log(JSON.stringify({ number: 42, state: state(), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example/1" }], reviewDecision: "", comments: [] }));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "merge") { fs.writeFileSync(process.env.GH_STATE, "MERGED"); process.exit(0); }
console.error("To get started with GitHub CLI, please run:  gh auth login"); process.exit(4);
`,
    },
    before: ({ project }) => {
      initRepo(project);
      sh(["git", "remote", "add", "origin", remote], project);
      sh(["git", "push", "-q", "-u", "origin", "main"], project);
    },
  });
  expect((await d.api("POST", "/api/profiles", { name: "Git", path: d.project })).status).toBe(201);
  expect((await d.api("POST", "/api/profiles", { name: "Local", path: local })).status).toBe(201);
  ev = await events(d);
}, 60_000);

afterAll(async () => {
  ev?.close();
  await d?.stop();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

const T = (slug: string) => `/api/profiles/${slug}/tickets`;
const tdir = (slug: string, id: string) => join(d.home, "profiles", slug, "tickets", id);
const meta = (slug: string, id: string) => parseTicketFile(readFileSync(join(tdir(slug, id), "ticket.md"), "utf8")).meta;
const comments = (slug: string, id: string) => readJsonl(join(tdir(slug, id), "comments.jsonl"));
const ghCalls = () => readJsonl(join(root, "gh-calls.jsonl"));
const real = (p: string) => realpathSync(p);

async function create(slug: string, title: string, body: string, status = "ready"): Promise<any> {
  const r = await d.api("POST", T(slug), { title, body, status, mode: "auto" });
  expect(r.status).toBe(201);
  return r.data;
}

describe("ticket copies (worktrees)", () => {
  test("a ticket on a git board runs in its own copy on its own branch; the project folder is left alone", async () => {
    const tag = s.set("copy", [{ files: { "copy.txt": "made in the copy\n" }, sh: ["git add copy.txt", "git commit -q -m 'add copy.txt'"] }]);
    const t = await create(SLUG, "Make a copy", `x ${tag}`);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.outcome).toBe("done");
    // <parent of the board folder>/.ckanban-worktrees/<slug>/<ticket id>, branch ck/<id>-<title slug>.
    expect(v.worktree).toBe(join(dirname(d.project), ".ckanban-worktrees", SLUG, t.id));
    expect(v.branch).toStartWith(`ck/${t.id}-make-a-copy`);
    expect(meta(SLUG, t.id)).toMatchObject({ worktree: v.worktree, branch: v.branch });
    expect(s.runs("copy")[0].cwd).toBe(real(v.worktree));
    expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], v.worktree)).toBe(v.branch);
    expect(readFileSync(join(v.worktree, "copy.txt"), "utf8")).toBe("made in the copy\n");
    // The project folder is untouched: still on main, without the file, nothing uncommitted.
    expect(existsSync(join(d.project, "copy.txt"))).toBe(false);
    expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], d.project)).toBe("main");
    expect(sh(["git", "status", "--porcelain"], d.project)).toBe("");
    // The branch is in the project's own repo, one commit ahead of main.
    expect(sh(["git", "rev-list", "--count", `main..${v.branch}`], d.project)).toBe("1");
    // The diff route shows the copy's change against the base.
    const diff = await d.api("GET", `${T(SLUG)}/${t.id}/diff`);
    expect(diff.status).toBe(200);
    expect(JSON.stringify(diff.data)).toContain("copy.txt");
    // A second run of the same ticket reuses the copy.
    s.set("copy", [{}]);
    expect((await d.api("POST", `${T(SLUG)}/${t.id}/chat`, { text: "again" })).status).toBe(202);
    await until(() => s.runs("copy").length === 2, 30_000, "second run");
    await settled(d, SLUG, t.id, (x) => x.runCount === 2);
    expect(s.runs("copy")[1].cwd).toBe(real(v.worktree));
  }, 90_000);

  test("a plain folder board has no copy: GET /diff is 404 (no version history)", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect((await d.api("POST", "/api/profiles", { name: "Plain", path: plain })).status).toBe(201);
    const tag = s.set("plain", [{ files: { "edited.txt": "in place\n" } }]);
    const t = await create("plain", "Edit in place", `x ${tag}`);
    const v = await settled(d, "plain", t.id, (x) => x.status === "review");
    expect(v.worktree).toBeNull();
    expect(v.branch).toBeNull();
    expect(s.runs("plain")[0].cwd).toBe(real(plain));
    expect(readFileSync(join(plain, "edited.txt"), "utf8")).toBe("in place\n");
    expect((await d.api("GET", `${T("plain")}/${t.id}/diff`)).status).toBe(404);
  }, 60_000);
});

describe("a main ticket's tool ticket merges into its copy, then the main ticket lands it", () => {
  let main: any;
  let tool: any;

  test("the main ticket's run creates a tool ticket; it starts from the main copy, commits and merges into it", async () => {
    const toolTag = s.set("tool", [{
      files: { "feature.txt": "from the tool ticket\n" },
      sh: ["git add feature.txt", "git commit -q -m 'add feature'"],
      calls: [{ method: "POST", path: `${T(SLUG)}/{ticket}/merge-into-main` }, { method: "POST", path: `${T(SLUG)}/{ticket}/merge-into-main` }],
      summary: "Added the feature.",
    }]);
    const mainTag = s.set("main", [{
      calls: [{ method: "POST", path: T(SLUG), body: { title: "Build the feature", body: `## Objective\nAdd it. ${toolTag}`, kind: "build" } }],
      summary: "Started the build step.",
    }]);
    main = await create(SLUG, "The feature", `Plan it. ${mainTag}`);
    await until(() => s.out("main").length === 1, 30_000, "main run's create call");
    const made = s.out("main")[0];
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ title: "Build the feature", tool: true, parentId: main.id, mode: "auto", kind: "build" });
    tool = made.data;
    expect(comments(SLUG, tool.id).some((c) => c.text.startsWith(`Tool ticket of ${main.id}`))).toBe(true);

    // The board starts the step on its own; it merges once (the second call has nothing new).
    await until(() => s.out("tool").length === 2, 60_000, "tool run's merge calls");
    const m = await settled(d, SLUG, main.id);
    expect(m.main).toBe(true);
    expect(m.branch).toStartWith(`ck/${main.id}-`);
    const t = await settled(d, SLUG, tool.id, (x) => x.outcome === "done");
    expect(t.branch).toStartWith(`ck/${tool.id}-build-the-feature`);
    expect(t.worktree).toBe(join(dirname(d.project), ".ckanban-worktrees", SLUG, tool.id));
    expect(s.runs("tool")[0].cwd).toBe(real(t.worktree));
    // The tool ticket's copy started from the main ticket's branch (the fast-forward merge below needs that).

    const [first, second] = s.out("tool");
    expect(first).toMatchObject({ status: 200, data: { message: `Merged 1 commit into the main ticket's copy (${m.branch}).` } });
    expect(second).toMatchObject({ status: 200, data: { message: "Nothing new to merge: the main ticket's copy already has your work." } });
    const toolHead = sh(["git", "rev-parse", t.branch], d.project);
    expect(sh(["git", "rev-parse", m.branch], d.project)).toBe(toolHead);
    expect(meta(SLUG, tool.id).merged).toBe(toolHead);
    expect(comments(SLUG, main.id).some((c) => c.text === `Merged 1 commit of ${tool.id} "Build the feature" into this ticket's copy.`)).toBe(true);
    if (m.worktree && existsSync(m.worktree)) expect(readFileSync(join(m.worktree, "feature.txt"), "utf8")).toBe("from the tool ticket\n");
    // The project folder's main is untouched until the main ticket lands.
    expect(existsSync(join(d.project, "feature.txt"))).toBe(false);
  }, 120_000);

  test("merge-into-main refusals: another ticket's header 403, a main ticket 409, uncommitted changes 409, a moved main copy 409", async () => {
    const P = `${T(SLUG)}/${tool.id}/merge-into-main`;
    expect((await d.api("POST", P, {})).status).toBe(403);
    expect((await d.api("POST", P, {}, { "x-ckanban-run": `${SLUG}/${main.id}` })).status).toBe(403);
    expect((await d.api("POST", P, {}, { "x-ckanban-run": `${SLUG}/${tool.id}`, "x-ckanban-huddle-agent": "qa" })).status).toBe(403);
    const notTool = await d.api("POST", `${T(SLUG)}/${main.id}/merge-into-main`, {}, { "x-ckanban-run": `${SLUG}/${main.id}` });
    expect(notTool.status).toBe(409);
    expect(notTool.data.error).toBe("only a tool ticket merges into its main ticket's copy");

    const t = await view(d, SLUG, tool.id);
    writeFileSync(join(t.worktree, "dirty.txt"), "not committed\n");
    const dirty = await d.api("POST", P, {}, { "x-ckanban-run": `${SLUG}/${tool.id}` });
    expect(dirty.status).toBe(409);
    expect(dirty.data.error).toContain("commit them, then call merge_into_main again");
    rmSync(join(t.worktree, "dirty.txt"));

    // The main copy moves on (another commit there): the tool branch is no longer ahead of it.
    const m = await view(d, SLUG, main.id);
    const mainDir = m.worktree && existsSync(m.worktree) ? m.worktree : null;
    if (mainDir) {
      writeFileSync(join(mainDir, "other.txt"), "x\n");
      sh(["git", "add", "other.txt"], mainDir);
      sh(["git", "commit", "-q", "-m", "other"], mainDir);
    } else {
      const tmpWt = join(root, "tmp-main-wt");
      sh(["git", "worktree", "add", "-q", tmpWt, m.branch], d.project);
      writeFileSync(join(tmpWt, "other.txt"), "x\n");
      sh(["git", "add", "other.txt"], tmpWt);
      sh(["git", "commit", "-q", "-m", "other"], tmpWt);
      sh(["git", "worktree", "remove", "--force", tmpWt], d.project);
    }
    writeFileSync(join(t.worktree, "more.txt"), "more\n");
    sh(["git", "add", "more.txt"], t.worktree);
    sh(["git", "commit", "-q", "-m", "more"], t.worktree);
    const moved = await d.api("POST", P, {}, { "x-ckanban-run": `${SLUG}/${tool.id}` });
    expect(moved.status).toBe(409);
    expect(moved.data.error).toContain("The main ticket's copy moved since you last merged it (try 1 of");
    expect(moved.data.error).toContain(`git merge ${m.branch}`);
    expect(meta(SLUG, tool.id).mergeFails).toBe(1);
    // Merge the main copy in, as the error says, and retry: it goes through.
    sh(["git", "merge", "-q", "--no-edit", m.branch], t.worktree);
    const ok = await d.api("POST", P, {}, { "x-ckanban-run": `${SLUG}/${tool.id}` });
    expect(ok.status).toBe(200);
    expect(ok.data.message).toBe(`Merged 2 commits into the main ticket's copy (${m.branch}).`); // "more" and the merge commit
    expect(meta(SLUG, tool.id).mergeFails).toBe(0);
  }, 60_000);

  test("land with a remote: pushes the main copy and opens one pull request; a second land updates it", async () => {
    const m = await settled(d, SLUG, main.id);
    const P = `${T(SLUG)}/${main.id}/land`;
    expect((await d.api("POST", P, { summary: "x" }, { "x-ckanban-run": `${SLUG}/${tool.id}` })).status).toBe(403);
    const empty = await d.api("POST", P, { summary: "  " });
    expect(empty.status).toBe(409);
    expect(empty.data.error).toBe("say in one line what this milestone is (summary)");
    const notMain = await d.api("POST", `${T(SLUG)}/${tool.id}/land`, { summary: "x" });
    expect(notMain.status).toBe(409);
    expect(notMain.data.error).toBe("only a main ticket lands milestones");

    const before = ev.all.length;
    const r = await d.api("POST", P, { summary: "Feature built" }, { "x-ckanban-run": `${SLUG}/${main.id}` });
    expect(r.status).toBe(200);
    expect(r.data.message).toBe(`Landed: pushed your copy and opened a pull request: ${PR}`);
    // The bare remote has the main copy's branch at its head.
    expect(sh(["git", "rev-parse", m.branch], remote)).toBe(sh(["git", "rev-parse", m.branch], d.project));
    const create = ghCalls().filter((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create).toHaveLength(1);
    expect(create[0].args).toEqual(["pr", "create", "--head", m.branch, "--base", "main", "--title", "The feature", "--body", "Feature built"]);
    const after = await view(d, SLUG, main.id);
    expect(JSON.stringify(after.prs ?? after.prUrl)).toContain(PR);
    const status = JSON.parse(readFileSync(join(tdir(SLUG, main.id), "outputs", "status.json"), "utf8"));
    expect(status.milestones.at(-1)).toMatchObject({ summary: "Feature built", landed: `opened ${PR}` });
    expect(comments(SLUG, main.id).at(-1)).toMatchObject({ author: "ai", text: `Milestone landed: Feature built (opened ${PR}).` });
    expect(ev.all.slice(before).some((e) => e.type === "ticket.updated" && e.ticket?.id === main.id)).toBe(true);
    // The project folder's main didn't move: landing with a remote goes through the pull request.
    expect(existsSync(join(d.project, "feature.txt"))).toBe(false);

    const again = await d.api("POST", P, { summary: "More work" });
    expect(again.status).toBe(200);
    expect(again.data.message).toBe(`Landed: pushed your copy and updated the open pull request: ${PR}`);
    expect(ghCalls().filter((c) => c.args[0] === "pr" && c.args[1] === "create")).toHaveLength(1);
  }, 60_000);

  test("land with uncommitted changes in the main copy is refused", async () => {
    const m = await view(d, SLUG, main.id);
    if (!m.worktree || !existsSync(m.worktree)) return; // no copy on disk: the check can't apply
    writeFileSync(join(m.worktree, "loose.txt"), "x\n");
    const r = await d.api("POST", `${T(SLUG)}/${main.id}/land`, { summary: "Dirty" });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("uncommitted changes");
    rmSync(join(m.worktree, "loose.txt"));
  });
});

describe("land without a remote", () => {
  test("merges the main copy into main in the project folder", async () => {
    const tag = s.set("localmain", [{ files: { "landed.txt": "landed\n" }, sh: ["git add landed.txt", "git commit -q -m 'landed'"] }]);
    const t = await create(LOCAL, "Local feature", `x ${tag}`);
    const v = await settled(d, LOCAL, t.id, (x) => x.status === "review");
    expect(v.branch).toStartWith(`ck/${t.id}-local-feature`);
    expect(existsSync(join(local, "landed.txt"))).toBe(false);
    const r = await d.api("POST", `${T(LOCAL)}/${t.id}/land`, { summary: "Local milestone" });
    expect(r.status).toBe(200);
    const sha = sh(["git", "rev-parse", "--short", "HEAD"], local);
    expect(r.data.message).toBe(`Landed: merged your copy into main in the project folder (${sha}).`);
    expect(readFileSync(join(local, "landed.txt"), "utf8")).toBe("landed\n");
    expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], local)).toBe("main");
    const status = JSON.parse(readFileSync(join(tdir(LOCAL, t.id), "outputs", "status.json"), "utf8"));
    expect(status.milestones.at(-1)).toMatchObject({ summary: "Local milestone", landed: `merged into main in the project folder at ${sha}` });
    // The project folder with uncommitted changes: refused, nothing merged.
    writeFileSync(join(local, "README.md"), "changed\n");
    s.set("localmain", [{ files: { "second.txt": "2\n" }, sh: ["git add second.txt", "git commit -q -m second"] }]);
    expect((await d.api("POST", `${T(LOCAL)}/${t.id}/chat`, { text: "one more" })).status).toBe(202);
    await settled(d, LOCAL, t.id, (x) => x.runCount === 2);
    const dirty = await d.api("POST", `${T(LOCAL)}/${t.id}/land`, { summary: "Second" });
    expect(dirty.status).toBe(409);
    expect(dirty.data.error).toContain("the project folder has uncommitted changes");
    expect(existsSync(join(local, "second.txt"))).toBe(false);
    sh(["git", "checkout", "README.md"], local);
  }, 90_000);
});

describe("pull request routes (stub gh)", () => {
  test("refresh reads the PR's status; merge squashes it; check-pr sees it merged and moves the card to Done", async () => {
    const url = "https://github.com/test/repo/pull/77";
    const t = await create(SLUG, "Has a PR", `x ${s.set("prroutes", [{ prUrl: url }])}`);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect(v.prUrl).toBe(url);
    expect((await d.api("POST", `${T(SLUG)}/${t.id}/pr/merge`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);

    const r = await d.api("POST", `${T(SLUG)}/${t.id}/pr/refresh`, { force: true });
    expect(r.status).toBe(200);
    expect(r.data.pr).toMatchObject({ url, number: 42, state: "OPEN", failing: 0, pending: 0, mergeable: "MERGEABLE", conflicts: false, base: "main" });
    expect(r.data.pr.checks).toEqual([{ name: "ci", state: "pass", url: "https://ci.example/1", at: null }]);
    expect(meta(SLUG, t.id).pr).toMatchObject({ url, state: "OPEN" });

    const open = await d.api("POST", `${T(SLUG)}/${t.id}/check-pr`, {});
    expect(open.status).toBe(200);
    expect(open.data.state).toBe("OPEN");
    expect(open.data.ticket.status).toBe("review");

    const merged = await d.api("POST", `${T(SLUG)}/${t.id}/pr/merge`, {});
    expect(merged.status).toBe(200);
    expect(ghCalls().some((c) => c.args.join(" ") === `pr merge ${url} --squash --delete-branch`)).toBe(true);
    const after = await until(async () => {
      const c = await d.api("POST", `${T(SLUG)}/${t.id}/check-pr`, {});
      const x = await view(d, SLUG, t.id);
      return x.status === "done" ? { c, x } : null;
    }, 15_000, "the card in Done");
    expect(after.x.status).toBe("done");
    rmSync(join(root, "gh-state"), { force: true });
  }, 60_000);
});

describe("files the chat mentions, and version history", () => {
  test("find-files and file look in the ticket's copy, then the project folder, then its outputs", async () => {
    const t = await create(SLUG, "Has files", `x ${s.set("files", [{ files: { "src/in-copy.ts": "export const a = 1;\n" }, outputs: { "out.md": "# Out\n" } }])}`);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    const r = await d.api("POST", `${T(SLUG)}/${t.id}/find-files`, { paths: ["src/in-copy.ts", "README.md", "out.md", "nope.txt", "../../etc/hosts"] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.data.found).sort()).toEqual(["README.md", "out.md", "src/in-copy.ts"]);
    expect(r.data.found["src/in-copy.ts"].rel).toBe("src/in-copy.ts");
    const f = await d.api("GET", `${T(SLUG)}/${t.id}/file?path=${encodeURIComponent("src/in-copy.ts")}`);
    expect(f.status).toBe(200);
    expect(f.data.dir).toBe(real(v.worktree));
    expect(JSON.stringify(f.data)).toContain("export const a = 1;");
    const raw = await fetch(`${d.url}${T(SLUG)}/${t.id}/file?path=out.md&raw=1`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("# Out\n");
    expect((await d.api("GET", `${T(SLUG)}/${t.id}/file?path=nope.txt`)).status).toBe(404);
    expect((await d.api("GET", `${T(SLUG)}/${t.id}/file?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(404);
  }, 60_000);

  test("version-history: GET tells a plain folder from a repo; POST turns it on, and the board's next ticket gets a copy", async () => {
    const folder = join(root, "turn-on");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notes.txt"), "hello\n");
    expect((await d.api("GET", "/api/version-history?path=relative")).status).toBe(400);
    const before = await d.api("GET", `/api/version-history?path=${encodeURIComponent(folder)}`);
    expect(before.status).toBe(200);
    expect(before.data.git).toBe(true);
    expect(before.data.repo).toBe("plain");
    expect((await d.api("POST", "/api/version-history", { path: join(root, "missing") })).status).toBe(404);
    expect((await d.api("POST", "/api/profiles", { name: "Turn on", path: folder })).status).toBe(201);
    const on = await d.api("POST", "/api/version-history", { path: folder });
    expect(on.status).toBe(200);
    expect(on.data.changed).toBe(true);
    expect(on.data.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(on.data.repo).toBe("local");
    expect(sh(["git", "rev-parse", "HEAD"], folder)).toBe(on.data.sha);
    expect(existsSync(join(folder, ".gitignore"))).toBe(true);
    const again = await d.api("POST", "/api/version-history", { path: folder });
    expect(again.data).toMatchObject({ changed: false, sha: on.data.sha });
    const t = await create("turn-on", "After turning on", `x ${s.set("turnon", [{}])}`);
    const v = await settled(d, "turn-on", t.id, (x) => x.status === "review");
    expect(v.worktree).toBe(join(root, ".ckanban-worktrees", "turn-on", t.id));
  }, 60_000);

  test("version-history: a click while tickets change files in the folder saves a request; the board turns it on after the last one ends", async () => {
    const folder = join(root, "later");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notes.txt"), "hello\n");
    expect((await d.api("POST", "/api/profiles", { name: "Later", path: folder })).status).toBe(201);
    const [g1, g2] = [s.gate("later1"), s.gate("later2")];
    // Two tool tickets, made by their main ticket's run (the user's own tickets are main tickets, which never edit
    // files).
    const t1 = s.set("later1", [{ waitFile: g1.file }]);
    const t2 = s.set("later2", [{ waitFile: g2.file }]);
    const mainTag = s.set("latermain", [{
      calls: [
        { method: "POST", path: T("later"), body: { title: "Later one", body: `## Objective\nOne. ${t1}`, kind: "build" } },
        { method: "POST", path: T("later"), body: { title: "Later two", body: `## Objective\nTwo. ${t2}`, kind: "build" } },
      ],
      summary: "Started both.",
    }]);
    await create("later", "Later feature", `Plan it. ${mainTag}`);
    await until(() => (s.out("latermain").length === 2 ? true : null), 30_000, "main run's create calls");
    const [one, two] = s.out("latermain").map((o) => o.data);
    expect([one.tool, two.tool]).toEqual([true, true]);
    await running(d, "later", one.id);
    await running(d, "later", two.id);
    const asked = await d.api("POST", "/api/version-history", { path: folder });
    expect(asked).toMatchObject({ status: 202, data: { pending: true } });
    const file = join(d.home, "version-history-pending.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(schemaProblems("version-history-pending.schema.json", saved)).toEqual([]);
    expect(saved[folder].tickets.map((t: any) => t.id).sort()).toEqual([one.id, two.id].sort());
    // Every sharing card shows it, with the folder its Cancel needs.
    for (const t of [one, two]) expect((await view(d, "later", t.id)).folderShare).toMatchObject({ others: 1, pending: true, path: folder });
    // Cancel clears it; a second click saves it again.
    expect(await d.api("POST", "/api/version-history", { path: folder, cancel: true })).toMatchObject({ status: 200, data: { pending: false } });
    expect(existsSync(file)).toBe(false);
    expect((await view(d, "later", one.id)).folderShare).toMatchObject({ pending: false });
    expect((await d.api("POST", "/api/version-history", { path: folder })).status).toBe(202);
    g1.release();
    await settled(d, "later", one.id);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(existsSync(file)).toBe(true);
    g2.release();
    await settled(d, "later", two.id);
    await until(async () => (existsSync(join(folder, ".git")) && !existsSync(file) ? true : null), 20_000, "version history to turn on");
    expect(sh(["git", "log", "--oneline"], folder)).toContain("Initial snapshot");
  }, 60_000);
});

describe("branch", () => {
  test("POST /branch makes a \"Branch: <title>\" ticket in Planning with its own branch off the source's", async () => {
    const t = await create(SLUG, "Source", `x ${s.set("branchsrc", [{ files: { "b.txt": "b\n" }, sh: ["git add b.txt", "git commit -q -m b"] }])}`);
    const v = await settled(d, SLUG, t.id, (x) => x.status === "review");
    expect((await d.api("POST", `${T(SLUG)}/${t.id}/branch`, {}, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
    const r = await d.api("POST", `${T(SLUG)}/${t.id}/branch`, {});
    expect(r.status).toBe(201);
    const b = r.data.ticket;
    expect(b).toMatchObject({ title: "Branch: Source", status: "planning" });
    expect(b.id).not.toBe(t.id);
    expect(b.sessionId).not.toBe(v.sessionId);
    const branched = await settled(d, SLUG, b.id, (x) => !!x.branch && x.branch !== v.branch, 30_000);
    // The new branch starts from the source's committed work.
    expect(sh(["git", "merge-base", "--is-ancestor", v.branch, branched.branch], d.project)).toBe("");
  }, 60_000);
});
