import { useEffect, useState } from 'react';
import {
  type Character,
  type CharactersFile,
  type AttachmentSummary,
  activateCharacter,
  broadcastCharacterChange,
  deleteCharacter,
  listCharacterAttachments,
  readCharacterAttachment,
  writeCharacterAttachment,
  deleteCharacterAttachment,
  upsertCharacter,
} from '../lib/characters';
import {
  fetchInstalledModels,
  openModelsFolder,
  type InstalledModel,
} from '../lib/models';
import { useCachedJson } from '../lib/fetchCache';
import { HTTP_BASE } from '../lib/apiBase';

/**
 * Character roster — used to be its own page (`/characters`). Folded
 * into Home in 2026-05 because the rest of the UI was just plumbing
 * around the active character anyway: top nav was getting noisy and
 * the roster is the thing the user wants on the main screen.
 *
 * Each character bundles { name, model_id, system_prompt, notes } and
 * the "active" one drives:
 *   - Avatar canvas (which Live2D model loads).
 *   - Chat persona (companion-server prepends `system_prompt` to every
 *     user message before forwarding to upstream zeroclaw).
 *
 * Storage is server-side at companion.characters.json (sibling of
 * companion.toml) — every window sees the same roster.
 */
export default function CharacterRoster() {
  // Cached read of /api/characters — instant on revisit; mutations
  // below invalidate the cache so the roster refreshes after any
  // upsert/delete/activate without a manual `reload()`.
  const url = `${HTTP_BASE}/api/characters`;
  const { data: file, error: fileError } = useCachedJson<CharactersFile>(url, 30_000);
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const error = mutationError ?? fileError;

  useEffect(() => {
    // Models list comes from a static directory scan; cache TTL not
    // worth the indirection — fetch once on mount.
    void fetchInstalledModels().then(setModels);
  }, []);

  const onActivate = async (id: string) => {
    setMutationError(null);
    try {
      await activateCharacter(id);
      broadcastCharacterChange();
    } catch (e) {
      setMutationError(String(e));
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm(`Delete character ${id}?`)) return;
    setMutationError(null);
    try {
      await deleteCharacter(id);
      broadcastCharacterChange();
    } catch (e) {
      setMutationError(String(e));
    }
  };

  const onSave = async (c: Character) => {
    setMutationError(null);
    try {
      await upsertCharacter(c);
      broadcastCharacterChange();
      setEditing(null);
    } catch (e) {
      setMutationError(String(e));
    }
  };

  const newCharacter = (): Character => ({
    id: `char-${Date.now()}`,
    name: 'New character',
    model_id: models[0]?.id ?? '',
    system_prompt: '',
    notes: '',
  });

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Characters</h2>
        <span style={{ fontSize: 12, color: '#666' }}>
          Each character has its own avatar and personality. Activate one to chat with it.
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setEditing(newCharacter())}
          style={primaryBtn}
        >
          + New character
        </button>
      </div>

      {error && <ErrorBox message={error} />}

      {!file ? (
        <Hint>loading…</Hint>
      ) : file.characters.length === 0 ? (
        <Hint>
          No characters yet. Click <strong>+ New character</strong> to define
          one — give it a name, pick a model, and write the persona prompt
          you'd like zeroclaw to play.
        </Hint>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    </section>
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
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
  // Local copy of models so the dropdown can refresh after the user
  // drops new model folders into the directory without re-mounting
  // the modal.
  const [localModels, setLocalModels] = useState<InstalledModel[]>(models);
  const [refreshing, setRefreshing] = useState(false);
  const refreshModels = async () => {
    setRefreshing(true);
    try { setLocalModels(await fetchInstalledModels()); }
    finally { setRefreshing(false); }
  };
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
        <Field label="ID (can't change)">
          <input
            type="text"
            value={draft.id}
            disabled
            style={{ ...inputStyle, opacity: 0.5 }}
          />
        </Field>
        <Field label="Avatar model">
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={draft.model_id}
              onChange={(e) => setDraft({ ...draft, model_id: e.target.value })}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">(use the default model)</option>
              {localModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.format})</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void openModelsFolder()}
              title="Open the Live2D models folder so you can drop in new ones"
              style={secondaryBtn}
            >
              + Add model
            </button>
            <button
              type="button"
              onClick={() => void refreshModels()}
              disabled={refreshing}
              style={{ ...secondaryBtn, opacity: refreshing ? 0.5 : 1 }}
            >
              {refreshing ? '…' : '↻'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Click <strong>+ Add model</strong> to open the folder where Live2D
            models live. Drop a model folder there (must contain a{' '}
            <code style={{ color: '#888' }}>.model3.json</code> or{' '}
            <code style={{ color: '#888' }}>.model.json</code> file), then
            click <strong>↻</strong> to refresh this list.
          </div>
        </Field>
        <Field label="Personality prompt">
          <textarea
            value={draft.system_prompt}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            placeholder="You are a warm, casual companion. Speak naturally, like a close friend..."
            style={{ ...inputStyle, minHeight: 160, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
          />
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            How this character talks. Added to every message you send so
            the agent stays in character. Leave blank for plain chat.
          </div>
        </Field>
        <Field label="Notes & lore (markdown)">
          <textarea
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            placeholder={"Backstory, scenario, speech style…\n\nUse markdown headings to organize sections."}
            style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
          />
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Extra context for this character — backstory, world details,
            speech quirks. Added after the personality prompt. For longer
            content (whole lorebooks), use Markdown files below.
          </div>
        </Field>
        <AttachmentsPanel charId={character.id} />

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

/** Editor for the per-character `*.md` files at
 *  `<config-dir>/characters/<id>/`. Each save round-trips through
 *  the server (it writes to disk, then the next chat turn picks it
 *  up automatically). The user can also drop files into that
 *  directory with their own editor and click Refresh — both paths
 *  produce the same on-disk state. */
function AttachmentsPanel({ charId }: { charId: string }) {
  const [list, setList] = useState<AttachmentSummary[]>([]);
  const [openName, setOpenName] = useState<string | null>(null);
  const [openBody, setOpenBody] = useState<string>('');
  const [draftBody, setDraftBody] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshList = async () => {
    setErr(null);
    try { setList(await listCharacterAttachments(charId)); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { void refreshList(); }, [charId]);

  const open = async (name: string) => {
    setErr(null);
    try {
      const body = await readCharacterAttachment(charId, name);
      setOpenName(name); setOpenBody(body); setDraftBody(body);
    } catch (e) { setErr(String(e)); }
  };
  const saveOpen = async () => {
    if (!openName) return;
    setBusy(true); setErr(null);
    try {
      await writeCharacterAttachment(charId, openName, draftBody);
      setOpenBody(draftBody);
      await refreshList();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const removeFile = async (name: string) => {
    if (!confirm(`Delete attachment ${name}?`)) return;
    setBusy(true); setErr(null);
    try {
      await deleteCharacterAttachment(charId, name);
      if (openName === name) { setOpenName(null); setOpenBody(''); setDraftBody(''); }
      await refreshList();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const createFile = async () => {
    const cleaned = newName.trim();
    if (!cleaned) return;
    const safe = cleaned.toLowerCase().endsWith('.md') ? cleaned : `${cleaned}.md`;
    setBusy(true); setErr(null);
    try {
      await writeCharacterAttachment(charId, safe, '# ' + safe.replace(/\.md$/i, '') + '\n\n');
      setNewName('');
      await refreshList();
      void open(safe);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const dirty = openName !== null && draftBody !== openBody;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <div style={{ fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ color: '#cbd5e1', fontWeight: 600 }}>Markdown files</strong>
        <span style={{ fontSize: 11 }}>— for longer notes (lorebook, world, scenarios)</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={refreshList} style={secondaryBtn}>Refresh</button>
      </div>
      {err && <div style={{ fontSize: 12, color: '#fca5a5' }}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {list.length === 0 && (
          <div style={{ fontSize: 12, color: '#666' }}>
            No files yet. Click "+ Add file" below to create one.
          </div>
        )}
        {list.map((a) => (
          <div key={a.name} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void open(a.name)}
              style={{
                ...secondaryBtn,
                background: openName === a.name ? '#1e293b' : 'transparent',
                color: openName === a.name ? '#fff' : '#aaa',
                fontSize: 12, padding: '4px 10px',
              }}
              title={`${a.size} bytes`}
            >
              {a.name}
            </button>
            <button
              type="button"
              onClick={() => void removeFile(a.name)}
              disabled={busy}
              style={{ ...dangerBtn, padding: '2px 6px', fontSize: 11 }}
              aria-label={`Delete ${a.name}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          placeholder="lore.md"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createFile(); } }}
          style={{ ...inputStyle, flex: 1, fontSize: 12, padding: '4px 8px' }}
        />
        <button
          type="button"
          onClick={() => void createFile()}
          disabled={busy || !newName.trim()}
          style={{ ...primaryBtn, fontSize: 12, padding: '4px 10px',
                   opacity: busy || !newName.trim() ? 0.5 : 1 }}
        >
          + Add file
        </button>
      </div>
      {openName && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#aaa' }}>
              Editing <code style={{ color: '#cbd5e1' }}>{openName}</code>
              {dirty && <span style={{ color: '#fbbf24', marginLeft: 6 }}>•</span>}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void saveOpen()}
              disabled={busy || !dirty}
              style={{ ...primaryBtn, fontSize: 12, padding: '4px 10px',
                       opacity: busy || !dirty ? 0.5 : 1 }}
            >
              Save
            </button>
          </div>
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            spellCheck={false}
            style={{ ...inputStyle, minHeight: 200, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
          />
        </div>
      )}
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
      fontSize: 13,
    }}>
      {message}
    </div>
  );
}
function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ color: '#888', fontSize: 13, lineHeight: 1.6 }}>{children}</div>;
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
