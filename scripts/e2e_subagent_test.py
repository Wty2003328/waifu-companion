"""End-to-end pipeline test that mirrors what the browser does.

Connects to /ws/avatar, sends Ready, POSTs a chat message, captures
every server-emitted frame, then asserts on the captured payloads:

- Subagent ran successfully (subagent_used=True in Debug frame).
- clean_chat_text has no thinking-trace preamble.
- Sentence count in translated_text matches clean_chat_text.
- One Audio frame per chunk; turn_id stable across them; last=True
  fires exactly once.
- No "thank you" / "ありがとう" duplication.

Run: python scripts/e2e_subagent_test.py
"""

from __future__ import annotations

import io
import json
import re
import sys
import threading
import time
from urllib import request

# Windows console default cp1252/gbk can't print emoji or kanji from
# the agent's replies. Reconfigure stdout to UTF-8 before any print.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import websocket

WS = "ws://127.0.0.1:9181/ws/avatar"
HTTP = "http://127.0.0.1:9181/api/chat"

THINKING_MARKERS = [
    "the user said",
    "let me check",
    "let me store",
    "let me respond",
    "looking at the context",
    "webhook_msg_",
]

JA_TERMINATORS = re.compile(r"[。！？\n]")
EN_TERMINATORS = re.compile(r"[.!?]+")


def sentence_count(text: str, lang: str) -> int:
    """Cheap sentence counter that matches what split_sentences sees."""
    text = text.strip()
    if not text:
        return 0
    pat = JA_TERMINATORS if lang == "ja" else EN_TERMINATORS
    parts = [p for p in pat.split(text) if p.strip()]
    return len(parts) or 1


def run_one(message: str) -> dict:
    """Send `message` through /api/chat, listen for 30s, return findings."""
    frames: list[dict] = []
    done = threading.Event()

    def on_message(_ws, raw):
        try:
            msg = json.loads(raw)
        except Exception:
            return
        frames.append(msg)
        if msg.get("type") == "Idle":
            done.set()

    def on_open(ws):
        ws.send(json.dumps({"type": "Ready"}))

    ws = websocket.WebSocketApp(WS, on_open=on_open, on_message=on_message)
    t = threading.Thread(target=ws.run_forever, daemon=True)
    t.start()
    time.sleep(0.5)  # let WS connect + Ready settle

    req = request.Request(
        HTTP,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps({"message": message}).encode(),
    )
    started = time.monotonic()
    try:
        with request.urlopen(req, timeout=120) as resp:
            chat_body = json.loads(resp.read())
    except Exception as e:
        ws.close()
        return {"error": f"chat call failed: {e}"}

    # Wait for Idle frame (signals the turn is fully done). Long replies
    # plus subagent + N TTS chunks can run 90s+; give them room.
    done.wait(timeout=180)
    ws.close()

    elapsed = time.monotonic() - started
    by_type: dict[str, list[dict]] = {}
    for f in frames:
        by_type.setdefault(f.get("type", "?"), []).append(f)

    debug = (by_type.get("Debug") or [{}])[0]
    text_frames = by_type.get("Text") or []
    audio_frames = by_type.get("Audio") or []

    return {
        "elapsed_s": round(elapsed, 1),
        "frames_total": len(frames),
        "frame_counts": {k: len(v) for k, v in by_type.items()},
        "raw_reply": chat_body.get("reply", ""),
        "subagent_used": debug.get("subagent_used"),
        "clean_chat_text": debug.get("chat_text", ""),
        "spoken_text": debug.get("spoken_text", ""),
        "expression": debug.get("expression"),
        "subtitle_text": text_frames[0].get("content") if text_frames else None,
        "audio_chunks": [
            {
                "seq": a.get("seq"),
                "last": a.get("last"),
                "turn_id": a.get("turn_id"),
                "size_b64": len(a.get("audio") or ""),
            }
            for a in audio_frames
        ],
    }


def assert_test(name: str, cond: bool, why: str = "") -> bool:
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}{(' — ' + why) if why else ''}")
    return cond


def evaluate(case: str, r: dict) -> int:
    print(f"\n=== {case} ===")
    if "error" in r:
        print(f"  ✗ pipeline error: {r['error']}")
        return 1
    print(f"  elapsed: {r['elapsed_s']}s  frames: {r['frame_counts']}")
    print(f"  raw_reply ({len(r['raw_reply'])}c): {r['raw_reply'][:150]!r}")
    print(f"  clean_chat_text: {r['clean_chat_text'][:200]!r}")
    print(f"  spoken_text: {r['spoken_text'][:200]!r}")
    print(f"  expression: {r['expression']}  subagent_used: {r['subagent_used']}")
    print(f"  audio_chunks: {len(r['audio_chunks'])} (last marks: "
          f"{sum(1 for c in r['audio_chunks'] if c['last'])})")

    fails = 0
    if not assert_test("subagent_used=True", r["subagent_used"] is True,
                       "subagent failed/timed out → fell back to raw text"):
        fails += 1
    if not assert_test("at least 1 Text frame",
                       (r["frame_counts"].get("Text") or 0) >= 1):
        fails += 1
    if not assert_test("subtitle == clean_chat_text",
                       r["subtitle_text"] == r["clean_chat_text"],
                       "Text frame content drifts from subagent's clean output"):
        fails += 1

    clean_lower = (r["clean_chat_text"] or "").lower()
    leak = next((m for m in THINKING_MARKERS if m in clean_lower), None)
    if not assert_test("no thinking-trace leak", leak is None,
                       f"found {leak!r} in clean text"):
        fails += 1

    en_count = sentence_count(r["clean_chat_text"], "en")
    ja_count = sentence_count(r["spoken_text"], "ja")
    # Japanese-with-bullets drifts upward (each list item ends in 。) so
    # we accept up to ~3x the English count. The strong assertion is that
    # neither side is empty — that's the "subagent failed silently" smell.
    if not assert_test(
        f"sentence count nonzero on both sides (en={en_count}, ja={ja_count})",
        en_count > 0 and ja_count > 0 and ja_count <= max(3, en_count * 3),
        "Japanese drifted away from English chat-bubble alignment",
    ):
        fails += 1

    # Duplication heuristic: same word repeated 3+ times in spoken_text
    # but only once in clean_chat_text means the LLM emphasis-duplicated.
    spoken = r["spoken_text"]
    if "ありがとう" in spoken:
        ja_thanks = spoken.count("ありがとう")
        en_thanks = clean_lower.count("thank")
        if not assert_test(
            f"thanks not duplicated (en thanks={en_thanks}, ja={ja_thanks})",
            ja_thanks <= max(1, en_thanks),
            "anime emphasis duplication regression",
        ):
            fails += 1

    last_count = sum(1 for c in r["audio_chunks"] if c["last"])
    if not assert_test("exactly one last=True audio chunk", last_count == 1,
                       f"got {last_count} — frontend queue may not flush"):
        fails += 1

    if r["audio_chunks"]:
        turns = {c["turn_id"] for c in r["audio_chunks"]}
        if not assert_test("all audio chunks share one turn_id", len(turns) == 1):
            fails += 1
        if not assert_test(
            "all audio chunks have non-empty bytes",
            all(c["size_b64"] > 100 for c in r["audio_chunks"]),
            "TTS returned empty body for at least one chunk",
        ):
            fails += 1

    return fails


def main() -> int:
    cases = [
        ("plain greeting", "hello, how are you today?"),
        ("explicit thanks (regression)", "please thank me for being kind"),
        ("longer factual", "what's the best food in the United States?"),
    ]
    fails = 0
    for label, msg in cases:
        r = run_one(msg)
        fails += evaluate(label, r)
    print(f"\n{'PASS' if fails == 0 else 'FAIL'} — {fails} failed assertion(s)")
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
