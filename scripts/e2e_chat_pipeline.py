"""

Patches the overlay's WebSocket constructor BEFORE the page reconnects,
so we can see every frame flowing through the pipeline:
  - UserMessage (companion echoed)
  - Reply (zeroclaw response, post-persona-injection)
  - SubagentResult (translation + expression pick)
  - Audio (TTS WAV chunks)

Test passes if all four kinds appear within the timeout.
"""
import json, sys, time, urllib.request, urllib.error
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from websocket import create_connection  # type: ignore

CDP = "http://127.0.0.1:9222/json/list"

def find(target_filter):
    ts = json.load(urllib.request.urlopen(CDP, timeout=5))
    for t in ts:
        if t.get("type") == "page" and target_filter(t.get("url", "")):
            return t
    raise SystemExit(f"no target matching {target_filter}")

def call_with(target, mid, method, params=None):
    ws = create_connection(target["webSocketDebuggerUrl"], timeout=10)
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == mid:
            ws.close()
            return m

def evw(target, mid, expr, await_promise=False):
    r = call_with(target, mid, "Runtime.evaluate", {
        "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
    })
    return r["result"].get("result", {}).get("value", r["result"])

def main():
    main_w = find(lambda u: "overlay=" not in u)
    overlay = find(lambda u: "overlay=" in u)

    # Show the pet so the WS is connected.
    print("show pet:", evw(main_w, 1,
        'window.__TAURI_INTERNALS__.invoke("show_avatar_window").then(()=>"OK").catch(e=>"ERR:"+e)',
        await_promise=True))
    time.sleep(0.5)

    # Use Page.addScriptToEvaluateOnNewDocument so the patch runs
    # BEFORE the React tree opens its WebSocket on the next reload.
    patch_script = """
      window.__frames__ = [];
      const OrigWS = window.WebSocket;
      function PatchedWS(url, ...rest) {
        const ws = new OrigWS(url, ...rest);
        window.__frames__.push({t: 0, kind: 'OPEN', url: String(url)});
        ws.addEventListener('message', (e) => {
          try {
            const j = JSON.parse(e.data);
            const k = j.kind ?? (j.frame && j.frame.kind) ?? j.type ?? 'unknown';
            window.__frames__.push({
              t: performance.now() | 0,
              kind: k,
              size: e.data.length,
              preview: e.data.slice(0, 200),
            });
          } catch {
            window.__frames__.push({t: performance.now() | 0, kind: 'binary', size: (e.data && e.data.byteLength) || 0});
          }
        });
        return ws;
      }
      PatchedWS.prototype = OrigWS.prototype;
      Object.defineProperty(window, 'WebSocket', { value: PatchedWS, configurable: true });
    """
    print("install pre-doc patch:", call_with(overlay, 2,
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": patch_script}).get("result", {}).get("identifier"))
    print("reload overlay:", call_with(overlay, 3, "Page.reload", {})
          .get("result", {}))
    time.sleep(2.5)

    # Send chat.
    print("\n--- POST /api/chat ---")
    req = urllib.request.Request(
        "http://127.0.0.1:9181/api/chat",
        data=json.dumps({"message": "Say hello in one short sentence."}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    reply = ""
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode()
            reply = body
            print(f"  status: {r.status} in {time.time()-t0:.1f}s")
            print(f"  body: {body[:200]}")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
        return

    # Wait for TTS audio to flow.
    time.sleep(8.0)

    raw = evw(overlay, 4, "JSON.stringify(window.__frames__ || [])")
    frames = json.loads(raw or '[]')
    print(f"\n--- WS frames captured ({len(frames)}) ---")
    kinds = {}
    for f in frames:
        k = f.get('kind', '?')
        kinds[k] = kinds.get(k, 0) + 1
    print(f"  by kind: {kinds}")
    for f in frames[-25:]:
        prev = (f.get('preview') or '')[:160].replace('\n', ' ')
        print(f"  t={f.get('t')}ms kind={f.get('kind')} size={f.get('size','-')} {prev}")

    # Pass criteria
    expected = {'UserMessage', 'Reply', 'SubagentResult', 'Audio'}
    seen = set()
    for f in frames:
        # Companion broadcasts AvatarEvent::Frame { kind, ... } — kind
        # in the JSON is the variant name. Be permissive about casing.
        for e in expected:
            if e.lower() in (f.get('kind') or '').lower() or e.lower() in (f.get('preview') or '').lower():
                seen.add(e)
    print(f"\nseen kinds: {seen}")
    print(f"missing:    {expected - seen}")
    print(f"\nresult: {'PASS' if expected.issubset(seen) else 'PARTIAL — see missing kinds above'}")

if __name__ == "__main__":
    main()
