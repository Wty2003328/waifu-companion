import { useState, useEffect } from 'react';
import {
  HTTP_BASE,
  getDefaultServerUrl,
  getServerUrl,
  getStoredServerUrl,
  setStoredServerUrl,
} from '../lib/apiBase';
import { invalidateCache, useCachedJson } from '../lib/fetchCache';
import { listGpus, type DetectedGpu } from '../lib/tauriShell';
import { tokens, inputStyle, monoInputStyle } from '../lib/theme';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? inv : null;
}

/** Build a useful error message for a failed Settings POST. The naked
 *  `${r.status} ${await r.text()}` pattern produced "Save failed: 500 "
 *  (trailing space, no context) on empty bodies and dumped multi-KB
 *  Rust panic traces into the warn banner when the body was huge. This
 *  normalizes: human-readable status, truncated body, no dangling
 *  whitespace, and a non-empty fallback when the server says nothing. */
async function saveErrorMessage(label: string, r: Response): Promise<string> {
  let body = '';
  try { body = (await r.text()).trim(); } catch { /* swallow */ }
  if (body.length > 280) body = body.slice(0, 280) + '… (truncated)';
  const status = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
  if (!body) return `${label} — ${status}. Server returned no message.`;
  return `${label} — ${status}: ${body}`;
}

interface AvatarConfigView {
  enabled: boolean;
  chat_language: string;
  /** Universal TTS port — companion knows only a URL + synthesis defaults.
   *  Engine identity, weights, python interpreter etc. live in an external
   *  launcher (tts_lab/launch_tts.py). See docs/TTS-PROVIDER-SPEC.md. */
  tts: {
    api_url: string | null;
    voice: string | null;
    language: string;
    speed: number;
    /** Quality preset (fast | balanced | high). null → sidecar default. */
    quality: string | null;
    /** Paragraph-wise streaming toggle. */
    streaming: boolean;
    /** Opaque launcher command, run at startup if non-empty. */
    launcher_command: string | null;
  };
  subagent: {
    enabled: boolean;
    only_when_translating: boolean;
    use_zeroclaw_webhook: boolean;
    streaming: boolean;
    llm_model: string;
    llm_base_url: string;
    llm_disable_thinking: boolean;
    llm_api_key_set: boolean;
    timeout_secs: number;
    translator?: TranslatorConfigView;
  };
  model: {
    model_dir: string | null;
    default_expression: string;
    scale: number;
    anchor: string;
  };
}

/// Subagent's translation backend + NMT sidecar tuning.
/// Mirrors `crates/companion-avatar/src/translator.rs::TranslatorConfig`.
interface TranslatorConfigView {
  backend: 'llm' | 'http';
  url: string;
  http_timeout_secs: number;
  nmt_quality_preset: string;       // "fast" | "balanced" | "quality" | "custom"
  nmt_model_id: string | null;
  nmt_num_beams: number | null;
  nmt_device: string;                // "cpu" | "cuda" | "cuda:N"
  nmt_precision: string;             // "auto" | "fp32" | "fp16" | "bf16"
  nmt_src_lang: string;
  nmt_tgt_lang: string;
  nmt_launch_command: string;
  nmt_auto_start: boolean;
  nmt_close_with_companion: boolean;
  nmt_port: number;
}

/// One supported language for an NMT preset. `code` is the
/// short code our config files use (ISO-2 for everything except a
/// few NLLB-specific ones); `name` is the human-readable label.
interface NmtLanguage {
  code: string;
  name: string;
}

/// Curated NLLB-200 list. The model technically supports 200
/// languages, but the chat companion realistically needs the
/// common-use subset. Add a row here when a user actually needs it.
const NLLB_LANGUAGES: NmtLanguage[] = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)' },
  { code: 'ko', name: 'Korean' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'hi', name: 'Hindi' },
];

/// What each preset can translate. Drives the language-pair dropdowns
/// in the UI. `fixed_pair` locks the dropdowns when the model is
/// single-direction (Helsinki opus-mt / fugumt are per-pair).
interface NmtPresetDef {
  id: string;
  label: string;
  blurb: string;
  /// Languages the model accepts as source. Empty list = the preset
  /// is single-pair (use `fixed_pair`).
  src: NmtLanguage[];
  /// Languages the model can output. Same shape.
  tgt: NmtLanguage[];
  /// When set, src/tgt are locked to this exact pair (Marian single-
  /// direction models). The UI shows the pair as a static label.
  fixed_pair?: { src: NmtLanguage; tgt: NmtLanguage };
}

const NMT_PRESETS: NmtPresetDef[] = [
  {
    id: 'fast',
    label: 'Fast (fugumt-en-ja, ~70 M)',
    blurb: '~100 ms CPU. Specialized en→ja. Decent modern JA but a bit literal.',
    src: [],
    tgt: [],
    fixed_pair: {
      src: { code: 'en', name: 'English' },
      tgt: { code: 'ja', name: 'Japanese' },
    },
  },
  {
    id: 'balanced',
    label: 'Balanced — recommended (NLLB-200-distilled-600M)',
    blurb: '~400 ms CPU / ~200 ms GPU. Multilingual, production-grade quality.',
    src: NLLB_LANGUAGES,
    tgt: NLLB_LANGUAGES,
  },
  {
    id: 'quality',
    label: 'Quality (NLLB-200-distilled-1.3B)',
    blurb: '~1–2 s CPU / ~300 ms GPU. Noticeably better than 600M; GPU recommended. Top tier.',
    src: NLLB_LANGUAGES,
    tgt: NLLB_LANGUAGES,
  },
  {
    id: 'custom',
    label: 'Custom (specify model id)',
    blurb: 'Any seq2seq HF model. Fill in the "Model ID" field below.',
    src: [],
    tgt: [],
  },
];

interface ZeroclawConfigView {
  /// "zeroclaw" | "openclaw" | "hermes" | "custom". Drives the chat
  /// HTTP shape (webhook vs OpenAI-compat) and prefilled default port.
  kind: string;
  url: string;
  timeout_secs: number;
  pair_token_set: boolean;
  reachable: boolean;
}

/// Known agent kinds and the metadata the UI needs to present them.
/// Keep this in sync with `AgentKind` in companion-core/src/config.rs.
const AGENT_KINDS: Array<{
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

interface ServerConfig {
  avatar: AvatarConfigView | null;
  zeroclaw?: ZeroclawConfigView;
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
    <div
      style={{
        flex: '1 1 0', minHeight: 0, overflow: 'auto',
        contain: 'paint',
        overscrollBehavior: 'contain',
      }}
    >
      <div style={{ padding: '40px 32px', maxWidth: 880, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', color: tokens.text }}>
          Settings
        </h1>
        <p style={{ color: tokens.textMuted, fontSize: 13, margin: '6px 0 0 0', lineHeight: 1.55 }}>
          Changes apply immediately. Voice-engine swaps and a few other
          process-level options take effect on the next app start —
          they'll say so explicitly.
        </p>
      </header>

      {error && <ErrorBox message={error} />}

      <Section title="Main agent">
        {!cfg && !error && <SectionLoading rows={3} />}
        {cfg?.zeroclaw && (
          <ZeroclawEditor current={cfg.zeroclaw} onSaved={reloadCfg} />
        )}
      </Section>

      <Section title="Avatar & voice">
        {!cfg && !error && <SectionLoading rows={3} />}
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
            onSaved={reloadCfg}
            tomlHintDismissed={tomlHintDismissed}
            onDismissHint={() => {
              setTomlHintDismissed(true);
              localStorage.setItem(TOML_HINT_KEY, '1');
            }}
          />
        )}
      </Section>

      {/* Companion service URL — most users never touch this. It's the
          address the React UI uses to reach its own background service
          (the companion-server sidecar). Distinct from the agent URL
          above; the description spells that out so it doesn't get
          confused with it. */}
      <Section
        title="Companion service"
        description="Where this UI reaches its local background service (the companion-server sidecar). Leave blank for the default — this is not the agent address; set that in Main agent above."
      >
        <FieldRow
          label="Service URL"
          hint={`Now using: ${getServerUrl()}${isUsingDefaultUrl ? ' (default)' : ''}`}
        >
          <input
            type="text"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveUrl()}
            placeholder={`${getDefaultServerUrl()}  (default)`}
            style={monoInputStyle}
          />
          <Button onClick={handleSaveUrl} primary>Save</Button>
          <Button onClick={handleClearUrl} disabled={isUsingDefaultUrl}>Reset</Button>
        </FieldRow>
        {savedHint && (
          <div style={{ marginTop: 8 }}>
            <Hint tone="good">{savedHint}</Hint>
          </div>
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

/** Live state read from the TTS server's /healthz at form load. Used
 *  read-only — the companion never branches on this; it's UI telemetry
 *  ("you're talking to <engine_id>"). */
interface TtsServerInfo {
  engine_id: string;
  spec_version: string;
  model?: string;
}

/** Edits the connection to the (possibly remote) zeroclaw daemon.
 *  Lets the user point the companion at a zeroclaw running on a home
 *  server, a Raspberry Pi, or another laptop on the LAN — no
 *  companion.toml editing. The companion never gives zeroclaw access
 *  to the machine it runs on; it just POSTs chat to zeroclaw's
 *  `/webhook` and renders the reply. Changes need a companion-server
 *  restart (the client is built once at startup). */
function ZeroclawEditor({
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

  /// Prefill the URL when the user picks a new kind — but only if the
  /// current URL still matches the OLD kind's default port. If they
  /// typed something custom, leave it alone.
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
      // CURRENTLY configured zeroclaw, not the typed URL — note that
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

function AvatarEditor({
  current, onSaved,
}: {
  current: AvatarConfigView;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(current.enabled);
  const [chatLang, setChatLang] = useState<string>(current.chat_language);
  // Universal TTS port — companion knows only URL + synthesis defaults.
  // Engine identity, weights, python interpreter, GPU device etc. live
  // in an external launcher (tts_lab/launch_tts.py).
  const [ttsApiUrl, setTtsApiUrl] = useState<string>(current.tts.api_url ?? '');
  const [ttsLang, setTtsLang] = useState<string>(current.tts.language);
  const [ttsVoice, setTtsVoice] = useState<string>(current.tts.voice ?? '');
  const [ttsSpeed, setTtsSpeed] = useState<number>(current.tts.speed);
  const [ttsQuality, setTtsQuality] = useState<string>(current.tts.quality ?? 'balanced');
  const [ttsLauncherCmd, setTtsLauncherCmd] = useState<string>(current.tts.launcher_command ?? '');
  // Read-only telemetry from the live server's /healthz. Tells the user
  // which engine they're actually talking to; companion never uses this
  // for control flow.
  const [serverInfo, setServerInfo] = useState<TtsServerInfo | null>(null);
  // Voice registry from GET /v1/audio/voices. Empty until the fetch
  // resolves; falls back to a free-text input if the server is offline.
  const [sidecarVoices, setSidecarVoices] = useState<{ id: string; name: string; language: string | null }[]>([]);

  const effectiveTtsUrl = (ttsApiUrl.trim() || current.tts.api_url || 'http://127.0.0.1:9890').replace(/\/$/, '');

  // Hit /healthz + /v1/audio/voices on the configured server. Both are
  // best-effort — if the server is down the form still works, the user
  // just gets a free-text voice input and no engine_id badge.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${effectiveTtsUrl}/healthz`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TtsServerInfo | null) => setServerInfo(data))
      .catch(() => setServerInfo(null));
    fetch(`${effectiveTtsUrl}/v1/audio/voices`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { voices: [] }))
      .then((data: { voices?: { id: string; name?: string; language?: string }[] }) => {
        setSidecarVoices(
          (data.voices ?? []).map((v) => ({
            id: v.id,
            name: v.name || v.id,
            language: v.language ?? null,
          })),
        );
      })
      .catch(() => setSidecarVoices([]));
    return () => ctrl.abort();
  }, [effectiveTtsUrl]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== current.enabled ||
    chatLang !== current.chat_language ||
    ttsApiUrl.trim() !== (current.tts.api_url ?? '') ||
    ttsLang !== current.tts.language ||
    ttsVoice.trim() !== (current.tts.voice ?? '') ||
    Math.abs(ttsSpeed - current.tts.speed) > 0.001 ||
    ttsQuality !== (current.tts.quality ?? 'balanced') ||
    ttsLauncherCmd.trim() !== (current.tts.launcher_command ?? '');

  const save = async () => {
    setSaving(true); setError(null);
    const body: Record<string, unknown> = {};
    if (enabled !== current.enabled) body.enabled = enabled;
    if (chatLang !== current.chat_language) body.chat_language = chatLang;
    if (ttsApiUrl.trim() !== (current.tts.api_url ?? '')) body.tts_api_url = ttsApiUrl.trim();
    if (ttsLang !== current.tts.language) body.tts_language = ttsLang;
    if (ttsVoice.trim() !== (current.tts.voice ?? '')) body.tts_voice = ttsVoice.trim();
    if (Math.abs(ttsSpeed - current.tts.speed) > 0.001) body.tts_speed = ttsSpeed;
    if (ttsQuality !== (current.tts.quality ?? 'balanced')) body.tts_quality = ttsQuality;
    if (ttsLauncherCmd.trim() !== (current.tts.launcher_command ?? '')) body.tts_launcher_command = ttsLauncherCmd.trim();
    try {
      const r = await fetch(`${HTTP_BASE}/api/config/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await saveErrorMessage('Avatar save failed', r));
      // Server returns a JSON body describing what got applied live
      // and whether a TTS child-process restart is pending. The
      // restart itself runs on a background task — the watchdog
      // updates /api/status when it finishes (success or fail).
      const result = await r.json().catch(() => ({}));
      if (result?.tts_error) {
        // Synchronous build error — bad path or similar. Surface now.
        setError(`Apply: ${result.tts_error}`);
      } else {
        setSavedAt(Date.now());
        setTimeout(() => setSavedAt(null), 4000);
      }
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <>
      <FieldRow label="Enable avatar">
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

      <Subsection label="Voice server">
        <FieldRow
          label="Server URL"
          hint={
            serverInfo
              ? <>Connected — speaking to <code style={{ color: tokens.textMuted }}>{serverInfo.engine_id}</code> (spec v{serverInfo.spec_version}{serverInfo.model ? ` · ${serverInfo.model}` : ''}).</>
              : <>Where the TTS server listens. Must speak <a href="docs/TTS-PROVIDER-SPEC.md" style={{ color: tokens.primary }}>TTS Provider Spec v1</a>. Server not reachable — voice list and engine info won't load.</>
          }
        >
          <input
            type="text"
            value={ttsApiUrl}
            onChange={(e) => setTtsApiUrl(e.target.value)}
            placeholder="http://127.0.0.1:9891"
            style={inputStyle}
            spellCheck={false}
          />
        </FieldRow>
        <FieldRow
          label="Launcher command"
          hint={
            <>
              Optional. If set, companion spawns this opaquely at startup
              and tears it down at exit per the lifecycle protocol. Leave
              empty if you manage the server yourself. The recommended
              pattern is to use <code style={{ color: tokens.textMuted }}>tts_lab/launch_tts.py --engine X --port N</code>;
              run <code style={{ color: tokens.textMuted }}>--list</code> to see known engines.
            </>
          }
        >
          <input
            type="text"
            value={ttsLauncherCmd}
            onChange={(e) => setTtsLauncherCmd(e.target.value)}
            placeholder="python /path/to/tts_lab/launch_tts.py --engine sbv2-asuna-v2 --port 9891"
            style={inputStyle}
            spellCheck={false}
          />
        </FieldRow>
      </Subsection>

      <Subsection label="Voice">
        <FieldRow
          label="Voice"
          hint={
            sidecarVoices.length > 0
              ? <>Loaded from <code style={{ color: tokens.textMuted }}>{effectiveTtsUrl}/v1/audio/voices</code>.</>
              : <>Server's voice registry isn't reachable. Type the <code style={{ color: tokens.textMuted }}>voice_id</code> manually.</>
          }
        >
          {sidecarVoices.length > 0 ? (
            <select
              value={sidecarVoices.find((v) => v.id === ttsVoice) ? ttsVoice : '__custom'}
              onChange={(e) => {
                if (e.target.value === '__custom') return;
                setTtsVoice(e.target.value);
              }}
              style={inputStyle}
            >
              {sidecarVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.language ? ` (${v.language})` : ''}
                </option>
              ))}
              <option value="__custom">Other voice_id…</option>
            </select>
          ) : (
            <input
              type="text"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder="asuna_v2"
              style={inputStyle}
            />
          )}
        </FieldRow>
        {sidecarVoices.length > 0 && !sidecarVoices.find((v) => v.id === ttsVoice) && (
          <FieldRow label="Custom voice_id">
            <input
              type="text"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder="my_voice"
              style={inputStyle}
            />
          </FieldRow>
        )}

        <FieldRow
          label="Quality preset"
          hint={
            ttsQuality === 'fast'
              ? 'Fast — real-time conversation, snappier first audio. Lower voice fidelity.'
              : ttsQuality === 'high'
              ? 'High — long-form / important responses. Stricter to the reference voice; slower.'
              : 'Balanced — default. Natural prosody + acceptable speed.'
          }
        >
          <select
            value={ttsQuality}
            onChange={(e) => setTtsQuality(e.target.value)}
            style={{ ...inputStyle, maxWidth: 360 }}
          >
            <option value="fast">Fast</option>
            <option value="balanced">Balanced — recommended</option>
            <option value="high">High</option>
          </select>
        </FieldRow>
        <div style={{ fontSize: 11.5, color: tokens.textDim, marginTop: 12, lineHeight: 1.5 }}>
          The avatar's Live2D model and default expression are set
          per-character on the <a href="/" style={{ color: tokens.primary }}>Home page</a>.
        </div>
      </Subsection>

      <EditorFooter
        status={
          <>
            {error && <Hint tone="warn">{error}</Hint>}
            {/* Order matters: a fresh dirty edit should switch back
                to "unsaved" instead of stale-"Applied". */}
            {!error && dirty && <Hint tone="muted">unsaved changes</Hint>}
            {!error && !dirty && savedAt && <Hint tone="good">✓ Applied — voice changes are live.</Hint>}
          </>
        }
      >
        <Button onClick={save} primary disabled={!dirty || saving}>
          {saving ? 'Applying…' : 'Apply'}
        </Button>
      </EditorFooter>
    </>
  );
}

// ── Translation editor ───────────────────────────────────────────

/// Three mutually-exclusive translation engines. The companion's
/// internal config has two axes (subagent backend + translator
/// backend) but the meaningful product surface is one choice:
///   - direct : the user's own AI service (translate + expression via LLM)
///   - webhook: zeroclaw acts as the AI proxy (no API key on this machine)
///   - local  : bundled NMT model + keyword expressions (no LLM at all)
type TranslationMode = 'direct' | 'webhook' | 'local';

function deriveMode(c: AvatarConfigView['subagent']): TranslationMode {
  if (c.translator?.backend === 'http') return 'local';
  return c.use_zeroclaw_webhook ? 'webhook' : 'direct';
}

function SubagentEditor({
  current, onSaved, tomlHintDismissed, onDismissHint,
}: {
  current: AvatarConfigView['subagent'];
  onSaved: () => void;
  tomlHintDismissed: boolean;
  onDismissHint: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean>(current.enabled);
  const [onlyXlate, setOnlyXlate] = useState<boolean>(current.only_when_translating);
  const [streaming, setStreaming] = useState<boolean>(current.streaming);
  const [timeout, setTimeout_] = useState<number>(current.timeout_secs);
  const [mode, setMode] = useState<TranslationMode>(deriveMode(current));
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>(current.llm_model || '');
  const [baseUrl, setBaseUrl] = useState<string>(current.llm_base_url || '');
  // `current.llm_disable_thinking` may be undefined on older server
  // builds — default to true (the historical hardcoded behavior).
  const [disableThinking, setDisableThinking] = useState<boolean>(current.llm_disable_thinking ?? true);

  // Local mode requires streaming: the non-streaming path issues an
  // LLM-only `analyze()` JSON call for expression metadata, which has
  // no LLM available in local mode. Snap streaming on whenever the
  // user picks Local; let them toggle it off again only after switching
  // back to one of the LLM modes.
  useEffect(() => {
    if (mode === 'local' && !streaming) setStreaming(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ----- Translator state -----
  // The translator subobject can be absent on older server builds —
  // null-safe pulls with sensible fallbacks. `null` for nullable
  // overrides is normalized to '' in the input so the form is
  // controlled. The backend is NOT a separate state var here — it's
  // derived from `mode` ('local' ↔ 'http', everything else ↔ 'llm').
  const tr = current.translator;
  const [trPreset, setTrPreset] = useState<string>(tr?.nmt_quality_preset ?? 'balanced');
  const [trDevice, setTrDevice] = useState<string>(tr?.nmt_device ?? 'cpu');
  const [trPrecision, setTrPrecision] = useState<string>(tr?.nmt_precision ?? 'auto');
  const [trModelId, setTrModelId] = useState<string>(tr?.nmt_model_id ?? '');
  const [trSrcLang, setTrSrcLang] = useState<string>(tr?.nmt_src_lang ?? 'en');
  const [trTgtLang, setTrTgtLang] = useState<string>(tr?.nmt_tgt_lang ?? 'ja');
  const [trNumBeams, setTrNumBeams] = useState<number | ''>(tr?.nmt_num_beams ?? '');
  const [trUrl, setTrUrl] = useState<string>(tr?.url ?? 'http://127.0.0.1:9881');
  const [trAutoStart, setTrAutoStart] = useState<boolean>(tr?.nmt_auto_start ?? false);
  const [trShowAdvanced, setTrShowAdvanced] = useState<boolean>(false);
  // Detected GPUs for the NMT device dropdown. Same Tauri command the
  // TTS editor uses, so the two surfaces stay in sync (one detection
  // result, two consumers). Empty until resolved; we render a CPU+
  // fallback so the form is always usable.
  const [trDetectedGpus, setTrDetectedGpus] = useState<DetectedGpu[]>([]);
  useEffect(() => { void listGpus().then(setTrDetectedGpus); }, []);

  // When the preset changes, snap src/tgt into a configuration the
  // selected model actually supports. Without this, switching from
  // "balanced" (NLLB, where the user picked fr→de) to "fast"
  // (fugumt-en-ja, fixed) would leave the form state as fr→de and
  // we'd POST garbage to the backend.
  useEffect(() => {
    const preset = NMT_PRESETS.find((p) => p.id === trPreset);
    if (!preset) return;
    if (preset.fixed_pair) {
      if (trSrcLang !== preset.fixed_pair.src.code) setTrSrcLang(preset.fixed_pair.src.code);
      if (trTgtLang !== preset.fixed_pair.tgt.code) setTrTgtLang(preset.fixed_pair.tgt.code);
      return;
    }
    if (preset.src.length > 0 && !preset.src.some((l) => l.code === trSrcLang)) {
      setTrSrcLang(preset.src[0].code);
    }
    if (preset.tgt.length > 0 && !preset.tgt.some((l) => l.code === trTgtLang)) {
      // Avoid src === tgt when possible.
      const fallback = preset.tgt.find((l) => l.code !== trSrcLang)
        ?? preset.tgt[0];
      setTrTgtLang(fallback.code);
    }
    // We intentionally only react to preset changes here; reading
    // trSrcLang/trTgtLang would create a loop with the setters above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trPreset]);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Translator details only matter when local mode is active. Gating
  // dirty on `mode === 'local'` avoids enabling Apply for translator
  // edits the user made and then moved away from (the save body
  // wouldn't have sent them anyway).
  const trDirty =
    mode === 'local' && (
      trPreset !== (tr?.nmt_quality_preset ?? 'balanced') ||
      trDevice !== (tr?.nmt_device ?? 'cpu') ||
      trPrecision !== (tr?.nmt_precision ?? 'auto') ||
      trModelId !== (tr?.nmt_model_id ?? '') ||
      trSrcLang !== (tr?.nmt_src_lang ?? 'en') ||
      trTgtLang !== (tr?.nmt_tgt_lang ?? 'ja') ||
      (trNumBeams === '' ? (tr?.nmt_num_beams ?? null) !== null
                         : trNumBeams !== (tr?.nmt_num_beams ?? -1)) ||
      trUrl !== (tr?.url ?? 'http://127.0.0.1:9881') ||
      trAutoStart !== (tr?.nmt_auto_start ?? false)
    );

  const dirty =
    enabled !== current.enabled ||
    onlyXlate !== current.only_when_translating ||
    streaming !== current.streaming ||
    timeout !== current.timeout_secs ||
    mode !== deriveMode(current) ||
    apiKey.length > 0 ||
    model.trim() !== (current.llm_model || '') ||
    baseUrl.trim() !== (current.llm_base_url || '') ||
    disableThinking !== (current.llm_disable_thinking ?? true) ||
    trDirty;

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
        if (!r.ok) throw new Error(await saveErrorMessage('Avatar save failed', r));
        // Re-sync `current` so a later subagent-save failure doesn't
        // make the just-applied avatar fields look "dirty" — they're
        // already on disk, the user shouldn't see them queued again.
        onSaved();
      }
      // Map the three-way mode back onto the two internal axes:
      //   direct  → use_zeroclaw_webhook=false, translator.backend=llm
      //   webhook → use_zeroclaw_webhook=true,  translator.backend=llm
      //   local   → use_zeroclaw_webhook=false, translator.backend=http
      const subBody: Record<string, unknown> = {};
      const priorMode = deriveMode(current);
      if (mode !== priorMode) {
        subBody.use_zeroclaw_webhook = mode === 'webhook';
        subBody.translator_backend = mode === 'local' ? 'http' : 'llm';
      }
      if (apiKey.length > 0) subBody.api_key = apiKey;
      if (model.trim() !== (current.llm_model || '')) subBody.model = model.trim();
      if (baseUrl.trim() !== (current.llm_base_url || '')) subBody.base_url = baseUrl.trim();
      if (disableThinking !== (current.llm_disable_thinking ?? true)) subBody.disable_thinking = disableThinking;
      if (timeout !== current.timeout_secs) subBody.timeout_secs = timeout;

      // Translator detail overrides — only send when local mode is the
      // current intent. Outside of local mode the NMT sidecar config
      // has no effect; sending edits there pollutes companion.runtime.json
      // with intent the user no longer has.
      if (mode === 'local') {
        if (trUrl !== (tr?.url ?? 'http://127.0.0.1:9881')) subBody.translator_url = trUrl;
        if (trPreset !== (tr?.nmt_quality_preset ?? 'balanced')) subBody.translator_nmt_quality_preset = trPreset;
        if (trDevice !== (tr?.nmt_device ?? 'cpu')) subBody.translator_nmt_device = trDevice;
        if (trPrecision !== (tr?.nmt_precision ?? 'auto')) subBody.translator_nmt_precision = trPrecision;
        if (trModelId !== (tr?.nmt_model_id ?? '')) subBody.translator_nmt_model_id = trModelId;
        if (trSrcLang !== (tr?.nmt_src_lang ?? 'en')) subBody.translator_nmt_src_lang = trSrcLang;
        if (trTgtLang !== (tr?.nmt_tgt_lang ?? 'ja')) subBody.translator_nmt_tgt_lang = trTgtLang;
        if (trAutoStart !== (tr?.nmt_auto_start ?? false)) subBody.translator_nmt_auto_start = trAutoStart;
        if (trNumBeams !== '' && trNumBeams !== (tr?.nmt_num_beams ?? -1)) {
          subBody.translator_nmt_num_beams = trNumBeams;
        }
      }
      if (Object.keys(subBody).length) {
        const r = await fetch(`${HTTP_BASE}/api/config/subagent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subBody),
        });
        if (!r.ok) throw new Error(await saveErrorMessage('Translation save failed', r));
      }
      setSavedAt(Date.now());
      setApiKey('');
      // Re-fetch /api/config so `current` reflects the just-saved values —
      // otherwise `dirty` stays true (current vs. local-state mismatch) and
      // the "unsaved changes" indicator + Apply button never clear, which
      // makes a successful save look like it did nothing.
      onSaved();
      // The server hot-swapped the subagent in-place. Fade the
      // "Applied" hint after 4s so it doesn't linger.
      setTimeout(() => setSavedAt(null), 4000);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <>
      <div style={{ fontSize: 12, color: tokens.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        When your chat language differs from the voice language, replies
        are translated before speech synthesis. Translation also feeds
        expression and motion selection.
      </div>
      <FieldRow label="Enable translation">
        <Toggle checked={enabled} onChange={setEnabled} />
      </FieldRow>
      <FieldRow
        label="Only when languages differ"
        hint={onlyXlate
          ? "Skip the translator when chat and voice share a language."
          : "Run the translator on every reply, even same-language."}
      >
        <Toggle checked={onlyXlate} onChange={setOnlyXlate} />
      </FieldRow>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '12px 0', borderBottom: `1px solid ${tokens.border}`,
        fontSize: 13,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ minWidth: 160, color: tokens.textMuted, fontWeight: 500 }}>
            Translation engine
          </span>
        </div>
        <ModeRadio
          checked={mode === 'direct'}
          onSelect={() => setMode('direct')}
          name="Direct AI service"
          blurb="Use your own AI service (OpenAI, z.ai, OpenRouter, …). Highest quality — persona-aware translation and expression analysis. Requires an API key."
        />
        <ModeRadio
          checked={mode === 'webhook'}
          onSelect={() => setMode('webhook')}
          name="Main agent (proxy)"
          blurb="Route translation requests through the upstream agent (zeroclaw). Reuses the agent's API key — none stored on this machine. Slower (extra hop)."
        />
        <ModeRadio
          checked={mode === 'local'}
          onSelect={() => setMode('local')}
          name="Local model"
          blurb="Run a bundled neural translation model on this machine. No API key, no network. Plain register (no persona). Streaming-only — expression detection uses keyword matching."
        />
      </div>

      {mode === 'direct' && (
        <Subsection label="Service configuration">
          <FieldRow label="API endpoint">
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1" style={monoInputStyle} />
          </FieldRow>
          <FieldRow label="Model">
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini" style={monoInputStyle} />
          </FieldRow>
          <FieldRow
            label="API key"
            hint="Stored locally in companion.runtime.json (gitignored). Not transmitted to any third party."
          >
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.llm_api_key_set ? '••• saved (paste to replace)' : 'paste API key'}
              style={monoInputStyle}
              autoComplete="off"
            />
          </FieldRow>
          <FieldRow
            label="Chain-of-thought"
            hint={disableThinking
              ? "Disabled — sends thinking:{type:disabled}. GLM-4.5/4.6/5 family skip reasoning (~1 s vs ~15–25 s). Other providers ignore the flag."
              : "Enabled — the model reasons before responding. Slower, but better translation and expression picks on ambiguous inputs."}
          >
            <Toggle checked={!disableThinking} onChange={(on) => setDisableThinking(!on)} />
          </FieldRow>
        </Subsection>
      )}

      {mode === 'webhook' && (
        <div style={{
          marginTop: 14,
          padding: '10px 12px',
          background: tokens.bgPanelHi,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radiusSm,
          fontSize: tokens.fontHint,
          color: tokens.textMuted,
          lineHeight: 1.55,
        }}>
          Translation requests are forwarded to the upstream agent's
          <code>/webhook</code> endpoint. The agent's API key and model
          selection apply — no additional configuration needed.
        </div>
      )}

      {mode === 'local' && (
        <Subsection label="Local model configuration">
          <>
            <FieldRow
              label="Quality preset"
              hint={
                NMT_PRESETS.find((p) => p.id === trPreset)?.blurb
                ?? 'Presets trade speed for quality — smaller models render faster but produce blunter translations.'
              }
            >
              <select
                value={trPreset}
                onChange={(e) => setTrPreset(e.target.value)}
                style={{ ...inputStyle, maxWidth: 360 }}
              >
                {NMT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </FieldRow>

            {trPreset === 'custom' && (
              <FieldRow
                label="Model ID"
                hint="HuggingFace repo id, e.g. `facebook/nllb-200-distilled-1.3B` or `staka/fugumt-en-ja`. Empty falls back to the preset."
              >
                <input
                  type="text"
                  value={trModelId}
                  onChange={(e) => setTrModelId(e.target.value)}
                  placeholder="org/model-name"
                  style={monoInputStyle}
                />
              </FieldRow>
            )}

            {(() => {
              // Pick the language UI for the currently-selected preset.
              // Three shapes:
              //   - fixed_pair (Marian single-direction): show static label.
              //   - non-empty src/tgt arrays (NLLB): two dropdowns.
              //   - custom preset (empty arrays, no fixed_pair): free text
              //     since we don't know what the user's HF model supports.
              const preset = NMT_PRESETS.find((p) => p.id === trPreset);
              if (!preset) return null;
              if (preset.fixed_pair) {
                return (
                  <FieldRow
                    label="Languages"
                    hint="This model is single-direction — the pair is fixed. Pick a different preset to change languages."
                  >
                    <div style={{
                      padding: '4px 10px',
                      background: '#1f2937',
                      borderRadius: 4,
                      fontSize: 13,
                      color: '#cbd5e1',
                    }}>
                      {preset.fixed_pair.src.name}
                      <span style={{ color: tokens.textMuted, margin: '0 8px' }}>→</span>
                      {preset.fixed_pair.tgt.name}
                    </div>
                  </FieldRow>
                );
              }
              if (preset.src.length > 0 && preset.tgt.length > 0) {
                return (
                  <FieldRow
                    label="Languages"
                    hint="Pick the chat→voice translation direction. Add more rows in NLLB_LANGUAGES (Settings.tsx) if your language isn't listed — NLLB-200 supports 200 of them."
                  >
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        value={trSrcLang}
                        onChange={(e) => setTrSrcLang(e.target.value)}
                        style={{ ...inputStyle, minWidth: 160 }}
                      >
                        {preset.src.map((l) => (
                          <option key={l.code} value={l.code}>{l.name}</option>
                        ))}
                      </select>
                      <span style={{ color: tokens.textMuted }}>→</span>
                      <select
                        value={trTgtLang}
                        onChange={(e) => setTrTgtLang(e.target.value)}
                        style={{ ...inputStyle, minWidth: 160 }}
                      >
                        {preset.tgt
                          .filter((l) => l.code !== trSrcLang)
                          .map((l) => (
                            <option key={l.code} value={l.code}>{l.name}</option>
                          ))}
                      </select>
                    </div>
                  </FieldRow>
                );
              }
              // Custom preset: we don't know what languages the user's
              // model supports — fall back to free text.
              return (
                <FieldRow
                  label="Languages"
                  hint="Your custom model determines what's supported. Use ISO-2 (en, ja, zh) or flores-200 codes (eng_Latn, jpn_Jpan)."
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="text" value={trSrcLang}
                      onChange={(e) => setTrSrcLang(e.target.value.trim())}
                      placeholder="en"
                      style={{ ...monoInputStyle, maxWidth: 100 }}
                    />
                    <span style={{ color: tokens.textMuted }}>→</span>
                    <input
                      type="text" value={trTgtLang}
                      onChange={(e) => setTrTgtLang(e.target.value.trim())}
                      placeholder="ja"
                      style={{ ...monoInputStyle, maxWidth: 100 }}
                    />
                  </div>
                </FieldRow>
              );
            })()}

            <FieldRow
              label="Device"
              hint={
                trDetectedGpus.length === 0
                  ? 'GPU detection unavailable (nvidia-smi not on PATH). CPU is the safe default; GPU 0 works for single-CUDA setups. Quality/Best presets really benefit from a GPU.'
                  : `Detected ${trDetectedGpus.length} GPU${trDetectedGpus.length === 1 ? '' : 's'}. CPU is the safe default — it won't fight the TTS for VRAM. A GPU is worth it only with spare headroom; Quality/Best presets benefit most.`
              }
            >
              <select
                value={trDevice}
                onChange={(e) => setTrDevice(e.target.value)}
                style={{ ...inputStyle, maxWidth: 480 }}
              >
                <option value="cpu">CPU only (safe, no VRAM use)</option>
                {trDetectedGpus.length > 0 ? (
                  trDetectedGpus.map((g) => (
                    <option key={g.index} value={`cuda:${g.index}`}>
                      GPU {g.index}: {g.name}
                      {g.vram_total_mb != null
                        ? ` (${(g.vram_total_mb / 1024).toFixed(1)} GB)`
                        : ''}
                    </option>
                  ))
                ) : (
                  <option value="cuda:0">GPU 0 (auto-detect failed; pick manually)</option>
                )}
                {/* Preserve a saved index we don't currently detect
                    (mirrors the TTS dropdown's behavior). */}
                {trDevice.startsWith('cuda:')
                  && !trDetectedGpus.find((g) => `cuda:${g.index}` === trDevice)
                  && trDetectedGpus.length > 0 && (
                  <option value={trDevice}>
                    {trDevice} (saved; not detected on this machine)
                  </option>
                )}
                {/* Legacy 'cuda' value (no index) — keep it selectable
                    if someone has it saved from an earlier build, but
                    don't surface it as a fresh choice. */}
                {trDevice === 'cuda' && (
                  <option value="cuda">CUDA (default index — pick a specific GPU above)</option>
                )}
              </select>
            </FieldRow>

            <FieldRow
              label="Launch with companion"
              hint={trAutoStart
                ? "Spawns the NMT sidecar at companion launch (first run downloads weights — model size shown in the preset blurb above)."
                : "Off — tools/avatar/nmt_translator_server.py must be started manually before the first translation."}
            >
              <Toggle checked={trAutoStart} onChange={setTrAutoStart} />
            </FieldRow>

            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => setTrShowAdvanced((v) => !v)}
                style={{
                  background: 'transparent',
                  color: tokens.textMuted,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '4px 0',
                }}
              >
                {trShowAdvanced ? '▾ hide advanced' : '▸ show advanced'}
              </button>
            </div>
            {trShowAdvanced && (
              <>
                <FieldRow
                  label="Precision"
                  hint="auto = fp16 on GPU, fp32 on CPU (CPU fp16 is usually slower than fp32 without AVX half-precision support)."
                >
                  <select
                    value={trPrecision}
                    onChange={(e) => setTrPrecision(e.target.value)}
                    style={{ ...inputStyle, maxWidth: 160 }}
                  >
                    <option value="auto">auto</option>
                    <option value="fp32">fp32</option>
                    <option value="fp16">fp16</option>
                    <option value="bf16">bf16</option>
                  </select>
                </FieldRow>
                <FieldRow
                  label="Beam width"
                  hint="1 = greedy (fastest, worst). 5–8 = high quality. Leave blank for the preset's default."
                >
                  <input
                    type="number" min={1} max={12}
                    value={trNumBeams}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === '') setTrNumBeams('');
                      else {
                        const n = Math.max(1, Math.min(12, parseInt(raw, 10) || 0));
                        setTrNumBeams(n);
                      }
                    }}
                    style={{ ...inputStyle, maxWidth: 100 }}
                    placeholder="preset default"
                  />
                </FieldRow>
                <FieldRow
                  label="Sidecar URL"
                  hint="Localhost in normal use. Change only if you're running the NMT server on another machine or port."
                >
                  <input
                    type="text"
                    value={trUrl}
                    onChange={(e) => setTrUrl(e.target.value.trim())}
                    placeholder="http://127.0.0.1:9881"
                    style={monoInputStyle}
                  />
                </FieldRow>
              </>
            )}
            {!trAutoStart && (
              <div style={{
                marginTop: 8,
                padding: '6px 10px',
                background: '#1f2937',
                borderLeft: '3px solid #f59e0b',
                fontSize: 11,
                color: '#cbd5e1',
                lineHeight: 1.5,
              }}>
                The sidecar must be running for translation to work.
                With auto-start off, launch it manually:{' '}
                <code style={{ color: tokens.warn, padding: '0 4px' }}>
                  python tools/avatar/nmt_translator_server.py
                </code>
              </div>
            )}
          </>
        </Subsection>
      )}

      <Subsection label="Performance">
        <FieldRow
          label="Request timeout (s)"
          hint="Maximum wait for a translation response before falling back. Direct AI: 1–3 s typical. Main agent: 5–10 s. Local model: 1–2 s."
        >
          <input
            type="number" min={5} max={300}
            value={timeout}
            onChange={(e) => setTimeout_(Math.max(1, parseInt(e.target.value, 10) || 60))}
            style={{ ...inputStyle, maxWidth: 100 }}
          />
        </FieldRow>
        <FieldRow
          label="Streaming output"
          hint={
            mode === 'local'
              ? 'Required for Local model — expression detection runs from keywords on the streamed sentences; the non-streaming JSON path needs an LLM.'
              : streaming
                ? 'Speech starts on the first sentence (~1–3 s). Faster perceived latency; expressions chosen by keyword match.'
                : 'Wait for the full translation before any speech (~15–25 s). Slower start; richer per-reply expression analysis.'
          }
        >
          <Toggle
            checked={streaming}
            onChange={setStreaming}
            disabled={mode === 'local'}
          />
        </FieldRow>
      </Subsection>

      <EditorFooter
        status={
          <>
            {error && <Hint tone="warn">{error}</Hint>}
            {!error && dirty && <Hint tone="muted">unsaved changes</Hint>}
            {!error && !dirty && savedAt && <Hint tone="good">✓ Applied — subagent swapped live.</Hint>}
          </>
        }
      >
        <Button onClick={save} primary disabled={!dirty || saving}>
          {saving ? 'Applying…' : 'Apply'}
        </Button>
      </EditorFooter>

      {mode === 'webhook' && !tomlHintDismissed && (
        <SubagentSpeedupHint onDismiss={onDismissHint} />
      )}
    </>
  );
}

// ── Toggle / generic widgets ────────────────────────────────────

/// A single row in a stacked radio-list with title + description.
/// Used by the Translation engine selector — the three modes need
/// more explanation than fits on one line, so each option gets its
/// own block of help text below the label.
function ModeRadio({
  checked, onSelect, name, blurb,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  blurb: string;
}) {
  return (
    <label
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '8px 10px',
        background: checked ? tokens.bgPanelHi : 'transparent',
        borderRadius: 6,
        cursor: 'pointer',
        border: checked ? `1px solid ${tokens.primary}` : '1px solid transparent',
      }}
    >
      <input
        type="radio"
        name="translation-mode"
        checked={checked}
        onChange={onSelect}
        style={{ marginTop: 3, accentColor: tokens.primary }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          color: checked ? tokens.primary : tokens.text,
          fontWeight: 500,
          fontSize: 13,
        }}>
          {name}
        </span>
        <span style={{ color: tokens.textMuted, fontSize: 11.5, lineHeight: 1.4 }}>
          {blurb}
        </span>
      </div>
    </label>
  );
}

function Toggle({
  checked, onChange, disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /// When true, the toggle is non-interactive and visually muted.
  /// Used when a parent setting forces a fixed value (e.g. Local
  /// model mode forces Streaming on).
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onChange(!checked); }}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className="ws-btn"
      style={{
        width: 38, height: 22,
        background: checked ? tokens.primary : '#2a2f3a',
        borderRadius: 11, border: 'none', position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0, padding: 0,
        opacity: disabled ? 0.5 : 1,
        transition: 'background 120ms ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        transition: 'left 140ms cubic-bezier(0.4, 0, 0.2, 1)',
      }} />
    </button>
  );
}

/** Inline path field with a Browse button. Wraps the native file
 *  picker so the user doesn't have to type or paste OS paths by hand. */
function FieldRow({
  label, hint, children,
}: {
  label: string;
  /** Optional secondary copy under the field. */
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap',
      padding: '12px 0',
      borderBottom: `1px solid ${tokens.border}`,
    }}>
      <label style={{
        minWidth: 168,
        paddingTop: 9,                 // visually centers against the input
        color: tokens.textMuted,
        fontSize: 12.5,
        fontWeight: 500,
        letterSpacing: '0.005em',
      }}>{label}</label>
      <div style={{
        flex: '1 1 280px', minWidth: 220,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {children}
        </div>
        {hint && (
          <div style={{ fontSize: 11.5, color: tokens.textDim, lineHeight: 1.5 }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

function SubagentSpeedupHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={{
      marginTop: 12, padding: 14,
      background: tokens.bgPanelHi,
      border: `1px solid ${tokens.border}`,
      borderRadius: tokens.radius,
      fontSize: tokens.fontBody, color: tokens.text, lineHeight: 1.55,
      position: 'relative',
    }}>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="ws-btn"
        style={{
          position: 'absolute', top: 6, right: 6,
          background: 'transparent', border: 'none',
          color: tokens.textMuted, cursor: 'pointer',
          fontSize: 14, padding: '2px 6px', borderRadius: tokens.radiusXs,
        }}
      >✕</button>
      <div style={{ fontWeight: 600, color: tokens.text, marginBottom: 6 }}>
        Faster replies available
      </div>
      Routing through the main agent adds 5–10 seconds per reply. If you
      have an OpenAI / z.ai / similar API key, switch the mode above to
      <strong> Direct AI</strong> for ~1–3 second replies. The change applies
      live on <strong>Apply</strong> — no restart needed.
      <div style={{ marginTop: 6, color: tokens.textMuted }}>
        Cheap fast options: gpt-4o-mini, Groq Llama-3.3-70B, Z.ai GLM-4-Flash.
        Or run Ollama locally for free at <code>localhost:11434/v1</code>.
      </div>
    </div>
  );
}

/** A labelled subsection within a Section. Renders the children
 *  inline (always visible — no click-to-expand) under a small caps
 *  header with a divider above, so related controls stay grouped
 *  without hiding anything behind a disclosure. */
function Subsection({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 18,
      paddingTop: 14,
      borderTop: `1px solid ${tokens.border}`,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: tokens.textDim,
        marginBottom: 10,
      }}>{label}</div>
      {children}
    </div>
  );
}

function Section({
  title, description, children,
}: {
  title: string;
  /** Optional one-liner under the section title. Sets context for the section's controls. */
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{
      background: tokens.bgPanel,
      border: `1px solid ${tokens.border}`,
      borderRadius: tokens.radius,
      padding: '20px 22px',
      marginTop: 20,
    }}>
      <header style={{ marginBottom: description ? 14 : 12 }}>
        <h2 style={{
          margin: 0,
          fontSize: 15.5,
          fontWeight: 600,
          color: tokens.text,
          letterSpacing: '-0.005em',
        }}>{title}</h2>
        {description && (
          <p style={{
            margin: '4px 0 0 0',
            fontSize: 12.5,
            color: tokens.textMuted,
            lineHeight: 1.55,
          }}>{description}</p>
        )}
      </header>
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

/// Footer toolbar for an editor: status hints on the left, action
/// buttons on the right, separator above. Use this in place of an
/// ad-hoc `<Row>` to give every editor the same end-of-form rhythm.
function EditorFooter({
  status, children,
}: {
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      marginTop: 16,
      paddingTop: 16,
      borderTop: `1px solid ${tokens.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {status}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
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

/** Skeleton placeholder for a section whose data is still loading.
 *  Reserves vertical space matching the editor's rough layout (a few
 *  FieldRow-sized bars) so the page doesn't visibly shift when the
 *  fetch lands. The pulsing dot from `.ws-typing-dot` cues "active". */
function SectionLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '6px 0' }}
    >
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        fontSize: 12, color: tokens.textDim,
      }}>
        <span className="ws-typing-dot" />
        Loading current settings…
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 32,
            background: tokens.bgPanelHi,
            borderRadius: tokens.radiusSm,
            opacity: 0.55,
            // Stagger the rows visually so the skeleton doesn't read
            // as a uniform block — gives the eye something to land on.
            width: `${100 - i * 6}%`,
          }}
        />
      ))}
    </div>
  );
}

function Hint({ tone, children }: { tone: 'muted' | 'good' | 'warn'; children: React.ReactNode }) {
  const color =
    tone === 'good' ? tokens.success :
    tone === 'warn' ? tokens.warn :
    tokens.textDim;
  return (
    <div style={{
      fontSize: 12,
      color,
      lineHeight: 1.5,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {children}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      background: 'rgba(239, 68, 68, 0.10)',
      border: `1px solid rgba(239, 68, 68, 0.30)`,
      color: '#fca5a5',
      padding: '12px 14px',
      borderRadius: tokens.radius,
      marginTop: 16,
      fontSize: 13,
      lineHeight: 1.5,
    }}>
      <strong style={{ color: '#fecaca' }}>Failed to load config.</strong>{' '}
      {message}
    </div>
  );
}

function Button({
  children, onClick, primary, disabled, title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const isPrimary = !!primary && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`ws-btn${isPrimary ? ' ws-btn--primary' : ''}`}
      style={{
        padding: '8px 14px',
        background: isPrimary ? tokens.primary : 'transparent',
        color: isPrimary ? '#fff' : tokens.textMuted,
        border: `1px solid ${isPrimary ? tokens.primary : tokens.border}`,
        borderRadius: tokens.radiusSm,
        fontSize: 12.5,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        minHeight: 34,
      }}
    >
      {children}
    </button>
  );
}

// inputStyle / monoInputStyle moved to ../lib/theme — imported above.
