/**
 * Avatar WebSocket hook with a process-lifetime singleton WS.
 *
 * The connection is opened lazily on first hook use and **kept alive
 * for the lifetime of the page** — closing it on hook unmount would
 * drop in-flight TTS audio frames any time the user navigates away
 * from the Avatar tab while a reply is still streaming (the broadcast
 * channel on the server silently discards frames when no receivers
 * exist). That was a real, reproducible UX bug: send a long reply,
 * switch to Settings, come back — and the audio is gone.
 *
 * Design:
 *   1. One module-level `WebSocket` for the whole page. Reconnects
 *      automatically on close.
 *   2. **Audio is played at module level**, independent of any hook
 *      subscriber. So even if no React component is mounted that
 *      subscribes to the visual events, TTS still speaks.
 *   3. Visual subscribers (Avatar tab's expression / motion / lip-sync
 *      handlers) register on mount and unregister on unmount. They
 *      can come and go freely.
 *
 * The Tauri rodio worker dedupes incoming `(turnId, seq)` pairs, so
 * even when the Avatar tab IS mounted and its `onAudio` callback also
 * calls `playAudioNative`, only one playback happens. That's why this
 * change is backward-compatible — no Avatar.tsx changes required.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeAudioAvailable, playAudioNative, stopAudioNative } from '../../lib/nativeAudio';

export interface LipSyncDataProto {
  frames: { t: number; o: number; s: number }[];
  frame_duration_ms: number;
}

export interface DebugFrame {
  chat_text: string;
  spoken_text: string;
  expression: string;
  subagent_used: boolean;
  /// Which translation backend ran for this turn:
  ///   "llm"  — direct LLM call or zeroclaw webhook proxy
  ///   "nmt"  — local NMT sidecar (subagent.translator.backend = "http")
  ///   "none" — chat_language matched tts_language; no translation
  /// Empty string for back-compat with pre-iter-14 servers; the
  /// Avatar page falls back to the binary "used / fell back" label.
  translation_path?: string;
}

export interface AvatarNotification {
  type: string;
  // Connected
  session_id?: string;
  // ModelInfo
  model_url?: string;
  scale?: number;
  anchor?: string;
  default_expression?: string;
  // Expression
  name?: string;
  intensity?: number;
  duration_ms?: number | null;
  // Motion
  group?: string;
  // Audio
  audio?: string;
  format?: string;
  sample_rate?: number;
  lip_sync?: LipSyncDataProto;
  // Text
  content?: string;
  // Debug — companion-emitted diagnostic info per turn
  chat_text?: string;
  spoken_text?: string;
  expression?: string;
  subagent_used?: boolean;
  translation_path?: string;
  // Error
  message?: string;
}

export type AvatarMessage =
  | { type: 'Ready' }
  | { type: 'Touch'; hit_area: string; x: number; y: number }
  | { type: 'MotionRequest'; group: string; name: string }
  | { type: 'ExpressionRequest'; name: string };

export interface UseAvatarSocketOptions {
  onModelInfo?: (info: {
    modelUrl: string;
    scale: number;
    anchor: string;
    defaultExpression: string;
  }) => void;
  onExpression?: (name: string, intensity: number, durationMs: number | null) => void;
  onMotion?: (group: string, name: string) => void;
  onAudio?: (
    audioBase64: string,
    format: string,
    sampleRate: number,
    lipSync: LipSyncDataProto,
    /** Stable id of the agent turn this chunk belongs to. Same across
     *  all chunks of one reply; flushes the queue on change. */
    turnId: string,
    /** 0-based index of this chunk within its turn. */
    seq: number,
    /** True when this is the final chunk of the turn. */
    last: boolean,
  ) => void;
  onText?: (content: string) => void;
  /** A user-typed message echoed back from the server (so every
   *  connected window records the same user turn). */
  onUserMessage?: (content: string) => void;
  onDebug?: (frame: DebugFrame) => void;
  onIdle?: () => void;
  onError?: (message: string) => void;
}

// ── Module-level singleton state ───────────────────────────────────

let sharedWs: WebSocket | null = null;
let sharedWsUrl: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Track the most recent turn id we've forwarded native audio for, so
 *  we can cancel an in-flight playback when a new turn starts (the
 *  user fires a second message before the first reply finishes). */
let currentNativeTurnId: string | null = null;
/** Stable subscriber registry. Each hook call inserts its own object;
 *  unmount removes it. Iteration order is insertion order — stable. */
const subscribers = new Set<UseAvatarSocketOptions>();
/** Listeners for the boolean connected state, fanned out so every hook
 *  instance sees the same value. */
const connectedListeners = new Set<(connected: boolean) => void>();
let sharedConnected = false;

function notifyConnected(value: boolean) {
  if (sharedConnected === value) return;
  sharedConnected = value;
  for (const cb of connectedListeners) cb(value);
}

function handleAudioFrame(msg: AvatarNotification) {
  // ALWAYS-ON audio playback. Runs whether the Avatar tab is mounted
  // or not, so a tab-switch mid-reply doesn't kill TTS.
  if (!msg.lip_sync) return;
  const audioBase64 = msg.audio ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  const turnId: string = m.turn_id ?? '';
  const seq: number = m.seq ?? 0;
  const last: boolean = Boolean(m.last);
  if (!nativeAudioAvailable()) return; // browser fallback path stays in Avatar.tsx

  // New turn started — drop the previous queue so a fresh reply
  // doesn't wait behind a half-played one.
  if (turnId && turnId !== currentNativeTurnId) {
    void stopAudioNative();
    currentNativeTurnId = turnId;
  }
  // Empty audio + last=true is the end-of-turn terminator — still
  // forward it so the rodio sink finalizes cleanly.
  void playAudioNative(audioBase64, turnId, seq, last).catch(() => {
    /* swallow — rodio prints its own diagnostics on failure */
  });
}

function dispatchToSubscriber(msg: AvatarNotification, opts: UseAvatarSocketOptions) {
  switch (msg.type) {
    case 'Connected':
      // Nothing to do — connection state is tracked via WS lifecycle.
      break;
    case 'ModelInfo':
      if (msg.model_url && opts.onModelInfo) {
        opts.onModelInfo({
          modelUrl: msg.model_url,
          scale: msg.scale ?? 0.2,
          anchor: msg.anchor ?? 'center',
          defaultExpression: msg.default_expression ?? 'neutral',
        });
      }
      break;
    case 'Expression':
      if (msg.name && opts.onExpression) {
        opts.onExpression(msg.name, msg.intensity ?? 0.8, msg.duration_ms ?? null);
      }
      break;
    case 'Motion':
      if (msg.group && msg.name && opts.onMotion) {
        opts.onMotion(msg.group, msg.name);
      }
      break;
    case 'Audio':
      // We've already played audio at module level (always). The
      // subscriber's onAudio callback exists to drive visual side-effects
      // (lip-sync animation, "isPlaying" UI state) — only fires when
      // a subscriber is registered.
      if (msg.lip_sync && opts.onAudio) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = msg as any;
        opts.onAudio(
          msg.audio ?? '',
          msg.format ?? 'wav',
          msg.sample_rate ?? 22050,
          msg.lip_sync,
          m.turn_id ?? '',
          m.seq ?? 0,
          Boolean(m.last),
        );
      }
      break;
    case 'Text':
      if (msg.content && opts.onText) opts.onText(msg.content);
      break;
    case 'UserMessage':
      if (msg.content && opts.onUserMessage) opts.onUserMessage(msg.content);
      break;
    case 'Debug':
      if (opts.onDebug) {
        opts.onDebug({
          chat_text: msg.chat_text ?? '',
          spoken_text: msg.spoken_text ?? '',
          expression: msg.expression ?? '',
          subagent_used: msg.subagent_used ?? false,
          translation_path: msg.translation_path ?? '',
        });
      }
      break;
    case 'Idle':
      opts.onIdle?.();
      break;
    case 'Error':
      if (msg.message && opts.onError) opts.onError(msg.message);
      break;
  }
}

function ensureWs(url: string) {
  // Tear down a connection pointed at a different URL (rare — only the
  // service-URL setting can change it, and that needs a page reload to
  // be honest about the change).
  if (sharedWs && sharedWsUrl !== url) {
    try { sharedWs.close(); } catch { /* ignore */ }
    sharedWs = null;
  }
  if (sharedWs && sharedWs.readyState <= WebSocket.OPEN) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  sharedWsUrl = url;
  const ws = new WebSocket(url);
  sharedWs = ws;

  ws.onopen = () => {
    notifyConnected(true);
  };

  ws.onclose = () => {
    notifyConnected(false);
    if (sharedWs === ws) sharedWs = null;
    // Schedule a reconnect — the WS singleton owns its own lifecycle now.
    reconnectTimer = setTimeout(() => {
      if (sharedWsUrl) ensureWs(sharedWsUrl);
    }, 3000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch { /* will fire onclose */ }
  };

  ws.onmessage = (event) => {
    let msg: AvatarNotification;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'Audio') handleAudioFrame(msg);
    for (const opts of subscribers) {
      try {
        dispatchToSubscriber(msg, opts);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[avatar-ws] subscriber threw:', e);
      }
    }
  };
}

function sendRaw(payload: AvatarMessage) {
  if (sharedWs && sharedWs.readyState === WebSocket.OPEN) {
    sharedWs.send(JSON.stringify(payload));
  }
}

// ── Hook ───────────────────────────────────────────────────────────

export function useAvatarSocket(url: string, options: UseAvatarSocketOptions = {}) {
  const [connected, setConnected] = useState(sharedConnected);

  // Keep a stable reference to the latest options so subscribers see
  // the freshest callbacks without churning the registry every render.
  const optionsRef = useRef<UseAvatarSocketOptions>(options);
  optionsRef.current = options;

  useEffect(() => {
    ensureWs(url);

    // Forwarder object that we register once and that reads from the
    // optionsRef. Inserting into / removing from `subscribers` works
    // on object identity, so a stable wrapper is essential.
    const wrapper: UseAvatarSocketOptions = {
      onModelInfo: (info) => optionsRef.current.onModelInfo?.(info),
      onExpression: (name, intensity, dur) =>
        optionsRef.current.onExpression?.(name, intensity, dur),
      onMotion: (group, name) => optionsRef.current.onMotion?.(group, name),
      onAudio: (audio, format, rate, lipSync, turnId, seq, last) =>
        optionsRef.current.onAudio?.(audio, format, rate, lipSync, turnId, seq, last),
      onText: (content) => optionsRef.current.onText?.(content),
      onUserMessage: (content) => optionsRef.current.onUserMessage?.(content),
      onDebug: (frame) => optionsRef.current.onDebug?.(frame),
      onIdle: () => optionsRef.current.onIdle?.(),
      onError: (message) => optionsRef.current.onError?.(message),
    };
    subscribers.add(wrapper);

    const connListener = (c: boolean) => setConnected(c);
    connectedListeners.add(connListener);
    // Sync with current state (subscriber may have been added after open).
    setConnected(sharedConnected);

    return () => {
      subscribers.delete(wrapper);
      connectedListeners.delete(connListener);
      // **Do not close the WS** — that's the whole point of this hook.
    };
  }, [url]);

  const sendReady = useCallback(() => {
    sendRaw({ type: 'Ready' });
  }, []);

  const sendTouch = useCallback((hitArea: string, x: number, y: number) => {
    sendRaw({ type: 'Touch', hit_area: hitArea, x, y });
  }, []);

  const sendMotionRequest = useCallback((group: string, name: string) => {
    sendRaw({ type: 'MotionRequest', group, name });
  }, []);

  const sendExpressionRequest = useCallback((name: string) => {
    sendRaw({ type: 'ExpressionRequest', name });
  }, []);

  return {
    connected,
    sendReady,
    sendTouch,
    sendMotionRequest,
    sendExpressionRequest,
  };
}
