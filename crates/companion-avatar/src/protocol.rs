//! WebSocket protocol types for Live2D avatar communication.
//!
//! Route: `GET /ws/avatar`
//!
//! ## Server → Client (`AvatarNotification`)
//!
//! 1. On connect: `Connected` + `ModelInfo`
//! 2. During agent turn: `Expression` → `Audio` (with lip sync) → `Idle`
//!
//! ## Client → Server (`AvatarMessage`)
//!
//! - `Ready` after model loads
//! - `Touch` on click/tap hit areas
//! - `MotionRequest` / `ExpressionRequest` for manual control

use serde::{Deserialize, Serialize};

// ── Server → Client ──────────────────────────────────────────────

/// Messages from server to the Live2D frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AvatarNotification {
    /// Connection acknowledged.
    Connected {
        session_id: String,
    },

    /// Model loading instruction (sent immediately after connect).
    ModelInfo {
        /// URL or relative path to the Live2D model directory.
        model_url: String,
        /// Scale factor for the model.
        scale: f32,
        /// Position anchor (e.g. "center", "bottom-left").
        anchor: String,
        /// Expression to apply on idle.
        default_expression: String,
    },

    /// Expression change command.
    Expression {
        /// Expression name matching a Live2D expression in the model.
        name: String,
        /// Intensity 0.0–1.0.
        intensity: f32,
        /// Duration in ms to hold the expression before returning to idle.
        duration_ms: Option<u32>,
    },

    /// Motion trigger (e.g. wave, nod, shake).
    Motion {
        /// Motion group name (e.g. "Idle", "TapBody").
        group: String,
        /// Motion name within the group.
        name: String,
    },

    /// Audio data with associated lip sync frames.
    Audio {
        /// Base64-encoded audio bytes.
        audio: String,
        /// Audio format ("wav", "mp3", "pcm").
        format: String,
        /// Sample rate in Hz.
        sample_rate: u32,
        /// Lip sync frame data synchronized to audio.
        lip_sync: LipSyncDataProto,
    },

    /// Agent text for optional subtitle display.
    Text {
        content: String,
    },

    /// Idle state — no audio playing, return to neutral pose.
    Idle,

    /// Error notification.
    Error {
        message: String,
    },
}

// ── Client → Server ──────────────────────────────────────────────

/// Messages from the Live2D frontend to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AvatarMessage {
    /// Client has loaded the model and is ready for data.
    Ready,

    /// Touch/hit area event from the Live2D model.
    Touch {
        /// Hit area name (e.g. "head", "body", "arm").
        hit_area: String,
        /// X coordinate relative to model.
        x: f32,
        /// Y coordinate relative to model.
        y: f32,
    },

    /// Request to play a specific motion.
    MotionRequest {
        group: String,
        name: String,
    },

    /// Request to change expression.
    ExpressionRequest {
        name: String,
    },
}

// ── Lip sync data (wire format) ─────────────────────────────────

/// Protocol-friendly lip sync data for transport over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LipSyncDataProto {
    /// Lip sync frames.
    pub frames: Vec<LipSyncFrameProto>,
    /// Duration of each frame in milliseconds.
    pub frame_duration_ms: u32,
}

/// A single lip sync frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LipSyncFrameProto {
    /// Timestamp in milliseconds from audio start.
    pub t: u32,
    /// Mouth open amount 0.0–1.0.
    pub o: f32,
    /// Mouth smile amount -1.0–1.0.
    pub s: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_avatar_notification_connected() {
        let msg = AvatarNotification::Connected {
            session_id: "test-123".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Connected\""));
        assert!(json.contains("\"session_id\":\"test-123\""));
    }

    #[test]
    fn serialize_avatar_notification_audio() {
        let msg = AvatarNotification::Audio {
            audio: "dGVzdA==".to_string(),
            format: "wav".to_string(),
            sample_rate: 22050,
            lip_sync: LipSyncDataProto {
                frames: vec![LipSyncFrameProto {
                    t: 0,
                    o: 0.5,
                    s: 0.0,
                }],
                frame_duration_ms: 30,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"Audio\""));
        assert!(json.contains("\"sample_rate\":22050"));
    }

    #[test]
    fn deserialize_avatar_message_ready() {
        let json = r#"{"type":"Ready"}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, AvatarMessage::Ready));
    }

    #[test]
    fn deserialize_avatar_message_touch() {
        let json = r#"{"type":"Touch","hit_area":"head","x":100.0,"y":200.0}"#;
        let msg: AvatarMessage = serde_json::from_str(json).unwrap();
        match msg {
            AvatarMessage::Touch { hit_area, x, y } => {
                assert_eq!(hit_area, "head");
                assert!((x - 100.0).abs() < f32::EPSILON);
                assert!((y - 200.0).abs() < f32::EPSILON);
            }
            other => panic!("expected Touch, got: {other:?}"),
        }
    }
}
