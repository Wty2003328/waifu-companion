import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HTTP_BASE,
  getDefaultServerUrl,
  getServerUrl,
  getStoredServerUrl,
  setStoredServerUrl,
} from '../lib/apiBase';

interface CompanionStatus {
  ok: boolean;
  zeroclaw_up: boolean;
  avatar_enabled: boolean;
  pulse_enabled?: boolean;
}

export default function Home() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Settings for the companion server URL.
  const [serverInput, setServerInput] = useState<string>(getStoredServerUrl());
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${HTTP_BASE}/api/status`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const data: CompanionStatus = await r.json();
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleSaveUrl = () => {
    const trimmed = serverInput.trim();
    setStoredServerUrl(trimmed);
    setSavedHint(
      trimmed
        ? `Saved. Reload the page for ${trimmed} to take effect.`
        : 'Cleared. Reload the page to use the default.'
    );
    setTimeout(() => setSavedHint(null), 4000);
  };

  const handleClearUrl = () => {
    setStoredServerUrl('');
    setServerInput('');
    setSavedHint('Cleared. Reload the page to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };

  const effectiveUrl = getServerUrl();
  const isUsingDefault = !getStoredServerUrl();

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0, fontSize: 28 }}>zeroclaw companion</h1>
      <p style={{ color: '#888', lineHeight: 1.6, marginTop: -4 }}>
        Live2D avatar + Pulse dashboard, decoupled from the upstream zeroclaw daemon. Talks to
        zeroclaw over its public REST + SSE API — no fork-side patches required.
      </p>

      <section style={{ background: '#16181c', borderRadius: 10, padding: 20, marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Status</h2>
        {error && <div style={{ color: '#ef4444', marginTop: 8 }}>error: {error}</div>}
        {status && (
          <table style={{ width: '100%', marginTop: 8, fontSize: 14 }}>
            <tbody>
              <Row label="companion-server" ok={status.ok} value={status.ok ? 'running' : 'down'} />
              <Row
                label="upstream zeroclaw"
                ok={status.zeroclaw_up}
                value={status.zeroclaw_up ? 'connected' : 'unreachable'}
              />
              <Row
                label="avatar"
                ok={status.avatar_enabled}
                value={status.avatar_enabled ? 'enabled' : 'disabled in config'}
              />
              {status.pulse_enabled !== undefined && (
                <Row
                  label="pulse"
                  ok={status.pulse_enabled}
                  value={status.pulse_enabled ? 'enabled' : 'disabled in config'}
                />
              )}
            </tbody>
          </table>
        )}
        {!status && !error && <div style={{ color: '#888', marginTop: 8 }}>checking…</div>}
      </section>

      <section style={{ background: '#16181c', borderRadius: 10, padding: 20, marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Server connection</h2>
        <p style={{ color: '#888', fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          Where this UI looks for companion-server. Leave empty for the default
          ({getDefaultServerUrl()}). Useful if companion-server is on another
          machine or a non-default port.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveUrl()}
            placeholder={`${getDefaultServerUrl()}  (default)`}
            style={{
              flex: '1 1 280px',
              minWidth: 220,
              background: '#0b0d10',
              color: '#fff',
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #2a2d33',
              fontSize: 13,
              fontFamily: 'monospace',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleSaveUrl}
            style={{
              padding: '8px 14px',
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleClearUrl}
            disabled={isUsingDefault}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: '#888',
              border: '1px solid #2a2d33',
              borderRadius: 6,
              fontSize: 13,
              cursor: isUsingDefault ? 'not-allowed' : 'pointer',
              opacity: isUsingDefault ? 0.4 : 1,
            }}
          >
            Reset
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: savedHint ? '#10b981' : '#666' }}>
          {savedHint ?? `Currently using: ${effectiveUrl}${isUsingDefault ? ' (default)' : ' (custom)'}`}
        </div>
      </section>

      <section style={{ background: '#16181c', borderRadius: 10, padding: 20, marginTop: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Open</h2>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <Link
            to="/avatar"
            style={{
              padding: '10px 18px',
              background: '#3b82f6',
              color: '#fff',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Live2D avatar
          </Link>
          <Link
            to="/pulse"
            style={{
              padding: '10px 18px',
              background: '#1f2937',
              color: '#fff',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Pulse dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}

function Row({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <tr>
      <td style={{ padding: '6px 0', color: '#aaa' }}>{label}</td>
      <td style={{ padding: '6px 0', textAlign: 'right' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: ok ? '#10b981' : '#ef4444',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: ok ? '#10b981' : '#ef4444',
            }}
          />
          {value}
        </span>
      </td>
    </tr>
  );
}
