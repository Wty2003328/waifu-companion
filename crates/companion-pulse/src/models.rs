//! Pulse domain types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A raw item produced by a collector before storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawItem {
    pub source: String,
    pub collector_id: String,
    pub title: String,
    pub url: Option<String>,
    pub content: Option<String>,
    pub metadata: serde_json::Value,
    pub published_at: Option<DateTime<Utc>>,
}

/// A stored item in the database. Same shape as [`RawItem`] plus an `id`
/// and a `collected_at` timestamp.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub source: String,
    pub collector_id: String,
    pub title: String,
    pub url: Option<String>,
    pub content: Option<String>,
    pub metadata: serde_json::Value,
    pub published_at: Option<DateTime<Utc>>,
    pub collected_at: DateTime<Utc>,
}

/// API response shape for the feed endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedItem {
    pub id: String,
    pub source: String,
    pub collector_id: String,
    pub title: String,
    pub url: Option<String>,
    pub content: Option<String>,
    pub metadata: serde_json::Value,
    pub published_at: Option<DateTime<Utc>>,
    pub collected_at: DateTime<Utc>,
    /// When this item was marked as read by the user. None == unread.
    /// Frontend uses this to dim already-read entries and to filter
    /// down to "Unread only" via the feed query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<DateTime<Utc>>,
    /// LLM-generated summary, populated lazily by `POST /items/{id}/summarize`.
    /// Cached in SQLite so re-opening the drawer doesn't re-bill the LLM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// Record of a collector run for monitoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorRun {
    pub id: String,
    pub collector_id: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub items_count: u32,
    pub status: String,
    pub error: Option<String>,
}
