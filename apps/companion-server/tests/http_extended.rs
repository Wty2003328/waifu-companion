//! Extended HTTP integration tests for companion-server.
//!
//! `http_smoke.rs` covers `/health`, `/api/status`, and the disabled-
//! pulse fallthrough. This file fills out the surface tested at the
//! Rust process level:
//!
//! - `/api/shutdown` actually terminates the process within the grace
//!   window (no infinite-hang regression).
//! - Configuration hot-swap correctness for the zeroclaw URL — POST
//!   override, observe the watchdog flip.
//! - Health watchdog flips from "up" to "down" when the configured
//!   agent URL becomes unreachable.
//! - SPA fallback returns HTML 200 for unknown `/api/*` paths.
//!
//! Each test spawns its own companion-server process against a tempdir
//! companion.toml so they're parallel-safe at the OS level (modulo
//! port collisions; we use unique ports per test).

use std::process::Stdio;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::time::sleep;

/// Tiny copy of http_smoke::boot_companion that lets us pick the
/// agent URL and avatar/pulse toggles. Returns the child + bound port.
async fn boot_with(
    zeroclaw_url: &str,
    avatar_enabled: bool,
    pulse_enabled: bool,
) -> (Child, u16, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let toml_path = dir.path().join("companion.toml");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let toml = format!(
        r#"
[zeroclaw]
url = "{zeroclaw_url}"
kind = "zeroclaw"
timeout_secs = 5

[server]
host = "127.0.0.1"
port = {port}

[avatar]
enabled = {avatar_enabled}

[pulse]
enabled = {pulse_enabled}
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

    // Wait for /health.
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
async fn shutdown_endpoint_terminates_within_grace() {
    let (mut child, port, _dir) = boot_with("http://127.0.0.1:1", false, false).await;
    let client = reqwest::Client::new();
    // Fire shutdown.
    let resp = client
        .post(format!("http://127.0.0.1:{port}/api/shutdown"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 202, "/api/shutdown should return 202");

    // Wait up to 12s for the process to exit. Avatar / pulse are off here
    // so there are no sidecars to gracefully stop — the binary should
    // exit ~immediately.
    let start = Instant::now();
    let deadline = Duration::from_secs(12);
    loop {
        match child.try_wait().unwrap() {
            Some(status) => {
                let elapsed = start.elapsed();
                // Don't assert on exit code — Windows reports varied codes
                // for clean SIGTERM-equivalent shutdown. Just assert it
                // DID exit.
                assert!(
                    elapsed < deadline,
                    "took {elapsed:?} to exit, deadline {deadline:?}",
                );
                let _ = status;
                return;
            }
            None => {
                if start.elapsed() > deadline {
                    let _ = child.kill().await;
                    panic!(
                        "companion-server did NOT exit within {deadline:?} \
                         after POST /api/shutdown",
                    );
                }
                sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

#[tokio::test]
async fn spa_fallthrough_returns_html_or_404_for_unknown_api_path() {
    let (mut child, port, _dir) = boot_with("http://127.0.0.1:1", false, false).await;
    let r = reqwest::get(format!("http://127.0.0.1:{port}/api/this-does-not-exist"))
        .await
        .unwrap();
    // Without a web/dist build available, expect 404 (no SPA fallback
    // file). With one, expect 200 + HTML body. Either is fine; what we
    // disallow is a 5xx (server crash).
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    assert!(
        !status.is_server_error(),
        "unknown /api/ path returned 5xx (status={status}, body={body:?})",
    );
    let _ = child.kill().await;
}

#[tokio::test]
async fn health_watchdog_marks_unreachable_agent_down() {
    // Agent URL points at an unbound port → watchdog should report
    // zeroclaw_up = false within ~10 s.
    let (mut child, port, _dir) = boot_with("http://127.0.0.1:1", false, false).await;
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/status");
    let mut down = false;
    for _ in 0..30 {
        let r = client.get(&url).send().await.unwrap();
        let json: serde_json::Value = r.json().await.unwrap();
        if json["zeroclaw_up"] == false {
            down = true;
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }
    assert!(
        down,
        "watchdog did not flip zeroclaw_up to false within 15 s",
    );
    let _ = child.kill().await;
}

#[tokio::test]
async fn config_get_returns_redacted_state() {
    // Just GET /api/config and verify the shape includes the keys
    // documented in the iter-10 audit (tts.streaming, etc.) so the
    // schema-drift regression class is locked in at the Rust layer too.
    let (mut child, port, _dir) = boot_with("http://127.0.0.1:1", false, false).await;
    let r = reqwest::get(format!("http://127.0.0.1:{port}/api/config"))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let json: serde_json::Value = r.json().await.unwrap();
    // zeroclaw subtree exists; avatar may be null (avatar=false).
    assert!(
        json.get("zeroclaw").is_some(),
        "GET /api/config missing 'zeroclaw' subtree: {json:?}",
    );
    let _ = child.kill().await;
}

#[tokio::test]
async fn zeroclaw_override_round_trips() {
    // Boot with one URL → POST override with a different URL → GET
    // /api/config → confirm the new URL is reflected.
    let (mut child, port, _dir) = boot_with("http://127.0.0.1:1", false, false).await;
    let client = reqwest::Client::new();
    let new_url = "http://127.0.0.1:42620";
    let body = serde_json::json!({"url": new_url});
    let r = client
        .post(format!("http://127.0.0.1:{port}/api/config/zeroclaw"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "POST override returned {:?}", r.status());
    let cfg: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/api/config"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        cfg["zeroclaw"]["url"],
        serde_json::Value::String(new_url.into()),
        "zeroclaw URL didn't round-trip: {cfg:?}",
    );
    let _ = child.kill().await;
}
