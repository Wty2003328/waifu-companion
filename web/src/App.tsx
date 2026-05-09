import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? inv : null;
}

const PET_VISIBLE_KEY = 'companion.petVisible.v1';

// True only when this window is the main one (NOT the overlay). The
// overlay shouldn't render its own copy of the nav / pet toggle.
const IS_OVERLAY_WINDOW =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('overlay');

const Home = lazy(() => import('./pages/Home'));
const Avatar = lazy(() => import('./pages/Avatar'));
const Pulse = lazy(() => import('./pages/Pulse'));
const Settings = lazy(() => import('./pages/Settings'));
const Characters = lazy(() => import('./pages/Characters'));

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {!IS_OVERLAY_WINDOW && <Nav />}
        {!IS_OVERLAY_WINDOW && <ZeroclawHealthBanner />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={<Loader />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/avatar" element={<Avatar />} />
              <Route path="/characters" element={<Characters />} />
              <Route path="/pulse" element={<Pulse />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </BrowserRouter>
  );
}

/**
 * Banner that warns the user when zeroclaw isn't running. The
 * companion app intentionally does NOT spawn or kill zeroclaw
 * (it's a separate long-lived daemon the user manages). On startup
 * we call the Tauri command `check_zeroclaw_health` (or, in browser,
 * read /api/status's zeroclaw_up field) and surface a sticky banner
 * if it's down. We re-poll every 30s in case the user starts it.
 */
function ZeroclawHealthBanner() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const inv = tauriInvoke();
      try {
        let ok = false;
        if (inv) {
          ok = await inv('check_zeroclaw_health', { url: '' });
        } else {
          // Browser fallback: companion-server's /api/status reports
          // zeroclaw_up. May be slightly stale (last successful health
          // call) but good enough for a non-blocking banner.
          const r = await fetch('/api/status');
          if (r.ok) {
            const j = await r.json();
            ok = !!j.zeroclaw_up;
          }
        }
        if (!cancelled) setHealthy(ok);
      } catch {
        if (!cancelled) setHealthy(false);
      }
    };
    void check();
    const id = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (healthy !== false || dismissed) return null;
  return (
    <div
      style={{
        background: '#3a1c1c',
        borderBottom: '1px solid #5a2a2a',
        color: '#fcd5d5',
        padding: '8px 16px',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span>⚠️</span>
      <span style={{ flex: 1 }}>
        <strong>zeroclaw is not running.</strong> Chat will fail until you
        start it. The companion app does not start zeroclaw automatically —
        it's a separate daemon you manage. Re-checking every 30s.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        style={{
          background: 'transparent',
          color: '#fcd5d5',
          border: '1px solid #5a2a2a',
          borderRadius: 4,
          padding: '2px 10px',
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        dismiss
      </button>
    </div>
  );
}

function Nav() {
  const [petVisible, setPetVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PET_VISIBLE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Re-sync the overlay window's actual state when this component mounts
  // and any time the user flips the toggle. We don't trust the stored
  // bit alone — a Tauri restart with showPet=true should re-show.
  useEffect(() => {
    const inv = tauriInvoke();
    if (!inv) return;
    void inv(petVisible ? 'show_avatar_window' : 'hide_avatar_window').catch(
      (e) => console.error('pet toggle invoke failed:', e),
    );
  }, [petVisible]);

  const togglePet = () => {
    setPetVisible((v) => {
      const next = !v;
      try {
        localStorage.setItem(PET_VISIBLE_KEY, next ? '1' : '0');
      } catch { /* non-fatal */ }
      return next;
    });
  };

  return (
    <nav
      style={{
        display: 'flex',
        gap: 16,
        // Slightly more vertical padding so the title doesn't touch the
        // OS title bar in environments where the system extends chrome
        // into the content rect (Windows 11 Mica, some Tauri setups).
        padding: '14px 24px',
        borderBottom: '1px solid #1f2227',
        background: '#0e1014',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <Link to="/" style={{ color: '#fff', fontWeight: 600, textDecoration: 'none', fontSize: 14 }}>
        zeroclaw·companion
      </Link>
      <span style={{ flex: 1 }} />
      <NavLink to="/" label="Home" />
      <NavLink to="/avatar" label="Avatar" />
      <NavLink to="/characters" label="Characters" />
      <NavLink to="/pulse" label="Pulse" />
      <NavLink to="/settings" label="Settings" />
      <button
        type="button"
        onClick={togglePet}
        title={petVisible ? 'Hide the always-on-top desktop pet window' : 'Show the always-on-top desktop pet window'}
        style={{
          marginLeft: 8,
          padding: '4px 12px',
          borderRadius: 6,
          background: petVisible ? '#3b82f6' : 'transparent',
          border: petVisible ? 'none' : '1px solid #2a2d33',
          color: petVisible ? '#fff' : '#aaa',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {petVisible ? '🪟 Pet ON' : '🪟 Show pet'}
      </button>
    </nav>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} style={{ color: '#aaa', textDecoration: 'none', fontSize: 14 }}>
      {label}
    </Link>
  );
}

function Loader() {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: 32,
          height: 32,
          border: '2px solid #2a2d33',
          borderTopColor: '#3b82f6',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
