import { useEffect, useState, useCallback, useMemo } from 'react';
import { HTTP_BASE } from '../lib/apiBase';

// ── Types mirroring /api/pulse responses ─────────────────────────

interface FeedItem {
  id: string;
  source: string;
  collector_id: string;
  title: string;
  url: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  published_at: string | null;
  collected_at: string;
}
interface CollectorInfo { id: string; name: string; enabled: boolean; interval_secs: number; }
interface CollectorRun {
  id: string;
  collector_id: string;
  started_at: string;
  finished_at: string | null;
  items_count: number;
  status: string;
  error: string | null;
}
interface PulseStatus { collectors: CollectorInfo[]; runs: CollectorRun[]; }
interface RssFeed { name: string; url: string; }
interface VideoChannel { platform: string; channel_id: string; display_name: string; }

type Tab = 'feed' | 'sources' | 'settings';

// ── Page ─────────────────────────────────────────────────────────

export default function Pulse() {
  const [tab, setTab] = useState<Tab>('feed');
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Pulse</h1>
        <span style={{ flex: 1 }} />
        <Tabs current={tab} onChange={setTab} />
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {tab === 'feed' && <FeedTab onError={setError} />}
      {tab === 'sources' && <SourcesTab onError={setError} />}
      {tab === 'settings' && <SettingsTab onError={setError} />}
    </div>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: 'feed', label: 'Feed' },
    { id: 'sources', label: 'Sources' },
    { id: 'settings', label: 'Settings' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, background: '#16181c', padding: 4, borderRadius: 8, border: '1px solid #2a2d33' }}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: current === it.id ? '#3b82f6' : 'transparent',
            color: current === it.id ? '#fff' : '#aaa',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── Feed tab ─────────────────────────────────────────────────────

function FeedTab({ onError }: { onError: (m: string) => void }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<PulseStatus | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filter) params.set('source', filter);
      const [feedR, statusR] = await Promise.all([
        fetch(`${HTTP_BASE}/api/pulse/feed?${params}`),
        fetch(`${HTTP_BASE}/api/pulse/status`),
      ]);
      const looksDisabled = (r: Response) =>
        r.status === 404 ||
        !(r.headers.get('content-type') ?? '').toLowerCase().includes('json');
      if (looksDisabled(feedR) || looksDisabled(statusR)) {
        onError('Pulse is disabled in companion.toml. Set [pulse] enabled = true to use this.');
        setItems([]);
        setStatus(null);
        return;
      }
      if (!feedR.ok) throw new Error(`feed ${feedR.status}`);
      if (!statusR.ok) throw new Error(`status ${statusR.status}`);
      const feed = await feedR.json();
      const stat = await statusR.json();
      setItems(feed.items ?? []);
      setStatus(stat);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, onError]);

  useEffect(() => {
    void fetchAll();
    const id = setInterval(fetchAll, 30_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const trigger = async (cid: string) => {
    try {
      await fetch(`${HTTP_BASE}/api/pulse/trigger/${cid}`, { method: 'POST' });
      setTimeout(fetchAll, 1000);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Client-side title/content/source filter so a 100-item window can
  // be refined without re-querying the server.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.title} ${it.source} ${it.content ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, search]);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search title / source / body…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: '1 1 240px',
            background: '#0b0d10',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 6,
            border: '1px solid #2a2d33',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: '#16181c',
            color: '#fff',
            border: '1px solid #2a2d33',
            padding: '7px 10px',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <option value="">All sources</option>
          {status?.collectors.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={fetchAll}
          disabled={loading}
          style={refreshBtn(loading)}
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {status && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 12, color: '#888', marginBottom: 8, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Collectors
          </h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {status.collectors.map((c) => (
              <CollectorChip
                key={c.id}
                collector={c}
                lastRun={status.runs.find((r) => r.collector_id === c.id)}
                onTrigger={() => trigger(c.id)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 style={{ fontSize: 12, color: '#888', marginBottom: 8, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {search ? `Filtered (${filtered.length} of ${items.length})` : `Recent items (${items.length})`}
        </h2>
        {filtered.length === 0 && !loading && (
          <div style={{ color: '#666', fontSize: 13 }}>
            {search
              ? `No items match "${search}".`
              : 'No items yet. Wait for the next collector tick or click "Run now" above.'}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((item) => <FeedRow key={item.id} item={item} />)}
        </div>
      </section>
    </>
  );
}

function CollectorChip({
  collector, lastRun, onTrigger,
}: {
  collector: CollectorInfo;
  lastRun: CollectorRun | undefined;
  onTrigger: () => void;
}) {
  const tone = lastRun?.status === 'error' ? '#fca5a5' : lastRun?.status === 'ok' ? '#10b981' : '#888';
  return (
    <div style={{ padding: '10px 14px', background: '#16181c', borderRadius: 8, fontSize: 12, border: '1px solid #2a2d33', minWidth: 180 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{collector.name}</div>
      <div style={{ color: '#888' }}>every {fmtInterval(collector.interval_secs)} · {collector.enabled ? 'on' : 'off'}</div>
      <div style={{ color: tone, marginTop: 2 }}>
        last: {lastRun ? `${lastRun.items_count} items · ${lastRun.status}` : '—'}
      </div>
      <button type="button" onClick={onTrigger} style={runBtn}>Run now</button>
    </div>
  );
}

// ── Sources tab — RSS feeds + Video channels ─────────────────────

function SourcesTab({ onError }: { onError: (m: string) => void }) {
  const [feeds, setFeeds] = useState<RssFeed[]>([]);
  const [videos, setVideos] = useState<VideoChannel[]>([]);

  const reload = useCallback(async () => {
    try {
      const [fr, vr] = await Promise.all([
        fetch(`${HTTP_BASE}/api/pulse/feeds`),
        fetch(`${HTTP_BASE}/api/pulse/videos`),
      ]);
      if (!fr.ok || !vr.ok) throw new Error('list failed');
      const fj = await fr.json();
      const vj = await vr.json();
      setFeeds(fj.feeds ?? []);
      setVideos(vj.videos ?? []);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
      <RssFeedsPanel feeds={feeds} reload={reload} onError={onError} />
      <VideoChannelsPanel videos={videos} reload={reload} onError={onError} />
    </div>
  );
}

function RssFeedsPanel({ feeds, reload, onError }: { feeds: RssFeed[]; reload: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    try {
      const r = await fetch(`${HTTP_BASE}/api/pulse/feeds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      setName(''); setUrl('');
      reload();
    } catch (e) { onError((e as Error).message); }
  };
  const remove = async (u: string) => {
    try {
      const r = await fetch(`${HTTP_BASE}/api/pulse/feeds?url=${encodeURIComponent(u)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      reload();
    } catch (e) { onError((e as Error).message); }
  };
  return (
    <Panel title="RSS feeds">
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={inputStyle} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" style={inputStyle} />
        <button type="button" onClick={add} style={primaryBtn}>Add</button>
      </div>
      {feeds.length === 0 ? (
        <div style={{ fontSize: 12, color: '#666' }}>No user-managed feeds. The collector also runs the static list in companion.toml.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {feeds.map((f) => (
            <li key={f.url} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{f.name}</div>
                <div style={{ fontSize: 11, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.url}
                </div>
              </div>
              <button type="button" onClick={() => remove(f.url)} style={dangerBtn}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function VideoChannelsPanel({ videos, reload, onError }: { videos: VideoChannel[]; reload: () => void; onError: (m: string) => void }) {
  const [platform, setPlatform] = useState<'youtube' | 'bilibili'>('youtube');
  const [channelId, setChannelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const add = async () => {
    if (!channelId.trim() || !displayName.trim()) return;
    try {
      const r = await fetch(`${HTTP_BASE}/api/pulse/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, channel_id: channelId.trim(), display_name: displayName.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      setChannelId(''); setDisplayName('');
      reload();
    } catch (e) { onError((e as Error).message); }
  };
  const remove = async (p: string, id: string) => {
    try {
      const u = new URLSearchParams({ platform: p, channel_id: id });
      const r = await fetch(`${HTTP_BASE}/api/pulse/videos?${u}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      reload();
    } catch (e) { onError((e as Error).message); }
  };
  return (
    <Panel title="Video subscriptions">
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <select value={platform} onChange={(e) => setPlatform(e.target.value as 'youtube' | 'bilibili')} style={{ ...inputStyle, flex: '0 0 100px' }}>
          <option value="youtube">YouTube</option>
          <option value="bilibili">Bilibili</option>
        </select>
        <input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder={platform === 'youtube' ? 'UC… channel ID' : 'Bilibili UID'} style={{ ...inputStyle, flex: 1 }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" style={inputStyle} />
        <button type="button" onClick={add} style={primaryBtn}>Add</button>
      </div>
      {videos.length === 0 ? (
        <div style={{ fontSize: 12, color: '#666' }}>No subscribed channels.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {videos.map((v) => (
            <li key={`${v.platform}:${v.channel_id}`} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{v.display_name}</div>
                <div style={{ fontSize: 11, color: '#666' }}>
                  <span style={{ color: '#888', marginRight: 6 }}>{v.platform}</span>{v.channel_id}
                </div>
              </div>
              <button type="button" onClick={() => remove(v.platform, v.channel_id)} style={dangerBtn}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Settings tab — RSSHub URL etc. ───────────────────────────────

function SettingsTab({ onError }: { onError: (m: string) => void }) {
  const [rsshub, setRsshub] = useState('');
  const [savedRsshub, setSavedRsshub] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${HTTP_BASE}/api/pulse/settings/rsshub_url`)
      .then((r) => r.ok ? r.json() : Promise.reject(`status ${r.status}`))
      .then((j) => {
        setRsshub(j.value ?? '');
        setSavedRsshub(j.value ?? '');
      })
      .catch((e) => onError(String(e)));
  }, [onError]);

  const save = async () => {
    try {
      const r = await fetch(`${HTTP_BASE}/api/pulse/settings/rsshub_url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: rsshub.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSavedRsshub(rsshub.trim());
    } catch (e) { onError((e as Error).message); }
  };

  const dirty = rsshub.trim() !== (savedRsshub ?? '');
  return (
    <Panel title="Pulse settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 12, color: '#888' }}>RSSHub instance URL</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={rsshub}
            onChange={(e) => setRsshub(e.target.value)}
            placeholder="https://rsshub.app  (leave empty for the public instance)"
            style={inputStyle}
          />
          <button type="button" onClick={save} disabled={!dirty} style={{ ...primaryBtn, opacity: dirty ? 1 : 0.4 }}>
            Save
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
          Used by the video collector for Bilibili. Self-host RSSHub
          (<a href="https://docs.rsshub.app/install/" target="_blank" rel="noreferrer" style={{ color: '#7aa9ff' }}>docs</a>)
          to dodge rate limits and region blocks. Empty = use the public
          instance at <code>https://rsshub.app</code>.
        </div>
      </div>
    </Panel>
  );
}

// ── Shared bits ──────────────────────────────────────────────────

function FeedRow({ item }: { item: FeedItem }) {
  return (
    <article style={{ padding: 14, background: '#16181c', borderRadius: 8, border: '1px solid #1f2227' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
        {item.source} · {fmtDate(item.published_at ?? item.collected_at)}
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" style={{ color: '#fff', textDecoration: 'none' }}>
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </div>
      {item.content && (
        <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
          {stripHtml(item.content).slice(0, 280)}
          {item.content.length > 280 ? '…' : ''}
        </div>
      )}
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: '#16181c', borderRadius: 10, padding: 16, border: '1px solid #1f2227' }}>
      <h2 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{ padding: 12, background: '#1f1316', color: '#fca5a5', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1 }}>{message}</span>
      <button type="button" onClick={onDismiss} style={{ background: 'transparent', color: '#fca5a5', border: '1px solid #5a2a2a', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
        dismiss
      </button>
    </div>
  );
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtInterval(secs: number): string {
  if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
  if (secs >= 60) return `${Math.round(secs / 60)}m`;
  return `${secs}s`;
}
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const inputStyle: React.CSSProperties = {
  background: '#0b0d10', color: '#fff', padding: '6px 10px', borderRadius: 6,
  border: '1px solid #2a2d33', fontSize: 12, outline: 'none', flex: 1, minWidth: 0,
};
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', background: '#3b82f6', color: '#fff', border: 'none',
  borderRadius: 6, fontSize: 12, cursor: 'pointer', flexShrink: 0,
};
const dangerBtn: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent', color: '#fca5a5', border: '1px solid #4b2a2a',
  borderRadius: 4, fontSize: 11, cursor: 'pointer', flexShrink: 0,
};
const runBtn: React.CSSProperties = {
  marginTop: 8, padding: '4px 10px', background: '#3b82f6', color: '#fff', border: 'none',
  borderRadius: 4, fontSize: 11, cursor: 'pointer',
};
const refreshBtn = (loading: boolean): React.CSSProperties => ({
  padding: '7px 14px', background: '#1f2937', color: '#fff', border: 'none',
  borderRadius: 6, fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
});
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
  background: '#0e1014', borderRadius: 4, border: '1px solid #1f2227',
};
