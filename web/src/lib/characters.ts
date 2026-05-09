/**
 * Character roster: model + system prompt bundles. The active
 * character drives the avatar canvas (which Live2D model it loads)
 * and the chat persona (companion-server prepends its system_prompt
 * to every user message before sending to upstream zeroclaw).
 *
 * Storage is server-side at companion.characters.json — same machine
 * as companion.toml. We hit the REST endpoints rather than caching
 * locally so multiple windows always see the same roster.
 */

import { HTTP_BASE } from './apiBase';
import { invalidateCache } from './fetchCache';

export interface Character {
  id: string;
  name: string;
  /** Live2D model id (matches `web/public/live2d/models/<id>/`).
   *  Empty string defers to the server-default model. */
  model_id: string;
  /** Verbatim text prepended to every user message before zeroclaw
   *  sees it. Empty string disables the prepend (vanilla chat). */
  system_prompt: string;
  /** Optional markdown notes (lore, scenario, speech style). Edited
   *  in the Characters page, appended after `system_prompt` when
   *  composing the persona payload to zeroclaw. */
  notes?: string;
}

export interface AttachmentSummary {
  name: string;
  size: number;
}

export interface CharactersFile {
  active_id: string;
  characters: Character[];
}

export async function fetchCharacters(): Promise<CharactersFile> {
  const r = await fetch(`${HTTP_BASE}/api/characters`);
  if (!r.ok) throw new Error(`fetchCharacters: ${r.status}`);
  return r.json();
}

export async function upsertCharacter(c: Character): Promise<void> {
  const r = await fetch(`${HTTP_BASE}/api/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  });
  if (!r.ok) throw new Error(`upsertCharacter: ${r.status} ${await r.text()}`);
  invalidateCache(`${HTTP_BASE}/api/characters`);
}

export async function deleteCharacter(id: string): Promise<void> {
  const r = await fetch(`${HTTP_BASE}/api/characters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!r.ok) throw new Error(`deleteCharacter: ${r.status} ${await r.text()}`);
  invalidateCache(`${HTTP_BASE}/api/characters`);
}

export async function activateCharacter(id: string): Promise<void> {
  const r = await fetch(`${HTTP_BASE}/api/characters/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`activateCharacter: ${r.status} ${await r.text()}`);
  invalidateCache(`${HTTP_BASE}/api/characters`);
}

// ── Attachments (per-character markdown files on disk) ──────────

export async function listCharacterAttachments(id: string): Promise<AttachmentSummary[]> {
  const r = await fetch(`${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments`);
  if (!r.ok) throw new Error(`listAttachments: ${r.status}`);
  const j = await r.json();
  return j.attachments ?? [];
}

export async function readCharacterAttachment(id: string, file: string): Promise<string> {
  const r = await fetch(
    `${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file)}`,
  );
  if (!r.ok) throw new Error(`readAttachment ${file}: ${r.status}`);
  const j = await r.json();
  return j.body ?? '';
}

export async function writeCharacterAttachment(
  id: string, file: string, body: string,
): Promise<void> {
  const r = await fetch(
    `${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  if (!r.ok) throw new Error(`writeAttachment ${file}: ${r.status} ${await r.text()}`);
  invalidateCache(`${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments`);
}

export async function deleteCharacterAttachment(id: string, file: string): Promise<void> {
  const r = await fetch(
    `${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file)}`,
    { method: 'DELETE' },
  );
  if (!r.ok) throw new Error(`deleteAttachment ${file}: ${r.status}`);
  invalidateCache(`${HTTP_BASE}/api/characters/${encodeURIComponent(id)}/attachments`);
}

/** Fire when a character change should be reflected in other open
 *  components (e.g., the Avatar window's effective model selection).
 *
 *  Dispatches BOTH a same-window DOM event and a BroadcastChannel
 *  message. The BroadcastChannel is what reaches the separate Tauri
 *  windows (overlay avatar) since `window.dispatchEvent` is in-window
 *  only — without it, switching character in the main window leaves
 *  the overlay's Live2D model stale until the user reloads. */
export function broadcastCharacterChange(): void {
  window.dispatchEvent(new Event('companion:characters'));
  try {
    const ch = new BroadcastChannel('companion');
    ch.postMessage({ kind: 'characters' });
    ch.close();
  } catch { /* BroadcastChannel may be unavailable in old contexts */ }
}
