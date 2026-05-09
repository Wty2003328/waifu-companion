"""Verify the Open button calls open_external_url via Tauri."""
import json, sys, time, urllib.request
from websocket import create_connection  # type: ignore

def find_main():
    ts = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5))
    for t in ts:
        if t.get("type") == "page" and "overlay=" not in t.get("url", ""):
            return t

def call(ws, mid, method, params=None):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg

def ev(ws, mid, expr):
    r = call(ws, mid, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("result", {}).get("value")

def main():
    target = find_main()
    ws = create_connection(target["webSocketDebuggerUrl"], timeout=10)
    # Reset state via reload
    call(ws, 1, "Runtime.evaluate", {"expression": "location.href = '/pulse'"})
    time.sleep(3)
    # Patch invoke BEFORE clicking
    print(ev(ws, 2, """
        (function(){
          const w = window;
          const inv = w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke;
          if (!inv) return 'NO_TAURI';
          w.__open_calls__ = [];
          w.__orig_invoke__ = inv;
          w.__TAURI_INTERNALS__.invoke = function(cmd, args){
            if (cmd === 'open_external_url') w.__open_calls__.push(args);
            return inv.call(this, cmd, args);
          };
          return 'PATCHED';
        })();
    """))
    # Click first feed item to open drawer
    print('clicked item:', ev(ws, 3, "(document.querySelector('article'))?.click(); 'clicked'"))
    time.sleep(0.6)
    # Find the Open button by exact text
    btn_info = ev(ws, 4, """
        (function(){
          const btns = Array.from(document.querySelectorAll('button'));
          const open = btns.find(b => b.textContent.trim() === 'Open ↗');
          if (!open) return {found:false, allTexts: btns.map(b=>b.textContent.trim()).filter(Boolean).slice(0,30)};
          const r = open.getBoundingClientRect();
          return {found:true, x: r.x, y: r.y, w: r.width, h: r.height, text: open.textContent.trim()};
        })();
    """)
    print('open button:', json.dumps(btn_info, ensure_ascii=False)[:300])
    # Click it
    print('click result:', ev(ws, 5, """
        (function(){
          const btns = Array.from(document.querySelectorAll('button'));
          const open = btns.find(b => b.textContent.trim() === 'Open ↗');
          if (!open) return 'no_button';
          open.click();
          return 'clicked';
        })();
    """))
    time.sleep(0.6)
    print('open_external_url calls:', ev(ws, 6, "JSON.stringify(window.__open_calls__ || [])"))
    ws.close()

if __name__ == "__main__":
    main()
