/**
 * Tauri shell helpers.
 *
 * WebView2 (the browser engine Tauri uses on Windows) silently drops
 * `<a target="_blank">` and `window.open(url)` for cross-origin URLs —
 * there's no popup support in a single-window app shell. The Pulse
 * drawer's "Open ↗" button used to be a plain anchor and did nothing
 * in the desktop build (worked fine in the dev browser).
 *
 * The fix: route external opens through a Tauri command that calls
 * tauri-plugin-shell's default browser launcher. In the dev browser
 * (no Tauri runtime), fall back to `window.open` which works there.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? inv : null;
}

/** Open an http(s) URL in the user's default browser.
 *  Resolves once the OS has handed off the URL — typically <50ms.
 *  Errors are logged and swallowed so a misclick can't break the UI. */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  const inv = tauriInvoke();
  try {
    if (inv) {
      await inv('open_external_url', { url });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    console.warn('openExternal failed:', e);
  }
}
