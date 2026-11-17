// Outside-in contract: a huddle participant's own session, read-only (the Huddle tab's session viewer):
// GET /huddles/:id/participants/:handle/session (paged steps), .../session/tool/:toolUseId, who may read it, and
// a ticket session (@main) having no transcript of its own there. See contracts/api.md ("Huddles").
//
// The fake Claude (FAKE_TRANSCRIPT=1) thinks, runs `ls src` and posts "@main found it" in every turn, and writes
// that to its transcript under the test's CLAUDE_CONFIG_DIR, like the real CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Daemon, startDaemon, until } from "./daemon";

let d: Daemon;
const SLUG = "agents";
const base = `/api/profiles/${SLUG}`;
const RUN = "x-ckanban-run";

beforeAll(async () => {
  d = await startDaemon({ env: { FAKE_TRANSCRIPT: "1" } });
  expect((await d.api("POST", "/api/profiles", { name: "Agents", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

describe("a participant's session", () => {
  test("steps of a helper's own session, paged; tool details; the user's alone", async () => {
    const t = (await d.api("POST", `${base}/tickets`, { title: "Session host", body: "Host." })).data;
    const started = await d.api("POST", `${base}/huddles`, { ticketId: t.id, roster: [{ preset: "reviewer" }] });
    expect(started.status).toBe(201);
    const h = started.data;
    const path = `${base}/huddles/${h.id}/participants/reviewer/session`;
    // The helper's first turn: woken, thinks, runs a tool, posts.
    const s = await until(async () => {
      const r = await d.api("GET", path);
      return r.status === 200 && !r.data.live && r.data.steps.some((x: any) => x.kind === "post") ? r.data : null;
    }, 30_000, "the helper's session");
    expect(s).toMatchObject({ handle: "reviewer", kind: "agent", live: false, ticketId: null, hasMore: false, current: null });
    expect(typeof s.sessionId).toBe("string");
    expect(s.file).toEndWith(`${s.sessionId}.jsonl`);
    expect(s.total).toBe(s.steps.length);
    expect(s.steps[0]).toMatchObject({ i: 0, kind: "wake", text: "Started on its job" });
    expect(s.steps.find((x: any) => x.kind === "text")).toMatchObject({ text: "Checking how rows are built." });
    expect(s.steps.find((x: any) => x.kind === "tool")).toMatchObject({ text: "Bash: ls src", id: "tu_ls", out: "2 lines" });
    const post = s.steps.find((x: any) => x.kind === "post");
    expect(post).toMatchObject({ text: "@main found it", id: "tu_post", seq: 7 });
    expect(post.pending).toBeUndefined();

    // Paging: before an index, since an index, a limit.
    const last = (await d.api("GET", `${path}?limit=1`)).data;
    expect(last.steps.map((x: any) => x.i)).toEqual([s.total - 1]);
    expect(last.hasMore).toBe(s.total > 1);
    expect((await d.api("GET", `${path}?before=1`)).data.steps.map((x: any) => x.i)).toEqual([0]);
    expect((await d.api("GET", `${path}?before=0`)).data.steps).toEqual([]);
    expect((await d.api("GET", `${path}?since=1`)).data.steps.map((x: any) => x.i)).toEqual(s.steps.slice(1).map((x: any) => x.i));

    // A tool call in full; one that isn't there is a 404.
    const tool = await d.api("GET", `${path}/tool/tu_ls`);
    expect(tool.status).toBe(200);
    expect(JSON.stringify(tool.data)).toContain("ls src");
    expect((await d.api("GET", `${path}/tool/tu_none`)).status).toBe(404);

    // @main is the host ticket's own session: no transcript here (the viewer links to its chat).
    const main = await d.api("GET", `${base}/huddles/${h.id}/participants/main/session`);
    expect(main.status).toBe(200);
    expect(main.data).toMatchObject({ handle: "main", kind: "ticket-main", ticketId: t.id, sessionId: null, file: null, steps: [], total: 0 });
    expect((await d.api("GET", `${base}/huddles/${h.id}/participants/you/session`)).status).toBe(404);
    expect((await d.api("GET", `${base}/huddles/${h.id}/participants/nobody/session`)).status).toBe(404);
    // Runs and helpers can't read each other's sessions.
    expect((await d.api("GET", path, undefined, { [RUN]: `${SLUG}/${t.id}` })).status).toBe(403);

    expect((await d.api("POST", `${base}/huddles/${h.id}/close`, {})).data.status).toBe("closed");
    // It stays readable after the close.
    expect((await d.api("GET", path)).data.total).toBe(s.total);
  }, 60_000);
});
