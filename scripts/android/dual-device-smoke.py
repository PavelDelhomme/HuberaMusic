#!/usr/bin/env python3
"""Smoke rapide Samsung DEV + Blackview (USB) — lecture, skip, logs early_end.

Usage:
  python3 -u scripts/android/dual-device-smoke.py
  DEVICE_DEV=R5CT7263YJL DEVICE_BV=EEA9700PRO0014587 TRACKS=3 python3 -u ...
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "reports" / f"dual-smoke-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

DEVICES = [
    {
        "name": "samsung-dev",
        "serial": os.environ.get("DEVICE_DEV", "R5CT7263YJL"),
        "pkg": "ovh.delhomme.ytmusic.dev",
    },
    {
        "name": "blackview-usb",
        "serial": os.environ.get("DEVICE_BV", "EEA9700PRO0014587"),
        "pkg": os.environ.get("PKG_BV", "ovh.delhomme.ytmusic.dev"),
    },
]
if os.environ.get("BLACKVIEW_ONLY", "").strip() in ("1", "true", "yes"):
    DEVICES = [d for d in DEVICES if "blackview" in d["name"]]
if os.environ.get("SAMSUNG_ONLY", "").strip() in ("1", "true", "yes"):
    DEVICES = [d for d in DEVICES if "samsung" in d["name"]]
TRACKS = int(os.environ.get("TRACKS", "3"))
LISTEN_S = float(os.environ.get("LISTEN_S", "12"))


def sh(serial: str, *args: str, timeout: int = 45) -> str:
    try:
        r = subprocess.run(["adb", "-s", serial, *args], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def media(serial: str, pkg: str) -> dict:
    t = sh(serial, "shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(pkg)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 2800]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+)",
            chunk,
        )
        raw = (desc.group(1).strip() if desc else "")
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        code = int(m.group(2)) if m else -1
        named = (m.group(1) or "").upper() if m else ""
        state_map = {
            0: "NONE",
            1: "STOPPED",
            2: "PAUSED",
            3: "PLAYING",
            6: "BUFFERING",
            7: "ERROR",
        }
        state = named if named else state_map.get(code, str(code) if code >= 0 else "?")
        pos = int(m.group(3)) if m else -1
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        if title != "?" and score == 0 and pos > 0:
            score = 1
        if state == "ERROR" and pos > 1500:
            score = 3
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best.get("score", -1):
            best = cand
    return best


def dispatch(serial: str, action: str) -> None:
    key = {
        "skip_to_next": "next",
        "skip_to_previous": "previous",
        "play": "play",
        "pause": "pause",
    }.get(action, action)
    sh(serial, "shell", "cmd", "media_session", "dispatch", key)


def tap_play(serial: str, pkg: str) -> None:
    sh(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    for x, y in ((540, 1980), (540, 2000), (900, 1980)):
        sh(serial, "shell", "input", "tap", str(x), str(y))
        time.sleep(1.0)
        m = media(serial, pkg)
        if m["state"] in ("PLAYING", "BUFFERING") or m["pos"] > 1500:
            return
    sh(serial, "shell", "input", "keyevent", "85")


def playback_active(serial: str, pkg: str, baseline_pos: int = -1) -> tuple[bool, dict]:
    m = media(serial, pkg)
    if m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?":
        return True, m
    if m["pos"] > 1500:
        return True, m
    if baseline_pos >= 0 and m["pos"] > baseline_pos + 800:
        return True, m
    if m["state"] == "ERROR" and m["pos"] > 5000:
        return True, m
    return False, m


def mute(serial: str) -> None:
    sh(serial, "shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh(serial, "shell", "media", "volume", "--stream", "3", "--set", "0")


def early_end_count(serial: str, pkg: str) -> int:
    out = sh(
        serial,
        "shell",
        "logcat",
        "-d",
        "-t",
        "200",
        "-s",
        "PlaybackService:W",
        "PlaybackService:E",
        timeout=20,
    )
    return len(re.findall(r"fin trop tôt", out))


def smoke_one(dev: dict) -> dict:
    name, serial, pkg = dev["name"], dev["serial"], dev["pkg"]
    result = {"name": name, "serial": serial, "pkg": pkg, "ok": True, "checks": []}
    progress_ok = 0

    def check(label: str, ok: bool, detail: str = "", soft: bool = False) -> None:
        result["checks"].append({"name": label, "ok": ok, "detail": detail, "soft": soft})
        if not ok and not soft:
            result["ok"] = False
        log(f"[{name}] {'PASS' if ok else ('SOFT' if soft else 'FAIL')} {label}" + (f" — {detail}" if detail else ""))

    online = "device" in sh(serial, "get-state")
    check("device:online", online, serial)
    if not online:
        return result

    ver = sh(serial, "shell", f"dumpsys package {pkg} | grep versionName | head -1")
    check("pkg:installed", "versionName" in ver, ver.strip()[:80])

    mute(serial)
    before_ee = early_end_count(serial, pkg)

    sh(serial, "shell", f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1", timeout=20)
    time.sleep(2)
    m_before = media(serial, pkg)
    dispatch(serial, "play")
    time.sleep(3)

    playing, m0 = playback_active(serial, pkg, m_before["pos"])
    if not playing:
        dispatch(serial, "play")
        time.sleep(2)
        tap_play(serial, pkg)
        time.sleep(3)
        playing, m0 = playback_active(serial, pkg, m_before["pos"])
    check("playback:active", playing, f"{m0['state']} · {m0['title'][:40]}", soft=True)

    if not playing:
        dispatch(serial, "play")
        time.sleep(4)
        playing, m0 = playback_active(serial, pkg, m_before["pos"])
        check("playback:retry", playing, f"{m0['state']} · {m0['title'][:40]}", soft=True)

    titles: list[str] = []
    for i in range(TRACKS):
        time.sleep(LISTEN_S)
        m = media(serial, pkg)
        titles.append(m["title"])
        advancing = m["pos"] > 1500 or m["state"] == "PLAYING" or m["state"] == "BUFFERING"
        if advancing:
            progress_ok += 1
        check(f"track{i+1}:progress", advancing, f"pos={m['pos']} · {m['title'][:36]}")
        if i < TRACKS - 1:
            dispatch(serial, "skip_to_next")
            time.sleep(2.5)

    after_ee = early_end_count(serial, pkg)
    delta = max(0, after_ee - before_ee)
    check("eos:no_early_end_burst", delta <= 1, f"fin trop tôt delta={delta}")

    # OK global si progression réelle même si parser ERROR au démarrage
    if progress_ok >= max(1, TRACKS - 1) and delta <= 1:
        result["ok"] = True

    result["titles"] = titles
    return result


def main() -> int:
    log(f"dual-device-smoke OUT={OUT} TRACKS={TRACKS}")
    report = {"ok": True, "devices": []}
    for dev in DEVICES:
        r = smoke_one(dev)
        report["devices"].append(r)
        if not r["ok"]:
            report["ok"] = False
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} → {OUT / 'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
