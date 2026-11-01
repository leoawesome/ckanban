import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, type AgentId, type AgentStatus } from "../src/server/agents";
import { uninstallExtras } from "../src/uninstall-extras";
import { tempDir } from "./helpers";

const agent = (id: AgentId, over: Partial<AgentStatus> = {}): AgentStatus => ({
  id, label: id === "claude" ? "Claude Code" : "Codex", available: true, installed: true, current: true, command: "x", configPath: "/x", ...over,
});

function fakes(opts: { on?: boolean; offWarning?: string; offThrows?: boolean; agents?: AgentStatus[]; failing?: AgentId[]; hang?: boolean } = {}) {
  const calls: string[] = [];
  const remote = {
    active: () => (opts.on ? ({} as any) : null),
    off: async () => {
      calls.push("off");
      if (opts.hang) await new Promise(() => {});
      if (opts.offThrows) throw new Error("tailscale not found");
      return { enabled: false, url: null, host: null, allowedLogin: null, lastVisit: null, ...(opts.offWarning ? { warning: opts.offWarning } : {}) };
    },
  };
  const registry = {
    status: async () => opts.agents ?? [agent("claude"), agent("codex")],
    uninstall: async (id: AgentId) => {
      calls.push(`uninstall:${id}`);
      if (opts.failing?.includes(id)) throw new Error(`${id} broke\nmore`);
    },
  };
  const warnings: string[] = [];
  return { calls, remote, registry, warnings, warn: (s: string) => warnings.push(s) };
}

test("uninstall turns phone access off and removes both registrations", async () => {
  const f = fakes({ on: true });
  await uninstallExtras(f.remote, f.registry, f.warn);
  expect(f.calls).toEqual(["off", "uninstall:claude", "uninstall:codex"]);
  expect(f.warnings).toEqual([]);
});

test("uninstall leaves phone access alone when it is off, and skips what isn't registered or has no claude", async () => {
  const f = fakes({ agents: [agent("claude", { available: false }), agent("codex", { installed: false })] });
  await uninstallExtras(f.remote, f.registry, f.warn);
  expect(f.calls).toEqual([]);
  expect(f.warnings).toEqual([]);
});

test("uninstall carries on with warnings when tailscale, claude or codex fail", async () => {
  const f = fakes({ on: true, offWarning: "tailscale not found", failing: ["claude", "codex"] });
  await uninstallExtras(f.remote, f.registry, f.warn);
  expect(f.calls).toEqual(["off", "uninstall:claude", "uninstall:codex"]);
  expect(f.warnings).toEqual([
    `Couldn't turn off phone access (tailscale not found); run "ckanban remote off" later.`,
    `Couldn't remove ckanban from Claude Code (claude broke); run "ckanban mcp uninstall --claude" later.`,
    `Couldn't remove ckanban from Codex (codex broke); run "ckanban mcp uninstall --codex" later.`,
  ]);

  const g = fakes({ on: true, offThrows: true });
  await uninstallExtras(g.remote, g.registry, g.warn);
  expect(g.warnings).toEqual([`Couldn't turn off phone access (tailscale not found); run "ckanban remote off" later.`]);
  expect(g.calls).toEqual(["off", "uninstall:claude", "uninstall:codex"]);
});

test("uninstall gives up on a step that hangs", async () => {
  const f = fakes({ on: true, hang: true });
  await uninstallExtras(f.remote, f.registry, f.warn, 20);
  expect(f.warnings).toEqual([`Couldn't turn off phone access (no answer after 0.02 seconds); run "ckanban remote off" later.`]);
  expect(f.calls).toEqual(["off", "uninstall:claude", "uninstall:codex"]);
});

test("uninstall with the real registry: missing claude is silent, codex entry is removed", async () => {
  const dir = tempDir("ck-agents-");
  const claudeConfig = join(dir, ".claude.json");
  writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { ckanban: { command: "ckanban", args: ["mcp"] } } }));
  mkdirSync(join(dir, "codex"));
  const codexConfig = join(dir, "codex", "config.toml");
  writeFileSync(codexConfig, `[mcp_servers.ckanban]\ncommand = "ckanban"\nargs = ["mcp"]\n`);
  const registry = new AgentRegistry({ claudeBin: join(dir, "no-claude"), codexBin: join(dir, "no-codex"), claudeConfig, codexConfig, serverArgv: ["ckanban", "mcp"] });
  const f = fakes();
  await uninstallExtras(f.remote, registry, f.warn);
  expect(f.warnings).toEqual([]);
  expect(readFileSync(codexConfig, "utf8")).not.toContain("ckanban");
});
