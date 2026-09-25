#!/usr/bin/env python3
"""Aléatoire biblio + skips + une fin naturelle — sans son, sans clavier."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime

DEV = os.environ.get("DEVICE") or ""
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
SKIPS = int(os.environ.get("SKIPS", "5"))
WARM_S = float(os.environ.get("WARM_S", "10"))
NATURAL_S = float(os.environ.get("NATURAL_S", "55"))
state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}


def sh(*a, timeout=40) -> str:
    r = subprocess.run(["adb", "-s", DEV, *a], text=True, capture_output=True, timeout=timeout)
    return (r.stdout or "") + (r.stderr or "")


def log(m: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S')} {m}", flush=True)


def mute() -> None:
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")


def dump() -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-end.xml")
    return sh("shell", "cat", "/sdcard/ui-end.xml")


def tap(xml: str, label: str) -> bool:
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml
    ):
        if m.group(1) == label:
            x = (int(m.group(2)) + int(m.group(4))) // 2
            y = (int(m.group(3)) + int(m.group(5))) // 2
            log(f"  tap {label} @{x},{y}")
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "buf": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3600]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        st = re.search(r"state=PlaybackState\s*\{state=(?:([A-Z_]+)\()?(\d+)", chunk)
        md = re.search(r"metadata:.*description=(.*?)(?:,|\n|$)", chunk)
        if not st:
            continue
        state = state_map.get(int(st.group(2)), st.group(1) or st.group(2))
        pos_m = re.search(r"position=(\d+)", chunk[st.start() : st.start() + 280])
        buf_m = re.search(r"buffered position=(\d+)", chunk)
        best = {
            "title": (md.group(1).strip() if md else "?")[:70],
            "state": state,
            "pos": int(pos_m.group(1)) if pos_m else -1,
            "buf": int(buf_m.group(1)) if buf_m else -1,
        }
        break
    return best


def wait_play(timeout=14) -> dict:
    t0 = time.time()
    last = session()
    while time.time() - t0 < timeout:
        last = session()
        if last["state"] == "PLAYING" and last["title"] not in ("?", ""):
            return {**last, "ttfb": round(time.time() - t0, 2)}
        time.sleep(0.22)
    return {**last, "ttfb": round(time.time() - t0, 2)}


def measure_next(kind: str) -> dict:
    before = session()
    title0 = before["title"]
    out = sh("shell", "cmd", "media_session", "dispatch", "next")
    t0 = time.time()
    time.sleep(0.45)
    probe = session()
    if probe["title"] in ("?", title0):
        sh("shell", "input", "keyevent", "87")
        t0 = time.time()
    last = before
    buf = 0.0
    bs = None
    while time.time() - t0 < 14:
        last = session()
        if last["state"] == "BUFFERING":
            if bs is None:
                bs = time.time()
        elif bs is not None:
            buf += time.time() - bs
            bs = None
        if last["title"] not in ("?", title0) and last["state"] == "PLAYING":
            if bs:
                buf += time.time() - bs
            rec = {
                "kind": kind,
                "from": title0,
                "to": last["title"],
                "gap": round(time.time() - t0, 2),
                "buffering": round(buf, 2),
                "ok": (time.time() - t0) <= 5.0 and buf <= 4.0,
            }
            log("  " + json.dumps(rec, ensure_ascii=False))
            mute()
            return rec
        time.sleep(0.2)
    if bs:
        buf += time.time() - bs
    rec = {
        "kind": kind,
        "from": title0,
        "to": last["title"],
        "gap": round(time.time() - t0, 2),
        "buffering": round(buf, 2),
        "state": last["state"],
        "ok": False,
    }
    log("  FAIL " + json.dumps(rec, ensure_ascii=False))
    mute()
    return rec


def watch_natural(timeout: float) -> dict:
    before = session()
    title0 = before["title"]
    t0 = time.time()
    last = before
    buf = 0.0
    bs = None
    log(f"  watch natural from {title0!r} pos={before['pos']}")
    while time.time() - t0 < timeout:
        last = session()
        if last["state"] == "BUFFERING":
            if bs is None:
                bs = time.time()
        elif bs is not None:
            buf += time.time() - bs
            bs = None
        if last["title"] not in ("?", title0) and last["state"] == "PLAYING":
            if bs:
                buf += time.time() - bs
            rec = {
                "kind": "natural",
                "from": title0,
                "to": last["title"],
                "gap": round(time.time() - t0, 2),
                "buffering": round(buf, 2),
                "ok": buf <= 4.0,
            }
            log("  " + json.dumps(rec, ensure_ascii=False))
            return rec
        time.sleep(0.22)
    if bs:
        buf += time.time() - bs
    rec = {
        "kind": "natural",
        "from": title0,
        "to": last["title"],
        "gap": round(time.time() - t0, 2),
        "buffering": round(buf, 2),
        "state": last["state"],
        "ok": False,
    }
    log("  FAIL " + json.dumps(rec, ensure_ascii=False))
    return rec


def main() -> int:
    if not DEV:
        raise SystemExit("DEVICE required")
    mute()
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    sh("shell", "am", "start", "-n", f"{PKG}/ovh.delhomme.ytmusic.MainActivity")
    time.sleep(2.2)
    xml = dump()
    tap(xml, "Biblio") or tap(xml, "Bibliothèque")
    time.sleep(1.0)
    xml = dump()
    tap(xml, "Titres")
    time.sleep(0.8)
    xml = dump()
    t_click = time.time()
    tap(xml, "Aléatoire")
    s = wait_play(16)
    log(f"SHUFFLE {json.dumps({**s, 'click': round(time.time() - t_click, 2)}, ensure_ascii=False)}")
    mute()
    log(f"prefetch window {WARM_S}s")
    time.sleep(WARM_S)
    rows = []
    for i in range(SKIPS):
        rows.append(measure_next(f"skip-{i + 1}"))
        time.sleep(7)
    if NATURAL_S > 0:
        rows.append(watch_natural(NATURAL_S))
    ok = sum(1 for r in rows if r.get("ok"))
    log(f"DONE {ok}/{len(rows)}")
    print(json.dumps({"device": DEV, "ok": ok, "n": len(rows), "rows": rows}, ensure_ascii=False))
    return 0 if ok >= max(3, len(rows) - 2) else 2


if __name__ == "__main__":
    raise SystemExit(main())
