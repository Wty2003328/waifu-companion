// Toast bar that surfaces transitions in service health.
//
// Polls /api/status every 8s and emits a transient toast when a
// subsystem flips up→down (e.g. TTS crashed after a successful Apply,
// or the main agent went offline). Up→up and down→down don't toast;
// down→up emits a quiet "recovered" toast that auto-dismisses.
//
// Designed to live high in the tree (App.tsx) so toasts are visible
// from any page. Click a toast to dismiss it manually; otherwise it
// auto-fades after a few seconds.

import { useEffect, useState, useCallback } from 'react';
import { HTTP_BASE } from '../lib/apiBase';
import { tokens } from '../lib/theme';

interface StatusSnap {
  agent_up?: boolean;
  zeroclaw_up?: boolean; // legacy alias
  agent_last_error?: string | null;
  tts_up?: boolean;
  tts_last_error?: string | null;
  subagent_up?: boolean;
  subagent_last_error?: string | null;
  avatar_enabled?: boolean;
}

interface Toast {
  id: number;
  tone: 'warn' | 'good';
  title: string;
  body?: string;
}

const POLL_MS = 8_000;
let toastCounter = 0;

export default function ServiceToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Previous-tick state, used to detect transitions. We don't fire
  // a toast on the very first poll — if the agent is already down at
  // boot, the banner at the top handles that case better than a
  // transient toast would.
  const [prev, setPrev] = useState<StatusSnap | null>(null);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastCounter;
    setToasts((cur) => [...cur, { ...t, id }]);
    // Auto-dismiss after 8s. Failures linger a bit longer than
    // recoveries because the user might want to read the error.
    const ttl = t.tone === 'warn' ? 12_000 : 6_000;
    setTimeout(() => {
      setToasts((cur) => cur.filter((x) => x.id !== id));
    }, ttl);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let prevLocal: StatusSnap | null = prev;

    const tick = async () => {
      try {
        const r = await fetch(`${HTTP_BASE}/api/status`);
        if (!r.ok) return;
        const j: StatusSnap = await r.json();
        if (cancelled) return;
        // Coerce legacy alias.
        if (j.agent_up === undefined && j.zeroclaw_up !== undefined) {
          j.agent_up = j.zeroclaw_up;
        }
        if (prevLocal) {
          // Transition: was up, now down.
          if (prevLocal.agent_up && !j.agent_up) {
            pushToast({
              tone: 'warn',
              title: 'Main agent went offline',
              body: j.agent_last_error ?? 'No response to /health.',
            });
          } else if (!prevLocal.agent_up && j.agent_up) {
            pushToast({ tone: 'good', title: 'Main agent reconnected' });
          }
          if (j.avatar_enabled) {
            if (prevLocal.tts_up && !j.tts_up) {
              pushToast({
                tone: 'warn',
                title: 'Voice synthesis stopped responding',
                body: j.tts_last_error ?? 'TTS /health returned an error.',
              });
            } else if (!prevLocal.tts_up && j.tts_up) {
              pushToast({ tone: 'good', title: 'Voice synthesis recovered' });
            }
          }
        }
        prevLocal = j;
        setPrev(j);
      } catch {
        // Network blip while polling is itself meaningful but noisy;
        // skip the toast and let the next tick recover.
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div style={{
      position: 'fixed',
      bottom: 16,
      right: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      zIndex: 9999,
      maxWidth: 380,
      pointerEvents: 'none', // toasts capture clicks individually
    }}>
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
          style={{
            pointerEvents: 'auto',
            background: t.tone === 'warn'
              ? 'rgba(239, 68, 68, 0.12)'
              : 'rgba(16, 185, 129, 0.12)',
            border: `1px solid ${t.tone === 'warn' ? 'rgba(239,68,68,0.35)' : 'rgba(16,185,129,0.35)'}`,
            color: tokens.text,
            padding: '10px 14px',
            borderRadius: tokens.radius,
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 12.5,
            lineHeight: 1.5,
            boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
            animation: 'companion-fade-in 160ms ease-out',
          }}
        >
          <div style={{
            fontWeight: 600,
            color: t.tone === 'warn' ? '#fecaca' : '#86efac',
            marginBottom: t.body ? 2 : 0,
          }}>
            {t.tone === 'warn' ? '⚠ ' : '✓ '}{t.title}
          </div>
          {t.body && (
            <div style={{ color: tokens.textMuted, fontSize: 11.5 }}>{t.body}</div>
          )}
        </button>
      ))}
    </div>
  );
}
