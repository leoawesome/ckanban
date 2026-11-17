// Outside-in contract for the `ckanban` commands that manage the daemon and the machine: usage, version, install
// (the launchd plist byte for byte), restart, uninstall, open, update, start, remote status, mcp install/uninstall/status
// and the usage errors of artifact and browser-mcp. See contracts/cli.md sections 1, 2 and 4.
//
// Everything runs in a sandbox (cli-support.ts): temp HOME, stub launchctl/open/claude first on PATH. Each test that
// could reach launchctl first checks that the stub is the one PATH finds, so a broken sandbox fails instead of
// touching the real LaunchAgents folder.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_CMD, startDaemon } from "./daemon";
import { CLI_FROM_SOURCE, contractBlock, type FakeBoard, fakeBoard, type Sandbox, sandbox } from "./cli-support";

// Each test runs the CLI several times; one start takes seconds on a busy Mac.
setDefaultTimeout(60_000);

const UID = process.getuid!();
const JOB = `gui/${UID}/io.ckanban.daemon`;
/** The command `ckanban mcp` and the plist run: this very CLI (its argv), plus `mcp` or `start`. */
const SERVER_ARGV = [...CLI_CMD, "mcp"];

let sb: Sandbox;
let fb: FakeBoard;

beforeAll(() => {
  // `&`, `<` and `>` in the home folder's path: the plist must escape them.
  sb = sandbox("ck-cli-a&b<c>-");
  fb = fakeBoard();
});

afterAll(() => {
  fb?.stop();
  sb?.cleanup();
});

/** Refuses to go on unless launchctl and open are the sandbox's stubs and HOME is the temp one. */
function assertSandboxed() {
  for (const name of ["launchctl", "open", "osascript"]) {
    expect(Bun.which(name, { PATH: sb.env.PATH })).toBe(join(sb.bin, name));
  }
  expect(sb.env.HOME.startsWith(sb.root)).toBe(true);
  expect(sb.env.HOME).not.toBe(process.env.HOME);
}

const newCalls = (before: number) => sb.calls().slice(before);
const plistPath = () => join(sb.home, "Library", "LaunchAgents", "io.ckanban.daemon.plist");

describe("dispatch", () => {
  test("no command prints the usage text from the contract and exits 0; an unknown one exits 1", async () => {
    const ticketUsage = contractBlock("### Ticket usage block");
    const usage = contractBlock("### Usage text").replace("${TICKET_USAGE}", ticketUsage);
    const none = await sb.run([]);
    expect(none).toEqual({ code: 0, stdout: usage + "\n", stderr: "" });
    for (const arg of ["bogus", "--help", "-h"]) {
      const r = await sb.run([arg]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe(usage + "\n");
    }
  });

  test("--version, -v and version print the version", async () => {
    for (const arg of ["--version", "-v", "version"]) {
      const r = await sb.run([arg]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      if (CLI_FROM_SOURCE) expect(r.stdout).toBe("dev\n");
      else expect(r.stdout).toMatch(/^(dev|\d+\.\d+\.\d+\S*)\n$/);
    }
  });
});

describe("install", () => {
  test("writes the plist from the contract byte for byte, then bootout, print, bootstrap", async () => {
    assertSandboxed();
    const data = join(sb.root, "data-new", "nested");
    const before = sb.calls().length;
    // An empty entry and a repeat: both dropped from the plist's PATH.
    const PATH = `${sb.bin}::/usr/bin:/bin:/usr/bin`;
    const r = await sb.run(["install"], { env: { CKANBAN_PORT: "7799", CKANBAN_HOME: data, PATH } });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Installed ${plistPath()}\nBoard: http://localhost:7799\nLogs: ${join(data, "daemon.log")}\n`);
    expect(existsSync(data)).toBe(true);
    expect(newCalls(before)).toEqual([`launchctl bootout ${JOB}`, `launchctl print ${JOB}`, `launchctl bootstrap gui/${UID} ${plistPath()}`]);

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const wantPath = [sb.bin, "/usr/bin", "/bin", join(sb.home, ".local/bin"), join(sb.home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
    const want = contractBlock("The plist (`plistXml`")
      .replace("    <string>{ARG}</string>", CLI_CMD.map((a) => `    <string>${esc(a)}</string>`).join("\n"))
      .replace("{PATH}", esc(wantPath))
      .replace("{HOME}", esc(sb.home))
      .replaceAll("{LOG}", esc(join(data, "daemon.log"))) + "\n";
    expect(want).toContain("&amp;");
    expect(readFileSync(plistPath(), "utf8")).toBe(want);
  });

  test("bootstrap failing five times: stderr, its exit code, the plist stays", async () => {
    assertSandboxed();
    const before = sb.calls().length;
    const r = await sb.run(["install"], { env: { LAUNCHCTL_BOOTSTRAP: "5" } });
    expect(r.code).toBe(5);
    expect(r.stderr).toBe("launchctl bootstrap failed\n");
    expect(r.stdout).toBe("");
    expect(newCalls(before).filter((l) => l.startsWith("launchctl bootstrap"))).toHaveLength(5);
    expect(existsSync(plistPath())).toBe(true);
  }, 20_000);
});

describe("restart", () => {
  const board = () => `http://localhost:${fb.port}`;
  const run = (args: string[], env: Record<string, string> = {}) => sb.run(["restart", ...args], { env: { CKANBAN_PORT: String(fb.port), LAUNCHCTL_PRINT: "0", ...env } });

  test("not installed: exit 1, nothing asked", async () => {
    assertSandboxed();
    fb.reset(() => ({ json: { running: 0 } }));
    const r = await run([], { LAUNCHCTL_PRINT: "113" });
    expect(r).toEqual({ code: 1, stdout: "", stderr: "daemon not installed; run: ckanban install\n" });
    expect(fb.seen).toEqual([]);
  });

  test("asks the daemon with POST /api/restart and reports what it says", async () => {
    assertSandboxed();
    fb.reset(() => ({ json: { running: 0 } }));
    const before = sb.calls().length;
    const r = await run([]);
    expect(r).toEqual({ code: 0, stdout: `Restarting. Board: ${board()}\n`, stderr: "" });
    expect(fb.seen).toHaveLength(1);
    const req = fb.seen[0];
    expect(req).toMatchObject({ method: "POST", path: "/api/restart", body: {} });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers.host).toBe(`localhost:${fb.port}`);
    expect(req.headers.origin).toBeUndefined();
    expect(newCalls(before)).toEqual([`launchctl print ${JOB}`]);

    for (const [n, word] of [[1, "run"], [3, "runs"]] as const) {
      fb.reset(() => ({ json: { running: n } }));
      const p = await run([]);
      expect(p.code).toBe(0);
      expect(p.stdout).toBe(`Restart pending: waiting for ${n} active ${word} to finish (at most 2 min).
New runs, huddle wakes and Planning interviews start after the restart; your chat messages are answered as usual. Use \`ckanban restart --now\` to restart at once.\n`);
    }
  });

  test("daemon can't be asked (error answer or down) or --now: kickstart -k", async () => {
    assertSandboxed();
    fb.reset(() => ({ status: 500, json: { error: "x" } }));
    let before = sb.calls().length;
    let r = await run([]);
    expect(r).toEqual({ code: 0, stdout: `Restarted. Board: ${board()}\n`, stderr: "" });
    expect(newCalls(before)).toEqual([`launchctl print ${JOB}`, `launchctl kickstart -k ${JOB}`]);

    before = sb.calls().length;
    r = await sb.run(["restart"], { env: { CKANBAN_PORT: "9", LAUNCHCTL_PRINT: "0" } });
    expect(r).toEqual({ code: 0, stdout: "Restarted. Board: http://localhost:9\n", stderr: "" });
    expect(newCalls(before)).toEqual([`launchctl print ${JOB}`, `launchctl kickstart -k ${JOB}`]);

    fb.reset(() => ({ json: { running: 2 } }));
    r = await run(["--now"]);
    expect(r.stdout).toBe(`Restarted. Board: ${board()}\n`);
    expect(fb.seen).toEqual([]);
    // --now anywhere in the arguments.
    r = await sb.run(["restart", "x", "--now"], { env: { CKANBAN_PORT: String(fb.port), LAUNCHCTL_PRINT: "0" } });
    expect(r.stdout).toBe(`Restarted. Board: ${board()}\n`);
    expect(fb.seen).toEqual([]);
  });

  test("kickstart failing passes its exit code through", async () => {
    assertSandboxed();
    const r = await run(["--now"], { LAUNCHCTL_KICKSTART: "7" });
    expect(r).toEqual({ code: 7, stdout: "", stderr: "" });
  });
});

describe("open and update", () => {
  test("open runs `open http://localhost:<port>` and exits 0 whatever open returns", async () => {
    assertSandboxed();
    for (const exit of ["0", "3"]) {
      const before = sb.calls().length;
      const r = await sb.run(["open"], { env: { CKANBAN_PORT: "7799", OPEN_EXIT: exit } });
      expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(newCalls(before)).toEqual(["open http://localhost:7799"]);
    }
  });

  // The Rust CLI (ckanban-rs) is built from source too until the release binary is Rust (P4).
  test.skipIf(!CLI_FROM_SOURCE && !CLI_CMD[0].endsWith("ckanban-rs"))("update from source only says how to update", async () => {
    const r = await sb.run(["update"]);
    expect(r).toEqual({ code: 0, stdout: "Running from source: use `git pull && bun install && bun run build:web && ckanban restart`.\n", stderr: "" });
  });
});

describe("remote (status only: on and off drive Tailscale)", () => {
  test("no remote.json, or a disabled one: off; a bad action: usage", async () => {
    for (const args of [["remote"], ["remote", "status"]]) {
      expect(await sb.run(args)).toEqual({ code: 0, stdout: "Phone access is off.\n", stderr: "" });
    }
    const data = join(sb.root, "data-remote");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "remote.json"), JSON.stringify({ enabled: false, host: "mac.tail.ts.net", allowedLogin: "me@example.com", updatedAt: "" }));
    expect(await sb.run(["remote", "status"], { env: { CKANBAN_HOME: data } })).toEqual({ code: 0, stdout: "Phone access is off.\n", stderr: "" });
    expect(await sb.run(["remote", "sideways"])).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban remote on|off|status\n" });
    // Nothing called Tailscale.
    expect(sb.calls().filter((l) => l.startsWith("tailscale"))).toEqual([]);
  });
});

describe("mcp install, uninstall, status", () => {
  const claudeJson = () => join(sb.claudeDir, ".claude.json");
  const codexToml = () => join(sb.codexDir, "config.toml");
  const argvText = SERVER_ARGV.join(" ");
  const block = `[mcp_servers.ckanban]\ncommand = ${JSON.stringify(SERVER_ARGV[0])}\nargs = ${JSON.stringify(SERVER_ARGV.slice(1)).replace(/","/g, '", "')}\n`;

  test("status with nothing registered", async () => {
    const r = await sb.run(["mcp", "status"]);
    expect(r).toEqual({
      code: 0,
      stdout: `Claude Code: not registered  [${claudeJson()}]\nCodex: not registered (CLI not found)  [${codexToml()}]\n`,
      stderr: "",
    });
  });

  test("install registers with `claude mcp add` and writes the Codex block from the contract", async () => {
    const before = sb.calls().length;
    const r = await sb.run(["mcp", "install"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Claude Code: registered "ckanban" → ${argvText}\nCodex: registered "ckanban" → ${argvText}\n`);
    expect(newCalls(before)).toEqual([`claude mcp add --scope user ckanban -- ${argvText}`]);
    const want = contractBlock("Values are JSON strings")
      .replace(`"<serverArgv[0]>"`, JSON.stringify(SERVER_ARGV[0]))
      .replace(`["<serverArgv[1]>", "mcp"]`, JSON.stringify(SERVER_ARGV.slice(1)).replace(/","/g, '", "')) + "\n";
    expect(readFileSync(codexToml(), "utf8")).toBe(want);
    expect(want).toBe(block);

    // Codex is now registered; Claude Code is too once its config says so (the stub claude doesn't write it).
    writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { ckanban: { command: SERVER_ARGV[0], args: SERVER_ARGV.slice(1) } } }));
    const st = await sb.run(["mcp", "status"]);
    expect(st.stdout).toBe(`Claude Code: registered  [${claudeJson()}]\nCodex: registered  [${codexToml()}]\n`);

    // Already current: no claude call, the Codex file unchanged.
    const again = sb.calls().length;
    expect((await sb.run(["mcp", "install"])).code).toBe(0);
    expect(newCalls(again)).toEqual([]);
    expect(readFileSync(codexToml(), "utf8")).toBe(block);
  });

  test("another command registered: status says so; install removes then adds; Codex keeps the rest of the file", async () => {
    writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { ckanban: { command: "/old/ckanban", args: ["mcp"] } } }));
    writeFileSync(codexToml(), `model = "o3"\n\n[mcp_servers.ckanban]\ncommand = "/old/ckanban"\nargs = ["mcp"]\n\n[mcp_servers.ckanban.env]\nX = "1"\n\n[other]\nx = 1\n`);
    const st = await sb.run(["mcp", "status"]);
    expect(st.stdout).toBe(
      `Claude Code: registered with another command (/old/ckanban mcp)  [${claudeJson()}]\nCodex: registered with another command (/old/ckanban mcp)  [${codexToml()}]\n`,
    );
    const before = sb.calls().length;
    expect((await sb.run(["mcp", "install"])).code).toBe(0);
    expect(newCalls(before)).toEqual(["claude mcp remove ckanban --scope user", `claude mcp add --scope user ckanban -- ${argvText}`]);
    expect(readFileSync(codexToml(), "utf8")).toBe(`model = "o3"\n\n[other]\nx = 1\n\n${block}`);
  });

  test("uninstall --codex / --claude act on that agent only", async () => {
    let before = sb.calls().length;
    let r = await sb.run(["mcp", "uninstall", "--codex"]);
    expect(r).toEqual({ code: 0, stdout: `Codex: removed "ckanban"\n`, stderr: "" });
    expect(newCalls(before)).toEqual([]);
    expect(readFileSync(codexToml(), "utf8")).toBe(`model = "o3"\n\n[other]\nx = 1\n`);

    before = sb.calls().length;
    r = await sb.run(["mcp", "uninstall", "--claude"]);
    expect(r).toEqual({ code: 0, stdout: `Claude Code: removed "ckanban"\n`, stderr: "" });
    expect(newCalls(before)).toEqual(["claude mcp remove ckanban --scope user"]);

    // No entry: nothing to run, the same line.
    writeFileSync(claudeJson(), "{}");
    before = sb.calls().length;
    r = await sb.run(["mcp", "uninstall", "--claude"]);
    expect(r.stdout).toBe(`Claude Code: removed "ckanban"\n`);
    expect(newCalls(before)).toEqual([]);
  });

  test("errors: Claude CLI missing, claude failing, unknown action", async () => {
    const missing = join(sb.root, "no-such-claude");
    let r = await sb.run(["mcp", "install", "--claude"], { env: { CKANBAN_CLAUDE_BIN: missing } });
    expect(r).toEqual({ code: 1, stdout: "", stderr: `Claude CLI not found (${missing}). Is Claude Code installed and on PATH?\n` });
    const st = await sb.run(["mcp", "status"], { env: { CKANBAN_CLAUDE_BIN: missing } });
    expect(st.stdout.split("\n")[0]).toBe(`Claude Code: not registered (CLI not found)  [${claudeJson()}]`);

    r = await sb.run(["mcp", "install", "--claude"], { env: { CLAUDE_EXIT: "1", CLAUDE_STDERR: "one\ntwo\nthree\nfour" } });
    expect(r).toEqual({ code: 1, stdout: "", stderr: "claude mcp add failed: two\nthree\nfour\n" });

    const usage = contractBlock("### Ticket usage block").split("\n").filter((l) => /ckanban mcp|^\s{20,}Register/.test(l));
    expect(usage).toHaveLength(5);
    for (const args of [["mcp", "bogus"], ["mcp", "--json"]]) {
      expect(await sb.run(args)).toEqual({ code: 1, stdout: "", stderr: `usage:\n${usage.join("\n")}\n` });
    }
  });
});

describe("uninstall", () => {
  test("removes the MCP entries, boots the job out, deletes the plist, keeps the boards", async () => {
    assertSandboxed();
    mkdirSync(join(sb.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), "<plist/>");
    writeFileSync(join(sb.data, "keep.txt"), "board data");
    writeFileSync(join(sb.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { ckanban: { command: "/x", args: ["mcp"] } } }));
    writeFileSync(join(sb.codexDir, "config.toml"), `[other]\nx = 1\n\n[mcp_servers.ckanban]\ncommand = "/x"\nargs = ["mcp"]\n`);
    const before = sb.calls().length;
    const r = await sb.run(["uninstall"]);
    expect(r).toEqual({ code: 0, stdout: "Uninstalled ckanban daemon\n", stderr: "" });
    expect(newCalls(before)).toEqual(["claude mcp remove ckanban --scope user", `launchctl bootout ${JOB}`]);
    expect(existsSync(plistPath())).toBe(false);
    expect(readFileSync(join(sb.codexDir, "config.toml"), "utf8")).toBe("[other]\nx = 1\n");
    expect(readFileSync(join(sb.data, "keep.txt"), "utf8")).toBe("board data");
  });

  test("a failing step is one line on stderr; the daemon is still removed and the exit is 0", async () => {
    assertSandboxed();
    writeFileSync(join(sb.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { ckanban: { command: "/x", args: ["mcp"] } } }));
    const before = sb.calls().length;
    const r = await sb.run(["uninstall"], { env: { CLAUDE_EXIT: "1", CLAUDE_STDERR: "boom", LAUNCHCTL_BOOTOUT: "3" } });
    expect(r).toEqual({
      code: 0,
      stdout: "Uninstalled ckanban daemon\n",
      stderr: `Couldn't remove ckanban from Claude Code (claude mcp remove failed: boom); run "ckanban mcp uninstall --claude" later.\n`,
    });
    expect(newCalls(before)).toEqual(["claude mcp remove ckanban --scope user", `launchctl bootout ${JOB}`]);
  });

  test("nothing registered (Claude CLI missing): no agent calls", async () => {
    assertSandboxed();
    writeFileSync(join(sb.claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { ckanban: { command: "/x", args: ["mcp"] } } }));
    writeFileSync(join(sb.codexDir, "config.toml"), "");
    const before = sb.calls().length;
    const r = await sb.run(["uninstall"], { env: { CKANBAN_CLAUDE_BIN: join(sb.root, "no-such-claude") } });
    expect(r).toEqual({ code: 0, stdout: "Uninstalled ckanban daemon\n", stderr: "" });
    expect(newCalls(before)).toEqual([`launchctl bootout ${JOB}`]);
  });
});

describe("usage errors that need no daemon", () => {
  test("artifact", async () => {
    const usage = "usage: ckanban artifact publish <file> [--url <artifact url>] [--title <title>]\n       ckanban artifact read <url> [--out <file>]\n";
    for (const args of [["artifact"], ["artifact", "publish"], ["artifact", "read"], ["artifact", "share", "x"]]) {
      expect(await sb.run(args)).toEqual({ code: 1, stdout: "", stderr: usage });
    }
    expect(await sb.run(["artifact", "publish", "missing.html"])).toEqual({ code: 1, stdout: "", stderr: `no such file: ${join(sb.home, "missing.html")}\n` });
  });

  test("browser-mcp without --id or --dir", async () => {
    const usage = "usage: ckanban browser-mcp --id <id> --dir <data folder> [--name <name>] [--out <folder>]\n";
    for (const args of [["browser-mcp"], ["browser-mcp", "--id", "b1"], ["browser-mcp", "--dir", tmpdir()]]) {
      expect(await sb.run(args)).toEqual({ code: 1, stdout: "", stderr: usage });
    }
  });
});

test("`ckanban start` runs the daemon in the foreground, like dev", async () => {
  const d = await startDaemon({ cmd: [...CLI_CMD, "start"] });
  try {
    expect((await d.api("GET", "/api/profiles")).status).toBe(200);
  } finally {
    await d.stop();
  }
}, 60_000);
