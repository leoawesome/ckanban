// The contract tests check the server from the outside only, so they can later check a port of it. This fails when a
// file in test/contract imports (or requires) anything from src/ or web/.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** A path that leaves test/contract for src/ or web/ (relative or absolute). */
export function reachesSource(spec: string): boolean {
  return /(^|\/)(src|web)(\/|$)/.test(spec) && (spec.startsWith(".") || spec.startsWith("/"));
}

test("contract tests import nothing from src/ or web/", () => {
  const dir = import.meta.dir;
  const bad: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!/\.(ts|tsx|js|mjs)$/.test(f)) continue;
    for (const s of specifiers(readFileSync(join(dir, f), "utf8"))) if (reachesSource(s)) bad.push(`${f}: ${s}`);
  }
  expect(bad).toEqual([]);
});

test("the import check catches source imports", () => {
  // Built from pieces so this file's own text doesn't trip the check above.
  const imp = "import";
  const sample = [
    `${imp} { Store } from "../../src/server/store";`, `const x = await ${imp}("../../web/src/App");`,
    `const y = ${"require"}("/abs/src/cli.ts");`, `${imp} { join } from "node:path";`, `${imp} { startDaemon } from "./daemon";`,
  ].join("\n");
  expect(specifiers(sample).filter(reachesSource)).toEqual(["../../src/server/store", "../../web/src/App", "/abs/src/cli.ts"]);
});
