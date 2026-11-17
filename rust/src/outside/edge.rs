//! What the Rust board asked of the Bun satellite (`ckanban_board::api::Satellite`) and P2 now does itself: the
//! automations' pass calls (`signin::SignIn::pass_call`) and the Share menu's publishing (the board's `Publisher`,
//! which runs `ckanban artifact publish-output` until P3 ports that command). The helper's calls (Telegram's turn
//! end, the front desk gate) still go to the satellite until P1 moves the helper.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ckanban_board::api::{Failure, Satellite};
use ckanban_board::git::publish::Publisher;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::signin::SignIn;

/// How long one publish may take (Bun's helper gives up well before: it takes a minute or two).
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct OutsideSatellite {
    inner: Arc<dyn Satellite>,
    /// Set once the outside services are up (`BoardMode::connect_outside`); until then the satellite answers.
    pub signin: OnceLock<Arc<SignIn>>,
    pub publisher: OnceLock<Arc<Publisher>>,
}

impl OutsideSatellite {
    pub fn new(inner: Arc<dyn Satellite>) -> Arc<Self> {
        Arc::new(OutsideSatellite { inner, signin: OnceLock::new(), publisher: OnceLock::new() })
    }
}

impl Satellite for OutsideSatellite {
    fn turn_ended(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>> {
        self.inner.turn_ended(slug, id, text)
    }
    fn pass_call(&self, body: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        match self.signin.get() {
            Some(s) => {
                let s = s.clone();
                Box::pin(async move { Ok(s.pass_call(body).await) })
            }
            None => self.inner.pass_call(body),
        }
    }
    fn frontdesk_gate(&self, request: Value) -> BoxFuture<'_, Result<Option<Value>, Failure>> {
        self.inner.frontdesk_gate(request)
    }
    fn publish_artifact(&self, request: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        self.inner.publish_artifact(request)
    }
    fn share_jobs(&self, slug: &str, id: &str) -> Vec<Value> {
        self.publisher.get().map(|p| p.jobs(slug, id)).unwrap_or_default()
    }
}

/// The publishing step of the Share menu: `<this exe> artifact publish-output <file> --name <name> [--url <link>]`
/// (cli/artifact.rs), whose one line of output is Bun's `ArtifactOutcome`.
pub fn publish_run(exe: PathBuf) -> ckanban_board::git::publish::PublishRun {
    Arc::new(move |ask: Value| {
        let exe = exe.clone();
        Box::pin(async move {
            let s = |k: &str| ask.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let mut cmd = tokio::process::Command::new(&exe);
            cmd.arg("artifact").arg("publish-output").arg(s("file")).arg("--name").arg(s("name"));
            if let Some(u) = ask.get("url").and_then(Value::as_str) {
                cmd.arg("--url").arg(u);
            }
            // Not the board's own child markers: the helper is a top-level Claude (`helperEnv` drops the rest).
            cmd.env_remove("CKANBAN_SATELLITE").env_remove("CKANBAN_SATELLITE_EDGE");
            // Its own process group, so a timeout ends it and what it started. Not killed on drop: the timeout below
            // sends SIGTERM first, so the helper can stop the Claude it runs on its own terminal.
            cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
            let child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => return json!({ "ok": false, "error": format!("couldn't start the publishing helper: {e}") }),
            };
            let pid = child.id();
            let out = match tokio::time::timeout(PUBLISH_TIMEOUT, child.wait_with_output()).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => return json!({ "ok": false, "error": format!("the publishing helper failed: {e}") }),
                Err(_) => {
                    if let Some(pid) = pid {
                        // SIGTERM first: the helper then stops the Claude it started on its own terminal (another
                        // session, outside this group); SIGKILL the group 2s later.
                        // SAFETY: signals to the process group this server started for the helper.
                        unsafe {
                            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
                        }
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        // SAFETY: as above.
                        unsafe {
                            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                        }
                    }
                    return json!({ "ok": false, "error": "publishing took too long" });
                }
            };
            let text = String::from_utf8_lossy(&out.stdout);
            match text.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok().filter(Value::is_object)) {
                Some(v) => v,
                None => {
                    let err = String::from_utf8_lossy(&out.stderr);
                    let last = err.trim().lines().last().unwrap_or("").to_string();
                    json!({ "ok": false, "error": if last.is_empty() { "the publishing helper gave no answer".to_string() } else { last } })
                }
            }
        })
    })
}
