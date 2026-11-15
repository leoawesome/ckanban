// Prompt snippets. Moved verbatim from http.ts.
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/snippets */
export async function snippetRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { json, snippets } = ctx;
  // Prompt snippets: GET ?profile=<slug> returns global ones plus that board's.
  if (parts[0] === "snippets") {
    if (parts.length === 1 && m === "GET") return json(snippets.list(url.searchParams.get("profile") ?? undefined));
    if (parts.length === 1 && m === "POST") return json(snippets.create((await body(req)) ?? {}), 201);
    if (parts.length === 2 && m === "PATCH") return json(snippets.update(parts[1], (await body(req)) ?? {}));
    if (parts.length === 2 && m === "DELETE") {
      snippets.remove(parts[1]);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(404, "not found");
  }
  return NEXT;
}
