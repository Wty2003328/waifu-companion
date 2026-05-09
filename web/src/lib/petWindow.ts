/**
 * Tauri bridge for the desktop-pet (avatar overlay) window.
 *
 * Used by Avatar.tsx in overlay mode to:
 *   - Save / restore the window position across app restarts
 *   - Snap to a screen edge after a drag finishes
 *
 * In a plain browser these helpers degrade to no-ops (the avatar route
 * is still reachable via http://127.0.0.1:9181/avatar?overlay=1, but
 * a regular browser tab can't move its own host window).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

function tauriInvoke(): InvokeFn | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  return typeof inv === 'function' ? (inv as InvokeFn) : null;
}

export function petBridgeAvailable(): boolean {
  return tauriInvoke() !== null;
}

export interface PetGeometry { x: number; y: number; width: number; height: number; }
export interface MonitorBounds { x: number; y: number; width: number; height: number; }

export async function getPetGeometry(): Promise<PetGeometry | null> {
  const inv = tauriInvoke();
  if (!inv) return null;
  try {
    return (await inv('get_avatar_window_geometry')) as PetGeometry;
  } catch (e) {
    console.warn('petWindow: get geometry failed', e);
    return null;
  }
}

export async function setPetPosition(x: number, y: number): Promise<void> {
  const inv = tauriInvoke();
  if (!inv) return;
  try {
    await inv('set_avatar_window_position', { x: Math.round(x), y: Math.round(y) });
  } catch (e) {
    console.warn('petWindow: set position failed', e);
  }
}

export async function getPetMonitor(): Promise<MonitorBounds | null> {
  const inv = tauriInvoke();
  if (!inv) return null;
  try {
    return (await inv('get_avatar_monitor')) as MonitorBounds;
  } catch (e) {
    console.warn('petWindow: get monitor failed', e);
    return null;
  }
}

const POS_KEY = 'companion.petWindowPos.v1';

interface SavedPos { x: number; y: number; }

export function savePetPosition(x: number, y: number): void {
  try {
    const v: SavedPos = { x: Math.round(x), y: Math.round(y) };
    localStorage.setItem(POS_KEY, JSON.stringify(v));
  } catch { /* non-fatal */ }
}

export function loadPetPosition(): SavedPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.x === 'number' && typeof v?.y === 'number') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * If the pet is within `threshold` px of any monitor edge, return the
 * snapped position. Otherwise return the input unchanged. Snap aligns
 * the pet's outer rect with the edge, NOT its visual center, so the
 * window's transparent margins still hug the screen edge cleanly.
 */
export function computeSnap(
  pet: PetGeometry,
  monitor: MonitorBounds,
  threshold = 30,
): { x: number; y: number; snapped: boolean } {
  let { x, y } = pet;
  let snapped = false;
  // Left edge
  if (Math.abs(x - monitor.x) < threshold) {
    x = monitor.x;
    snapped = true;
  }
  // Right edge
  if (Math.abs((x + pet.width) - (monitor.x + monitor.width)) < threshold) {
    x = monitor.x + monitor.width - pet.width;
    snapped = true;
  }
  // Top edge
  if (Math.abs(y - monitor.y) < threshold) {
    y = monitor.y;
    snapped = true;
  }
  // Bottom edge
  if (Math.abs((y + pet.height) - (monitor.y + monitor.height)) < threshold) {
    y = monitor.y + monitor.height - pet.height;
    snapped = true;
  }
  return { x, y, snapped };
}
