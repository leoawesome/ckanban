#!/usr/bin/env bun
// A tiny MCP server on stdio (newline-delimited JSON-RPC) for the automations contract test: a "program on this
// computer" connection that check scripts reach with `ckanban call`. One tool, `list_items`, answers with the items in
// the file named by its `file` argument (JSON lines), as text. Every tools/call is appended to $FAKE_TOOLS_LOG.
// Imports nothing from src/.
import { appendFileSync, readFileSync } from "node:fs";

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    const line = buf.slice(0, i).trim();
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-tools", version: "1" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "list_items", description: "Items in a file", inputSchema: { type: "object" } }] } });
    } else if (m.method === "tools/call" && m.params.name === "list_items") {
      if (process.env.FAKE_TOOLS_LOG) appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify(m.params) + "\n");
      const items = readFileSync(String(m.params.arguments?.file ?? ""), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(items) }] } });
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method} ${m.params?.name ?? ""}`.trim() } });
    }
  }
}
