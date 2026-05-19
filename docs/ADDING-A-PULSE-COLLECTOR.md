# Adding a Pulse collector

Pulse is the SQLite-backed feed dashboard inside the companion. It
already supports RSS / Atom, Hacker News, GitHub releases, and YouTube
channels. New sources plug in via the `Collector` trait — implement
it once, register it, and the scheduler picks up the rest.

## The trait

In `crates/companion-pulse/src/collectors.rs`:

```rust
#[async_trait::async_trait]
pub trait Collector: Send + Sync {
    /// Stable identifier — used in companion.toml and the UI to
    /// reference this collector type. Lowercase, kebab-case.
    fn kind(&self) -> &'static str;

    /// Fetch the latest items from `source_url`. Return them in the
    /// order the upstream emitted them (collector layer dedupes by
    /// `external_id` against the SQLite store before insert).
    async fn fetch(
        &self,
        source_url: &str,
        last_seen_external_id: Option<&str>,
    ) -> anyhow::Result<Vec<PulseItem>>;
}
```

`PulseItem` is the storage row shape — title, link, optional summary,
publish time, an `external_id` you choose to dedupe on. The full
definition is in `crates/companion-pulse/src/models.rs`.

## Steps

### 1. Implement the trait

```rust
// crates/companion-pulse/src/collectors.rs

pub struct MyCollector {
    http: reqwest::Client,
}

#[async_trait::async_trait]
impl Collector for MyCollector {
    fn kind(&self) -> &'static str {
        "mycollector"
    }

    async fn fetch(
        &self,
        source_url: &str,
        last_seen: Option<&str>,
    ) -> anyhow::Result<Vec<PulseItem>> {
        // 1. Hit the upstream API. reqwest is already in deps.
        // 2. Parse the response (likely JSON or XML).
        // 3. Map each upstream entry → PulseItem. Choose an
        //    external_id that's stable across re-fetches — a URL or
        //    upstream-assigned ID, not a timestamp.
        // 4. If last_seen is Some, you may stop pagination once you
        //    see it (an optimization; not required — the storage
        //    layer will dedupe regardless).
        Ok(vec![])
    }
}
```

### 2. Register it

In `crates/companion-pulse/src/lib.rs` (or wherever the active
collector registry lives — grep for the existing `RssCollector`
registration):

```rust
let mut collectors: Vec<Arc<dyn Collector>> = vec![
    Arc::new(RssCollector::new(http.clone())),
    Arc::new(HackerNewsCollector::new(http.clone())),
    // ...
    Arc::new(MyCollector { http: http.clone() }),
];
```

### 3. Add tests

The existing collectors have unit tests under
`crates/companion-pulse/src/collectors.rs`'s `mod tests`. The pattern:
spin up an `axum`-based mock server in the test, point your collector
at it, assert the parsed `PulseItem` shape. SQLite isn't touched —
the trait test is pure-collector.

```rust
#[tokio::test]
async fn mycollector_parses_a_typical_response() {
    let mock = spawn_mock(|| /* canned response body */ ).await;
    let collector = MyCollector { http: reqwest::Client::new() };

    let items = collector.fetch(&mock.url, None).await.unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0].external_id, "expected-id");
}
```

`cargo test -p companion-pulse` should be green.

### 4. Make it configurable in the UI

The Pulse Settings panel reads the registered collectors and renders
"Add source" UI for each kind. As long as `kind()` returns the new
string and the collector is in the registry, the UI picks it up
automatically — no frontend changes needed for the basic case.

If your collector needs extra config beyond `source_url` (e.g., an
API token, a filter), you'll need to:

1. Add the field(s) to `PulseFeedConfig` in `companion-pulse/src/models.rs`.
2. Plumb them through the storage layer and the Pulse REST handlers.
3. Add the form fields in `web/src/pages/Pulse.tsx`.

That's a larger change; the four built-in collectors are all
URL-only, so it's untrodden ground — happy to review designs in an
issue first.

### 5. Document it

Add a brief mention in the README's Pulse section and (if config-only)
a sample entry in `companion.toml.example`. That's the full loop.
