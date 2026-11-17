//! `ckanban-rs`: the ckanban server and CLI. `ckanban-rs dev` (and `start`) is the board's daemon: it listens on the
//! board's port (and the phone access port), runs the board (board_mode.rs, the `ckanban-board` crate), answers usage,
//! spend, passes and agents (routes.rs) and serves the built web page (web.rs). `ckanban-rs mcp` is the stdio MCP
//! server (mcp/); every other command is in cli/. Bun's server was removed in P4: Bun only builds the web page.

mod agents;
mod artifact;
mod board_mode;
mod cli;
mod guard;
mod js;
mod mask;
mod mcp;
mod outside;
mod passes;
mod phone;
mod routes;
mod settings;
mod web;

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `ckanban-rs mcp`: the board's stdio MCP server (src/mcp/, the port of `ckanban mcp`).
    if args.len() == 1 && args[0] == "mcp" {
        return mcp::main();
    }
    // Every other `ckanban` command but `dev`/`start` (the front server below) lives in cli/.
    if let Some(code) = cli::run(&args) {
        return ExitCode::from(code);
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("ckanban-rs: {e}");
            return ExitCode::from(1);
        }
    };
    let code = rt.block_on(dev());
    // Open tunnels and in-flight requests end with the process.
    rt.shutdown_timeout(Duration::from_millis(200));
    ExitCode::from(code)
}

fn fail(msg: impl std::fmt::Display) -> u8 {
    eprintln!("ckanban-rs: {msg}");
    1
}

async fn dev() -> u8 {
    let root = settings::data_root();
    let config = std::fs::read_to_string(root.join("config.json")).ok();
    let env_port = std::env::var("CKANBAN_PORT").ok();
    let public_port = settings::board_port(env_port.as_deref(), config.as_deref());
    let remote_port = settings::remote_port(public_port, std::env::var("CKANBAN_REMOTE_PORT").ok().as_deref(), config.as_deref());

    let exe = std::env::current_exe().unwrap_or_default();
    let env_repo = std::env::var_os("CKANBAN_REPO").filter(|s| !s.is_empty()).map(PathBuf::from);
    // The web page is served from the source folder's `web/dist`; without one the board still runs (the page says
    // how to build it).
    let web_dir = match settings::repo_root(env_repo.as_deref(), &exe) {
        Ok(r) => settings::web_dir(&r),
        Err(e) => {
            eprintln!("ckanban-rs: {e}; the web page can't be served");
            PathBuf::from("/nonexistent/web/dist")
        }
    };
    let web = web::Web::new(web_dir);
    if !web.built() {
        eprintln!("web UI not built yet: run `bun run build:web` ({} is missing)", web.dir().join("index.html").display());
    }

    // The board's port first: if it is taken, fail before starting anything.
    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, public_port)).await {
        Ok(l) => l,
        Err(e) => return fail(format!("can't listen on 127.0.0.1:{public_port}: {e}")),
    };
    // The board (board_mode.rs): the data folder's lock, the core, runs, the helper, schedules.
    let board = match board_mode::prepare(&root, public_port, remote_port).await {
        Ok(b) => b,
        Err(e) => return fail(format!("the board can't start: {e}")),
    };
    // The phone access listener; a busy port only costs phone access.
    let phone = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, remote_port)).await {
        Ok(l) => Some(l),
        Err(e) => {
            eprintln!("ckanban-rs: phone access listener on 127.0.0.1:{remote_port} failed: {e}");
            None
        }
    };

    // The UI hears of a change to the passes file (Bun's `integration.updated`).
    let bus = board.core.bus.clone();
    let notify: passes::Notify = Arc::new(move |file: &str| {
        if file == "automation-passes.json" {
            bus.emit_json(serde_json::json!({ "type": "integration.updated" }));
        }
    });
    board.connect_passes(notify.clone());
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
    eprintln!("ckanban-rs {} listening on http://localhost:{public_port}", env!("CARGO_PKG_VERSION"));

    // P2: the outside services (MCP servers, passes and sign-ins, phone access, agents, bug reports).
    board.connect_outside(notify.clone());
    let native = routes::Native::new(root.clone(), public_port, notify);
    // P1c: Telegram and the front desk (held requests are replayed through these routes).
    board.connect_telegram();
    let phone_accept = phone.map(|l| tokio::spawn(phone::serve(l, web.clone(), native.clone(), board.clone())));
    let accept = tokio::spawn(serve(listener, web, native, board.clone()));
    // A restart the board asked for (`POST /api/restart`, once its work is done) ends this process like a SIGTERM;
    // launchd starts it again.
    let exit = board.exit.clone();
    tokio::select! {
        _ = sigterm.recv() => {}
        _ = sigint.recv() => {}
        _ = exit.notified() => eprintln!("ckanban-rs: restarting"),
    }
    // Runs stop first (marked so the next start resumes them).
    board.shutdown().await;
    accept.abort();
    if let Some(p) = phone_accept {
        p.abort();
    }
    board.stop(0);
    0
}

async fn serve(listener: TcpListener, web: Arc<web::Web>, native: Arc<routes::Native>, board: Arc<board_mode::BoardMode>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("ckanban-rs: accept: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let (web, native, board) = (web.clone(), native.clone(), board.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |mut req: hyper::Request<hyper::body::Incoming>| {
                let (web, native, board) = (web.clone(), native.clone(), board.clone());
                // Route on the path Bun's `new URL` would see (dot segments resolved).
                web::normalize_target(&mut req);
                async move { Ok::<_, std::convert::Infallible>(board.handle(req, peer, ckanban_board::gate::request::Listener::Local, &native, &web).await) }
            });
            let _ = http1::Builder::new().half_close(true).serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
        });
    }
}
