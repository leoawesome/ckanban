// Starts `ckanban mcp` (the stdio MCP server) as its own program against a contract-test daemon and speaks
// newline-delimited JSON-RPC 2.0 to it, the way Claude Code does. Imports nothing from src/ (see daemon.ts).
// Another MCP server (a port) is tested by setting CKANBAN_CONTRACT_MCP to a JSON array, e.g. '["/tmp/ckanban-rs","mcp"]';
// unset, it is the contract CLI (CKANBAN_CONTRACT_CLI) with "mcp" added.
import { CLI_CMD, commandFromEnv, type Daemon } from "./daemon";

export const MCP_CMD = commandFromEnv("CKANBAN_CONTRACT_MCP", [...CLI_CMD, "mcp"]);

export interface ToolAnswer {
  text: string;
  isError: boolean;
  raw: any;
}

export interface Mcp {
  /** Sends one request and waits for the reply with the same id (the whole JSON-RPC response). */
  request(method: string, params?: unknown): Promise<any>;
  /** Writes a raw line (a notification, a batch or bad JSON). */
  send(line: string): void;
  /** Waits for the next reply whose id matches (or any reply with id null when id is null). */
  reply(id: string | number | null, ms?: number): Promise<any>;
  /** tools/call: the first text block and isError. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  stderr(): string;
  close(): Promise<number>;
}

export interface McpOptions {
  /** Extra env (e.g. CKANBAN_TICKET for a board run), over the daemon's env. */
  env?: Record<string, string>;
  cwd?: string;
  /** Do the initialize handshake first (default true). */
  init?: boolean;
  /** Another server command than MCP_CMD (the parity test starts Bun's and a port's side by side). */
  cmd?: string[];
}

export async function startMcp(d: Daemon, opts: McpOptions = {}): Promise<Mcp> {
  const proc = Bun.spawn(opts.cmd ?? MCP_CMD, {
    env: { ...d.env, ...opts.env },
    cwd: opts.cwd ?? d.project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const replies: any[] = [];
  const waiters: (() => void)[] = [];
  let err = "";
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        replies.push(JSON.parse(line));
        waiters.splice(0).forEach((w) => w());
      }
    }
  })();
  (async () => {
    err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  })();

  const send = (line: string) => {
    proc.stdin.write(line + "\n");
    proc.stdin.flush();
  };
  const reply = async (id: string | number | null, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = replies.findIndex((r) => r.id === id);
      if (i >= 0) return replies.splice(i, 1)[0];
      if (proc.exitCode !== null) throw new Error(`mcp server exited with ${proc.exitCode}:\n${err}`);
      const left = end - Date.now();
      if (left <= 0) throw new Error(`no reply to id ${id} within ${ms}ms`);
      await Promise.race([new Promise<void>((r) => waiters.push(r)), Bun.sleep(Math.min(left, 200))]);
    }
  };
  let next = 1;
  const request = (method: string, params?: unknown) => {
    const id = next++;
    send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    return reply(id);
  };
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`tools/call ${name}: JSON-RPC error ${JSON.stringify(r.error)}`);
    const text = r.result.content.map((c: any) => c.text).join("\n");
    return { text, isError: r.result.isError === true, raw: r.result };
  };
  const close = async () => {
    try {
      proc.stdin.end();
    } catch {}
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!done) proc.kill("SIGKILL");
    return proc.exited;
  };

  const m: Mcp = { request, send, reply, call, stderr: () => err, close };
  if (opts.init !== false) {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-test", version: "1" } });
    send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  }
  return m;
}
