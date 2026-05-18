/**
 * Voice-input hook for the avatar chat.
 *
 * Wire shape:
 *   1. start() — `getUserMedia({audio})` + MediaRecorder, capture WebM/Opus
 *      (or whatever the browser hands us; the sidecar resamples via
 *      faster-whisper's preprocessor — format-agnostic).
 *   2. stop()  — finalize recording, base64-encode, POST to
 *      `${HTTP_BASE}/api/avatar/asr`, fire `onTranscript`.
 *   3. cancel() — drop the recorder without sending.
 *
 * Error states surfaced via `error` are user-facing strings (mic denied,
 * sidecar 503, network failure). The caller renders them next to the
 * mic button so the user knows why nothing happened.
 *
 * The chat input is reusing the same `setChatInput` setter on transcribe
 * success — so the user can edit the transcript before sending, instead
 * of force-submitting (which feels worse when ASR mishears).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceInputState =
  | 'idle'
  | 'permission'   // waiting for mic permission prompt
  | 'recording'
  | 'transcribing' // POSTing to /api/avatar/asr
  | 'error';

export interface VoiceInputOptions {
  /** API base — pass `HTTP_BASE` from apiBase.ts. */
  apiBase: string;
  /** Forwarded to the sidecar as `language` hint. Leave undefined for auto-detect. */
  language?: string;
  /** Called with the transcript on success. */
  onTranscript: (text: string) => void;
  /** Maximum recording length in seconds. Default 30. */
  maxSeconds?: number;
  /** Minimum recording length in milliseconds to send. Default 250 — anything
   *  shorter is a button-bounce / accidental press and Whisper would just
   *  hallucinate. */
  minMs?: number;
}

export interface VoiceInputHandle {
  state: VoiceInputState;
  error: string | null;
  /** Begin recording. No-op if already active. */
  start: () => Promise<void>;
  /** Stop and transcribe. No-op if not recording. */
  stop: () => Promise<void>;
  /** Stop without transcribing — used for "release outside button" gestures. */
  cancel: () => void;
  /** True iff the browser exposes MediaRecorder + getUserMedia. */
  supported: boolean;
}

function toBase64(buf: ArrayBuffer): string {
  // Loop in 16 KB chunks so very large clips don't blow the stack
  // when spreading bytes into String.fromCharCode.
  const bytes = new Uint8Array(buf);
  const chunk = 0x4000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export function useVoiceInput(opts: VoiceInputOptions): VoiceInputHandle {
  const { apiBase, language, onTranscript, maxSeconds = 30, minMs = 250 } = opts;

  const [state, setState] = useState<VoiceInputState>('idle');
  const [error, setError] = useState<string | null>(null);

  const mediaRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const cancelRef = useRef<boolean>(false);
  const timeoutRef = useRef<number | null>(null);

  const supported = (() => {
    if (typeof window === 'undefined') return false;
    return (
      typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && !!navigator.mediaDevices.getUserMedia
      && typeof window.MediaRecorder !== 'undefined'
    );
  })();

  // Clean up any open mic + recorder when the component unmounts. Without
  // this, navigating away mid-recording leaks the microphone indicator
  // and the OS keeps showing "mic in use".
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch { /* already stopped */ }
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const start = useCallback(async () => {
    if (!supported) {
      setError('Voice input not supported in this browser');
      setState('error');
      return;
    }
    if (state === 'recording' || state === 'transcribing') return;

    setError(null);
    setState('permission');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // Common cases: NotAllowedError (user denied), NotFoundError (no mic).
      // Pick the most actionable message.
      const friendly =
        /NotAllowed|denied|Permission/i.test(msg)
          ? 'Microphone permission denied — enable it in your browser/OS settings.'
          : /NotFound|no device/i.test(msg)
          ? 'No microphone detected.'
          : `Could not start recording: ${msg}`;
      setError(friendly);
      setState('error');
      return;
    }
    mediaRef.current = stream;
    chunksRef.current = [];
    cancelRef.current = false;
    // Browser-preferred mime; whisper's preprocessor resamples regardless.
    // Some Chromium builds reject 'audio/webm' even when supported, so we
    // fall through to an empty options bag if MediaRecorder rejects ours.
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    } catch {
      rec = new MediaRecorder(stream);
    }
    recorderRef.current = rec;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    startedAtRef.current = Date.now();
    rec.start();
    setState('recording');

    // Safety net: auto-stop after maxSeconds so a stuck button doesn't
    // record forever.
    timeoutRef.current = window.setTimeout(() => {
      try { rec.stop(); } catch { /* already stopped */ }
    }, maxSeconds * 1000);
  }, [supported, state, maxSeconds]);

  const finalize = useCallback(
    async (blob: Blob, durMs: number) => {
      if (durMs < minMs) {
        setError(null);
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        const buf = await blob.arrayBuffer();
        const audio = toBase64(buf);
        const resp = await fetch(`${apiBase}/api/avatar/asr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio, language }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          const friendly =
            resp.status === 503
              ? `Voice input unavailable: ${body}`
              : `Transcription failed (${resp.status}): ${body || resp.statusText}`;
          setError(friendly);
          setState('error');
          return;
        }
        const data: { text?: string } = await resp.json();
        const text = (data.text ?? '').trim();
        if (!text) {
          // Whisper sometimes returns an empty string on very quiet /
          // empty audio. Surface as a soft error instead of silently
          // putting nothing in the input box.
          setError('Did not catch any speech — try again.');
          setState('error');
          return;
        }
        onTranscript(text);
        setError(null);
        setState('idle');
      } catch (e) {
        setError(`Network error: ${(e as Error).message || String(e)}`);
        setState('error');
      }
    },
    [apiBase, language, minMs, onTranscript],
  );

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || state !== 'recording') return;
    cancelRef.current = false;
    const startedAt = startedAtRef.current;
    return new Promise<void>((resolve) => {
      rec.onstop = async () => {
        // Free the mic before posting — otherwise the OS indicator
        // stays on through the network call.
        mediaRef.current?.getTracks().forEach((t) => t.stop());
        mediaRef.current = null;
        recorderRef.current = null;
        if (timeoutRef.current) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        if (cancelRef.current) {
          setState('idle');
          setError(null);
          resolve();
          return;
        }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        await finalize(blob, Date.now() - startedAt);
        resolve();
      };
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
  }, [state, finalize]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
    try { recorderRef.current?.stop(); } catch { /* */ }
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    recorderRef.current = null;
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState('idle');
    setError(null);
  }, []);

  return { state, error, start, stop, cancel, supported };
}
