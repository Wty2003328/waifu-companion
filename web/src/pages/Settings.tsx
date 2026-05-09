import { useState } from 'react';
import {
  HTTP_BASE,
  getDefaultServerUrl,
  getServerUrl,
  getStoredServerUrl,
  setStoredServerUrl,
} from '../lib/apiBase';
import { invalidateCache, useCachedJson } from '../lib/fetchCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? inv : null;
}

interface AvatarConfigView {
  enabled: boolean;
  chat_language: string;
  tts: {
    engine: string;
    language: string;
    voice: string | null;
    api_url: string | null;
    speed: number;
  };
  subagent: {
    enabled: boolean;
    only_when_translating: boolean;
    use_zeroclaw_webhook: boolean;
    streaming: boolean;
    llm_model: string;
    llm_base_url: string;
    llm_api_key_set: boolean;
    timeout_secs: number;
  };
  model: {
    model_dir: string | null;
    default_expression: string;
    scale: number;
    anchor: string;
  };
}

interface ServerConfig {
  avatar: AvatarConfigView | null;
}

const TOML_HINT_KEY = 'companion.tomlHint.dismissed.v1';

export default function Settings() {
  // Cached read of server config — instant on Settings revisit, the
  // hook auto-revalidates after `invalidateCache` calls fired by
  // editor save handlers.
  const cfgUrl = `${HTTP_BASE}/api/config`;
  const { data: cfg, error: fetchError } = useCachedJson<ServerConfig>(cfgUrl, 60_000);
  const reloadCfg = () => { invalidateCache(cfgUrl); };

  // Companion URL section state
  const [serverInput, setServerInput] = useState<string>(getStoredServerUrl());
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const [tomlHintDismissed, setTomlHintDismissed] = useState<boolean>(
    () => localStorage.getItem(TOML_HINT_KEY) === '1',
  );
  const error = fetchError;

  const handleSaveUrl = () => {
    const trimmed = serverInput.trim();
    setStoredServerUrl(trimmed);
    setSavedHint(trimmed
      ? `Saved. Reload to use ${trimmed}.`
      : 'Cleared. Reload to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };

  const handleClearUrl = () => {
    setStoredServerUrl('');
    setServerInput('');
    setSavedHint('Cleared. Reload to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };

  const isUsingDefaultUrl = !getStoredServerUrl();

  return (
    <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: 32, maxWidth: 880, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>Settings</h1>
      <p style={{ color: '#888', fontSize: 13, marginTop: -4 }}>
        Most changes save instantly. A few (voice engine, language defaults)
        only take effect after a quick app restart — the Save button will tell
        you when that's needed.
      </p>

      {error && <ErrorBox message={error} />}

      <Section title="Server address">
        <div style={{ color: '#888', fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
          Address this app uses to reach its background service. Leave blank
          unless the service is on a different computer or port.
        </div>
        <Row>
          <input
            type="text"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveUrl()}
            placeholder={`${getDefaultServerUrl()}  (default)`}
            style={inputStyle}
          />
          <Button onClick={handleSaveUrl} primary>Save</Button>
          <Button onClick={handleClearUrl} disabled={isUsingDefaultUrl}>Reset</Button>
        </Row>
        <Hint tone={savedHint ? 'good' : 'muted'}>
          {savedHint ?? `Now using: ${getServerUrl()}${isUsingDefaultUrl ? ' (default)' : ''}`}
        </Hint>
      </Section>

      <Section title="Avatar & voice">
        {!cfg && !error && <Hint tone="muted">loading…</Hint>}
        {cfg && !cfg.avatar && (
          <Hint tone="warn">
            Avatar is turned off in the config file. Set{' '}
            <code>[avatar] enabled = true</code> in companion.toml to use it.
          </Hint>
        )}
        {cfg?.avatar && (
          <AvatarEditor current={cfg.avatar} onSaved={reloadCfg} />
        )}
      </Section>

      <Section title="Translation & expressions">
        {cfg?.avatar?.subagent && (
          <SubagentEditor
            current={cfg.avatar.subagent}
            tomlHintDismissed={tomlHintDismissed}
            onDismissHint={() => {
              setTomlHintDismissed(true);
              localStorage.setItem(TOML_HINT_KEY, '1');
            }}
          />
        )}
      </Section>
      </div>
    </div>
  );
}

// ── Avatar editor ────────────────────────────────────────────────
//
// Knobs that flip frequently and don't need a TTS engine restart get
// editable controls here. The TTS engine, voice, and reference audio
// stay read-only because changing them implies a different launch
// pipeline (different engine binary, different model weights).

const LANGUAGE_CHOICES: { code: string; label: string }[] = [
  { code: 'en', label: 'English (en)' },
  { code: 'ja', label: 'Japanese (ja)' },
  { code: 'zh', label: 'Chinese (zh)' },
  { code: 'ko', label: 'Korean (ko)' },
  { code: 'es', label: 'Spanish (es)' },
  { code: 'fr', label: 'French (fr)' },
  { code: 'de', label: 'German (de)' },
];

// Known TTS engines. `gpt-sovits-v4` is the project's default reference
// rig; the others are common alternatives users may have set up.
// "Custom…" lets the user type whatever (no validation server-side).
const TTS_ENGINES: { value: string; label: string }[] = [
  { value: 'gpt-sovits-v4', label: 'gpt-sovits-v4' },
  { value: 'gpt-sovits',    label: 'gpt-sovits (legacy)' },
  { value: 'edge-tts',      label: 'edge-tts (Microsoft, no GPU)' },
  { value: 'fish-speech',   label: 'fish-speech' },
  { value: 'melotts',       label: 'melotts' },
  { value: 'xtts',          label: 'xtts' },
  { value: 'f5-tts',        label: 'f5-tts' },
];

function AvatarEditor({
  current, onSaved,
}: {
  current: AvatarConfigView;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(current.enabled);
  const [chatLang, setChatLang] = useState<string>(current.chat_language);
  const [ttsLang, setTtsLang] = useState<string>(current.tts.language);
  const [ttsSpeed, setTtsSpeed] = useState<number>(current.tts.speed);
  const [ttsEngine, setTtsEngine] = useState<string>(current.tts.engine);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== current.enabled ||
    chatLang !== current.chat_language ||
    ttsLang !== current.tts.language ||
    Math.abs(ttsSpeed - current.tts.speed) > 0.001 ||
    ttsEngine.trim() !== current.tts.engine;

  const save = async () => {
    setSaving(true); setError(null);
    const body: Record<string, unknown> = {};
    if (enabled !== current.enabled) body.enabled = enabled;
    if (chatLang !== current.chat_language) body.chat_language = chatLang;
    if (ttsLang !== current.tts.language) body.tts_language = ttsLang;
    if (Math.abs(ttsSpeed - current.tts.speed) > 0.001) body.tts_speed = ttsSpeed;
    if (ttsEngine.trim() !== current.tts.engine) body.tts_engine = ttsEngine.trim();
    try {
      const r = await fetch(`${HTTP_BASE}/api/config/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`save failed: ${r.status} ${await r.text()}`);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const restart = async () => {
    const inv = tauriInvoke();
    if (!inv) {
      window.alert('Restart the companion-server process to apply.');
      return;
    }
    try { await inv('restart_app'); }
    catch (e) { setError(`restart failed: ${(e as Error).message}`); }
  };

  return (
    <>
      <FieldRow label="Show avatar">
        <Toggle checked={enabled} onChange={setEnabled} />
      </FieldRow>
      <FieldRow label="Chat language">
        <select value={chatLang} onChange={(e) => setChatLang(e.target.value)} style={inputStyle}>
          {LANGUAGE_CHOICES.find((l) => l.code === chatLang) === undefined && (
            <option value={chatLang}>{chatLang} (custom)</option>
          )}
          {LANGUAGE_CHOICES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Voice language">
        <select value={ttsLang} onChange={(e) => setTtsLang(e.target.value)} style={inputStyle}>
          {LANGUAGE_CHOICES.find((l) => l.code === ttsLang) === undefined && (
            <option value={ttsLang}>{ttsLang} (custom)</option>
          )}
          {LANGUAGE_CHOICES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Voice speed">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
          <input
            type="range" min={0.5} max={2.0} step={0.05}
            value={ttsSpeed}
            onChange={(e) => setTtsSpeed(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontFamily: 'monospace', color: '#cbd5e1', minWidth: 48, textAlign: 'right' }}>
            {ttsSpeed.toFixed(2)}×
          </span>
        </div>
      </FieldRow>

      <AdvancedDisclosure label="Advanced — voice engine">
        <FieldRow label="Voice engine">
          <select
            value={TTS_ENGINES.find((e) => e.value === ttsEngine) ? ttsEngine : '__custom'}
            onChange={(e) => {
              if (e.target.value === '__custom') return;
              setTtsEngine(e.target.value);
            }}
            style={inputStyle}
          >
            {TTS_ENGINES.map((e) => (
              <option key={e.value} value={e.value}>{e.label}</option>
            ))}
            <option value="__custom">Other…</option>
          </select>
        </FieldRow>
        {!TTS_ENGINES.find((e) => e.value === ttsEngine) && (
          <FieldRow label="Custom engine name">
            <input
              type="text"
              value={ttsEngine}
              onChange={(e) => setTtsEngine(e.target.value)}
              placeholder="my-engine"
              style={inputStyle}
            />
          </FieldRow>
        )}
        <div style={{ fontSize: 11, color: '#666', marginTop: 4, lineHeight: 1.5 }}>
          Different engines need different model files and a matching
          launcher. If you change this, you'll likely also need to point
          the app at the right files in your config — see the README.
          <br />
          The avatar's voice, Live2D model, and default expression are
          set per-character on the <a href="/" style={{ color: '#7aa9ff' }}>Home page</a>.
        </div>
      </AdvancedDisclosure>

      <Row>
        <div style={{ flex: 1, minWidth: 0 }}>
          {error && <Hint tone="warn">{error}</Hint>}
          {savedAt && !error && <Hint tone="good">Saved. Click <strong>Restart</strong> to apply.</Hint>}
          {!savedAt && !error && dirty && <Hint tone="muted">unsaved changes</Hint>}
        </div>
        <Button onClick={save} primary disabled={!dirty || saving}>
          {saving ? 'saving…' : 'Save'}
        </Button>
        <Button onClick={restart}>Restart</Button>
      </Row>
    </>
  );
}

// ── Subagent editor ──────────────────────────────────────────────

type Backend = 'direct' | 'webhook';

function SubagentEditor({
  current, tomlHintDismissed, onDismissHint,
}: {
  current: AvatarConfigView['subagent'];
  tomlHintDismissed: boolean;
  onDismissHint: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(current.enabled);
  const [onlyXlate, setOnlyXlate] = useState<boolean>(current.only_when_translating);
  const [streaming, setStreaming] = useState<boolean>(current.streaming);
  const [timeout, setTimeout_] = useState<number>(current.timeout_secs);
  const [backend, setBackend] = useState<Backend>(current.use_zeroclaw_webhook ? 'webhook' : 'direct');
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>(current.llm_model || '');
  const [baseUrl, setBaseUrl] = useState<string>(current.llm_base_url || '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== current.enabled ||
    onlyXlate !== current.only_when_translating ||
    streaming !== current.streaming ||
    timeout !== current.timeout_secs ||
    backend !== (current.use_zeroclaw_webhook ? 'webhook' : 'direct') ||
    apiKey.length > 0 ||
    model.trim() !== (current.llm_model || '') ||
    baseUrl.trim() !== (current.llm_base_url || '');

  const save = async () => {
    setSaving(true); setError(null);
    try {
      // Avatar-side toggles → /api/config/avatar (subagent.enabled,
      // subagent.only_when_translating live under [avatar.subagent] in
      // the TOML hierarchy, so we route them through the avatar override
      // path which knows how to patch that subtree).
      const avatarBody: Record<string, unknown> = {};
      if (enabled !== current.enabled) avatarBody.subagent_enabled = enabled;
      if (onlyXlate !== current.only_when_translating) avatarBody.subagent_only_when_translating = onlyXlate;
      if (streaming !== current.streaming) avatarBody.subagent_streaming = streaming;
      if (Object.keys(avatarBody).length) {
        const r = await fetch(`${HTTP_BASE}/api/config/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(avatarBody),
        });
        if (!r.ok) throw new Error(`avatar save: ${r.status} ${await r.text()}`);
      }
      // Backend + LLM connection → /api/config/subagent.
      const subBody: Record<string, unknown> = {};
      if (backend !== (current.use_zeroclaw_webhook ? 'webhook' : 'direct')) {
        subBody.use_zeroclaw_webhook = backend === 'webhook';
      }
      if (apiKey.length > 0) subBody.api_key = apiKey;
      if (model.trim() !== (current.llm_model || '')) subBody.model = model.trim();
      if (baseUrl.trim() !== (current.llm_base_url || '')) subBody.base_url = baseUrl.trim();
      if (timeout !== current.timeout_secs) subBody.timeout_secs = timeout;
      if (Object.keys(subBody).length) {
        const r = await fetch(`${HTTP_BASE}/api/config/subagent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subBody),
        });
        if (!r.ok) throw new Error(`subagent save: ${r.status} ${await r.text()}`);
      }
      setSavedAt(Date.now());
      setApiKey('');
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const restart = async () => {
    const inv = tauriInvoke();
    if (!inv) { window.alert('Restart the companion-server process to apply.'); return; }
    try { await inv('restart_app'); }
    catch (e) { setError(`restart failed: ${(e as Error).message}`); }
  };

  return (
    <>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
        When your chat language doesn't match the voice language, this
        translates replies before speaking. It also picks the right facial
        expression for each line.
      </div>
      <FieldRow label="Translate replies">
        <Toggle checked={enabled} onChange={setEnabled} />
      </FieldRow>
      <FieldRow label="Only when needed">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Toggle checked={onlyXlate} onChange={setOnlyXlate} />
          <span style={{ fontSize: 11, color: '#666' }}>
            {onlyXlate
              ? 'skip when chat & voice are the same language'
              : 'always run, even for same-language chats'}
          </span>
        </div>
      </FieldRow>

      <div style={{
        display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #1f2227',
        fontSize: 13, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{ minWidth: 160, color: '#888' }}>How it runs</span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="radio" name="backend" checked={backend === 'direct'} onChange={() => setBackend('direct')} />
          <span style={{ color: backend === 'direct' ? '#10b981' : '#cbd5e1' }}>
            Direct AI <span style={{ color: '#666' }}>(fast — needs an API key)</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="radio" name="backend" checked={backend === 'webhook'} onChange={() => setBackend('webhook')} />
          <span style={{ color: backend === 'webhook' ? '#f59e0b' : '#cbd5e1' }}>
            Through main agent <span style={{ color: '#666' }}>(slower, no key needed)</span>
          </span>
        </label>
      </div>

      {backend === 'direct' && (
        <AdvancedDisclosure label="AI service details">
          <FieldRow label="API endpoint">
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1" style={inputStyle} />
          </FieldRow>
          <FieldRow label="Model name">
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini" style={inputStyle} />
          </FieldRow>
          <FieldRow label="API key">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.llm_api_key_set ? '••• saved (paste to replace)' : 'paste your OpenAI / z.ai / etc. key'}
              style={inputStyle}
              autoComplete="off"
            />
          </FieldRow>
          <div style={{ fontSize: 11, color: '#666', marginLeft: 168 }}>
            Saved on this computer only. Keep this file out of git.
          </div>
        </AdvancedDisclosure>
      )}

      <AdvancedDisclosure label="Advanced — timing & streaming">
        <FieldRow label="Time limit (seconds)">
          <input
            type="number" min={5} max={300}
            value={timeout}
            onChange={(e) => setTimeout_(Math.max(1, parseInt(e.target.value, 10) || 60))}
            style={{ ...inputStyle, maxWidth: 100 }}
          />
        </FieldRow>
        <div style={{ fontSize: 11, color: '#666', marginLeft: 168, marginBottom: 8 }}>
          How long to wait for a translation before giving up.
          Direct AI usually replies in 1–3 seconds; the main-agent path
          can take 5–10.
        </div>
        <FieldRow label="Stream while speaking">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Toggle checked={streaming} onChange={setStreaming} />
            <span style={{ fontSize: 11, color: '#666' }}>
              {streaming
                ? 'TTS starts on the first sentence (~3s) — faster, uses keyword expressions'
                : 'wait for the full translation (~15-25s) before speaking — picks richer expressions'}
            </span>
          </div>
        </FieldRow>
        <div style={{ fontSize: 11, color: '#666', marginLeft: 168 }}>
          Streaming requires <strong>Direct AI</strong> mode (above).
          With "Through main agent" it falls back to the non-streaming
          path automatically.
        </div>
      </AdvancedDisclosure>

      <Row>
        <div style={{ flex: 1, minWidth: 0 }}>
          {error && <Hint tone="warn">{error}</Hint>}
          {savedAt && !error && <Hint tone="good">Saved. Click <strong>Restart</strong> to apply.</Hint>}
          {!savedAt && !error && dirty && <Hint tone="muted">unsaved changes</Hint>}
        </div>
        <Button onClick={save} primary disabled={!dirty || saving}>
          {saving ? 'saving…' : 'Save'}
        </Button>
        <Button onClick={restart}>Restart</Button>
      </Row>

      {backend === 'webhook' && !tomlHintDismissed && (
        <SubagentSpeedupHint onDismiss={onDismissHint} />
      )}
    </>
  );
}

// ── Toggle / generic widgets ────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 36, height: 20,
        background: checked ? '#3b82f6' : '#2a2d33',
        borderRadius: 10, border: 'none', position: 'relative',
        cursor: 'pointer', flexShrink: 0,
        transition: 'background 120ms ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 120ms ease',
      }} />
    </button>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
      padding: '8px 0', borderBottom: '1px solid #1f2227',
    }}>
      <span style={{ minWidth: 160, color: '#888', fontSize: 12 }}>{label}</span>
      <div style={{ flex: '1 1 280px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function SubagentSpeedupHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={{
      marginTop: 12, padding: 14, background: '#1e2433',
      border: '1px solid #2d3a55', borderRadius: 8,
      fontSize: 12, color: '#cbd5e1', lineHeight: 1.55, position: 'relative',
    }}>
      <button type="button" onClick={onDismiss} title="Dismiss" style={{
        position: 'absolute', top: 8, right: 8, background: 'transparent',
        border: 'none', color: '#888', cursor: 'pointer', fontSize: 14,
      }}>✕</button>
      <div style={{ fontWeight: 600, color: '#fff', marginBottom: 6 }}>💡 Make this faster</div>
      Routing through the main agent adds 5–10 seconds per reply. If you
      have an OpenAI / z.ai / similar API key, switch the option above to
      <strong> Direct AI</strong> for ~1–3 second replies.
      <div style={{ marginTop: 6, color: '#94a3b8' }}>
        Cheap fast options: gpt-4o-mini, Groq Llama-3.3-70B, Z.ai GLM-4-Flash.
        Or run Ollama locally for free at <code>localhost:11434/v1</code>.
        Hit <strong>Save</strong> then <strong>Restart</strong> after you change it.
      </div>
    </div>
  );
}

/** Collapsible "Advanced" section. Closed by default; opens to reveal
 *  the technical knobs that most users won't touch. Keeps the main
 *  settings page short and approachable for first-time users while
 *  still letting power users get to everything. */
function AdvancedDisclosure({
  label, children,
}: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 0', background: 'transparent', border: 'none',
          color: '#7aa9ff', fontSize: 12, cursor: 'pointer', textAlign: 'left',
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 10, color: '#666', width: 10, textAlign: 'center' }}>
          {open ? '▾' : '▸'}
        </span>
        {label}
      </button>
      {open && <div style={{ paddingLeft: 18, paddingBottom: 8 }}>{children}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: '#16181c', borderRadius: 10, padding: 20, marginTop: 16,
    }}>
      <h2 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
      {children}
    </div>
  );
}

function ReadonlyRow({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'muted';
}) {
  const color = tone === 'good' ? '#10b981' : tone === 'warn' ? '#f59e0b' : '#cbd5e1';
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '6px 0',
      borderBottom: '1px solid #1f2227', fontSize: 13,
    }}>
      <span style={{ minWidth: 160, color: '#888' }}>{label}</span>
      <span style={{ color, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

function Hint({ tone, children }: { tone: 'muted' | 'good' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'good' ? '#10b981' : tone === 'warn' ? '#f59e0b' : '#666';
  return <div style={{ fontSize: 11, color }}>{children}</div>;
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div style={{
      background: '#1f1316', color: '#fca5a5', padding: 12,
      borderRadius: 8, marginTop: 16, fontSize: 13,
    }}>
      Failed to load config: {message}
    </div>
  );
}

function Button({
  children, onClick, primary, disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 14px',
        background: primary && !disabled ? '#3b82f6' : 'transparent',
        color: primary && !disabled ? '#fff' : '#888',
        border: primary && !disabled ? 'none' : '1px solid #2a2d33',
        borderRadius: 6, fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  flex: '1 1 280px', minWidth: 220,
  background: '#0b0d10', color: '#fff',
  padding: '8px 12px', borderRadius: 6, border: '1px solid #2a2d33',
  fontSize: 13, fontFamily: 'monospace', outline: 'none',
};
