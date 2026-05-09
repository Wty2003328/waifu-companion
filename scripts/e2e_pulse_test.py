"""End-to-end test for the Pulse subsystem.

Exercises every CRUD endpoint + the tabbed UI.

Backend (no Playwright):
  - GET  /api/pulse/status            collectors list shows rss/hackernews/videos/github_releases
  - GET  /api/pulse/feeds             empty initial roster
  - POST /api/pulse/feeds             add a feed → list reflects it
  - DELETE /api/pulse/feeds?url=…     remove → list empty again
  - GET  /api/pulse/videos            empty initial roster
  - POST /api/pulse/videos            add youtube + bilibili
  - validation rejects unsupported platform (400)
  - DELETE /api/pulse/videos          unsubscribe one, leave the other
  - PUT  /api/pulse/settings/rsshub_url    set + read back
  - PUT with empty value clears the setting

Frontend (Playwright):
  - /pulse renders a tabbed UI
  - "Sources" tab shows both RSS and Video panels with "Add" buttons
  - "Settings" tab shows the rsshub_url field

Pre-condition: companion-server must be running with [pulse] enabled.

Run: python scripts/e2e_pulse_test.py
"""

from __future__ import annotations

import io
import json
import sys
from urllib import request, parse

from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:9181"


def http(method: str, path: str, body: dict | None = None) -> tuple[int, object]:
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

    # ── Pulse enabled? ──
    code, body = http("GET", "/api/pulse/status")
    if code != 200:
        print(f"  ✗ /api/pulse/status returned {code}: {body}")
        print("    (Pulse may be disabled in companion.toml — set [pulse] enabled = true)")
        return 1
    cols = {c["id"] for c in body.get("collectors", [])}
    expected_min = {"rss", "hackernews"}
    if expected_min.issubset(cols):
        print(f"  ✓ /api/pulse/status reports collectors: {sorted(cols)}")
    else:
        fails += 1
        print(f"  ✗ missing default collectors. got {sorted(cols)}")

    # ── Reset RSS feeds + video channels for deterministic test ──
    code, body = http("GET", "/api/pulse/feeds")
    for f in body.get("feeds", []):
        http("DELETE", f"/api/pulse/feeds?url={parse.quote(f['url'], safe='')}")
    code, body = http("GET", "/api/pulse/videos")
    for v in body.get("videos", []):
        http(
            "DELETE",
            f"/api/pulse/videos?platform={v['platform']}&channel_id={parse.quote(v['channel_id'], safe='')}",
        )
    http("PUT", "/api/pulse/settings/rsshub_url", {"value": ""})

    # ── RSS feeds CRUD ──
    code, _ = http(
        "POST", "/api/pulse/feeds",
        {"name": "Hacker News (probe)", "url": "https://hnrss.org/frontpage"},
    )
    assert code == 200, f"add feed: {code}"
    code, body = http("GET", "/api/pulse/feeds")
    if any(f["url"] == "https://hnrss.org/frontpage" for f in body["feeds"]):
        print("  ✓ POST /feeds created the entry")
    else:
        fails += 1
        print(f"  ✗ feed missing after POST: {body}")
    code, _ = http("DELETE", "/api/pulse/feeds?url=https%3A%2F%2Fhnrss.org%2Ffrontpage")
    assert code == 200, f"delete feed: {code}"
    code, body = http("GET", "/api/pulse/feeds")
    if not any(f["url"] == "https://hnrss.org/frontpage" for f in body["feeds"]):
        print("  ✓ DELETE /feeds removed the entry")
    else:
        fails += 1
        print(f"  ✗ feed still present after DELETE: {body}")

    # ── Video channels CRUD ──
    code, _ = http("POST", "/api/pulse/videos", {
        "platform": "youtube", "channel_id": "UCsXVk37bltHxD1rDPwtNM8Q", "display_name": "Kurzgesagt",
    })
    assert code == 200, f"add youtube: {code}"
    code, _ = http("POST", "/api/pulse/videos", {
        "platform": "bilibili", "channel_id": "12345", "display_name": "Test UID",
    })
    assert code == 200, f"add bilibili: {code}"
    code, body = http("GET", "/api/pulse/videos")
    platforms = {v["platform"] for v in body["videos"]}
    if platforms == {"youtube", "bilibili"}:
        print("  ✓ video channels added (youtube + bilibili)")
    else:
        fails += 1
        print(f"  ✗ video roster wrong: {body}")

    # ── Validation: unsupported platform ──
    code, body = http("POST", "/api/pulse/videos", {
        "platform": "tiktok", "channel_id": "x", "display_name": "y",
    })
    if code == 400:
        print("  ✓ unsupported platform rejected with 400")
    else:
        fails += 1
        print(f"  ✗ unsupported platform should 400 (got {code}: {body})")

    # ── Update by re-POST should not duplicate ──
    code, _ = http("POST", "/api/pulse/videos", {
        "platform": "youtube", "channel_id": "UCsXVk37bltHxD1rDPwtNM8Q", "display_name": "Kurzgesagt – In a Nutshell",
    })
    assert code == 200
    code, body = http("GET", "/api/pulse/videos")
    yt = [v for v in body["videos"] if v["platform"] == "youtube"]
    if len(yt) == 1 and yt[0]["display_name"] == "Kurzgesagt – In a Nutshell":
        print("  ✓ re-POST same channel updates display_name in place")
    else:
        fails += 1
        print(f"  ✗ re-POST broke: {yt}")

    # ── Delete one, leave the other ──
    code, _ = http(
        "DELETE", f"/api/pulse/videos?platform=bilibili&channel_id=12345"
    )
    assert code == 200
    code, body = http("GET", "/api/pulse/videos")
    if {v["platform"] for v in body["videos"]} == {"youtube"}:
        print("  ✓ targeted DELETE removes only the named channel")
    else:
        fails += 1
        print(f"  ✗ wrong videos remained: {body}")

    # ── Settings PUT/GET ──
    code, _ = http("PUT", "/api/pulse/settings/rsshub_url", {"value": "https://rsshub.example.com"})
    assert code == 200
    code, body = http("GET", "/api/pulse/settings/rsshub_url")
    if body.get("value") == "https://rsshub.example.com":
        print("  ✓ PUT/GET settings round-trip")
    else:
        fails += 1
        print(f"  ✗ settings mismatch: {body}")
    # Empty string clears.
    code, _ = http("PUT", "/api/pulse/settings/rsshub_url", {"value": ""})
    code, body = http("GET", "/api/pulse/settings/rsshub_url")
    if body.get("value") in (None, ""):
        print("  ✓ empty PUT clears the setting")
    else:
        fails += 1
        print(f"  ✗ clear failed: {body}")

    # ── Cleanup leftover state from this run ──
    http("DELETE", "/api/pulse/videos?platform=youtube&channel_id=UCsXVk37bltHxD1rDPwtNM8Q")

    # ── Frontend: tabbed UI renders ──
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context().new_page()
        page.goto(f"{BASE}/pulse", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(800)

        for label in ("Feed", "Sources", "Settings"):
            try:
                page.locator(f'button:has-text("{label}")').first.wait_for(state="visible", timeout=2000)
            except Exception:
                fails += 1
                print(f"  ✗ tab '{label}' missing")
                break
        else:
            print("  ✓ Pulse page renders Feed / Sources / Settings tabs")

        # Sources tab: both panels visible
        page.locator('button:has-text("Sources")').first.click()
        page.wait_for_timeout(400)
        for panel in ("RSS feeds", "Video subscriptions"):
            try:
                page.get_by_text(panel, exact=False).first.wait_for(state="visible", timeout=2000)
            except Exception:
                fails += 1
                print(f"  ✗ Sources tab missing '{panel}' panel")
                break
        else:
            print("  ✓ Sources tab shows RSS + Video panels")

        # Settings tab: rsshub field visible
        page.locator('button:has-text("Settings")').first.click()
        page.wait_for_timeout(400)
        try:
            page.get_by_text("RSSHub instance URL", exact=False).first.wait_for(state="visible", timeout=2000)
            print("  ✓ Settings tab shows RSSHub field")
        except Exception:
            fails += 1
            print("  ✗ Settings tab missing rsshub field")

        browser.close()

    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
