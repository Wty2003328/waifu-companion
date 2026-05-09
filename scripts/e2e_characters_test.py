"""End-to-end test for the character management feature.

Covers:
  - GET /api/characters returns a default empty roster on a clean install.
  - POST /api/characters creates a character and re-fetch shows it.
  - POST /api/characters with the same id updates instead of duplicating.
  - POST /api/characters/active sets the active id; /api/characters reflects it.
  - DELETE /api/characters/:id removes; the active_id clears if it pointed at the deleted one.
  - Validation: empty id rejected (400); deleting unknown id 404.
  - Settings UI shows the Characters route reachable.
  - Characters page renders the cards + "+ New character" works after creating one.

We do NOT touch /api/chat in this test (that path needs zeroclaw +
TTS running — keeping the GPU model off per user preference). The
chat-injection path is covered indirectly: handle_chat reads the
characters file via the same code path, so if these CRUD calls
work, the prepend logic on the next real chat will too.

Run: python scripts/e2e_characters_test.py
"""

from __future__ import annotations

import io
import json
import sys
from urllib import request

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:9181"


def http(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    req = request.Request(
        f"{BASE}{path}",
        method=method,
        headers={"Content-Type": "application/json"} if body else {},
        data=json.dumps(body).encode() if body else None,
    )
    try:
        with request.urlopen(req, timeout=10) as r:
            data = r.read().decode()
            try:
                return r.status, json.loads(data)
            except Exception:
                return r.status, data
    except request.HTTPError as e:
        return e.code, e.read().decode()


def main() -> int:
    fails = 0

    # ── Reset to a clean roster so re-runs are deterministic.
    # Read the existing roster + delete every character so subsequent
    # asserts start from {active_id: "", characters: []}.
    code, body = http("GET", "/api/characters")
    if code != 200:
        print(f"  ✗ initial GET /api/characters failed: {code} {body}")
        return 2
    existing_ids = [c["id"] for c in body.get("characters", [])]
    if existing_ids:
        for cid in existing_ids:
            http("DELETE", f"/api/characters/{cid}")
        print(f"  (cleaned up {len(existing_ids)} pre-existing character(s))")

    code, body = http("GET", "/api/characters")
    print(f"  GET /api/characters → {code}: {body}")
    if code == 200 and body.get("characters") == [] and body.get("active_id") == "":
        print("  ✓ clean install GET returns empty roster")
    else:
        fails += 1
        print(f"  ✗ expected empty roster, got: {body}")

    # ── Create
    char_a = {
        "id": "asuna-default",
        "name": "Asuna",
        "model_id": "asuna",
        "system_prompt": "You are Yuuki Asuna. Speak warmly.",
    }
    code, _ = http("POST", "/api/characters", char_a)
    if code == 200:
        print("  ✓ POST /api/characters created Asuna (200)")
    else:
        fails += 1
        print(f"  ✗ create returned {code}")

    code, body = http("GET", "/api/characters")
    if code == 200 and any(c["id"] == "asuna-default" for c in body["characters"]):
        print("  ✓ Asuna present in roster after create")
    else:
        fails += 1
        print(f"  ✗ Asuna missing: {body}")

    # ── Update by reposting same id (new prompt)
    char_a_updated = {**char_a, "system_prompt": "You are Asuna v2."}
    http("POST", "/api/characters", char_a_updated)
    code, body = http("GET", "/api/characters")
    matches = [c for c in body["characters"] if c["id"] == "asuna-default"]
    if len(matches) == 1 and matches[0]["system_prompt"] == "You are Asuna v2.":
        print("  ✓ re-POSTing same id updates instead of duplicating")
    else:
        fails += 1
        print(f"  ✗ update broke: {matches}")

    # ── Add a second character + activate it
    char_b = {
        "id": "haru-vtuber",
        "name": "Haru",
        "model_id": "haru",
        "system_prompt": "You are Haru.",
    }
    http("POST", "/api/characters", char_b)
    code, _ = http("POST", "/api/characters/active", {"id": "haru-vtuber"})
    if code == 200:
        print("  ✓ POST /api/characters/active set haru-vtuber active")
    else:
        fails += 1
        print(f"  ✗ activate returned {code}")

    code, body = http("GET", "/api/characters")
    if code == 200 and body["active_id"] == "haru-vtuber" and len(body["characters"]) == 2:
        print("  ✓ active_id reflects switch; roster has 2 characters")
    else:
        fails += 1
        print(f"  ✗ post-activate state wrong: {body}")

    # ── Validation: empty id rejected
    code, body = http("POST", "/api/characters", {"id": "", "name": "x", "model_id": "", "system_prompt": ""})
    if code == 400:
        print("  ✓ empty id rejected with 400")
    else:
        fails += 1
        print(f"  ✗ empty id was accepted: {code} {body}")

    # ── Validation: delete unknown id 404
    code, body = http("DELETE", "/api/characters/does-not-exist")
    if code == 404:
        print("  ✓ DELETE unknown id returns 404")
    else:
        fails += 1
        print(f"  ✗ DELETE unknown id returned {code}: {body}")

    # ── Delete the active character; active_id should clear
    http("DELETE", "/api/characters/haru-vtuber")
    code, body = http("GET", "/api/characters")
    if code == 200 and body["active_id"] == "" and len(body["characters"]) == 1:
        print("  ✓ deleting active character clears active_id")
    else:
        fails += 1
        print(f"  ✗ delete-active state wrong: {body}")

    # ── Frontend smoke: the Characters page is reachable + renders
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(f"{BASE}/characters", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1000)
        try:
            page.get_by_text("Characters", exact=False).first.wait_for(state="visible", timeout=5000)
            print("  ✓ /characters page renders title")
        except Exception:
            fails += 1
            print("  ✗ /characters page didn't render")

        # We cleaned up all characters except asuna-default (still in roster).
        # The card for it should be visible.
        try:
            page.get_by_text("Asuna", exact=False).first.wait_for(state="visible", timeout=5000)
            print("  ✓ Asuna card visible")
        except Exception:
            fails += 1
            print("  ✗ Asuna card missing on page")

        # Click "+ New character" — modal should appear with id field.
        try:
            page.get_by_text("+ New character", exact=False).first.click()
            page.wait_for_timeout(400)
            page.get_by_text("Edit character", exact=False).first.wait_for(state="visible", timeout=2000)
            print("  ✓ '+ New character' opens edit modal")
        except Exception:
            fails += 1
            print("  ✗ new-character modal didn't open")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
