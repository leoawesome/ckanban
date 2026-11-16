//! `ckanban-rs`: the `ckanban` commands (cli/) and `ckanban-rs dev`, the Rust front server of the ckanban trial. It listens on the board's port, starts the Bun
//! daemon (`bun src/cli.ts dev`) as a child on an internal port. `GET /api/usage` and `GET /api/spend` are answered
//! here (routes.rs, with `ckanban-core`); every other request is passed to the child (proxy.rs).
//!
//! The child gets CKANBAN_PORT (its internal port), CKANBAN_FRONT_PORT (the board's port) and, on stdin, "<secret> <our pid>"
//! that marks this server's requests (`src/core/front.ts`). Stdin stays open: when this process dies, even killed
//! hard, the child reads end of input and stops. When the child exits, this process exits with the same code, so
//! launchd and `ckanban restart` work as with Bun alone. SIGTERM/SIGINT stop the child first.

mod agents;
mod board_mode;
mod cli;
mod guard;
mod js;
mod mask;
mod mcp;
mod passes;
mod proxy;
mod routes;
mod settings;
mod shadow;

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;
use std::process::{ExitCode, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

/// How long the Bun child gets to answer its first request.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the child gets to stop after SIGTERM before it is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

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
    let repo = match settings::repo_root(env_repo.as_deref(), &exe) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let bun = match settings::bun_path() {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    let secret = match settings::new_secret() {
        Ok(s) => s,
        Err(e) => return fail(e),
    };

    // The board's port first: if it is taken, fail before starting anything.
    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, public_port)).await {
        Ok(l) => l,
        Err(e) => return fail(format!("can't listen on 127.0.0.1:{public_port}: {e}")),
    };
    let internal_port = match settings::free_port(&[public_port, remote_port]) {
        Ok(p) => p,
        Err(e) => return fail(format!("no free internal port: {e}")),
    };
    // Board mode (board_mode.rs): off unless asked for; then the Rust board owns the board and Bun is its satellite.
    let board = board_mode::prepare(&root, public_port).await;

    let mut cmd = Command::new(&bun);
    cmd.arg(repo.join("src/cli.ts"))
        .arg("dev")
        .env("CKANBAN_PORT", internal_port.to_string())
        .env("CKANBAN_FRONT_PORT", public_port.to_string());
    if board.is_some() {
        cmd.env("CKANBAN_SATELLITE", "1");
    } else {
        cmd.env_remove("CKANBAN_SATELLITE");
    }
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return fail(format!("can't start {} {}: {e}", bun.display(), repo.join("src/cli.ts").display())),
    };
    // Kept open for the child's lifetime: its end of input tells the child this server is gone.
    let mut stdin = child.stdin.take().expect("piped stdin");
    if let Err(e) = stdin.write_all(format!("{secret} {}\n", std::process::id()).as_bytes()).await {
        let _ = child.start_kill();
        return fail(format!("can't hand the secret to the daemon: {e}"));
    }
    let _ = stdin.flush().await;
    // Later lines tell the child about files this server changed ("changed <file>"), in order, from one writer task
    // that owns stdin for the child's lifetime.
    let (tell_tx, mut tell_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let teller = tokio::spawn(async move {
        while let Some(line) = tell_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
        stdin
    });
    let tell_board = tell_tx.clone();
    let notify: passes::Notify = Arc::new(move |file: &str| {
        let _ = tell_tx.send(format!("changed {file}\n"));
    });

    let proxy = proxy::Proxy::new(internal_port, &secret);
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");

    // Wait until the child answers; meanwhile callers queue on the listener.
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            eprintln!("ckanban-rs: the daemon exited before it answered ({status})");
            return exit_code(status);
        }
        if proxy.ready(public_port).await {
            break;
        }
        if Instant::now() > deadline {
            let code = stop_child(&mut child).await;
            if let Some(b) = &board {
                b.stop(code);
            }
            return fail(format!(
                "the daemon ({} {} dev) didn't answer on 127.0.0.1:{internal_port} within {}s; see its log: this process's output{}",
                bun.display(),
                repo.join("src/cli.ts").display(),
                READY_TIMEOUT.as_secs(),
                log_hint(&root),
            ));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            _ = sigterm.recv() => return stop_board(&board, stop_child(&mut child).await),
            _ = sigint.recv() => return stop_board(&board, stop_child(&mut child).await),
        }
    }
    if let Some(b) = &board {
        b.connect_satellite(internal_port, &secret, tell_board).await;
    } else {
        drop(tell_board);
    }
    eprintln!("ckanban-rs {} listening on http://localhost:{public_port}, daemon on internal port {internal_port}", env!("CARGO_PKG_VERSION"));

    let native = routes::Native::new(root.clone(), public_port, notify, &bun, &repo);
    let shadow = shadow::prepare(&root, board.is_some());
    let accept = tokio::spawn(serve(listener, proxy, native, board.clone(), shadow));
    let code = tokio::select! {
        status = child.wait() => match status {
            Ok(s) => exit_code(s),
            Err(e) => fail(format!("lost the daemon: {e}")),
        },
        _ = sigterm.recv() => stop_child(&mut child).await,
        _ = sigint.recv() => stop_child(&mut child).await,
    };
    accept.abort();
    teller.abort();
    stop_board(&board, code)
}

/// Board mode ended with `code` (board_mode.rs): the core stops; 0 is a clean stop, anything else counts as a crash.
fn stop_board(board: &Option<Arc<board_mode::BoardMode>>, code: u8) -> u8 {
    if let Some(b) = board {
        b.stop(code);
    }
    code
}

/// Under launchd the output goes to the data folder's daemon.log.
fn log_hint(root: &std::path::Path) -> String {
    let log = root.join("daemon.log");
    if log.is_file() { format!(" ({} when started by launchd)", log.display()) } else { String::new() }
}

async fn serve(
    listener: TcpListener,
    proxy: Arc<proxy::Proxy>,
    native: Arc<routes::Native>,
    board: Option<Arc<board_mode::BoardMode>>,
    shadow: Option<Arc<ckanban_board::index::shadow::Shadow>>,
) {
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
        let proxy = proxy.clone();
        let native = native.clone();
        let board = board.clone();
        let shadow = shadow.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let proxy = proxy.clone();
                let native = native.clone();
                let board = board.clone();
                let shadow = shadow.clone();
                async move {
                    if let Some(b) = &board {
                        if let Some(res) = b.answer(&req).await {
                            return Ok(res);
                        }
                    }
                    if let Some(b) = &board
                        && let Some(res) = b.answer_sessions(&req).await
                    {
                        return Ok(res);
                    }
                    let req = match &board {
                        Some(b) => match b.answer_request(req, peer).await {
                            Ok(res) => return Ok(res),
                            Err(req) => req,
                        },
                        None => req,
                    };
                    let compare = shadow.as_ref().and_then(|_| shadow::wanted(req.method(), req.uri().path(), req.uri().query()));
                    Ok::<_, std::convert::Infallible>(match native.answer(req, peer).await {
                        Ok(res) => res,
                        Err(req) => {
                            let res = proxy.forward(req, peer).await;
                            match (&shadow, compare) {
                                (Some(s), Some((path, query))) => shadow::tee(s, path, query, res).await,
                                _ => res,
                            }
                        }
                    })
                }
            });
            let _ = http1::Builder::new().half_close(true).serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
        });
    }
}

/// SIGTERM to the child, then its exit code; SIGKILL if it doesn't stop in time.
async fn stop_child(child: &mut Child) -> u8 {
    if let Some(pid) = child.id() {
        // SAFETY: plain kill(2) on our own child's pid.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
        Ok(Ok(s)) => exit_code(s),
        _ => {
            let _ = child.kill().await;
            137
        }
    }
}

/// The child's exit code; 128 + signal when a signal ended it (as a shell reports it).
fn exit_code(s: std::process::ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt;
    match (s.code(), s.signal()) {
        (Some(c), _) => c as u8,
        (None, Some(sig)) => 128u8.wrapping_add(sig as u8),
        _ => 1,
    }
}
