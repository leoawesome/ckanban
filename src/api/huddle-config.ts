// Huddle teammates, templates, squads, role notes and what the board learned. Moved verbatim from http.ts.
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { NOTES_CAP } from "../huddle/huddle-notes";
import type { SquadCardState } from "../huddle/squad";
import { LearnError } from "../board/learner";
import type { Profile } from "../core/types";
import { nowIso } from "../core/util";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/huddle-presets, huddle-templates, squads, learned, huddle-notes */
export async function huddleConfigRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile): Promise<RouteResult> {
  const { store, json, learner, huddles, emitTicket } = ctx;
  // /profiles/:p/huddle-presets[/:name] — huddle role presets ("teammates"): built-ins merged with the global ones and
  // the board's own. Anyone reads; only the user saves or deletes (the Team tab, a proposal card, the CLI). A run (a
  // huddle agent's or a ticket's, the coordinator included) proposes one with propose_teammate instead. Body `scope`:
  // "board" (default) or "global" (every board); DELETE ?scope= defaults to the level in effect.
  if (parts[2] === "huddle-presets") {
    if (parts.length === 3 && m === "GET") return json(huddles.presets(slug));
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) {
      throw new HttpError(403, m === "DELETE"
        ? "a board or huddle run can't delete or reset teammates; ask the user"
        : "a board or huddle run can't save teammates; propose one with propose_teammate and the user saves it with one click");
    }
    if (parts.length === 3 && m === "POST") {
      const b = await body(req);
      return json(huddles.savePreset(slug, b, b?.scope ?? "board"), 201);
    }
    if (parts.length === 4 && m === "PUT") {
      const b = await body(req);
      return json(huddles.savePreset(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
    }
    if (parts.length === 4 && m === "DELETE") return json(huddles.deletePreset(slug, parts[3], url.searchParams.get("scope") ?? undefined));
    throw new HttpError(404, "not found");
  }

  // /profiles/:p/huddle-templates[/:name] — whole-huddle templates (roster and rules), levels as for presets. Anyone
  // reads; only the user changes them.
  if (parts[2] === "huddle-templates") {
    if (parts.length === 3 && m === "GET") return json(huddles.templates(slug));
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes squads (the Team tab); propose one with propose_squad and the user saves it with one click");
    if (parts.length === 3 && m === "POST") {
      const b = await body(req);
      return json(huddles.saveTemplate(slug, b, b?.scope ?? "board"), 201);
    }
    if (parts.length === 4 && m === "PUT") {
      const b = await body(req);
      return json(huddles.saveTemplate(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
    }
    if (parts.length === 4 && m === "DELETE") return json(huddles.deleteTemplate(slug, parts[3], url.searchParams.get("scope") ?? undefined));
    throw new HttpError(404, "not found");
  }

  // POST /profiles/:p/squads — the user saves a squad card (propose_squad, "Save as squad…", or Edit first): body
  // { squad, scope: "board" | "global", replace?, card?: { ticketId, uuid } | { huddleId, learningId } }. People with
  // no preset are saved as teammates at the same scope (an existing teammate of that name is used as is); a squad of
  // the same name is only replaced with replace: true (else 409). The card, when given, is marked saved. Only the user.
  if (parts[2] === "squads" && parts.length === 3 && m === "POST") {
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) {
      throw new HttpError(403, "a board or huddle run can't save squads or teammates; propose one with propose_squad and the user saves it with one click");
    }
    const b = await body(req);
    const scope = b?.scope ?? "board";
    const card = b?.card && typeof b.card === "object" ? b.card : null;
    const ticketCard = card && typeof card.ticketId === "string" && typeof card.uuid === "string" && card.uuid ? card as { ticketId: string; uuid: string } : null;
    const huddleCard = card && typeof card.huddleId === "string" && typeof card.learningId === "string" ? card as { huddleId: string; learningId: string } : null;
    if (card && !ticketCard && !huddleCard) throw new HttpError(400, "card must be { ticketId, uuid } or { huddleId, learningId }");
    if (ticketCard && !store.getTicket(slug, ticketCard.ticketId)) throw new HttpError(404, `ticket ${ticketCard.ticketId} not found`);
    const out = huddles.saveSquad(slug, b?.squad, scope, huddleCard ?? undefined, b?.replace === true);
    if (ticketCard) {
      const t = store.getTicket(slug, ticketCard.ticketId)!;
      const state: SquadCardState = { state: "saved", name: out.squad.name, scope: scope === "global" ? "global" : "board", teammates: out.teammates, at: nowIso() };
      store.updateTicket(slug, t.id, { squadCards: { ...t.squadCards, [ticketCard.uuid]: state } });
      emitTicket(slug, t.id);
    }
    return json(out, 201);
  }

  // /profiles/:p/learned — what the board learned on its own (learner.ts). Anyone reads; only the user undoes,
  // saves or drops, so no run or agent can change what future runs are told.
  if (parts[2] === "learned") {
    if (parts.length === 3 && m === "GET") {
      const v = learner.view(slug);
      // count=1: only how many are new (the Team badge); the Learned view loads the rest when opened.
      return json(url.searchParams.get("count") === "1" ? { newCount: v.newCount } : v);
    }
    if (m !== "POST") throw new HttpError(404, "not found");
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes what the board learned (Team, Learned)");
    try {
      if (parts.length === 4 && parts[3] === "seen") {
        await learner.markSeen(slug);
        return json(learner.view(slug));
      }
      const [, , , what, id, act] = parts;
      if (parts.length === 6 && what === "changes" && (act === "undo" || act === "redo")) return json(await learner.undo(id, act === "redo"));
      if (parts.length === 6 && what === "lessons" && act === "save") return json(await learner.saveNow(id));
      if (parts.length === 6 && what === "lessons" && (act === "drop" || act === "keep")) return json(await learner.drop(id, act === "keep"));
    } catch (err) {
      if (err instanceof LearnError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(404, "not found");
  }

  // /profiles/:p/huddle-notes[/:role/:scope] — role notes from past huddles (huddle-notes.ts). Anyone reads; only the
  // user writes them, so no agent can change what future agents are told.
  if (parts[2] === "huddle-notes") {
    if (parts.length === 3 && m === "GET") return json({ notes: huddles.notes(slug), cap: NOTES_CAP });
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes huddle role notes (the Team tab)");
    if (parts.length === 5 && m === "PUT") return json(huddles.setNotes(slug, parts[3], parts[4], (await body(req))?.notes));
    throw new HttpError(404, "not found");
  }
  return NEXT;
}
