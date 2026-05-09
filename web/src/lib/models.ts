/**
 * Live2D model selection: lists installed models from the server,
 * persists the user's pick to localStorage so it overrides the
 * server-default model that arrives via the WS ModelInfo frame.
 */

import { HTTP_BASE } from './apiBase';

export interface InstalledModel {
  id: string;
  name: string;
  modelUrl: string;
  format: 'cubism2' | 'cubism4' | string;
}

export async function fetchInstalledModels(): Promise<InstalledModel[]> {
  try {
    const r = await fetch(`${HTTP_BASE}/api/models`);
    if (!r.ok) return [];
    const j = await r.json();
    if (!Array.isArray(j?.models)) return [];
    return j.models;
  } catch {
    return [];
  }
}

/** Open the Live2D models folder in the OS file explorer. Lets users
 *  drop in their own model folders without going through a UI
 *  uploader. Returns the resolved path string from Tauri, or null in
 *  a non-Tauri (browser) context. */
export async function openModelsFolder(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const inv = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke ?? null;
  if (typeof inv !== 'function') return null;
  try {
    return (await inv('open_models_folder')) as string;
  } catch (e) {
    console.warn('openModelsFolder failed:', e);
    return null;
  }
}

const MODEL_KEY = 'companion.userModel.v1';

/** The user's chosen model id, or null to defer to the server default. */
export function getUserModelChoice(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

export function setUserModelChoice(id: string | null): void {
  try {
    if (id === null || id === '') {
      localStorage.removeItem(MODEL_KEY);
    } else {
      localStorage.setItem(MODEL_KEY, id);
    }
  } catch { /* non-fatal */ }
}
