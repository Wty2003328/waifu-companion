/**
 * Webcam face/motion tracker.
 *
 * v1 implementation: frame-difference motion detection. We grab a
 * downsampled grayscale frame from the webcam every ~100ms, diff it
 * against the previous frame, and compute the centroid of the motion.
 * That centroid is our "face is here" estimate. Crude — a real
 * face-landmark detector (MediaPipe / face-api.js) would be more
 * accurate — but: no ML model download, no CSP changes for CDN
 * fetches, ~70 lines of code. Good enough for "Asuna looks toward
 * me when I move."
 *
 * The caller starts tracking with `start(onFocus)` — we deliver a
 * normalized (x, y) in [-1, 1] each tick. Calling `stop()` releases
 * the camera + clears intervals.
 */

interface Tracker {
  videoEl: HTMLVideoElement;
  canvasEl: HTMLCanvasElement;
  intervalId: ReturnType<typeof setInterval>;
  stream: MediaStream;
}

let active: Tracker | null = null;

export interface FocusPoint { x: number; y: number; /** "we're confident a face moved" */ confidence: number; }

export function isWebcamTracking(): boolean {
  return active !== null;
}

/**
 * Start tracking. Resolves once the webcam stream is live and the
 * tick is scheduled. Rejects if getUserMedia fails (permission
 * denied, no camera, etc.).
 */
export async function startWebcamTracking(
  onFocus: (point: FocusPoint) => void,
  opts: { width?: number; height?: number; intervalMs?: number } = {},
): Promise<void> {
  if (active) return; // already running
  const W = opts.width ?? 64;
  const H = opts.height ?? 48;
  const TICK_MS = opts.intervalMs ?? 100;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: 320, height: 240, facingMode: 'user' },
  });

  const videoEl = document.createElement('video');
  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.style.position = 'fixed';
  videoEl.style.left = '-9999px'; // off-screen; we only need the pixels
  document.body.appendChild(videoEl);
  await videoEl.play();

  const canvasEl = document.createElement('canvas');
  canvasEl.width = W;
  canvasEl.height = H;
  const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context unavailable');

  // Mirror horizontally so user-on-the-right maps to face-on-the-right
  // (otherwise the webcam's natural mirror flips the model's gaze).
  ctx.translate(W, 0);
  ctx.scale(-1, 1);

  let prev: Uint8ClampedArray | null = null;
  const tick = () => {
    if (!active) return;
    try {
      ctx.drawImage(videoEl, 0, 0, W, H);
    } catch {
      return; // video not ready yet
    }
    const img = ctx.getImageData(0, 0, W, H);
    // Convert to grayscale Y values in-place (we only need the
    // luma channel for motion diff). Reuse img.data to keep alloc
    // pressure low.
    const lumas = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      lumas[i] =
        (img.data[o] * 0.299 +
          img.data[o + 1] * 0.587 +
          img.data[o + 2] * 0.114) | 0;
    }

    if (prev) {
      // Diff & accumulate weighted centroid.
      let sumX = 0, sumY = 0, sumW = 0;
      const THRESH = 16; // ignore noise below this delta
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const d = Math.abs(lumas[i] - prev[i]);
          if (d > THRESH) {
            sumX += x * d;
            sumY += y * d;
            sumW += d;
          }
        }
      }
      if (sumW > 200) {
        // Normalize centroid to [-1, 1].
        const cx = sumX / sumW;
        const cy = sumY / sumW;
        const nx = (cx / W) * 2 - 1;
        const ny = (cy / H) * 2 - 1;
        // Confidence is based on total motion — clamp to [0, 1].
        const conf = Math.min(1, sumW / (W * H * 16));
        onFocus({ x: nx, y: ny, confidence: conf });
      }
    }
    prev = lumas;
  };
  const intervalId = setInterval(tick, TICK_MS);

  active = { videoEl, canvasEl, intervalId, stream };
}

export function stopWebcamTracking(): void {
  if (!active) return;
  clearInterval(active.intervalId);
  active.stream.getTracks().forEach((t) => t.stop());
  active.videoEl.remove();
  active = null;
}
