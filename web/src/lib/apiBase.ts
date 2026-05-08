// Where to reach companion-server.
//
// Resolution order:
//   1. localStorage `companion.serverUrl` (user override, set on Home page)
//   2. Tauri webview detected → hardcoded `http://127.0.0.1:9181`
//      (relative URLs in Tauri route into Tauri's asset protocol, not HTTP)
//   3. Browser → empty string, so fetch('/api/x') stays same-origin
//      (browser served from companion-server itself)
//
// Use HTTP_BASE for fetch() URLs, WS_BASE for new WebSocket() URLs.
// Both are evaluated lazily so a user save persists across reloads.

const STORAGE_KEY = 'companion.serverUrl';
const DEFAULT_TAURI_HOST = '127.0.0.1:9181';

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__TAURI_INTERNALS__ != null || w.__TAURI__ != null) return true;
  if (typeof window.location !== 'undefined') {
    const proto = window.location.protocol;
    if (proto === 'tauri:' || proto === 'tauri-asset:') return true;
    if (window.location.host === 'tauri.localhost') return true;
  }
  return false;
}

/** Read the user-saved companion URL, if any. Empty string when unset. */
export function getStoredServerUrl(): string {
  try {
    return (localStorage.getItem(STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/** Persist a user-supplied companion URL. Pass empty string to clear. */
export function setStoredServerUrl(url: string): void {
  try {
    if (!url.trim()) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, url.trim().replace(/\/+$/, ''));
  } catch {
    // localStorage might be unavailable; non-fatal
  }
}

/** Best-effort default URL used when the user hasn't customized. */
export function getDefaultServerUrl(): string {
  if (isTauri()) return `http://${DEFAULT_TAURI_HOST}`;
  if (typeof window !== 'undefined' && window.location?.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }
  return `http://${DEFAULT_TAURI_HOST}`;
}

/** Effective companion HTTP base URL. */
export function getServerUrl(): string {
  return getStoredServerUrl() || getDefaultServerUrl();
}

// HTTP_BASE: use directly for fetch() URLs. In browser+default mode, returns
// '' so fetch('/api/x') stays a relative same-origin request.
export const HTTP_BASE: string = (() => {
  const stored = getStoredServerUrl();
  if (stored) return stored;
  if (isTauri()) return `http://${DEFAULT_TAURI_HOST}`;
  return ''; // browser, same-origin: use relative URLs
})();

// WS_BASE: equivalent for new WebSocket() URLs.
export const WS_BASE: string = (() => {
  const stored = getStoredServerUrl();
  const httpUrl = stored || (isTauri() ? `http://${DEFAULT_TAURI_HOST}` : '');
  if (httpUrl) {
    // http(s):// → ws(s)://
    return httpUrl.replace(/^http/, 'ws');
  }
  // Browser, same-origin
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://${DEFAULT_TAURI_HOST}`;
})();
