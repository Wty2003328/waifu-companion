import { useEffect, useState } from 'react';
import {
  HTTP_BASE,
  getDefaultServerUrl,
  getServerUrl,
  getStoredServerUrl,
  setStoredServerUrl,
} from '../lib/apiBase';
import { cachedJson, useCachedJson } from '../lib/fetchCache';
import CharacterRoster from '../components/CharacterRoster';
import { tokens, monoInputStyle } from '../lib/theme';

interface CompanionStatus {
  ok: boolean;
  zeroclaw_up: boolean;
  avatar_enabled: boolean;
  pulse_enabled?: boolean;
}

/**
 * Home — primary page. Character roster is the main content; status
 * + companion-service URL are tucked into collapsible panels at the
 * top of the page so they're available without dominating.
 */
export default function Home() {
  return (
    // Outer: scrollable flex item that fills the routes wrapper.
    // Inner: centered content with max-width + horizontal padding.
    <div style={{
      flex: '1 1 0', minHeight: 0, overflow: 'auto',
      // Promote scroll container to its own compositor layer + clip
      // repaints inside it. Without `contain: paint`, scrolling here
      // can invalidate the entire window's paint tree on each frame.
      contain: 'paint',
      overscrollBehavior: 'contain',
    }}>
      <div style={{ padding: '40px 32px', maxWidth: 880, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{
            margin: 0, fontSize: tokens.fontPage, fontWeight: 700,
            letterSpacing: '-0.01em', color: tokens.text,
          }}>
            waifu-companion
          </h1>
          <p style={{
            color: tokens.textMuted, fontSize: 13, lineHeight: 1.55,
            margin: '6px 0 0 0',
          }}>
            Manage your characters and check that the agent's listening.
          </p>
        </header>
        <SystemPanels />
        <div style={{ marginTop: 24 }}>
          <CharacterRoster />
        </div>
      </div>
    </div>
  );
}

/** Status + server-connection collapsibles, side-by-side rhythm with
 *  the rest of the dark UI (matches the Settings section styling). */
function SystemPanels() {
  const [statusOpen, setStatusOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  // Cached status — instant on revisit (5s TTL). The poll below
  // forces a fresh read every 5s independent of TTL so the badge
  // dots stay live.
  const url = `${HTTP_BASE}/api/status`;
  const { data: status, error } = useCachedJson<CompanionStatus>(url, 5_000);
  useEffect(() => {
    const id = setInterval(() => {
      void cachedJson(url, { force: true }).catch(() => { /* error surfaced via hook */ });
    }, 5_000);
    return () => clearInterval(id);
  }, [url]);

  // Compact summary for the collapsed title row.
  const dot = (ok: boolean) => (
    <span style={{
      width: 7, height: 7, borderRadius: '50%',
      background: ok ? tokens.success : tokens.danger,
      display: 'inline-block', marginRight: 6, flexShrink: 0,
    }} />
  );
  const summary = !status ? (
    <span style={{ color: tokens.textDim, fontSize: 12 }}>checking…</span>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontSize: 12, color: tokens.textMuted }}>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>{dot(status.ok)}server</span>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>{dot(status.zeroclaw_up)}agent</span>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>{dot(status.avatar_enabled)}avatar</span>
      {status.pulse_enabled !== undefined &&
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>{dot(status.pulse_enabled)}pulse</span>}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <CollapsibleRow
        title="Status"
        rightSummary={summary}
        open={statusOpen}
        onToggle={() => setStatusOpen((v) => !v)}
      >
        {error && (
          <div style={{
            color: tokens.danger, fontSize: 12.5, marginBottom: 8,
            lineHeight: 1.5,
          }}>error: {error}</div>
        )}
        {status && (
          <table style={{ width: '100%', fontSize: 13 }}>
            <tbody>
              <StatusRow label="App service" ok={status.ok} value={status.ok ? 'running' : 'not running'} />
              <StatusRow label="Main agent" ok={status.zeroclaw_up} value={status.zeroclaw_up ? 'connected' : "can't reach"} />
              <StatusRow label="Avatar" ok={status.avatar_enabled} value={status.avatar_enabled ? 'on' : 'off in config'} />
              {status.pulse_enabled !== undefined && (
                <StatusRow label="Pulse" ok={status.pulse_enabled} value={status.pulse_enabled ? 'on' : 'off in config'} />
              )}
            </tbody>
          </table>
        )}
      </CollapsibleRow>

      <CollapsibleRow
        title="Companion service URL"
        rightSummary={
          <span style={{
            fontSize: 12, color: tokens.textDim,
            fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
          }}>
            {getServerUrl()}
          </span>
        }
        open={serverOpen}
        onToggle={() => setServerOpen((v) => !v)}
      >
        <ServerConnectionForm />
      </CollapsibleRow>
    </div>
  );
}

function CollapsibleRow({
  title, rightSummary, open, onToggle, children,
}: {
  title: string;
  rightSummary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: tokens.bgPanel,
      border: `1px solid ${tokens.border}`,
      borderRadius: tokens.radius,
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={onToggle}
        className="ws-btn"
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '11px 16px', background: 'transparent', border: 'none',
          color: tokens.text, fontSize: 13, cursor: 'pointer', textAlign: 'left',
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 11, color: tokens.textDim, width: 12, textAlign: 'center' }}>
          {open ? '▾' : '▸'}
        </span>
        <span style={{ fontWeight: 500 }}>{title}</span>
        <span style={{ flex: 1 }} />
        {rightSummary}
      </button>
      {open && (
        <div style={{
          padding: '4px 16px 16px 40px',
          borderTop: `1px solid ${tokens.border}`,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Editor for the companion-server URL stored in localStorage. */
function ServerConnectionForm() {
  const [serverInput, setServerInput] = useState<string>(getStoredServerUrl());
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const handleSave = () => {
    const trimmed = serverInput.trim();
    setStoredServerUrl(trimmed);
    setSavedHint(
      trimmed
        ? `Saved. Reload the page for ${trimmed} to take effect.`
        : 'Cleared. Reload the page to use the default.',
    );
    setTimeout(() => setSavedHint(null), 4000);
  };
  const handleClear = () => {
    setStoredServerUrl('');
    setServerInput('');
    setSavedHint('Cleared. Reload the page to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };
  const isUsingDefault = !getStoredServerUrl();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
      <p style={{ color: tokens.textMuted, fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
        Where this UI reaches its background service. Leave blank for
        the default ({getDefaultServerUrl()}). Only change this if
        you've moved the service to a different machine or port.{' '}
        <strong>Not</strong> the agent URL — set that in <em>Settings → Main agent</em>.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={serverInput}
          onChange={(e) => setServerInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          placeholder={`${getDefaultServerUrl()}  (default)`}
          style={monoInputStyle}
        />
        <button
          type="button"
          onClick={handleSave}
          className="ws-btn ws-btn--primary"
          style={{
            padding: '8px 14px', background: tokens.primary, color: '#fff',
            border: `1px solid ${tokens.primary}`,
            borderRadius: tokens.radiusSm,
            fontSize: 12.5, fontWeight: 500, cursor: 'pointer', minHeight: 34,
          }}
        >Save</button>
        <button
          type="button"
          onClick={handleClear}
          disabled={isUsingDefault}
          className="ws-btn"
          style={{
            padding: '8px 14px', background: 'transparent',
            color: tokens.textMuted,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radiusSm,
            fontSize: 12.5, fontWeight: 500,
            cursor: isUsingDefault ? 'not-allowed' : 'pointer',
            opacity: isUsingDefault ? 0.45 : 1, minHeight: 34,
          }}
        >Reset</button>
      </div>
      {savedHint && <div style={{ fontSize: 12, color: tokens.success, lineHeight: 1.5 }}>{savedHint}</div>}
    </div>
  );
}

function StatusRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <tr>
      <td style={{ padding: '5px 0', color: tokens.textMuted }}>{label}</td>
      <td style={{ padding: '5px 0', textAlign: 'right' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          color: ok ? tokens.success : tokens.danger,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: ok ? tokens.success : tokens.danger,
          }} />
          {value}
        </span>
      </td>
    </tr>
  );
}
