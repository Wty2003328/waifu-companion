"""Verify drag-to-translate the model in main window mode.

Behavior under test (Live2DViewer):
  - Press + move > 5px → drag, calls onTranslate with cumulative dx/dy
    which Avatar.tsx applies to prefs.offsetX/offsetY.
  - Press + release without crossing the threshold → tap (hit-area
    motion). Not testable in headless because that requires a fully
    loaded Live2D model with declared hit areas; we only test the
    drag path here.
  - In overlay mode the listeners are suppressed (data-tauri-drag-
    region wins). We assert that.

Test:
  1. Open main /avatar.
  2. Read prefs.offsetX, offsetY before drag.
  3. Synthesize a mousedown on the canvas, then mousemove(+50, +30),
     then mouseup.
  4. Read prefs.offsetX, offsetY after — should have advanced by ~50,
     ~30 (within a few px slop because Live2D's auto-fit recompute
     interval can shift things).
  5. Open overlay /avatar?overlay=1 and confirm drag does NOT mutate
     prefs (those listeners are off).

Run: python scripts/e2e_drag_to_translate_test.py
"""

from __future__ import annotations

import io
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

MAIN = "http://127.0.0.1:9181/avatar"
OVERLAY = "http://127.0.0.1:9181/avatar?overlay=1"
PREFS_KEY = "companion.avatarPrefs.v1"


def get_offsets(page) -> tuple[float, float]:
    raw = page.evaluate(f"() => localStorage.getItem('{PREFS_KEY}')")
    if not raw:
        return 0.0, 0.0
    p = json.loads(raw)
    return p.get("offsetX", 0), p.get("offsetY", 0)


def drag_canvas(page, dx: int, dy: int) -> None:
    """Synthesize a left-button drag of (dx, dy) on the Live2D canvas."""
    page.evaluate(
        """([dx, dy]) => {
            const canvas = document.querySelector('canvas');
            if (!canvas) throw new Error('no canvas');
            const r = canvas.getBoundingClientRect();
            const x0 = r.left + r.width / 2;
            const y0 = r.top + r.height / 2;
            const fire = (type, x, y, target = canvas) => {
                const ev = new MouseEvent(type, {
                    bubbles: true, cancelable: true, button: 0,
                    clientX: x, clientY: y, view: window,
                });
                target.dispatchEvent(ev);
            };
            fire('mousedown', x0, y0);
            // The drag listeners are on `window` for mousemove/up.
            const fireWin = (type, x, y) => {
                const ev = new MouseEvent(type, {
                    bubbles: true, cancelable: true, button: 0,
                    clientX: x, clientY: y, view: window,
                });
                window.dispatchEvent(ev);
            };
            // Cross the 5px threshold first, then deliver the rest in
            // a few small steps to mimic a real cursor.
            const steps = 6;
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                fireWin('mousemove', x0 + dx * t, y0 + dy * t);
            }
            fireWin('mouseup', x0 + dx, y0 + dy);
        }""",
        [dx, dy],
    )


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(MAIN, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("() => localStorage.clear()")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)
        # Wait long enough for Live2DViewer's `loaded` state to flip
        # (we attach drag listeners only after model load).
        page.wait_for_timeout(2500)

        before = get_offsets(page)
        drag_canvas(page, 50, 30)
        # State updates are batched — give React a beat.
        page.wait_for_timeout(200)
        after = get_offsets(page)
        ddx = after[0] - before[0]
        ddy = after[1] - before[1]
        print(f"  before={before}  after={after}  dx={ddx} dy={ddy}")
        # Tolerance: drag math should match exactly because we own
        # both ends, but the auto-fit ticker can mutate offsetX/Y too
        # (it doesn't, but defend against drift). Allow ±3px.
        if abs(ddx - 50) <= 3 and abs(ddy - 30) <= 3:
            print("  ✓ drag-to-translate moved offsets by the drag delta")
        else:
            fails += 1
            print(f"  ✗ expected dx≈50 dy≈30, got dx={ddx} dy={ddy}")

        # ── Overlay should NOT respond to drag (window-drag wins).
        page.goto(OVERLAY, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)
        page.wait_for_timeout(2500)
        ov_before = get_offsets(page)
        drag_canvas(page, 80, 80)
        page.wait_for_timeout(200)
        ov_after = get_offsets(page)
        if ov_before == ov_after:
            print("  ✓ overlay drag does NOT mutate prefs (window-drag path)")
        else:
            fails += 1
            print(f"  ✗ overlay drag changed prefs: {ov_before} → {ov_after}")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
