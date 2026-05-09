import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string) => Promise<any>) | null {
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

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {!IS_OVERLAY_WINDOW && <Nav />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={<Loader />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/avatar" element={<Avatar />} />
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
