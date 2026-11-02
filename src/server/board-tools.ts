import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "./util";
import type { McpAddInput } from "./mcp";

/**
 * A board's "only this board" tools: MCP servers that reach that board's Claude runs only (merged into the inline
 * `--mcp-config` every board run gets), so other projects don't load them. One file per board, in the board's own
 * folder under ~/.claude-kanban/profiles/<slug>/, shaped like Claude Code's `{"mcpServers": {...}}`. It can hold
 * secrets (headers, env values), so it is written owner-only (0600) and never into the project folder.
 */

export const BOARD_TOOLS_FILE = "board-tools.json";

/** One server entry, as Claude Code stores it (`{command,args,env}` or `{type,url,headers}`). */
export type ToolEntry = Record<string, unknown>;

/** Reads a board's tools. Empty when the file is missing or unreadable. */
export function readBoardTools(file: string): Record<string, ToolEntry> {
  if (!existsSync(file)) return {};
  try {
    const servers = JSON.parse(readFileSync(file, "utf8"))?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    return Object.fromEntries(Object.entries(servers).filter(([, e]) => e && typeof e === "object" && !Array.isArray(e))) as Record<string, ToolEntry>;
  } catch {
    return {};
  }
}

/** Writes a board's tools atomically, owner-only (it can hold secrets). */
export function writeBoardTools(file: string, servers: Record<string, ToolEntry>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The stored entry for an add/edit form input (already checked with `addArgs`). */
export function entryFromInput(input: McpAddInput): ToolEntry {
  if (input.transport === "stdio") {
    const env = Object.fromEntries((input.env ?? []).filter((e) => e.key || e.value).map((e) => [e.key.trim(), String(e.value)]));
    return {
      type: "stdio", command: String(input.command ?? "").trim(), args: (input.args ?? []).map(String),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  const headers = Object.fromEntries((input.headers ?? []).filter((h) => h.name || h.value).map((h) => [h.name.trim(), String(h.value)]));
  return { type: input.transport, url: String(input.url ?? "").trim(), ...(Object.keys(headers).length ? { headers } : {}) };
}

/** Form input for a stored entry; null when it has a shape the board can't read back. */
export function inputFromEntry(name: string, e: ToolEntry): McpAddInput | null {
  const kind = String(e.type ?? (e.url ? "http" : "stdio"));
  const pairs = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>) : null);
  if (kind === "http" || kind === "sse") {
    const headers = e.headers === undefined ? [] : pairs(e.headers);
    if (typeof e.url !== "string" || !e.url || !headers) return null;
    return { name, transport: kind, url: e.url, headers: headers.map(([k, v]) => ({ name: k, value: String(v) })) };
  }
  if (kind !== "stdio") return null;
  const env = e.env === undefined ? [] : pairs(e.env);
  if (typeof e.command !== "string" || !e.command || !env) return null;
  if (e.args !== undefined && !Array.isArray(e.args)) return null;
  return { name, transport: "stdio", command: e.command, args: ((e.args as unknown[]) ?? []).map(String), env: env.map(([k, v]) => ({ key: k, value: String(v) })) };
}
