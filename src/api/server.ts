// The board's web server: starts the routes' context, checks each request (local or phone access), sends /api/...
// to the route files in order and serves the UI. Moved from http.ts; routes, paths and answers unchanged.
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { routeLabel, track } from "../core/lag";
import { ConflictError } from "../board/board";
import { PassError } from "../integrations/passes";
import { LoopError } from "../schedules/loops";
import { RUN_HEADER, ScheduleError } from "../schedules/scheduler";
import { JobError } from "../schedules/jobs";
import { SnippetError } from "../board/snippets";
import { HuddleError } from "../huddle/huddle";
import { HUDDLE_HEADER } from "../huddle/huddle-roster";
import { McpError } from "../integrations/mcp";
import { LISTENER_HEADER, RemoteError } from "../integrations/remote";
import { AgentError } from "../integrations/agents";
import type { Shell } from "../browser/shell";
import { QuickChatError } from "../chat/quickchat";
import { FRONT_DESK_HEADER } from "../helper/frontdesk-id";
import { nowIso } from "../core/util";
import { callerPort, fromFront } from "../core/front";
import { HttpError, type Listener, NEXT, type RouteResult, type ServerDeps, type ShellSocket, body, requestRefusal } from "./context";
import { attachmentRoutes } from "./attachments";
import { remoteRoutes } from "./remote";
import { browserRoutes } from "./browsers";
import { notifyRoutes } from "./notify";
import { systemRoutes } from "./system";
import { avatarRoutes } from "./avatars";
import { inboxRoutes } from "./inbox";
import { connectionRoutes } from "./connections";
import { snippetRoutes } from "./snippets";
import { passRoutes } from "./passes";
import { profileListRoutes, profileRoutes } from "./profiles";
import { chatRoutes } from "./chats";
import { scheduleRoutes } from "./schedules";
import { huddleConfigRoutes } from "./huddle-config";
import { ticketListRoutes } from "./tickets-list";
import { ticketRoutes } from "./tickets";
import { ticketInfoRoutes } from "./ticket-info";
import { ticketFileRoutes } from "./ticket-files";
import { ticketCardRoutes } from "./ticket-cards";
import { ticketActionRoutes } from "./ticket-actions";
import { huddleApi } from "./huddles";
import { createContext } from "./context";

export { isAllowedRequest, isAllowedSocket, refuseSharedFolder, requestRefusal, type Listener, type ServerDeps } from "./context";

export function createServer(deps: ServerDeps) {
  const ctx = createContext(deps);
  const { store, json, shells, remote, via, notifier, profileOr404, ticketOr404, publicPort } = ctx;
  ctx.bind({ api });

  async function api(req: Request, url: URL): Promise<Response | undefined> {
    // The Telegram front desk (helper/frontdesk.ts): what starts, stops or moves work is held for a Confirm tap.
    const desk = req.headers.get(FRONT_DESK_HEADER);
    if (desk !== null) {
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "a board run can't also be the front desk");
      if (url.pathname === "/api/telegram/front-desk/file" && req.method === "POST") {
        const b = await body(req);
        const r = await notifier.frontDesk.sendFile(desk, String(b?.path ?? ""), typeof b?.caption === "string" ? b.caption : "");
        return json(r.body, r.status);
      }
      let b: unknown = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          const raw = await req.clone().text();
          b = raw ? JSON.parse(raw) : null;
        } catch {
          b = null;
        }
      }
      const held = await notifier.frontDesk.gate(desk, req.method, url.pathname, b);
      if (held) return json(held.body, held.status);
    } else if (url.pathname === "/api/telegram/front-desk/file") throw new HttpError(403, "send_file only works in the Telegram front desk's chat");
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method;
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    let r: RouteResult;
    if ((r = await attachmentRoutes(ctx, req, url, parts, m, type)) !== NEXT) return r;

    // Only JSON mutations: blocks HTML <form> posts (text/plain, urlencoded) that skip CORS preflight.
    if ((m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }

    if ((r = await remoteRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await browserRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await notifyRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await systemRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await avatarRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await inboxRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await connectionRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await snippetRoutes(ctx, req, url, parts, m)) !== NEXT) return r;
    if ((r = await passRoutes(ctx, req, url, parts, m)) !== NEXT) return r;

    if (parts[0] !== "profiles") throw new HttpError(404, "not found");

    if ((r = await profileListRoutes(ctx, req, url, parts, m)) !== NEXT) return r;

    const slug = parts[1];
    const profile = profileOr404(slug);

    if ((r = await profileRoutes(ctx, req, url, parts, m, slug, profile)) !== NEXT) return r;
    if ((r = await chatRoutes(ctx, req, url, parts, m, slug, profile)) !== NEXT) return r;
    if ((r = await scheduleRoutes(ctx, req, url, parts, m, slug, profile)) !== NEXT) return r;
    if ((r = await huddleConfigRoutes(ctx, req, url, parts, m, slug, profile)) !== NEXT) return r;

    // /profiles/:p/huddles — shared rooms where several Claude sessions work on a ticket (see huddle.ts)
    if (parts[2] === "huddles") return huddleApi(ctx, req, url, slug, parts.slice(3));

    // /profiles/:p/tickets
    if (parts[2] !== "tickets") throw new HttpError(404, "not found");
    // A board not read yet (the first requests after a start) reads its ticket files in slices first: a write places
    // the ticket among the others (Store.nextOrder and the cached lists), which otherwise read thousands of ticket
    // files in one go (seconds of frozen daemon for a move to In progress). Once read, this costs nothing.
    await store.listTicketsSliced(slug);
    if ((r = await ticketListRoutes(ctx, req, url, parts, m, slug, profile)) !== NEXT) return r;

    const id = parts[3];
    ticketOr404(slug, id);

    if ((r = await ticketRoutes(ctx, req, url, parts, m, slug, profile, id)) !== NEXT) return r;

    const action = parts[4];
    if ((r = await ticketInfoRoutes(ctx, req, url, parts, m, slug, profile, id, action)) !== NEXT) return r;
    if ((r = await ticketFileRoutes(ctx, req, url, parts, m, slug, profile, id, action)) !== NEXT) return r;
    if ((r = await ticketCardRoutes(ctx, req, url, parts, m, slug, profile, id, action)) !== NEXT) return r;
    if ((r = await ticketActionRoutes(ctx, req, url, parts, m, slug, profile, id, action)) !== NEXT) return r;
    throw new HttpError(404, "not found");
  }


  function staticFile(url: URL): Response {
    const assets = deps.assets ?? {};
    if (Object.keys(assets).length) {
      const hit = assets[url.pathname] ?? assets["/index.html"];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(Bun.file(hit));
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(deps.webDir, rel);
    if (file.startsWith(deps.webDir) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    const index = join(deps.webDir, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return new Response("UI not built. Run: bun run build:web", { status: 404 });
  }

  function attachShell(ws: import("bun").ServerWebSocket<ShellSocket>, restart = false) {
    const d = ws.data;
    d.unsubscribe?.();
    let shell: Shell;
    try {
      shell = shells.get(d.slug, d.cwd, d.cols, d.rows, restart, d.folder);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      return;
    }
    d.shell = shell;
    const back = shell.scrollback();
    if (back.length) ws.sendBinary(back);
    if (shell.exited) ws.send(JSON.stringify({ type: "exit", code: shell.exitCode }));
    else shell.resize(d.cols, d.rows);
    d.unsubscribe = shell.subscribe((e) => {
      if (e.type === "data") ws.sendBinary(e.data);
      else ws.send(JSON.stringify({ type: "exit", code: e.code }));
    });
  }

  async function handle(req: Request, srv: import("bun").Server<ShellSocket>, listener: Listener): Promise<Response | undefined> {
    const res = await track(routeLabel(req), () => route(req, srv, listener));
    if (res && listener === "remote") res.headers.set(LISTENER_HEADER, "remote");
    return res;
  }

  async function route(req: Request, srv: import("bun").Server<ShellSocket>, listener: Listener): Promise<Response | undefined> {
    // Behind the Rust front server (core/front.ts) the board's port is the front's; this one only takes its requests.
    const refusal = listener === "local" && !fromFront(req) ? "forbidden" : requestRefusal(req, publicPort(), remote.active(), listener);
    if (refusal) return new Response(refusal, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    via.set(req, { listener, srv, peer: listener === "local" ? callerPort(req, srv.requestIP(req)?.port) : 0 });
    if (listener === "remote") remote.noteVisit(nowIso());
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return staticFile(url);
    try {
      return (await api(req, url)) as Response;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.confirm ? { confirm: e.confirm } : {}) }, e.status);
      if (e instanceof ConflictError) return json({ error: e.message }, 409);
      if (e instanceof McpError) return json({ error: e.message }, e.status);
      if (e instanceof AgentError) return json({ error: e.message }, e.status);
      if (e instanceof ScheduleError) return json({ error: e.message }, e.status);
      if (e instanceof LoopError) return json({ error: e.message }, e.status);
      if (e instanceof PassError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
      if (e instanceof JobError) return json({ error: e.message }, e.status);
      if (e instanceof SnippetError) return json({ error: e.message }, e.status);
      if (e instanceof HuddleError) return json({ error: e.message }, e.status);
      if (e instanceof RemoteError) return json({ error: e.message }, e.status);
      if (e instanceof QuickChatError) return json({ error: e.message }, e.status);
      if (e instanceof URIError) return json({ error: "malformed URL" }, 400);
      console.error(e);
      return json({ error: (e as Error).message ?? "internal error" }, 500);
    }
  }

  const websocket: import("bun").WebSocketHandler<ShellSocket> = {
    open: (ws) => attachShell(ws),
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }
      const shell = ws.data.shell;
      if (msg.type === "input" && typeof msg.data === "string") shell?.write(msg.data);
      else if (msg.type === "resize") {
        ws.data.cols = Math.min(1000, Math.max(1, Number(msg.cols) || 80));
        ws.data.rows = Math.min(1000, Math.max(1, Number(msg.rows) || 24));
        shell?.resize(ws.data.cols, ws.data.rows);
      } else if (msg.type === "restart") {
        // Another tab may already have restarted it: then just join the new shell.
        ws.send(JSON.stringify({ type: "reset" }));
        attachShell(ws, shells.current(ws.data.slug, ws.data.folder) === shell);
      }
    },
    close: (ws) => ws.data.unsubscribe?.(),
  };

  const server = Bun.serve<ShellSocket>({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    fetch: (req, srv) => handle(req, srv, "local"),
    websocket,
  });
  // Only `tailscale serve` connects here (it runs on this Mac); every request is checked as a tailnet request.
  // A busy port only costs phone access, never the board.
  let remoteServer: import("bun").Server<ShellSocket> | null = null;
  if (deps.remotePort !== undefined) {
    try {
      remoteServer = Bun.serve<ShellSocket>({
        hostname: "127.0.0.1",
        port: deps.remotePort,
        idleTimeout: 0,
        fetch: (req, srv) => handle(req, srv, "remote"),
        websocket,
      });
    } catch (e) {
      console.error(`phone access listener on 127.0.0.1:${deps.remotePort} failed: ${(e as Error).message}`);
    }
  }
  ctx.bind({ server, remoteServer });
  return Object.assign(server, { remoteServer });
}
