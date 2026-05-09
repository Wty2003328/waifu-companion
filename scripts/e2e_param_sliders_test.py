"""Verify Live2D parameter sliders.

Behavior under test:
  - After the model loads, Avatar.tsx reads the model's parameter
    list via Live2DViewer's getParameters() ref method.
  - Settings popover renders a "Live2D parameters" section showing
    one slider per parameter.
  - Moving a slider stores the override in localStorage under
    `companion.params.<modelId>.v1`.
  - The Live2DViewer's render-loop continuously re-applies the
    override (we can't observe rendering in headless, so we test the
    storage round-trip + the DOM presence of sliders).

Run: python scripts/e2e_param_sliders_test.py
"""

from __future__ import annotations

import io
import json
import sys

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

URL = "http://127.0.0.1:9181/avatar"


def main() -> int:
    fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle", timeout=30000)
        page.evaluate("() => localStorage.clear()")
        page.reload(wait_until="networkidle", timeout=30000)
        # Live2D model load + the 600ms grace period before
        # availableParams populates.
        page.wait_for_timeout(4500)

        # Open the settings popover.
        page.locator('button[title="Canvas settings"]').first.click()
        page.wait_for_timeout(400)

        # Section header should report a parameter count.
        section_text = page.evaluate("""() => {
            for (const el of document.querySelectorAll('div, span')) {
                if (el.textContent && el.textContent.startsWith('Live2D parameters')) {
                    return el.textContent;
                }
            }
            return null;
        }""")
        print(f"  section header: {section_text!r}")
        if section_text and "(" in section_text:
            count = int(section_text.split("(")[1].split(")")[0])
            print(f"  ✓ parameter count visible in header: {count}")
            if count <= 0:
                fails += 1
                print("  ✗ count is zero — model didn't expose params")
        else:
            fails += 1
            print(f"  ✗ unexpected section header: {section_text!r}")

        # There should be at least one type=range input under the
        # popover (one per parameter).
        ranges = page.evaluate("""() => {
            const popovers = Array.from(document.querySelectorAll('div'))
                .filter(el => el.style.position === 'absolute'
                    && el.style.right === '12px'
                    && el.style.maxHeight);
            if (popovers.length === 0) return -1;
            return popovers[0].querySelectorAll('input[type="range"]').length;
        }""")
        print(f"  range sliders in popover: {ranges}")
        if isinstance(ranges, int) and ranges >= 5:
            print(f"  ✓ {ranges} parameter sliders rendered (≥5)")
        else:
            fails += 1
            print(f"  ✗ expected many sliders, got {ranges}")

        # Pick a PARAM_ slider specifically (the popover also has zoom/
        # x/y/rotation sliders we don't want to confuse with Live2D
        # params). Walk the popover and find the first range input
        # whose row's monospace label starts with PARAM_.
        ok = page.evaluate(
            """() => {
                const popovers = Array.from(document.querySelectorAll('div'))
                    .filter(el => el.style.position === 'absolute'
                        && el.style.right === '12px'
                        && el.style.maxHeight);
                if (popovers.length === 0) return { error: 'no popover' };
                for (const slider of popovers[0].querySelectorAll('input[type=\"range\"]')) {
                    const row = slider.closest('div');
                    const labelSpan = row?.querySelector('span');
                    const id = labelSpan?.textContent?.trim() ?? '';
                    if (!id.startsWith('PARAM_')) continue;
                    const setter = Object.getOwnPropertyDescriptor(
                        HTMLInputElement.prototype, 'value'
                    ).set;
                    // Pick the max value to guarantee a difference from
                    // the model's current value (midpoint may equal it).
                    const newValue = Number(slider.max);
                    setter.call(slider, newValue);
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    return { paramId: id, newValue };
                }
                return { error: 'no PARAM_ slider' };
            }"""
        )
        print(f"  drove a PARAM slider: {ok}")
        page.wait_for_timeout(300)

        # Verify localStorage has the override.
        # Storage key uses 'server-default' as model id when no user
        # selection (we cleared localStorage at the start).
        stored = page.evaluate(
            "() => localStorage.getItem('companion.params.server-default.v1')"
        )
        print(f"  storage: {stored!r}")
        if stored:
            parsed = json.loads(stored)
            if isinstance(parsed, dict) and len(parsed) >= 1:
                print(f"  ✓ slider write persisted to localStorage ({len(parsed)} key(s))")
            else:
                fails += 1
                print(f"  ✗ stored object empty/wrong shape: {parsed}")
        else:
            fails += 1
            print("  ✗ no parameter override saved to localStorage")

        # Click "Reset all" — overrides should clear.
        try:
            page.locator('button:has-text("Reset all")').first.click(timeout=2000)
            page.wait_for_timeout(200)
            after = page.evaluate(
                "() => localStorage.getItem('companion.params.server-default.v1')"
            )
            if after in (None, "", "null"):
                print("  ✓ 'Reset all' cleared overrides")
            else:
                fails += 1
                print(f"  ✗ 'Reset all' didn't clear: {after!r}")
        except Exception as e:
            fails += 1
            print(f"  ✗ couldn't click Reset all: {e}")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
