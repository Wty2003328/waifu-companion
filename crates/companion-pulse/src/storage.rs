//! SQLite-backed storage for Pulse items + collector runs.
//!
//! rusqlite is synchronous, so every operation is wrapped in
//! `tokio::task::spawn_blocking`. Each call opens its own connection to
//! avoid mutex contention between the scheduler and API handlers (SQLite
//! handles concurrent access fine via its own locking).

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{CollectorRun, FeedItem, RawItem};

#[derive(Clone)]
pub struct PulseDatabase {
    path: Arc<String>,
}

impl PulseDatabase {
    /// Open or create the database, run migrations.
    pub async fn new(db_path: &str) -> Result<Self> {
        if let Some(parent) = Path::new(db_path).parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create dir {}", parent.display()))?;
        }

        // One-shot bootstrap: WAL + foreign keys.
        let path = db_path.to_string();
        let p2 = path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = Connection::open(&p2)?;
            conn.execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
            )?;
            Ok(())
        })
        .await??;

        let db = Self {
            path: Arc::new(path),
        };
        db.run_migrations().await?;
        tracing::info!("pulse: database ready at {}", db_path);
        Ok(db)
    }

    // Reserved for future Pulse code paths that want a primed
    // sqlite handle (with PRAGMA busy_timeout pre-set) without
    // re-implementing the boilerplate. Not yet called — keeping it
    // here so the next collector PR doesn't have to re-add it.
    #[allow(dead_code)]
    fn open(&self) -> Result<Connection> {
        let conn = Connection::open(self.path.as_str())?;
        conn.execute_batch("PRAGMA busy_timeout=5000;")?;
        Ok(conn)
    }

    async fn run_migrations(&self) -> Result<()> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let c = Connection::open(path.as_str())?;
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS items (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    collector_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    url TEXT,
                    content TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    published_at TEXT,
                    collected_at TEXT NOT NULL,
                    read_at TEXT,
                    summary TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_items_collected_at ON items(collected_at);
                 CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
                 CREATE INDEX IF NOT EXISTS idx_items_read_at ON items(read_at);
                 CREATE TABLE IF NOT EXISTS collector_runs (
                    id TEXT PRIMARY KEY,
                    collector_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    items_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'running',
                    error TEXT
                 );
                 CREATE TABLE IF NOT EXISTS user_feeds (
                    name TEXT NOT NULL,
                    url TEXT NOT NULL PRIMARY KEY
                 );
                 CREATE TABLE IF NOT EXISTS video_channels (
                    platform     TEXT NOT NULL,
                    channel_id   TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    PRIMARY KEY (platform, channel_id)
                 );
                 CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                 );",
            )?;
            // Idempotent column adds for users upgrading from pre-read-tracking
            // schema. SQLite errors if the column exists; we swallow that
            // specific error so re-runs are no-ops.
            let _ = c.execute("ALTER TABLE items ADD COLUMN read_at TEXT", []);
            let _ = c.execute(
                "CREATE INDEX IF NOT EXISTS idx_items_read_at ON items(read_at)",
                [],
            );
            // summary column added in the agent-summarize iteration. Same
            // idempotent pattern: ignore "duplicate column" errors so old
            // databases pick it up on next start.
            let _ = c.execute("ALTER TABLE items ADD COLUMN summary TEXT", []);
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Insert a new item, returning its UUID.
    pub async fn insert_item(&self, raw: &RawItem) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let metadata = serde_json::to_string(&raw.metadata)?;
        let published = raw.published_at.map(|d| d.to_rfc3339());
        let item = raw.clone();
        let id2 = id.clone();
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let c = Connection::open(path.as_str())?;
            c.execute(
                "INSERT INTO items
                 (id, source, collector_id, title, url, content, metadata, published_at, collected_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    id2, item.source, item.collector_id, item.title,
                    item.url, item.content, metadata, published, now
                ],
            )?;
            Ok(())
        })
        .await??;
        Ok(id)
    }

    /// True when an item with this URL already exists (deduplication helper).
    pub async fn item_exists_by_url(&self, url: &str) -> Result<bool> {
        let path = self.path.clone();
        let url = url.to_string();
        tokio::task::spawn_blocking(move || -> Result<bool> {
            let c = Connection::open(path.as_str())?;
            let count: i64 = c.query_row(
                "SELECT COUNT(*) FROM items WHERE url = ?1",
                params![url],
                |r| r.get(0),
            )?;
            Ok(count > 0)
        })
        .await?
    }

    /// Most-recent items, optionally filtered by source / search /
    /// unread state. All filters compose as AND. Search matches a
    /// case-insensitive substring against title OR content (SQLite
    /// LIKE — fine for the typical Pulse working set of <100k items).
    pub async fn get_feed(
        &self,
        limit: u32,
        offset: u32,
        source: Option<&str>,
        search: Option<&str>,
        unread_only: bool,
    ) -> Result<Vec<FeedItem>> {
        let path = self.path.clone();
        let source = source.map(|s| s.to_string());
        let search = search
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", s.to_lowercase()));
        tokio::task::spawn_blocking(move || -> Result<Vec<FeedItem>> {
            let c = Connection::open(path.as_str())?;

            // Build WHERE clauses + ordered param values dynamically.
            // rusqlite's `params!` only takes a fixed-arity tuple, so
            // we collect into a Vec<Box<dyn ToSql>> and feed it in.
            use rusqlite::ToSql;
            let mut where_clauses: Vec<&'static str> = Vec::new();
            let mut bound: Vec<Box<dyn ToSql>> = Vec::new();

            if let Some(ref s) = source {
                where_clauses.push("(source = ? OR source LIKE ? || ':%' OR collector_id = ?)");
                bound.push(Box::new(s.clone()));
                bound.push(Box::new(s.clone()));
                bound.push(Box::new(s.clone()));
            }
            if let Some(ref q) = search {
                where_clauses.push("(LOWER(title) LIKE ? OR LOWER(IFNULL(content, '')) LIKE ?)");
                bound.push(Box::new(q.clone()));
                bound.push(Box::new(q.clone()));
            }
            if unread_only {
                where_clauses.push("read_at IS NULL");
            }
            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", where_clauses.join(" AND "))
            };
            let sql = format!(
                "SELECT id, source, collector_id, title, url, content, metadata, published_at, collected_at, read_at, summary
                 FROM items
                 {where_sql}
                 ORDER BY collected_at DESC
                 LIMIT ? OFFSET ?",
            );
            bound.push(Box::new(limit as i64));
            bound.push(Box::new(offset as i64));
            let bound_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();

            let mut stmt = c.prepare(&sql)?;
            let items: Vec<FeedItem> = stmt
                .query_map(bound_refs.as_slice(), row_to_feed_item)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
        .await?
    }

    pub async fn mark_item_read(&self, id: &str, read: bool) -> Result<bool> {
        let path = self.path.clone();
        let item_id = id.to_string();
        let now = Utc::now().to_rfc3339();
        let n = tokio::task::spawn_blocking(move || -> Result<usize> {
            let c = Connection::open(path.as_str())?;
            let n = if read {
                c.execute(
                    "UPDATE items SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL",
                    params![now, item_id],
                )?
            } else {
                c.execute(
                    "UPDATE items SET read_at = NULL WHERE id = ?1",
                    params![item_id],
                )?
            };
            Ok(n)
        })
        .await??;
        Ok(n > 0)
    }

    /// Mark every currently-stored item as read in one shot. Useful
    /// for "clear inbox" UX without iterating IDs from the client.
    pub async fn mark_all_read(&self) -> Result<u64> {
        let path = self.path.clone();
        let now = Utc::now().to_rfc3339();
        let n = tokio::task::spawn_blocking(move || -> Result<u64> {
            let c = Connection::open(path.as_str())?;
            let n = c.execute(
                "UPDATE items SET read_at = ?1 WHERE read_at IS NULL",
                params![now],
            )?;
            Ok(n as u64)
        })
        .await??;
        Ok(n)
    }

    /// Fetch a single feed item by id. Used by the summarize endpoint
    /// (needs title + content + url + cached summary in one round-trip).
    pub async fn get_item(&self, id: &str) -> Result<Option<FeedItem>> {
        let path = self.path.clone();
        let item_id = id.to_string();
        let item = tokio::task::spawn_blocking(move || -> Result<Option<FeedItem>> {
            let c = Connection::open(path.as_str())?;
            let mut stmt = c.prepare(
                "SELECT id, source, collector_id, title, url, content, metadata, published_at, collected_at, read_at, summary
                 FROM items WHERE id = ?1",
            )?;
            let row = stmt.query_row([item_id], row_to_feed_item).optional()?;
            Ok(row)
        })
        .await??;
        Ok(item)
    }

    /// Persist a generated summary so we don't re-call the LLM on every
    /// drawer-open. Pass `None` to clear.
    pub async fn set_item_summary(&self, id: &str, summary: Option<&str>) -> Result<()> {
        let path = self.path.clone();
        let item_id = id.to_string();
        let summary = summary.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            let c = Connection::open(path.as_str())?;
            c.execute(
                "UPDATE items SET summary = ?1 WHERE id = ?2",
                params![summary, item_id],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn unread_count(&self) -> Result<u64> {
        let path = self.path.clone();
        let n = tokio::task::spawn_blocking(move || -> Result<u64> {
            let c = Connection::open(path.as_str())?;
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM items WHERE read_at IS NULL",
                [],
                |r| r.get(0),
            )?;
            Ok(n as u64)
        })
        .await??;
        Ok(n)
    }

    pub async fn start_collector_run(&self, collector_id: &str) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let path = self.path.clone();
        let cid = collector_id.to_string();
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "INSERT INTO collector_runs (id, collector_id, started_at, status) VALUES (?1,?2,?3,'running')",
                params![id2, cid, now],
            )?;
            Ok(())
        })
        .await??;
        Ok(id)
    }

    pub async fn finish_collector_run(
        &self,
        run_id: &str,
        items_count: u32,
        error: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let status = if error.is_some() { "error" } else { "success" };
        let path = self.path.clone();
        let rid = run_id.to_string();
        let err = error.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "UPDATE collector_runs
                 SET finished_at = ?1, items_count = ?2, status = ?3, error = ?4
                 WHERE id = ?5",
                params![now, items_count, status, err, rid],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn get_collector_status(&self) -> Result<Vec<CollectorRun>> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<CollectorRun>> {
            let c = Connection::open(path.as_str())?;
            let mut stmt = c.prepare(
                "SELECT id, collector_id, started_at, finished_at, items_count, status, error
                 FROM collector_runs
                 ORDER BY started_at DESC
                 LIMIT 50",
            )?;
            let runs = stmt
                .query_map([], |r| {
                    Ok(CollectorRun {
                        id: r.get(0)?,
                        collector_id: r.get(1)?,
                        started_at: parse_dt(r.get::<_, String>(2)?).unwrap_or_else(Utc::now),
                        finished_at: r.get::<_, Option<String>>(3)?.and_then(parse_dt),
                        items_count: r.get::<_, i64>(4)? as u32,
                        status: r.get(5)?,
                        error: r.get(6)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(runs)
        })
        .await?
    }

    pub async fn get_user_feeds(&self) -> Result<Vec<(String, String)>> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<(String, String)>> {
            let c = Connection::open(path.as_str())?;
            let mut stmt = c.prepare("SELECT name, url FROM user_feeds ORDER BY name")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
        .await?
    }

    pub async fn add_user_feed(&self, name: &str, url: &str) -> Result<()> {
        let path = self.path.clone();
        let n = name.to_string();
        let u = url.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "INSERT OR REPLACE INTO user_feeds (name, url) VALUES (?1, ?2)",
                params![n, u],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn remove_user_feed(&self, url: &str) -> Result<()> {
        let path = self.path.clone();
        let u = url.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?
                .execute("DELETE FROM user_feeds WHERE url = ?1", params![u])?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Drop items older than `cutoff` (RFC3339). Returns rows deleted.
    pub async fn purge_older_than(&self, cutoff_rfc3339: &str) -> Result<u64> {
        let path = self.path.clone();
        let cutoff = cutoff_rfc3339.to_string();
        let n = tokio::task::spawn_blocking(move || -> Result<u64> {
            let c = Connection::open(path.as_str())?;
            let n = c.execute("DELETE FROM items WHERE collected_at < ?1", params![cutoff])?;
            Ok(n as u64)
        })
        .await??;
        Ok(n)
    }

    // ── Video subscriptions (YouTube + Bilibili-via-RSSHub) ──────────
    //
    // The VideoCollector reads channels from this table on every call so
    // the user can add/remove subscriptions without a restart. Self-hosted
    // RSSHub support for Bilibili lives in the `settings` table under the
    // key `rsshub_url` — leave it unset to fall back to public rsshub.app.

    /// Returns (platform, channel_id, display_name) tuples for every
    /// configured subscription, ordered by platform then channel_id.
    pub async fn get_video_channels(&self) -> Result<Vec<(String, String, String)>> {
        let path = self.path.clone();
        let rows = tokio::task::spawn_blocking(move || -> Result<Vec<(String, String, String)>> {
            let c = Connection::open(path.as_str())?;
            let mut stmt = c.prepare(
                "SELECT platform, channel_id, display_name
                 FROM video_channels
                 ORDER BY platform, channel_id",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await??;
        Ok(rows)
    }

    pub async fn add_video_channel(
        &self,
        platform: &str,
        channel_id: &str,
        display_name: &str,
    ) -> Result<()> {
        let path = self.path.clone();
        let p = platform.to_string();
        let c = channel_id.to_string();
        let d = display_name.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "INSERT INTO video_channels (platform, channel_id, display_name)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(platform, channel_id) DO UPDATE SET display_name = excluded.display_name",
                params![p, c, d],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn remove_video_channel(&self, platform: &str, channel_id: &str) -> Result<()> {
        let path = self.path.clone();
        let p = platform.to_string();
        let c = channel_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "DELETE FROM video_channels WHERE platform = ?1 AND channel_id = ?2",
                params![p, c],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    // ── Generic key/value settings table ─────────────────────────────
    //
    // Used by VideoCollector to read `rsshub_url` (override the default
    // public RSSHub instance with a self-hosted one to bypass rate
    // limits + region blocks). Open-ended k/v store; future settings
    // can be added without a schema change.

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let path = self.path.clone();
        let k = key.to_string();
        let val = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            let c = Connection::open(path.as_str())?;
            let mut stmt = c.prepare("SELECT value FROM settings WHERE key = ?1")?;
            let val: Option<String> = stmt
                .query_row(params![k], |r| r.get::<_, Option<String>>(0))
                .optional()?
                .flatten();
            Ok(val)
        })
        .await??;
        Ok(val)
    }

    pub async fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let path = self.path.clone();
        let k = key.to_string();
        let v = value.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            Connection::open(path.as_str())?.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }
}

fn parse_dt(s: String) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(&s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn row_to_feed_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<FeedItem> {
    Ok(FeedItem {
        id: r.get(0)?,
        source: r.get(1)?,
        collector_id: r.get(2)?,
        title: r.get(3)?,
        url: r.get(4)?,
        content: r.get(5)?,
        metadata: serde_json::from_str(&r.get::<_, String>(6).unwrap_or_default())
            .unwrap_or_default(),
        published_at: r.get::<_, Option<String>>(7)?.and_then(parse_dt),
        collected_at: r
            .get::<_, String>(8)
            .ok()
            .and_then(parse_dt)
            .unwrap_or_else(Utc::now),
        // read_at column is the 10th SELECT field; older databases
        // upgraded via the `ALTER TABLE` migration return None until
        // the user marks things read.
        read_at: r
            .get::<_, Option<String>>(9)
            .ok()
            .flatten()
            .and_then(parse_dt),
        summary: r.get::<_, Option<String>>(10).ok().flatten(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    async fn fresh_db() -> (TempDir, PulseDatabase) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("pulse.db");
        let db = PulseDatabase::new(path.to_str().unwrap()).await.unwrap();
        (dir, db)
    }

    fn raw_item(url: Option<&str>) -> RawItem {
        RawItem {
            source: "test".into(),
            collector_id: "test".into(),
            title: "hello".into(),
            url: url.map(String::from),
            content: Some("body".into()),
            metadata: json!({"k": "v"}),
            published_at: None,
        }
    }

    #[tokio::test]
    async fn insert_and_read_feed() {
        let (_d, db) = fresh_db().await;
        let _ = db
            .insert_item(&raw_item(Some("https://a.example/1")))
            .await
            .unwrap();
        let _ = db
            .insert_item(&raw_item(Some("https://a.example/2")))
            .await
            .unwrap();
        let feed = db.get_feed(10, 0, None, None, false).await.unwrap();
        assert_eq!(feed.len(), 2);
    }

    #[tokio::test]
    async fn item_summary_round_trip() {
        let (_d, db) = fresh_db().await;
        let id = db
            .insert_item(&raw_item(Some("https://a.example/sum")))
            .await
            .unwrap();

        // Fresh items have no summary.
        let item = db.get_item(&id).await.unwrap().expect("item should exist");
        assert!(item.summary.is_none());

        // Round-trip a summary.
        db.set_item_summary(&id, Some("- bullet one\n- bullet two"))
            .await
            .unwrap();
        let item = db.get_item(&id).await.unwrap().unwrap();
        assert_eq!(item.summary.as_deref(), Some("- bullet one\n- bullet two"));

        // Feed query also surfaces the summary, not just get_item.
        let feed = db.get_feed(10, 0, None, None, false).await.unwrap();
        assert_eq!(
            feed[0].summary.as_deref(),
            Some("- bullet one\n- bullet two")
        );

        // Clearing wipes the cache.
        db.set_item_summary(&id, None).await.unwrap();
        let item = db.get_item(&id).await.unwrap().unwrap();
        assert!(item.summary.is_none());

        // Missing id is None, not an error.
        assert!(db.get_item("no-such-id").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn item_exists_by_url_dedup() {
        let (_d, db) = fresh_db().await;
        db.insert_item(&raw_item(Some("https://a.example/dup")))
            .await
            .unwrap();
        assert!(
            db.item_exists_by_url("https://a.example/dup")
                .await
                .unwrap()
        );
        assert!(
            !db.item_exists_by_url("https://a.example/none")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn collector_run_lifecycle() {
        let (_d, db) = fresh_db().await;
        let run = db.start_collector_run("rss").await.unwrap();
        db.finish_collector_run(&run, 5, None).await.unwrap();
        let runs = db.get_collector_status().await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].items_count, 5);
        assert_eq!(runs[0].status, "success");
    }

    #[tokio::test]
    async fn collector_run_with_error() {
        let (_d, db) = fresh_db().await;
        let run = db.start_collector_run("rss").await.unwrap();
        db.finish_collector_run(&run, 0, Some("boom"))
            .await
            .unwrap();
        let runs = db.get_collector_status().await.unwrap();
        assert_eq!(runs[0].status, "error");
        assert_eq!(runs[0].error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn user_feed_crud() {
        let (_d, db) = fresh_db().await;
        db.add_user_feed("HN", "https://hnrss.org").await.unwrap();
        db.add_user_feed("Lobsters", "https://lobste.rs/rss")
            .await
            .unwrap();
        let feeds = db.get_user_feeds().await.unwrap();
        assert_eq!(feeds.len(), 2);
        db.remove_user_feed("https://hnrss.org").await.unwrap();
        let after = db.get_user_feeds().await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].0, "Lobsters");
    }

    #[tokio::test]
    async fn feed_filters_by_source_and_paginates() {
        let (_d, db) = fresh_db().await;
        for i in 0..5 {
            let mut r = raw_item(Some(&format!("https://hn.example/{i}")));
            r.source = "hackernews".into();
            r.collector_id = "hackernews".into();
            db.insert_item(&r).await.unwrap();
        }
        for i in 0..3 {
            let mut r = raw_item(Some(&format!("https://rss.example/{i}")));
            r.source = "rss:lobsters".into();
            r.collector_id = "rss".into();
            db.insert_item(&r).await.unwrap();
        }
        let only_hn = db
            .get_feed(10, 0, Some("hackernews"), None, false)
            .await
            .unwrap();
        assert_eq!(only_hn.len(), 5);
        let only_rss = db.get_feed(10, 0, Some("rss"), None, false).await.unwrap();
        assert_eq!(only_rss.len(), 3);
        let page1 = db.get_feed(2, 0, None, None, false).await.unwrap();
        let page2 = db.get_feed(2, 2, None, None, false).await.unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page2.len(), 2);
        assert_ne!(page1[0].id, page2[0].id);
    }

    #[tokio::test]
    async fn feed_filters_by_search_substring() {
        let (_d, db) = fresh_db().await;
        for (title, content) in [
            ("Rust 1.89 release", "Compiler diagnostics"),
            ("Tauri 2.5 ships", "WebView2 patches"),
            ("Python 3.13 GA", "free-threaded mode"),
        ] {
            let mut r = raw_item(Some(&format!("https://x/{title}")));
            r.title = title.into();
            r.content = Some(content.into());
            db.insert_item(&r).await.unwrap();
        }
        // matches title
        let rust = db.get_feed(10, 0, None, Some("rust"), false).await.unwrap();
        assert_eq!(rust.len(), 1);
        assert!(rust[0].title.contains("Rust"));
        // matches content (case-insensitive)
        let webview = db
            .get_feed(10, 0, None, Some("WEBVIEW"), false)
            .await
            .unwrap();
        assert_eq!(webview.len(), 1);
        assert!(webview[0].title.contains("Tauri"));
        // empty search string is treated as no filter
        let all = db.get_feed(10, 0, None, Some("   "), false).await.unwrap();
        assert_eq!(all.len(), 3);
        // no matches
        let none = db
            .get_feed(10, 0, None, Some("nodejs"), false)
            .await
            .unwrap();
        assert_eq!(none.len(), 0);
    }

    #[tokio::test]
    async fn read_state_round_trip_and_unread_filter() {
        let (_d, db) = fresh_db().await;
        let id_a = db
            .insert_item(&raw_item(Some("https://x/a")))
            .await
            .unwrap();
        let id_b = db
            .insert_item(&raw_item(Some("https://x/b")))
            .await
            .unwrap();
        // both unread initially
        assert_eq!(db.unread_count().await.unwrap(), 2);
        // mark a as read
        let changed = db.mark_item_read(&id_a, true).await.unwrap();
        assert!(changed);
        assert_eq!(db.unread_count().await.unwrap(), 1);
        // marking already-read item again returns false (no-op)
        let changed2 = db.mark_item_read(&id_a, true).await.unwrap();
        assert!(!changed2);
        // unread filter excludes a
        let only_unread = db.get_feed(10, 0, None, None, true).await.unwrap();
        assert_eq!(only_unread.len(), 1);
        assert_eq!(only_unread[0].id, id_b);
        // unmark a
        db.mark_item_read(&id_a, false).await.unwrap();
        assert_eq!(db.unread_count().await.unwrap(), 2);
        // mark all read
        db.mark_all_read().await.unwrap();
        assert_eq!(db.unread_count().await.unwrap(), 0);
        let unread = db.get_feed(10, 0, None, None, true).await.unwrap();
        assert!(unread.is_empty());
    }

    #[tokio::test]
    async fn search_filter_combines_with_unread() {
        let (_d, db) = fresh_db().await;
        let id_a = db
            .insert_item(&{
                let mut r = raw_item(Some("https://x/a"));
                r.title = "Rust 1.89".into();
                r
            })
            .await
            .unwrap();
        db.insert_item(&{
            let mut r = raw_item(Some("https://x/b"));
            r.title = "Rust 1.88".into();
            r
        })
        .await
        .unwrap();
        db.mark_item_read(&id_a, true).await.unwrap();
        // both match "rust" but only b is unread
        let r = db.get_feed(10, 0, None, Some("rust"), true).await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "Rust 1.88");
    }

    #[tokio::test]
    async fn purge_older_than_cutoff() {
        let (_d, db) = fresh_db().await;
        db.insert_item(&raw_item(Some("https://a.example/1")))
            .await
            .unwrap();
        // Future cutoff → everything is "older" than it
        let future = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let n = db.purge_older_than(&future).await.unwrap();
        assert_eq!(n, 1);
        let feed = db.get_feed(10, 0, None, None, false).await.unwrap();
        assert!(feed.is_empty());
    }

    // ── Additional coverage ────────────────────────────────────────

    #[tokio::test]
    async fn concurrent_inserts_dont_corrupt() {
        // Spawn 8 parallel insert tasks, verify all land and the
        // database remains queryable.
        let (_d, db) = fresh_db().await;
        let mut handles = vec![];
        for i in 0..8 {
            let db2 = db.clone();
            handles.push(tokio::spawn(async move {
                for j in 0..5 {
                    let mut r = raw_item(Some(&format!("https://x/{i}/{j}")));
                    r.title = format!("item-{i}-{j}");
                    db2.insert_item(&r).await.unwrap();
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let feed = db.get_feed(100, 0, None, None, false).await.unwrap();
        assert_eq!(feed.len(), 40, "expected 8×5=40 items, got {}", feed.len());
    }

    #[tokio::test]
    async fn settings_kv_round_trip_and_overwrite() {
        let (_d, db) = fresh_db().await;
        // Initially unset.
        assert!(db.get_setting("missing").await.unwrap().is_none());
        // Set then get.
        db.set_setting("k1", Some("v1")).await.unwrap();
        assert_eq!(db.get_setting("k1").await.unwrap().as_deref(), Some("v1"));
        // Overwrite.
        db.set_setting("k1", Some("v2")).await.unwrap();
        assert_eq!(db.get_setting("k1").await.unwrap().as_deref(), Some("v2"));
        // Set None → stored as NULL; get returns None.
        db.set_setting("k1", None).await.unwrap();
        assert!(db.get_setting("k1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn video_channel_crud_idempotent_insert() {
        let (_d, db) = fresh_db().await;
        // First insert.
        db.add_video_channel("youtube", "UCabc", "Alice")
            .await
            .unwrap();
        let rows = db.get_video_channels().await.unwrap();
        assert_eq!(rows.len(), 1);
        // Duplicate key insert with updated display name — should UPSERT.
        db.add_video_channel("youtube", "UCabc", "Alice Renamed")
            .await
            .unwrap();
        let rows = db.get_video_channels().await.unwrap();
        assert_eq!(rows.len(), 1, "duplicate key should UPSERT not append");
        assert_eq!(rows[0].2, "Alice Renamed");
        // Different platform with same channel_id is a different row.
        db.add_video_channel("bilibili", "UCabc", "Bob")
            .await
            .unwrap();
        let rows = db.get_video_channels().await.unwrap();
        assert_eq!(rows.len(), 2);
        // Remove one.
        db.remove_video_channel("youtube", "UCabc").await.unwrap();
        let rows = db.get_video_channels().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "bilibili");
    }

    #[tokio::test]
    async fn dedup_url_dedup_with_sql_meta_chars() {
        let (_d, db) = fresh_db().await;
        let evil = "https://example.com/feed?q=' OR 1=1--";
        db.insert_item(&raw_item(Some(evil))).await.unwrap();
        assert!(db.item_exists_by_url(evil).await.unwrap());
        assert!(
            !db.item_exists_by_url("https://other.example/x")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn mark_unknown_item_read_returns_false() {
        let (_d, db) = fresh_db().await;
        let changed = db.mark_item_read("never-existed", true).await.unwrap();
        assert!(!changed, "marking nonexistent should return false");
    }

    #[tokio::test]
    async fn user_feed_replace_on_same_url() {
        // INSERT OR REPLACE → same URL, new name overrides.
        let (_d, db) = fresh_db().await;
        db.add_user_feed("First", "https://a.example/feed")
            .await
            .unwrap();
        db.add_user_feed("Second", "https://a.example/feed")
            .await
            .unwrap();
        let feeds = db.get_user_feeds().await.unwrap();
        assert_eq!(feeds.len(), 1);
        assert_eq!(feeds[0].0, "Second");
    }

    #[tokio::test]
    async fn feed_limit_offset_clamps_at_table_end() {
        let (_d, db) = fresh_db().await;
        for i in 0..3 {
            db.insert_item(&raw_item(Some(&format!("https://x/{i}"))))
                .await
                .unwrap();
        }
        // Offset past the end → empty result, not error.
        let v = db.get_feed(10, 100, None, None, false).await.unwrap();
        assert!(v.is_empty());
        // Limit 0 → empty.
        let v = db.get_feed(0, 0, None, None, false).await.unwrap();
        assert!(v.is_empty());
    }

    #[tokio::test]
    async fn collector_status_returns_runs_in_recent_first_order() {
        let (_d, db) = fresh_db().await;
        let r1 = db.start_collector_run("rss").await.unwrap();
        db.finish_collector_run(&r1, 2, None).await.unwrap();
        // Sleep so collected_at strictly increases.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let r2 = db.start_collector_run("hn").await.unwrap();
        db.finish_collector_run(&r2, 4, None).await.unwrap();
        let runs = db.get_collector_status().await.unwrap();
        assert_eq!(runs.len(), 2);
        // Most-recent first.
        assert_eq!(runs[0].collector_id, "hn");
        assert_eq!(runs[1].collector_id, "rss");
    }
}
