// Tauri build script.
//
// Tauri 2's `externalBin` looks in `binaries/` for a per-target binary
// named `companion-server-<rust-target>.exe`. Without this script the
// developer has to manually rebuild + copy that file every time
// companion-server changes — and forgetting to means Tauri silently
// runs an old sidecar with a stale API surface (we hit this in
// development: a new endpoint returned 405 because the bundled binary
// was last copied hours earlier).
//
// On every Tauri build, copy the freshest `target/release/companion-server.exe`
// (workspace root) into `binaries/companion-server-<target>.exe`. The
// developer is responsible for `cargo build -p companion-server --release`
// before invoking the Tauri build — but at least we won't silently ship
// a stale binary if they did.

use std::path::PathBuf;

fn main() {
    sync_sidecar_binary();
    tauri_build::build()
}

fn sync_sidecar_binary() {
    // Resolve workspace root: this build.rs lives at apps/companion-tauri/.
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest.parent().and_then(|p| p.parent());
    let Some(workspace_root) = workspace_root else {
        println!("cargo:warning=could not resolve workspace root; skipping sidecar sync");
        return;
    };

    let target = std::env::var("TARGET").unwrap_or_default();
    let exe = if target.contains("windows") { ".exe" } else { "" };

    let src = workspace_root
        .join("target/release")
        .join(format!("companion-server{exe}"));
    let dst_dir = manifest.join("binaries");
    let dst = dst_dir.join(format!("companion-server-{target}{exe}"));

    // Tell cargo to re-run this script when the upstream binary changes.
    // Without this, cargo skips build.rs when nothing in companion-tauri
    // changed — which means rebuilding companion-server alone won't
    // refresh the sidecar copy. We also re-run when binaries/ changes
    // in case a developer manually swaps a build in.
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", dst_dir.display());

    if !src.exists() {
        println!(
            "cargo:warning=companion-server not built yet at {} — Tauri sidecar will use whatever is already in binaries/. Run `cargo build -p companion-server --release` first.",
            src.display()
        );
        return;
    }

    let _ = std::fs::create_dir_all(&dst_dir);
    // Skip the copy if dst is already at least as fresh as src — keeps
    // incremental rebuilds fast.
    if let (Ok(src_meta), Ok(dst_meta)) = (std::fs::metadata(&src), std::fs::metadata(&dst)) {
        if let (Ok(s), Ok(d)) = (src_meta.modified(), dst_meta.modified()) {
            if d >= s {
                return;
            }
        }
    }
    if let Err(e) = std::fs::copy(&src, &dst) {
        println!(
            "cargo:warning=failed to refresh sidecar binary {}: {e}",
            dst.display()
        );
    } else {
        println!(
            "cargo:warning=refreshed sidecar binary {} → {}",
            src.display(),
            dst.display()
        );
    }
}
