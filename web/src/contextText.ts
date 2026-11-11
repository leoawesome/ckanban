/**
 * The Context panel's words and rows (kept DOM-free for tests). The server parses Claude Code's `/context` report
 * (src/server/context-usage.ts); this turns its rows into plain names, colours and the phone's shorter list.
 */

export interface ContextCategory { name: string; tokens: number; percent: number | null; deferred: boolean }
export interface ContextServer { server: string; tokens: number; tools: { name: string; tokens: number }[] }
export interface ContextReport {
  model: string | null;
  used: number;
  window: number;
  percent: number;
  categories: ContextCategory[];
  mcpServers: ContextServer[];
  builtinTools: { name: string; tokens: number }[];
  memoryFiles: { type: string; path: string; tokens: number }[];
  skills: { name: string; source: string; tokens: number }[];
}
export interface ContextView {
  state: "none" | "idle" | "running";
  result: { report: ContextReport; checkedAt: string } | null;
  error: string | null;
  /** From the chat's earlier session: still shown, refreshed when the next run ends. */
  stale?: boolean;
}

export interface ContextRow {
  key: string;
  label: string;
  /** Claude Code's own name and a one-line explanation (hover text; under the row on a phone). */
  title: string;
  hint: string;
  tokens: number;
  percent: number | null;
  /** Bar colour (a CSS colour or variable). */
  color: string;
  deferred: boolean;
  /** Free space: shown as the bar's empty part, not a segment. */
  free: boolean;
}

interface Known { label: string; hint: string; color: string }
const KNOWN: Record<string, Known> = {
  "messages": { label: "Messages", hint: "Everything said in this chat so far, including tool results", color: "#3b7dd8" },
  "system tools": { label: "Built-in tools", hint: "Claude Code's built-in tools: read, edit, run commands", color: "#e07a3a" },
  "mcp tools": { label: "Connected app tools", hint: "Tools from connected apps (MCP servers) loaded up front", color: "#3fb68b" },
  "system prompt": { label: "System prompt", hint: "Claude Code's own standing instructions", color: "#e8a72c" },
  "skills": { label: "Skills", hint: "Short descriptions of the skills Claude can use", color: "#8a8780" },
  "memory files": { label: "Memory files", hint: "CLAUDE.md and saved memories", color: "#a29f97" },
  "mcp server instructions": { label: "Connected app instructions", hint: "Instructions that connected apps give Claude", color: "#b8b5ad" },
  "autocompact buffer": { label: "Room to summarise", hint: "Kept free so the chat can be summarised when it gets long", color: "#c9c6bd" },
  "free space": { label: "Free space", hint: "Space left before Claude has to summarise", color: "transparent" },
  "mcp tools (deferred)": { label: "Connected app tools (on demand)", hint: "Available but only loaded when Claude asks for them: not counted as used", color: "var(--border)" },
  "system tools (deferred)": { label: "Built-in tools (on demand)", hint: "Available but only loaded when Claude asks for them: not counted as used", color: "var(--border)" },
};
/** Colours for rows Claude Code adds later (they keep their own label). */
const EXTRA = ["#9b6bd1", "#d0598a", "#4fa3b5", "#7a8f3a"];
/** Order on screen: biggest kinds first, as in the mockup; unknown rows after the known used ones. */
const ORDER = ["messages", "system tools", "mcp tools", "system prompt", "skills", "memory files", "mcp server instructions"];

export function contextRows(cats: ContextCategory[]): ContextRow[] {
  let extra = 0;
  const rows = cats.map((c): ContextRow => {
    const k = c.name.trim().toLowerCase();
    const known = KNOWN[k];
    const deferred = c.deferred;
    return {
      key: k, label: known?.label ?? c.name, hint: known?.hint ?? (deferred ? KNOWN["mcp tools (deferred)"].hint : ""),
      title: known ? `${c.name}: ${known.hint}` : c.name,
      tokens: c.tokens, percent: deferred ? null : c.percent, deferred,
      color: known?.color ?? (deferred ? "var(--border)" : EXTRA[extra++ % EXTRA.length]),
      free: k === "free space",
    };
  });
  const rank = (r: ContextRow) => {
    if (r.deferred) return 100;
    if (r.free) return 51;
    if (r.key === "autocompact buffer") return 50;
    const i = ORDER.indexOf(r.key);
    return i >= 0 ? i : 20;
  };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

const MERGE = new Set(["skills", "memory files", "mcp server instructions"]);

/**
 * The phone's shorter list: Skills, Memory files and Connected app instructions are one row, and the on-demand rows
 * are one row too.
 */
export function phoneRows(rows: ContextRow[]): ContextRow[] {
  const out: ContextRow[] = [];
  const merge = (key: string, label: string, hint: string, color: string, parts: ContextRow[], deferred: boolean): ContextRow => ({
    key, label, hint, color, deferred, free: false, title: parts.map((p) => p.title).join("\n"),
    tokens: parts.reduce((s, p) => s + p.tokens, 0),
    percent: deferred ? null : Math.round(parts.reduce((s, p) => s + (p.percent ?? 0), 0) * 10) / 10,
  });
  const small = rows.filter((r) => MERGE.has(r.key));
  const onDemand = rows.filter((r) => r.deferred);
  for (const r of rows) {
    if (MERGE.has(r.key)) {
      if (r === small[0]) out.push(small.length > 1 ? merge("small", "Skills, memory, app instructions", "Skills, CLAUDE.md and connected apps' instructions", "#8a8780", small, false) : r);
      continue;
    }
    if (r.deferred) {
      if (r === onDemand[0]) out.push(onDemand.length > 1 ? merge("on-demand", "On-demand tools", "Loaded only when needed, not counted", "var(--border)", onDemand, true) : r);
      continue;
    }
    out.push(r);
  }
  return out;
}

/** "154k", "1M", "201", "92.1k" (one decimal under 100k). */
export function tokenText(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const percentText = (p: number | null) => (p === null ? "—" : `${p.toFixed(1)}%`);

/** The chip: "Context" before the first check, then "N% used". */
export function chipText(v: ContextView | null): string {
  return v?.result ? `${Math.round(v.result.report.percent)}% used` : "Context";
}

/** "Checked just now", "Checked 2 min ago", "Checked 3 h ago". */
export function checkedText(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "Checked just now";
  if (s < 3600) return `Checked ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Checked ${Math.floor(s / 3600)} h ago`;
  return `Checked ${Math.floor(s / 86400)} d ago`;
}

/** Memory file paths, shortened: the home folder as ~. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}
