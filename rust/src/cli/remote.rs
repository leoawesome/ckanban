//! `ckanban remote on|off|status` (`remoteCommand` in src/cli/cli.ts): phone access over Tailscale, with the same
//! output and exit codes. It drives `outside::phone::Phone` (the port of `RemoteAccess`), which writes `remote.json`;
//! the daemon picks that up on its next request. The listener port is `remoteListenPort` (CKANBAN_REMOTE_PORT, else
//! config.json's remotePort, else the board's port + 1).

use std::sync::Arc;

use serde_json::{Map, Value};

use super::out;
use crate::outside::phone::{Phone, default_probe, default_runner, qr_terminal};

const USAGE: &str = "usage: ckanban remote on|off|status";

fn text<'a>(st: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    st.get(k).and_then(Value::as_str)
}

/// `show(st)`: what the status says, then the address as a QR code.
fn show(st: &Map<String, Value>) {
    if st.get("enabled") != Some(&Value::Bool(true)) {
        out("Phone access is off.");
        if let Some(w) = text(st, "warning") {
            eprintln!("Warning: {w}");
        }
        return;
    }
    let url = text(st, "url").unwrap_or("");
    out(&format!("Phone access is on: {url}"));
    out(&format!("Only {} can open it, from devices on your tailnet (never public).", text(st, "allowedLogin").unwrap_or("undefined")));
    let ts = text(st, "tailscale");
    if ts == Some("stopped") || ts == Some("unavailable") {
        let what = if ts == Some("stopped") {
            format!("Tailscale is off on this Mac (state: {})", text(st, "backendState").unwrap_or("undefined"))
        } else {
            "Can't check Tailscale on this Mac".to_string()
        };
        out("");
        out(&format!("{what}: phone can't connect. Open the Tailscale app; turn on \"Launch Tailscale at login\" in its Settings."));
    }
    if let Some(p) = text(st, "serveProblem") {
        out("");
        out(&format!("The phone can't reach the board: {p}"));
    }
    out("");
    out(&qr_terminal(url));
}

pub fn run(action: Option<&str>) -> u8 {
    if !matches!(action, None | Some("on" | "off" | "status")) {
        eprintln!("{USAGE}");
        return 1;
    }
    let root = crate::settings::data_root();
    let config = std::fs::read_to_string(root.join("config.json")).ok();
    let port = crate::settings::remote_port(super::board_port(), std::env::var("CKANBAN_REMOTE_PORT").ok().as_deref(), config.as_deref());
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("ckanban: {e}");
            return 1;
        }
    };
    // The link check's log lines go to stdout, as Bun's `console.log`.
    let phone = Phone::with(root, port, default_runner(), default_probe(), Arc::new(|line: &str| out(line)));
    let r = rt.block_on(async {
        match action {
            Some("on") => phone.on().await,
            Some("off") => phone.off().await,
            _ => Ok(phone.live_status().await),
        }
    });
    match r {
        Ok(st) => {
            show(&st);
            0
        }
        Err(e) => {
            eprintln!("{}", e.message);
            1
        }
    }
}
