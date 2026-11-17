// `bun run test:contract:rust`: builds the Rust front server (rust/, release) and runs test/contract through it, so
// every contract test also checks `ckanban-rs dev` in front of the Bun daemon and `ckanban-rs` as the `ckanban` CLI
// (CKANBAN_CONTRACT_CLI), plus the parity test of the routes Rust answers itself (test/contract/rust-parity.test.ts). The MCP test (test/contract/mcp.test.ts) talks to `ckanban-rs mcp`,
// and test/contract/mcp-parity.test.ts checks it answers like Bun's `ckanban mcp`. Kept out of `bun run test`: it needs
// cargo. Extra arguments go to `bun test` (e.g. a file name).
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
// scripts/build-rust.sh: the release build (rustup's cargo, or $CARGO), signed on macOS so folder access sticks.
const build = Bun.spawnSync(["/bin/bash", join(REPO, "scripts", "build-rust.sh")], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const bin = join(REPO, "rust", "target", "release", "ckanban-rs");
const test = Bun.spawnSync([process.execPath, "test", ...(process.argv.length > 2 ? process.argv.slice(2) : ["test/contract"])], {
  cwd: REPO,
  stdout: "inherit",
  stderr: "inherit",
  // CKANBAN_PARITY_RS turns on test/contract/rust-parity.test.ts (Bun alone next to ckanban-rs, same answers).
  // CKANBAN_CONTRACT_MCP: the stdio MCP server under test is the Rust one (no tool starts Bun).
  env: {
    ...process.env, CKANBAN_CONTRACT_DAEMON: JSON.stringify([bin, "dev"]), CKANBAN_PARITY_RS: JSON.stringify([bin, "dev"]),
    CKANBAN_CONTRACT_CLI: JSON.stringify([bin]),
    CKANBAN_CONTRACT_MCP: JSON.stringify([bin, "mcp"]), CKANBAN_PARITY_MCP: JSON.stringify([bin, "mcp"]), CKANBAN_BUN: process.execPath,
  },
});
process.exit(test.exitCode ?? 1);
