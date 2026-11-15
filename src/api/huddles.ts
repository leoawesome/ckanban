// Huddle routes (/api/profiles/:p/huddles/...). Moved verbatim from http.ts.
import { RUN_HEADER } from "../schedules/scheduler";
import type { Caller } from "../huddle/huddle";
import { participantSession, participantTool } from "../huddle/huddle-session";
import { HUDDLE_HEADER, SOURCE_HEADER } from "../huddle/huddle-roster";
import { revealFile } from "../board/share";
import { type ApiContext, HttpError, body, parallelWork } from "./context";

/**
 * Huddle routes. The sender of a message is never taken from the body: a request from a board run is that run's
 * participant (its token for agents), anything else is the user (@you). Stop, resume, close and stopping one
 * participant are the user's alone.
 */
export async function huddleApi(ctx: ApiContext, req: Request, url: URL, slug: string, rest: string[]): Promise<Response> {
  const { store, board, json, sessions, huddleSessions, sideCall, huddles } = ctx;
  const m = req.method;
  const who: Caller = { run: req.headers.get(RUN_HEADER), agent: req.headers.get(HUDDLE_HEADER) };
  const userOnly = (what: string) => {
    if (who.run || who.agent) throw new HttpError(403, `only the user can ${what}; ask them in the huddle (tag @you)`);
  };
  const num = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
  };
  // start_huddle: the host ticket's own unattended run starts its review huddle, or its chat when the user asked (Huddles.startAuto checks the rest).
  if (rest.length === 1 && rest[0] === "auto" && m === "POST") {
    const [runSlug, ticketId] = (who.run ?? "").split("/");
    if (!who.run || who.agent || runSlug !== slug || !ticketId) {
      throw new HttpError(403, "only a board run of the host ticket can start an auto huddle; propose a roster with propose_huddle instead");
    }
    const b = await body(req);
    const out = huddles.startAuto(slug, ticketId, {
      reason: typeof b.reason === "string" ? b.reason : "",
      trigger: typeof b.trigger === "string" ? b.trigger : undefined,
      template: ([b.squad, b.template].find((v) => typeof v === "string" && v.trim()) as string | undefined)?.trim(),
      roster: Array.isArray(b.roster) ? b.roster : undefined,
      maxCostUsd: b.maxCostUsd === undefined || b.maxCostUsd === null ? undefined : Number(b.maxCostUsd),
      topic: typeof b.topic === "string" ? b.topic : undefined,
    });
    return json({ waiting: out.waiting, template: out.template, huddle: out.huddle ? huddles.view(slug, out.huddle) : null }, out.waiting ? 202 : 201);
  }
  if (rest.length === 0) {
    if (m === "GET") {
      // open=1: only the huddles still going (the board's first load); the Huddles list asks for all of them.
      return json(await huddles.listSliced(slug, { ticketId: url.searchParams.get("ticket") ?? undefined, open: url.searchParams.get("open") === "1" }));
    }
    if (m === "POST") {
      userOnly("start a huddle (propose a roster with propose_huddle instead)");
      const b = await body(req);
      const ticketId = String(b.ticketId ?? "");
      if (!ticketId) throw new HttpError(400, "ticketId is required");
      // The ticket's run is doing the work (not a chat reply in Planning or Review): a huddle now would work alongside it.
      const host = store.getTicket(slug, ticketId);
      if (host && (host.status === "ready" || host.status === "in_progress") && board.isRunning(slug, ticketId)) parallelWork(req, b, "run-active");
      const squad = [b.squad, b.template].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      const h = huddles.create(slug, ticketId, Array.isArray(b.roster) ? b.roster : [], {
        maxParticipants: Number(b.maxParticipants) || undefined,
        maxCostUsd: b.maxCostUsd === undefined || b.maxCostUsd === null ? undefined : Number(b.maxCostUsd),
        template: squad,
        topic: b.topic,
      });
      return json(huddles.view(slug, h), 201);
    }
    throw new HttpError(404, "not found");
  }
  const { h, me } = huddles.identify(slug, rest[0], who);
  const [, action, handle, sub, part, partId] = rest;
  if (!action && m === "GET") {
    const page = huddles.messages(slug, h.id, { before: num("before"), since: num("since"), limit: num("limit") });
    return json({ huddle: huddles.view(slug, h), you: me.handle, ...page });
  }
  if (m === "POST" && action === "messages" && !handle) {
    const b = await body(req);
    const kind = b.kind === "finding" ? "finding" : "message";
    const status = b.status ? { status: b.status, reason: typeof b.reason === "string" ? b.reason : undefined, lessons: b.lessons } : undefined;
    const src = req.headers.get(SOURCE_HEADER);
    return json(huddles.post(slug, h.id, me, String(b.text ?? ""), kind, status, src === "ui" || src === "mcp" ? src : "none"), 201);
  }
  // The pinned brief (goal, decisions): leads, @main and the user.
  if (m === "PUT" && action === "brief" && !handle) {
    const b = await body(req);
    return json(huddles.view(slug, huddles.setBrief(slug, h.id, me, String(b.text ?? ""))));
  }
  // A participant's own status: done, blocked (reason) or active again.
  if (m === "POST" && action === "status" && !handle) {
    const b = await body(req);
    const { token: _t, ...p } = huddles.setStatus(slug, h.id, me, b.status, typeof b.reason === "string" ? b.reason : undefined, b.lessons);
    return json(p);
  }
  // @main or a lead asks the user to close the huddle (only the user closes it).
  if (m === "POST" && action === "close-request" && !handle) {
    const b = await body(req);
    return json(huddles.view(slug, huddles.requestClose(slug, h.id, me, typeof b.reason === "string" ? b.reason : "")));
  }
  if (action === "participants") {
    if (m === "POST" && !handle) {
      const b = await body(req);
      const added = huddles.addParticipants(slug, h.id, me, b ?? {});
      return json({ added: added.map(({ token: _t, ...p }) => p), huddle: huddles.view(slug, huddles.get(slug, h.id)) }, 201);
    }
    if (m === "PATCH" && handle && !sub) {
      const b = await body(req);
      huddles.setMode(slug, h.id, me, handle, b.mode);
      return json(huddles.view(slug, huddles.get(slug, h.id)));
    }
    if (m === "POST" && handle && sub === "stop") {
      userOnly("stop a participant");
      huddles.stopParticipant(slug, h.id, handle);
      return json(huddles.view(slug, huddles.get(slug, h.id)));
    }
    // A participant's own Claude session, read-only (the Huddle tab's session viewer). The user's alone: agents
    // and runs can't read each other's sessions.
    if (handle && sub === "session") {
      userOnly("read a participant's session");
      if (m === "GET" && !part) {
        return json(participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { before: num("before"), since: num("since"), limit: num("limit") }));
      }
      if (m === "GET" && part === "tool" && partId) {
        const d = participantTool(huddles, sessions, slug, h.id, handle, partId);
        if (!d) throw new HttpError(404, "tool call not found");
        return json(d);
      }
      if (m === "POST" && part === "reveal" && !partId) {
        const file = participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { limit: 1 }).file;
        if (!file) throw new HttpError(404, `@${handle} has no transcript file yet`);
        await revealFile(file);
        return json({ ok: true, file });
      }
    }
    if (m === "POST" && handle && sub === "restart") {
      userOnly("restart a participant");
      huddles.restartParticipant(slug, h.id, handle);
      return json(huddles.view(slug, huddles.get(slug, h.id)));
    }
  }
  if (m === "POST" && !handle && (action === "stop" || action === "resume" || action === "close")) {
    userOnly(`${action} the huddle`);
    const b = action === "resume" ? await body(req) : {};
    const add = b?.addBudgetUsd === undefined || b?.addBudgetUsd === null ? 0 : Number(b.addBudgetUsd);
    const out = action === "stop" ? huddles.stopAll(slug, h.id) : action === "resume" ? huddles.resume(slug, h.id, add) : huddles.close(slug, h.id);
    return json(huddles.view(slug, out));
  }
  // The user viewed the huddle up to message `seq` (scrolled to the latest): what tagged them so far counts as seen.
  if (m === "POST" && action === "seen" && !handle) {
    userOnly("mark the huddle seen");
    const b = await body(req);
    return json(huddles.view(slug, huddles.markSeen(slug, h.id, Number(b?.seq))));
  }
  // A huddle agent proposes a teammate (propose_teammate): it waits under Learnings for the user.
  if (m === "POST" && action === "teammates" && !handle) return json(huddles.proposeTeammate(slug, h.id, me, await body(req)), 201);
  // A huddle agent proposes a squad (propose_squad): it waits under Learnings for the user.
  if (m === "POST" && action === "squads" && !handle) return json(huddles.proposeSquad(slug, h.id, me, await body(req)), 201);
  // "Save as squad…": a generic squad written from this huddle (running or closed) by one side call, as a squad card.
  // Saves nothing (the user saves the card with POST /profiles/:p/squads). Always 200: { proposal, error, setup, costUsd }.
  if (m === "POST" && action === "generic-squad" && !handle) {
    userOnly("make a squad from a huddle");
    return json(await huddles.genericSquad(slug, h.id, sideCall));
  }
  // Lessons agents proposed: only the user edits, saves (as role notes) or discards them.
  if (action === "learnings" && handle) {
    userOnly("save, edit or discard learnings");
    if (m === "POST" && sub === "discard") return json(huddles.discardLearning(slug, h.id, handle));
    const patch = async () => {
      const raw = await req.text();
      let b: any = {};
      try {
        if (raw.trim()) b = JSON.parse(raw) ?? {};
      } catch {
        throw new HttpError(400, "invalid JSON body");
      }
      return { text: b.text, scope: b.scope, target: b.target, replace: b.replace };
    };
    if (m === "PATCH" && !sub) return json(huddles.editLearning(slug, h.id, handle, await patch()));
    if (m === "POST" && sub === "save") return json(huddles.saveLearning(slug, h.id, handle, await patch()));
  }
  if (m === "POST" && action === "invite" && !handle) {
    const b = await body(req);
    const ticketId = String(b.ticketId ?? "");
    if (!ticketId) throw new HttpError(400, "ticketId is required");
    const { token: _t, ...p } = huddles.invite(slug, h.id, me, ticketId, typeof b.handle === "string" ? b.handle : undefined);
    return json(p, 201);
  }
  // Changes helpers hand in from their own copies: the helper hands in; a lead, @main or the user accepts or rejects.
  if (m === "POST" && action === "hand-ins" && !handle) {
    const b = await body(req);
    return json(await huddles.handIn(slug, h.id, me, typeof b.summary === "string" ? b.summary : ""), 201);
  }
  if (m === "POST" && action === "hand-ins" && handle && (sub === "accept" || sub === "reject") && !part) {
    const b = await body(req);
    return json(await huddles.reviewHandIn(slug, h.id, me, handle, sub === "accept", typeof b.reason === "string" ? b.reason : ""));
  }
  // A lead, @main or the user lets a helper change files (in its own copy of the folder).
  if (m === "POST" && action === "participants" && handle && sub === "allow-changes" && !part) {
    const { token: _t, ...p } = huddles.allowChanges(slug, h.id, me, handle);
    return json(p);
  }
  if (m === "POST" && action === "findings" && !handle) {
    const b = await body(req);
    const act = b.action === "add" || b.action === "resolve" ? b.action : "list";
    return json(huddles.findings(slug, h.id, me, act, { text: typeof b.text === "string" ? b.text : undefined, id: typeof b.id === "string" ? b.id : undefined }));
  }
  throw new HttpError(404, "not found");
}
