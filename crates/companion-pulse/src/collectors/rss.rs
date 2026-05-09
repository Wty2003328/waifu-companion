//! RSS / Atom feed collector. Wraps `feed-rs`.

use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::{Collector, parse_interval};
use crate::config::RssConfig;
use crate::models::RawItem;
use crate::storage::PulseDatabase;

pub struct RssCollector {
    config: RssConfig,
    /// Optional handle to the database — when present, the collector
    /// merges runtime-managed feeds (from the `user_feeds` table,
    /// editable via the /pulse Sources tab) on top of the static
    /// list in companion.toml. None for the unit-test path.
    db: Option<PulseDatabase>,
    client: reqwest::Client,
}

impl RssCollector {
    pub fn new(config: RssConfig) -> Self {
        Self::with_db(config, None)
    }

    pub fn with_db(config: RssConfig, db: Option<PulseDatabase>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("zeroclaw-companion/0.1.0 (+pulse)")
            .build()
            .unwrap_or_default();
        Self { config, db, client }
    }

    /// Parse an arbitrary feed body (RSS or Atom) into [`RawItem`]s.
    /// Public so tests can inject canned XML without needing the network.
    pub fn parse_body(name: &str, body: &[u8]) -> Result<Vec<RawItem>> {
        let feed = feed_rs::parser::parse(body)?;
        let items: Vec<RawItem> = feed
            .entries
            .into_iter()
            .map(|entry| {
                let title = entry
                    .title
                    .map(|t| t.content)
                    .unwrap_or_else(|| "Untitled".into());
                let url = entry.links.first().map(|l| l.href.clone());
                let content = entry
                    .summary
                    .map(|s| s.content)
                    .or_else(|| entry.content.and_then(|c| c.body));
                let published_at: Option<DateTime<Utc>> = entry
                    .published
                    .or(entry.updated)
                    .map(|d| d.with_timezone(&Utc));
                let metadata = serde_json::json!({
                    "feed_name": name,
                    "feed_url": url,
                    "authors": entry.authors.iter().map(|a| &a.name).collect::<Vec<_>>(),
                    "categories": entry.categories.iter().map(|c| &c.term).collect::<Vec<_>>(),
                });
                RawItem {
                    source: format!("rss:{}", name.to_lowercase().replace(' ', "-")),
                    collector_id: "rss".to_string(),
                    title,
                    url,
                    content,
                    metadata,
                    published_at,
                }
            })
            .collect();
        Ok(items)
    }

    async fn fetch_feed(&self, name: &str, url: &str) -> Result<Vec<RawItem>> {
        tracing::debug!("rss: fetching {} ({})", name, url);
        let body = self.client.get(url).send().await?.bytes().await?;
        Self::parse_body(name, &body)
    }
}

#[async_trait]
impl Collector for RssCollector {
    fn id(&self) -> &str {
        "rss"
    }
    fn name(&self) -> &str {
        "RSS Feeds"
    }
    fn default_interval(&self) -> Duration {
        parse_interval(&self.config.interval)
    }
    fn enabled(&self) -> bool {
        self.config.enabled
    }

    async fn collect(&self) -> Result<Vec<RawItem>> {
        // Merge static toml feeds + runtime user_feeds (added via the
        // /pulse Sources tab). De-dupe by URL so a feed listed in both
        // doesn't get double-fetched. Static-toml entry's name wins
        // when both list the same URL — that one's the one with the
        // user-friendly display name in companion.toml.
        let mut by_url: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        if let Some(ref db) = self.db {
            match db.get_user_feeds().await {
                Ok(rows) => {
                    for (name, url) in rows {
                        by_url.insert(url, name);
                    }
                }
                Err(e) => tracing::warn!("rss: failed to load user feeds: {e}"),
            }
        }
        for feed in &self.config.feeds {
            by_url.insert(feed.url.clone(), feed.name.clone());
        }

        let mut all = Vec::new();
        for (url, name) in &by_url {
            match self.fetch_feed(name, url).await {
                Ok(items) => {
                    tracing::info!("rss: {} → {} items", name, items.len());
                    all.extend(items);
                }
                Err(e) => tracing::warn!("rss: {} failed: {e}", name),
            }
        }
        if by_url.is_empty() {
            tracing::debug!(
                "rss: no feeds configured (toml is empty + no runtime feeds via /api/pulse/feeds)"
            );
        }
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sample Feed</title>
    <link>https://example.com/</link>
    <item>
      <title>First Post</title>
      <link>https://example.com/1</link>
      <description>Body of post one.</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/2</link>
      <description>Body of post two.</description>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parse_rss_two_items() {
        let items = RssCollector::parse_body("Sample", RSS_SAMPLE.as_bytes()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "First Post");
        assert_eq!(items[0].url.as_deref(), Some("https://example.com/1"));
        assert_eq!(items[0].source, "rss:sample");
        assert_eq!(items[0].collector_id, "rss");
        assert!(items[0].published_at.is_some());
    }

    #[test]
    fn parse_rss_lowercases_source_and_replaces_spaces() {
        let items = RssCollector::parse_body("My Cool Feed", RSS_SAMPLE.as_bytes()).unwrap();
        assert_eq!(items[0].source, "rss:my-cool-feed");
    }

    #[test]
    fn parse_rss_missing_pubdate() {
        let items = RssCollector::parse_body("Sample", RSS_SAMPLE.as_bytes()).unwrap();
        assert!(items[1].published_at.is_none());
    }

    #[test]
    fn parse_rss_invalid_body_errors() {
        let result = RssCollector::parse_body("Sample", b"not xml");
        assert!(result.is_err());
    }
}
