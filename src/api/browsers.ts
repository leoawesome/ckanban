// Board browsers, named Chromes and shared devices. Moved verbatim from http.ts.
import { RUN_HEADER } from "../schedules/scheduler";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { DeviceError } from "../browser/devices";
import { ChromeError } from "../browser/chromes";
import { BrowserError } from "../browser/board-browsers";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/board-browsers, /api/browsers, /api/devices */
export async function browserRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { board, json, browsersView, userOnly, deviceViews } = ctx;
  // Board browsers (board-browsers.ts): Chromes the board starts itself, per set of logins. Runs may only ask for one
  // to be started (ensure, from a run's browser tools after a crash); everything else is the user's.
  if (parts[0] === "board-browsers") {
    try {
      const bb = board.boardBrowsers;
      const view = () => browsersView();
      if (parts.length === 1 && m === "GET") return json(view());
      const id = decodeURIComponent(parts[1] ?? "");
      // A run's browser tools ask for this after its Chrome stopped mid-run: only a browser some run is using now
      // (one the board gave a run) is started again, never any other.
      if (parts.length === 3 && parts[2] === "ensure" && m === "POST") {
        if (!bb.get(id)) throw new HttpError(404, "There is no board browser with that name.");
        if (!bb.inUse(id)) throw new HttpError(409, "Only a task using this browser can start it again.");
        const port = await bb.ensure(id);
        return json({ ok: true, port });
      }
      // Everything else (add, rename, keep running, remove with its logins, open, close) is the user's, from the
      // board in a browser: never a run, its shell or another program.
      await userOnly(req, "Changing board browsers");
      if (parts.length === 1 && m === "POST") {
        const b = (await body(req)) ?? {};
        const added = await bb.add(b.name);
        return json({ ...view(), added: added.id });
      }
      if (parts.length === 2 && m === "PATCH") {
        const b = (await body(req)) ?? {};
        bb.update(id, { name: b.name, keepRunning: b.keepRunning, startUrl: b.startUrl });
        return json(view());
      }
      if (parts.length === 2 && m === "DELETE") {
        await bb.remove(id);
        // Boards and tickets that listed it keep the entry; runs skip a browser that no longer exists.
        return json(view());
      }
      if (parts.length === 3 && (parts[2] === "open" || parts[2] === "sign-in") && m === "POST") {
        const b = (await body(req)) ?? {};
        const r = await bb.openWindow(id, b.url);
        return json({ ...view(), ...r });
      }
      // The sign-in screen (More, Browsers): a live picture of a logged-out browser's login tab and taps or typing
      // passed to it, so sign-in works from a phone. Only the user, only this board's own browsers, only while it
      // needs sign-in (BoardBrowsers.screenTab); the picture is made in memory for this answer and never saved.
      if (parts.length === 3 && parts[2] === "screen" && m === "POST") {
        const shot = await bb.screen(id);
        return new Response(shot.jpeg, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-page-site": shot.site ?? "" } });
      }
      if (parts.length === 3 && parts[2] === "input" && m === "POST") {
        await bb.input(id, await body(req));
        return json({ ok: true });
      }
      if (parts.length === 3 && parts[2] === "close" && m === "POST") {
        if (bb.inUse(id)) throw new HttpError(409, "A task is using this browser now. It closes by itself once the task is done.");
        const closed = await bb.close(id);
        return json({ ...view(), closed, message: closed ? "Closed. Its logins are saved." : "Chrome is still closing. Try again in a minute." });
      }
    } catch (e) {
      if (e instanceof BrowserError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Named Chromes (chromes.ts): the Chromes runs have listed on this Mac, the user's names, and each board's default.
  if (parts[0] === "browsers") {
    try {
      const view = () => browsersView();
      if (parts.length === 1 && m === "GET") return json(view());
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user names or removes Chromes (More, Browsers)");
      const deviceId = decodeURIComponent(parts[1] ?? "");
      if (parts.length === 2 && m === "PATCH") {
        const b = (await body(req)) ?? {};
        if (typeof b.name !== "string") throw new HttpError(400, "name must be text");
        board.chromes.rename(deviceId, b.name);
        return json(view());
      }
      if (parts.length === 2 && m === "DELETE") {
        board.chromes.remove(deviceId);
        return json(view());
      }
    } catch (e) {
      if (e instanceof ChromeError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // Shared devices (devices.ts): every board's list, who uses each one and who waits. Runs read it; only the user edits or frees.
  if (parts[0] === "devices") {
    try {
      if (parts.length === 1 && m === "GET") return json(deviceViews());
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes or frees devices (More, Devices); a run takes and lets go of its own with take_devices and release_devices");
      if (parts.length === 1 && m === "POST") {
        const b = (await body(req)) ?? {};
        board.devices.upsert({
          name: String(b.name ?? ""), description: b.description === undefined ? undefined : String(b.description),
          capacity: b.capacity === undefined ? undefined : Number(b.capacity),
        });
        return json(deviceViews());
      }
      const name = decodeURIComponent(parts[1] ?? "");
      if (parts.length === 2 && m === "DELETE") {
        board.devices.remove(name);
        return json(deviceViews());
      }
      if (parts.length === 3 && parts[2] === "free" && m === "POST") {
        const b = (await body(req)) ?? {};
        board.devices.free(name, String(b.profile ?? ""), String(b.id ?? ""));
        return json(deviceViews());
      }
    } catch (e) {
      if (e instanceof DeviceError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  return NEXT;
}
