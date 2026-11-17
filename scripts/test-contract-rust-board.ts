// `bun run test:contract:rust-board`: the contract tests against `ckanban-rs dev` with the Rust board on
// (CKANBAN_RUST_BOARD=1, docs/rust-port-board-plan.md 3.2). Builds ckanban-rs (release), then runs each line of
// rust/board/contract-files.txt (a file in test/contract, optionally `| <test name pattern>`) as its own `bun test`;
// any listed file that fails, fails the run. Arguments run those files instead (listed or not), e.g. to see how far a
// file gets: `bun run test:contract:rust-board tickets.test.ts`. Kept out of `bun run test`: it needs cargo.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const LIST = join(REPO, "rust", "board", "contract-files.txt");

export interface Entry {
  file: string;
  pattern: string | null;
}

/** The lines of contract-files.txt: `file` or `file | pattern`; blank lines and `#` comments skipped. */
export function parseList(text: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const bar = line.indexOf("|");
    const file = (bar < 0 ? line : line.slice(0, bar)).trim();
    const pattern = bar < 0 ? null : line.slice(bar + 1).trim() || null;
    if (!/^[\w.-]+\.test\.ts$/.test(file)) throw new Error(`contract-files.txt: not a test file name: ${JSON.stringify(file)}`);
    out.push({ file, pattern });
  }
  return out;
}

if (import.meta.main) {
  // scripts/build-rust.sh: the release build (rustup's cargo, or $CARGO), signed on macOS so folder access sticks.
  const build = Bun.spawnSync(["/bin/bash", join(REPO, "scripts", "build-rust.sh")], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

  const bin = join(REPO, "rust", "target", "release", "ckanban-rs");
  const args = process.argv.slice(2);
  const entries: Entry[] = args.length ? args.map((a) => ({ file: a.replace(/^test\/contract\//, ""), pattern: null })) : parseList(readFileSync(LIST, "utf8"));
  const env = {
    ...process.env, CKANBAN_RUST_BOARD: "1", CKANBAN_CONTRACT_DAEMON: JSON.stringify([bin, "dev"]), CKANBAN_CONTRACT_CLI: JSON.stringify([bin]),
    CKANBAN_CONTRACT_MCP: JSON.stringify([bin, "mcp"]), CKANBAN_BUN: process.execPath,
    // The parity tests (rust-parity, mcp-parity, board-parity) compare ckanban-rs with Bun; without these they skip.
    CKANBAN_PARITY_RS: JSON.stringify([bin, "dev"]), CKANBAN_PARITY_MCP: JSON.stringify([bin, "mcp"]),
  };
  const failed: string[] = [];
  for (const e of entries) {
    const label = e.pattern ? `${e.file} | ${e.pattern}` : e.file;
    console.log(`\n=== ${label}`);
    const run = Bun.spawnSync([process.execPath, "test", join("test", "contract", e.file), ...(e.pattern ? ["-t", e.pattern] : [])], {
      cwd: REPO, stdout: "inherit", stderr: "inherit", env,
    });
    if (run.exitCode !== 0) failed.push(label);
  }
  console.log(failed.length ? `\nFailed in board mode: ${failed.join(", ")}` : `\nAll ${entries.length} passed in board mode.`);
  process.exit(failed.length ? 1 : 0);
}
