// The user's avatar choices for Claude, the user and teammates. Moved verbatim from http.ts.
import { AvatarError, CLAUDE_KEY, withAvatar, withClaudeName, withoutAvatar } from "../board/avatars";
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { type ApiContext, HttpError, NEXT, type RouteResult, body, claudeNameOf } from "./context";

/** /api/avatars */
export async function avatarRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { store, json } = ctx;
  // The user's avatar choices for Claude, the user and teammates: one set for every board (src/board/avatars.ts).
  if (parts[0] === "avatars") {
    if (parts.length === 1 && m === "GET") return json(store.listAvatars());
    // PUT /api/avatars/claude/name {name}: the name shown in place of "Claude" ("" or "Claude": back to "Claude").
    const nameRoute = parts.length === 3 && parts[1] === CLAUDE_KEY && parts[2] === "name" && m === "PUT";
    if (nameRoute || (parts.length === 2 && (m === "PUT" || m === "DELETE"))) {
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "a board or huddle run can't change avatars; ask the user");
      const name = parts[1];
      // The body first, then the saved file: a slow upload must not write back a copy read before it arrived.
      const sent = m === "PUT" ? await body(req) : undefined;
      try {
        const next = nameRoute ? withClaudeName(store.listAvatars(), claudeNameOf(sent))
          : m === "PUT" ? withAvatar(store.listAvatars(), name, sent) : withoutAvatar(store.listAvatars(), name);
        store.saveAvatars(next);
        return json(next);
      } catch (e) {
        if (e instanceof AvatarError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
  }
  return NEXT;
}
