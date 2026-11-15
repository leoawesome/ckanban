// Quick chats (no ticket) and reading a ticket's earlier chat. Moved verbatim from http.ts.
import { CHAT_PAGE } from "../chat/quickchat-index";
import { matchesText, parseRef, readChat, readText, searchChat } from "../chat/chat-search";
import { AGENT_STEP_TAIL, settleAgent } from "../runs/subagents";
import { settleWorkflow } from "../runs/workflows";
import { SimplifyError } from "../chat/simplify";
import type { Profile } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/profiles/:p/chats, /chat/search, /chat/read */
export async function chatRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile): Promise<RouteResult> {
  const { store, json, sessions, quickChats, contextRoute, userOnly, simplifier, suggestParent, ticketOr404, ownRun, chatReach, readSessionsIn, readChatIn, chatSources, view } = ctx;
  // /profiles/:p/chats — quick chats with Claude in the board's folder, no ticket (the Ask tab, the Claude panel)
  if (parts[2] === "chats") {
    // Only the user's browser: a board run, huddle agent or other program can't start Claude runs here (no runs starting runs).
    const userAsks = () => userOnly(req, "Quick chats");
    if (parts.length === 3 && m === "GET") {
      // The Ask tab asks for a page (limit, then before=<next> for "Load older"); no limit: every chat, for a page
      // opened before the list came in pages.
      if (!url.searchParams.has("limit")) return json(quickChats.list(slug).map((c) => quickChats.view(slug, c)));
      const page = await quickChats.page(slug, Number(url.searchParams.get("limit")) || CHAT_PAGE, url.searchParams.get("before"));
      return json({ chats: page.chats.map((c) => quickChats.view(slug, c)), next: page.next });
    }
    // A new chat starts with its first message.
    if (parts.length === 3 && m === "POST") {
      await userAsks();
      return json(quickChats.send(slug, null, String((await body(req))?.text ?? "")), 201);
    }
    const cid = parts[3];
    const chat = quickChats.get(slug, cid);
    if (!chat) throw new HttpError(404, "chat not found");
    if (parts.length === 4 && m === "GET") return json(quickChats.view(slug, chat));
    // The Context panel: how much of Claude's memory the chat fills (GET cached, POST checks now).
    if (parts.length === 5 && parts[4] === "context" && (m === "GET" || m === "POST")) {
      return contextRoute(req, "chat", slug, cid, () => quickChats.contextSpec(slug, cid), "Checking a chat's context");
    }
    if (parts.length === 4 && m === "PATCH") {
      await userAsks();
      const b = (await body(req)) ?? {};
      return json(quickChats.rename(slug, cid, typeof b.title === "string" ? b.title : null));
    }
    if (parts.length === 4 && m === "DELETE") {
      await userAsks();
      await quickChats.remove(slug, cid);
      return new Response(null, { status: 204 });
    }
    if (parts.length === 5 && parts[4] === "messages" && m === "POST") {
      await userAsks();
      return json(quickChats.send(slug, cid, String((await body(req))?.text ?? "")));
    }
    if (parts.length === 5 && parts[4] === "stop" && m === "POST") {
      await userAsks();
      quickChats.stop(slug, cid);
      return json(quickChats.view(slug, quickChats.get(slug, cid) ?? chat));
    }
    if (parts.length === 5 && parts[4] === "ticket" && m === "POST") {
      await userAsks();
      const b = (await body(req).catch(() => null)) ?? {};
      if (b.partOf !== undefined && b.partOf !== null && (typeof b.partOf !== "string" || !b.partOf)) throw new HttpError(400, "partOf must be a ticket id");
      const partOf = typeof b.partOf === "string" ? b.partOf : undefined;
      if (partOf && !store.getTicket(slug, partOf)) throw new HttpError(400, `ticket ${partOf} not found (partOf)`);
      const r = await quickChats.makeTicket(slug, cid, partOf);
      if (!partOf) suggestParent(slug, r.ticket.id);
      return json({ ticket: view(profile, store.getTicket(slug, r.ticket.id) ?? r.ticket), chat: r.chat }, 201);
    }
    // The conversation, newest last, paged like a ticket's (see the ticket conversation route).
    if (parts.length === 5 && parts[4] === "conversation" && m === "GET") {
      await readSessionsIn([chat.sessionId]);
      const parsed = sessions.get(chat.sessionId);
      const all = parsed?.entries ?? [];
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
      const end = Math.max(0, Math.min(all.length, before));
      const start = Math.max(0, end - limit);
      const active = quickChats.isRunning(slug, cid);
      const entries = all.slice(start, end).map((e) => {
        if (e.workflow) {
          const { script: _script, scriptPath: _path, ...workflow } = settleWorkflow(e.workflow, active);
          return { ...e, workflow };
        }
        if (!e.agent) return e;
        const agent = settleAgent(e.agent, active);
        return { ...e, agent: { ...agent, steps: agent.steps.slice(-AGENT_STEP_TAIL) } };
      });
      return json({ entries, start, total: all.length });
    }
    // "Say it simpler" for the chat's replies, like a ticket's (see the ticket simplify routes).
    if (parts.length === 5 && parts[4] === "simplified" && m === "GET") {
      await readSessionsIn([chat.sessionId]);
      return json(simplifier.savedIn(quickChats.simplifiedPath(slug, cid), sessions.get(chat.sessionId)?.entries ?? []));
    }
    if (parts.length === 5 && parts[4] === "simplify" && m === "POST") {
      await userAsks();
      const b = await body(req);
      await readSessionsIn([chat.sessionId]);
      const e = typeof b?.uuid === "string" ? sessions.get(chat.sessionId)?.entries.find((x) => x.uuid === b.uuid) : null;
      if (!e) throw new HttpError(404, "no such message in this chat");
      try {
        return json(await simplifier.simplifyIn({ file: quickChats.simplifiedPath(slug, cid), spend: quickChats.sideSpendPath(slug, cid) }, quickChats.view(slug, chat).title, e));
      } catch (err) {
        if (err instanceof SimplifyError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    // Rewind (chat only: quick chats never change files back), Undo rewind and Fork from here, like a ticket's.
    if (parts.length === 5 && parts[4] === "rewind" && (m === "GET" || m === "POST")) {
      const b = m === "POST" ? ((await userAsks(), await body(req)) ?? {}) : {};
      const uuid = m === "POST" ? String(b.uuid ?? "") : url.searchParams.get("uuid") ?? "";
      await readSessionsIn([chat.sessionId]);
      const entries = sessions.get(chat.sessionId)?.entries ?? [];
      const entry = entries.find((e) => e.uuid === uuid && e.rewind);
      if (!entry) throw new HttpError(404, "This message can't be rewound to.");
      if (m === "GET") return json({ blocked: quickChats.rewindBlocked(slug, cid), files: null, filesReason: "quick-chat" });
      return json(await quickChats.rewind(slug, cid, entry, entries));
    }
    if (parts.length === 5 && parts[4] === "rewind-undo" && (m === "GET" || m === "POST")) {
      if (m === "GET") {
        const u = chat.rewindUndo ?? null;
        return json({ available: !!u, blocked: await quickChats.undoRewindBlocked(slug, cid), messages: u?.messages ?? 0, files: 0, filesSaved: false });
      }
      await userAsks();
      return json(await quickChats.undoRewind(slug, cid));
    }
    if (parts.length === 5 && parts[4] === "fork" && m === "POST") {
      await userAsks();
      const uuid = String((await body(req))?.uuid ?? "");
      await readSessionsIn([chat.sessionId]);
      const entry = sessions.get(chat.sessionId)?.entries.find((e) => e.uuid === uuid && e.rewind);
      if (!entry) throw new HttpError(404, "The chat can't be forked from this message.");
      const next = quickChats.fork(slug, cid, uuid);
      return json({ id: next.id, text: entry.text, chat: next }, 201);
    }
    if (parts.length === 6 && parts[4] === "tool" && m === "GET") {
      const d = sessions.toolDetail(chat.sessionId, parts[5]);
      if (!d) throw new HttpError(404, "tool call not found");
      return json(d);
    }
    throw new HttpError(404, "not found");
  }

  // /profiles/:p/chat/search and /chat/read: search_chat and read_chat, earlier messages of a ticket's chat (chat-search.ts).
  // A run reads its own ticket's chat; a main ticket also its tool tickets'. Huddle helpers don't.
  if (parts[2] === "chat" && parts.length === 4 && m === "GET") {
    if (parts[3] === "search") {
      const id = url.searchParams.get("ticket") || ownRun(req, slug);
      if (!id) throw new HttpError(400, "say which ticket's chat to search (ticket)");
      const t = ticketOr404(slug, id);
      chatReach(req, slug, t);
      const tools = url.searchParams.get("tools") === "1";
      const q = url.searchParams.get("q") ?? "";
      await readChatIn(t);
      try {
        return json({ text: matchesText(t.id, q, searchChat(chatSources(t, tools), q, { includeTools: tools }), tools) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (parts[3] === "read") {
      const ref = parseRef(url.searchParams.get("ref") ?? "");
      if (!ref) throw new HttpError(400, "ref must look like <sessionId>:<message number>, as search_chat gives it");
      const t = store.listTickets(slug).find((x) => x.sessionId === ref.sessionId || x.earlierSessions?.some((s) => s.sessionId === ref.sessionId));
      if (!t) throw new HttpError(404, `no ticket on this board has the chat ${ref.sessionId}`);
      chatReach(req, slug, t);
      await readSessionsIn([ref.sessionId]);
      const src = chatSources(t, true).find((s) => s.sessionId === ref.sessionId);
      if (!src) throw new HttpError(404, `the chat ${ref.sessionId} can't be read any more (its transcript is gone)`);
      const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
      try {
        return json({ text: readText(t.id, readChat(src, ref.index, { before: num("before"), after: num("after") })) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
  }
  return NEXT;
}
