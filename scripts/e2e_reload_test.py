"""Reproduce: 'after we restart the app, only agent's messages show'.

Drives the chat panel under headless Chromium:
  1. Clear localStorage so we start fresh.
  2. Send a message, wait for both user + assistant bubbles.
  3. Inspect localStorage — both turns should be there.
  4. RELOAD the page (simulating an app restart — this is what
     Tauri does when our restart_app command fires; WebView2 keeps
     the same localStorage origin).
  5. After reload: count "you ·" headers vs "asuna ·" headers.
     If the user-reported bug holds, we'll see asuna headers but
     no "you ·" header.

Run: python scripts/e2e_reload_test.py
"""

from __future__ import annotations

import io
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

URL = "http://127.0.0.1:9181/avatar"
MSG = "reload-bug-probe"


def inspect_history(page) -> dict:
    """Pull the chat history list off the page DOM + localStorage."""
    raw = page.evaluate("() => localStorage.getItem('companion.chatHistory.v1')")
    parsed = json.loads(raw) if raw else None
    role_counts = {}
    if isinstance(parsed, list):
        for t in parsed:
            role_counts[t.get("role")] = role_counts.get(t.get("role"), 0) + 1
    bubble_count = page.locator(":scope >> text=/^you ·/i").count()
    asuna_count = page.locator(":scope >> text=/^asuna ·/i").count()
    return {
        "ls_role_counts": role_counts,
        "ls_size": len(parsed) if isinstance(parsed, list) else 0,
        "you_headers": bubble_count,
        "asuna_headers": asuna_count,
        "raw_first_300": raw[:300] if raw else None,
    }


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        # NOTE: NOT using add_init_script("localStorage.clear()") because
        # that fires on EVERY navigation including reload — would mask the
        # very bug we're testing. Clear once explicitly after first load.
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("() => localStorage.clear()")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)

        chat = page.locator('input[type="text"]')
        chat.wait_for(state="visible", timeout=10000)
        chat.fill(MSG)
        chat.press("Enter")
        page.get_by_text(MSG, exact=False).first.wait_for(state="visible", timeout=5000)
        # Wait for assistant
        page.locator("text=/^asuna ·/i").first.wait_for(state="visible", timeout=120000)

        before = inspect_history(page)
        print("=== before reload ===")
        print(json.dumps(before, indent=2, ensure_ascii=False))

        # Reload — same context, same origin, localStorage preserved.
        # This is what Tauri's app.restart() effectively does for the
        # WebView2 (the chrome restarts but the origin's storage stays).
        print("\n→ reloading page (simulates app restart)\n")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)
        # Give React a beat to hydrate from localStorage and render.
        page.wait_for_timeout(800)

        after = inspect_history(page)
        print("=== after reload ===")
        print(json.dumps(after, indent=2, ensure_ascii=False))

        # Asserts
        if before["ls_role_counts"].get("user", 0) >= 1:
            print("✓ before reload: user turn in localStorage")
        else:
            fails += 1
            print("✗ before reload: NO user turn in localStorage")

        if after["ls_role_counts"].get("user", 0) >= 1:
            print("✓ after reload:  user turn STILL in localStorage")
        else:
            fails += 1
            print("✗ after reload:  user turn LOST from localStorage")

        if after["you_headers"] >= 1:
            print(f"✓ after reload:  {after['you_headers']} 'you ·' header(s) rendered")
        else:
            fails += 1
            print("✗ after reload:  NO 'you ·' header rendered (the user bug)")

        if after["asuna_headers"] >= 1:
            print(f"✓ after reload:  {after['asuna_headers']} 'asuna ·' header(s) rendered")
        else:
            fails += 1
            print("✗ after reload:  NO 'asuna ·' header rendered")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
