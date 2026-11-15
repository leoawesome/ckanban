// What a ticket's buttons and tools do: move, stop, plan, land, PRs and the rest. Moved verbatim from http.ts.
import { ConflictError } from "../board/board";
import { checkPr, mergePr, PrError, REFRESH_MIN_MS, refreshPr, resolveConflicts, sendFailures } from "../runs/prpoller";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { familyRoot } from "../../web/src/features/family/family";
import { isManager } from "../board/main-ticket";
import type { Profile } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/tickets/:id/{link-session,branch,move,...,planning-command} */
export async function ticketActionRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile, id: string, action: string): Promise<RouteResult> {
  const { deps, store, board, json, huddles, runRights, inFamily, byRequest, byRun, byGuest, runTicket, strings, view } = ctx;
  if (m === "POST" && action === "link-session") {
    const b = await body(req);
    try {
      const t = await board.linkSession(slug, id, b.sessionId ? String(b.sessionId) : null);
      return json(view(profile, t));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Branch: a new ticket with a copy of this one's conversation and committed code (the user's call, not a run's).
  if (m === "POST" && action === "branch") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "branching is disabled inside a board run; use the propose_branch tool so the user can click Branch");
    try {
      const r = await board.branchTicket(slug, id);
      return json({ ticket: view(profile, r.ticket), warning: r.warning }, 201);
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Move a Backlog ticket to another board (the user's click, not a run's).
  if (m === "POST" && action === "move") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "moving tickets is the user's call, not a run's");
    const b = await body(req);
    const target = String(b.board ?? "");
    if (!store.getProfile(target)) throw new HttpError(404, "board not found");
    try {
      const t = await board.moveTicket(slug, id, target);
      huddles.closeForTicket(slug, id);
      return json(view(store.getProfile(target)!, t), 201);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Follow-up work on a ticket that already ran (the user's click on its proposal card): a step of its feature, or its
  // first step as it becomes a main ticket; the ticket keeps its title and description.
  if (m === "POST" && action === "follow-up-work") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "follow-up work starts with the user's click on a proposal card; use the propose_ticket tool");
    const b = await body(req);
    try {
      const t = await board.followUpWork(slug, id, { title: String(b.title ?? ""), body: String(b.body ?? ""), start: !!b.start, important: b.important === true });
      return json(view(profile, t), 201);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // One-click recovery: the session is gone (fresh-session) or open in a terminal (take-over). The user's call.
  if (m === "POST" && (action === "fresh-session" || action === "take-over")) {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "session recovery is the user's call, not a run's");
    try {
      if (action === "fresh-session") return json({ ticket: view(profile, board.startFresh(slug, id)), external: false });
      const r = await board.takeOver(slug, id);
      return json({ ticket: view(profile, r.ticket), external: r.external });
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  // "Fresh chat (keeps status)": the next message starts a new Claude session; history, status and outputs stay.
  if (m === "POST" && action === "fresh-chat") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "a fresh chat is the user's call, not a run's");
    try {
      return json(view(profile, board.freshChat(slug, id)));
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Installs the worktree's dependencies (the board's setup command) when the ticket's Claude needs them; waits for it.
  if (m === "POST" && action === "setup") {
    // A run may only install its own ticket's dependencies (the command runs the branch's install scripts).
    if (req.headers.get(RUN_HEADER) && runTicket(req, slug) !== id) throw new HttpError(403, "a board run may only run the setup of its own ticket");
    return json(await board.runSetup(slug, id));
  }
  // Main and tool tickets (main-ticket.ts). ask: a run asks a ticket of its family (POST .../<asker>/ask {target, question}).
  if (m === "POST" && action === "ask") {
    const asker = runTicket(req, slug);
    if (!asker || asker !== id || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "ask_ticket works from a board run, for that run's own ticket");
    const b = await body(req);
    const target = store.getTicket(slug, String(b.target ?? ""));
    if (!target) throw new HttpError(404, `ticket ${b.target} not found`);
    if (!inFamily(slug, id, target.id) && familyRoot(store.listTickets(slug), id)?.id !== familyRoot(store.listTickets(slug), target.id)?.id) {
      throw new HttpError(403, `${target.id} is not in this ticket's family`);
    }
    try {
      return json({ message: board.askTicket(slug, id, target.id, String(b.question ?? "")) }, 202);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // merge_into_main: a tool ticket's own run fast-forwards its main ticket's copy.
  if (m === "POST" && action === "merge-into-main") {
    if (runTicket(req, slug) !== id || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "merge_into_main works only from the tool ticket's own run");
    try {
      return json({ message: await board.mergeIntoMain(slug, id) });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }
  // land_milestone: the main ticket's own run (or the user) lands its copy.
  if (m === "POST" && action === "land") {
    const caller = runTicket(req, slug);
    if ((caller && caller !== id) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "land_milestone works only from the main ticket's own run");
    const b = await body(req);
    try {
      return json({ message: await board.landMilestone(slug, id, String(b.summary ?? "")) });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }
  if (m === "POST" && action === "stop") {
    const target = store.getTicket(slug, id)!;
    const { planner, requester, runner, guest } = runRights(req, slug, target);
    // The user's Stop on a main ticket stops its running tool tickets too.
    if (target.main && !req.headers.get(RUN_HEADER)) {
      const r = board.stopFamily(slug, id);
      return json({ stopped: r.stopped, tools: r.tools });
    }
    const stopped = board.stop(slug, id);
    if (planner && stopped) store.addComment(slug, id, "ai", "Planner stopped this run.");
    if (requester && stopped) store.addComment(slug, id, "ai", `Run stopped ${byRequest(requester)}.`);
    if (runner && stopped) store.addComment(slug, id, "ai", `Run stopped ${byRun(runner)}.`);
    if (guest && stopped) store.addComment(slug, id, "ai", `Run stopped ${byGuest(guest)}.`);
    return json({ stopped });
  }
  // Start / pause / resume / mark done the plan that runs a main ticket's (or tool group's) tool tickets.
  if (m === "POST" && action === "plan") {
    const b = await body(req);
    // Planned tickets are retired: only main tickets and tool groups run their tickets with a plan.
    if ((b.action === "start" || b.action === "resume") && !isManager(store.getTicket(slug, id))) {
      throw new HttpError(400, "only a main ticket runs tickets of its own: turn this ticket into a main ticket first");
    }
    // A main ticket may start or resume its own plan (plan_control) when it has planner rights; the rest is the user's.
    const byPlanner = !!req.headers.get(RUN_HEADER);
    if (byPlanner) {
      if (runTicket(req, slug) !== id || (b.action !== "start" && b.action !== "resume")) {
        throw new HttpError(403, "a board run may only start or resume its own ticket's plan; pausing and finishing are the user's");
      }
      if (!board.plannerRights(slug, id)) {
        throw new HttpError(403, "starting the plan from a board run needs the user's go-ahead: only a reply to the user's message in this ticket's chat may do it");
      }
      if (store.getTicket(slug, id)!.plan?.state === "done") throw new HttpError(403, "this ticket's plan is done; the user can start a new one first");
    }
    try {
      const t = b.action === "pause" ? board.pausePlan(slug, id)
        : b.action === "start" || b.action === "resume" ? board.startPlan(slug, id, { byPlanner })
        : b.action === "done" ? board.markPlanDone(slug, id)
        : null;
      if (!t) throw new HttpError(400, "action must be start, pause, resume or done");
      return json(view(profile, store.getTicket(slug, id) ?? t));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  // A run stopped at its spending cap: "Continue with +$Y" ({addUsd}).
  if (m === "POST" && action === "cap-continue") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can continue a ticket past its spending cap");
    const b = await body(req);
    try {
      return json(view(profile, await board.continueAfterCap(slug, id, Number(b.addUsd))), 202);
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Stalled run (no output for the board's stall time): Stop, Keep waiting or Restart in the same session.
  if (m === "POST" && action === "stall") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can stop, keep waiting on or restart a stalled run");
    const b = await body(req);
    if (b.action !== "stop" && b.action !== "wait" && b.action !== "restart") throw new HttpError(400, "action must be stop, wait or restart");
    try {
      return json(view(profile, board.stallAction(slug, id, b.action)));
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }
  // Usage limit: "Continue now" (action: continue), or "Don't auto-continue" / "Auto-continue" (auto: boolean).
  if (m === "POST" && action === "limit") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can continue a ticket after the usage limit or change its auto-continue");
    const b = await body(req);
    if (b.action === "continue") {
      try {
        return json(view(profile, await board.continueAfterLimit(slug, id)), 202);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (typeof b.auto !== "boolean") throw new HttpError(400, "send {action: \"continue\"} or {auto: true|false}");
    return json(view(profile, board.setAutoContinue(slug, id, b.auto)));
  }
  if (m === "POST" && action === "check-pr") {
    const state = await checkPr(board, store, slug, id);
    return json({ state, ticket: view(profile, store.getTicket(slug, id)!) });
  }
  // Review PR box: refresh (rate-limited unless force), send failing CI logs to Claude, resolve conflicts, Merge & done.
  if (m === "POST" && action === "pr" && ["refresh", "send-failures", "resolve-conflicts", "merge"].includes(parts[5])) {
    if (parts[5] !== "refresh" && req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can merge a PR or send its CI failures or conflicts from the board");
    try {
      if (parts[5] === "refresh") {
        const force = !!(await body(req).catch(() => ({} as Record<string, unknown>))).force;
        const pr = await refreshPr(board, store, slug, id, { ...deps.pr, maxAgeMs: force ? 0 : REFRESH_MIN_MS });
        return json({ pr, ticket: view(profile, store.getTicket(slug, id)!) });
      }
      const t = parts[5] === "merge" ? await mergePr(board, store, slug, id, deps.pr)
        : parts[5] === "resolve-conflicts" ? await resolveConflicts(board, store, slug, id, deps.pr)
        : await sendFailures(board, store, slug, id, deps.pr);
      return json(view(profile, t), parts[5] === "merge" ? 200 : 202);
    } catch (e) {
      if (e instanceof PrError) throw new HttpError(e.status, e.message);
      if (e instanceof HttpError || e instanceof ConflictError) throw e;
      throw new HttpError(502, (e as Error).message);
    }
  }
  if (m === "POST" && action === "planning-command") {
    try {
      return json({ command: await board.planningCommand(slug, id) });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  return NEXT;
}
