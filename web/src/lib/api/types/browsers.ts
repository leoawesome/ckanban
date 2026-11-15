/** WebSocket URL of the interactive shell in the board folder, or with `ticket` in that ticket's copy of the folder. */
export const shellSocketUrl = (slug: string, cols: number, rows: number, ticket?: string | null) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/profiles/${encodeURIComponent(slug)}/shell?cols=${cols}&rows=${rows}${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ""}`;

/** Shared devices a ticket's run uses now, and the ones it waits for (server: devices.ts). */
export interface TicketDevices {
  using: { name: string; since: string }[];
  waiting: { names: string[]; since: string } | null;
}

/** A ticket using or waiting for a device, on any board. */
export interface DeviceUser { slug: string; id: string; since: string; title: string | null; board: string }

/** More, Devices: a shared device with who uses it and who waits. */
/** A Chrome a run listed on this Mac (server: chromes.ts). Keyed by deviceId; name is the user's ("" until named). */
export interface ChromeBrowser {
  deviceId: string;
  name: string;
  /** Claude in Chrome's own display name when last listed ("Browser 1"); it changes on reconnect. */
  label: string;
  osPlatform?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  hint?: { site: string; at: string } | null;
}

/**
 * One browser a board or ticket chose (server: chromes.ts BrowserPick): a Claude in Chrome Chrome (kind "chrome", id =
 * deviceId), a board browser (kind "board", id = its id), or "ask". note: what it is for, told to the run.
 */
export interface BrowserPick {
  kind: "chrome" | "board" | "ask";
  id?: string;
  note?: string;
}

/** A board browser (server: board-browsers.ts): a Chrome the board starts itself, with its own saved logins. */
export interface BoardBrowserView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastSite: { site: string; at: string } | null;
  /** Started with the board and restarted if it stops; never closed when idle. */
  keepRunning: boolean;
  signedIn: boolean;
  /** Page a keep-running start opens. */
  startUrl: string | null;
  /** stopped, starting, hidden (running for tasks, no window), visible (a window on the Mac), closing. */
  state: "stopped" | "starting" | "hidden" | "visible" | "closing";
  /** What the last look at its pages said; "Not checked" when it hasn't been looked at yet. */
  signIn: "Signed in" | "Needs sign-in" | "Not checked";
  /** The login page's site when it needs sign-in. */
  signInSite: string | null;
  /** When it was last looked at. */
  checkedAt: string | null;
  /** Tasks using it now. */
  inUse: number;
  /** Open window was asked while a task used it: it opens once that task is done. */
  windowPending: boolean;
  /** Last start or close problem, in plain words. */
  error: string | null;
  folder: string;
}

export interface BrowsersState {
  browsers: ChromeBrowser[];
  /** When a run last listed the connected Chromes, and which were connected then. */
  listedAt: string | null;
  connected: string[];
  /** The board's own browsers. */
  boardBrowsers: BoardBrowserView[];
  /** Google Chrome on this Mac (board browsers need it); message in plain words when missing. */
  chrome: { installed: boolean; message: string | null };
  /** Each board's old single Chrome and its list (the list, or the old Chrome as a list of one; null: none). */
  boards: { slug: string; name: string; chrome: string | null; browsers: BrowserPick[] | null }[];
}

export interface DeviceView {
  name: string;
  description: string;
  capacity: number;
  addedByClaude?: boolean;
  lastUsedAt?: string | null;
  using: DeviceUser[];
  waiting: DeviceUser[];
}
