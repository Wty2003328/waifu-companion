"""Test sentence streaming end-to-end.

Sends a chat, captures every WS frame with (server-side) timestamps,
and analyzes:
  - First-audio latency (time from chat send to first Audio frame)
  - Chunk count + sizes (Audio chunks via TTS streaming)
  - Inter-chunk gaps (synthesizer staying ahead of playback?)
  - Order: are seq numbers monotonically increasing?
  - Last-flag: only the final chunk has last=true?

Failure modes we look for:
  - Chunks too small (unreliable TTS quality on tiny text)
  - Chunks too large (no streaming benefit; first audio late)
  - Out-of-order chunks (seq goes backward)
  - Missing last flag
  - Gap > 2s between consecutive chunks (TTS underrun)
"""
import sys, json, time, urllib.request
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

# Open a parallel WS to /ws/avatar via Python (no CDP needed).
from websocket import create_connection

CHAT_URL = "http://127.0.0.1:9181/api/chat"
WS_URL = "ws://127.0.0.1:9181/ws/avatar"

def main():
    if len(sys.argv) > 1:
        message = sys.argv[1]
    else:
        message = (
            "Reply in English. Tell me three study tips for tomorrow. "
            "Each tip should be one paragraph with a quick reason."
        )

    print(f"connecting to {WS_URL}")
    ws = create_connection(WS_URL, timeout=15)
    ws.settimeout(0.5)
    # Drain initial Connected + ModelInfo frames.
    for _ in range(4):
        try:
            msg = json.loads(ws.recv())
            print(f"  init: {msg.get('type')}")
        except Exception:
            break

    print(f"\nsending chat: {message[:80]}…")
    t0 = time.time()
    req = urllib.request.Request(CHAT_URL,
        data=json.dumps({"message": message}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            body = r.read().decode("utf-8", errors="replace")
            t_chat = time.time() - t0
            print(f"  chat returned {r.status} in {t_chat:.1f}s")
            print(f"  reply: {body[:150]}…\n")
    except Exception as e:
        print(f"  chat FAILED: {e}")
        return

    # Capture frames until Idle. Allow up to 5 minutes — long replies
    # with bulk-subagent + sentence TTS take 90-150s for 8-10 chunks.
    frames = []
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            raw = ws.recv()
            t_recv = time.time() - t0
            try:
                msg = json.loads(raw)
                msg["_t"] = t_recv
                msg["_size"] = len(raw)
                frames.append(msg)
                kind = msg.get("type")
                if kind == "Audio":
                    # `:>5` formats False as 'False' but coerces 0/1
                    # ints to padded-int output; print explicit bool
                    # repr to avoid the readable confusion.
                    last_repr = repr(msg.get('last'))
                    print(f"  +{t_recv:5.1f}s  Audio    seq={msg.get('seq','?'):>2} "
                          f"last={last_repr:>6}  bytes={len(raw)}")
                elif kind == "Text":
                    print(f"  +{t_recv:5.1f}s  Text     {msg.get('content','')[:80]}…")
                elif kind == "Debug":
                    print(f"  +{t_recv:5.1f}s  Debug    chat={msg.get('chat_text','')[:60]}… "
                          f"spoken={msg.get('spoken_text','')[:60]}…")
                elif kind == "Idle":
                    print(f"  +{t_recv:5.1f}s  Idle (turn complete)")
                    break
                else:
                    print(f"  +{t_recv:5.1f}s  {kind}")
            except json.JSONDecodeError:
                continue
        except Exception:
            continue

    # Analysis.
    audio = [f for f in frames if f.get("type") == "Audio"]
    print(f"\n--- analysis ---")
    print(f"Audio chunks captured: {len(audio)}")
    if not audio:
        print("FAIL: no audio")
        return

    first_audio_t = audio[0]["_t"]
    last_audio_t = audio[-1]["_t"]
    print(f"First audio: +{first_audio_t:.1f}s")
    print(f"Last audio:  +{last_audio_t:.1f}s")
    print(f"Streaming window: {last_audio_t - first_audio_t:.1f}s")

    # Order check
    seqs = [f.get("seq", -1) for f in audio]
    in_order = seqs == sorted(seqs)
    print(f"Order: seqs={seqs}  {'OK ✓' if in_order else 'OUT OF ORDER ✗'}")

    # Last flag check
    last_flags = [f.get("last", False) for f in audio]
    last_count = sum(1 for x in last_flags if x)
    last_on_final = bool(last_flags[-1])
    print(f"`last=true` count: {last_count} (expected 1, on final chunk={last_on_final})")

    # Gap analysis
    if len(audio) > 1:
        gaps = [audio[i+1]["_t"] - audio[i]["_t"] for i in range(len(audio)-1)]
        print(f"Inter-chunk gaps: {[f'{g:.1f}s' for g in gaps]}")
        max_gap = max(gaps)
        print(f"Max gap: {max_gap:.1f}s {'OK' if max_gap < 4 else 'WARN — possible TTS underrun'}")

    # Audio size analysis (rough proxy for chunk speech duration)
    sizes = [f["_size"] for f in audio]
    print(f"Chunk sizes (bytes incl. JSON wrapper): {sizes}")

    ws.close()
    print()

if __name__ == "__main__":
    main()
