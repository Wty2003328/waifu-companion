//! Video subscription collector.
//!
//! Fetches the latest videos from YouTube channels and Bilibili UP主
//! via RSS/Atom feeds — no API keys required.
//!
//! ## Feed sources
//!
//! - **YouTube**: built-in `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`
//!   (the channel's UC… id, not the @handle)
//! - **Bilibili**: via [RSSHub](https://github.com/DIYgod/RSSHub).
//!   Public instance `https://rsshub.app` works but is rate-limited.
//!   Self-hosted is recommended; configure with the `rsshub_url`
//!   setting in the database.
//!
//! ## Storage
//!
//! Subscriptions live in the `video_channels` table; the collector
//! reads them on every run so adding/removing a subscription via
//! `Database::add_video_channel` / `remove_video_channel` takes
//! effect at the next tick (no restart).
//!
//! ## Wire schema
//!
//! Each emitted [`RawItem`] has metadata:
//!   `{ platform, channel_id, channel_name, author, video_id,
//!      thumbnail, description }`
//!
//! and `source = "video:<platform>:<channel_id>"` so downstream
//! consumers can filter by channel without re-parsing the metadata.

use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

use crate::models::RawItem;
use crate::storage::PulseDatabase;

use super::Collector;

pub struct VideoCollector {
    client: reqwest::Client,
    db: PulseDatabase,
}

impl VideoCollector {
    pub fn new(db: PulseDatabase) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("waifu-companion-pulse/0.1.0")
            .build()
            .unwrap_or_default();
        Self { client, db }
    }

    fn youtube_feed_url(channel_id: &str) -> String {
        format!(
            "https://www.youtube.com/feeds/videos.xml?channel_id={}",
            channel_id
        )
    }

    fn bilibili_feed_url(rsshub_base: &str, channel_id: &str) -> String {
        format!(
            "{}/bilibili/user/video/{}",
            rsshub_base.trim_end_matches('/'),
            channel_id
        )
    }

    fn watch_url(platform: &str, video_id: &str) -> String {
        match platform {
            "youtube" => format!("https://www.youtube.com/watch?v={}", video_id),
            "bilibili" => format!("https://www.bilibili.com/video/{}", video_id),
            _ => String::new(),
        }
    }
}

#[async_trait]
impl Collector for VideoCollector {
    fn id(&self) -> &str {
        "videos"
    }

    fn name(&self) -> &str {
        "Video Subscriptions"
    }

    fn default_interval(&self) -> Duration {
        Duration::from_secs(30 * 60)
    }

    fn enabled(&self) -> bool {
        // Always enabled at the trait level — the collector no-ops when
        // no channels are configured, and adding one shouldn't require
        // a config reload.
        true
    }

    async fn collect(&self) -> Result<Vec<RawItem>> {
        let channels = self.db.get_video_channels().await.unwrap_or_default();
        if channels.is_empty() {
            return Ok(Vec::new());
        }
        tracing::debug!("videos: fetching {} channel(s)", channels.len());

        // RSSHub override (mostly for self-hosted bilibili).
        let rsshub_base = self
            .db
            .get_setting("rsshub_url")
            .await
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://rsshub.app".to_string());

        let mut items = Vec::new();
        for (platform, channel_id, display_name) in &channels {
            let feed_url = match platform.as_str() {
                "youtube" => Self::youtube_feed_url(channel_id),
                "bilibili" => Self::bilibili_feed_url(&rsshub_base, channel_id),
                other => {
                    tracing::warn!("videos: unsupported platform {other:?}");
                    continue;
                }
            };
            match self
                .fetch_feed(&feed_url, platform, channel_id, display_name)
                .await
            {
                Ok(mut feed_items) => items.append(&mut feed_items),
                Err(e) => tracing::warn!(
                    "videos: feed failed for {platform} {display_name} ({channel_id}): {e}"
                ),
            }
            // Throttle so we don't hammer YouTube / RSSHub.
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        tracing::info!(
            "videos: fetched {} item(s) from {} channel(s)",
            items.len(),
            channels.len()
        );
        Ok(items)
    }
}

impl VideoCollector {
    async fn fetch_feed(
        &self,
        url: &str,
        platform: &str,
        channel_id: &str,
        display_name: &str,
    ) -> Result<Vec<RawItem>> {
        let response = self.client.get(url).send().await?;
        if !response.status().is_success() {
            anyhow::bail!("HTTP {}", response.status());
        }
        let body = response.bytes().await?;
        let feed = feed_rs::parser::parse(&body[..])?;

        let items: Vec<RawItem> = feed
            .entries
            .into_iter()
            .take(10)
            .map(|entry| {
                let title = entry
                    .title
                    .map(|t| t.content)
                    .unwrap_or_else(|| "Untitled".to_string());
                let video_id = entry.id.clone();
                let entry_url = entry
                    .links
                    .first()
                    .map(|l| l.href.clone())
                    .unwrap_or_else(|| Self::watch_url(platform, &video_id));
                let published = entry
                    .published
                    .or(entry.updated)
                    .unwrap_or_else(Utc::now);
                let thumbnail = entry
                    .media
                    .first()
                    .and_then(|m| m.thumbnails.first())
                    .map(|t| t.image.uri.clone())
                    .or_else(|| {
                        if platform == "youtube" {
                            let vid = video_id.strip_prefix("yt:video:").unwrap_or(&video_id);
                            Some(format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", vid))
                        } else {
                            None
                        }
                    });
                let description = entry
                    .summary
                    .map(|s| s.content)
                    .or_else(|| entry.content.and_then(|c| c.body))
                    .unwrap_or_default();
                let author = entry
                    .authors
                    .first()
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| display_name.to_string());

                let metadata = serde_json::json!({
                    "platform": platform,
                    "channel_id": channel_id,
                    "channel_name": display_name,
                    "author": author,
                    "video_id": video_id,
                    "thumbnail": thumbnail,
                    "description": description.chars().take(300).collect::<String>(),
                });

                RawItem {
                    source: format!("video:{}:{}", platform, channel_id),
                    collector_id: "videos".to_string(),
                    title,
                    url: Some(entry_url),
                    content: if description.is_empty() {
                        None
                    } else {
                        Some(description)
                    },
                    metadata,
                    published_at: Some(published),
                }
            })
            .collect();
        Ok(items)
    }
}
