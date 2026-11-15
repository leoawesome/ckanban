// Boards: list and create, one board's settings, its folder (files, shell, sessions) and Find links. Moved verbatim from http.ts.
import { parseConnectorSetting } from "../runs/connectors";
import { existsSync, statSync } from "node:fs";
import { listSessions, liveSessionMatch, processCommands } from "../runs/claude";
import { EFFORT_HELP, listCommands, MODEL_HELP, validEffort, validModel } from "../chat/commands";
import { parseTaskModels } from "../board/main-ticket";
import { detectBaseBranch, isGitRepo, resolveBaseBranch } from "../runs/git";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { FileError, listDirPage, openWithSystem, readFileForView } from "../core/files";
import { browserPicks, ChromeError, chromeSetting, legacyChrome, picksFromLegacy } from "../browser/chromes";
import { ptySupported } from "../browser/shell";
import type { Profile } from "../core/types";
import { nowIso, slugify } from "../core/util";
import { applyDetection, detectSetup } from "../runs/worktree-setup";
import { type ApiContext, HttpError, NEXT, type RouteResult, type ShellSocket, body, capValue, isAllowedSocket, realFolder, refuseSharedFolder, workspaceValue } from "./context";

/** /api/profiles */
export async function profileListRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { store, bus, board, json } = ctx;
  // /profiles
  if (parts.length === 1) {
    if (m === "GET") {
      return json(store.listProfiles().map((p) => ({ ...p, pathExists: existsSync(p.path), running: board.running(p.slug) })));
    }
    if (m === "POST") {
      const b = await body(req);
      const name = String(b.name ?? "").trim();
      const path = String(b.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
      if (!name) throw new HttpError(400, "name is required");
      if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `path is not a directory: ${path}`);
      if (b.effort && !validEffort(String(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
      refuseSharedFolder(store.listProfiles(), path);
      let slug = slugify(name);
      for (let i = 2; store.getProfile(slug); i++) slug = `${slugify(name)}-${i}`;
      const profile: Profile = {
        name, slug, path,
        // Empty when there is nothing to branch from yet (not a repo, or no commits); runs re-detect it.
        baseBranch: b.baseBranch || ((await isGitRepo(path)) ? (await resolveBaseBranch(path, await detectBaseBranch(path))) ?? "" : ""),
        model: b.model || null,
        ...(b.effort ? { effort: String(b.effort) } : {}),
        ...(b.ultracode === true ? { ultracode: true } : {}),
        createdAt: nowIso(),
        ...(b.workspace !== undefined ? { workspace: workspaceValue(b.workspace) } : {}),
      };
      const saved = applyDetection(profile, await detectSetup(path));
      store.saveProfile(saved);
      bus.emit({ type: "profile.updated", slug, profile: saved });
      return json(saved, 201);
    }
  }
  return NEXT;
}

/** /api/profiles/:p, detect-setup, commands, sessions, files, file, open-file, shell, find-links */
export async function profileRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile): Promise<RouteResult> {
  const { deps, store, bus, board, json, shells, knownBrowsers, snippets, userOnly, linker, remote, via, listenerOf, panelFolder, server } = ctx;
  // /profiles/:p
  if (parts.length === 2) {
    if (m === "GET") return json(profile);
    if (m === "PATCH") {
      const b = await body(req);
      const next: Profile = { ...profile };
      if (b.name !== undefined) next.name = String(b.name);
      if (b.path !== undefined) next.path = String(b.path);
      if (b.baseBranch !== undefined) next.baseBranch = String(b.baseBranch);
      if (b.model !== undefined) next.model = b.model || null;
      if (b.mainModel !== undefined) {
        if (b.mainModel && !(typeof b.mainModel === "string" && validModel(b.mainModel))) throw new HttpError(400, `"${b.mainModel}" is not a model name. Use ${MODEL_HELP}.`);
        next.mainModel = b.mainModel || null;
      }
      if (b.taskModels !== undefined) {
        try {
          next.taskModels = parseTaskModels(b.taskModels);
        } catch (e: any) {
          throw new HttpError(400, e.message);
        }
      }
      if (b.freshChatTokens !== undefined) {
        const v = b.freshChatTokens;
        if (v !== null && (typeof v !== "number" || !(v > 0) || v > 10_000_000)) throw new HttpError(400, "freshChatTokens must be a positive number, or null for the default");
        next.freshChatTokens = v === null ? null : Math.round(v);
      }
      // The board's browsers: the old single Chrome (chrome) or a list with notes (browsers); each keeps the other in step.
      if (b.chrome !== undefined || b.browsers !== undefined) {
        if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user picks the board's browsers");
        if (b.browsers !== undefined) await userOnly(req, "Choosing the board's browsers");
        try {
          if (b.browsers !== undefined) {
            next.browsers = browserPicks(b.browsers, knownBrowsers);
            next.chrome = legacyChrome(next.browsers);
          } else {
            next.chrome = chromeSetting(b.chrome, (id) => !!board.chromes.get(id));
            next.browsers = picksFromLegacy(next.chrome);
          }
        } catch (e) {
          if (e instanceof ChromeError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (b.checkinOfferDismissed !== undefined) next.checkinOfferDismissed = b.checkinOfferDismissed === true;
      if (b.effort !== undefined) {
        if (b.effort && !validEffort(String(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
        next.effort = b.effort || null;
      }
      if (b.ultracode !== undefined) {
        if (typeof b.ultracode !== "boolean") throw new HttpError(400, "ultracode must be true or false");
        next.ultracode = b.ultracode;
        // The first version saved ultracode as the effort level: switching it separately keeps that level (xhigh).
        if (next.effort === "ultracode") next.effort = "xhigh";
      }
      if (b.copyFiles !== undefined) {
        if (!Array.isArray(b.copyFiles)) throw new HttpError(400, "copyFiles must be a list of paths");
        next.copyFiles = [...new Set(b.copyFiles.map((f: unknown) => String(f).trim()).filter(Boolean))] as string[];
      }
      if (b.setupCommand !== undefined) next.setupCommand = String(b.setupCommand ?? "").trim();
      if (b.cleanupCommand !== undefined) next.cleanupCommand = String(b.cleanupCommand ?? "").trim();
      if (b.autoHuddles !== undefined) next.autoHuddles = !!b.autoHuddles;
      if (b.keepAwake !== undefined) next.keepAwake = !!b.keepAwake;
      if (b.runCapUsd !== undefined) {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change the board's spending cap");
        next.runCapUsd = capValue(b.runCapUsd, true) || null;
      }
      if (b.artifacts !== undefined) next.artifacts = !!b.artifacts;
      if (b.workspace !== undefined) next.workspace = workspaceValue(b.workspace);
      if (b.claudeAiConnectors !== undefined) {
        const v = parseConnectorSetting(b.claudeAiConnectors);
        if (v === null) throw new HttpError(400, 'claudeAiConnectors must be "all", "none" or a list of connector names');
        next.claudeAiConnectors = v;
      }
      if (b.stallMinutes !== undefined) {
        const n = b.stallMinutes;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1440) throw new HttpError(400, "stallMinutes must be a whole number of minutes from 0 (off) to 1440");
        next.stallMinutes = n;
      }
      if (b.setupDetected !== undefined) next.setupDetected = b.setupDetected && typeof b.setupDetected === "object" ? b.setupDetected : null;
      if (next.path !== profile.path && realFolder(next.path) !== realFolder(profile.path)) {
        refuseSharedFolder(store.listProfiles().filter((p) => p.slug !== slug), next.path);
      }
      if (next.path !== profile.path) shells.kill(slug);
      store.saveProfile(next);
      bus.emit({ type: "profile.updated", slug, profile: next });
      board.dispatch(slug);
      return json(next);
    }
    if (m === "DELETE") {
      if (board.running(slug) > 0) throw new HttpError(409, "board has running tickets");
      store.deleteProfile(slug);
      snippets.dropScope(slug);
      shells.kill(slug);
      bus.emit({ type: "profile.updated", slug, profile: null });
      return new Response(null, { status: 204 });
    }
  }

  // /profiles/:p/detect-setup — what worktree setup detection finds now (the settings dialog decides what to save)
  if (parts[2] === "detect-setup" && parts.length === 3 && m === "POST") return json(await detectSetup(profile.path));

  // /profiles/:p/commands — skills and commands in the profile folder (the `/` picker of new ticket and schedule descriptions)
  if (parts[2] === "commands" && parts.length === 3 && m === "GET") {
    return json(listCommands(profile.path, { projects: [profile.path] }).map(({ local, ...c }) => c));
  }

  // /profiles/:p/sessions — Claude Code sessions started in the profile folder
  if (parts[2] === "sessions" && parts.length === 3 && m === "GET") {
    const commands = await processCommands();
    const linked = new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
    return json(listSessions(profile.path).map((s) => ({
      ...s,
      live: liveSessionMatch(commands, s),
      ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
    })));
  }

  // /profiles/:p/files?path= (one directory level) and /profiles/:p/file?path= (read-only contents). With &ticket=<id>:
  // in that ticket's copy of the folder (panelFolder), else the board folder.
  if ((parts[2] === "files" || parts[2] === "file") && parts.length === 3 && m === "GET") {
    const rel = url.searchParams.get("path") ?? "";
    const { root } = panelFolder(slug, profile.path, url.searchParams.get("ticket"));
    try {
      if (parts[2] === "files") return json({ path: rel, ...(await listDirPage(root, rel)) });
      return json(readFileForView(root, rel));
    } catch (e) {
      if (e instanceof FileError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  // /profiles/:p/open-file { path } — open a file from the explorer in its default app
  if (parts[2] === "open-file" && parts.length === 3 && m === "POST") {
    const b = (await body(req)) ?? {};
    const rel = String(b.path ?? "");
    const { root } = panelFolder(slug, profile.path, typeof b.ticket === "string" ? b.ticket : null);
    try {
      openWithSystem(root, rel, process.env.CKANBAN_OPEN_BIN);
    } catch (e) {
      if (e instanceof FileError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return json({ ok: true });
  }

  // /profiles/:p/shell[?ticket=<id>] — WebSocket to the interactive shell of the board folder, or of that ticket's copy
  if (parts[2] === "shell" && parts.length === 3 && m === "GET") {
    if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
    if (!isAllowedSocket(req, server.port ?? deps.port, remote.active(), listenerOf(req))) throw new HttpError(403, "forbidden");
    const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
    const where = panelFolder(slug, profile.path, url.searchParams.get("ticket"));
    const data: ShellSocket = { slug, folder: where.ticket, cwd: where.root, cols: dim("cols", 80), rows: dim("rows", 24) };
    if ((via.get(req)?.srv ?? server).upgrade(req, { data })) return undefined;
    throw new HttpError(400, "expected a WebSocket upgrade");
  }

  // POST /profiles/:p/find-links — Find links: Claude suggests parents for tickets without one. Nothing changes here;
  // the user's Link selected sets each one (PATCH partOf).
  if (parts[2] === "find-links" && parts.length === 3 && m === "POST") {
    await userOnly(req, "Finding links");
    try {
      return json(await linker.find(slug));
    } catch (e) {
      throw new HttpError(502, `Couldn't find links: ${(e as Error).message}`);
    }
  }
  return NEXT;
}
