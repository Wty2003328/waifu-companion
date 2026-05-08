import { useState, useCallback, useRef, useEffect } from 'react';
import Live2DViewer, { type Live2DViewerHandle, type ModelActions } from '../components/avatar/Live2DViewer';
import AvatarControls from '../components/avatar/AvatarControls';
import { useAvatarSocket, type LipSyncDataProto } from '../components/avatar/useAvatarSocket';

interface ModelInfo {
  modelUrl: string;
  scale: number;
  anchor: string;
  defaultExpression: string;
}

export default function Avatar() {
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [subtitle, setSubtitle] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [lipSyncData, setLipSyncData] = useState<LipSyncDataProto | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [modelActions, setModelActions] = useState<ModelActions>({ expressions: [], motions: [] });
  const [pendingAudio, setPendingAudio] = useState<HTMLAudioElement | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const viewerRef = useRef<Live2DViewerHandle>(null);

  // companion-server WS endpoint. Vite dev proxies /ws → ws://127.0.0.1:9181.
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws/avatar`;

  const { connected, sendReady, sendMotionRequest, sendExpressionRequest } = useAvatarSocket(wsUrl, {
    onModelInfo: (info) => {
      setModelInfo(info);
      sendReady();
    },
    onExpression: (name) => {
      viewerRef.current?.setExpression(name);
    },
    onMotion: (group, _name) => {
      const match = modelActions.motions.find((m) => m.group === group);
      if (match) viewerRef.current?.playMotion(match.group, match.index);
    },
    onAudio: (audioBase64, format, _sampleRate, lipSync) => {
      const mime = format === 'mp3' ? 'mpeg' : format;
      const audioBlob = new Blob(
        [Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))],
        { type: `audio/${mime}` }
      );
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audio.onended = () => {
        setIsPlaying(false);
        setPendingAudio(null);
        URL.revokeObjectURL(audioUrl);
      };
      setIsPlaying(true);
      setLipSyncData(lipSync);
      // Browser autoplay policy: a 10–20s wait for the agent reply may
      // exceed the user-gesture window from the original Send click.
      // Surface the error and stash the element so the user can click a
      // "Play" button to start it manually. Once they click once,
      // subsequent replies in this session play automatically.
      audio.play()
        .then(() => {
          audioUnlockedRef.current = true;
          setAudioError(null);
        })
        .catch((err) => {
          console.error('audio playback blocked:', err);
          setIsPlaying(false);
          setAudioError(err.name === 'NotAllowedError'
            ? 'Browser blocked audio. Click "Play" to enable.'
            : `Audio error: ${err.message}`);
          setPendingAudio(audio);
        });
    },
    onText: (content) => setSubtitle(content),
    onIdle: () => {
      setSubtitle('');
      setLipSyncData(null);
    },
    onError: (message) => console.error('Avatar error:', message),
  });

  const handleExpression = useCallback((name: string) => {
    sendExpressionRequest(name);
    viewerRef.current?.setExpression(name);
  }, [sendExpressionRequest]);

  const handleMotion = useCallback((group: string, index: number) => {
    sendMotionRequest(group, String(index));
    viewerRef.current?.playMotion(group, index);
  }, [sendMotionRequest]);

  // Send a user message to upstream zeroclaw via the companion-server proxy.
  // The reply lands back via the WS in 10–20s.
  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || sending) return;

    // Browser autoplay policy: this Send click is a user gesture that
    // unlocks audio. Play a 1-frame silent buffer right now so the
    // browser registers an active audio context. When the real audio
    // arrives 10–20s later it can autoplay because audio is unlocked.
    if (!audioUnlockedRef.current) {
      const silent = new Audio(
        // 1-frame silent WAV, base64-encoded.
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
      );
      silent
        .play()
        .then(() => {
          audioUnlockedRef.current = true;
        })
        .catch(() => {
          // Will fall back to manual click-to-play in onAudio handler.
        });
    }

    setSending(true);
    setChatInput('');
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!resp.ok) {
        console.error('Chat send failed:', resp.status, await resp.text());
      }
    } catch (e) {
      console.error('Chat send error:', e);
    } finally {
      setSending(false);
    }
  }, [chatInput, sending]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16, gap: 16 }}>
      <div
        style={{
          flex: 1,
          position: 'relative',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#0a0a0a',
        }}
      >
        {modelInfo ? (
          <Live2DViewer
            ref={viewerRef}
            modelUrl={modelInfo.modelUrl}
            scale={modelInfo.scale}
            anchor={modelInfo.anchor}
            defaultExpression={modelInfo.defaultExpression}
            lipSyncData={lipSyncData}
            isPlaying={isPlaying}
            onActionsReady={setModelActions}
          />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#888',
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>{connected ? '🎭' : '🔌'}</div>
              <div>{connected ? 'Waiting for model info…' : 'Connecting to avatar…'}</div>
            </div>
          </div>
        )}
        {pendingAudio && (
          <div
            style={{
              position: 'absolute',
              top: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#3b82f6',
              color: '#fff',
              padding: '10px 18px',
              borderRadius: 10,
              fontSize: 14,
              cursor: 'pointer',
              fontWeight: 600,
              boxShadow: '0 4px 12px rgba(59,130,246,0.4)',
            }}
            onClick={() => {
              pendingAudio
                .play()
                .then(() => {
                  audioUnlockedRef.current = true;
                  setIsPlaying(true);
                  setAudioError(null);
                  setPendingAudio(null);
                })
                .catch((e) => {
                  setAudioError(`Still blocked: ${e.message}`);
                });
            }}
          >
            ▶  {audioError ?? 'Click to play audio'}
          </div>
        )}
        {subtitle && (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              maxWidth: '80%',
              background: 'rgba(0, 0, 0, 0.7)',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: 10,
              fontSize: 14,
              backdropFilter: 'blur(4px)',
            }}
          >
            {subtitle}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div
          style={{
            background: '#16181c',
            borderRadius: 10,
            padding: 12,
            width: 240,
            flexShrink: 0,
          }}
        >
          <AvatarControls
            expressions={modelActions.expressions}
            motions={modelActions.motions}
            onExpressionRequest={handleExpression}
            onMotionRequest={handleMotion}
          />
        </div>
        <div style={{ flex: 1, background: '#16181c', borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
              placeholder="Type a message — the avatar will speak the reply"
              style={{
                flex: 1,
                background: '#0b0d10',
                color: '#fff',
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid #2a2d33',
                fontSize: 14,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={handleSendChat}
              disabled={!chatInput.trim() || sending}
              style={{
                padding: '10px 18px',
                background: chatInput.trim() && !sending ? '#3b82f6' : '#1f2937',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                cursor: chatInput.trim() && !sending ? 'pointer' : 'not-allowed',
              }}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: '#666',
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: connected ? '#10b981' : '#ef4444',
              }}
            />
            <span>{connected ? 'Connected to companion' : 'Disconnected'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
