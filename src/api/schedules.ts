// Schedules, automations (loops), one-time jobs and the set-up-with-Claude chats. Moved verbatim from http.ts.
import { pauser } from "../core/lag";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { quietDays, scheduleSpend } from "../schedules/quiet";
import type { Profile, Schedule, ScheduleEditor } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/schedules, automation-setup, checkin-setup, loops, jobs */
export async function scheduleRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile): Promise<RouteResult> {
  const { store, board, json, scheduler, jobs, spend, loops, userOnly, scheduleDeleter, profileOr404, runTicket, view, emitTicket } = ctx;
  // /profiles/:p/schedules — recurring ticket templates
  if (parts[2] === "schedules") {
    // Set by the ckanban MCP tools inside a board run ("<profile>/<ticket id>"): the edit is credited to that ticket.
    const run = req.headers.get(RUN_HEADER)?.split("/")[1] ?? "";
    const by: ScheduleEditor = /^t_[a-z0-9_]+$/i.test(run) ? { ticketId: run } : "user";
    // The list also shows each schedule's spend over 7 days and its quiet checks per day (quiet.ts).
    const view7 = async (s: Schedule, pause: () => Promise<void>) => {
      const h = await store.scheduleHistoryDigestAsync(slug, s.id, pause);
      const costOf = (tid: string) => (store.getTicket(slug, tid) ? spend.ticket(slug, tid).costUsd : 0);
      // A paused one also says when and by whom (its last "paused" edit), for the Paused section's status line.
      const p = s.enabled ? null : h.lastPause;
      const paused = p ? {
        pausedAt: p.at,
        pausedBy: p.by === "user" ? "user" as const : { ticketId: p.by.ticketId, title: store.getTicket(slug, p.by.ticketId)?.title ?? null },
      } : {};
      return { ...scheduler.view(slug, s), spend7dUsd: scheduleSpend(h.recent, new Date(Date.now() - 7 * 86_400_000), costOf), quietPerDay: quietDays(h.quietPerDay).slice(0, 7), ...paused };
    };
    if (parts.length === 3 && m === "GET") {
      const pause = pauser();
      const out = [];
      for (const s of store.listSchedules(slug)) out.push(await view7(s, pause));
      return json(out);
    }
    if (parts.length === 3 && m === "POST") return json(scheduler.view(slug, scheduler.create(slug, (await body(req)) ?? {}, by)), 201);
    const sid = parts[3];
    if (parts.length === 4 && m === "PATCH") return json(scheduler.view(slug, scheduler.update(slug, sid, (await body(req)) ?? {}, by)));
    if (parts.length === 4 && m === "DELETE") {
      await scheduleDeleter(req);
      scheduler.remove(slug, sid, by);
      return new Response(null, { status: 204 });
    }
    if (parts.length === 5 && parts[4] === "history" && m === "GET") return json(scheduler.history(slug, sid));
    if (parts.length === 5 && parts[4] === "run" && m === "POST") {
      // Any run may run a schedule now, its own schedule's run too; the history notes which ticket asked. Huddle
      // helpers only review (as for jobs), and a run only reaches its own board (as for jobs).
      if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "huddle participants can't run a schedule now; ask @main");
      const runner = runTicket(req, slug);
      if (runner && !store.getTicket(slug, runner)) throw new HttpError(404, `ticket ${runner} not found`);
      const entry = await scheduler.runNow(slug, sid, by);
      return json({ entry, schedule: scheduler.view(slug, scheduler.get(slug, sid)) });
    }
    throw new HttpError(404, "not found");
  }

  // POST /profiles/:p/automation-setup — Automations → Set up with Claude: a Planning ticket whose chat sets one up.
  if (parts[2] === "automation-setup" && parts.length === 3 && m === "POST") {
    await userOnly(req, "Setting up an automation");
    const t = await board.createTicket(slug, {
      title: "Set up an automation", status: "planning",
      body: "Set up an automation for this board with Claude: say what to watch (for example \"new Linear issues assigned to me\") and how often to check.",
    });
    store.updateTicket(slug, t.id, { automationSetup: true });
    emitTicket(slug, t.id);
    return json(view(profileOr404(slug), store.getTicket(slug, t.id)!), 201);
  }

  // POST /profiles/:p/checkin-setup — Schedules → Proactive check-ins: a Planning ticket whose chat sets up a quiet
  // check-in schedule (checkin-guides.ts). Nothing runs or costs anything until that chat creates the schedule.
  if (parts[2] === "checkin-setup" && parts.length === 3 && m === "POST") {
    await userOnly(req, "Setting up check-ins");
    const t = await board.createTicket(slug, {
      title: "Set up proactive check-ins", status: "planning",
      body: "Set up proactive check-ins with Claude: every work hour, Claude checks what needs you (messages, reviews, meetings coming up) and raises only that in Review. Pick what to check, your hours and what counts as urgent.",
    });
    store.updateTicket(slug, t.id, { checkinSetup: true });
    emitTicket(slug, t.id);
    return json(view(profileOr404(slug), store.getTicket(slug, t.id)!), 201);
  }

  // /profiles/:p/loops — automations: a check script on a timer turns new items into tickets. Anyone lists and
  // test-runs a script (the setup chat does); only the user saves, changes or runs one for real.
  if (parts[2] === "loops") {
    if (parts.length === 3 && m === "GET") return json(loops.list(slug));
    if (parts.length === 4 && parts[3] === "test" && m === "POST") return json(await loops.test(slug, (await body(req)) ?? {}));
    await userOnly(req, "Saving or changing an automation");
    if (parts.length === 3 && m === "POST") {
      const l = await loops.create(slug, (await body(req)) ?? {});
      // Its first check notes what is there already (no tickets) and fills "Last check found".
      void loops.checkNow(slug, l.id).catch(() => {});
      return json(l, 201);
    }
    const lid = parts[3];
    if (parts.length === 4 && m === "PATCH") {
      const b = (await body(req)) ?? {};
      const l = await loops.update(slug, lid, b);
      // A new script or switching it on starts with a check that notes what is there (see create).
      if (l.enabled && l.state === "ok" && (b.script !== undefined || b.enabled === true)) void loops.checkNow(slug, l.id).catch(() => {});
      return json(l);
    }
    if (parts.length === 4 && m === "DELETE") {
      await loops.remove(slug, lid);
      return new Response(null, { status: 204 });
    }
    if (parts.length === 5 && parts[4] === "check" && m === "POST") return json(await loops.checkNow(slug, lid));
    if (parts.length === 5 && parts[4] === "copy" && m === "POST") return json(await loops.copy(slug, lid, String((await body(req))?.to ?? "")), 201);
    throw new HttpError(404, "not found");
  }

  // /profiles/:p/jobs — one-time jobs (jobs.ts). Anyone lists; a board run or chat (RUN_HEADER) schedules jobs as its
  // ticket and may change, run or cancel any job on its board (credited to its ticket on the job). Huddle helpers can't.
  if (parts[2] === "jobs") {
    if (parts.length === 3 && m === "GET") {
      // finishedDays (the board UI): every job finished in that many days, not just the last 20.
      const days = Number(url.searchParams.get("finishedDays"));
      const finishedDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : undefined;
      return json(jobs.list(slug, url.searchParams.get("ticketId"), finishedDays).map((j) => jobs.view(j)));
    }
    if (parts.length === 4 && m === "GET") return json(jobs.view(jobs.get(slug, parts[3])));
    // Huddle teammates run as their host ticket but only review: jobs run in the board folder.
    if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "huddle participants can't schedule or change jobs; ask @main");
    const by = runTicket(req, slug);
    if (by && !store.getTicket(slug, by)) throw new HttpError(404, `ticket ${by} not found`);
    if (parts.length === 3 && m === "POST") return json(jobs.view(jobs.create(slug, (await body(req)) ?? {}, by)), 201);
    const jid = parts[3];
    if (parts.length === 4 && m === "PATCH") return json(jobs.view(await jobs.update(slug, jid, (await body(req)) ?? {}, by)));
    if (parts.length === 5 && m === "POST") {
      if (parts[4] === "cancel") return json(jobs.view(await jobs.cancel(slug, jid, by)));
      if (parts[4] === "run") return json(jobs.view(await jobs.runNow(slug, jid, by)));
    }
    throw new HttpError(404, "not found");
  }
  return NEXT;
}
