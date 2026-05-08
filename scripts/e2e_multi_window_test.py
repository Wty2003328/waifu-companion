"""Reproduce the localStorage race between Tauri's main + overlay windows.

Simulates Tauri's two-window setup with two Playwright pages in the
same browser context (so they share localStorage like real Tauri
windows do):

  - Page A (main): http://127.0.0.1:9181/avatar
  - Page B (overlay): http://127.0.0.1:9181/avatar?overlay=1

Both subscribe to /ws/avatar via the React app. User types in A;
WS Text frame broadcasts to BOTH; if B's React state is stale,
B may persist [..., assistant] without the user turn and clobber
A's storage.

After the fix (IS_OVERLAY = !!searchParam('overlay')) the overlay
should not write to localStorage at all, so this race can't happen.

Run: python scripts/e2e_multi_window_test.py
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
MSG = "multi-window-race-probe"


def role_counts(page) -> dict:
    raw = page.evaluate("() => localStorage.getItem('companion.chatHistory.v1')")
    parsed = json.loads(raw) if raw else None
    counts: dict[str, int] = {}
    if isinstance(parsed, list):
        for t in parsed:
            r = t.get("role")
            counts[r] = counts.get(r, 0) + 1
    return counts


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()  # one context = shared localStorage

        # Wipe localStorage by visiting any page and clearing once.
        boot = ctx.new_page()
        boot.goto(MAIN, wait_until="domcontentloaded", timeout=30000)
        boot.evaluate("() => localStorage.clear()")
        boot.close()

        # ── Open both windows in the same context ───────────────────
        page_main = ctx.new_page()
        page_overlay = ctx.new_page()
        page_main.goto(MAIN, wait_until="domcontentloaded", timeout=30000)
        page_overlay.goto(OVERLAY, wait_until="domcontentloaded", timeout=30000)
        page_main.wait_for_load_state("networkidle", timeout=15000)
        page_overlay.wait_for_load_state("networkidle", timeout=15000)

        # ── Send a message from the main window only ────────────────
        chat = page_main.locator('input[type="text"]')
        chat.wait_for(state="visible", timeout=10000)
        chat.fill(MSG)
        chat.press("Enter")
        page_main.get_by_text(MSG, exact=False).first.wait_for(
            state="visible", timeout=5000
        )
        # Wait for the assistant header in the main window
        page_main.locator("text=/^asuna ·/i").first.wait_for(
            state="visible", timeout=120000
        )
        # Give the overlay a moment to also receive the WS broadcast.
        page_main.wait_for_timeout(2000)

        # ── Inspect localStorage from both pages ────────────────────
        main_counts = role_counts(page_main)
        overlay_counts = role_counts(page_overlay)
        print(f"main page storage role counts: {main_counts}")
        print(f"overlay page storage role counts: {overlay_counts}")
        # Same context → both pages see the same localStorage. The
        # interesting question is: does the persisted value contain
        # both user + assistant, or did the overlay overwrite with just
        # [assistant]?
        if main_counts.get("user", 0) >= 1 and main_counts.get("assistant", 0) >= 1:
            print("✓ user+assistant turns survived multi-window WS fan-out")
        else:
            fails += 1
            print("✗ user turn lost — overlay window clobbered storage")

        # The overlay window must NOT render the chat panel.
        try:
            page_overlay.locator("text=/Chat history/").wait_for(
                state="visible", timeout=2000
            )
            fails += 1
            print("✗ overlay window rendered the chat panel (should be hidden)")
        except Exception:
            print("✓ overlay window did NOT render chat panel")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
