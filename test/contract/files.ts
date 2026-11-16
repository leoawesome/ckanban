// Readers for the daemon's data files, written from contracts/data-files.md (no code from src/).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

const CONTRACTS = resolve(import.meta.dir, "..", "..", "contracts");

/** ticket.md: `---\n<YAML front matter>---\n<body>`. */
export function parseTicketFile(raw: string): { meta: Record<string, any>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("ticket.md has no front matter");
  return { meta: YAML.parse(m[1]), body: m[2] ?? "" };
}

/** A JSONL file: one JSON object per line (missing file: no lines). */
export function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The path patterns in data-files.md's ```paths block: `<slug>`-style parts match one path segment, `**` any. */
export function documentedPaths(): RegExp[] {
  const md = readFileSync(join(CONTRACTS, "data-files.md"), "utf8");
  const block = md.match(/```paths\n([\s\S]*?)\n```/);
  if (!block) throw new Error("contracts/data-files.md has no ```paths block");
  return block[1].split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((p) => {
    const re = p.split("/").map((seg) => seg === "**" ? "(?:.+)" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>/g, "[^/]+").replace(/\*/g, "[^/]*")).join("/");
    return new RegExp(`^${re}$`);
  });
}

/** Every file under `dir`, as paths relative to it. */
export function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as any[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)));
}
