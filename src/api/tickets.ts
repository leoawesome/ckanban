// One ticket: read, change, delete. Moved verbatim from http.ts.
import { ConflictError, type Board } from "../board/board";
import { EFFORT_HELP, MODEL_HELP, validEffort, validModel } from "../chat/commands";
import { isManager } from "../board/main-ticket";
import { hasUncommittedChanges } from "../runs/git";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { MAX_RETRIES } from "../board/plan";
import { browserPicks, ChromeError, chromeSetting, legacyChrome, picksFromLegacy } from "../browser/chromes";
import { parentLink } from "../../web/src/features/family/family";
import { SELF_MOVES, STATUSES, type Profile, type SelfMove, type Ticket } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body, capValue, parallelWork } from "./context";

/** /api/profiles/:p/tickets/:id */
export async function ticketRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile, id: string): Promise<RouteResult> {
  const { store, board, json, knownBrowsers, huddles, userOnly, runRights, byRequest, byRun, byGuest, startsRun, runStart, guestStart, strings, view } = ctx;
  if (parts.length === 4) {
    if (m === "GET") return json(view(profile, store.getTicket(slug, id)!));
    if (m === "PATCH") {
      const b = await body(req);
      if (b.status !== undefined && !STATUSES.includes(b.status)) throw new HttpError(400, `invalid status ${b.status}`);
      const target = store.getTicket(slug, id)!;
      // ⭐ Important and suggested tags on its own ticket: any of the ticket's runs may set them (the user said the task
      // matters; a suggestion changes nothing until the user keeps it).
      const own = req.headers.get(RUN_HEADER) === `${slug}/${id}` && !req.headers.get(HUDDLE_HEADER);
      const onlyOwn = Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "important" || k === "suggestedTags");
      // Its own card to Done, Backlog or Ready, asked for by the user in this ticket's chat: moved once the reply ends.
      if (own && Object.keys(b).length === 1 && SELF_MOVES.includes(b.status) && board.requestSelfMove(slug, id, b.status as SelfMove)) {
        return json({ ...view(profile, target), selfMove: b.status });
      }
      const { planner, requester, runner, guest } = own && onlyOwn ? {} : runRights(req, slug, target);
      const patch: Parameters<Board["updateTicket"]>[2] = {};
      const deps = strings(b.dependsOn);
      if (deps) patch.dependsOn = deps;
      const needs = strings(b.needs);
      if (needs) patch.needs = needs;
      const tags = strings(b.tags);
      if (tags) patch.tags = tags;
      const suggested = strings(b.suggestedTags);
      if (suggested) patch.suggestedTags = suggested;
      if (b.parentId === null) patch.parentId = null;
      else if (b.parentId !== undefined) throw new HttpError(400, "parentId can only be cleared (null); use adopt to add a ticket to a plan");
      // Family: partOf a ticket id links it (null unlinks); parentSuggestion null is Not related.
      if (b.partOf !== undefined && b.partOf !== null && (typeof b.partOf !== "string" || !b.partOf)) throw new HttpError(400, "partOf must be a ticket id or null");
      if (b.parentSuggestion !== undefined && b.parentSuggestion !== null) throw new HttpError(400, "parentSuggestion can only be cleared (null)");
      // Show on board: a task (tool ticket) also gets a card; false hides it again (also a card gathered into a feature).
      if (b.showOnBoard !== undefined && typeof b.showOnBoard !== "boolean") throw new HttpError(400, "showOnBoard must be true or false");
      const linkOnly = Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "partOf" || k === "parentSuggestion" || k === "showOnBoard");
      if (b.mode === "auto" || b.mode === "interview") patch.mode = b.mode;
      if (typeof b.expectedBody === "string") patch.expectedBody = b.expectedBody;
      if (typeof b.title === "string") patch.title = b.title;
      if (typeof b.body === "string") patch.body = b.body;
      if (b.status) patch.status = b.status;
      // Starting work while the user's huddle is live on the ticket: both would work on the same thing.
      const working = (st?: string) => st === "ready" || st === "in_progress";
      if (working(patch.status) && !working(target.status) && store.openHuddles(slug).some((h) => h.hostTicket === id && h.status === "live" && !h.auto)) {
        parallelWork(req, b, "huddle-open");
      }
      if (typeof b.order === "number") patch.order = b.order;
      if (b.notice === null) patch.notice = null;
      if (b.important !== undefined) {
        if (typeof b.important !== "boolean") throw new HttpError(400, "important must be true or false");
        patch.important = b.important;
      }
      if (b.pinned !== undefined) {
        if (typeof b.pinned !== "boolean") throw new HttpError(400, "pinned must be true or false");
        patch.pinned = b.pinned;
      }
      // Spending cap per run: a positive amount, 0 for none, null for the board's. Only the user sets it.
      if (b.runCapUsd !== undefined) {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change a ticket's spending cap");
        patch.runCapUsd = capValue(b.runCapUsd, true);
      }
      // Model and effort for this ticket's runs: a name, or null for the board's. Only the user sets them.
      if (b.model !== undefined || b.effort !== undefined || b.ultracode !== undefined) {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change a ticket's model or effort");
      }
      // Ultracode for this ticket's runs: on, off, or null for the board's.
      // Chrome for this ticket's runs: a named Chrome's deviceId, "ask", or null for its main ticket's or the board's.
      // Or a list with notes (browsers, see chromes.ts BrowserPick); null: the ticket above it, else the board's.
      if (b.chrome !== undefined || b.browsers !== undefined) {
        if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user picks a ticket's browsers");
        if (b.browsers !== undefined) await userOnly(req, "Choosing a ticket's browsers");
        try {
          if (b.browsers !== undefined) {
            patch.browsers = browserPicks(b.browsers, knownBrowsers);
            patch.chrome = legacyChrome(patch.browsers);
          } else {
            patch.chrome = chromeSetting(b.chrome, (cid) => !!board.chromes.get(cid));
            patch.browsers = picksFromLegacy(patch.chrome);
          }
        } catch (e) {
          if (e instanceof ChromeError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (b.ultracode !== undefined) {
        if (b.ultracode !== null && typeof b.ultracode !== "boolean") throw new HttpError(400, "ultracode must be true, false or null");
        patch.ultracode = b.ultracode;
        if (target.effort === "ultracode" && b.effort === undefined) patch.effort = "xhigh";
      }
      if (b.model !== undefined) {
        if (b.model !== null && !(typeof b.model === "string" && validModel(b.model))) throw new HttpError(400, `"${b.model}" is not a model name. Use ${MODEL_HELP}.`);
        patch.model = b.model;
      }
      if (b.effort !== undefined) {
        if (b.effort !== null && !(typeof b.effort === "string" && validEffort(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
        patch.effort = b.effort;
      }
      if (planner || requester || runner || guest) {
        delete patch.order;
        delete patch.notice;
      }
      let startedBy: Ticket["startedBy"] | undefined;
      if ((runner || guest) && patch.status === "done" && target.status !== "done") {
        // Done removes the ticket's copy of the folder: a run never closes work that is under way or not saved yet.
        if (board.isRunning(slug, id)) {
          throw new HttpError(409, `${id} is working right now: stop it first with stop_ticket, or leave closing it to the user`);
        }
        if (!target.workdir && target.worktree && await hasUncommittedChanges(target.worktree)) {
          throw new HttpError(409, `${id} has changes in its copy of the folder that aren't saved in its version history yet; ` +
            "moving it to done could lose them, so only the user can close it (on the board)");
        }
      }
      if (startsRun(patch.status) && patch.status !== target.status) {
        // Who starts this run: another ticket's run (refused only for a loop) or the user (clears it).
        if (runner) startedBy = runStart(slug, runner, id);
        else if (guest) startedBy = guestStart(guest, id);
        else if (!planner) startedBy = null;
      }
      if (planner) {
        if (patch.status === "ready" && target.status !== "ready" && target.runCount > 0) {
          try {
            board.countRetry(slug, planner.id, id, MAX_RETRIES);
          } catch (e) {
            throw new HttpError(409, (e as Error).message);
          }
        }
      }
      let t: Ticket = target;
      try {
        if (b.partOf !== undefined) t = await board.setPartOf(slug, id, b.partOf);
        else if (b.parentSuggestion === null) t = board.dismissParentSuggestion(slug, id);
        if (typeof b.showOnBoard === "boolean" && (b.partOf === undefined || t.tool)) t = board.setShowOnBoard(slug, id, b.showOnBoard);
        if (!linkOnly) t = await board.updateTicket(slug, id, patch, { byUser: !req.headers.get(RUN_HEADER) });
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
      if (startedBy !== undefined) board.markStartedBy(slug, id, startedBy);
      const changer = planner ?? requester ?? runner ?? guest;
      if (own && onlyOwn && target.important !== t.important) store.addComment(slug, id, "ai", t.important ? "Claude marked this ticket ⭐ Important." : "Claude cleared ⭐ Important.");
      if (changer) {
        const what = Object.entries(patch)
          .map(([k, v]) => (k === "status" ? `moved it to ${v}` : k === "parentId" ? `released it from plan ${target.parentId}` : k === "important" ? (v ? "marked it ⭐ Important" : "cleared ⭐ Important") : k === "pinned" ? (v ? "pinned it" : "unpinned it") : `changed ${k}`)).join(", ");
        const by = planner ? "" : requester ? byRequest(requester) : runner ? byRun(runner) : byGuest(guest!);
        const was = parentLink(target)?.id ?? null;
        const linked = b.partOf === undefined || b.partOf === was ? ""
          : b.partOf ? `linked it as part of ${b.partOf}` : `unlinked it from ${was}`;
        if (linked) store.addComment(slug, id, "ai", planner ? `Planner ${linked}.` : `${linked[0].toUpperCase()}${linked.slice(1)} ${by}.`);
        if (what) store.addComment(slug, id, "ai", planner ? `Planner ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} ${by}.`);
      }
      return json(view(profile, startedBy === undefined ? t : store.getTicket(slug, id)!));
    }
    if (m === "DELETE") {
      if (req.headers.get(RUN_HEADER)) {
        // A main ticket may delete its own tool tickets; every other delete stays the user's.
        const target = store.getTicket(slug, id)!;
        const { planner } = target.tool ? runRights(req, slug, target) : {};
        if (!planner || !isManager(planner)) throw new HttpError(403, "deleting tickets is disabled inside a board run");
      }
      const doomed = store.getTicket(slug, id)!;
      const main = doomed.main ? doomed : doomed.tool ? board.mainOf(slug, doomed) : null;
      if (main && board.merging(slug, main.id)) throw new HttpError(409, "Wait a moment: a merge is running");
      // A main ticket takes its tool tickets with it (Board.deleteTicket): their huddles close too.
      for (const o of doomed.main ? board.toolTickets(slug, id) : []) huddles.closeForTicket(slug, o.id);
      huddles.closeForTicket(slug, id);
      try {
        await board.deleteTicket(slug, id);
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
      return new Response(null, { status: 204 });
    }
  }
  return NEXT;
}
