//! With the `embed-web` feature (release builds, `scripts/build-bin.ts`), the built web page (`web/dist`, or
//! `CKANBAN_WEB_DIST`) goes into the binary: this writes `$OUT_DIR/web_assets.rs`, a table of every file's path and
//! `include_bytes!`. Without the feature the table is empty and `web.rs` serves `web/dist` from the source folder, so
//! `bun run build:web && ckanban restart` keeps working. The generated file lives in `target/`, never in the repo.

use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("can't read {}: {e}", dir.display()))
        .map(|e| e.expect("directory entry").path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk(&p, out);
        } else if p.is_file() {
            out.push(p);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=CKANBAN_WEB_DIST");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("web_assets.rs");
    let mut code = String::from("pub static WEB_ASSETS: &[(&str, &[u8])] = &[\n");
    if std::env::var_os("CARGO_FEATURE_EMBED_WEB").is_some() {
        let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
        let dist = std::env::var_os("CKANBAN_WEB_DIST")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest.join("..").join("web").join("dist"));
        let dist = dist.canonicalize().unwrap_or_else(|_| panic!("embed-web: {} is missing; run `bun run build:web` first", dist.display()));
        assert!(dist.join("index.html").is_file(), "embed-web: {} has no index.html; run `bun run build:web` first", dist.display());
        println!("cargo:rerun-if-changed={}", dist.display());
        let mut files = Vec::new();
        walk(&dist, &mut files);
        for f in files {
            let rel = f.strip_prefix(&dist).expect("inside dist");
            let url: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let url = format!("/{}", url.join("/"));
            code.push_str(&format!("    ({url:?}, include_bytes!({:?})),\n", f.to_string_lossy()));
        }
    }
    code.push_str("];\n");
    std::fs::write(&out, code).expect("write web_assets.rs");
}
