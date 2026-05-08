// In the browser, the page is served from http://127.0.0.1:9181/ so
// relative URLs (`/api/chat`, `/ws/avatar`) resolve to companion-server
// directly. Vite dev mode also handles this via its proxy config.
//
// In the Tauri webview, the page is served from a custom protocol
// (tauri://localhost/) — relative URLs would route into Tauri's asset
// handler, not the companion-server. Tauri-mode detection: window
// exposes __TAURI_INTERNALS__ (Tauri 2) or __TAURI__ (Tauri 1, kept
// for safety) globals. We also fall back to a hostname check for
// future variants.
//
// Use HTTP_BASE for fetch() URLs, WS_BASE for new WebSocket() URLs.

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__TAURI_INTERNALS__ != null || w.__TAURI__ != null) return true;
  // Tauri 2 also exposes the page via tauri.localhost in some configs.
  if (typeof window.location !== 'undefined') {
    const proto = window.location.protocol;
    if (proto === 'tauri:' || proto === 'tauri-asset:') return true;
    if (window.location.host === 'tauri.localhost') return true;
  }
  return false;
}

const COMPANION_HOST = '127.0.0.1:9181';

export const HTTP_BASE = isTauri() ? `http://${COMPANION_HOST}` : '';

export const WS_BASE: string = (() => {
  if (isTauri()) return `ws://${COMPANION_HOST}`;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://${COMPANION_HOST}`;
})();
