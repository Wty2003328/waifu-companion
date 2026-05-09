"""Verify the desktop pet's drag-region attributes are applied so
the user can pick up the window from anywhere on the avatar.

User report: "why the pet window is not repositionable?"

Root cause: pixi-live2d-display renders the model into an inner
<canvas> that swallows mousedown before Tauri's drag-region handler
sees it. Fix: also tag the Live2D wrapper div + canvas itself with
`data-tauri-drag-region=""`.

This test asserts:
  - The outer canvas wrapper has data-tauri-drag-region="" in
    overlay mode (was already there).
  - The inner Live2D wrapper div has data-tauri-drag-region="" too.
  - The actual <canvas> element (where mousedown happens) carries
    the attribute.
  - The chat bar form has data-tauri-drag-region="false" so it
    does NOT drag the window.
  - The corner button row has data-tauri-drag-region="false".

We can't test the actual drag behavior in headless Chromium because
Tauri intercepts the attribute at the OS level, not via JS. But the
attribute being PRESENT on the right elements is a necessary
precondition — without it, no amount of Tauri config can make the
window draggable.

Run: python scripts/e2e_overlay_drag_test.py
"""

from __future__ import annotations

import io
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

OVERLAY = "http://127.0.0.1:9181/avatar?overlay=1"
MAIN = "http://127.0.0.1:9181/avatar"


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 400, "height": 540})
        page = ctx.new_page()
        page.goto(OVERLAY, wait_until="networkidle", timeout=30000)
        # Allow Live2D model to load (canvas attaches after async fetch).
        page.wait_for_timeout(2000)

        info = page.evaluate(
            """() => {
                const sel = (q) => document.querySelector(q);
                const all = (q) => Array.from(document.querySelectorAll(q));
                return {
                    canvasCount: all('canvas').length,
                    canvasDragAttrs: all('canvas').map(c => c.getAttribute('data-tauri-drag-region')),
                    // The Live2D wrapper div is the immediate parent of the canvas.
                    liveWrapDragAttr: sel('canvas')?.parentElement?.getAttribute('data-tauri-drag-region'),
                    // Corner button row (we tagged with "false" to opt out).
                    cornerRow: sel('button[title=\"Canvas settings\"]')
                        ?.parentElement?.getAttribute('data-tauri-drag-region'),
                    // Chat bar form.
                    formAttr: sel('form')?.getAttribute('data-tauri-drag-region'),
                    // Subtitle (only visible when present; opt-out on render).
                    subtitleAttr: (() => {
                        for (const el of all('div')) {
                            if (el.style.position === 'absolute' && el.style.bottom &&
                                getComputedStyle(el).backdropFilter !== 'none') {
                                return el.getAttribute('data-tauri-drag-region');
                            }
                        }
                        return null;
                    })(),
                };
            }"""
        )
        print("attrs:", info)

        # The Live2D wrapper must carry the drag attribute.
        if info["liveWrapDragAttr"] == "":
            print("  ✓ Live2D wrapper div has data-tauri-drag-region=''")
        else:
            fails += 1
            print(f"  ✗ Live2D wrapper missing drag attr (got {info['liveWrapDragAttr']!r})")

        # At least one canvas should carry the drag attribute (the Live2D one).
        if "" in info["canvasDragAttrs"]:
            print(f"  ✓ {info['canvasDragAttrs'].count('')} canvas(es) carry data-tauri-drag-region=''")
        else:
            fails += 1
            print(f"  ✗ no canvas carries drag attr (got {info['canvasDragAttrs']})")

        # Corner button row + chat bar must opt OUT.
        if info["cornerRow"] == "false":
            print("  ✓ corner button row opts out (data-tauri-drag-region='false')")
        else:
            fails += 1
            print(f"  ✗ corner row drag attr was {info['cornerRow']!r}, expected 'false'")

        if info["formAttr"] == "false":
            print("  ✓ chat bar form opts out (data-tauri-drag-region='false')")
        else:
            fails += 1
            print(f"  ✗ chat bar drag attr was {info['formAttr']!r}, expected 'false'")

        # ── Main window MUST NOT add drag-region (it has its own
        # window chrome / titlebar; making the canvas a drag region
        # would steal clicks from the model and confuse hit-test).
        page.goto(MAIN, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1500)
        main_info = page.evaluate(
            """() => {
                return Array.from(document.querySelectorAll('canvas'))
                    .map(c => c.getAttribute('data-tauri-drag-region'));
            }"""
        )
        if all(a is None for a in main_info):
            print("  ✓ main window canvas has NO drag-region (correct)")
        else:
            fails += 1
            print(f"  ✗ main window canvas has drag-region: {main_info}")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
