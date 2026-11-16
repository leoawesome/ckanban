//! The phone access listener in board mode (R13): a second loopback port (CKANBAN_REMOTE_PORT, config.json
//! `remotePort`, else the board's port + 1) that only `tailscale serve` points at, so a tailnet request can't pass as
//! local by sending `Host: localhost`. Each request is checked as a phone request (`BoardMode::handle` with
//! `Listener::Remote`: phone access on in `remote.json`, the tailnet host, the owner's Tailscale login, the tailnet
//! Origin of a change) and every answer carries `x-ckanban-listener: remote`. With board mode off the Bun daemon has
//! this listener, as before.

use std::sync::Arc;
use std::time::Duration;

use ckanban_board::gate::request::Listener;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::board_mode::BoardMode;
use crate::proxy::Proxy;
use crate::routes::Native;

pub async fn serve(listener: TcpListener, proxy: Arc<Proxy>, native: Arc<Native>, board: Arc<BoardMode>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("ckanban-rs: phone access accept: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let (proxy, native, board) = (proxy.clone(), native.clone(), board.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |mut req: hyper::Request<hyper::body::Incoming>| {
                crate::proxy::normalize_target(&mut req);
                let (proxy, native, board) = (proxy.clone(), native.clone(), board.clone());
                async move { Ok::<_, std::convert::Infallible>(board.handle(req, peer, Listener::Remote, &native, &proxy).await) }
            });
            let _ = http1::Builder::new().half_close(true).serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
        });
    }
}
