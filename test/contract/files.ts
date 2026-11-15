// Readers for the daemon's data files, written from contracts/data-files.md (no code from src/).
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

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
