// A ticket's comments, chat messages, queue and the cards in its chat. Moved verbatim from http.ts.
import { ConflictError } from "../board/board";
import { keysAnswerText } from "../integrations/ask-keys";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { fromTicketText, helperLineText } from "../runs/session";
import { suggestedLineError } from "../helper/line";
import { FEEDBACK_LINES_MAX } from "../helper/settings";
import type { SquadCardState } from "../huddle/squad";
import { hiddenTool, withYouTool } from "../../web/src/features/family/family";
import type { HelperRuleCardState, Profile, Ticket } from "../core/types";
import { nowIso } from "../core/util";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/tickets/:id/{comments,chat,queued,*-cards,closed-forms} */
export async function ticketCardRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile, id: string, action: string): Promise<RouteResult> {
  const { store, board, keyCardsInFlight, json, scheduler, passes, chatEntries, userOnly, helperOr503, helperCall, runRights, readChatIn, byRequest, byRun, byGuest, runStart, guestStart, view, emitTicket } = ctx;
  if (action === "comments") {
    if (m === "GET") {
      const all = store.listComments(slug, id);
      // ?last=N: the newest N (before the Nth comment with before=, for the next ones back), with how many come
      // earlier: get_ticket and `ticket show` print a page, not a long ticket's every comment. Comments are only
      // ever added, so a position stays put. No last: every comment, for older clients.
      const last = Number(url.searchParams.get("last") ?? 0) || 0;
      if (last <= 0) return json(all);
      const before = url.searchParams.get("before");
      const end = before === null ? all.length : Math.max(0, Math.min(all.length, Math.floor(Number(before)) || 0));
      const start = Math.max(0, end - Math.min(last, 500));
      return json({ comments: all.slice(start, end), earlier: start, total: all.length });
    }
    if (m === "POST") {
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "text is required");
      // The child reads user comments on its next run; mark who wrote this one. Another ticket's run leaves a note:
      // shown as Claude's, and labelled for the next run, so it never reads as the user's.
      const { planner, requester, runner, guest } = runRights(req, slug, store.getTicket(slug, id)!);
      if (runner) return json(board.addComment(slug, id, `Note from ticket ${runner.id} ("${runner.title}"): ${text}`, runner.id), 201);
      const by = planner ? "Planner: " : requester ? `From the Planning chat of ${requester.id} (user request): `
        : guest ? `From the chat of ${guest.ticket.id} on ${store.getProfile(guest.slug)?.name ?? guest.slug} (user request): ` : "";
      return json(board.addComment(slug, id, by + text), 201);
    }
  }
  if (m === "POST" && action === "chat") {
    const { planner, requester, runner, guest } = runRights(req, slug, store.getTicket(slug, id)!);
    const b = await body(req);
    const text = String(b.text ?? "").trim();
    if (!text) throw new HttpError(400, "text is required");
    // A message starts the ticket's run, now or once its current run ends (queued): another ticket's run is recorded
    // (and refused only for a loop) either way; the user's message to a ticket that isn't working clears it.
    const startedBy = runner ? runStart(slug, runner, id) : guest ? guestStart(guest, id)
      : !planner && !requester && !board.isRunning(slug, id) ? null : undefined;
    // A message from a run never hands the user's rights on to the run it starts.
    // Labelled with the sending ticket, so neither Claude nor the chat takes it for the user's own message.
    const sender = runner ?? planner ?? requester ?? guest?.ticket;
    // "Send in a fresh chat" is the user's own choice, never a run's or another ticket's.
    const fresh = b.fresh === true && !sender && !req.headers.get(RUN_HEADER);
    // Whether the task waited on the user before this message (closeQuestionsAbout).
    const waited = board.waitsForAnswer(slug, store.getTicket(slug, id)!);
    const t = await board.chat(slug, id, sender ? fromTicketText(sender.id, sender.title, text) : text,
      { fromPlanner: !!sender, ...(sender ? { from: { ticketId: sender.id, title: sender.title } } : {}), ...(fresh ? { fresh } : {}) });
    if (startedBy !== undefined) board.markStartedBy(slug, id, startedBy);
    // A message the user typed (not a slash command) reached Claude: a pending follow-up hears about it, and stops if it was set to.
    if (!req.headers.get(RUN_HEADER) && !text.startsWith("/")) board.userReplied(slug, id);
    // The user answered in a task's chat: a main ticket's question about that task is settled, and closes by itself.
    if (!sender && !req.headers.get(RUN_HEADER) && !req.headers.get(HUDDLE_HEADER) && !text.startsWith("/")) {
      const main = board.closeQuestionsAbout(slug, t, waited);
      if (main) emitTicket(slug, main.id);
    }
    // The user wrote in a tool ticket: its parent hears the whole message before its next decision.
    // A "with you" ticket is the user's own live step: answers go straight to it (also from the main ticket's chat), and
    // its result reaches the main ticket.
    if (!req.headers.get(RUN_HEADER) && !req.headers.get(HUDDLE_HEADER) && hiddenTool(t) && !withYouTool(t)) board.noteUserMessage(slug, id, text);
    if (requester) store.addComment(slug, id, "ai", `Message sent ${byRequest(requester)}.`);
    if (runner) store.addComment(slug, id, "ai", `Message sent ${byRun(runner)}.`);
    if (guest) store.addComment(slug, id, "ai", `Message sent ${byGuest(guest)}.`);
    return json(view(profile, t), 202);
  }
  // A message Claude hasn't received: POST .../queued/<msgId> sends it (unsent only), PATCH { text } edits it, DELETE discards it.
  if (action === "queued" && parts[5] && (m === "POST" || m === "PATCH" || m === "DELETE")) {
    try {
      let t: Ticket;
      if (m === "PATCH") {
        const text = String((await body(req)).text ?? "").trim();
        if (!text) throw new HttpError(400, "text is required");
        t = board.editQueued(slug, id, parts[5], text);
      } else t = m === "POST" ? await board.sendQueued(slug, id, parts[5]) : board.discardQueued(slug, id, parts[5]);
      return json(view(profile, t), m === "POST" ? 202 : 200);
    } catch (e) {
      if (e instanceof ConflictError || e instanceof HttpError) throw e;
      throw new HttpError(404, (e as Error).message);
    }
  }
  // A teammate card in the chat (propose_teammate) was answered: PUT .../teammate-cards/<entry uuid> { state: "saved",
  // name, scope } after the user saved it (the save itself goes through huddle-presets), or { state: "dismissed" }.
  // An automation card in the chat (propose_automation) was saved: PUT .../automation-cards/<entry uuid> { loopId }.
  if (action === "automation-cards" && parts.length === 6 && m === "PUT") {
    await userOnly(req, "Answering an automation card");
    const b = await body(req);
    const loopId = String(b?.loopId ?? "");
    if (!store.getLoop(slug, loopId)) throw new HttpError(400, "that automation doesn't exist");
    const t = store.getTicket(slug, id)!;
    store.updateTicket(slug, id, { automationCards: { ...t.automationCards, [parts[5]]: { loopId, at: nowIso() } } });
    emitTicket(slug, id);
    return json(view(profile, store.getTicket(slug, id)!));
  }
  // A key box in the chat (ask_keys) was answered: POST .../key-cards/<entry uuid> { keys: { NAME: "value" } } saves the
  // keys for this board, or { self: true } for "I'll do it myself". Then the ticket goes on in a new run (it has the
  // keys in its environment) with a message that names what was saved. Values never go into the reply, the ticket,
  // the chat, the activity log or a bus event.
  if (action === "key-cards" && parts.length === 6 && m === "POST") {
    await userOnly(req, "Saving keys");
    const uuid = parts[5];
    // One answer per box, even when Save is pressed twice: the second request waits for none and is refused.
    const flight = `${slug}/${id}/${uuid}`;
    if (keyCardsInFlight.has(flight)) throw new HttpError(409, "These keys are being saved already");
    // Claimed before any await, so a second request sent at once is refused here.
    keyCardsInFlight.add(flight);
    try {
      await readChatIn(store.getTicket(slug, id)!);
      const t = store.getTicket(slug, id)!;
      if (t.keyCards?.[uuid]) throw new HttpError(409, "This key box was already answered");
      const ask = chatEntries(t).find((e) => e.uuid === uuid && e.keys)?.keys;
      if (!ask) throw new HttpError(404, "That key box isn't in this chat any more");
      const b = (await body(req)) ?? {};
      const self = b.self === true;
      const given = b.keys && typeof b.keys === "object" && !Array.isArray(b.keys) ? b.keys as Record<string, unknown> : {};
      // Only the names the box asked for: anything else in the request is ignored.
      const input = self ? [] : ask.keys.flatMap((k) => {
        const v = given[k.envName];
        return typeof v === "string" && v.trim() ? [{ envName: k.envName, name: k.label, secret: v }] : [];
      });
      if (!self && !input.length) throw new HttpError(400, "Paste at least one key, or pick \"I'll do it myself\"");
      const saved = passes.saveBoardKeys(slug, input);
      const mark = () => {
        const now = store.getTicket(slug, id)!;
        store.updateTicket(slug, id, { keyCards: { ...now.keyCards, [uuid]: { saved, ...(self ? { self: true } : {}), at: nowIso() } } });
        emitTicket(slug, id);
      };
      // A new run, never the one going: a running claude keeps the environment it started with.
      try {
        await board.chat(slug, id, keysAnswerText(ask, saved, self), { nextRun: true });
      } catch (e) {
        // Nothing saved ("I'll do it myself"): the box stays open, so the user can answer again.
        if (!saved.length) throw e;
        // The keys are saved either way; only the message to Claude didn't go (it is stopping, say).
        mark();
        throw new HttpError(409, `The ${saved.length === 1 ? "key is" : "keys are"} saved, but Claude couldn't be told right now (${(e as Error).message}). Send it a message to carry on.`);
      }
      mark();
      return json(view(profile, store.getTicket(slug, id)!), 202);
    } finally {
      keyCardsInFlight.delete(flight);
    }
  }
  // A squad card in the chat (propose_squad) was dismissed: PUT .../squad-cards/<entry uuid> { state: "dismissed" }.
  // Saving goes through POST /profiles/:p/squads with the card, which marks it; { state: "saved", name, scope } here
  // only records a save made elsewhere (Edit first in the Team tab).
  if (action === "squad-cards" && parts.length === 6 && m === "PUT") {
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user answers squad cards");
    const b = await body(req);
    if (b.state !== "saved" && b.state !== "dismissed") throw new HttpError(400, "state must be saved or dismissed");
    if (b.scope !== undefined && b.scope !== "global" && b.scope !== "board") throw new HttpError(400, "scope must be global or board");
    const t = store.getTicket(slug, id)!;
    const card: SquadCardState = {
      state: b.state, at: nowIso(),
      ...(b.state === "saved" && typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}),
      ...(b.state === "saved" && b.scope ? { scope: b.scope } : {}),
    };
    store.updateTicket(slug, id, { squadCards: { ...t.squadCards, [parts[5]]: card } });
    emitTicket(slug, id);
    return json(view(profile, store.getTicket(slug, id)!));
  }
  // Close question: PUT .../closed-forms/<entry uuid> closes a questions form without answering (nothing is sent to
  // Claude, no run starts); the ticket stops waiting on the user for it.
  if (action === "closed-forms" && parts.length === 6 && m === "PUT") {
    await userOnly(req, "Closing a question");
    const uuid = parts[5];
    if (!uuid || uuid.length > 200) throw new HttpError(400, "the question's id is missing");
    try {
      const t = board.closeForm(slug, id, uuid);
      emitTicket(slug, id);
      return json(view(profile, t));
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, e.message);
      throw new HttpError(404, (e as Error).message);
    }
  }
  // Schedule delete card (Claude's delete_schedule in this ticket's chat or run): PUT .../schedule-delete-cards/<entry
  // uuid> { state: "deleted", scheduleId } deletes the schedule, { state: "kept" } keeps it. Only the user's click.
  if (action === "schedule-delete-cards" && parts.length === 6 && m === "PUT") {
    await userOnly(req, "Deleting a schedule");
    const uuid = parts[5];
    if (!uuid || uuid.length > 200) throw new HttpError(400, "the card's id is missing");
    const b = (await body(req)) ?? {};
    if (b.state !== "deleted" && b.state !== "kept") throw new HttpError(400, "state must be deleted or kept");
    const t = store.getTicket(slug, id)!;
    const done = t.scheduleDeleteCards?.[uuid];
    if (done) throw new HttpError(409, done.state === "deleted" ? "this schedule was already deleted from this card" : "this card was already answered");
    let name: string | undefined;
    if (b.state === "deleted") {
      const sid = typeof b.scheduleId === "string" ? b.scheduleId : "";
      const s = sid ? store.getSchedule(slug, sid) : null;
      if (!s) throw new HttpError(404, "This schedule is no longer on the board.");
      name = s.name;
      scheduler.remove(slug, sid, "user");
    }
    const card = { state: b.state, at: nowIso(), ...(name ? { name, scheduleId: b.scheduleId as string } : {}) };
    store.updateTicket(slug, id, { scheduleDeleteCards: { ...store.getTicket(slug, id)!.scheduleDeleteCards, [uuid]: card } });
    emitTicket(slug, id);
    return json(view(profile, store.getTicket(slug, id)!));
  }
  // Helper rule card (Claude's propose_helper_rule in this ticket's chat or run): PUT .../helper-rule-cards/<entry uuid>
  // { state: "added", text } saves the card's line to "What the helper knows about you"; { state: "dismissed" } (Not
  // now) saves nothing. Only the user's click: a run, huddle helper or other program is refused (userOnly), as on the
  // helper's own routes. The line saved is the one in this chat's transcript, the one the card shows; `text` (what the
  // user's card showed) must match it, so a line changed meanwhile is never saved unseen.
  if (action === "helper-rule-cards" && parts.length === 6 && m === "PUT") {
    await userOnly(req, "Adding to what the helper knows about you");
    const uuid = parts[5];
    if (!uuid || uuid.length > 200) throw new HttpError(400, "the card's id is missing");
    const b = (await body(req)) ?? {};
    if (b.state !== "added" && b.state !== "dismissed") throw new HttpError(400, "state must be added or dismissed");
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const rule = chatEntries(t).find((e) => e.uuid === uuid && e.helperRule)?.helperRule;
    if (!rule) throw new HttpError(404, "This suggestion isn't in this ticket's chat.");
    const done = t.helperRuleCards?.[uuid];
    if (done) throw new HttpError(409, done.state === "added" ? "This line was already added from this card." : "This card was already answered.");
    let card: HelperRuleCardState = { state: "dismissed", at: nowIso() };
    if (b.state === "added") {
      if (b.text !== rule.text) throw new HttpError(409, "This suggestion changed since the card was shown; reload the chat and check it again.");
      // The tool refuses these and the chat shows no card for them; checked again so nothing hidden is ever saved.
      const bad = suggestedLineError(rule.text);
      if (bad) throw new HttpError(400, `This suggestion can't be added: ${bad}.`);
      if (hiddenTool(t)) throw new HttpError(403, "This suggestion came from a step working in the background; ask in the main chat instead.");
      const h = helperOr503();
      const key = (x: string) => helperLineText(x).toLowerCase();
      const already = h.settings.get().feedback.some((f) => key(f.text) === key(rule.text));
      // A full list would drop the user's oldest line without a word: they choose what goes, in Notifications.
      if (!already && h.settings.get().feedback.length >= FEEDBACK_LINES_MAX) {
        throw new HttpError(409, `What the helper knows about you is full (${FEEDBACK_LINES_MAX} lines). Remove a line in Notifications, then tap Add again.`);
      }
      if (!already) {
        helperCall(() => h.settings.addFeedback(rule.text, "suggested"));
        h.feedbackAdded();
      }
      card = { state: "added", at: nowIso(), text: rule.text, ...(already ? { already: true } : {}) };
    }
    store.updateTicket(slug, id, { helperRuleCards: { ...store.getTicket(slug, id)!.helperRuleCards, [uuid]: card } });
    emitTicket(slug, id);
    return json(view(profile, store.getTicket(slug, id)!));
  }
  if (action === "teammate-cards" && parts.length === 6 && m === "PUT") {
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user answers teammate cards");
    const b = await body(req);
    if (b.state !== "saved" && b.state !== "dismissed") throw new HttpError(400, "state must be saved or dismissed");
    if (b.scope !== undefined && b.scope !== "global" && b.scope !== "board") throw new HttpError(400, "scope must be global or board");
    const t = store.getTicket(slug, id)!;
    const card = {
      state: b.state, at: nowIso(),
      ...(b.state === "saved" && typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}),
      ...(b.state === "saved" && b.scope ? { scope: b.scope } : {}),
    };
    store.updateTicket(slug, id, { teammateCards: { ...t.teammateCards, [parts[5]]: card } });
    emitTicket(slug, id);
    return json(view(profile, store.getTicket(slug, id)!));
  }
  return NEXT;
}
