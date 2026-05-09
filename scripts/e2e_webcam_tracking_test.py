"""Verify webcam motion-tracking toggle.

We can't drive a real camera in headless, but we can:
  - Verify the toggle UI exists in the settings popover.
  - Toggle it on and assert the pref persists.
  - Verify the React code calls getUserMedia (we stub it before
    the page loads and watch for the call).
  - Verify the disabled toggle stops the camera (calls .stop() on
    each track).

Run: python scripts/e2e_webcam_tracking_test.py
"""

from __future__ import annotations

import io
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

URL = "http://127.0.0.1:9181/avatar"
PREFS_KEY = "companion.avatarPrefs.v1"

# Stub getUserMedia so the page can run as if a webcam is present.
# We log every call into window.__webcamCalls so the test can verify
# the React effect actually requested + released the camera.
STUB = """
window.__webcamCalls = [];
window.__webcamStops = 0;
// Plain object impersonating a MediaStream. Most of webcamTracker
// only needs .getTracks() + the videoEl.srcObject assignment to
// not throw. We patch srcObject's setter to accept anything, and
// short-circuit play() to resolve immediately so the await chain
// in startWebcamTracking proceeds far enough to register the
// interval (which we don't actually need to tick — just verify
// that the lifecycle wiring works end-to-end).
const tracks = [{ stop() { window.__webcamStops += 1; } }];
const fakeStream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
    getAudioTracks: () => [],
    addEventListener() {},
    removeEventListener() {},
};
navigator.mediaDevices = navigator.mediaDevices || {};
navigator.mediaDevices.getUserMedia = (c) => {
    window.__webcamCalls.push(c);
    return Promise.resolve(fakeStream);
};
HTMLVideoElement.prototype.play = function () { return Promise.resolve(); };
// Loosen srcObject so assigning a plain object doesn't throw.
Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    set() { /* swallow */ },
    get() { return null; },
});
// Loosen drawImage so the canvas tick doesn't throw on the fake stream.
const origDraw = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function () {
    try { return origDraw.apply(this, arguments); } catch { /* fake stream has no frames */ }
};
"""


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        ctx.add_init_script(STUB)
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle", timeout=30000)
        page.evaluate("() => localStorage.clear()")
        page.reload(wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2500)

        # Open settings; find the webcam toggle.
        page.locator('button[title="Canvas settings"]').first.click()
        page.wait_for_timeout(400)

        try:
            page.get_by_text("Webcam motion tracking", exact=False).first.wait_for(
                state="visible", timeout=2000
            )
            print("  ✓ webcam toggle visible in popover")
        except Exception:
            fails += 1
            print("  ✗ webcam toggle missing")
            browser.close()
            return 2

        # Click the checkbox associated with the label.
        page.locator(
            'label:has-text("Webcam motion tracking") input[type="checkbox"]'
        ).first.click(force=True)
        page.wait_for_timeout(500)

        # Pref should reflect the toggle.
        prefs = json.loads(page.evaluate(f"() => localStorage.getItem('{PREFS_KEY}')"))
        if prefs.get("webcamTracking") is True:
            print("  ✓ pref webcamTracking persisted")
        else:
            fails += 1
            print(f"  ✗ pref didn't flip: {prefs.get('webcamTracking')!r}")

        # Stub should have been called (React effect calls
        # startWebcamTracking → getUserMedia).
        calls = page.evaluate("() => window.__webcamCalls")
        print(f"  getUserMedia called {len(calls)} time(s); first constraints: "
              f"{calls[0] if calls else None}")
        if calls and calls[0].get("video"):
            print("  ✓ effect requested video stream")
        else:
            fails += 1
            print("  ✗ no video request was made")

        # Disable the toggle. Tracks should stop.
        page.locator(
            'label:has-text("Webcam motion tracking") input[type="checkbox"]'
        ).first.click(force=True)
        page.wait_for_timeout(400)
        stops = page.evaluate("() => window.__webcamStops")
        print(f"  track.stop() called {stops} time(s) after disable")
        if stops >= 1:
            print("  ✓ camera released on disable")
        else:
            fails += 1
            print("  ✗ camera was NOT released")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
