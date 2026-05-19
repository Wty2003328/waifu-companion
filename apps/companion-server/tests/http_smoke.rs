//! Smoke test: launches the companion-server binary against a stub
//! companion.toml and verifies the public endpoints respond correctly.
//!
//! This is a real integration test — it spawns the actual binary as a
//! subprocess, so it covers wiring that unit tests can't reach (config
//! loading, axum route registration, sidecar startup).

use std::process::Stdio;
use std::time::Duration;

use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::time::sleep;

/// Prepare a temp companion.toml and start companion-server pointed at
/// it. Returns the child process and the bound port.
async fn boot_companion() -> (Child, u16, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let toml_path = dir.path().join("companion.toml");
    // Pick a random port by binding 0 then dropping — companion-server
    // doesn't currently support port=0 itself, so we steal a port and
    // hand it back. Tiny race window; acceptable for a smoke test.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let toml = format!(
        r#"
[zeroclaw]
url = "http://127.0.0.1:1"   # deliberately unreachable; tests don't need it

[server]
host = "127.0.0.1"
port = {port}

[avatar]
enabled = false

[pulse]
enabled = false
"#
    );
    {
        let mut f = tokio::fs::File::create(&toml_path).await.unwrap();
        f.write_all(toml.as_bytes()).await.unwrap();
        f.flush().await.unwrap();
    }

    let bin = env!("CARGO_BIN_EXE_companion-server");
    let child = Command::new(bin)
        .env("COMPANION_CONFIG", &toml_path)
        .env("RUST_LOG", "warn")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn companion-server");

    // Wait until /health responds, up to 5s.
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::new();
    for _ in 0..50 {
        if let Ok(r) = client.get(&url).send().await
            && r.status().is_success()
        {
            return (child, port, dir);
        }
        sleep(Duration::from_millis(100)).await;
    }
    panic!("companion-server did not become healthy within 5s");
}

#[tokio::test]
async fn health_endpoint_returns_ok() {
    let (mut child, port, _dir) = boot_companion().await;
    let body = reqwest::get(&format!("http://127.0.0.1:{port}/health"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body.trim(), "ok");
    let _ = child.kill().await;
}

#[tokio::test]
async fn status_endpoint_reports_disabled_subsystems() {
    let (mut child, port, _dir) = boot_companion().await;
    // AppHealth defaults `agent_up = true` (optimistic) and the
    // watchdog flips it to false on its first sweep. The interval can
    // be a few seconds, so poll /api/status until the value settles
    // (zeroclaw URL is `127.0.0.1:1` — unreachable — so we expect false).
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/status");
    let mut json: serde_json::Value = serde_json::json!({});
    for _ in 0..30 {
        json = client.get(&url).send().await.unwrap().json().await.unwrap();
        if json["zeroclaw_up"] == false {
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(json["ok"], true);
    assert_eq!(
        json["zeroclaw_up"], false,
        "watchdog should have flipped zeroclaw_up to false (URL is :1, unreachable)"
    );
    assert_eq!(json["avatar_enabled"], false);
    assert_eq!(json["pulse_enabled"], false);
    let _ = child.kill().await;
}

#[tokio::test]
async fn pulse_routes_404_when_disabled() {
    let (mut child, port, _dir) = boot_companion().await;
    let resp = reqwest::get(&format!("http://127.0.0.1:{port}/api/pulse/feed"))
        .await
        .unwrap();
    // Without the nest, requests fall through to the SPA fallback (which
    // tries to serve dist/) or 404. Either way: NOT 200.
    assert_ne!(resp.status(), 200);
    let _ = child.kill().await;
}
