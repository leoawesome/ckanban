import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Keys the user saved for one board (the ask_keys box in a ticket chat, or a key an automation needs): stored as board
 * passes in the one pass store (integrations/passes.ts, kind "key" with `board` set), owner-only (0600). Every later
 * run on that board gets them as environment variables under their names (ticket runs, huddle helpers, automations
 * that list them), so Claude can place a key with shell commands without ever reading it. Values never leave the
 * daemon in any other way: not to the UI, Claude's messages, logs, ticket files or bus events.
 *
 * This file only reads the store (cheap, cached by the file's change time): runs, huddles and the store's masking use
 * it without needing the Passes object the HTTP server owns.
 */

export const PASSES_FILE = "automation-passes.json";

/** Variable names a saved key can't take: the board's own, and ones that change how Claude, git or programs start. */
const RESERVED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP", "PWD", "IFS", "PS4", "CDPATH", "BASH_ENV", "ENV", "ZDOTDIR",
  "PROMPT_COMMAND", "EDITOR", "VISUAL", "PAGER", "SSH_AUTH_SOCK", "GNUPGHOME", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GOOGLE_APPLICATION_CREDENTIALS",
  // gh reads these first: a saved one would replace the board's own GitHub login (pushes, pull requests) in every run.
  "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
]);
const RESERVED_PREFIX = /^(CKANBAN_|CLAUDE|ANTHROPIC_|AWS_BEARER_TOKEN_BEDROCK|VERTEX_|GH_|DYLD_|LD_|NODE_|BUN_|npm_|GIT_|LC_|XDG_|SSL_|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|MCP_|OTEL_|DISABLE_|PYTHON)/;
export const KEY_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Why this can't be a saved key's name, or null when it can. */
export function keyNameError(name: string): string | null {
  if (!KEY_NAME.test(name)) return `"${name}" can't be a key's name: use capital letters, digits and _ (like SENTRY_AUTH_TOKEN)`;
  if (RESERVED.has(name) || RESERVED_PREFIX.test(name)) return `"${name}" is a name the board or Claude uses itself: pick another (like MY_${name.replace(/^_+/, "")})`;
  return null;
}

/** A saved board key as stored (no other pass kinds). */
interface StoredKey {
  id: string;
  board: string;
  name: string;
  envName: string;
  secret: string;
  createdAt: string;
  savedAt?: string;
}

interface Cached {
  stamp: string;
  passes: any[];
}
const cache = new Map<string, Cached>();

function readAll(root: string): any[] {
  const file = join(root, PASSES_FILE);
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    cache.delete(file);
    return [];
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.passes;
  let passes: any[] = [];
  try {
    const f = JSON.parse(readFileSync(file, "utf8"));
    passes = Array.isArray(f?.passes) ? f.passes : [];
  } catch {}
  cache.set(file, { stamp, passes });
  return passes;
}

/** The board's saved keys (with their values: daemon use only). */
function boardKeys(root: string, slug: string): StoredKey[] {
  return readAll(root).filter((p) => p?.kind === "key" && p.board === slug && !p.url && typeof p.envName === "string" && typeof p.secret === "string" && p.secret) as StoredKey[];
}

/** The environment variables a run on this board gets: each saved key under its name. Never another board's. */
export function boardKeyEnv(root: string, slug: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of boardKeys(root, slug)) if (!keyNameError(k.envName)) out[k.envName] = k.secret;
  return out;
}

/** Every secret the pass store holds (keys and tokens of every board), long enough to mask safely. */
export function savedSecrets(root: string): string[] {
  const out: string[] = [];
  for (const p of readAll(root)) for (const s of [p?.secret, p?.tokens?.access, p?.tokens?.refresh, p?.oauth?.clientSecret]) if (typeof s === "string" && s.length >= 8) out.push(s);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Hides every saved secret in text the board stores or shows (as `***`). */
export function maskSaved(root: string, text: string): string {
  if (!text) return text;
  let out = text;
  for (const s of savedSecrets(root)) if (out.includes(s)) out = out.split(s).join("***");
  return out;
}

/**
 * Like maskSaved, for JSON text (a line about to be written, a response): a secret shows there in its JSON-escaped
 * form, so that is what is replaced, and the JSON stays valid. Returns the text unchanged when it holds none.
 */
export function maskSavedJson(root: string, json: string): string {
  let out = json;
  for (const s of savedSecrets(root)) {
    const form = JSON.stringify(s).slice(1, -1);
    if (out.includes(form)) out = out.split(form).join("***");
  }
  return out;
}
