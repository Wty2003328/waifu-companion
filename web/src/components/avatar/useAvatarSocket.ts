import { useEffect, useRef, useState, useCallback } from 'react';

export interface LipSyncDataProto {
  frames: { t: number; o: number; s: number }[];
  frame_duration_ms: number;
}

export interface AvatarNotification {
  type: string;
  // Connected
  session_id?: string;
  // ModelInfo
  model_url?: string;
  scale?: number;
  anchor?: string;
  default_expression?: string;
  // Expression
  name?: string;
  intensity?: number;
  duration_ms?: number | null;
  // Motion
  group?: string;
  // Audio
  audio?: string;
  format?: string;
  sample_rate?: number;
  lip_sync?: LipSyncDataProto;
  // Text
  content?: string;
  // Error
  message?: string;
}

export type AvatarMessage =
  | { type: 'Ready' }
  | { type: 'Touch'; hit_area: string; x: number; y: number }
  | { type: 'MotionRequest'; group: string; name: string }
  | { type: 'ExpressionRequest'; name: string };

interface UseAvatarSocketOptions {
  onModelInfo?: (info: {
    modelUrl: string;
    scale: number;
    anchor: string;
    defaultExpression: string;
  }) => void;
  onExpression?: (name: string, intensity: number, durationMs: number | null) => void;
  onMotion?: (group: string, name: string) => void;
  onAudio?: (
    audioBase64: string,
    format: string,
    sampleRate: number,
    lipSync: LipSyncDataProto
  ) => void;
  onText?: (content: string) => void;
  onIdle?: () => void;
  onError?: (message: string) => void;
}

export function useAvatarSocket(url: string, options: UseAvatarSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 3 seconds
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        try {
          const msg: AvatarNotification = JSON.parse(event.data);

          switch (msg.type) {
            case 'Connected':
              break;
            case 'ModelInfo':
              if (msg.model_url && options.onModelInfo) {
                options.onModelInfo({
                  modelUrl: msg.model_url,
                  scale: msg.scale ?? 0.2,
                  anchor: msg.anchor ?? 'center',
                  defaultExpression: msg.default_expression ?? 'neutral',
                });
              }
              break;
            case 'Expression':
              if (msg.name && options.onExpression) {
                options.onExpression(msg.name, msg.intensity ?? 0.8, msg.duration_ms ?? null);
              }
              break;
            case 'Motion':
              if (msg.group && msg.name && options.onMotion) {
                options.onMotion(msg.group, msg.name);
              }
              break;
            case 'Audio':
              if (msg.audio && msg.lip_sync && options.onAudio) {
                options.onAudio(
                  msg.audio,
                  msg.format ?? 'wav',
                  msg.sample_rate ?? 22050,
                  msg.lip_sync
                );
              }
              break;
            case 'Text':
              if (msg.content && options.onText) {
                options.onText(msg.content);
              }
              break;
            case 'Idle':
              options.onIdle?.();
              break;
            case 'Error':
              if (msg.message && options.onError) {
                options.onError(msg.message);
              }
              break;
          }
        } catch {
          // Ignore parse errors
        }
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url]);

  const sendReady = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'Ready' }));
  }, []);

  const sendTouch = useCallback((hitArea: string, x: number, y: number) => {
    wsRef.current?.send(
      JSON.stringify({ type: 'Touch', hit_area: hitArea, x, y })
    );
  }, []);

  const sendMotionRequest = useCallback((group: string, name: string) => {
    wsRef.current?.send(
      JSON.stringify({ type: 'MotionRequest', group, name })
    );
  }, []);

  const sendExpressionRequest = useCallback((name: string) => {
    wsRef.current?.send(
      JSON.stringify({ type: 'ExpressionRequest', name })
    );
  }, []);

  return {
    connected,
    sendReady,
    sendTouch,
    sendMotionRequest,
    sendExpressionRequest,
  };
}
