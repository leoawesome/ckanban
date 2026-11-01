import type { AgentRegistry } from "./server/agents";
import type { RemoteAccess } from "./server/remote";

export const STEP_LIMIT_MS = 15_000;

type Remote = Pick<RemoteAccess, "active" | "off">;
type Registry = Pick<AgentRegistry, "status" | "uninstall">;

function limit<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} seconds`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** `ckanban uninstall`: turn off phone access and remove the ckanban MCP from Claude Code and Codex. Never throws; each failure is one line. */
export async function uninstallExtras(remote: Remote, registry: Registry, warn: (s: string) => void = console.error, ms = STEP_LIMIT_MS) {
  if (remote.active()) {
    try {
      const st = await limit(remote.off(), ms);
      if (st.warning) warn(`Couldn't turn off phone access (${reason(st.warning)}); run "ckanban remote off" later.`);
    } catch (e) {
      warn(`Couldn't turn off phone access (${reason(e)}); run "ckanban remote off" later.`);
    }
  }
  let agents: Awaited<ReturnType<Registry["status"]>>;
  try {
    agents = await limit(registry.status(), ms);
  } catch (e) {
    warn(`Couldn't check Claude Code and Codex (${reason(e)}); run "ckanban mcp uninstall" later.`);
    return;
  }
  for (const a of agents) {
    // Not registered, or Claude Code isn't installed (nothing to remove it with): fine.
    if (!a.installed || (a.id === "claude" && !a.available)) continue;
    try {
      await limit(registry.uninstall(a.id), ms);
    } catch (e) {
      warn(`Couldn't remove ckanban from ${a.label} (${reason(e)}); run "ckanban mcp uninstall --${a.id}" later.`);
    }
  }
}
