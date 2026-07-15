#!/usr/bin/env python3
"""
Solar Memesis — file watcher
Watches html/css/js (and this folder) and asks Node to refresh browsers (like F5).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RELOAD_URL = "http://127.0.0.1:3000/__reload"
POLL_SEC = 0.35
WATCH_EXTS = {".html", ".css", ".js", ".json", ".py"}
IGNORE_DIRS = {".git", "node_modules", "__pycache__", ".cursor"}


def snapshot() -> dict[str, float]:
    out: dict[str, float] = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in WATCH_EXTS:
                continue
            # Don't reload when only the watcher itself is edited mid-scan spam — still OK
            try:
                out[str(p.relative_to(ROOT))] = p.stat().st_mtime
            except OSError:
                pass
    return out


def trigger(file: str) -> None:
    data = json.dumps({"file": file}).encode("utf-8")
    req = urllib.request.Request(
        RELOAD_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            resp.read()
        print(f"[watcher] reload ← {file}")
    except urllib.error.URLError as e:
        print(f"[watcher] Node not ready ({e})")
    except Exception as e:
        print(f"[watcher] error: {e}")


def main() -> int:
    print("")
    print("  Solar Memesis — Python live reload")
    print(f"  Watching: {ROOT}")
    print(f"  Ext: {', '.join(sorted(WATCH_EXTS))}")
    print("")

    # Wait for Node
    for _ in range(40):
        try:
            urllib.request.urlopen("http://127.0.0.1:3000/", timeout=1)
            break
        except Exception:
            time.sleep(0.25)
    else:
        print("[watcher] Node server did not start on :3000")
        return 1

    prev = snapshot()
    print(f"[watcher] tracking {len(prev)} files")

    while True:
        time.sleep(POLL_SEC)
        cur = snapshot()
        changed = []
        for k, m in cur.items():
            if k not in prev or prev[k] != m:
                changed.append(k)
        for k in prev:
            if k not in cur:
                changed.append(k)
        if changed:
            # one broadcast per batch
            trigger(changed[0] if len(changed) == 1 else f"{len(changed)} files")
        prev = cur


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n[watcher] stopped")
        raise SystemExit(0)
