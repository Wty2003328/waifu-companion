//! Pulse — personal intelligence dashboard for the zeroclaw companion.
//!
//! Periodic collectors (RSS, HackerNews, …) push items into a SQLite-backed
//! store. The companion-server exposes the feed at `/api/pulse/*`. The
//! frontend renders a dashboard.
//!
//! Architecture:
//! ```text
//!   PulseConfig (companion.toml [pulse])
//!         │
//!         ▼
//!   Scheduler ── runs each Collector at its interval ──▶ PulseDatabase
//!                                                              │
//!                                                              ▼
//!                                                       /api/pulse/feed
//! ```

pub mod collectors;
pub mod config;
pub mod models;
pub mod scheduler;
pub mod storage;
pub mod summarizer;

pub use config::{PulseConfig, RssConfig, FeedEntry, HackerNewsConfig, VideosConfig};
pub use collectors::github::GithubReleasesConfig;
pub use models::{CollectorRun, FeedItem, RawItem};
pub use scheduler::{Scheduler, trigger_collector};
pub use storage::PulseDatabase;
pub use collectors::{Collector, parse_interval};
pub use summarizer::Summarizer;

use std::sync::Arc;

/// Shared Pulse subsystem state. Held by the server's AppState when
/// `[pulse] enabled = true`.
#[derive(Clone)]
pub struct PulseSubsystem {
    pub db: PulseDatabase,
    pub collectors: Vec<Arc<dyn Collector>>,
    /// Optional summarizer used by the `/items/{id}/summarize` endpoint.
    /// `None` ⇒ summarize returns 503. Two backends are supported (direct
    /// OpenAI-compatible LLM, or zeroclaw's `/webhook`) — see [`Summarizer`].
    pub summarizer: Option<Arc<Summarizer>>,
}

impl PulseSubsystem {
    /// Build the subsystem and start the scheduler in the background.
    /// Pass `None` for `summarizer` to disable the summarize endpoint
    /// while keeping the rest of Pulse working.
    pub async fn start(
        cfg: &PulseConfig,
        summarizer: Option<Arc<Summarizer>>,
    ) -> anyhow::Result<Self> {
        // Resolve DB path. Default ./data/pulse.db relative to CWD.
        let db_path = cfg.database.path.clone();
        let db = PulseDatabase::new(&db_path).await?;

        let mut list: Vec<Arc<dyn Collector>> = Vec::new();
        if let Some(rss) = cfg.collectors.rss.clone() {
            list.push(Arc::new(collectors::rss::RssCollector::with_db(
                rss,
                Some(db.clone()),
            )));
        }
        if let Some(hn) = cfg.collectors.hackernews.clone() {
            list.push(Arc::new(collectors::hackernews::HackerNewsCollector::new(
                hn,
            )));
        }
        // Video subscriptions (YouTube + Bilibili-via-RSSHub). Channels
        // come from the DB, not the toml, so the user can curate them
        // at runtime without a restart.
        if cfg.collectors.videos.as_ref().map(|v| v.enabled).unwrap_or(false) {
            list.push(Arc::new(collectors::videos::VideoCollector::new(
                db.clone(),
            )));
        }
        // GitHub releases — repos in toml, no DB plumbing needed.
        if let Some(gh) = cfg.collectors.github_releases.clone() {
            if gh.enabled {
                list.push(Arc::new(
                    collectors::github::GithubReleasesCollector::new(gh),
                ));
            }
        }

        tracing::info!("pulse: {} collector(s) registered", list.len());

        let sched = Arc::new(Scheduler::new(list.clone(), db.clone()));
        let sched_handle = Arc::clone(&sched);
        tokio::spawn(async move {
            sched_handle.start().await;
        });

        Ok(Self {
            db,
            collectors: list,
            summarizer,
        })
    }
}
