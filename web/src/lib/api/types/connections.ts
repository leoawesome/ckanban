export type McpStatus = "connected" | "needs_auth" | "failed" | "pending" | "unknown";
/** "board": an "only this board" tool, kept by the board, not in Claude's own config. */
export type McpScope = "user" | "local" | "project" | "claude.ai" | "board" | "other";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  target: string;
  transport: McpTransport | null;
  scope: McpScope;
  status: McpStatus;
  message: string | null;
  /** Counts toward the header badge: failed, or needs auth after having worked before. */
  attention: boolean;
  login: {
    state: "waiting" | "failed"; url: string | null; error: string | null; startedAt: string;
    /** A claude.ai connector: sign-in happens on claude.ai. */
    claudeAi: boolean;
    /** Takes the address the sign-in page ended on (signed in on another device). */
    canPaste: boolean;
  } | null;
  /** Boards that have it as an "only this board" tool (empty: none). */
  boards: { slug: string; name: string }[];
  /** Whether it can move between "All projects" and "Only this board", and why not. */
  move: { can: boolean; why: string | null };
  /** A move's second step failed: the tool is in both places until Try again. */
  leftover: string | null;
}

export interface McpState {
  servers: McpServer[];
  unparsed: string[];
  checkedAt: string | null;
  checking: boolean;
  error: string | null;
}

export interface McpAddInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: { key: string; value: string }[];
  headers?: { name: string; value: string }[];
  /** Add or edit it as an "only this board" tool on this board (slug). Missing: all projects. */
  board?: string;
}

/** An outside agent that can use the board through `ckanban mcp`. */
export interface AgentStatus {
  id: "claude" | "codex";
  label: string;
  available: boolean;
  installed: boolean;
  /** Registered with this ckanban's command (false: an old path). */
  current: boolean;
  command: string | null;
  configPath: string;
}

export interface McpConfig extends McpAddInput {
  scope: McpScope;
  /** Shell line that starts a stdio server like Claude does (env included). Null for http/sse. */
  commandLine: string | null;
}

/** ask_keys' input as the chat shows it (src/server/ask-keys.ts). */
export interface KeysAsk {
  keys: { envName: string; label: string; help?: string; createUrl?: string }[];
  reason: string;
  replace: boolean;
}
