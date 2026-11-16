// Outside-in contract: the read routes of a board's files and a ticket's work, on boards and tickets seeded as files
// before the daemon starts (no run needed, so the same test runs against Bun and the Rust board): a ticket's outputs
// (list, serve, download, Show in Finder, Copy file), the files its chat mentions (find-files, file), its Changes tab
// (a copy against the base branch, a ticket in the folder itself since its first run, a main ticket since it started,
// a plain folder), the board's Files panel (files, file, open-file), detect-setup and /api/version-history. Paths that
// leave their folder are refused. See contracts/api.md ("Ticket files and outputs", "Profiles").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { sh } from "./runs";

let d: Daemon;
let root: string;
let plain: string;
let copy: string;
let mainCopy: string;
let baseSha: string;
let startSha: string;
const B = "files";
const P = "plain";
const T = (slug: string, id: string) => `/api/profiles/${slug}/tickets/${id}`;
const STAMP = "2026-11-15T08:00:00.000Z";

function write(dir: string, rel: string, text: string) {
  const f = join(dir, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
}

function profile(home: string, slug: string, path: string, baseBranch: string) {
  write(join(home, "profiles", slug), "profile.json", `${JSON.stringify({ name: slug, slug, path, baseBranch, model: null, createdAt: STAMP }, null, 2)}\n`);
}

/** A ticket file as Bun writes one (front matter of plain scalars, then the body). */
function ticket(home: string, slug: string, id: string, fields: Record<string, string | boolean | number>) {
  const meta = { id, title: `Ticket ${id}`, status: "review", mode: "auto", createdAt: STAMP, updatedAt: STAMP, ...fields };
  const yaml = Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`).join("\n");
  write(join(home, "profiles", slug, "tickets", id), "ticket.md", `---\n${yaml}\n---\nBody of ${id}\n`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ck-contract-files-"));
  plain = join(root, "plain");
  write(plain, "notes.txt", "plain notes\n");
  const openLog = join(root, "open-calls.jsonl");
  d = await startDaemon({
    env: { CKANBAN_OPEN_BIN: join(root, "fake-open"), CKANBAN_OSASCRIPT_BIN: join(root, "fake-osascript"), OPEN_LOG: openLog },
    before: ({ home, project }) => {
      // The project: a repo on main; .env is git-ignored, web/ has a tracked lockfile.
      write(project, ".gitignore", ".env\nbuild/\n");
      write(project, "web/bun.lock", "");
      write(project, "src/app.ts", "export const app = 1;\n");
      sh(["git", "init", "-q", "-b", "main"], project);
      sh(["git", "config", "user.name", "Contract"], project);
      sh(["git", "config", "user.email", "contract@example.com"], project);
      sh(["git", "add", "-A"], project);
      sh(["git", "commit", "-q", "-m", "first"], project);
      write(project, ".env", "SECRET=1\n");
      write(project, "build/out.js", "x");
      baseSha = sh(["git", "rev-parse", "HEAD"], project);
      // A ticket's copy on its own branch, with a commit and an untracked file.
      copy = join(root, ".ckanban-worktrees", B, "t_copy");
      sh(["git", "worktree", "add", "-q", "-b", "ck/t_copy-x", copy, "main"], project);
      write(copy, "src/app.ts", "export const app = 2;\n");
      sh(["git", "commit", "-q", "-am", "change app"], copy);
      write(copy, "src/new.ts", "export const fresh = true;\n");
      // A main ticket's copy: its Changes are everything since its start.
      mainCopy = join(root, ".ckanban-worktrees", B, "t_main");
      sh(["git", "worktree", "add", "-q", "-b", "ck/t_main-m", mainCopy, "main"], project);
      startSha = sh(["git", "rev-parse", "HEAD"], mainCopy);
      write(mainCopy, "merged.txt", "from a tool ticket\n");
      sh(["git", "add", "-A"], mainCopy);
      sh(["git", "commit", "-q", "-m", "merged work"], mainCopy);
      profile(home, B, project, "main");
      profile(home, P, plain, "");
      ticket(home, B, "t_copy", { worktree: copy, branch: "ck/t_copy-x" });
      ticket(home, B, "t_main", { worktree: mainCopy, branch: "ck/t_main-m", main: true, startSha });
      ticket(home, B, "t_inplace", { baseSha, runCount: 1 });
      ticket(home, P, "t_plain", { runCount: 1 });
      const out = join(home, "profiles", B, "tickets", "t_copy", "outputs");
      write(out, "report.md", "# Report\n");
      write(out, "charts/chart.png", "PNG");
      write(out, "page.html", "<script>alert(1)</script>");
      write(out, "node_modules/skip.js", "skipped");
      write(root, "outside.txt", "outside\n");
      // In a git-ignored folder, so it isn't one of the folder's changes.
      symlinkSync(join(root, "outside.txt"), join(project, "build", "escape.txt"));
      // Stand-ins for `open` and `osascript`: they write down how they were called.
      for (const [name, bin] of [["fake-open", "open"], ["fake-osascript", "osascript"]]) {
        write(root, name, `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.OPEN_LOG, JSON.stringify({ bin: "${bin}", args: process.argv.slice(2) }) + "\\n");\n`);
        sh(["chmod", "755", join(root, name)], root);
      }
    },
  });
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(root, { recursive: true, force: true });
}, 30_000);

const real = (p: string) => realpathSync(p);

describe("a ticket's outputs", () => {
  test("listed newest first without dependency folders; served as sandboxed text, raster images as themselves", async () => {
    const r = await d.api("GET", `${T(B, "t_copy")}/outputs`);
    expect(r.status).toBe(200);
    expect(r.data.map((f: any) => f.name).sort()).toEqual(["charts/chart.png", "page.html", "report.md"]);
    expect(r.data[0]).toEqual({ name: expect.any(String), size: expect.any(Number), updatedAt: expect.stringMatching(/Z$/) });
    const html = await fetch(`${d.url}${T(B, "t_copy")}/outputs/page.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    const png = await fetch(`${d.url}${T(B, "t_copy")}/outputs/charts/chart.png?download=1`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toBe(`attachment; filename="chart.png"; filename*=UTF-8''chart.png`);
    expect((await d.api("GET", `${T(B, "t_copy")}/outputs/missing.md`)).status).toBe(404);
    expect((await d.api("GET", `${T(B, "t_copy")}/outputs/..%2Fticket.md`)).status).toBe(404);
    expect((await d.api("GET", `${T(B, "t_none")}/outputs`)).data).toEqual({ error: "ticket t_none not found" });
    expect((await d.api("GET", `/api/profiles/nope/tickets/t_copy/outputs`)).data).toEqual({ error: "board nope not found" });
    // No outputs folder: an empty list.
    expect((await d.api("GET", `${T(B, "t_main")}/outputs`)).data).toEqual([]);
  });

  test("Show in Finder and Copy file run the system commands; a board run may not; publish needs a known action", async () => {
    const reveal = await d.api("POST", `${T(B, "t_copy")}/outputs/report.md?action=reveal`, {});
    expect(reveal).toMatchObject({ status: 200, data: { ok: true } });
    expect((await d.api("POST", `${T(B, "t_copy")}/outputs/report.md?action=copy`, {})).status).toBe(200);
    const calls = readFileSync(join(root, "open-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls[0]).toEqual({ bin: "open", args: ["-R", join(d.home, "profiles", B, "tickets", "t_copy", "outputs", "report.md")] });
    expect(calls[1].bin).toBe("osascript");
    expect(calls[1].args.at(-1)).toBe(join(d.home, "profiles", B, "tickets", "t_copy", "outputs", "report.md"));
    const run = await d.api("POST", `${T(B, "t_copy")}/outputs/report.md?action=reveal`, {}, { "x-ckanban-run": `${B}/t_copy` });
    expect(run).toMatchObject({ status: 403, data: { error: "sharing outputs is disabled inside a board run" } });
    expect((await d.api("POST", `${T(B, "t_copy")}/outputs/report.md?action=print`, {})).data).toEqual({ error: "action must be reveal, copy or publish" });
    expect((await d.api("POST", `${T(B, "t_copy")}/outputs/missing.md?action=reveal`, {})).status).toBe(404);
  });
});

describe("files a chat mentions", () => {
  test("find-files looks in the ticket's copy, the project folder, then its outputs; nothing outside them", async () => {
    const r = await d.api("POST", `${T(B, "t_copy")}/find-files`, {
      paths: ["src/new.ts", " src/app.ts ", "README.md", "report.md", "nope.txt", "../outside.txt", join(root, "outside.txt"), "build/escape.txt", 5, ""],
    });
    expect(r.status).toBe(200);
    expect(r.data.found).toEqual({
      "src/new.ts": { root: "ticket", rel: "src/new.ts" },
      "src/app.ts": { root: "ticket", rel: "src/app.ts" },
      // The copy has the project's committed files too.
      "README.md": { root: "ticket", rel: "README.md" },
      "report.md": { root: "outputs", rel: "report.md" },
    });
    expect((await d.api("POST", `${T(B, "t_copy")}/find-files`, "not json" as any)).status).toBe(200);
  });

  test("file reads one for viewing (or raw); a folder, a missing file and a path outside are 404", async () => {
    const f = await d.api("GET", `${T(B, "t_copy")}/file?path=${encodeURIComponent("src/app.ts")}`);
    expect(f.status).toBe(200);
    expect(f.data).toEqual({ path: "src/app.ts", size: 22, content: "export const app = 2;\n", binary: false, tooLarge: false, root: "ticket", dir: real(copy) });
    const raw = await fetch(`${d.url}${T(B, "t_copy")}/file?path=report.md&raw=1`);
    expect(raw.headers.get("content-security-policy")).toBe("sandbox");
    expect(await raw.text()).toBe("# Report\n");
    for (const p of ["src", "nope.txt", "../outside.txt", join(root, "outside.txt"), "build/escape.txt"]) {
      expect((await d.api("GET", `${T(B, "t_copy")}/file?path=${encodeURIComponent(p)}`)).data).toEqual({ error: "file not found in this ticket's folders" });
    }
  });
});

describe("the Changes tab", () => {
  test("a copy: its commits and untracked files against the base branch", async () => {
    const r = await d.api("GET", `${T(B, "t_copy")}/diff`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.data)).toEqual(["base", "mergeBase", "branch", "files", "additions", "deletions"]);
    expect(r.data).toMatchObject({ base: "main", mergeBase: baseSha, branch: "ck/t_copy-x", additions: 2, deletions: 1 });
    expect(r.data.files.map((f: any) => [f.path, f.status])).toEqual([["src/app.ts", "M"], ["src/new.ts", "A"]]);
    expect(r.data.files[0].hunks[0].lines).toEqual([
      { type: "del", text: "export const app = 1;", old: 1, new: null },
      { type: "add", text: "export const app = 2;", old: null, new: 1 },
    ]);
  });

  test("a main ticket since it started; a ticket in the folder since its first run; a plain folder has none", async () => {
    const m = await d.api("GET", `${T(B, "t_main")}/diff`);
    expect(m.data).toMatchObject({ base: startSha.slice(0, 7), mergeBase: startSha, additions: 1 });
    expect(m.data.files.map((f: any) => f.path)).toEqual(["merged.txt"]);
    const inplace = await d.api("GET", `${T(B, "t_inplace")}/diff?w=1`);
    expect(inplace.status).toBe(200);
    expect(inplace.data).toMatchObject({ base: baseSha.slice(0, 7), branch: "main", files: [] });
    const none = await d.api("GET", `${T(P, "t_plain")}/diff`);
    expect(none).toMatchObject({ status: 404, data: { error: "No version history for this folder, so changes can't be shown." } });
  });
});

describe("the board's Files panel", () => {
  test("files lists folders first, hiding .git and git-ignored entries; ?ticket= lists its copy", async () => {
    const r = await d.api("GET", `/api/profiles/${B}/files?path=`);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      path: "",
      entries: [
        { name: "src", path: "src", type: "dir" },
        { name: "web", path: "web", type: "dir" },
        { name: ".gitignore", path: ".gitignore", type: "file" },
        { name: "README.md", path: "README.md", type: "file" },
      ],
      more: 0,
    });
    const own = await d.api("GET", `/api/profiles/${B}/files?path=src&ticket=t_copy`);
    expect(own.data.entries.map((e: any) => e.path)).toEqual(["src/app.ts", "src/new.ts"]);
    // An empty ticket is the board folder.
    expect((await d.api("GET", `/api/profiles/${B}/files?path=&ticket=`)).data.entries.map((e: any) => e.path)).toEqual(["src", "web", ".gitignore", "README.md"]);
    expect((await d.api("GET", `/api/profiles/${B}/files?ticket=bad%20id`)).data).toEqual({ error: "invalid ticket" });
    expect((await d.api("GET", `/api/profiles/${B}/files?ticket=t_gone`)).data).toEqual({ error: "ticket not found" });
    expect((await d.api("GET", `/api/profiles/${B}/files?path=..`)).data).toEqual({ error: "path must not contain .." });
    expect((await d.api("GET", `/api/profiles/${B}/files?path=README.md`)).data).toEqual({ error: "not a directory" });
  });

  test("file reads one; a symlink out of the folder is 403; open-file opens it with the system's app", async () => {
    const f = await d.api("GET", `/api/profiles/${B}/file?path=src/app.ts`);
    expect(f.data).toEqual({ path: "src/app.ts", size: 22, content: "export const app = 1;\n", binary: false, tooLarge: false });
    expect(await d.api("GET", `/api/profiles/${B}/file?path=build/escape.txt`)).toMatchObject({ status: 403, data: { error: "path is outside the board folder" } });
    expect((await d.api("GET", `/api/profiles/${B}/file?path=nope`)).data).toEqual({ error: "not found" });
    expect((await d.api("POST", `/api/profiles/${B}/open-file`, { path: "README.md" })).data).toEqual({ ok: true });
    // The app is started and left running: its call shows up a moment later.
    const want = JSON.stringify({ bin: "open", args: [real(join(d.project, "README.md"))] });
    await until(() => readFileSync(join(root, "open-calls.jsonl"), "utf8").includes(want), 10_000, "open to be called");
    expect((await d.api("POST", `/api/profiles/${B}/open-file`, { path: "../x" })).status).toBe(400);
  });

  test("detect-setup finds git-ignored .env files and tracked lockfiles; a plain folder has none", async () => {
    const r = await d.api("POST", `/api/profiles/${B}/detect-setup`, {});
    expect(r.data).toEqual({ at: expect.any(String), copyFiles: [".env"], setupCommand: "(cd web && bun install)", setupFrom: ["web/bun.lock"] });
    expect((await d.api("POST", `/api/profiles/${P}/detect-setup`, {})).data).toMatchObject({ copyFiles: [], setupCommand: "", setupFrom: [] });
  });
});

describe("version history", () => {
  test("GET tells a plain folder from a repo; POST turns it on once; a missing folder is 404", async () => {
    expect((await d.api("GET", "/api/version-history?path=relative")).data).toEqual({ error: "an absolute folder path is required" });
    expect((await d.api("GET", `/api/version-history?path=${encodeURIComponent(d.project)}`)).data).toEqual({ git: true, repo: "local" });
    expect((await d.api("GET", `/api/version-history?path=${encodeURIComponent(join(root, "missing"))}`)).data).toEqual({ git: true, repo: null });
    expect((await d.api("GET", `/api/version-history?path=${encodeURIComponent(plain)}`)).data).toEqual({ git: true, repo: "plain" });
    expect((await d.api("POST", "/api/version-history", { path: join(root, "missing") })).status).toBe(404);
    const on = await d.api("POST", "/api/version-history", { path: plain });
    expect(on.status).toBe(200);
    expect(on.data).toEqual({ changed: true, sha: expect.stringMatching(/^[0-9a-f]{40}$/), ignored: [], repo: "local" });
    expect(sh(["git", "rev-parse", "HEAD"], plain)).toBe(on.data.sha);
    expect(existsSync(join(plain, ".gitignore"))).toBe(true);
    expect((await d.api("POST", "/api/version-history", { path: plain })).data).toEqual({ changed: false, sha: on.data.sha, ignored: [], repo: "local" });
  });
});
