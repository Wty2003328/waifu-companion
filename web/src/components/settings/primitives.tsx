/**
 * Layout + atom primitives for the Settings page editors.
 *
 * Nothing here knows about agent / avatar / subagent state — every
 * component takes its data as props. Editors compose them.
 */

import React from 'react';
import { tokens } from '../../lib/theme';

/** Build a useful error message for a failed Settings POST. The naked
 *  `${r.status} ${await r.text()}` pattern produced "Save failed: 500 "
 *  (trailing space, no context) on empty bodies and dumped multi-KB
 *  Rust panic traces into the warn banner when the body was huge. This
 *  normalizes: human-readable status, truncated body, no dangling
 *  whitespace, and a non-empty fallback when the server says nothing. */
export async function saveErrorMessage(label: string, r: Response): Promise<string> {
  let body = '';
  try { body = (await r.text()).trim(); } catch { /* swallow */ }
  if (body.length > 280) body = body.slice(0, 280) + '… (truncated)';
  const status = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
  if (!body) return `${label} — ${status}. Server returned no message.`;
  return `${label} — ${status}: ${body}`;
}

// ── Layout primitives ──────────────────────────────────────────────

export function Section({
  title, description, children,
}: {
  title: string;
  /** Optional one-liner under the section title. Sets context for the section's controls. */
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{
      background: tokens.bgPanel,
      border: `1px solid ${tokens.border}`,
      borderRadius: tokens.radius,
      padding: '20px 22px',
      marginTop: 20,
    }}>
      <header style={{ marginBottom: description ? 14 : 12 }}>
        <h2 style={{
          margin: 0,
          fontSize: 15.5,
          fontWeight: 600,
          color: tokens.text,
          letterSpacing: '-0.005em',
        }}>{title}</h2>
        {description && (
          <p style={{
            margin: '4px 0 0 0',
            fontSize: 12.5,
            color: tokens.textMuted,
            lineHeight: 1.55,
          }}>{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

/** A labelled subsection within a Section. Renders the children
 *  inline (always visible — no click-to-expand) under a small caps
 *  header with a divider above, so related controls stay grouped
 *  without hiding anything behind a disclosure. */
export function Subsection({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 18,
      paddingTop: 14,
      borderTop: `1px solid ${tokens.border}`,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: tokens.textDim,
        marginBottom: 10,
      }}>{label}</div>
      {children}
    </div>
  );
}

/** Inline path field with a Browse button. Wraps the native file
 *  picker so the user doesn't have to type or paste OS paths by hand. */
export function FieldRow({
  label, hint, children,
}: {
  label: string;
  /** Optional secondary copy under the field. */
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap',
      padding: '12px 0',
      borderBottom: `1px solid ${tokens.border}`,
    }}>
      <label style={{
        minWidth: 168,
        paddingTop: 9,                 // visually centers against the input
        color: tokens.textMuted,
        fontSize: 12.5,
        fontWeight: 500,
        letterSpacing: '0.005em',
      }}>{label}</label>
      <div style={{
        flex: '1 1 280px', minWidth: 220,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {children}
        </div>
        {hint && (
          <div style={{ fontSize: 11.5, color: tokens.textDim, lineHeight: 1.5 }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

/** Footer toolbar for an editor: status hints on the left, action
 *  buttons on the right, separator above. Use this in place of an
 *  ad-hoc `<Row>` to give every editor the same end-of-form rhythm. */
export function EditorFooter({
  status, children,
}: {
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      marginTop: 16,
      paddingTop: 16,
      borderTop: `1px solid ${tokens.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {status}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
      {children}
    </div>
  );
}

export function ReadonlyRow({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'muted';
}) {
  const color = tone === 'good' ? '#10b981' : tone === 'warn' ? '#f59e0b' : '#cbd5e1';
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '6px 0',
      borderBottom: '1px solid #1f2227', fontSize: 13,
    }}>
      <span style={{ minWidth: 160, color: '#888' }}>{label}</span>
      <span style={{ color, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

// ── Atoms ──────────────────────────────────────────────────────────

/** A single row in a stacked radio-list with title + description.
 *  Used by the Translation engine selector — the three modes need
 *  more explanation than fits on one line, so each option gets its
 *  own block of help text below the label. */
export function ModeRadio({
  checked, onSelect, name, blurb,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  blurb: string;
}) {
  return (
    <label
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '8px 10px',
        background: checked ? tokens.bgPanelHi : 'transparent',
        borderRadius: 6,
        cursor: 'pointer',
        border: checked ? `1px solid ${tokens.primary}` : '1px solid transparent',
      }}
    >
      <input
        type="radio"
        name="translation-mode"
        checked={checked}
        onChange={onSelect}
        style={{ marginTop: 3, accentColor: tokens.primary }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          color: checked ? tokens.primary : tokens.text,
          fontWeight: 500,
          fontSize: 13,
        }}>
          {name}
        </span>
        <span style={{ color: tokens.textMuted, fontSize: 11.5, lineHeight: 1.4 }}>
          {blurb}
        </span>
      </div>
    </label>
  );
}

export function Toggle({
  checked, onChange, disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** When true, the toggle is non-interactive and visually muted.
   *  Used when a parent setting forces a fixed value (e.g. Local
   *  model mode forces Streaming on). */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onChange(!checked); }}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className="ws-btn"
      style={{
        width: 38, height: 22,
        background: checked ? tokens.primary : '#2a2f3a',
        borderRadius: 11, border: 'none', position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0, padding: 0,
        opacity: disabled ? 0.5 : 1,
        transition: 'background 120ms ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        transition: 'left 140ms cubic-bezier(0.4, 0, 0.2, 1)',
      }} />
    </button>
  );
}

export function Button({
  children, onClick, primary, disabled, title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const isPrimary = !!primary && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`ws-btn${isPrimary ? ' ws-btn--primary' : ''}`}
      style={{
        padding: '8px 14px',
        background: isPrimary ? tokens.primary : 'transparent',
        color: isPrimary ? '#fff' : tokens.textMuted,
        border: `1px solid ${isPrimary ? tokens.primary : tokens.border}`,
        borderRadius: tokens.radiusSm,
        fontSize: 12.5,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        minHeight: 34,
      }}
    >
      {children}
    </button>
  );
}

export function Hint({ tone, children }: { tone: 'muted' | 'good' | 'warn'; children: React.ReactNode }) {
  const color =
    tone === 'good' ? tokens.success :
    tone === 'warn' ? tokens.warn :
    tokens.textDim;
  return (
    <div style={{
      fontSize: 12,
      color,
      lineHeight: 1.5,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {children}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      background: 'rgba(239, 68, 68, 0.10)',
      border: `1px solid rgba(239, 68, 68, 0.30)`,
      color: '#fca5a5',
      padding: '12px 14px',
      borderRadius: tokens.radius,
      marginTop: 16,
      fontSize: 13,
      lineHeight: 1.5,
    }}>
      <strong style={{ color: '#fecaca' }}>Failed to load config.</strong>{' '}
      {message}
    </div>
  );
}

/** Skeleton placeholder for a section whose data is still loading.
 *  Reserves vertical space matching the editor's rough layout (a few
 *  FieldRow-sized bars) so the page doesn't visibly shift when the
 *  fetch lands. The pulsing dot from `.ws-typing-dot` cues "active". */
export function SectionLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '6px 0' }}
    >
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        fontSize: 12, color: tokens.textDim,
      }}>
        <span className="ws-typing-dot" />
        Loading current settings…
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 32,
            background: tokens.bgPanelHi,
            borderRadius: tokens.radiusSm,
            opacity: 0.55,
            // Stagger the rows visually so the skeleton doesn't read
            // as a uniform block — gives the eye something to land on.
            width: `${100 - i * 6}%`,
          }}
        />
      ))}
    </div>
  );
}

export function SubagentSpeedupHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={{
      marginTop: 12, padding: 14,
      background: tokens.bgPanelHi,
      border: `1px solid ${tokens.border}`,
      borderRadius: tokens.radius,
      fontSize: tokens.fontBody, color: tokens.text, lineHeight: 1.55,
      position: 'relative',
    }}>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="ws-btn"
        style={{
          position: 'absolute', top: 6, right: 6,
          background: 'transparent', border: 'none',
          color: tokens.textMuted, cursor: 'pointer',
          fontSize: 14, padding: '2px 6px', borderRadius: tokens.radiusXs,
        }}
      >✕</button>
      <div style={{ fontWeight: 600, color: tokens.text, marginBottom: 6 }}>
        Faster replies available
      </div>
      Routing through the main agent adds 5–10 seconds per reply. If you
      have an OpenAI / z.ai / similar API key, switch the mode above to
      <strong> Direct AI</strong> for ~1–3 second replies. The change applies
      live on <strong>Apply</strong> — no restart needed.
      <div style={{ marginTop: 6, color: tokens.textMuted }}>
        Cheap fast options: gpt-4o-mini, Groq Llama-3.3-70B, Z.ai GLM-4-Flash.
        Or run Ollama locally for free at <code>localhost:11434/v1</code>.
      </div>
    </div>
  );
}
