/**
 * The Context panel: how full a chat's Claude memory is and what fills it, from Claude Code's built-in `/context`.
 *
 * `claude -p "/context" --resume <id>` makes no model call, but it appends bookkeeping lines to the session it
 * resumes. So it never runs on a chat's own session: the session file is copied (forkSessionFile), `/context` runs
 * on the copy, and the copy is deleted afterwards. The copy gives the same numbers.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** The result is from the chat's earlier Claude session (shown until the next run end refreshes it). */
  stale?: boolean;
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
  /**
   * Where a chat's last result is saved, so it survives a restart; null: don't save (the chat is gone). Its folder must
   * already exist: a write never creates folders, so a check that ends after a delete leaves nothing behind.
   */
  file?: (key: string) => string | null;
  /** Background checks (schedule()) running at once across the board (default 2). */
  maxBackground?: number;
}

/** What is saved per chat: only the parsed result, when it was checked, and the session it belongs to. */
interface Saved {
  sessionId: string;
  result: ContextResult;
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
  /** Background checks waiting for a slot, one per chat (a newer one replaces the queued one). */
  private queue = new Map<string, ContextSpec>();
  private background = 0;
  private waiters = new Set<() => void>();

  constructor(private opts: ContextUsageOptions) {}

  private configDir(): string {
    return this.opts.configDir?.() ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  /** The cached view for the chat (spec null: no session yet). Never starts a check. */
  view(key: string, sessionId: string | null): ContextView {
    if (!sessionId) return { state: "none", result: null, error: null };
    const e = this.entry(key);
    const state = this.inflight.has(sessionId) ? "running" : "idle";
    if (!e) return { state, result: null, error: null };
    if (e.sessionId === sessionId) return { state, result: e.result, error: e.error };
    // An earlier session's numbers: shown, marked stale, refreshed when the next run ends.
    return { state, result: e.result, error: null, stale: true };
  }

  /** The chat has a result (in memory or saved on disk). */
  checked(key: string): boolean {
    return this.entry(key) !== undefined;
  }

  /** The cached entry, read from the saved file the first time (so results survive a restart). */
  private entry(key: string): Entry | undefined {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const saved = this.load(key);
    if (!saved) return undefined;
    const e: Entry = { sessionId: saved.sessionId, result: saved.result, error: null };
    this.cache.set(key, e);
    return e;
  }

  private load(key: string): Saved | null {
    let f: string | null = null;
    try {
      f = this.opts.file?.(key) ?? null;
      if (!f || !existsSync(f)) return null;
      const s = JSON.parse(readFileSync(f, "utf8")) as Saved;
      if (typeof s?.sessionId !== "string" || typeof s.result?.checkedAt !== "string" || !s.result.report) return null;
      return s;
    } catch {
      return null;
    }
  }

  private save(key: string, saved: Saved): void {
    try {
      const f = this.opts.file?.(key);
      if (!f || !existsSync(dirname(f))) return;
      const tmp = `${f}.tmp-${crypto.randomUUID()}`;
      writeFileSync(tmp, JSON.stringify(saved));
      renameSync(tmp, f);
    } catch {}
  }

  /**
   * A check in the background (a run of the chat ended): waits for one of the board's few slots. A chat already
   * waiting keeps one place in the queue, with the newest spec.
   */
  schedule(key: string, spec: ContextSpec): void {
    this.queue.delete(key);
    this.queue.set(key, spec);
    this.pump();
  }

  private pump(): void {
    const max = Math.max(1, this.opts.maxBackground ?? 2);
    while (this.background < max && this.queue.size) {
      const [key, spec] = this.queue.entries().next().value as [string, ContextSpec];
      this.queue.delete(key);
      this.background++;
      this.refresh(key, spec).finally(() => {
        this.background--;
        this.pump();
        if (!this.background && !this.queue.size) for (const w of this.waiters) w();
      });
    }
  }

  /** Background checks running and waiting (tests). */
  get pending(): { running: number; queued: number } {
    return { running: this.background, queued: this.queue.size };
  }

  /** Starts a check (or joins the one running for this session); resolves when it is over. */
  refresh(key: string, spec: ContextSpec): Promise<void> {
    const running = this.inflight.get(spec.sessionId);
    if (running) return running;
    const p = this.run(spec).then(
      (result) => {
        this.cache.set(key, { sessionId: spec.sessionId, result, error: null });
        this.save(key, { sessionId: spec.sessionId, result });
      },
      (e) => {
        const prev = this.entry(key);
        this.cache.set(key, { sessionId: spec.sessionId, result: prev?.sessionId === spec.sessionId ? prev.result : null, error: plain(e) });
      },
    ).finally(() => {
      this.inflight.delete(spec.sessionId);
      this.opts.changed?.(key);
    });
    this.inflight.set(spec.sessionId, p);
    return p;
  }

  /** Forget a chat (deleted): its cached result and any queued check. The saved file goes with the chat's own files. */
  drop(key: string): void {
    this.cache.delete(key);
    this.queue.delete(key);
  }

  /** Waits for every check that is running or queued (shutdown, tests). */
  async idle(): Promise<void> {
    if (this.background || this.queue.size) await new Promise<void>((r) => {
      const w = () => {
        this.waiters.delete(w);
        r();
      };
      this.waiters.add(w);
    });
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
