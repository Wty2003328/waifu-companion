# Pulse migration plan

`companion-pulse` is currently a stub. This document tracks what's left to
port from the fork's `src/pulse/` and `web/src/components/pulse/` into the
companion repo.

## Source inventory (in the fork)

```
src/pulse/
├── api_calendar.rs     ─┐
├── api_feed.rs          │
├── api_settings.rs      │  REST handlers — needs reimplementation
├── api_system.rs        │  on companion-server's axum router
├── collectors/
│   ├── github.rs       ─┐
│   ├── hackernews.rs    │
│   ├── reddit.rs        │  All collectors run periodically and push
│   ├── rss.rs           │  results into storage. Self-contained
│   ├── stocks.rs        │  modulo HTTP client.
│   ├── videos.rs        │
│   └── weather.rs      ─┘
├── config.rs            ──> moves into companion.toml [pulse] block
├── config_loader.rs     ──> companion-core handles config loading
├── models.rs            ──> domain types (Item, Source, Digest, …)
├── scheduler.rs         ──> tokio task that ticks each collector on its cadence
└── storage.rs           ──> SQLite-backed feed/digest storage

web/src/components/pulse/   ~2,300 LOC of widgets, settings, dashboard
web/src/types/pulse.ts
web/src/hooks/useWidgetData.ts
web/src/lib/pulseUtils.ts
```

## Migration plan

### Step 1 — Domain + storage (smallest, do first)
Port `models.rs` and `storage.rs` to `crates/companion-pulse/src/`. The
storage layer is SQLite-backed and self-contained. No companion-server
changes required yet.

### Step 2 — Collectors
Port collectors one at a time, starting with `rss.rs` (simplest, least
external API surface). Each collector implements a small `Collector`
trait and writes to storage. The scheduler is a single tokio task that
loops over enabled collectors at their configured cadence.

### Step 3 — REST API on companion-server
Reimplement `api_feed.rs` / `api_calendar.rs` / `api_system.rs` /
`api_settings.rs` as axum handlers in `apps/companion-server/src/api/`.
Add a `PulseSubsystem` field to `AppState` and mount routes when
`[pulse] enabled = true`.

### Step 4 — Frontend port
Copy `web/src/components/pulse/` into the companion's `web/src/`. The
fork uses Tailwind + custom theme tokens; the companion currently uses
inline styles. Two options:

- **(a)** keep the fork's Tailwind + `pulseUtils` and just paste the
  components in. ~1 hour, but the companion picks up Tailwind as a
  dep.
- **(b)** rewrite the widget styling inline like Avatar.tsx. ~2–3 hours,
  but no new build deps.

### Step 5 — Wire into nav
Replace `pages/Pulse.tsx` (currently a placeholder) with the real
dashboard component.

## Estimated effort

- Steps 1–3: 4–6 hours of focused porting (reasonably mechanical)
- Step 4: 1–3 hours depending on style choice
- Step 5: 30 minutes

Total: one focused session.

## Out of scope for this migration

- Calendar sync (the fork's calendar widget uses Google Calendar; if we
  want this in companion we should consume zeroclaw's existing Google
  Workspace integration over its API rather than re-implementing OAuth).
- Email digests (same reasoning; route through zeroclaw's email channel).

These are *features* that should layer on top of the basic Pulse
dashboard once the rest is ported.
