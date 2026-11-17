#!/usr/bin/env bun
// Builds the release binaries: the web page, then the Rust server `ckanban-rs` for each Mac chip with the page built
// in (cargo feature `embed-web`, see rust/build.rs) and the release version set (CKANBAN_VERSION).
// Usage: bun scripts/build-bin.ts [version] [--arch arm64|x64]   → dist/ckanban-darwin-arm64, dist/ckanban-darwin-x64
// Signing happens in release.yml; this leaves the linker's ad-hoc signature. Nothing it writes is in version history
// (dist/ and rust/target/ are ignored; the page's file table is generated inside rust/target/).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const archFlag = args.indexOf("--arch");
const only = archFlag >= 0 ? args[archFlag + 1] : undefined;
const positional = args.filter((_, i) => i !== archFlag && i !== archFlag + 1);
const version = (positional[0] ?? process.env.CKANBAN_VERSION ?? "dev").replace(/^v/, "");

const TARGETS: Record<string, string> = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };
if (archFlag >= 0 && !only) throw new Error("--arch needs arm64 or x64");
if (only && !TARGETS[only]) throw new Error(`unknown --arch ${only} (arm64 or x64)`);
const cargoHome = join(homedir(), ".cargo", "bin", "cargo");
const cargo = process.env.CARGO || (existsSync(cargoHome) ? cargoHome : "cargo");

async function sh(cmd: string[], cwd = root, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if ((await p.exited) !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

// The web page's typecheck uses the root's packages too.
await sh(["bun", "install", "--frozen-lockfile"]);
await sh(["bun", "install", "--frozen-lockfile"], join(root, "web"));
await sh(["bun", "run", "build"], join(root, "web"));

mkdirSync(join(root, "dist"), { recursive: true });
for (const [arch, triple] of Object.entries(TARGETS)) {
  if (only && arch !== only) continue;
  // --target keeps these apart from rust/target/release/ckanban-rs, the build from source the daemon may be running.
  await sh([cargo, "build", "--release", "--locked", "--features", "embed-web", "--target", triple, "--bin", "ckanban-rs"], join(root, "rust"), {
    CKANBAN_VERSION: version,
    CKANBAN_WEB_DIST: join(root, "web", "dist"),
    // No compile cache (sccache): it doesn't count CKANBAN_VERSION, so a cached "dev" build could come back.
    RUSTC_WRAPPER: "",
  });
  const out = join(root, "dist", `ckanban-darwin-${arch}`);
  copyFileSync(join(root, "rust", "target", triple, "release", "ckanban-rs"), out);
  if (arch === (process.arch === "arm64" ? "arm64" : "x64")) {
    const got = Bun.spawnSync([out, "--version"]).stdout.toString().trim();
    if (got !== version) throw new Error(`${relative(root, out)} reports version ${got}, not ${version}`);
  }
  console.log(`built ${relative(root, out)} (v${version})`);
}
