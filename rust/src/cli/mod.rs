//! The `ckanban` commands in Rust (contracts/cli.md), with the same arguments, output, exit codes and HTTP calls as
//! Bun's `src/cli/cli.ts`. `dev`/`start` are the front server and `mcp` alone the stdio MCP server (main.rs, mcp/). A few commands stay on Bun for now and are
//! handed to `bun src/cli.ts` with the same arguments (the process is replaced, so input, output and exit code are
//! Bun's own): `browser-mcp` (drives a board browser), `artifact` (a
//! Claude Code session in a pty), `remote` (Tailscale) and `update` (the release binary is still Bun's).

mod agents;
mod args;
mod board;
mod http;
mod launchd;
mod text;

use std::io::Write;
use std::os::unix::process::CommandExt;
use std::process::Command;

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

/// `bun <repo>/src/cli.ts <args>`, found as `ckanban-rs dev` finds them.
pub fn bun_command(args: &[String]) -> Result<Command, String> {
    let exe = std::env::current_exe().unwrap_or_default();
    let env_repo = std::env::var_os("CKANBAN_REPO").filter(|s| !s.is_empty()).map(std::path::PathBuf::from);
    let repo = crate::settings::repo_root(env_repo.as_deref(), &exe)?;
    let bun = crate::settings::bun_path()?;
    let mut c = Command::new(bun);
    c.arg(repo.join("src/cli.ts")).args(args);
    Ok(c)
}

/// Hands the whole command to Bun: this process becomes it. Returns only when that fails.
fn to_bun(args: &[String]) -> u8 {
    match bun_command(args) {
        Ok(mut c) => {
            let e = c.exec();
            eprintln!("ckanban: can't start bun: {e}");
        }
        Err(e) => eprintln!("ckanban: {e}"),
    }
    1
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
        Some("browser-mcp") => to_bun(argv),
        Some("artifact") => to_bun(argv),
        Some("remote") => to_bun(argv),
        Some("update") => to_bun(argv),
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
