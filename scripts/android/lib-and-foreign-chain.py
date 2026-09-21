#!/usr/bin/env python3
"""Samsung/Blackview : biblio + skips + hold mid-titre + titres hors biblio.

Sans son. Pas de force-stop. Pas de clavier.
Usage: DEVICE=R5CT7263YJL python3 -u scripts/android/lib-and-foreign-chain.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

DEV = os.environ.get("DEVICE") or ""
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
SKIPS = int(os.environ.get("SKIPS", "12"))
HOLD_S = float(os.environ.get("HOLD_S", "55"))
PLAY_WAIT = float(os.environ.get("PLAY_WAIT", "22"))
FOREIGN = [
    "4NRXx6U8ABQ",  # Blinding Lights
    "kJQP7kiw5Fk",  # Despacito
    "JGwWNGJdvx8",  # Shape of You
    "fJ9rUzIMcZQ",  # Bohemian Rhapsody
    "OPf0YbXqDm0",  # Uptown Funk
    "hT_nvWreIhg",  # Counting Stars
]
state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "logs" / "smoke" / f"libforeign-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{re.sub(r'[^a-zA-Z0-9]+', '_', DEV)[:20]}"
OUT.mkdir(parents=True, exist_ok=True)


def sh(*a, timeout=40) -> str:
    r = subprocess.run(["adb", "-s", DEV, *a], text=True, capture_output=True, timeout=timeout)
    return (r.stdout or "") + (r.stderr or "")


def log(m: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {m}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def mute() -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")


def dump() -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-lf.xml")
    return sh("shell", "cat", "/sdcard/ui-lf.xml")


def tap(xml: str, label: str, contains: bool = False) -> bool:
    for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
        t, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        ok = (label.lower() in t.lower()) if contains else (t == label)
        if ok and t not in ("Google", "Gboard", "Samsung"):
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            log(f"  tap {t!r} @{x},{y}")
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3600]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        st = re.search(r"state=PlaybackState\s*\{state=(?:([A-Z_]+)\()?(\d+)", chunk)
        md = re.search(r"metadata:.*description=(.*?)(?:,|\n|$)", chunk)
        if not st:
            continue
        pos_m = re.search(r"position=(\d+)", chunk[st.start() : st.start() + 280])
        best = {
            "title": (md.group(1).strip() if md else "?")[:80],
            "state": state_map.get(int(st.group(2)), st.group(1) or st.group(2)),
            "pos": int(pos_m.group(1)) if pos_m else -1,
        }
        break
    return best


def wait_play(timeout: float = PLAY_WAIT) -> dict:
    t0 = time.time()
    last = session()
    while time.time() - t0 < timeout:
        last = session()
        if last["state"] == "PLAYING" and last["pos"] >= 0:
            return last
        time.sleep(1.2)
    return last


def next_track() -> None:
    sh("shell", "cmd", "media_session", "dispatch", "next")


def main() -> int:
    if not DEV:
        raise SystemExit("DEVICE=… required")
    mute()
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2.5)
    xml = dump()
    tap(xml, "Biblio") or tap(xml, "Bibliothèque", True)
    time.sleep(1.2)
    xml = dump()
    if not tap(xml, "Aléatoire"):
        tap(dump(), "Tout lire")
    time.sleep(2.0)

    results: list[dict] = []
    ok_lib = 0
    for i in range(SKIPS):
        st = wait_play()
        ok = st["state"] == "PLAYING"
        if ok:
            ok_lib += 1
        log(f"lib[{i+1}/{SKIPS}] {'OK' if ok else 'FAIL'} {st['state']} pos={st['pos']} {st['title']}")
        results.append({"kind": "library", "i": i, "ok": ok, **st})
        next_track()
        time.sleep(1.6)

    hold0 = wait_play()
    title0, pos0 = hold0["title"], hold0["pos"]
    time.sleep(HOLD_S)
    hold1 = session()
    cut = hold1["title"] != title0 and title0 not in ("?", "")
    advanced = hold1["pos"] > pos0 + 8_000
    hold_ok = hold1["state"] == "PLAYING" and not cut and (advanced or hold1["pos"] >= 0)
    log(
        f"hold {'OK' if hold_ok else 'FAIL'} {hold0['state']}→{hold1['state']} "
        f"pos {pos0}→{hold1['pos']} cut={cut} {hold1['title']}"
    )
    results.append(
        {
            "kind": "hold",
            "ok": hold_ok,
            "cut": cut,
            "from": hold0,
            "to": hold1,
        }
    )

    ok_fr = 0
    for vid in FOREIGN:
        sh(
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            f"ytmusic://watch/{vid}",
            PKG,
        )
        time.sleep(1.2)
        st = wait_play()
        ok = st["state"] == "PLAYING"
        if ok:
            ok_fr += 1
        log(f"foreign {vid} {'OK' if ok else 'FAIL'} {st['state']} pos={st['pos']} {st['title']}")
        results.append({"kind": "foreign", "id": vid, "ok": ok, **st})

    report = {
        "device": DEV,
        "pkg": PKG,
        "out": str(OUT),
        "library_ok": ok_lib,
        "library_n": SKIPS,
        "foreign_ok": ok_fr,
        "foreign_n": len(FOREIGN),
        "hold_ok": hold_ok,
        "ok": ok_lib >= max(1, SKIPS - 2) and hold_ok and ok_fr >= 4,
        "results": results,
    }
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log(
        f"DONE lib={ok_lib}/{SKIPS} hold={'OK' if hold_ok else 'FAIL'} "
        f"foreign={ok_fr}/{len(FOREIGN)} all={'OK' if report['ok'] else 'FAIL'}"
    )
    print(json.dumps({k: report[k] for k in ("device", "ok", "library_ok", "library_n", "hold_ok", "foreign_ok", "foreign_n", "out")}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
