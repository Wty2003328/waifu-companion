//! GitHub releases collector.
//!
//! Polls each watched repo's `/releases.atom` and emits one item per
//! release. No GitHub API key required — the atom feed is anonymous-
//! readable and has no rate limit beyond standard CDN throttling.
//!
//! The watched repo list is configured in `companion.toml`:
//!
//! ```toml
//! [pulse.collectors.github_releases]
//! enabled  = true
//! interval = "1h"
//! repos = [
//!   "rust-lang/rust",
//!   "tauri-apps/tauri",
//!   "anthropic/claude-code",
//! ]
//! ```
//!
//! Adding a repo at runtime currently requires a config edit + restart.
//! (The DB-driven model used by the video collector would work here
//! too if the user wants hot-reload — straightforward follow-up.)

use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::{Collector, parse_interval};
use crate::models::RawItem;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubReleasesConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_1h")]
    pub interval: String,
    /// Each entry is "owner/repo" — e.g. "rust-lang/rust".
    #[serde(default)]
    pub repos: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_1h() -> String {
    "1h".to_string()
}

pub struct GithubReleasesCollector {
    cfg: GithubReleasesConfig,
    client: reqwest::Client,
}

impl GithubReleasesCollector {
    pub fn new(cfg: GithubReleasesConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("waifu-companion-pulse/0.1.0")
            .build()
            .unwrap_or_default();
        Self { cfg, client }
    }
}

#[async_trait]
impl Collector for GithubReleasesCollector {
    fn id(&self) -> &str {
        "github_releases"
    }

    fn name(&self) -> &str {
        "GitHub Releases"
    }

    fn default_interval(&self) -> Duration {
        parse_interval(&self.cfg.interval)
    }

    fn enabled(&self) -> bool {
        self.cfg.enabled && !self.cfg.repos.is_empty()
    }

    async fn collect(&self) -> Result<Vec<RawItem>> {
        if self.cfg.repos.is_empty() {
            return Ok(Vec::new());
        }
        tracing::debug!("github_releases: polling {} repo(s)", self.cfg.repos.len());

        let mut out = Vec::new();
        for repo in &self.cfg.repos {
            let url = format!(
                "https://github.com/{}/releases.atom",
                repo.trim_matches('/')
            );
            match self.fetch_repo(&url, repo).await {
                Ok(mut items) => out.append(&mut items),
                Err(e) => tracing::warn!("github_releases: {repo} failed: {e}"),
            }
            // Be polite — atoms are CDN-cached but back-to-back fan-out
            // looks like abuse to GitHub's edge.
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        tracing::info!(
            "github_releases: fetched {} release(s) across {} repo(s)",
            out.len(),
            self.cfg.repos.len()
        );
        Ok(out)
    }
}

impl GithubReleasesCollector {
    async fn fetch_repo(&self, url: &str, repo: &str) -> Result<Vec<RawItem>> {
        let resp = self.client.get(url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("HTTP {}", resp.status());
        }
        let body = resp.bytes().await?;
        let feed = feed_rs::parser::parse(&body[..])?;
        let items: Vec<RawItem> = feed
            .entries
            .into_iter()
            .take(10)
            .map(|entry| {
                let title = entry
                    .title
                    .map(|t| t.content)
                    .unwrap_or_else(|| format!("{repo} release"));
                let release_url = entry
                    .links
                    .first()
                    .map(|l| l.href.clone())
                    .unwrap_or_else(|| format!("https://github.com/{repo}/releases"));
                let published = entry.updated.or(entry.published).unwrap_or_else(Utc::now);
                let author = entry
                    .authors
                    .first()
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| repo.to_string());
                let summary = entry
                    .content
                    .and_then(|c| c.body)
                    .or_else(|| entry.summary.map(|s| s.content))
                    .unwrap_or_default();
                // The atom id looks like
                //   tag:github.com,2008:Repository/41881900/v2.0.6
                // Extract just the release tag at the end. Falls back to
                // the full id if the format doesn't match (defensive).
                let tag_only: String = entry
                    .id
                    .rsplit('/')
                    .next()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| entry.id.clone());
                let metadata = serde_json::json!({
                    "platform": "github",
                    "repo": repo,
                    "tag": tag_only,
                    "tag_full_id": entry.id,
                    "author": author,
                });
                RawItem {
                    source: format!("github:{repo}"),
                    collector_id: "github_releases".to_string(),
                    title,
                    url: Some(release_url),
                    content: if summary.is_empty() {
                        None
                    } else {
                        Some(summary)
                    },
                    metadata,
                    published_at: Some(published),
                }
            })
            .collect();
        Ok(items)
    }
}
