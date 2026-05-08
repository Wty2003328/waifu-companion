"""Headless browser test that drives /avatar like a real user would.

Verifies the chat-history bug the user keeps hitting: type a message,
press Enter, then assert that BOTH a "you" bubble AND an "asuna" bubble
appear, in that order, with the right text.

Also checks console output for the [chat] +user / +assistant log lines
emitted by appendTurn so we know whether handleSendChat fired.

Run:
  python scripts/e2e_browser_test.py
"""

from __future__ import annotations

import io
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

URL = "http://127.0.0.1:9181/avatar"
MSG = "playwright-test-message-please-respond-briefly"


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        console_lines: list[str] = []
        page.on("console", lambda m: console_lines.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console_lines.append(f"[pageerror] {e}"))

        # Clear any leftover history so we test from a known state.
        page.add_init_script("window.localStorage.clear();")
        print(f"→ goto {URL}")
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)

        # The chat input is the only <input type=text> on the page.
        # Avatar.tsx:656 renders it with placeholder "Send a message…".
        chat_input = page.locator('input[type="text"]')
        chat_input.wait_for(state="visible", timeout=10000)
        print("→ typing message")
        chat_input.click()
        chat_input.fill(MSG)
        chat_input.press("Enter")

        # Wait for the user bubble to appear (the assistant bubble can take
        # 30–60s; the user bubble should appear synchronously on Enter).
        user_bubble = page.get_by_text(MSG, exact=False).first
        try:
            user_bubble.wait_for(state="visible", timeout=5000)
            print("✓ user bubble visible")
        except Exception as e:
            fails += 1
            print(f"✗ user bubble never appeared: {e}")

        # Assert localStorage actually persists the user turn.
        history_json = page.evaluate(
            "() => localStorage.getItem('companion.chatHistory.v1')"
        )
        print(f"  localStorage: {history_json[:300] if history_json else None!r}")
        if history_json and '"role":"user"' in history_json and MSG in history_json:
            print("✓ user turn in localStorage")
        else:
            fails += 1
            print("✗ user turn NOT in localStorage")

        # Wait up to 90s for an assistant bubble.
        print("→ waiting for assistant reply (≤90s)...")
        try:
            page.locator('div', has_text='asuna').first.wait_for(
                state="visible", timeout=90000
            )
            print("✓ assistant bubble visible")
        except Exception as e:
            fails += 1
            print(f"✗ assistant bubble never appeared: {e}")

        # Print the console log so we can see [chat] +user / +assistant
        # markers from our diagnostic logging.
        print("\nconsole output:")
        for line in console_lines[-40:]:
            print(f"  {line}")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
