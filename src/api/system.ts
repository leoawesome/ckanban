// The daemon itself: health, profiling, events, version, usage and spend, Claude defaults, folders, restart, bug reports. Moved verbatim from http.ts.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { profileFor } from "../core/cpuprof";
import { claudeDefaults, findClaude, listClaudeProjects, pickFolder } from "../runs/claude";
import { learnedVersions } from "../runs/model-versions";
import { enableVersionHistory, repoKind, which } from "../runs/git";
import { cronError, describeCron, nextRuns, parseCron } from "../schedules/cron";
import { RUN_HEADER } from "../schedules/scheduler";
import { BugReportError, draftReport, submitReport, type BugBlockId, type BugSource } from "../integrations/bugreport";
import { ptySupported } from "../browser/shell";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/health, debug, events, version, usage, spend, team-usage, cron, claude, pick-folder, version-history, awake, restart, bug-report */
export async function systemRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { deps, store, board, json, updates, huddles, usage, spend, sse } = ctx;
  if (parts[0] === "health" && m === "GET") {
    const [claude, git, gh] = await Promise.all([
      process.env.CKANBAN_CLAUDE_BIN ? which(process.env.CKANBAN_CLAUDE_BIN) : findClaude(), which("git"), which("gh"),
    ]);
    return json({ claude, git, gh, pty: ptySupported() });
  }

  // A CPU profile of this daemon for N seconds (to find what holds the board up): this Mac's own address only.
  if (parts[0] === "debug" && parts[1] === "profile" && m === "POST") {
    const host = req.headers.get("host") ?? "";
    if (req.headers.get(RUN_HEADER) || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || host.endsWith(`:${deps.remotePort}`)) {
      throw new HttpError(403, "profiles are taken from this Mac only");
    }
    return json(await profileFor(Number(url.searchParams.get("seconds")) || 15, join(store.root, "debug")));
  }

  if (parts[0] === "events" && m === "GET") return sse(req);
  if (parts[0] === "version" && m === "GET") return json(await updates.status());
  // ?fresh=1 is the Refresh button: asks now unless a check went out in the last minute or Anthropic asked us to wait.
  if (parts[0] === "usage" && m === "GET") return json(await usage.get({ fresh: url.searchParams.get("fresh") === "1" }));
  // What every board spent today (tickets' runs and huddle agents), for the header pill.
  if (parts[0] === "spend" && m === "GET") return json(await spend.recent());
  // How every teammate (huddle preset) and template was used, from the huddles on every board.
  if (parts[0] === "team-usage" && m === "GET") return json(huddles.usage());

  // Schedule form preview: is the expression valid, what it means, when it fires next.
  if (parts[0] === "cron" && parts[1] === "preview" && parts.length === 2 && m === "GET") {
    const expr = (url.searchParams.get("expr") ?? "").trim();
    const error = expr ? cronError(expr) : "cron expression is required";
    if (error) return json({ valid: false, error, summary: null, next: [] });
    return json({ valid: true, error: null, summary: describeCron(expr), next: nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString()) });
  }

  if (parts[0] === "claude" && parts[1] === "projects" && m === "GET") {
    const taken = new Set(store.listProfiles().map((p) => p.path));
    return json(listClaudeProjects().map((p) => ({ ...p, hasProfile: taken.has(p.path) })));
  }
  if (parts[0] === "claude" && parts[1] === "defaults" && m === "GET") return json({ ...claudeDefaults(), versions: learnedVersions() });
  if (parts[0] === "pick-folder" && m === "POST") return json({ path: await pickFolder() });
  // A folder's version history, for the "Turn on version history" offer (New board, board settings).
  if (parts[0] === "version-history" && parts.length === 1) {
    const path = m === "GET" ? url.searchParams.get("path") ?? "" : String((await body(req))?.path ?? "");
    if (!path.trim() || !isAbsolute(path)) throw new HttpError(400, "an absolute folder path is required");
    const git = await which("git");
    if (m === "GET") return json({ git, repo: git && existsSync(path) ? await repoKind(path) : null });
    if (m === "POST") {
      if (!git) throw new HttpError(400, "git isn't installed on this computer");
      if (!existsSync(path)) throw new HttpError(404, `folder does not exist: ${path}`);
      // A ticket editing the folder in place right now would leave half-done files in the first snapshot.
      const busy = store.listProfiles().filter((p) => p.path === path)
        .flatMap((p) => store.listTickets(p.slug).filter((t) => board.isRunning(p.slug, t.id) && board.runsInFolder(p.slug, t) !== false));
      if (busy.length) throw new HttpError(409, `Wait until "${busy[0].title}" finishes: Claude is changing files in this folder right now.`);
      let r;
      try {
        r = await enableVersionHistory(path);
      } catch (e) {
        throw new HttpError(500, `Couldn't turn on version history: ${(e as Error).message}`);
      }
      const repo = await repoKind(path);
      // Boards on this folder: their next ticket gets a worktree of its own.
      for (const p of store.listProfiles()) if (p.path === path) board.noteRepo(p.slug, repo);
      return json({ ...r, repo });
    }
  }
  if (parts[0] === "awake" && parts.length === 1 && m === "GET") return json({ held: deps.awake?.() ?? false });
  if (parts[0] === "restart" && parts.length === 1) {
    if (m === "GET") return json(board.restartState());
    if (m === "POST") {
      if (!deps.restart) throw new HttpError(501, "restart is only available on the daemon");
      return json(deps.restart());
    }
  }

  // Report bug: context preview, then file a GitHub issue on the ckanban repo.
  if (parts[0] === "bug-report" && m === "POST" && parts.length <= 2) {
    const b = await body(req);
    const ref = b.ticketId ? { slug: String(b.profile ?? ""), id: String(b.ticketId) } : null;
    try {
      // A compressed run log is decompressed off the event loop first; the report then reads its tail in place.
      if (ref && store.getTicket(ref.slug, ref.id)) await store.loadActivity(ref.slug, ref.id).catch(() => {});
      const draft = draftReport(store, ref);
      if (parts[1] === "draft") return json(draft);
      if (parts.length !== 1) throw new HttpError(404, "not found");
      const source: BugSource = b.source === "ai" || b.source === "cli" ? b.source : "ui";
      const include = Array.isArray(b.include) ? (b.include.map(String) as BugBlockId[]) : undefined;
      const r = await submitReport(
        { title: String(b.title ?? ""), description: String(b.description ?? ""), blocks: draft.blocks, include, source },
        { dataRoot: store.root, gh: deps.gh },
      );
      return json(r, r.url ? 201 : 200);
    } catch (e) {
      if (e instanceof BugReportError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  return NEXT;
}
