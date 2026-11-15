// `ckanban mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) exposing the board as tools.
// Hand-rolled instead of @modelcontextprotocol/sdk: we only need initialize, tools/list and tools/call.
// The tools themselves are in the *-tools.ts files next to this one, one file per group.
import { createHash } from "node:crypto";
import { assertCanChange, BoardClient, ConfirmPending } from "../cli/client";
import { VERSION } from "../core/version";
import type { Tool, ToolContext } from "./shared";
import { ARTIFACT_TOOLS } from "./artifact-tools";
import { SCHEDULE_TOOLS, JOB_TOOLS } from "./schedule-tools";
import { PLANNING_TOOLS } from "./form-tools";
import { HUDDLE_TOOLS } from "./huddle-tools";
import { TICKET_TOOLS } from "./ticket-tools";
import { WORKFLOW_TOOLS } from "./workflow-tools";
import { FAMILY_TOOLS } from "./family-tools";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const TOOLS: Tool[] = [
  ...TICKET_TOOLS,
  ...WORKFLOW_TOOLS,
  ...FAMILY_TOOLS,
  ...PLANNING_TOOLS,
  ...HUDDLE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...SCHEDULE_TOOLS,
  ...JOB_TOOLS,
];


let toolsHash: string | null = null;

/** A fingerprint of the board tools' names, descriptions and options: it changes when a new version changes any tool. */
export function toolsVersion(): string {
  toolsHash ??= createHash("sha256").update(JSON.stringify(TOOLS.map((t) => [t.name, t.description, t.inputSchema]))).digest("hex").slice(0, 16);
  return toolsHash;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
  if (!tool) return text(`unknown tool ${name}`, true);
  try {
    if (tool.changes && !tool.allowInRun && !tool.plannerScope) assertCanChange(ctx.env);
    return text(await tool.run(args ?? {}, ctx));
  } catch (e) {
    // Held for the user's Confirm tap in Telegram (the front desk): not an error, the text says what happens next.
    if (e instanceof ConfirmPending) return text(e.message);
    return text((e as Error).message, true);
  }
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: JsonRpc, ctx: ToolContext): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  const isRequest = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "ckanban", version: VERSION },
        instructions:
          "Tools for the user's local ckanban board. Use them when the user asks to put work on the board, " +
          "find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default. " +
          "Schedules (create_schedule etc.) make the board create and run a ticket on a cron, for work the user wants done regularly; " +
          "schedule_job runs a ticket or a command once at a set time. Board chats and runs may create, change, pause, resume and run them now on their own judgment; " +
          "delete_schedule there deletes nothing: in a ticket's chat or run it shows the user a card to confirm (a tool ticket reports it to its main ticket instead), " +
          "a quick chat can't delete schedules (the user does it in the Schedules window), and the Telegram front desk asks for a Confirm tap. " +
          "ask_questions, propose_ticket, propose_tickets, propose_branch, propose_teammate and propose_squad are for the board's ticket chats: they show a form or cards to the user. " +
          "propose_helper_rule suggests a line for what the helper knows about the user, only when the user asked for that alert rule in a message they typed; the user's Add on its card saves it.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case "tools/call":
      return reply(await callTool(String(msg.params?.name ?? ""), msg.params?.arguments, ctx));
    default:
      return isRequest ? fail(-32601, `method not found: ${msg.method}`) : null;
  }
}

export async function serveStdio(ctx: ToolContext = { client: new BoardClient(), cwd: process.cwd(), env: process.env }): Promise<void> {
  const write = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const decoder = new TextDecoder();
  let buf = "";
  const pending: Promise<void>[] = [];
  const handle = (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      pending.push(handleMessage(m, ctx).then((r) => {
        if (r) write(r);
      }, (e) => {
        if (m?.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
      }));
    }
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  await Promise.all(pending);
}
