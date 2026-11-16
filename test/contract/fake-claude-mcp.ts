#!/usr/bin/env bun
// A fake of `claude mcp ...` for the connections contract test: keeps user-scope servers in
// $CLAUDE_CONFIG_DIR/.claude.json `mcpServers`, as Claude Code does, and prints `list` and `get` in its format. Every
// command it is given is appended to $FAKE_MCP_LOG (JSON lines). Only `mcp` commands come here (connections.test.ts
// sends the rest to test/fixtures/fake-claude.ts). Imports nothing from src/.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(args) + "\n");
const file = join(process.env.CLAUDE_CONFIG_DIR ?? "/nonexistent", ".claude.json");
const read = (): any => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const write = (cfg: any) => writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
const fail = (text: string) => {
  process.stderr.write(text + "\n");
  process.exit(1);
};

const [, cmd, ...rest] = args;
const cfg = read();
const servers: Record<string, any> = (cfg.mcpServers ??= {});
const target = (e: any) => (e.type === "http" || e.type === "sse" ? `${e.url} (${e.type.toUpperCase()})` : [e.command, ...(e.args ?? [])].join(" "));

if (cmd === "list") {
  const names = Object.keys(servers);
  console.log("Checking MCP server health...\n");
  if (!names.length) console.log("No MCP servers configured.");
  for (const n of names) console.log(`${n}: ${target(servers[n])} - ✓ Connected`);
} else if (cmd === "get") {
  const e = servers[rest[0]];
  if (!e) fail(`No MCP server found with name: ${rest[0]}`);
  console.log(`${rest[0]}:\n  Scope: User config\n  Status: ✓ Connected\n  Type: ${e.type}`);
} else if (cmd === "remove") {
  if (!servers[rest[0]]) fail(`No user-scoped MCP server found with name: ${rest[0]}`);
  delete servers[rest[0]];
  write(cfg);
} else if (cmd === "add-json") {
  // add-json --scope user <name> <json>
  const pos = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--scope");
  servers[pos[0]] = JSON.parse(pos[1]);
  write(cfg);
} else if (cmd === "add") {
  // add --scope user --transport <t> <name> [-e K=V]... -- <command> <args...>   or   ... <name> <url> [-H "N: V"]...
  let transport = "stdio";
  const pos: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") break;
    if (a === "--scope") i++;
    else if (a === "--transport") transport = rest[++i];
    else if (a === "-e") {
      const [k, ...v] = rest[++i].split("=");
      env[k] = v.join("=");
    } else if (a === "-H") {
      const h = rest[++i];
      const at = h.indexOf(": ");
      headers[h.slice(0, at)] = h.slice(at + 2);
    } else pos.push(a);
  }
  const name = pos[0];
  if (servers[name]) fail(`MCP server ${name} already exists in user config`);
  servers[name] = transport === "stdio"
    ? { type: "stdio", command: rest[i + 1], args: rest.slice(i + 2), env }
    : { type: transport, url: pos[1], ...(Object.keys(headers).length ? { headers } : {}) };
  write(cfg);
} else {
  fail(`fake claude mcp: no ${cmd}`);
}
