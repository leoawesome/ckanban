// Phone access from the outside: the daemon's second listener (CKANBAN_REMOTE_PORT), which on a real Mac only
// `tailscale serve` calls, with the tailnet Host and the owner's Tailscale login. remote.json (contracts/data-files.md)
// is written by the test, so no Tailscale command ever runs. Imports nothing from src/.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "./daemon";

export const PHONE_HOST = "ckmac.tail0000.ts.net";
export const PHONE_LOGIN = "owner@example.com";

/** Writes remote.json as `ckanban remote on` (or off) leaves it. The daemon re-reads it when it changes. */
export function writeRemoteJson(home: string, enabled: boolean, extra: Record<string, unknown> = {}) {
  writeFileSync(join(home, "remote.json"), JSON.stringify({ enabled, host: PHONE_HOST, allowedLogin: PHONE_LOGIN, updatedAt: new Date().toISOString(), ...extra }, null, 2) + "\n");
}

/** The headers `tailscale serve` passes on for the owner's phone; a mutation from the board page adds its Origin. */
export function phoneHeaders(method: string): Record<string, string> {
  return {
    host: PHONE_HOST,
    "tailscale-user-login": PHONE_LOGIN,
    ...(method === "GET" || method === "HEAD" ? {} : { origin: `https://${PHONE_HOST}` }),
  };
}

/** A request on the phone access listener; `headers` replace the phone's own (pass a key with "" to drop it). */
export async function phone<T = any>(d: Daemon, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; text: string; headers: Headers }> {
  const h: Record<string, string> = { ...phoneHeaders(method), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  for (const k of Object.keys(h)) if (h[k] === "") delete h[k];
  const res = await fetch(`http://127.0.0.1:${d.remotePort}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, text, headers: res.headers };
}
