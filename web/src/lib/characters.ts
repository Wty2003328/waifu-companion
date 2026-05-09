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

export interface Character {
  id: string;
  name: string;
  /** Live2D model id (matches `web/public/live2d/models/<id>/`).
   *  Empty string defers to the server-default model. */
  model_id: string;
  /** Verbatim text prepended to every user message before zeroclaw
   *  sees it. Empty string disables the prepend (vanilla chat). */
  system_prompt: string;
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
}

export async function deleteCharacter(id: string): Promise<void> {
  const r = await fetch(`${HTTP_BASE}/api/characters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!r.ok) throw new Error(`deleteCharacter: ${r.status} ${await r.text()}`);
}

export async function activateCharacter(id: string): Promise<void> {
  const r = await fetch(`${HTTP_BASE}/api/characters/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`activateCharacter: ${r.status} ${await r.text()}`);
}

/** Fire when a character change should be reflected in other open
 *  components (e.g., the Avatar window's effective model selection). */
export function broadcastCharacterChange(): void {
  window.dispatchEvent(new Event('companion:characters'));
}
