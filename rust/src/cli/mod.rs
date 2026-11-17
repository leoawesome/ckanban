//! The `ckanban` commands in Rust (contracts/cli.md), with the same arguments, output, exit codes and HTTP calls as
//! Bun's `src/cli/cli.ts`. `dev`/`start` are the front server and `mcp` alone the stdio MCP server (main.rs, mcp/). `browser-mcp` (browser_mcp/), `remote` (remote.rs,
//! on outside::phone), `artifact` (artifact.rs, on crate::artifact) and `update` (from source until P4) are Rust too:
//! no command starts Bun.

mod agents;
mod args;
mod artifact;
mod board;
mod browser_mcp;
mod http;
mod launchd;
mod remote;
mod text;

use std::io::Write;

/// `VERSION` in `src/core/version.ts`: set at release build (CKANBAN_VERSION), else "dev".
const VERSION: &str = match option_env!("CKANBAN_VERSION") {
    Some(v) => v,
    None => "dev",
};

pub const TICKET_USAGE: &str = "  ckanban profiles     List boards (profiles) and their folders
  ckanban ticket list [--status <s>] [--query <words>] [--limit <n>] [--after <id>] [--include-tool]
                       Open work (not Done) newest first, 100 at a time; --status done pages
                       through Done, --query finds tickets by words in any column (at most 100)
  ckanban ticket show <id> [--comments-before <n>]
  ckanban ticket create --title <t> [--body <md> | --body-file <f>] [--status <s>] [--mode interview|auto] [--needs <r1,r2>] [--tags <t1,t2>]
  ckanban ticket update <id> [--title <t>] [--body <md> | --body-file <f>] [--status <s>] [--mode <m>] [--needs <r1,r2>] [--tags <t1,t2>] [--show-on-board true|false]
  ckanban ticket move <id> <status>
  ckanban ticket chat <id> <message>
  ckanban ticket comment <id> <text>
  ckanban ticket stop <id>
  ckanban ticket delete <id>
  ckanban ticket setup [<board>/]<id>
                       Install a ticket's project dependencies (the board's setup command)
                       in its copy of the folder; waits until done. Runs ask for this.
  ckanban ticket take-device <name> [<name>...]
                       Inside a board run: take shared devices for this ticket just before
                       using them (all at once; waits up to 4 minutes, then call again).
  ckanban ticket release-device [<name>...]
                       Let go of them (all of this run's devices when no name is given).
  ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]
                       File a ckanban bug as a GitHub issue (with <id>: attach that
                       ticket's details and last run log). Needs gh, else prints a link.
                       Ticket commands act on the board whose folder contains the current
                       directory; --profile <slug> picks another. --json prints raw JSON.
                       --body - / --body-file - read the description from stdin.
  ckanban mcp          Run the board's MCP server on stdio (for Claude Code, Codex, ...)
  ckanban mcp install [--claude] [--codex]
                       Register the MCP server with Claude Code and/or Codex (default: both)
  ckanban mcp uninstall [--claude] [--codex]
  ckanban mcp status   Show where the MCP server is registered";

fn usage() -> String {
    format!(
        "ckanban — kanban board for Claude Code

Usage:
  ckanban dev          Run the server in the foreground
  ckanban start        Same as dev (used by launchd)
  ckanban install      Install and start the launchd background daemon (macOS)
  ckanban restart      Restart the daemon once active runs finish (after pulling or building changes)
                       --now: restart at once (cut-off replies resume after the restart)
  ckanban uninstall    Stop and remove the launchd daemon, turn off phone access and remove the MCP
                       from Claude Code and Codex (your boards stay)
  ckanban open         Open the board in your browser
  ckanban update       Update to the latest release and restart the daemon
  ckanban remote on|off|status
                       Phone access over Tailscale (tailnet only, your login only)
  ckanban artifact publish <file> [--url <artifact url>] [--title <title>]
                       Publish a page to claude.ai (works from headless board runs)
  ckanban artifact read <url> [--out <file>]
                       Save an artifact's page source to a local file
  ckanban call <service> <tool> ['<json arguments>']
                       From an automation's check script: call a tool of a service connected for automations
{TICKET_USAGE}
  ckanban --version    Print the version
"
    )
}

/// `console.log`: the text and a newline; a closed stdout is not an error.
pub fn out(s: &str) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{s}");
    let _ = o.flush();
}

/// `os.homedir()`: HOME.
pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// The board's port as the CLI finds it: CKANBAN_PORT, else config.json, else 7777.
pub fn board_port() -> u16 {
    let config = std::fs::read_to_string(crate::settings::data_root().join("config.json")).ok();
    crate::settings::board_port(std::env::var("CKANBAN_PORT").ok().as_deref(), config.as_deref())
}

/// `ckanban update`. This binary is built from source on Leo's Mac (no Rust release yet), so it says how to update
/// from source. A Rust release would add the download (the SHA256SUMS check, the swap and the restart).
fn update() -> u8 {
    out("Running from source: use `git pull && bun run build:web && scripts/build-rust.sh && ckanban restart`.");
    0
}

/// Board commands print the error alone and exit 1.
fn board_cmd(r: Result<(), String>) -> u8 {
    match r {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// Runs one command. `None`: `dev` or `start`, which main.rs runs (the front server).
pub fn run(argv: &[String]) -> Option<u8> {
    let cmd = argv.first().map(String::as_str);
    let rest = argv.get(1..).unwrap_or(&[]);
    let client = || http::Client { port: board_port() };
    Some(match cmd {
        Some("dev" | "start") => return None,
        Some("install") => launchd::install(),
        Some("restart") => launchd::restart(rest.iter().any(|a| a == "--now")),
        Some("uninstall") => launchd::uninstall(),
        Some("open") => launchd::open(),
        Some("profiles") => board_cmd(board::profiles(rest, &client())),
        Some("ticket" | "tickets") => board_cmd(board::ticket(rest, &client())),
        Some("call") => board_cmd(board::call(rest, &client())),
        Some("mcp") if !rest.is_empty() => board_cmd(agents::mcp_command(rest)),
        Some("browser-mcp") => browser_mcp::run(rest),
        Some("artifact") => artifact::run(rest),
        Some("remote") => remote::run(rest.first().map(String::as_str)),
        Some("update") => update(),
        Some("--version" | "-v" | "version") => {
            out(VERSION);
            0
        }
        _ => {
            out(&usage());
            // `cmd ? 1 : 0`: an empty first argument counts as none.
            u8::from(cmd.is_some_and(|c| !c.is_empty()))
        }
    })
}
