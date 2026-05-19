/**
 * Avatar & voice editor.
 *
 * Knobs that flip frequently and don't need a TTS engine restart get
 * editable controls here. The TTS engine, voice, and reference audio
 * stay read-only because changing them implies a different launch
 * pipeline (different engine binary, different model weights).
 */

import { useEffect, useState } from 'react';
import { HTTP_BASE } from '../../lib/apiBase';
import { tokens, inputStyle } from '../../lib/theme';
import type { AvatarConfigView } from './types';
import {
  Button,
  EditorFooter,
  FieldRow,
  Hint,
  Subsection,
  Toggle,
  saveErrorMessage,
} from './primitives';

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

export function AvatarEditor({
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
