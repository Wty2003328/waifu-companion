/**
 * Settings page — composes the three editors (agent / avatar / subagent)
 * plus the companion-service-URL block.
 *
 * Each editor is in its own file under web/src/components/settings/;
 * shared layout + atom primitives live alongside them in primitives.tsx.
 */

import { useState } from 'react';
import {
  HTTP_BASE,
  getDefaultServerUrl,
  getServerUrl,
  getStoredServerUrl,
  setStoredServerUrl,
} from '../lib/apiBase';
import { invalidateCache, useCachedJson } from '../lib/fetchCache';
import { tokens, monoInputStyle } from '../lib/theme';

import { AvatarEditor } from '../components/settings/AvatarEditor';
import { ZeroclawEditor } from '../components/settings/AgentEditor';
import { SubagentEditor } from '../components/settings/SubagentEditor';
import {
  Button,
  ErrorBox,
  FieldRow,
  Hint,
  Section,
  SectionLoading,
} from '../components/settings/primitives';
import type { ServerConfig } from '../components/settings/types';

const TOML_HINT_KEY = 'companion.tomlHint.dismissed.v1';

export default function Settings() {
  // Cached read of server config — instant on Settings revisit, the
  // hook auto-revalidates after `invalidateCache` calls fired by
  // editor save handlers.
  const cfgUrl = `${HTTP_BASE}/api/config`;
  const { data: cfg, error: fetchError } = useCachedJson<ServerConfig>(cfgUrl, 60_000);
  const reloadCfg = () => { invalidateCache(cfgUrl); };

  // Companion URL section state
  const [serverInput, setServerInput] = useState<string>(getStoredServerUrl());
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const [tomlHintDismissed, setTomlHintDismissed] = useState<boolean>(
    () => localStorage.getItem(TOML_HINT_KEY) === '1',
  );
  const error = fetchError;

  const handleSaveUrl = () => {
    const trimmed = serverInput.trim();
    setStoredServerUrl(trimmed);
    setSavedHint(trimmed
      ? `Saved. Reload to use ${trimmed}.`
      : 'Cleared. Reload to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };

  const handleClearUrl = () => {
    setStoredServerUrl('');
    setServerInput('');
    setSavedHint('Cleared. Reload to use the default.');
    setTimeout(() => setSavedHint(null), 4000);
  };

  const isUsingDefaultUrl = !getStoredServerUrl();

  return (
    <div
      style={{
        flex: '1 1 0', minHeight: 0, overflow: 'auto',
        contain: 'paint',
        overscrollBehavior: 'contain',
      }}
    >
      <div style={{ padding: '40px 32px', maxWidth: 880, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', color: tokens.text }}>
            Settings
          </h1>
          <p style={{ color: tokens.textMuted, fontSize: 13, margin: '6px 0 0 0', lineHeight: 1.55 }}>
            Changes apply immediately. Voice-engine swaps and a few other
            process-level options take effect on the next app start —
            they'll say so explicitly.
          </p>
        </header>

        {error && <ErrorBox message={error} />}

        <Section title="Main agent">
          {!cfg && !error && <SectionLoading rows={3} />}
          {cfg?.zeroclaw && (
            <ZeroclawEditor current={cfg.zeroclaw} onSaved={reloadCfg} />
          )}
        </Section>

        <Section title="Avatar & voice">
          {!cfg && !error && <SectionLoading rows={3} />}
          {cfg && !cfg.avatar && (
            <Hint tone="warn">
              Avatar is turned off in the config file. Set{' '}
              <code>[avatar] enabled = true</code> in companion.toml to use it.
            </Hint>
          )}
          {cfg?.avatar && (
            <AvatarEditor current={cfg.avatar} onSaved={reloadCfg} />
          )}
        </Section>

        <Section title="Translation & expressions">
          {cfg?.avatar?.subagent && (
            <SubagentEditor
              current={cfg.avatar.subagent}
              onSaved={reloadCfg}
              tomlHintDismissed={tomlHintDismissed}
              onDismissHint={() => {
                setTomlHintDismissed(true);
                localStorage.setItem(TOML_HINT_KEY, '1');
              }}
            />
          )}
        </Section>

        {/* Companion service URL — most users never touch this. It's the
            address the React UI uses to reach its own background service
            (the companion-server sidecar). Distinct from the agent URL
            above; the description spells that out so it doesn't get
            confused with it. */}
        <Section
          title="Companion service"
          description="Where this UI reaches its local background service (the companion-server sidecar). Leave blank for the default — this is not the agent address; set that in Main agent above."
        >
          <FieldRow
            label="Service URL"
            hint={`Now using: ${getServerUrl()}${isUsingDefaultUrl ? ' (default)' : ''}`}
          >
            <input
              type="text"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveUrl()}
              placeholder={`${getDefaultServerUrl()}  (default)`}
              style={monoInputStyle}
            />
            <Button onClick={handleSaveUrl} primary>Save</Button>
            <Button onClick={handleClearUrl} disabled={isUsingDefaultUrl}>Reset</Button>
          </FieldRow>
          {savedHint && (
            <div style={{ marginTop: 8 }}>
              <Hint tone="good">{savedHint}</Hint>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
