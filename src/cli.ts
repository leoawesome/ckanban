#!/usr/bin/env bun
// The ckanban server, CLI and MCP server are the Rust binary `ckanban-rs` since P4 (docs/rust-port.md); Bun's own
// code is gone and Bun only builds the web page. This file only hands every `ckanban` command to that binary, so
// what still points here (an older launchd file, an MCP registration `bun src/cli.ts mcp`, `bun run dev`) keeps
// working. Point those at `rust/target/release/ckanban-rs` instead: `ckanban-rs install` and `ckanban-rs mcp install`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const bin = process.env.CKANBAN_RS || join(import.meta.dir, "..", "rust", "target", "release", "ckanban-rs");
if (!existsSync(bin)) {
  console.error(`ckanban: the Rust binary isn't built yet (${bin}). Build it with: scripts/build-rust.sh`);
  process.exit(1);
}
const child = Bun.spawn([bin, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
// launchd and `ckanban restart` stop the daemon with SIGTERM: passed on, so the binary stops its runs cleanly.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
const code = await child.exited;
process.exit(child.signalCode ? 128 + (({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[child.signalCode] ?? 0) : code);
