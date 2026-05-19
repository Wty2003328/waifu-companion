/**
 * Main-agent editor — points the companion at a (possibly remote)
 * agent daemon (zeroclaw / openclaw / hermes / custom). The companion
 * never gives the agent access to the machine it runs on; it just POSTs
 * chat to the agent's `/webhook` (or `/v1/chat/completions`) and
 * renders the reply.
 */

import { useState } from 'react';
import { HTTP_BASE } from '../../lib/apiBase';
import { tokens, inputStyle, monoInputStyle } from '../../lib/theme';
import type { ZeroclawConfigView } from './types';
import { Button, EditorFooter, FieldRow, Hint, saveErrorMessage } from './primitives';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? inv : null;
}

/** Known agent kinds and the metadata the UI needs to present them.
 *  Keep this in sync with `AgentKind` in companion-core/src/config.rs. */
export const AGENT_KINDS: Array<{
  id: 'zeroclaw' | 'openclaw' | 'hermes' | 'custom';
  label: string;
  port: number;
  blurb: string;
}> = [
  {
    id: 'zeroclaw',
    label: 'zeroclaw (Rust, /webhook)',
    port: 42617,
    blurb: 'Talks to a zeroclaw gateway. POSTs {message} to /webhook.',
  },
  {
    id: 'openclaw',
    label: 'openclaw (Node, /v1/chat/completions)',
    port: 18790,
    blurb:
      'Talks to an openclaw gateway via its OpenAI-compatible /v1/chat/completions endpoint. ' +
      'A pairing token is required when openclaw is bound to LAN.',
  },
  {
    id: 'hermes',
    label: 'hermes-agent (via bridge, /webhook)',
    port: 18791,
    blurb:
      'Talks to the hermes-bridge.py shim (POST /webhook). The shim shells out to ' +
      '`hermes -z "<message>"` since hermes-agent has no built-in synchronous HTTP chat. ' +
      'See README → "Running hermes" for the bridge.',
  },
  {
    id: 'custom',
    label: 'custom (/webhook)',
    port: 42617,
    blurb:
      'Anything else that speaks the zeroclaw /webhook shape (`{"message"}` → `{"response"}`). ' +
      'Point this at any compatible URL.',
  },
];

/** Edits the connection to the (possibly remote) agent daemon.
 *  Lets the user point the companion at an agent running on a home
 *  server, a Raspberry Pi, or another laptop on the LAN — no
 *  companion.toml editing. The change applies live; the agent client
 *  is hot-swapped inside companion-server. */
export function ZeroclawEditor({
  current, onSaved,
}: {
  current: ZeroclawConfigView;
  onSaved: () => void;
}) {
  const initialKind = (current.kind || 'zeroclaw') as typeof AGENT_KINDS[number]['id'];
  const [kind, setKind] = useState<typeof AGENT_KINDS[number]['id']>(initialKind);
  const [url, setUrl] = useState<string>(current.url);
  const [token, setToken] = useState<string>(''); // never pre-filled; redacted server-side
  const [timeout, setTimeout_] = useState<number>(current.timeout_secs);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const spec = AGENT_KINDS.find((k) => k.id === kind) ?? AGENT_KINDS[0];

  /** Prefill the URL when the user picks a new kind — but only if the
   *  current URL still matches the OLD kind's default port. If they
   *  typed something custom, leave it alone. */
  const handleKindChange = (next: typeof AGENT_KINDS[number]['id']) => {
    const prev = AGENT_KINDS.find((k) => k.id === kind) ?? AGENT_KINDS[0];
    const newSpec = AGENT_KINDS.find((k) => k.id === next) ?? AGENT_KINDS[0];
    setKind(next);
    // Replace `:<oldPort>` with `:<newPort>` if the URL looks like the
    // default for the previous kind. Otherwise don't touch the URL.
    const oldUrl = url.trim();
    const wasPrevDefault =
      oldUrl === `http://127.0.0.1:${prev.port}` ||
      oldUrl === `http://localhost:${prev.port}` ||
      oldUrl.endsWith(`:${prev.port}`);
    if (wasPrevDefault) {
      setUrl(oldUrl.replace(`:${prev.port}`, `:${newSpec.port}`));
    }
  };

  const dirty =
    kind !== (current.kind || 'zeroclaw') ||
    url.trim() !== current.url ||
    token.length > 0 ||
    timeout !== current.timeout_secs;

  const save = async () => {
    setSaving(true); setError(null);
    const body: Record<string, unknown> = {};
    if (kind !== (current.kind || 'zeroclaw')) body.kind = kind;
    if (url.trim() !== current.url) body.url = url.trim();
    if (token.length > 0) body.pair_token = token;
    if (timeout !== current.timeout_secs) body.timeout_secs = timeout;
    if (Object.keys(body).length === 0) { setSaving(false); return; }
    try {
      const r = await fetch(`${HTTP_BASE}/api/config/zeroclaw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await saveErrorMessage('Agent save failed', r));
      setSavedAt(Date.now());
      setToken(''); // clear once persisted; server redacts on read
      onSaved();
      // The server hot-swapped the agent client; tell the health
      // banner to re-poll right now so the red bar clears instead of
      // sitting stale until the next 30s tick.
      window.dispatchEvent(new CustomEvent('companion:agent-changed'));
      // Fade the "Applied" hint after 4s so it doesn't linger.
      setTimeout(() => setSavedAt(null), 4000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const testConnection = async () => {
    const inv = tauriInvoke();
    const target = url.trim() || current.url;
    setTestResult('testing');
    if (inv) {
      // Reuse the Tauri health-probe command, but against the URL the
      // user typed (not the running config) so they can verify before
      // saving + restarting.
      try {
        const ok = await inv('check_zeroclaw_health', { url: target });
        setTestResult(ok ? 'ok' : 'fail');
      } catch { setTestResult('fail'); }
    } else {
      // Browser fallback: ask companion-server. This only checks the
      // CURRENTLY configured agent, not the typed URL — note that
      // to the user.
      try {
        const r = await fetch(`${HTTP_BASE}/api/config`);
        const j = await r.json();
        setTestResult(j?.zeroclaw?.reachable ? 'ok' : 'fail');
      } catch { setTestResult('fail'); }
    }
    setTimeout(() => setTestResult('idle'), 5000);
  };

  return (
    <>
      <p style={{
        margin: '0 0 14px 0', fontSize: 12.5, color: tokens.textMuted, lineHeight: 1.55,
      }}>
        Where the companion finds your main agent. Pick the flavor and
        point it at the host running it (this machine, a home server, a
        Raspberry Pi, another laptop on your LAN). The companion only
        sends chat messages and shows replies; the agent never gets to
        touch the computer the companion runs on.
      </p>
      <FieldRow label="Agent" hint={spec.blurb}>
        <select
          value={kind}
          onChange={(e) => handleKindChange(e.target.value as typeof AGENT_KINDS[number]['id'])}
          style={{ ...inputStyle, maxWidth: 360 }}
        >
          {AGENT_KINDS.map((k) => (
            <option key={k.id} value={k.id}>{k.label}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Gateway URL">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={`http://192.168.1.50:${spec.port}  (or http://127.0.0.1:${spec.port} for local)`}
          style={monoInputStyle}
        />
      </FieldRow>
      <FieldRow label="Pairing token">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={current.pair_token_set ? '••• set (paste to replace)' : 'optional — only if your agent requires one'}
          style={monoInputStyle}
          autoComplete="off"
        />
      </FieldRow>
      <FieldRow
        label="Request timeout (s)"
        hint={
          <>
            Long enough for the agent's full tool-use loop (web searches,
            browser, shell). 300s is a safe default; bump it if you see
            "timed out" on complex requests.
            <br />
            For a LAN agent, make sure its gateway binds to{' '}
            <code>0.0.0.0</code> (not <code>127.0.0.1</code>) so it's
            reachable from this machine.
          </>
        }
      >
        <input
          type="number" min={5} max={1800}
          value={timeout}
          onChange={(e) => setTimeout_(Math.max(5, Math.min(1800, parseInt(e.target.value, 10) || 300)))}
          style={{ ...inputStyle, maxWidth: 110 }}
        />
      </FieldRow>
      <EditorFooter
        status={
          <>
            {error && <Hint tone="warn">{error}</Hint>}
            {!error && dirty && <Hint tone="muted">unsaved changes</Hint>}
            {!error && !dirty && savedAt && <Hint tone="good">✓ Applied — agent switched live.</Hint>}
            {!error && !dirty && !savedAt && (
              <Hint tone={current.reachable ? 'good' : 'warn'}>
                {current.reachable
                  ? '● connected'
                  : `● not reachable — check the URL or start ${spec.id}`}
              </Hint>
            )}
            {testResult === 'testing' && <Hint tone="muted">testing…</Hint>}
            {testResult === 'ok' && <Hint tone="good">✓ reachable</Hint>}
            {testResult === 'fail' && <Hint tone="warn">✗ no response</Hint>}
          </>
        }
      >
        <Button onClick={testConnection} disabled={testResult === 'testing'}>Test connection</Button>
        <Button onClick={save} primary disabled={!dirty || saving}>
          {saving ? 'Applying…' : 'Apply'}
        </Button>
      </EditorFooter>
    </>
  );
}
