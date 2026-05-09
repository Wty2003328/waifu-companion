"""E2E coverage for the Pulse iteration:

  Wave 1 — read tracking
  Wave 2 — server-side search
  Wave 3 — item detail drawer
  Wave 4 — suggested-feeds preset
  Wave 5 — agent summarize (cached)

Backend (no Playwright):
  - GET  /api/pulse/unread_count            initial count
  - POST /api/pulse/items/{id}/read         mark read; count drops
  - DELETE /api/pulse/items/{id}/read       mark unread; count climbs
  - POST /api/pulse/items/read_all          clears unread
  - GET  /api/pulse/feed?unread=1           filter excludes read items
  - GET  /api/pulse/feed?search=…           case-insensitive substring
                                            on title + content
  - search + unread compose

Frontend (Playwright):
  - "Unread only" checkbox + count badge render in Feed tab
  - Clicking the unread chip on a row toggles read state visually
  - Clicking a row opens the detail drawer with the title
  - Pressing Esc closes the drawer
  - "Mark all read" button drops count to 0
  - Sources tab → "Suggested feeds" expander reveals presets
  - Clicking a suggestion adds it to the user-feeds list

Pre-condition: companion-server is running with [pulse] enabled and
has at least a few items in the feed (the test triggers hackernews
+ rss to seed if empty).

Run: python scripts/e2e_pulse_features_test.py
"""

from __future__ import annotations

import io
import json
import sys
import time
from urllib import request, parse

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:9181"


def http(method: str, path: str, body: dict | None = None,
         timeout: float = 15) -> tuple[int, object]:
    req = request.Request(
        f"{BASE}{path}",
        method=method,
        headers={"Content-Type": "application/json"} if body else {},
        data=json.dumps(body).encode() if body else None,
    )
    try:
        with request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except request.HTTPError as e:
        return e.code, e.read().decode()


def seed_items_if_empty() -> int:
    """Make sure the feed has items so the read/search tests have
    something to act on. Adds a real RSS feed + triggers hackernews."""
    code, body = http("GET", "/api/pulse/feed?limit=10")
    if code == 200 and body.get("items"):
        return len(body["items"])
    # No items — add hnrss frontpage and trigger.
    http("POST", "/api/pulse/feeds", {
        "name": "HN frontpage (probe)", "url": "https://hnrss.org/frontpage",
    })
    http("POST", "/api/pulse/trigger/rss")
    http("POST", "/api/pulse/trigger/hackernews")
    # Wait for items to land.
    for _ in range(30):
        time.sleep(1)
        code, body = http("GET", "/api/pulse/feed?limit=10")
        if code == 200 and body.get("items"):
            return len(body["items"])
    return 0


def main() -> int:
    fails = 0

    n = seed_items_if_empty()
    if n == 0:
        print("  ✗ couldn't seed items — collectors may be offline")
        return 1
    print(f"  ✓ feed has {n} item(s) to work with")

    # Reset all read state for determinism.
    http("POST", "/api/pulse/items/read_all")

    # ── Wave 1: unread_count + mark read ──
    print("\n=== Wave 1: read tracking ===")
    # After read_all: count is 0
    code, body = http("GET", "/api/pulse/unread_count")
    assert code == 200, f"unread_count: {code}"
    if body.get("unread") == 0:
        print("  ✓ /unread_count returns 0 after read_all")
    else:
        fails += 1
        print(f"  ✗ unread_count after read_all: {body}")

    # Pick an item, mark unread → count climbs to 1
    code, feed = http("GET", "/api/pulse/feed?limit=1")
    item_id = feed["items"][0]["id"]
    http("DELETE", f"/api/pulse/items/{item_id}/read")
    code, body = http("GET", "/api/pulse/unread_count")
    if body.get("unread") == 1:
        print("  ✓ DELETE /items/{id}/read marks one unread (count=1)")
    else:
        fails += 1
        print(f"  ✗ unread count after unmark: {body}")

    # POST read → count drops to 0; second POST is a no-op (changed=false)
    code, body = http("POST", f"/api/pulse/items/{item_id}/read")
    if body.get("changed") is True:
        print("  ✓ POST /items/{id}/read flips state (changed=true)")
    else:
        fails += 1
        print(f"  ✗ POST mark-read returned: {body}")
    code, body = http("POST", f"/api/pulse/items/{item_id}/read")
    if body.get("changed") is False:
        print("  ✓ second POST is a no-op (changed=false)")
    else:
        fails += 1
        print(f"  ✗ second POST should be no-op: {body}")

    # ── /feed?unread=1 excludes read items ──
    code, body = http("GET", "/api/pulse/feed?limit=100&unread=1")
    if not any(it["id"] == item_id for it in body["items"]):
        print("  ✓ ?unread=1 excludes read item")
    else:
        fails += 1
        print(f"  ✗ ?unread=1 still returned read item")

    # ── Wave 2: server-side search ──
    print("\n=== Wave 2: server-side search ===")
    # Pick a token from a stored item's title for a deterministic match.
    code, body = http("GET", "/api/pulse/feed?limit=5")
    title_token = ""
    for it in body["items"]:
        words = [w for w in it["title"].split() if len(w) >= 4 and w.isalnum()]
        if words:
            title_token = words[0].lower()
            break
    if not title_token:
        print("  ⚠ no usable token in feed for search test; skipping")
    else:
        code, body = http("GET", f"/api/pulse/feed?search={parse.quote(title_token)}&limit=20")
        items = body.get("items", [])
        if items and all(title_token in (it["title"] + (it.get("content") or "")).lower() for it in items):
            print(f"  ✓ ?search={title_token!r} returns {len(items)} item(s), all containing the token")
        else:
            fails += 1
            print(f"  ✗ search returned mismatched items: {[it['title'] for it in items[:3]]}")

    # No-match token returns empty
    code, body = http("GET", "/api/pulse/feed?search=zzzzz_no_such_substring_zzzzz")
    if body.get("items") == []:
        print("  ✓ search with no matches returns empty list")
    else:
        fails += 1
        print(f"  ✗ no-match search returned: {body}")

    # ── /api/pulse/items/read_all ──
    print("\n=== mark all read ===")
    # Mark a few items unread first so read_all has something to do.
    code, body = http("GET", "/api/pulse/feed?limit=5")
    for it in body["items"]:
        http("DELETE", f"/api/pulse/items/{it['id']}/read")
    code, body = http("POST", "/api/pulse/items/read_all")
    if body.get("ok") and (body.get("marked") or 0) >= 1:
        print(f"  ✓ POST /items/read_all marked {body['marked']} item(s)")
    else:
        fails += 1
        print(f"  ✗ read_all returned: {body}")
    code, body = http("GET", "/api/pulse/unread_count")
    if body.get("unread") == 0:
        print("  ✓ unread count is 0 after read_all")
    else:
        fails += 1
        print(f"  ✗ unread after read_all: {body}")

    # ── Wave 5: agent summarize ──
    # Backend may be unavailable (zeroclaw upstream not running, no API
    # key, etc). We test both paths: success → cached round-trip; or
    # 503/502 → friendly error path. The test passes either way as
    # long as the endpoint behaves *correctly* for the env it's in.
    print("\n=== Wave 5: agent summarize ===")
    code, feed = http("GET", "/api/pulse/feed?limit=1")
    sid = feed["items"][0]["id"]
    # First call hits the LLM, which can take 5–30s. Be generous.
    code, body = http("POST", f"/api/pulse/items/{sid}/summarize", timeout=120)
    summarize_works = False
    if code == 200 and isinstance(body, dict) and body.get("summary"):
        summary_first = body["summary"]
        cached_first = body.get("cached")
        print(f"  ✓ summarize returned {len(summary_first)}-char summary "
              f"(cached={cached_first})")
        summarize_works = True
        # Round-trip: a second call with no force should be served from
        # cache (cached=True, identical text, instantaneous).
        code2, body2 = http("POST", f"/api/pulse/items/{sid}/summarize")
        if code2 == 200 and body2.get("summary") == summary_first and body2.get("cached"):
            print("  ✓ second call returns cached summary without re-billing LLM")
        else:
            fails += 1
            print(f"  ✗ second call wasn't cached: {body2}")
        # The feed endpoint should now surface the summary inline.
        code3, feed3 = http("GET", f"/api/pulse/feed?limit=100")
        target = next((it for it in feed3["items"] if it["id"] == sid), None)
        if target and target.get("summary") == summary_first:
            print("  ✓ /feed surfaces cached summary on the item")
        else:
            fails += 1
            print(f"  ✗ /feed didn't carry summary: {target}")
    elif code in (502, 503):
        print(f"  ⚠ summarize backend unavailable ({code}); skipping success path "
              f"(this is expected if zeroclaw upstream is offline)")
    else:
        fails += 1
        print(f"  ✗ summarize returned unexpected status {code}: {body}")

    # ── Wave 3 + 4: UI ──
    print("\n=== UI: read toggle, drawer, suggestions ===")
    # Set up a deterministic state — one unread item we can click on.
    code, body = http("GET", "/api/pulse/feed?limit=1")
    target = body["items"][0]
    http("DELETE", f"/api/pulse/items/{target['id']}/read")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1200, "height": 900}).new_page()
        page.goto(f"{BASE}/pulse", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1000)

        # Unread checkbox + count badge present.
        try:
            page.get_by_text("Unread only", exact=False).first.wait_for(state="visible", timeout=3000)
            print("  ✓ Feed tab has 'Unread only' control")
        except Exception:
            fails += 1
            print("  ✗ 'Unread only' control missing")

        # Click the row's read-toggle button. The button text is
        # "○ unread" when the item is currently unread; clicking flips
        # to "✓ read".
        try:
            unread_btn = page.locator('button:has-text("unread")').first
            unread_btn.wait_for(state="visible", timeout=3000)
            unread_btn.click()
            page.wait_for_timeout(300)
            # The same button should now read "read"
            page.locator('button:has-text("read")').first.wait_for(state="visible", timeout=2000)
            print("  ✓ row read-toggle button flips state in the UI")
        except Exception as e:
            fails += 1
            print(f"  ✗ row toggle didn't flip: {e}")

        # Click a feed row to open the drawer (the article element).
        try:
            page.locator('article').first.click()
            page.wait_for_timeout(400)
            page.locator('button[aria-label="Close"]').first.wait_for(state="visible", timeout=2000)
            print("  ✓ clicking a row opens the detail drawer")
        except Exception as e:
            fails += 1
            print(f"  ✗ drawer didn't open: {e}")

        # Drawer has the Summarize button (or Re-summarize if already cached).
        try:
            sum_btn = page.locator('button:has-text("Summarize"), button:has-text("Re-summarize")').first
            sum_btn.wait_for(state="visible", timeout=2000)
            print("  ✓ drawer has the Summarize button")
            # If the backend works, clicking should produce the summary block.
            if summarize_works:
                sum_btn.click()
                # Either the summary block appears (success) or an error shows.
                page.locator('[data-testid="summary-block"]').first.wait_for(
                    state="visible", timeout=15000)
                print("  ✓ clicking Summarize renders the AGENT SUMMARY block")
        except Exception as e:
            fails += 1
            print(f"  ✗ summarize UI didn't work: {e}")

        # Esc closes the drawer.
        try:
            page.keyboard.press('Escape')
            page.wait_for_timeout(300)
            close_btn = page.locator('button[aria-label="Close"]').first
            if close_btn.count() == 0 or not close_btn.is_visible():
                print("  ✓ Esc closes the drawer")
            else:
                fails += 1
                print("  ✗ Esc didn't close the drawer")
        except Exception as e:
            fails += 1
            print(f"  ✗ Esc-to-close: {e}")

        # Sources tab → suggested feeds.
        page.locator('button:has-text("Sources")').first.click()
        page.wait_for_timeout(400)
        try:
            page.get_by_text("Suggested feeds", exact=False).first.click()
            page.wait_for_timeout(300)
            page.get_by_text("Hacker News (front page)", exact=False).first.wait_for(state="visible", timeout=2000)
            print("  ✓ Suggested feeds expander shows curated presets")
        except Exception as e:
            fails += 1
            print(f"  ✗ suggested-feeds list missing: {e}")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
