// The Connections panel: Claude Code MCP servers and the `ckanban mcp` registration. Moved verbatim from http.ts.
import { AGENT_IDS, type AgentId } from "../integrations/agents";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/mcp, /api/agents */
export async function connectionRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { json, mcp, agents, userOnly } = ctx;
  // Connections panel: Claude Code MCP servers (always from the home dir, user scope for edits).
  if (parts[0] === "mcp") {
    const name = parts[1];
    if (parts.length === 1 && m === "GET") return json(mcp.state());
    // Adding or changing a tool decides what later runs start (a stdio command), and a tool's settings hold its keys
    // (env values, headers): both are for the user only, never a board run. The list above stays open (MCP tools read it).
    if (m !== "GET") await userOnly(req, "Changing Claude's tools (Connections)");
    else if (parts.length === 3 && parts[2] === "config") await userOnly(req, "Reading a tool's settings", { read: true });
    if (parts.length === 1 && m === "POST") {
      await mcp.add(await body(req));
      return json(mcp.state(), 201);
    }
    if (parts.length === 2 && name === "refresh" && m === "POST") {
      mcp.refresh();
      return json(mcp.state(), 202);
    }
    if (parts.length === 2 && m === "DELETE") {
      await mcp.remove(name, url.searchParams.get("board") ?? undefined);
      return json(mcp.state());
    }
    // Move between "All projects" and "Only this board": { to: "board" | "all", board: <slug> }.
    if (parts.length === 3 && m === "POST" && parts[2] === "move") {
      const b = (await body(req)) ?? {};
      const board = String(b.board ?? "");
      if (b.to === "board") await mcp.moveToBoard(name, board);
      else if (b.to === "all") await mcp.moveToUser(name, board);
      else throw new HttpError(400, "to must be board or all");
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "retry-move") {
      await mcp.retryMove(name);
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "login") {
      mcp.login(name);
      return json(mcp.state(), 202);
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "login-paste") {
      mcp.paste(name, String((await body(req))?.text ?? ""));
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "cancel-login") {
      mcp.cancelLogin(name);
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "logout") {
      await mcp.logout(name);
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "POST" && parts[2] === "recheck") {
      const s = await mcp.recheck(name);
      if (!s) throw new HttpError(502, `couldn't check ${name}; try Refresh`);
      return json(mcp.state());
    }
    if (parts.length === 3 && m === "GET" && parts[2] === "config") return json(mcp.config(name, url.searchParams.get("board") ?? undefined));
    if (parts.length === 2 && m === "PUT") {
      await mcp.update(name, await body(req));
      return json(mcp.state());
    }
    throw new HttpError(404, "not found");
  }

  // Connections panel: is `ckanban mcp` registered with Claude Code / Codex, and (un)register it.
  if (parts[0] === "agents") {
    if (parts.length === 1 && m === "GET") return json(await agents.status());
    const id = parts[1] as AgentId;
    if (m !== "GET") await userOnly(req, "Connecting the board to Claude Code or Codex");
    if (parts.length === 3 && m === "POST" && AGENT_IDS.includes(id) && (parts[2] === "install" || parts[2] === "uninstall")) {
      await (parts[2] === "install" ? agents.install(id) : agents.uninstall(id));
      if (id === "claude") mcp.refresh();
      return json(await agents.status());
    }
    throw new HttpError(404, "not found");
  }
  return NEXT;
}
