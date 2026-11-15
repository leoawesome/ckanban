import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Dirs {
  configDir?: string;
}

export function projectsDir(d: Dirs = {}): string {
  return join(d.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

export function findSessionFile(sessionId: string, d: Dirs = {}): string | null {
  const root = projectsDir(d);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/** Every session file under the projects folder by session id (one readdir per project folder, not a stat per id). */
export function scanSessionFiles(d: Dirs = {}): Map<string, string> {
  const root = projectsDir(d);
  const out = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (!out.has(id)) out.set(id, join(root, dir, name));
    }
  }
  return out;
}

/** scanSessionFiles with its reads off the event loop, a few folders at a time. */
export async function scanSessionFilesAsync(d: Dirs = {}, batch = 16): Promise<Map<string, string>> {
  const root = projectsDir(d);
  const out = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (let i = 0; i < dirs.length; i += batch) {
    const part = dirs.slice(i, i + batch);
    const lists = await Promise.all(part.map((dir) => readdir(join(root, dir)).catch(() => [] as string[])));
    part.forEach((dir, j) => {
      for (const name of lists[j]) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -6);
        if (!out.has(id)) out.set(id, join(root, dir, name));
      }
    });
  }
  return out;
}
