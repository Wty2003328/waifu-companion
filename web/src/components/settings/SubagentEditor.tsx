/**
 * Translation engine editor. The companion has two internal axes
 * (subagent backend + translator backend) but the user-facing surface
 * is one three-way choice:
 *   - direct : the user's own AI service (translate + expression via LLM)
 *   - webhook: zeroclaw acts as the AI proxy (no API key on this machine)
 *   - local  : bundled NMT model + keyword expressions (no LLM at all)
 */

import { useEffect, useState } from 'react';
import { HTTP_BASE } from '../../lib/apiBase';
import { listGpus, type DetectedGpu } from '../../lib/tauriShell';
import { tokens, inputStyle, monoInputStyle } from '../../lib/theme';
import type { AvatarConfigView } from './types';
import {
  Button,
  EditorFooter,
  FieldRow,
  Hint,
  ModeRadio,
  Subsection,
  SubagentSpeedupHint,
  Toggle,
  saveErrorMessage,
} from './primitives';

/** One supported language for an NMT preset. `code` is the
 *  short code our config files use (ISO-2 for everything except a
 *  few NLLB-specific ones); `name` is the human-readable label. */
interface NmtLanguage {
  code: string;
  name: string;
}

/** Curated NLLB-200 list. The model technically supports 200
 *  languages, but the chat companion realistically needs the
 *  common-use subset. Add a row here when a user actually needs it. */
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

/** What each preset can translate. Drives the language-pair dropdowns
 *  in the UI. `fixed_pair` locks the dropdowns when the model is
 *  single-direction (Helsinki opus-mt / fugumt are per-pair). */
interface NmtPresetDef {
  id: string;
  label: string;
  blurb: string;
  /** Languages the model accepts as source. Empty list = the preset
   *  is single-pair (use `fixed_pair`). */
  src: NmtLanguage[];
  /** Languages the model can output. Same shape. */
  tgt: NmtLanguage[];
  /** When set, src/tgt are locked to this exact pair (Marian single-
   *  direction models). The UI shows the pair as a static label. */
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

type TranslationMode = 'direct' | 'webhook' | 'local';

function deriveMode(c: AvatarConfigView['subagent']): TranslationMode {
  if (c.translator?.backend === 'http') return 'local';
  return c.use_zeroclaw_webhook ? 'webhook' : 'direct';
}

export function SubagentEditor({
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
                    hint="Pick the chat→voice translation direction. Add more rows in NLLB_LANGUAGES (SubagentEditor.tsx) if your language isn't listed — NLLB-200 supports 200 of them."
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
                {trDevice.startsWith('cuda:')
                  && !trDetectedGpus.find((g) => `cuda:${g.index}` === trDevice)
                  && trDetectedGpus.length > 0 && (
                  <option value={trDevice}>
                    {trDevice} (saved; not detected on this machine)
                  </option>
                )}
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
