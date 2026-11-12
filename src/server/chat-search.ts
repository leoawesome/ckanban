// search_chat / read_chat: Claude looks up earlier messages of a ticket's chat (its current session and every session
// left behind with "Send in a fresh chat") instead of re-reading the whole conversation. A message's ref is
// `<sessionId>:<index>`, the index of its entry in the parsed transcript (session.ts), so it stays the same after restarts.
import type { SessionEntry } from "./session";

/** One session of a ticket's chat, oldest first in the list handed in. */
export interface ChatSource {
  sessionId: string;
  entries: SessionEntry[];
  /** Tool output by tool_use id (only read when tools are searched). */
  toolOutput?: Map<string, string>;
}

export interface ChatMatch {
  ref: string;
  at: string;
  who: string;
  snippet: string;
}

export const SEARCH_LIMIT = 10;
export const READ_MAX_MESSAGES = 40;
export const READ_MAX_TOKENS = 8000;
const DEFAULT_SIDE = 10;

/** Rough token count (about 4 characters a token). */
export const roughTokens = (s: string) => Math.ceil(s.length / 4);

export function whoWrote(e: SessionEntry): string {
  if (e.peer?.automation) return `Automation "${e.peer.automation}"`;
  if (e.peer?.ticketId) return e.peer.dir === "in" ? `Ticket ${e.peer.ticketId}` : "Claude";
  if (e.peer) return "Huddle";
  if (e.kind === "tool" || e.kind === "agent" || e.kind === "workflow") return "Tool";
  if (e.kind === "board") return "Board";
  return e.role === "user" ? "User" : "Claude";
}

/** A user message or one of Claude's replies (not a tool row, a board note or a built-in command's output). */
const isMessage = (e: SessionEntry) => e.kind === "text" && !e.commandOutput && !!e.text.trim();

function entryText(e: SessionEntry, src: ChatSource, tools: boolean): string | null {
  if (isMessage(e)) return e.text;
  if (!tools) return null;
  if (e.kind === "tool" || e.kind === "agent" || e.kind === "workflow") {
    const out = e.toolUseId ? src.toolOutput?.get(e.toolUseId) : e.agent?.result ?? undefined;
    return [e.text, out].filter(Boolean).join("\n") || null;
  }
  return e.text.trim() ? e.text : null;
}

/** The query's words, lower case; whole words, no stemming. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean))];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${esc(w)}(?![\\p{L}\\p{N}_])`, "iu");

/** A few lines around the first line that has one of the words. */
function snippet(text: string, res: RegExp[]): string {
  const lines = text.split("\n");
  let at = lines.findIndex((l) => res.some((r) => r.test(l)));
  if (at < 0) at = 0;
  const pick = lines.slice(Math.max(0, at - 2), at + 3).map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l));
  const out = pick.join("\n").trim();
  return out.length > 900 ? `${out.slice(0, 899)}…` : out;
}

/** Messages that have every word of the query, newest first; total counts all matches. */
export function searchChat(sources: ChatSource[], query: string, o: { includeTools?: boolean; limit?: number } = {}): { matches: ChatMatch[]; total: number } {
  const words = queryWords(query);
  if (!words.length) throw new Error("the query is empty: give one or more words to look for");
  const res = words.map(wordRe);
  const limit = o.limit ?? SEARCH_LIMIT;
  const matches: ChatMatch[] = [];
  let total = 0;
  for (let s = sources.length - 1; s >= 0; s--) {
    const src = sources[s];
    for (let i = src.entries.length - 1; i >= 0; i--) {
      const e = src.entries[i];
      const text = entryText(e, src, !!o.includeTools);
      if (!text || !res.every((r) => r.test(text))) continue;
      total++;
      if (matches.length < limit) matches.push({ ref: `${src.sessionId}:${i}`, at: e.at, who: whoWrote(e), snippet: snippet(text, res) });
    }
  }
  return { matches, total };
}

export function parseRef(ref: string): { sessionId: string; index: number } | null {
  const m = /^\s*([\w-]+):(\d+)\s*$/.exec(ref ?? "");
  return m ? { sessionId: m[1], index: Number(m[2]) } : null;
}

export interface ReadLine {
  ref: string;
  at: string;
  who: string;
  text: string;
}

/**
 * The messages around index: up to `before` earlier and `after` later ones (10 each by default), capped at 40 messages
 * and about 8,000 tokens, filled outwards from the ref. Tool rows show as one line; the ref's own entry shows in full.
 */
export function readChat(src: ChatSource, index: number, o: { before?: number; after?: number } = {}): { lines: ReadLine[]; capped: boolean } {
  if (index < 0 || index >= src.entries.length) throw new Error(`no message ${index} in that chat (it has ${src.entries.length})`);
  const side = (v: number | undefined) => Math.max(0, Math.min(READ_MAX_MESSAGES - 1, Number.isFinite(v) ? Math.floor(v!) : DEFAULT_SIDE));
  const [want, wantAfter] = [side(o.before), side(o.after)];
  const shown = (i: number, full: boolean): ReadLine | null => {
    const e = src.entries[i];
    let text = full ? entryText(e, src, true) ?? e.text : isMessage(e) ? e.text : e.text.split("\n")[0];
    if (!text?.trim()) return null;
    if (full && roughTokens(text) > READ_MAX_TOKENS) text = `${text.slice(0, READ_MAX_TOKENS * 4 - 1)}…`;
    return { ref: `${src.sessionId}:${i}`, at: e.at, who: whoWrote(e), text };
  };
  const center = shown(index, true)!;
  const lines: ReadLine[] = [center];
  let tokens = roughTokens(center.text);
  let [lo, hi, nBefore, nAfter] = [index - 1, index + 1, 0, 0];
  let capped = false;
  // Fill outwards one message at a time, earlier and later in turn, until the asked count or a cap.
  while ((nBefore < want && lo >= 0) || (nAfter < wantAfter && hi < src.entries.length)) {
    for (const dir of ["before", "after"] as const) {
      if (dir === "before" ? nBefore >= want || lo < 0 : nAfter >= wantAfter || hi >= src.entries.length) continue;
      const i = dir === "before" ? lo-- : hi++;
      const line = shown(i, false);
      if (!line) continue;
      const cost = roughTokens(line.text);
      if (lines.length >= READ_MAX_MESSAGES || tokens + cost > READ_MAX_TOKENS) {
        capped = true;
        return { lines, capped };
      }
      tokens += cost;
      if (dir === "before") {
        lines.unshift(line);
        nBefore++;
      } else {
        lines.push(line);
        nAfter++;
      }
    }
  }
  return { lines, capped };
}

/** Tool results in a raw transcript by tool_use id (search_chat with includeTools). */
export function toolOutputs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.includes("tool_result")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const c = b.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : "";
      out.set(b.tool_use_id, text.length > 20_000 ? text.slice(0, 20_000) : text);
    }
  }
  return out;
}

const when = (at: string) => (at ? at.slice(0, 16).replace("T", " ") : "unknown time");

export function matchesText(ticketId: string, query: string, r: { matches: ChatMatch[]; total: number }, includeTools: boolean): string {
  if (!r.matches.length) {
    return `No messages in ${ticketId}'s chat have all of: ${queryWords(query).join(", ")}.` +
      (includeTools ? "" : " Tool output wasn't searched; pass includeTools: true to search it too.") + " Try fewer or other words.";
  }
  const head = `${r.total} message${r.total === 1 ? " in" : "s in"} ${ticketId}'s chat match${r.total === 1 ? "es" : ""}` +
    (r.total > r.matches.length ? `; the newest ${r.matches.length} below` : "") + ". read_chat(ref) loads the messages around one.";
  return [head, ...r.matches.map((m) => `\n[${m.ref}] ${when(m.at)} ${m.who}:\n${m.snippet}`)].join("\n");
}

export function readText(ticketId: string, r: { lines: ReadLine[]; capped: boolean }): string {
  const body = r.lines.map((l) => `[${l.ref}] ${when(l.at)} ${l.who}:\n${l.text}`).join("\n\n");
  return `${r.lines.length} message${r.lines.length === 1 ? "" : "s"} from ${ticketId}'s chat:\n\n${body}` +
    (r.capped ? `\n\n(Stopped at the cap of ${READ_MAX_MESSAGES} messages or about ${READ_MAX_TOKENS} tokens; read_chat on the first or last ref shows more.)` : "");
}
