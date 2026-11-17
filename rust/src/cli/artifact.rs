//! `ckanban artifact publish|read|publish-output` (contracts/cli.md), as `artifact()` in src/cli/cli.ts: publishes or
//! reads a claude.ai page through the artifact helper (crate::artifact). `publish-output` is the Share menu's step: an
//! output file published as a page, the outcome printed as one JSON line (exit 0 either way).

use std::path::{Component, Path, PathBuf};

use crate::artifact::{self, Job, Options, Outcome};

use super::out;

const USAGE: &str = "usage: ckanban artifact publish <file> [--url <artifact url>] [--title <title>]\n       ckanban artifact read <url> [--out <file>]";

/// `flag(args, name)`: the argument after `name`.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// path.resolve: absolute against the working folder, `.` and `..` folded.
fn resolve(p: &str) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_default().join(p);
    let mut out = PathBuf::from("/");
    for c in base.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

fn options() -> Options {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Options { bin: env("CKANBAN_CLAUDE_BIN"), model: env("CKANBAN_ARTIFACT_MODEL"), ..Options::default() }
}

pub fn run(args: &[String]) -> u8 {
    let action = args.first().map(String::as_str);
    let target = args.get(1).map(String::as_str).filter(|t| !t.is_empty());
    let Some(target) = target else {
        eprintln!("{USAGE}");
        return 1;
    };
    artifact::stop_helpers_on_signal();
    match action {
        Some("publish-output") => {
            let file = resolve(target);
            let name = flag(args, "--name").map(str::to_string).unwrap_or_else(|| Path::new(target).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            let r = artifact::publish_output(&file, &name, flag(args, "--url").map(str::to_string), &options());
            out(&r.to_json().to_string());
            0
        }
        Some("publish") => {
            let file = resolve(target);
            if !file.exists() {
                eprintln!("no such file: {}", file.display());
                return 1;
            }
            let job = Job::Publish {
                file: file.to_string_lossy().into_owned(),
                url: flag(args, "--url").filter(|u| !u.is_empty()).map(str::to_string),
                title: flag(args, "--title").filter(|t| !t.is_empty()).map(str::to_string),
            };
            match artifact::run_job(&job, &options()) {
                // Same wording as the Artifact tool, so the board lists the page on the ticket.
                Outcome::Published { text, .. } => {
                    out(&text);
                    0
                }
                Outcome::Failed(e) => {
                    eprintln!("artifact publish failed: {e}");
                    1
                }
                Outcome::Read { .. } => 0,
            }
        }
        Some("read") => match artifact::run_job(&Job::Read { url: target.to_string() }, &options()) {
            Outcome::Read { html } => {
                let file = match flag(args, "--out") {
                    Some(o) => resolve(o),
                    None => {
                        let last = target.rsplit('/').next().unwrap_or("");
                        resolve(&std::env::temp_dir().join(format!("artifact-{last}.html")).to_string_lossy())
                    }
                };
                if let Some(dir) = file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                if let Err(e) = std::fs::write(&file, html) {
                    eprintln!("{e}");
                    return 1;
                }
                out(&format!("Saved {target} to {}", file.display()));
                0
            }
            Outcome::Failed(e) => {
                eprintln!("artifact read failed: {e}");
                1
            }
            Outcome::Published { .. } => 0,
        },
        _ => {
            eprintln!("{USAGE}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_and_paths() {
        let a: Vec<String> = ["publish", "f", "--url", "u"].iter().map(|s| s.to_string()).collect();
        assert_eq!(flag(&a, "--url"), Some("u"));
        assert_eq!(flag(&a, "--title"), None);
        assert_eq!(resolve("/a/./b/../c"), PathBuf::from("/a/c"));
    }
}
