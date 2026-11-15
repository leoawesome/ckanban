// A ticket's context, activity, family, feature status, gathering, snooze, follow-ups, devices, notify, seen and usage. Moved verbatim from http.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pauser } from "../core/lag";
import { FollowUpError } from "../schedules/followup";
import { TOOL_NO_NOTIFY } from "../board/main-ticket";
import { resolveRun } from "../../web/src/lib/models";
import { addPrs } from "../board/prs";
import { resumeCommand } from "../runs/prompts";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { SNOOZE_FOREVER, SNOOZE_MS, snoozeKey, ticketAttention } from "../helper/attention";
import { MessageError } from "../helper/notify";
import { DeviceError, TAKE_WAIT_MS } from "../browser/devices";
import { readSideSpend } from "../runs/side-call";
import { readWindows, ticketRuns, ticketUsage, windowsNeeded } from "../usage/ticket-usage";
import { familyOf, featureRoot, hiddenTool, withYouTool, LINK_WORDS, parentLink } from "../../web/src/features/family/family";
import { STATUS_FIELDS, type StatusPatch } from "../board/feature";
import type { Profile, Ticket } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/tickets/:id/{context,activity,family,family-view,status,own-work,gather,snooze,follow-up,devices,notify,seen,usage} */
export async function ticketInfoRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile, id: string, action: string): Promise<RouteResult> {
  const { store, bus, board, json, sessions, huddles, contextRoute, windowsFile, usage, spend, claudeLogs, runLogs, notifier, otherBoard, askedBy, runBoard, ownRun, view } = ctx;
  // The Context panel: how much of Claude's memory the ticket's chat fills (GET cached, POST checks now).
  if (action === "context" && parts.length === 5 && (m === "GET" || m === "POST")) {
    return contextRoute(req, "ticket", slug, id, () => board.contextSpec(slug, id), "Checking a chat's context", () => board.contextSession(slug, id));
  }
  // The log's newest page; `?before=` (the previous answer's `before`) pages back, null once the first entry is in.
  if (action === "activity" && m === "GET") {
    const raw = url.searchParams.get("before");
    const before = raw === null ? undefined : Number(raw);
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new HttpError(400, "before must be a byte offset from a previous page");
    return json(await store.readActivityPageAsync(slug, id, before));
  }
  // The ticket's whole family from the top ticket down (web/src/features/family/family.ts), with each one's session and last result.
  if (action === "family" && m === "GET") {
    return json(familyOf(store.listTickets(slug), id).map(({ ticket: t, depth, how }) => ({
      id: t.id, title: t.title, status: t.status, depth, how: how && LINK_WORDS[how], parent: depth ? parentLink(t)?.id ?? null : null,
      ...(depth && t.main ? { subFeature: true } : t.tool ? { task: true, ...(t.showOnBoard ? { showOnBoard: true } : {}) } : t.showOnBoard === false ? { showOnBoard: false } : {}),
      sessionId: t.sessionId, resumeCommand: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? profile.path, t.sessionId) : null,
      prUrl: t.prUrl, updatedAt: t.updatedAt, result: store.lastAiComment(slug, t.id),
    })));
  }
  // The Family tab: the whole family from the top with each ticket's model, cost, state and last summary. The family's
  // total cost is worked out here only, never written into a ticket's own spend.
  if (action === "family-view" && m === "GET") {
    // A cold daemon reads the board's tickets and huddles in slices first.
    await store.loadHuddles(slug);
    const tickets = await store.listTicketsSliced(slug);
    const hosts = board.hostHuddles(slug);
    // Each member's cost read first in slices (a compressed old log decompressed off the event loop): the rows below
    // then only read what is new.
    const pause = pauser();
    const family = familyOf(tickets, id);
    for (const { ticket: t } of family) await spend.ticketAsync(slug, t.id, pause).catch(() => {});
    // Each row reads the ticket's last comment and checks its report file: a 300-task feature paused between rows.
    const rows = [];
    for (const { ticket: t, depth } of family) {
      await pause();
      const v = view(profile, t, hosts);
      const out = store.outputsPath(slug, t.id);
      rows.push({
        id: t.id, depth, parent: depth ? parentLink(t)?.id ?? null : null,
        // A sub-feature row (a main ticket under another): its own card and chat; its tasks are its own.
        ...(depth && t.main ? { subFeature: true, tasks: board.toolTickets(slug, t.id, tickets).length } : {}),
        // What its runs use (the same order as board.ts chatArgs), for the Tasks tab.
        model: resolveRun(t, profile).model, effort: resolveRun(t, profile).effort,
        costUsd: spend.ticket(slug, t.id).costUsd + huddles.ticketSpend(slug, t.id).costUsd,
        needsYou: !!v.attention && v.attention.kind !== "review",
        summary: store.lastAiComment(slug, t.id), finishedAt: v.running ? null : t.runEndedAt ?? t.doneAt ?? null,
        report: existsSync(join(out, "report.md")),
      });
    }
    return json(rows);
  }
  // "Where we are": the feature's status (feature.ts). GET reads it; POST is update_status (the user, a run of a
  // ticket in the same family, or a chat answering the user's typed message, on any board: askedBy); POST notes is
  // "Add a note" (the user only).
  if (action === "status" && parts.length === 5 && m === "GET") {
    const f = board.featureStatus(slug, id);
    return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path });
  }
  if (action === "status" && parts.length === 5 && m === "POST") {
    if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "huddle helpers can't change the feature's status; tell @main what to put there");
    const from = runBoard(req);
    const caller = ownRun(req, slug);
    const all = store.listTickets(slug);
    let by: string | null = null;
    if (from !== null && !(caller && featureRoot(all, caller)?.id === featureRoot(all, id)?.id)) {
      by = askedBy(req, slug);
      if (!by && from !== slug) throw otherBoard("updating a feature's status", slug, from);
      if (!by) {
        throw new HttpError(403, `only runs of tickets in this feature may update its status (${caller} is not in ${id}'s family), ` +
          "or a chat replying to a message the user typed there");
      }
    }
    const b = await body(req);
    const patch: StatusPatch = {};
    for (const f of STATUS_FIELDS) {
      if (b[f] === undefined) continue;
      if (b[f] !== null && typeof b[f] !== "string") throw new HttpError(400, `${f} must be text or null`);
      patch[f] = b[f];
    }
    if (b.prNotes !== undefined) {
      if (!b.prNotes || typeof b.prNotes !== "object" || Array.isArray(b.prNotes)) throw new HttpError(400, "prNotes must map pull request URLs to a short note");
      // Only the family's own pull requests get a note.
      const prs = new Set(board.featureStatus(slug, id).facts.prs.map((p) => p.url));
      patch.prNotes = Object.fromEntries(Object.entries(b.prNotes).filter(([u]) => prs.has(u)).slice(0, 100).map(([u, v]) => [u, typeof v === "string" ? v : null]));
    }
    // Pull requests in other repos, by URL: they join the feature's list and the board tracks their state.
    let addedPrs = false;
    if (b.prs !== undefined) {
      if (!Array.isArray(b.prs) || b.prs.some((u: unknown) => typeof u !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(u))) {
        throw new HttpError(400, "prs must be a list of GitHub pull request URLs, e.g. https://github.com/owner/repo/pull/12");
      }
      const top = featureRoot(store.listTickets(slug), id);
      if (top && b.prs.length) {
        const add = addPrs(top, b.prs.slice(0, 20));
        if ("prs" in add) board.patchPrs(slug, top.id, add as Pick<Ticket, "prs" | "prUrl">);
        addedPrs = true;
      }
    }
    if (!Object.keys(patch).length && !addedPrs) throw new HttpError(400, `nothing to update: pass ${STATUS_FIELDS.join(", ")}, prNotes or prs`);
    const f = board.updateStatus(slug, id, patch);
    if (by) store.addComment(slug, f.top.id, "ai", `Status updated ${by}.`);
    return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path, markdown: f.markdown });
  }
  if (action === "status" && parts[5] === "notes" && m === "POST") {
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user adds notes to the status (Add a note)");
    const b = await body(req);
    try {
      const f = board.addStatusNote(slug, id, String(b.text ?? ""));
      return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // "Make it its own work": a task (tool ticket) becomes a main ticket with its own card and chat; still linked, it is a
  // sub-feature (Board.makeOwnWork). The user, or a chat answering the user's own message (askedBy).
  if (action === "own-work" && m === "POST") {
    const from = runBoard(req);
    if (from !== null && !askedBy(req, slug)) {
      if (from !== slug) throw otherBoard("making a task its own work", slug, from);
      throw new HttpError(403, "making a task its own work works from a chat, in a reply to a message the user typed there");
    }
    try {
      return json(view(profile, await board.makeOwnWork(slug, id)));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Gather tickets into a feature: the user (Family tab), or a chat answering the user's own message (askedBy): the
  // feature's own, another one on this board or one on another board. Credited when it isn't the feature's own.
  if (action === "gather" && m === "POST") {
    const from = runBoard(req);
    const caller = ownRun(req, slug);
    const all = store.listTickets(slug);
    let by: string | null = null;
    if (from !== null) {
      by = askedBy(req, slug);
      if (!by && from !== slug) throw otherBoard("gathering tickets", slug, from);
      if (!by) throw new HttpError(403, "gathering tickets works from a chat, in a reply to a message the user typed there");
      if (caller && featureRoot(all, caller)?.id === featureRoot(all, id)?.id) by = null;
    }
    const b = await body(req);
    if (!Array.isArray(b.tickets) || !b.tickets.length) throw new HttpError(400, "tickets must list { id, group } entries");
    const items = b.tickets.filter((x: any) => x && typeof x.id === "string" && x.id.trim())
      .map((x: any) => ({ id: x.id.trim(), group: typeof x.group === "string" && x.group.trim() ? x.group.trim() : null }));
    try {
      if (b.hide !== undefined && typeof b.hide !== "boolean") throw new HttpError(400, "hide must be true or false");
      const r = await board.gather(slug, id, items, typeof b.newGroup === "string" ? b.newGroup : null, by, { hide: b.hide === true });
      return json({ gathered: r.gathered.map((t) => view(profile, t)), movedUp: r.movedUp, skipped: r.skipped, group: r.group && view(profile, r.group), kept: r.kept });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  // Inbox Snooze: hide what the ticket waits for now (1 day, { hours }, or { forever: true } until unsnoozed); DELETE unsnoozes.
  // Any of them ends when what the ticket waits for changes.
  if (action === "snooze" && (m === "POST" || m === "DELETE")) {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "snoozing is the user's, not a board run's");
    if (m === "DELETE") return json(view(profile, board.setSnooze(slug, id, null)));
    const b = (await body(req)) ?? {};
    const forever = b.forever === true;
    const hours = b.hours === undefined ? SNOOZE_MS / 3600_000 : Number(b.hours);
    if (!forever && !(hours > 0 && hours <= 24 * 30)) throw new HttpError(400, "hours must be between 0 and 720");
    const t = store.getTicket(slug, id)!;
    const session = t.sessionId ? sessions.summary(t.sessionId) : null;
    const huddle = board.hostHuddles(slug).get(id);
    const att = ticketAttention(store, slug, t, session, board.isRunning(slug, id), huddle, (x) => board.isRunning(slug, x));
    if (!att) throw new HttpError(409, "this ticket doesn't need you, nothing to snooze");
    const until = forever ? SNOOZE_FOREVER : new Date(Date.now() + hours * 3600_000).toISOString();
    return json(view(profile, board.setSnooze(slug, id, { until, key: snoozeKey(t, session, att, huddle) })));
  }
  // Follow-ups (followup.ts): a ticket's own Claude sets one (follow_up) or stops it (cancel_follow_up, with a reason);
  // the user's card offers Follow up now (POST .../follow-up/now) and Stop following up (DELETE).
  if (action === "follow-up") {
    const caller = req.headers.get(RUN_HEADER);
    if (caller && (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER))) {
      throw new HttpError(403, "a run can only set or stop follow-ups on its own ticket");
    }
    try {
      if (m === "POST" && parts[5] === "now") {
        if (caller) throw new HttpError(403, "Follow up now is the user's button; set a follow-up with follow_up instead");
        return json(view(profile, await board.wakeFollowUp(slug, id, { manual: true })), 202);
      }
      if (parts.length > 5) throw new HttpError(404, "not found");
      if (m === "POST") {
        const b = (await body(req)) ?? {};
        const opt = (k: string) => (b[k] === undefined || b[k] === null ? null : String(b[k]));
        if (b.cancelOnReply !== undefined && typeof b.cancelOnReply !== "boolean") throw new HttpError(400, "cancelOnReply must be true or false");
        return json(view(profile, board.setFollowUp(slug, id, { after: opt("after"), at: opt("at"), note: opt("note"), cancelOnReply: b.cancelOnReply })), 201);
      }
      if (m === "DELETE") {
        const b = (await body(req).catch(() => ({}))) ?? {};
        return json(view(profile, board.cancelFollowUp(slug, id, caller ? "claude" : "user", b.reason === undefined ? null : String(b.reason))));
      }
    } catch (e) {
      if (e instanceof FollowUpError) throw new HttpError(400, e.message);
      throw e;
    }
  }
  // take_devices / release_devices: the ticket's own Claude takes shared devices just before it uses them (devices.ts).
  if (action === "devices" && m === "POST" && parts.length === 5) {
    const caller = req.headers.get(RUN_HEADER);
    if (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the ticket's own run takes or lets go of devices for it");
    const b = (await body(req)) ?? {};
    try {
      if (b.action === "take") {
        const r = await board.devices.take(slug, id, b.names, Number.isFinite(b.waitMs) ? Math.max(0, Math.min(Number(b.waitMs), TAKE_WAIT_MS)) : TAKE_WAIT_MS);
        return json(r.ok ? r : { ...r, usedBy: r.usedBy.map((u) => ({ ...u, title: store.getTicket(u.slug, u.id)?.title ?? null })) });
      }
      if (b.action === "release") return json({ released: board.devices.release(slug, id, b.names) });
      throw new HttpError(400, "action must be take or release");
    } catch (e) {
      if (e instanceof DeviceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  // notify_user: the ticket's own Claude sends the user a notification in its own words (Notifier.message).
  if (action === "notify" && m === "POST" && parts.length === 5) {
    const caller = req.headers.get(RUN_HEADER);
    if (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the ticket's own Claude sends it a notification, from its run or chat");
    if (hiddenTool(store.getTicket(slug, id)) && !withYouTool(store.getTicket(slug, id))) throw new HttpError(403, TOOL_NO_NOTIFY);
    const b = (await body(req)) ?? {};
    if (typeof b.message !== "string") throw new HttpError(400, "message is required");
    if (b.urgent !== undefined && typeof b.urgent !== "boolean") throw new HttpError(400, "urgent must be true or false");
    if (b.why !== undefined && (typeof b.why !== "string" || b.why.length > 300)) throw new HttpError(400, "why must be one line of text");
    try {
      return json(await notifier.message(slug, id, b.message, { urgent: b.urgent === true, why: typeof b.why === "string" ? b.why : null }));
    } catch (e) {
      if (e instanceof MessageError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  // The user opened the ticket (the follow-up wake prompt says when).
  if (action === "seen" && m === "POST") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user's board marks a ticket seen");
    // Opening the ticket stops its helper reminders (and notes when); a pending reminder skips markSeen's throttle.
    const reminded = notifier.opened(slug, id);
    // Its helper line now says the reminders stopped (Inbox, ticket page).
    if (reminded) bus.emit({ type: "helper.updated" });
    return json(view(profile, board.markSeen(slug, id, reminded)));
  }
  if (action === "usage" && m === "GET") {
    // The usage endpoint rate-limits: a ticket view reuses the shared cached answer.
    const plan = await usage.get();
    const activity = await runLogs.entries(store.activityPath(slug, id));
    const windows = readWindows(windowsFile);
    const needed = windowsNeeded(ticketRuns(activity), windows);
    if (needed.length) await claudeLogs.refresh(Math.min(...needed.map((w) => Date.parse(w.start))));
    return json(ticketUsage({
      activity, windows, machineCost: (a, b) => claudeLogs.costBetween(a, b), windowError: "windows" in plan ? null : plan.error,
      teammates: huddles.ticketSpend(slug, id), side: readSideSpend(store.sideSpendPath(slug, id)).costUsd,
    }));
  }
  return NEXT;
}
