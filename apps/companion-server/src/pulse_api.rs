//! Pulse REST API.
//!
//! Mounted at `/api/pulse/*` only when `[pulse] enabled = true`. Routes:
//! - `GET  /api/pulse/feed`               — recent items (?limit=, ?offset=, ?source=)
//! - `GET  /api/pulse/status`             — collector run history
//! - `POST /api/pulse/trigger/{id}`       — manually run a collector by id
//! - `GET  /api/pulse/feeds`              — user-managed RSS feeds
//! - `POST /api/pulse/feeds`              — add a feed
//! - `DELETE /api/pulse/feeds`            — remove by url
//! - `GET  /api/pulse/videos`             — subscribed video channels
//! - `POST /api/pulse/videos`             — subscribe (platform + channel_id + display_name)
//! - `DELETE /api/pulse/videos`           — unsubscribe (?platform=&channel_id=)
//! - `GET  /api/pulse/settings/{key}`     — read a Pulse setting (e.g. rsshub_url)
//! - `PUT  /api/pulse/settings/{key}`     — set a setting (body: {"value": "..."})

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Query, State, Path},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;

use companion_pulse::{PulseSubsystem, scheduler::trigger_collector};

#[derive(Debug, Deserialize)]
pub struct FeedQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    offset: u32,
    #[serde(default)]
    source: Option<String>,
}

fn default_limit() -> u32 {
    50
}

#[derive(Debug, Deserialize)]
pub struct AddFeedReq {
    name: String,
    url: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoveFeedQuery {
    url: String,
}

#[derive(Debug, Deserialize)]
pub struct AddVideoReq {
    /// "youtube" or "bilibili" (anything else is rejected so misspellings
    /// don't silently get persisted).
    platform: String,
    /// YouTube channel UC… id, or Bilibili UID. The collector treats
    /// these as opaque keys.
    channel_id: String,
    display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoveVideoQuery {
    platform: String,
    channel_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SettingValue {
    /// Empty string clears the setting (DELETE-by-PUT pattern keeps
    /// the URL space simple).
    value: String,
}

pub fn routes() -> Router<Arc<PulseSubsystem>> {
    Router::new()
        .route("/feed", get(handle_feed))
        .route("/status", get(handle_status))
        .route("/trigger/{id}", post(handle_trigger))
        .route("/feeds", get(handle_list_feeds).post(handle_add_feed).delete(handle_remove_feed))
        .route(
            "/videos",
            get(handle_list_videos).post(handle_add_video).delete(handle_remove_video),
        )
        .route(
            "/settings/{key}",
            get(handle_get_setting).put(handle_set_setting),
        )
}

async fn handle_feed(
    State(state): State<Arc<PulseSubsystem>>,
    Query(q): Query<FeedQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let limit = q.limit.min(500);
    let items = state
        .db
        .get_feed(limit, q.offset, q.source.as_deref())
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn handle_status(
    State(state): State<Arc<PulseSubsystem>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let runs = state.db.get_collector_status().await.map_err(internal)?;
    let collectors: Vec<_> = state
        .collectors
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id(),
                "name": c.name(),
                "enabled": c.enabled(),
                "interval_secs": c.default_interval().as_secs(),
            })
        })
        .collect();
    Ok(Json(
        serde_json::json!({ "collectors": collectors, "runs": runs }),
    ))
}

async fn handle_trigger(
    State(state): State<Arc<PulseSubsystem>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    trigger_collector(&state.collectors, &state.db, &id)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    Ok(Json(serde_json::json!({ "triggered": id })))
}

async fn handle_list_feeds(
    State(state): State<Arc<PulseSubsystem>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let feeds = state.db.get_user_feeds().await.map_err(internal)?;
    let shaped: Vec<_> = feeds
        .into_iter()
        .map(|(name, url)| serde_json::json!({ "name": name, "url": url }))
        .collect();
    Ok(Json(serde_json::json!({ "feeds": shaped })))
}

async fn handle_add_feed(
    State(state): State<Arc<PulseSubsystem>>,
    Json(req): Json<AddFeedReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if req.name.trim().is_empty() || req.url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name and url are required".into()));
    }
    state.db.add_user_feed(&req.name, &req.url).await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn handle_remove_feed(
    State(state): State<Arc<PulseSubsystem>>,
    Query(q): Query<RemoveFeedQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state.db.remove_user_feed(&q.url).await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Video subscriptions ─────────────────────────────────────────────

async fn handle_list_videos(
    State(state): State<Arc<PulseSubsystem>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let rows = state.db.get_video_channels().await.map_err(internal)?;
    let shaped: Vec<_> = rows
        .into_iter()
        .map(|(platform, channel_id, display_name)| {
            serde_json::json!({
                "platform": platform,
                "channel_id": channel_id,
                "display_name": display_name,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "videos": shaped })))
}

async fn handle_add_video(
    State(state): State<Arc<PulseSubsystem>>,
    Json(req): Json<AddVideoReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let p = req.platform.trim().to_lowercase();
    if p != "youtube" && p != "bilibili" {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("unsupported platform {p:?} (expected youtube or bilibili)"),
        ));
    }
    if req.channel_id.trim().is_empty() || req.display_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "channel_id and display_name required".into()));
    }
    state
        .db
        .add_video_channel(&p, req.channel_id.trim(), req.display_name.trim())
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn handle_remove_video(
    State(state): State<Arc<PulseSubsystem>>,
    Query(q): Query<RemoveVideoQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .db
        .remove_video_channel(&q.platform, &q.channel_id)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Settings k/v ────────────────────────────────────────────────────

async fn handle_get_setting(
    State(state): State<Arc<PulseSubsystem>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let value = state.db.get_setting(&key).await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "key": key, "value": value })))
}

async fn handle_set_setting(
    State(state): State<Arc<PulseSubsystem>>,
    Path(key): Path<String>,
    Json(req): Json<SettingValue>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let v = req.value.as_str();
    let stored = if v.is_empty() { None } else { Some(v) };
    state.db.set_setting(&key, stored).await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true, "value": stored })))
}

// ────────────────────────────────────────────────────────────────────

fn internal(e: anyhow::Error) -> (StatusCode, String) {
    tracing::error!("pulse api: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
