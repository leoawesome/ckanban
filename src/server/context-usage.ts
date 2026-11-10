/**
 * The Context panel: how full a chat's Claude memory is and what fills it, from Claude Code's built-in `/context`.
 *
 * `claude -p "/context" --resume <id>` makes no model call, but it appends bookkeeping lines to the session it
 * resumes. So it never runs on a chat's own session: the session file is copied (forkSessionFile), `/context` runs
 * on the copy, and the copy is deleted afterwards. The copy gives the same numbers.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { forkSessionFile } from "./fork";

// ---- Parser: the markdown `/context` prints ----

export interface ContextCategory {
  /** The row's name as Claude Code prints it ("System tools", "MCP tools (deferred)", or anything new). */
  name: string;
  tokens: number;
  /** Share of the window, or null when the row had none. */
  percent: number | null;
  /** Loaded only when Claude asks for it ("(deferred)"): not counted in used. */
  deferred: boolean;
}

export interface ContextTool { name: string; tokens: number }
export interface ContextServer { server: string; tokens: number; tools: ContextTool[] }
export interface ContextMemoryFile { type: string; path: string; tokens: number }
export interface ContextSkill { name: string; source: string; tokens: number }

export interface ContextReport {
  model: string | null;
  used: number;
  window: number;
  percent: number;
  categories: ContextCategory[];
  /** MCP tools grouped by server, biggest server first. */
  mcpServers: ContextServer[];
  /** Built-in tools when the report lists them (`### System Tools`), else empty. */
  builtinTools: ContextTool[];
  memoryFiles: ContextMemoryFile[];
  skills: ContextSkill[];
}

/** "2.5k" → 2500, "1.2m" → 1200000, "201" → 201, "~130" → 130, "1,234" → 1234. NaN-free: unreadable gives 0. */
export function parseTokens(s: string): number {
  const m = /([\d.,]+)\s*([kmb])?/i.exec(s.replace(/~/g, "").trim());
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Math.round(n * mult);
}

function parsePercent(s: string): number | null {
  const m = /(-?[\d.]+)\s*%/.exec(s);
  return m ? Number(m[1]) : null;
}

/** The markdown table rows (cells) under each `###` heading, keyed by heading in lower case. */
function tables(md: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  let current: string[][] | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = /^#{3,}\s+(.+)$/.exec(line);
    if (h) {
      current = [];
      out.set(h[1].trim().toLowerCase(), current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current || !line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    // The separator row, and the header row (the first row of each table).
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
    current.push(cells);
  }
  // Drop each table's header row.
  for (const [k, rows] of out) out.set(k, rows.slice(1));
  return out;
}

const section = (t: Map<string, string[][]>, ...names: string[]) => {
  for (const n of names) {
    const rows = t.get(n);
    if (rows) return rows;
  }
  return [];
};

export function parseContextReport(md: string): ContextReport {
  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(md)?.[1]?.trim() || null;
  const tok = /\*\*Tokens:\*\*\s*([\d.,]+\s*[kmb]?)\s*\/\s*([\d.,]+\s*[kmb]?)\s*(?:\(\s*([\d.]+)\s*%\s*\))?/im.exec(md);
  const t = tables(md);
  const categories: ContextCategory[] = section(t, "estimated usage by category").filter((c) => c[0]).map((c) => ({
    name: c[0],
    tokens: parseTokens(c[1] ?? ""),
    percent: parsePercent(c[2] ?? ""),
    deferred: /\(deferred\)/i.test(c[0]),
  }));
  let used = tok ? parseTokens(tok[1]) : 0;
  let window = tok ? parseTokens(tok[2]) : 0;
  // A report without the Tokens line: work it out from the rows (deferred rows and free space don't count as used).
  if (!tok && categories.length) {
    const counted = categories.filter((c) => !c.deferred && !/^free space$/i.test(c.name) && !/autocompact|buffer/i.test(c.name));
    used = counted.reduce((s, c) => s + c.tokens, 0);
    window = categories.filter((c) => !c.deferred).reduce((s, c) => s + c.tokens, 0);
  }
  const percent = tok?.[3] !== undefined ? Number(tok[3]) : window ? Math.round((used / window) * 100) : 0;

  const servers = new Map<string, ContextServer>();
  for (const c of section(t, "mcp tools")) {
    if (!c[0]) continue;
    const server = c[1] || "other";
    const name = c[0].startsWith(`mcp__${server}__`) ? c[0].slice(`mcp__${server}__`.length) : c[0];
    const tokens = parseTokens(c[2] ?? "");
    const s = servers.get(server) ?? { server, tokens: 0, tools: [] };
    s.tools.push({ name, tokens });
    s.tokens += tokens;
    servers.set(server, s);
  }
  const builtinTools = section(t, "system tools", "built-in tools").filter((c) => c[0]).map((c) => ({ name: c[0], tokens: parseTokens(c[c.length - 1] ?? "") }));
  const memoryFiles = section(t, "memory files").filter((c) => c.length >= 2).map((c) => c.length >= 3
    ? { type: c[0], path: c[1], tokens: parseTokens(c[2]) }
    : { type: "", path: c[0], tokens: parseTokens(c[1]) });
  const skills = section(t, "skills").filter((c) => c[0]).map((c) => c.length >= 3
    ? { name: c[0], source: c[1], tokens: parseTokens(c[2]) }
    : { name: c[0], source: "", tokens: parseTokens(c[1] ?? "") });
  return {
    model, used, window, percent, categories,
    mcpServers: [...servers.values()].sort((a, b) => b.tokens - a.tokens),
    builtinTools, memoryFiles, skills,
  };
}

// ---- Runner: /context on a throwaway copy of the session ----

/** What a chat's real runs use, so the copy sees the same tools and settings. */
export interface ContextSpec {
  sessionId: string;
  /** The folder the chat runs in (its session is filed under it). */
  cwd: string;
  /** The chat's run flags as buildArgs makes them (any --resume/--session-id in them is replaced). */
  args: string[];
  env?: Record<string, string>;
}

/** Flags of a chat run that don't belong in a one-off `/context` call (stream input/output, the prompt, the cap). */
const DROP_WITH_VALUE = new Set(["--input-format", "--output-format", "--resume", "--session-id", "--append-system-prompt", "--max-budget-usd", "--permission-prompt-tool"]);
const DROP = new Set(["-p", "--print", "--verbose", "--replay-user-messages", "--include-partial-messages"]);

/** `claude` argv (without the binary) that prints `/context` for the copy `forkId`, keeping the chat's other flags. */
export function contextArgs(chatArgs: string[], forkId: string): string[] {
  const keep: string[] = [];
  for (let i = 0; i < chatArgs.length; i++) {
    const a = chatArgs[i];
    if (DROP.has(a)) continue;
    if (DROP_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    keep.push(a);
  }
  // The prompt goes right after -p: a list flag like --disallowedTools would take a prompt that came later.
  return ["-p", "/context", "--output-format", "json", "--resume", forkId, ...keep];
}

export const CONTEXT_TIMEOUT_MS = 60_000;

export interface ContextResult {
  report: ContextReport;
  checkedAt: string;
}

/** What the endpoint answers. */
export interface ContextView {
  /** none: the chat has no Claude session yet. */
  state: "none" | "idle" | "running";
  result: ContextResult | null;
  /** The last check failed (plain words); the previous result, if any, stays. */
  error: string | null;
}

export interface ContextUsageOptions {
  claudeBin: string;
  timeoutMs?: number;
  /** Claude's config folder (default $CLAUDE_CONFIG_DIR or ~/.claude). */
  configDir?: () => string;
  /** The session's transcript file, or null. */
  sessionFile: (sessionId: string) => string | null;
  /** A check finished (or failed) for this chat key: tell the UI. */
  changed?: (key: string) => void;
}

interface Entry {
  sessionId: string;
  result: ContextResult | null;
  error: string | null;
}

/** Plain-words message for a failed check. */
function plain(e: unknown): string {
  const m = String((e as Error)?.message ?? e).trim();
  return m.length > 300 ? `${m.slice(0, 297)}…` : m || "Claude Code didn't say why.";
}

/**
 * Results cached per chat (key) and session; one `/context` process per session at a time (callers share it).
 * Nothing runs on render: only refresh() starts one.
 */
export class ContextUsage {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();

  constructor(private opts: ContextUsageOptions) {}

  private configDir(): string {
    return this.opts.configDir?.() ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  /** The cached view for the chat (spec null: no session yet). Never starts a check. */
  view(key: string, sessionId: string | null): ContextView {
    if (!sessionId) return { state: "none", result: null, error: null };
    const e = this.cache.get(key);
    const mine = e && e.sessionId === sessionId ? e : null;
    return { state: this.inflight.has(sessionId) ? "running" : "idle", result: mine?.result ?? null, error: mine?.error ?? null };
  }

  /** The chat was checked before (so a run ending refreshes it). */
  checked(key: string): boolean {
    return this.cache.has(key);
  }

  /** Starts a check (or joins the one running for this session); resolves when it is over. */
  refresh(key: string, spec: ContextSpec): Promise<void> {
    const running = this.inflight.get(spec.sessionId);
    if (running) return running;
    const p = this.run(spec).then(
      (result) => void this.cache.set(key, { sessionId: spec.sessionId, result, error: null }),
      (e) => {
        const prev = this.cache.get(key);
        this.cache.set(key, { sessionId: spec.sessionId, result: prev?.sessionId === spec.sessionId ? prev.result : null, error: plain(e) });
      },
    ).finally(() => {
      this.inflight.delete(spec.sessionId);
      this.opts.changed?.(key);
    });
    this.inflight.set(spec.sessionId, p);
    return p;
  }

  /** Forget a chat (deleted, or its session changed). */
  drop(key: string): void {
    this.cache.delete(key);
  }

  /** Waits for every check that is running (shutdown, tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private async run(spec: ContextSpec): Promise<ContextResult> {
    const src = this.opts.sessionFile(spec.sessionId);
    if (!src) throw new Error("This chat has no saved conversation yet.");
    const forkId = crypto.randomUUID();
    let fork: string | null = null;
    try {
      // The copy is read from the file, so a chat that is running right now is safe too.
      fork = forkSessionFile(src, { fromId: spec.sessionId, toId: forkId, fromCwd: spec.cwd, toCwd: spec.cwd }, this.configDir());
      const proc = Bun.spawn([this.opts.claudeBin, ...contextArgs(spec.args, forkId)], {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        // Closed stdin: otherwise Claude Code waits a few seconds for input.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, this.opts.timeoutMs ?? CONTEXT_TIMEOUT_MS);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      if (timedOut) throw new Error(`Claude Code took longer than ${Math.round((this.opts.timeoutMs ?? CONTEXT_TIMEOUT_MS) / 1000)} seconds to answer.`);
      let json: any = null;
      try {
        json = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? "");
      } catch {}
      if (!json || typeof json.result !== "string") {
        const why = (err.trim().split("\n").filter(Boolean).at(-1) ?? "").trim();
        throw new Error(why ? `Claude Code couldn't check: ${why}` : `Claude Code couldn't check (exit code ${proc.exitCode}).`);
      }
      if (json.is_error) throw new Error(`Claude Code couldn't check: ${json.result.trim() || "no reason given"}`);
      const report = parseContextReport(json.result);
      if (!report.window && !report.categories.length) throw new Error("Claude Code's answer had no context numbers in it.");
      return { report, checkedAt: new Date().toISOString() };
    } finally {
      if (fork) {
        try {
          rmSync(fork, { force: true });
        } catch {}
        const side = join(dirname(fork), forkId);
        try {
          if (existsSync(side)) rmSync(side, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}
