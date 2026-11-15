// A board's ticket list and new tickets. Moved verbatim from http.ts.
import { pauser } from "../core/lag";
import { EFFORT_HELP, MODEL_HELP, validEffort, validModel } from "../chat/commands";
import { isManager, kindDefaults } from "../board/main-ticket";
import { maskSavedJson } from "../integrations/board-keys";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { featureRoot, fitParent, groupsOf, levelOf, MAX_LEVEL, isFeature, parentLink, TICKET_KINDS, type TicketKind } from "../../web/src/features/family/family";
import { boardScope, countScope, DONE_PAGE, donePage, doneSearch, idsScope, listScope } from "../board/ticket-scope";
import { STATUSES, type Profile, type Status, type Ticket } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/tickets */
export async function ticketListRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile): Promise<RouteResult> {
  const { store, board, json, sessions, suggestParent, runRights, byRequest, byRun, byGuest, startsRun, runStart, guestStart, strings, boardIndex, view } = ctx;
  if (parts.length === 3) {
    if (m === "GET") {
      await sessions.ready();
      // Right after a start the board's huddles may not be read yet (loadAllLists runs while pages already load).
      await store.loadHuddles(slug);
      const hosts = board.hostHuddles(slug);
      // The first listing after a start reads the board's ticket files in slices (seconds of frozen daemon otherwise).
      const idx = boardIndex(slug, await store.listTicketsSliced(slug));
      const tickets = idx.tickets;
      const one = (t: Ticket) => ({ ...view(profile, t, hosts), ...(idx.features.has(t.id) ? { feature: true } : {}) });
      // Every caller asks for a scope (ticketScope.ts): the board the unfinished work first, Done in pages or by
      // search; list_tickets and `ticket list` a filtered page (scope=list); board settings a count.
      // Views are built in slices: a whole board's is seconds of work when the Mac is busy.
      const views = async (list: Ticket[]) => {
        const pause = pauser();
        const out = [];
        for (const t of list) {
          await pause();
          out.push(one(t));
        }
        return out;
      };
      const scope = url.searchParams.get("scope");
      // No scope: every ticket, for older clients only (an old ckanban CLI or MCP server); nothing here asks for it.
      // The answer is about 13 MB on a 10,000-ticket board: turned into text a slice at a time, since one
      // JSON.stringify (plus hiding saved keys) of all of it froze the daemon for a few hundred ms on a busy Mac.
      if (!scope) {
        const pause = pauser();
        const rows: string[] = [];
        for (const t of tickets) {
          await pause();
          rows.push(maskSavedJson(store.root, JSON.stringify(one(t))));
        }
        return new Response(`[${rows.join(",")}]`, { headers: { "content-type": "application/json" } });
      }
      const num = (k: string) => Number(url.searchParams.get(k) ?? 0) || 0;
      const list = (k: string) => (url.searchParams.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (scope === "count") return json(countScope(tickets, idx.scope.column));
      if (scope === "list") {
        const status = url.searchParams.get("status");
        if (status && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
        const page = listScope(tickets, {
          status, tool: url.searchParams.get("tool") === "1", q: url.searchParams.get("q"), tags: list("tags"),
          limit: num("limit"), after: url.searchParams.get("after"),
        }, idx.newest);
        return json({ ...page, tickets: await views(page.tickets) });
      }
      const picked = scope === "board" ? boardScope(tickets, { done: num("done"), ids: list("ids"), after: url.searchParams.get("after") }, idx.scope)
        : scope === "done" ? donePage(tickets, num("offset"), num("limit") || DONE_PAGE, idx.scope.column, url.searchParams.get("after"))
        : scope === "search" ? doneSearch(tickets, url.searchParams.get("q") ?? "", list("tags"), idx.scope)
        : scope === "ids" ? idsScope(tickets, list("ids"), idx.scope)
        : null;
      if (!picked) throw new HttpError(400, "scope must be board, done, search, ids, list or count");
      return json({ tickets: await views(picked.tickets), doneTotal: picked.doneTotal, ...("doneHead" in picked ? { doneHead: picked.doneHead } : {}) });
    }
    if (m === "POST") {
      const b = await body(req);
      const title = String(b.title ?? "").trim();
      if (!title) throw new HttpError(400, "title is required");
      const fromRun = req.headers.get(RUN_HEADER)?.split("/");
      // create_ticket's main: true: a new main ticket, like the user's own New ticket, made because the user asked for
      // it in a message they typed in the calling chat (on its own board, or this one). Top level, or with partOf a
      // sub-feature of another main ticket (the family rules decide where: Board.createTicket, linkProblem).
      const wantMain = b.main === true;
      if (b.main !== undefined && b.main !== null && typeof b.main !== "boolean") throw new HttpError(400, "main must be true or false");
      if (wantMain) {
        if (b.parentId) throw new HttpError(400, "a main ticket isn't part of a plan: leave out parentId (use partOf to make it a sub-feature)");
        if (b.sessionId) throw new HttpError(400, "a main ticket can't be made from a linked session: leave out sessionId");
        if (fromRun && (req.headers.get(HUDDLE_HEADER) || !fromRun[1] || !board.userAskedRun(fromRun[0], fromRun[1]))) {
          throw new HttpError(403, "main: true needs a message the user typed in this chat: work runs, follow-ups, plan wake-ups, " +
            "replies to other tickets and huddle helpers can't create main tickets");
        }
      } else if (b.gather !== undefined && b.gather !== null) {
        throw new HttpError(400, "gather only works with main: true (use gather_tickets to add tickets to an existing feature)");
      }
      let gatherItems: { id: string; group: string | null }[] | null = null;
      if (wantMain && b.gather !== undefined && b.gather !== null) {
        if (!Array.isArray(b.gather)) throw new HttpError(400, "gather must list { id, group } entries");
        gatherItems = b.gather.filter((x: any) => x && typeof x.id === "string" && x.id.trim())
          .map((x: any) => ({ id: x.id.trim(), group: typeof x.group === "string" && x.group.trim() ? x.group.trim() : null }));
      }
      const rights = runRights(req, slug);
      // A main ticket's own chat creating a new main ticket: not a tool ticket of its family.
      const { requester, guest } = rights;
      // Part of another ticket's family: a run's own ticket (create_ticket's partOfThisTicket, shown as "from chat") or,
      // for the user, any ticket of this board.
      let partOf = typeof b.partOf === "string" && b.partOf ? b.partOf : undefined;
      if (partOf && !store.getTicket(slug, partOf)) throw new HttpError(400, `ticket ${partOf} not found (partOf)`);
      const ownRun = fromRun?.[0] === slug && fromRun[1] && !req.headers.get(HUDDLE_HEADER) ? store.getTicket(slug, fromRun[1]) ?? null : null;
      let partOfVia = partOf && fromRun?.[0] === slug && fromRun[1] === partOf ? "chat" as const : undefined;
      // Where a run's ticket went instead of the partOf it asked for, and why: told to the run in the reply.
      const placed: string[] = [];
      if (partOf && fromRun && !wantMain) {
        const all = store.listTickets(slug);
        const top = featureRoot(all, partOf);
        // From a run, partOf is any ticket of the run's own feature (at any depth: groups, rounds, other tool tickets,
        // also while its main ticket sits in Done; a sub-feature's runs stay in it), or another open feature's top
        // ticket or group.
        const ownFamily = !!ownRun && !!top && featureRoot(all, ownRun.id)?.id === top.id;
        const feature = !!top && isFeature(all, top) && (top.id === partOf || groupsOf(all, top.id).some((g) => g.id === partOf));
        if (!partOfVia && !ownFamily && !feature) {
          // Anything else never blocks the work: it goes where partOfThisTicket puts it (a chat from another board: top level).
          const asked = partOf;
          [partOf, partOfVia] = ownRun ? [ownRun.id, "chat" as const] : [undefined, undefined];
          placed.push(`partOf ${asked} isn't in this run's own feature or an open feature's top ticket or group, so the ticket went ` +
            `${ownRun ? `under this run's own ticket ${ownRun.id}` : "to the top level"} instead.`);
        }
        // Too deep in the family: under the nearest ticket above it that leaves room.
        const fit = partOf ? fitParent(all, partOf) : undefined;
        if (partOf && fit && fit !== partOf) {
          placed.push(`Under ${partOf} it would be more than ${MAX_LEVEL} levels deep, so it went under ${fit} ("${all.find((t) => t.id === fit)?.title ?? ""}") instead.`);
          [partOf, partOfVia] = [fit, ownRun?.id === fit ? "chat" as const : undefined];
        }
      }
      // A ticket a run makes inside its own main ticket's family is a tool ticket there: a step of the nearest ticket
      // above it that runs steps (a group or round, else the main ticket), so it starts on its own and its result
      // reaches the main ticket.
      let stepOf: Ticket | undefined;
      if (!wantMain && partOf && ownRun && (!rights.planner || isManager(rights.planner))) {
        const at = store.getTicket(slug, partOf)!;
        const main = board.mainOf(slug, at);
        if (main && board.mainOf(slug, ownRun)?.id === main.id) {
          const all = store.listTickets(slug);
          stepOf = main;
          for (let cur: Ticket | undefined = at, n = 0; cur && cur.id !== main.id && n < 50; cur = all.find((o) => o.id === parentLink(cur!)?.id), n++) {
            if (isManager(cur) && levelOf(all, cur.id) + 1 <= MAX_LEVEL) { stepOf = cur; break; }
          }
          if (stepOf.id !== ownRun.id) placed.push(`It is a tool ticket of ${stepOf.id} ("${stepOf.title}"): the board starts it on its own and its result goes there.`);
        }
      }
      const planner = wantMain ? undefined : stepOf ?? rights.planner;
      const runner = rights.runner ?? (wantMain ? rights.planner : undefined);
      let status: Status = STATUSES.includes(b.status) ? b.status : "backlog";
      let mode: "auto" | "interview" = b.mode === "auto" ? "auto" : "interview";
      let parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : undefined;
      const planKey = typeof b.planKey === "string" && b.planKey.trim() ? b.planKey.trim() : undefined;
      const dependsOn = strings(b.dependsOn);
      const needs = strings(b.needs);
      const tags = strings(b.tags);
      // Planned tickets are retired: only a main ticket's (or tool group's) runs add tickets under it, as tool tickets.
      if (parentId && !planner) {
        throw new HttpError(400, "a ticket can't be created under another one: planned tickets are retired. Create it on its own " +
          "(a new ticket is a main ticket that splits its work into tasks), or with partOf to put it in a feature");
      }
      if (planner) {
        // A main ticket adds tool tickets to its own family; the board starts them when their dependencies are done.
        const kids = store.listTickets(slug).filter((c) => c.parentId === planner.id);
        const missing = (dependsOn ?? []).filter((d) => !kids.some((k) => k.id === d || k.planKey === d));
        if (missing.length) throw new HttpError(400, `unknown dependency ${missing.join(", ")}: use a sibling's ticket id or key`);
        [parentId, status, mode] = [planner.id, "backlog", "auto"];
      }
      // A ticket Claude creates inside a main ticket's family is a tool ticket: unattended, never interviewing.
      const tool = !!planner;
      if (parentId && !store.getTicket(slug, parentId)) throw new HttpError(400, `parent ticket ${parentId} not found`);
      if (b.kind !== undefined && b.kind !== null && !TICKET_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${TICKET_KINDS.join(", ")}`);
      const kind: TicketKind | undefined = b.kind ?? undefined;
      // Model and effort for its runs: from create_ticket inside a run, else a tool ticket's kind decides.
      if (b.model !== undefined && b.model !== null && !(typeof b.model === "string" && validModel(b.model))) throw new HttpError(400, `"${b.model}" is not a model name. Use ${MODEL_HELP}.`);
      if (b.effort !== undefined && b.effort !== null && !(typeof b.effort === "string" && validEffort(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
      const defaults = tool ? kindDefaults(kind, profile) : null;
      const model: string | null = (typeof b.model === "string" && b.model) || defaults?.model || null;
      const effort: string | null = (typeof b.effort === "string" && b.effort) || defaults?.effort || null;
      // Made by a schedule's run: what that schedule raised for the user (its next quiet runs follow up on it).
      const runTicket = fromRun?.[0] === slug && fromRun[1] && !req.headers.get(HUDDLE_HEADER) ? store.getTicket(slug, fromRun[1]) : null;
      const raisedBy = runTicket?.scheduleId ? { scheduleId: runTicket.scheduleId, ticketId: runTicket.id } : null;
      const startedBy = runner && startsRun(status) ? runStart(slug, runner) : guest && startsRun(status) ? guestStart(guest) : null;
      // The user's own new ticket, on its own (not under another ticket, not a linked session): a main ticket.
      const main = wantMain || (!fromRun && !parentId && !partOf && !b.sessionId);
      // A tool ticket that changes files starts from its main ticket's copy (git boards), so its work merges back there.
      const mainTicket = tool ? board.mainOf(slug, planner!) : null;
      const startFrom = tool && mainTicket?.branch && mainTicket.worktree ? mainTicket.branch : null;
      let t: Ticket;
      try {
        t = await board.createTicket(slug, {
          title, body: String(b.body ?? ""), status: b.sessionId && !planner ? "backlog" : status, mode, parentId, planKey, dependsOn, needs, tags,
          important: b.important === true, ...(partOf && !tool ? { partOf, ...(partOfVia ? { partOfVia } : {}) } : {}),
          ...(raisedBy ? { raisedBy } : {}), ...(kind ? { kind } : {}),
          ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(main ? { main: true } : {}), ...(tool ? { tool: true } : {}),
          ...(startFrom ? { startFrom } : {}),
        });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (planner) store.addComment(slug, t.id, "ai", `Tool ticket of ${planner.id} ("${planner.title}").`);
      // Its manager's plan runs it (in any column): started now if the plan was resting.
      let planPaused = false;
      if (tool) {
        // Its main ticket's plan still paused by Stop: the step waits, and the reply tells Claude so (no "queued").
        const top = mainTicket ?? planner!;
        planPaused = store.getTicket(slug, top.id)?.plan?.state === "paused";
        // Made by the main ticket's own run while its card sits in Done or Backlog: back to Review, so the step starts.
        // A step made by another run in its family leaves the user's park alone (its plan still runs it).
        if (planner!.main) board.unparkForNewStep(slug, planner!.id);
        board.ensurePlan(slug, planner!.id);
        board.advancePlans(slug);
      }
      if (requester) store.addComment(slug, t.id, "ai", `Created ${byRequest(requester)}.`);
      if (runner) store.addComment(slug, t.id, "ai", `Created ${byRun(runner)}.`);
      if (guest) store.addComment(slug, t.id, "ai", `Created ${byGuest(guest)}.`);
      if (partOfVia) store.addComment(slug, t.id, "ai", `Linked as part of ${partOf} ("${store.getTicket(slug, partOf!)?.title ?? ""}"), the ticket whose chat created it.`);
      if (startedBy) board.markStartedBy(slug, t.id, startedBy);
      if (wantMain && fromRun) store.addComment(slug, t.id, "ai", "Created as a main ticket at the user's request.");
      // Then the tickets the user asked to move into it (Board.gather: they keep their cards, chats, work and PRs).
      let gathered: { gathered: unknown[]; movedUp: unknown[]; skipped: unknown[]; group: unknown } | null = null;
      if (gatherItems?.length) {
        try {
          const r = await board.gather(slug, t.id, gatherItems, typeof b.newGroup === "string" ? b.newGroup : null);
          gathered = { gathered: r.gathered.map((x) => view(profile, x)), movedUp: r.movedUp, skipped: r.skipped, group: r.group && view(profile, r.group) };
        } catch (e) {
          gathered = { gathered: [], movedUp: [], skipped: gatherItems.map((x) => ({ id: x.id, reason: (e as Error).message })), group: null };
        }
      }
      // A ticket the user made (not a run, plan or linked one) gets a parent suggestion in its panel.
      if (!fromRun && !parentId && !partOf) suggestParent(slug, t.id);
      if (b.sessionId && !planner) {
        try {
          await board.linkSession(slug, t.id, String(b.sessionId));
          t = await board.updateTicket(slug, t.id, { status });
        } catch (e) {
          await board.deleteTicket(slug, t.id);
          throw new HttpError(400, (e as Error).message);
        }
      }
      return json({ ...view(profile, store.getTicket(slug, t.id)!), ...(gathered ? { gather: gathered } : {}), ...(planPaused ? { planPaused: true } : {}), ...(placed.length ? { note: placed.join(" ") } : {}) }, 201);
    }
  }
  return NEXT;
}
