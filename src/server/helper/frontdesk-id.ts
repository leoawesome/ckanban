// The Telegram front desk's identity, shared by the daemon and the ckanban MCP server / CLI (kept tiny: client.ts imports it).
// The daemon gives the front desk's runs CKANBAN_FRONTDESK="<board>/<chat id>/<secret>"; BoardClient sends it back as a
// header with every request, and the daemon holds the actions that start, stop or move work for a Confirm tap in Telegram.

export const FRONT_DESK_ENV = "CKANBAN_FRONTDESK";
export const FRONT_DESK_HEADER = "x-ckanban-frontdesk";

/** The daemon's answer (HTTP 202) when it held an action for the user's Confirm tap: { confirmation: "<what to tell the user>" }. */
export const CONFIRM_STATUS = 202;
