// Lists across every board: the Inbox and the ticket search. Moved verbatim from http.ts.
import { pauser } from "../core/lag";
import { CMD_SEARCH_LIMIT } from "../board/cmdbar";
import { byWaitingAge } from "../helper/attention";
import { featureRoot, hiddenTool } from "../../web/src/features/family/family";
import { type ApiContext, HttpError, NEXT, type RouteResult } from "./context";

/** /api/inbox, GET /api/tickets */
export async function inboxRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { store, board, json, sessions, cmdRows, boardIndex, attentionOf } = ctx;
  if (parts[0] === "inbox" && m === "GET") {
    // Every board: tickets that need the user (the same rule as the cards' "Your turn"), oldest first.
    // Right after a start with no saved summaries, wait for the sliced read instead of reading every transcript now.
    await sessions.ready();
    const out = [];
    const pause = pauser();
    for (const p of store.listProfiles()) {
      await store.loadHuddles(p.slug);
      const hosts = board.hostHuddles(p.slug);
      // Done waits on the user only for a missed follow-up (see ownAttention): the board index keeps the tickets that
      // can wait, so the thousands of Done ones aren't walked, and building just the attention instead of the whole
      // card keeps this poll from reading every old ticket's transcript summary every few seconds. The attention of
      // a ticket whose session, run, huddle and ticket didn't change since the last poll is reused (attentionOf).
      for (const t of boardIndex(p.slug).inboxable) {
        await pause();
        const v = attentionOf(p, t, hosts, board.isRunning(p.slug, t.id), t.sessionId ? sessions.summary(t.sessionId) : null);
        const base = { profile: p.slug, profileName: p.name, id: t.id, title: t.title };
        if (v.attention) out.push({ ...base, attention: v.attention });
        else if (v.snoozed) out.push({ ...base, attention: v.snoozed.attention, snoozedUntil: v.snoozed.until });
      }
    }
    return json(out.sort(byWaitingAge));
  }

  if (parts[0] === "tickets" && parts.length === 1 && m === "GET") {
    // ⌘K command bar (cmdbar.ts): scope=open, every ticket that isn't Done on every board; scope=done&q=…, the Done
    // tickets that best match (board: the board the user is on, first on ties; limit: how many).
    const scope = url.searchParams.get("scope");
    if (scope === "open") return json(await cmdRows.open());
    if (scope === "done") {
      return json(await cmdRows.searchDone(url.searchParams.get("q") ?? "", url.searchParams.get("board"), Number(url.searchParams.get("limit")) || CMD_SEARCH_LIMIT));
    }
    if (scope) throw new HttpError(400, "scope must be open or done");
    // No scope: a light row per ticket on every board, for a page opened before the bar searched Done on the
    // daemon (it searches in the browser). Long texts are capped.
    const cap = (s: string | null) => (s && s.length > 4000 ? s.slice(0, 4000) : s ?? "");
    const out = [];
    const pause = pauser();
    for (const p of store.listProfiles()) {
      for (const t of store.listTickets(p.slug)) {
        await pause();
        out.push({
          profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status,
          running: board.isRunning(p.slug, t.id), updatedAt: t.updatedAt,
          body: cap(t.body), summary: cap(store.lastAiComment(p.slug, t.id)), prUrl: t.prUrl,
          ...(hiddenTool(t) ? { mainTicket: (() => {
            const main = board.mainOf(p.slug, t) ?? featureRoot(store.listTickets(p.slug), t.id);
            return main && main.id !== t.id ? { id: main.id, title: main.title } : null;
          })() } : {}),
        });
      }
    }
    return json(out);
  }
  return NEXT;
}
