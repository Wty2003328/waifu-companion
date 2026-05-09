import { useEffect, useState } from 'react';
import {
  type Character,
  type CharactersFile,
  activateCharacter,
  broadcastCharacterChange,
  deleteCharacter,
  fetchCharacters,
  upsertCharacter,
} from '../lib/characters';
import {
  fetchInstalledModels,
  type InstalledModel,
} from '../lib/models';

/**
 * Character roster page.
 *
 * Each character bundles { name, model_id, system_prompt } and the
 * "active" one is what the rest of the app uses:
 *   - Avatar canvas swaps to the character's Live2D model.
 *   - companion-server prepends `system_prompt` to every user
 *     message before forwarding to upstream zeroclaw, so you can
 *     define different personas without touching zeroclaw's config.
 *
 * Storage is server-side at companion.characters.json (sibling of
 * companion.toml) — every window sees the same roster.
 */
export default function CharactersPage() {
  const [file, setFile] = useState<CharactersFile | null>(null);
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => fetchCharacters().then(setFile).catch((e) => setError(String(e)));

  useEffect(() => {
    void reload();
    void fetchInstalledModels().then(setModels);
  }, []);

  const onActivate = async (id: string) => {
    setError(null);
    try {
      await activateCharacter(id);
      broadcastCharacterChange();
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Delete character ${id}?`)) return;
    setError(null);
    try {
      await deleteCharacter(id);
      broadcastCharacterChange();
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const onSave = async (c: Character) => {
    setError(null);
    try {
      await upsertCharacter(c);
      broadcastCharacterChange();
      setEditing(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const newCharacter = (): Character => ({
    id: `char-${Date.now()}`,
    name: 'New character',
    model_id: models[0]?.id ?? '',
    system_prompt: '',
  });

  return (
    <div style={{ padding: 32, maxWidth: 880, margin: '0 auto', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Characters</h1>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setEditing(newCharacter())}
          style={primaryBtn}
        >
          + New character
        </button>
      </div>
      <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>
        Each character bundles a Live2D model + a system prompt. The
        active character drives the avatar canvas and the chat persona;
        the subagent (translation) stays the same regardless. Active
        roster lives at <code style={{ color: '#aaa' }}>companion.characters.json</code>.
      </p>

      {error && <ErrorBox message={error} />}

      {!file ? (
        <Hint tone="muted">loading…</Hint>
      ) : file.characters.length === 0 ? (
        <Hint tone="muted">
          No characters yet. Click <strong>+ New character</strong> to define
          one — give it a name, pick a model, and write the persona prompt
          you'd like zeroclaw to play.
        </Hint>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {file.characters.map((c) => (
            <CharacterCard
              key={c.id}
              character={c}
              active={file.active_id === c.id}
              models={models}
              onActivate={() => onActivate(c.id)}
              onEdit={() => setEditing(c)}
              onDelete={() => onDelete(c.id)}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal
          character={editing}
          models={models}
          onCancel={() => setEditing(null)}
          onSave={onSave}
        />
      )}
    </div>
  );
}

function CharacterCard({
  character,
  active,
  models,
  onActivate,
  onEdit,
  onDelete,
}: {
  character: Character;
  active: boolean;
  models: InstalledModel[];
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const modelLabel =
    models.find((m) => m.id === character.model_id)?.name ?? character.model_id ?? '(server default)';
  return (
    <div
      style={{
        background: active ? '#142133' : '#16181c',
        border: active ? '2px solid #3b82f6' : '1px solid #2a2d33',
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{character.name}</div>
        <div style={{ fontSize: 11, color: '#888', fontFamily: 'ui-monospace, monospace' }}>
          {character.id}
        </div>
        {active && (
          <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>● ACTIVE</div>
        )}
        <span style={{ flex: 1 }} />
        {!active && (
          <button type="button" onClick={onActivate} style={primaryBtn}>
            Activate
          </button>
        )}
        <button type="button" onClick={onEdit} style={secondaryBtn}>Edit</button>
        <button type="button" onClick={onDelete} style={dangerBtn}>Delete</button>
      </div>
      <div style={{ fontSize: 12, color: '#aaa' }}>
        <strong style={{ color: '#cbd5e1' }}>Model:</strong> {modelLabel}
      </div>
      <div style={{ fontSize: 12, color: '#aaa' }}>
        <strong style={{ color: '#cbd5e1' }}>System prompt:</strong>{' '}
        {character.system_prompt
          ? <span style={{ fontStyle: 'italic' }}>"{character.system_prompt.slice(0, 240)}{character.system_prompt.length > 240 ? '…' : ''}"</span>
          : <span style={{ color: '#666' }}>(none — vanilla chat)</span>}
      </div>
    </div>
  );
}

function EditModal({
  character,
  models,
  onCancel,
  onSave,
}: {
  character: Character;
  models: InstalledModel[];
  onCancel: () => void;
  onSave: (c: Character) => void;
}) {
  const [draft, setDraft] = useState<Character>(character);
  const [saving, setSaving] = useState(false);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#16181c', border: '1px solid #2a2d33', borderRadius: 10,
          padding: 24, minWidth: 480, maxWidth: 720, width: '100%',
          maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Edit character</h2>
        <Field label="Name">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="ID (immutable)">
          <input
            type="text"
            value={draft.id}
            disabled
            style={{ ...inputStyle, opacity: 0.5 }}
          />
        </Field>
        <Field label="Live2D model">
          <select
            value={draft.model_id}
            onChange={(e) => setDraft({ ...draft, model_id: e.target.value })}
            style={inputStyle}
          >
            <option value="">(server default)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name} ({m.format})</option>
            ))}
          </select>
        </Field>
        <Field label="System prompt">
          <textarea
            value={draft.system_prompt}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            placeholder="You are Yuuki Asuna from SAO. Speak warmly, use playful Japanese mannerisms..."
            style={{ ...inputStyle, minHeight: 160, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
          />
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Prepended verbatim to every user message before zeroclaw
            sees it. Leave empty for vanilla zeroclaw chat.
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onCancel} style={secondaryBtn}>Cancel</button>
          <button
            type="button"
            disabled={saving || !draft.name.trim()}
            onClick={async () => {
              setSaving(true);
              try { await onSave(draft); }
              finally { setSaving(false); }
            }}
            style={{ ...primaryBtn, opacity: saving || !draft.name.trim() ? 0.5 : 1 }}
          >
            {saving ? 'saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── styled-component-style helpers ──
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#888' }}>{label}</span>
      {children}
    </label>
  );
}
function ErrorBox({ message }: { message: string }) {
  return (
    <div style={{
      background: '#1f1316', color: '#fca5a5', padding: 12, borderRadius: 8,
      marginTop: 16, fontSize: 13,
    }}>
      {message}
    </div>
  );
}
function Hint({ tone, children }: { tone: 'muted' | 'good'; children: React.ReactNode }) {
  const color = tone === 'good' ? '#10b981' : '#888';
  return <div style={{ marginTop: 16, color, fontSize: 13, lineHeight: 1.6 }}>{children}</div>;
}
const inputStyle: React.CSSProperties = {
  background: '#0b0d10',
  color: '#fff',
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid #2a2d33',
  fontSize: 13,
  outline: 'none',
};
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #2a2d33',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  color: '#fca5a5',
  border: '1px solid #4b2a2a',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};
