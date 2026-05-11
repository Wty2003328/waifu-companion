import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as PIXI from 'pixi.js';
// `@pixi/unsafe-eval` replaces PIXI's eval-based shader compiler with one
// that doesn't need `unsafe-eval` in the CSP. Required for Tauri 2 / browser
// extensions / any strict-CSP environment. Must run BEFORE the first PIXI
// Application is constructed.
import { install as installUnsafeEvalShim } from '@pixi/unsafe-eval';
import type { LipSyncDataProto } from './useAvatarSocket';

installUnsafeEvalShim(PIXI);

// Required by pixi-live2d-display
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).PIXI = PIXI;

// Auto-pick Cubism 2 vs Cubism 4 by sniffing the model manifest.
// Cubism 4 files end in `.model3.json` and reference a `.moc3` mesh.
// Cubism 2 files are usually `model.json` / `*model*.json` referencing a `.moc`.
// `pixi-live2d-display` ships separate entry points for each. Return type
// is widened to `any` because the union of the two Live2DModel types loses
// the inherited PIXI.Container properties (width/height/scale/x/y) we use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadModel(modelUrl: string): Promise<any> {
  const isCubism4 = modelUrl.toLowerCase().endsWith('.model3.json');
  if (isCubism4) {
    const mod = await import('pixi-live2d-display/cubism4');
    return mod.Live2DModel.from(modelUrl, { autoInteract: false });
  } else {
    const mod = await import('pixi-live2d-display/cubism2');
    return mod.Live2DModel.from(modelUrl, { autoInteract: false });
  }
}

export interface Live2DViewerHandle {
  setExpression: (name: string) => void;
  playMotion: (group: string, index: number) => void;
  /** Read every parameter the loaded model exposes. Returns [] if
   *  the model isn't ready yet or doesn't expose its core model. */
  getParameters: () => ModelParameter[];
}

export interface ModelActions {
  expressions: { name: string }[];
  motions: { group: string; index: number }[];
}

/**
 * Information about a single Live2D parameter — what the model
 * exposes, plus the live current value at the moment of read.
 * Both Cubism 2 (`PARAM_ANGLE_X`) and Cubism 4 (`ParamAngleX`)
 * formats are flattened to this shape.
 */
export interface ModelParameter {
  id: string;
  current: number;
  min: number;
  max: number;
  default: number;
}

/**
 * Standard Cubism 2 parameter IDs. The Cubism 2 webgl runtime is
 * minified (no public getParamCount / getParamId) so we can't
 * enumerate dynamically. Probing this well-known list against
 * core.getParamFloat() filters down to the params the loaded model
 * actually has. Min/max/default come from Cubism 2's documented
 * conventions.
 */
const CUBISM2_KNOWN_PARAMS: { id: string; min: number; max: number; default: number }[] = [
  // Head pose
  { id: 'PARAM_ANGLE_X', min: -30, max: 30, default: 0 },
  { id: 'PARAM_ANGLE_Y', min: -30, max: 30, default: 0 },
  { id: 'PARAM_ANGLE_Z', min: -30, max: 30, default: 0 },
  // Body
  { id: 'PARAM_BODY_ANGLE_X', min: -10, max: 10, default: 0 },
  { id: 'PARAM_BODY_ANGLE_Y', min: -10, max: 10, default: 0 },
  { id: 'PARAM_BODY_ANGLE_Z', min: -10, max: 10, default: 0 },
  { id: 'PARAM_BREATH', min: 0, max: 1, default: 0 },
  // Eyes
  { id: 'PARAM_EYE_L_OPEN', min: 0, max: 1, default: 1 },
  { id: 'PARAM_EYE_R_OPEN', min: 0, max: 1, default: 1 },
  { id: 'PARAM_EYE_BALL_X', min: -1, max: 1, default: 0 },
  { id: 'PARAM_EYE_BALL_Y', min: -1, max: 1, default: 0 },
  { id: 'PARAM_EYE_BALL_FORM', min: -1, max: 1, default: 0 },
  { id: 'PARAM_EYE_L_SMILE', min: 0, max: 1, default: 0 },
  { id: 'PARAM_EYE_R_SMILE', min: 0, max: 1, default: 0 },
  // Brows
  { id: 'PARAM_BROW_L_Y', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_R_Y', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_L_X', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_R_X', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_L_ANGLE', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_R_ANGLE', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_L_FORM', min: -1, max: 1, default: 0 },
  { id: 'PARAM_BROW_R_FORM', min: -1, max: 1, default: 0 },
  // Mouth
  { id: 'PARAM_MOUTH_OPEN_Y', min: 0, max: 1, default: 0 },
  { id: 'PARAM_MOUTH_FORM', min: -1, max: 1, default: 0 },
  // Cheek
  { id: 'PARAM_CHEEK', min: 0, max: 1, default: 0 },
  // Hair / accessories
  { id: 'PARAM_HAIR_FRONT', min: 0, max: 1, default: 0 },
  { id: 'PARAM_HAIR_SIDE', min: 0, max: 1, default: 0 },
  { id: 'PARAM_HAIR_BACK', min: 0, max: 1, default: 0 },
];

interface Live2DViewerProps {
  modelUrl: string;
  scale: number;
  anchor: string;
  defaultExpression: string;
  lipSyncData?: LipSyncDataProto | null;
  isPlaying: boolean;
  onActionsReady?: (actions: ModelActions) => void;
  /**
   * User-adjustable transform overrides applied on top of the auto-fit.
   * scaleMultiplier=1 means "use auto-fit"; >1 zooms in, <1 zooms out.
   * offsetX/Y are pixels relative to the auto-fit center.
   */
  scaleMultiplier?: number;
  offsetX?: number;
  offsetY?: number;
  /** Rotation in degrees, around the model's visual center. */
  rotation?: number;
  /** Mirror the model horizontally (negate X scale). */
  mirrorX?: boolean;
  /**
   * When true, the avatar autoplays a random motion from the "Idle"
   * group (or any group containing "idle") at `idleMotionIntervalMs`.
   * Stops while a turn is speaking (isPlaying = true).
   */
  idleMotion?: boolean;
  idleMotionIntervalMs?: number;
  /**
   * When true, the model's gaze follows the mouse cursor over the
   * canvas via Live2DModel.focus(). pixi-live2d-display normalizes
   * the focus to (-1..1, -1..1) so we just hand it window-relative
   * coords clamped to the canvas rect.
   */
  eyeTracking?: boolean;
  /** Available motions, used by idle auto-play. */
  motionsRef?: { current: { group: string; index: number }[] | null };
  /**
   * When true, the Live2D canvas + its wrapper carry
   * `data-tauri-drag-region`, so click-and-drag on the avatar moves
   * the host Tauri window. Without this the inner PIXI canvas captures
   * mousedown and the parent's drag attribute never fires — that's why
   * the desktop pet wasn't repositionable.
   */
  dragRegion?: boolean;
  /**
   * When true, click-and-drag on the avatar in MAIN window mode
   * translates the model (parent updates prefs.offsetX/offsetY via
   * onTranslate). Suppressed in overlay mode because the click should
   * drag the WINDOW there instead. Quick taps that don't exceed
   * `dragThreshold` pixels are interpreted as clicks (hit-area motion).
   */
  dragToTranslate?: boolean;
  /**
   * Called with cumulative dx/dy in CSS pixels during a translate
   * drag. Caller is expected to apply the delta to its own offsetX/Y
   * state and pass the new offsetX/offsetY back as props on next render.
   */
  onTranslate?: (dx: number, dy: number) => void;
  /**
   * Per-parameter overrides keyed by parameter id (e.g.
   * "PARAM_ANGLE_X" / "ParamAngleX"). Continuously re-applied so
   * Live2D's motion system can't fight back. Pass an empty object
   * (the default) to leave the model's internal animation
   * unsuppressed.
   */
  parameterOverrides?: Record<string, number>;
}

const Live2DViewer = forwardRef<Live2DViewerHandle, Live2DViewerProps>(({
  modelUrl,
  defaultExpression,
  lipSyncData,
  isPlaying,
  onActionsReady,
  scaleMultiplier = 1,
  offsetX = 0,
  offsetY = 0,
  rotation = 0,
  mirrorX = false,
  idleMotion = false,
  idleMotionIntervalMs = 12000,
  eyeTracking = false,
  motionsRef,
  dragRegion = false,
  dragToTranslate = false,
  onTranslate,
  parameterOverrides,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelRef = useRef<any>(null);
  // True while a drag-to-translate gesture is in flight. Read by the
  // transform-applier effect so it doesn't snap the model back during
  // the drag.
  const draggingRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    setExpression: (name: string) => {
      const model = modelRef.current;
      if (!model) return;
      try {
        model.expression(name);
      } catch (e) {
        console.warn('[Live2DViewer] Expression failed:', e);
      }
    },
    playMotion: (group: string, index: number) => {
      const model = modelRef.current;
      if (!model) return;
      try {
        model.motion(group, index);
      } catch (e) {
        console.warn('[Live2DViewer] Motion failed:', e);
      }
    },
    getParameters: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = modelRef.current as any;
      if (!model) return [];
      try {
        const core = model.internalModel?.coreModel;
        if (!core) return [];
        // Cubism 4 layout — params accessible directly as arrays.
        const c4 = core.parameters;
        if (c4 && Array.isArray(c4.ids) && Array.isArray(c4.values)) {
          return c4.ids.map((id: string, i: number) => ({
            id,
            current: c4.values[i] ?? 0,
            min: c4.minimumValues?.[i] ?? c4.minimum?.[i] ?? -1,
            max: c4.maximumValues?.[i] ?? c4.maximum?.[i] ?? 1,
            default: c4.defaultValues?.[i] ?? c4.defaults?.[i] ?? 0,
          })) as ModelParameter[];
        }
        // Cubism 2: the runtime is minified (Live2DModelWebGL exposes
        // `_$MT`, `_$5S`, etc., but not getParamCount/getParamId in
        // un-mangled form). Probe the well-known list of standard
        // Cubism 2 parameter IDs — anything the model returns a value
        // for is something the user can drive.
        if (typeof core.getParamFloat === 'function') {
          const known = CUBISM2_KNOWN_PARAMS;
          const out: ModelParameter[] = [];
          for (const def of known) {
            try {
              const cur = core.getParamFloat(def.id);
              if (typeof cur === 'number' && !Number.isNaN(cur)) {
                out.push({ id: def.id, current: cur, min: def.min, max: def.max, default: def.default });
              }
            } catch { /* not present on this model */ }
          }
          return out;
        }
      } catch (e) {
        console.warn('[Live2DViewer] getParameters failed:', e);
      }
      return [];
    },
  }));

  // Keep a ref to the latest overrides so the high-frequency
  // re-apply loop reads them without re-subscribing every render.
  const overridesRef = useRef<Record<string, number> | undefined>(parameterOverrides);
  useEffect(() => { overridesRef.current = parameterOverrides; }, [parameterOverrides]);

  // Initialize PIXI application
  useEffect(() => {
    if (!canvasRef.current) return;

    try {
      // Render quality: match the user's hi-DPI display, anti-alias
      // edges, and prefer the discrete GPU. The default PIXI config
      // renders at devicePixelRatio=1 which makes Live2D models look
      // muddy on retina/4K screens compared to native viewers like
      // Live2DViewerEX.
      const app = new PIXI.Application({
        view: canvasRef.current,
        backgroundAlpha: 0,
        autoStart: true,
        resizeTo: canvasRef.current.parentElement ?? undefined,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      // Silence pixi-live2d-display@0.4.0's "isInteractive is not a
      // function" pointer-event spam: that library targets an older
      // PIXI v7 event API. We never need PIXI to do hit-testing on
      // the model (interaction lives in our React UI), so just turn
      // the event system off entirely.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stage = app.stage as any;
      stage.interactive = false;
      stage.interactiveChildren = false;
      stage.eventMode = 'none';
      appRef.current = app;
    } catch (e) {
      setError(`PIXI init failed: ${e}`);
    }

    return () => {
      appRef.current?.destroy(true, { children: true });
      appRef.current = null;
    };
  }, []);

  // Load Live2D model
  useEffect(() => {
    if (!appRef.current || !modelUrl) return;

    let cancelled = false;
    setError(null);

    (async () => {
      try {
        const model = await loadModel(modelUrl);
        if (cancelled || !appRef.current) return;

        // Stash the auto-fit transform so user-adjustable scale/offset
        // can be re-applied without reloading the model. The second
        // useEffect below reads `model.userData.autoFit` to recompute
        // the live transform.
        const fitModel = () => {
          const appW = appRef.current!.screen.width;
          const appH = appRef.current!.screen.height;
          const scaleX = appW / model.width;
          const scaleY = appH / model.height;
          const fitScale = Math.min(scaleX, scaleY) * 0.9;
          model.userData = model.userData || {};
          model.userData.autoFit = { fitScale, appW, appH };
        };
        fitModel();

        // Disable interaction on the model and all its children so
        // PIXI's event system doesn't walk into Live2D nodes that
        // don't implement the v7+ interactive API (causes the
        // "t.isInteractive is not a function" console spam).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = model as any;
        m.interactive = false;
        m.interactiveChildren = false;
        m.eventMode = 'none';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (appRef.current.stage as any).addChild(model);
        modelRef.current = model;
        // Expose the live model on window for diagnostics + e2e tests.
        // Safe debug global; doesn't affect production behavior.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__live2dModel = model;
        setLoaded(true);

        // Discover available expressions and motions from the model
        const actions: ModelActions = { expressions: [], motions: [] };
        try {
          const settings = model.internalModel?.settings as any;
          // Expressions
          if (settings?.expressions) {
            for (const expr of settings.expressions) {
              actions.expressions.push({ name: expr.name || expr.Name || String(expr.file) });
            }
          }
          // Motions
          if (settings?.motions) {
            for (const [group, motionList] of Object.entries(settings.motions)) {
              if (Array.isArray(motionList)) {
                for (let i = 0; i < motionList.length; i++) {
                  actions.motions.push({ group, index: i });
                }
              }
            }
          }
        } catch (e) {
          console.warn('[Live2DViewer] Could not read model actions:', e);
        }
        onActionsReady?.(actions);

        // Apply default expression
        if (defaultExpression) {
          try { model.expression(defaultExpression); } catch {}
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to load model: ${err}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (modelRef.current && appRef.current) {
        appRef.current.stage.removeChild(modelRef.current);
        modelRef.current = null;
      }
      setLoaded(false);
    };
  }, [modelUrl]);

  // Apply user-adjustable transform whenever it changes. We also
  // re-apply on resize via a short ticker so the model stays centered
  // when the canvas grows/shrinks.
  //
  // Pivot trick: we set `model.pivot` to the model's UNSCALED visual
  // center so rotation pivots around that point on screen. Position
  // is then the screen-space anchor for that pivot. This works for
  // both Cubism 2 (`internalModel`) and Cubism 4 models — `model.width`
  // / `model.scale.x` recovers the unscaled width regardless of edition.
  useEffect(() => {
    const applyTransform = () => {
      // While the user is dragging the model, position is driven
      // imperatively by the drag handler below — re-applying the
      // prop-derived transform here would fight it (snap-back jitter).
      // The handler keeps `model.x/y` exactly where the eventual
      // committed offset will land, so skipping is safe; the next
      // run after `onUp` (when the new offset prop arrives) is a
      // visual no-op.
      if (draggingRef.current) return;
      const model = modelRef.current;
      const app = appRef.current;
      if (!model || !app) return;
      const fit = model.userData?.autoFit;
      if (!fit) return;
      // Recompute fit if app size changed (window resize, panel toggle).
      if (fit.appW !== app.screen.width || fit.appH !== app.screen.height) {
        const scaleX = app.screen.width / model.width;
        const scaleY = app.screen.height / model.height;
        fit.fitScale = Math.min(scaleX, scaleY) * 0.9;
        fit.appW = app.screen.width;
        fit.appH = app.screen.height;
      }
      const finalScale = fit.fitScale * scaleMultiplier;
      // Mirror by negating X scale; absolute scale stays the same.
      model.scale.x = mirrorX ? -finalScale : finalScale;
      model.scale.y = finalScale;
      // Recover unscaled dimensions so pivot lands at the geometric
      // center regardless of mirror/scale state.
      const unscaledW = model.width / Math.abs(model.scale.x);
      const unscaledH = model.height / Math.abs(model.scale.y);
      model.pivot.set(unscaledW / 2, unscaledH / 2);
      // Place the pivot at canvas center + offset. Since pivot is at
      // the model's visual center, this also centers the visible model.
      model.x = app.screen.width / 2 + offsetX;
      model.y = app.screen.height / 2 + offsetY;
      model.rotation = (rotation * Math.PI) / 180;
    };
    applyTransform();
    // Cheap re-check loop — handles "model just loaded" and "canvas resized"
    // without setting up a ResizeObserver.
    const id = setInterval(applyTransform, 250);
    return () => clearInterval(id);
  }, [scaleMultiplier, offsetX, offsetY, rotation, mirrorX, loaded]);

  // Idle motion auto-play.
  // When enabled and not currently speaking, picks a random motion
  // from any group whose name contains "idle" (case-insensitive) and
  // plays it every `idleMotionIntervalMs`. Pauses while isPlaying so
  // the speaking-turn motion (if any) isn't interrupted.
  useEffect(() => {
    if (!idleMotion || !loaded) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const model = modelRef.current;
      const motions = motionsRef?.current ?? [];
      if (!model || isPlaying || motions.length === 0) return;
      const idleGroup = motions.filter(
        (m) => m.group.toLowerCase().includes('idle')
      );
      // Fall back to any motion group if none are explicitly "idle".
      const pool = idleGroup.length > 0 ? idleGroup : motions;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) {
        try {
          model.motion(pick.group, pick.index);
        } catch (e) {
          console.warn('[Live2DViewer] idle motion failed:', e);
        }
      }
    };
    // First idle motion fires after one interval (not immediately) so
    // the user sees the avatar's natural pose first.
    const id = setInterval(tick, Math.max(2000, idleMotionIntervalMs));
    return () => { cancelled = true; clearInterval(id); };
  }, [idleMotion, idleMotionIntervalMs, isPlaying, loaded, motionsRef]);

  // Drag-to-translate the model + hit-area click for motions.
  //
  // Both gestures share mousedown, so they're handled in one effect:
  //   - Press + move > DRAG_THRESHOLD px → translate (calls onTranslate
  //     with cumulative delta).
  //   - Press + release without crossing the threshold → hit-area
  //     click (fires `Tap{HitArea}` motion).
  // In pet (overlay) mode we suppress both — clicks should fall
  // through to data-tauri-drag-region so the window moves instead.
  useEffect(() => {
    if (!loaded || dragRegion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const DRAG_THRESHOLD = 5; // px — distance before a press becomes a drag
    let pressing = false;
    let dragging = false;
    let startX = 0, startY = 0;
    let lastX = 0, lastY = 0;
    // Cumulative drag delta in screen pixels. Applied imperatively to
    // the PIXI model on each move (no React round-trip → 60+fps smooth),
    // then committed to the parent's offset state once on release.
    let accumDx = 0, accumDy = 0;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left button only
      pressing = true;
      dragging = false;
      accumDx = accumDy = 0;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
    };
    const onMove = (e: MouseEvent) => {
      if (!pressing) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          dragging = true;
          if (dragToTranslate) {
            canvas.style.cursor = 'grabbing';
            draggingRef.current = true; // pause the transform applier
          }
        } else {
          return;
        }
      }
      if (dragToTranslate) {
        // Move the model directly — no setState, so the drag tracks
        // the pointer at display refresh rate instead of React's
        // render cadence. The cumulative delta is committed on `onUp`.
        const model = modelRef.current;
        if (model) {
          model.x += dx;
          model.y += dy;
        }
        accumDx += dx;
        accumDy += dy;
      }
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      const wasDragging = dragging;
      pressing = false;
      dragging = false;
      canvas.style.cursor = dragToTranslate ? 'grab' : '';
      if (wasDragging) {
        if (dragToTranslate) {
          // Commit the cumulative delta to the parent's offset state
          // once. When the new offsetX/offsetY props arrive, the
          // transform applier repositions to the same place the model
          // already is — a visual no-op — so there's no snap. Clearing
          // draggingRef *after* the commit means the next applier run
          // (triggered by the prop change) sees the post-drag offset.
          if (onTranslate && (accumDx !== 0 || accumDy !== 0)) {
            onTranslate(accumDx, accumDy);
          }
          draggingRef.current = false;
        }
        return; // a drag never counts as a hit-area tap
      }
      // Treat as a tap → hit-area motion.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = modelRef.current as any;
      if (!model) return;
      const rect = canvas.getBoundingClientRect();
      const x = lastX - rect.left;
      const y = lastY - rect.top;
      try {
        const hits: string[] = model.hitTest?.(x, y) ?? [];
        if (hits.length === 0) return;
        const motions = motionsRef?.current ?? [];
        const wanted = `Tap${hits[0]}`.toLowerCase();
        const exact = motions.find((m) => m.group.toLowerCase() === wanted);
        const fallback = motions.find((m) => m.group.toLowerCase().startsWith('tap'));
        const pick = exact ?? fallback;
        if (pick) model.motion(pick.group, pick.index);
      } catch (err) {
        console.warn('[Live2DViewer] hit-area motion failed:', err);
      }
    };
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    if (dragToTranslate) canvas.style.cursor = 'grab';
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.style.cursor = '';
    };
  }, [loaded, dragRegion, dragToTranslate, onTranslate, motionsRef]);

  // Continuously re-apply parameterOverrides so Live2D's motion
  // system doesn't overwrite the user's slider values on every tick.
  // pixi-live2d-display runs at ~60fps; we hook into requestAnimationFrame
  // to land our writes AFTER each motion update (which schedules the
  // values), so the user's value is what actually renders.
  useEffect(() => {
    if (!loaded) return;
    let raf = 0;
    const apply = () => {
      raf = requestAnimationFrame(apply);
      const ov = overridesRef.current;
      if (!ov || Object.keys(ov).length === 0) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = modelRef.current as any;
      if (!model) return;
      try {
        const core = model.internalModel?.coreModel;
        if (!core) return;
        // Cubism 4: write directly into the parameters arrays.
        const c4 = core.parameters;
        if (c4 && Array.isArray(c4.ids) && Array.isArray(c4.values)) {
          for (const [id, value] of Object.entries(ov)) {
            const idx = c4.ids.indexOf(id);
            if (idx >= 0) c4.values[idx] = value;
          }
          return;
        }
        // Cubism 2: setParamFloat is the public API.
        if (typeof core.setParamFloat === 'function') {
          for (const [id, value] of Object.entries(ov)) {
            core.setParamFloat(id, value);
          }
          return;
        }
        // Fallback: write into _model.parameters directly.
        const c2 = core._model?.parameters;
        if (c2 && Array.isArray(c2.ids) && Array.isArray(c2.values)) {
          for (const [id, value] of Object.entries(ov)) {
            const idx = c2.ids.indexOf(id);
            if (idx >= 0) c2.values[idx] = value;
          }
        }
      } catch { /* model is mid-load or destroyed; will retry next frame */ }
    };
    raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [loaded]);

  // Eye tracking — model gaze follows mouse over the canvas.
  // pixi-live2d-display takes window-coordinate mouse positions; the
  // model normalizes internally. This only works when the underlying
  // Cubism core exposes PARAM_ANGLE_X / PARAM_EYE_BALL_X (most do).
  useEffect(() => {
    if (!eyeTracking || !loaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const model = modelRef.current;
      if (!model) return;
      try {
        // pixi-live2d-display 0.4 expects (x, y) in window/page coords.
        model.focus?.(e.clientX, e.clientY);
      } catch { /* old model formats may not expose focus */ }
    };
    const onLeave = () => {
      const model = modelRef.current;
      if (!model) return;
      try { model.focus?.(0, 0); } catch { /* noop */ }
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [eyeTracking, loaded]);

  // Drive lip sync animation
  useEffect(() => {
    if (!modelRef.current || !lipSyncData || !isPlaying) return;
    if (lipSyncData.frames.length === 0) return;

    const frames = lipSyncData.frames;
    const frameDuration = lipSyncData.frame_duration_ms;
    startTimeRef.current = performance.now();

    const animate = () => {
      const elapsed = performance.now() - startTimeRef.current;
      let frameIdx = 0;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i]?.t ?? 0 <= elapsed) {
          frameIdx = i;
        } else {
          break;
        }
      }
      const frame = frames[frameIdx];
      if (frame) {
        try {
          const coreModel = modelRef.current?.internalModel?.coreModel;
          const paramIds = coreModel?._model?.parameters?.ids;
          if (paramIds) {
            for (let i = 0; i < paramIds.length; i++) {
              if (paramIds[i] === 'ParamMouthOpenY') {
                coreModel._model.parameters.values[i] = frame.o;
                break;
              }
            }
          }
        } catch {}
      }
      const lastFrame = frames[frames.length - 1];
      if (lastFrame && elapsed < lastFrame.t + frameDuration * 2) {
        animFrameRef.current = requestAnimationFrame(animate);
      }
    };
    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [lipSyncData, isPlaying]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  // The drag-region attribute on both the wrapper AND the canvas
  // ensures the click-to-drag-window behavior actually fires when the
  // user clicks ON the avatar. Without it on the canvas, PIXI's
  // pointer pipeline swallows mousedown before Tauri's drag handler
  // sees it — that was the "pet window not repositionable" bug.
  const dragAttrs = dragRegion ? { 'data-tauri-drag-region': '' } : {};
  return (
    <div className="relative w-full h-full" {...dragAttrs}>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ imageRendering: 'auto' }}
        {...dragAttrs}
      />
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          <p className="animate-pulse">Loading Live2D model...</p>
        </div>
      )}
    </div>
  );
});

Live2DViewer.displayName = 'Live2DViewer';
export default Live2DViewer;
