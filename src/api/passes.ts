// The board's own passes and `ckanban call` from automation scripts. Moved verbatim from http.ts.
import { PassError } from "../integrations/passes";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/passes, /api/automation-call */
export async function passRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { store, json, passes, loops, userOnly, listenerOf } = ctx;
  // /passes — the board's own passes: how automations reach a service without Claude (shared by all boards).
  // Connections shows them next to Claude's servers.
  if (parts[0] === "passes") {
    if (parts.length === 1 && m === "GET") {
      const all = passes.list();
      const used = new Map<string, number>();
      for (const p of store.listProfiles()) for (const l of store.listLoops(p.slug)) for (const id of l.passes ?? []) used.set(id, (used.get(id) ?? 0) + 1);
      // Which automations use each pass (by name), and the board name of a board's key, for Connections' Keys list.
      const usedNames = new Map<string, string[]>();
      for (const p of store.listProfiles()) for (const l of store.listLoops(p.slug)) for (const id of l.passes ?? []) usedNames.set(id, [...(usedNames.get(id) ?? []), l.name]);
      const boardName = (s: string | undefined) => (s ? store.getProfile(s)?.name || s : null);
      return json({
        passes: all.map((p) => ({ ...passes.view(p), usedBy: used.get(p.id) ?? 0, usedByNames: usedNames.get(p.id) ?? [], boardName: boardName(p.board) })),
        automations: loops.count(),
      });
    }
    if (parts.length === 1 && m === "POST") {
      await userOnly(req, "Connecting a service for automations");
      const b = (await body(req)) ?? {};
      if (b.board !== undefined && b.board !== null && (typeof b.board !== "string" || !store.getProfile(b.board))) throw new HttpError(400, "That board doesn't exist");
      return json(passes.view(await passes.add(b)), 201);
    }
    // The service sends the user's browser here after they approve the board. Only on this Mac, and only with a
    // state that authorize made (so a page that makes the browser open this URL can't connect a stranger's account).
    if (parts[1] === "oauth" && parts[2] === "callback" && m === "GET") {
      if (listenerOf(req) !== "local") throw new HttpError(403, "sign in from the computer ckanban runs on");
      const page = (title: string, text: string, status = 200) => new Response(
        `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h2>${title}</h2><p>${text}</p>`,
        { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const esc = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const denied = url.searchParams.get("error");
      if (denied) return page("Not connected", esc(url.searchParams.get("error_description") ?? denied), 400);
      try {
        const p = await passes.complete(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
        return page("Connected", `${esc(p.name)} is connected for automations. You can close this tab and go back to the board.`);
      } catch (e) {
        if (e instanceof PassError) return page("Not connected", esc(e.message), e.status);
        throw e;
      }
    }
    const pid = parts[1];
    if (parts.length === 3 && parts[2] === "tools" && m === "GET") return json(await passes.tools(pid).catch((e) => {
      throw e instanceof PassError ? e : new HttpError(502, passes.mask((e as Error).message));
    }));
    await userOnly(req, "Changing a service's connection for automations");
    if (parts.length === 2 && m === "PATCH") return json(passes.view(passes.replaceKey(pid, (await body(req))?.secret)));
    if (parts.length === 2 && m === "DELETE") {
      passes.remove(pid);
      return new Response(null, { status: 204 });
    }
    if (parts.length === 3 && parts[2] === "authorize" && m === "POST") return json({ url: await passes.authorizeUrl(pid) });
    throw new HttpError(404, "not found");
  }

  // POST /automation-call — `ckanban call` from a check script: the token its check got says what it may call.
  if (parts[0] === "automation-call" && parts.length === 1 && m === "POST") {
    const b = (await body(req)) ?? {};
    return json({ result: await loops.call(String(b.token ?? ""), String(b.service ?? ""), String(b.tool ?? ""), b.args) });
  }
  return NEXT;
}
