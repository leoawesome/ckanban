// Phone access over Tailscale. Moved verbatim from http.ts.
import { RUN_HEADER } from "../schedules/scheduler";
import { qrSvg } from "../integrations/remote";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/remote */
export async function remoteRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { json, remote, listenerOf } = ctx;
  // Phone access (remote.ts): anyone allowed in may see it; only this Mac may turn it on or off.
  if (parts[0] === "remote" && parts.length === 1) {
    if (m === "GET") {
      const st = await remote.liveStatus();
      return json({ ...st, qrSvg: st.url ? qrSvg(st.url) : null, local: listenerOf(req) === "local" });
    }
    if (m === "POST") {
      if (listenerOf(req) !== "local") throw new HttpError(403, "phone access can only be changed on this Mac");
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't change phone access");
      const b = await body(req);
      if (typeof b?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
      const st = b.enabled ? await remote.on() : await remote.off();
      return json({ ...st, qrSvg: st.url ? qrSvg(st.url) : null, local: true });
    }
  }
  return NEXT;
}
