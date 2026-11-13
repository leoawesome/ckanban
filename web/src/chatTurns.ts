// How the chat groups messages into turns and where time dividers go (kept DOM-free so tests can import it).

/** A new avatar and name line after this long a pause, even when the same speaker goes on. */
export const GROUP_GAP_MS = 10 * 60_000;
/** A "Today 14:05" divider after this long a pause (and at every day change). */
export const DIVIDER_GAP_MS = 60 * 60_000;

/** One row of the timeline: who said it ("claude", "user", "board", "peer:<ticket>"...), when, and whether it is a reply Claude wrote. */
export interface TurnItem { speaker: string; at: string; reply?: boolean }

/**
 * start: the first row of a turn (shows the avatar and name line). lastReply: the turn's last reply (its actions row
 * stays visible on a phone). divider: the label of a time divider shown before the row, or null.
 */
export interface TurnLayout { start: boolean; lastReply: boolean; divider: string | null }

const ms = (iso: string) => (iso ? Date.parse(iso) : NaN);
const dayKey = (t: number) => new Date(t).toDateString();

export function layoutTurns(items: TurnItem[], now = Date.now()): TurnLayout[] {
  const out: TurnLayout[] = [];
  let lastReply = -1;
  items.forEach((it, i) => {
    const prev = items[i - 1];
    const t = ms(it.at), p = prev ? ms(prev.at) : NaN;
    const gap = Number.isFinite(t) && Number.isFinite(p) ? t - p : 0;
    const dayChange = Number.isFinite(t) && (!prev || (Number.isFinite(p) && dayKey(t) !== dayKey(p)));
    const divider = Number.isFinite(t) && (dayChange && !!prev || gap >= DIVIDER_GAP_MS) ? dividerLabel(it.at, now) : null;
    const start = !prev || prev.speaker !== it.speaker || gap >= GROUP_GAP_MS || !!divider;
    if (start) lastReply = -1;
    out.push({ start, lastReply: false, divider });
    if (it.reply) {
      if (lastReply >= 0) out[lastReply].lastReply = false;
      out[i].lastReply = true;
      lastReply = i;
    }
  });
  return out;
}

/** "Today 14:05", "Yesterday 09:12", else "Sun 20 Oct, 21:00" (in the browser's language). */
export function dividerLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (dayKey(d.getTime()) === dayKey(now)) return `Today ${time}`;
  if (dayKey(d.getTime()) === dayKey(now - 86_400_000)) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The steps line under a reply: running "Step 4 · Reading api.ts", done "Did 6 steps"; failed: how many errored.
 *  activity: the run's live description of the step it is on ("Running gh"); while running it replaces the plain name. */
/** File tools whose step label is "<Tool>: <path>" (src/server/subagents.ts toolLabel). */
const FILE_STEP = /^(Read|Write|Edit|MultiEdit|NotebookEdit): ((?:~|\/)\S*\/([^/\s]+))$/;

/** A step label for one line: a file tool's full path becomes its file name ("Read: /a/b/c.png" is "Read: c.png"). */
export const shortStep = (label: string) => label.replace(FILE_STEP, "$1: $3");

/** Built-in tools as plain verbs; the raw label stays in the expanded step list. */
const PLAIN_TOOL: Record<string, string | ((arg: string) => string)> = {
  Read: (f) => `Read ${f}`, Edit: (f) => `Edited ${f}`, MultiEdit: (f) => `Edited ${f}`, NotebookEdit: (f) => `Edited ${f}`, Write: (f) => `Wrote ${f}`,
  Bash: "Ran a command", BashOutput: "Checked a command", KillShell: "Stopped a command", Monitor: "Watched a command",
  Grep: "Searched the files", Glob: "Looked for files", LS: "Listed files",
  WebFetch: "Opened a web page", WebSearch: (q) => `Searched the web for ${q}`,
  ToolSearch: "Got tools ready", Task: "Started a helper", Agent: "Started a helper", TodoWrite: "Updated its to-do list",
  Skill: "Used a skill", AskUserQuestion: "Asked you a question", ExitPlanMode: "Finished the plan", EnterPlanMode: "Started planning",
};

/** "mcp__linear-server__get_document" as "Linear", "get document" as "read document". */
const SERVICE: Record<string, string> = { ckanban: "Board", "claude-in-chrome": "Chrome" };
const VERB: Record<string, string> = {
  get: "read", read: "read", fetch: "read", view: "read", list: "list", search: "search", find: "search", query: "search",
  create: "create", add: "add", update: "update", edit: "update", set: "set", delete: "delete", remove: "delete", send: "send", post: "post",
};
function serviceName(raw: string): string {
  const s = raw.replace(/^claude_ai_/, "").replace(/[-_](server|mcp)$/i, "");
  return SERVICE[s] ?? (s.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) || "a tool");
}

/** A step label ("<Tool>: <arg>", src/server/subagents.ts toolLabel) in plain words for the one-line summary:
 *  "Read: /a/b/api.ts" is "Read api.ts", "Bash: bun test" is "Ran a command", "mcp__linear-server__get_document: X" is "Linear: read document". */
export function plainStep(label: string): string {
  const m = /^([\w-]+)(?:: ([\s\S]*))?$/.exec(label);
  if (!m) return label;
  const [, tool, arg = ""] = m;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    const [first, ...rest] = mcp[2].split(/[_-]+/);
    return `${serviceName(mcp[1])}: ${[VERB[first.toLowerCase()] ?? first, ...rest].join(" ").toLowerCase()}`;
  }
  const plain = PLAIN_TOOL[tool];
  if (!plain) return label;
  if (typeof plain === "string") return plain;
  return arg ? plain(/^(?:~|\/)/.test(arg) ? arg.replace(/\/+$/, "").split("/").pop()! : arg) : tool;
}

export function stepsSummary(items: { text: string; error?: true }[], running: boolean, activity?: string | null): { text: string; failed: number } {
  const plain = plainStep(items.at(-1)?.text ?? "");
  const failed = items.filter((t) => t.error).length;
  const n = items.length;
  // Done: only the count; the steps themselves are in the list it opens to.
  return { text: running ? `Step ${n} · ${activity || plain}` : `Did ${n} step${n === 1 ? "" : "s"}`, failed };
}

/** A message another ticket's Claude sent, as the board labels it (src/server/session.ts fromTicketText): its sender and text. */
export function fromTicket(text: string): { ticketId: string; title: string; text: string } | null {
  const m = /^Message from ticket (t_[\w-]+) \("([\s\S]*?)"\): ([\s\S]*)$/.exec(text);
  return m ? { ticketId: m[1], title: m[2], text: m[3].trim() } : null;
}

/** A later item of an automation's thread, as the board labels it (src/server/session.ts fromAutomationText). */
export function fromAutomation(text: string): { name: string; text: string } | null {
  const m = /^Message from automation \("([^"\r\n]*)"\): ([\s\S]*)$/.exec(text);
  return m ? { name: m[1], text: m[2].trim() } : null;
}

/**
 * Where items kept beside the conversation (board notes, step results, help cards, status notes, step messages) go:
 * index i = before block i (blocks.length = after them all), each before the first block that came after it, in order.
 * Nothing is placed until the timeline is ready (the conversation and the step messages have loaded): placed earlier,
 * they all land under the loading line and jump up once the messages arrive. Items older than a partial page
 * (start > 0) wait for "Load earlier".
 */
export function placeByTime<T extends { at: string }>(items: readonly T[], blockAts: readonly string[], page: { start: number } | null, ready: boolean): Map<number, T[]> {
  const out = new Map<number, T[]>();
  if (!ready || !page) return out;
  for (const it of items) {
    if (page.start > 0 && blockAts.length && it.at < blockAts[0]) continue;
    let i = blockAts.findIndex((a) => a > it.at);
    if (i < 0) i = blockAts.length;
    out.set(i, [...(out.get(i) ?? []), it]);
  }
  return out;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Which conversation messages went through Telegram (src/server/board.ts chatFromTelegram, helper/tgreply.ts):
 * inbound: the user's messages that came from there (the first matching text at or after it was sent); outbound: the
 * ticket's replies sent back there (the last reply starting with that text, from before it was sent).
 */
export function telegramMarks(
  entries: readonly { uuid: string; at: string; role: string; kind: string; text: string }[],
  ins: readonly { at: string; text: string }[] = [], outs: readonly { at: string; text: string }[] = [],
): { in: Set<string>; out: Set<string> } {
  const inbound = new Set<string>();
  const outbound = new Set<string>();
  for (const m of ins) {
    const from = new Date(Date.parse(m.at) - 60_000).toISOString();
    const want = flat(m.text);
    const e = entries.find((x) => x.role === "user" && x.kind === "text" && x.at >= from && !inbound.has(x.uuid) && flat(x.text) === want);
    if (e) inbound.add(e.uuid);
  }
  for (const o of outs) {
    const head = flat(o.text).slice(0, 80);
    if (!head) continue;
    const e = entries.findLast((x) => x.role === "assistant" && x.kind === "text" && x.at <= o.at && flat(x.text).startsWith(head));
    if (e) outbound.add(e.uuid);
  }
  return { in: inbound, out: outbound };
}

/** A board wake's grey line: "1 update from a tool ticket" (src/server/prompts.ts wakeSummary) is "Update from 1 task", others "Board update: …". */
export function wakeLabel(wake: string): string {
  const m = /^(\d+) updates? from (?:a |)(?:tool )?tickets?(?: in this group)?$/.exec(wake);
  if (m) return m[1] === "1" ? "Update from 1 task" : `Updates from ${m[1]} tasks`;
  if (/^every tool ticket finished$|^every ticket in this group finished$/.test(wake)) return "Every task finished";
  return `Board update: ${wake}`;
}
