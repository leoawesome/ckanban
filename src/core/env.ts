// Names of the env vars the daemon gives its runs, and of the request headers BoardClient (the ckanban MCP server and
// CLI) sends back to the daemon. Kept here, with no imports, so the CLI and MCP server can read them without loading
// the scheduler or the huddle code. The old homes (scheduler.ts, huddle-roster.ts, helper/frontdesk-id.ts) re-export them.

/** Request header the ckanban MCP tools send from inside a board run (value: the run's CKANBAN_TICKET). */
export const RUN_HEADER = "x-ckanban-run";
/**
 * A quick chat's runs get QUICK_CHAT_ENV ("<profile>/<chat id>"), and BoardClient sends it back as QUICK_CHAT_HEADER:
 * quick chats can't show a delete card, so the daemon refuses their schedule deletes.
 */
export const QUICK_CHAT_ENV = "CKANBAN_QUICK_CHAT";
export const QUICK_CHAT_HEADER = "x-ckanban-quick-chat";
/** Set on a huddle agent's claude process: "<huddle id>/<handle>/<token>". The token proves who is calling. */
export const HUDDLE_AGENT_ENV = "CKANBAN_HUDDLE_AGENT";
/** The MCP server/CLI forwards HUDDLE_AGENT_ENV to the daemon in this header. */
export const HUDDLE_HEADER = "x-ckanban-huddle-agent";
/** Where a request comes from: "ui" (the board's web UI) or "mcp" (BoardClient: the MCP server and CLI). Recorded on posts. */
export const SOURCE_HEADER = "x-ckanban-source";
/** The Telegram front desk's runs get FRONT_DESK_ENV ("<board>/<chat id>/<secret>"); BoardClient sends it back as FRONT_DESK_HEADER. */
export const FRONT_DESK_ENV = "CKANBAN_FRONTDESK";
export const FRONT_DESK_HEADER = "x-ckanban-frontdesk";
