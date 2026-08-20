#!/usr/bin/env python3
"""Smoke multi-flavour : Blackview DEV+PROD, Samsung DEV (LAN / API prod / package prod).

Usage:
  python3 -u scripts/android/multi-flavor-smoke.py
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
OUT = ROOT / "docs" / "reports" / f"multi-flavor-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

LAN_IP = os.environ.get(
    "LAN_IP",
    subprocess.run(
        ["bash", "-lc", "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"src\"){print $(i+1); exit}}'"],
        capture_output=True,
        text=True,
    ).stdout.strip()
    or "192.168.1.134",
)

TARGETS = [
    {
        "name": "blackview-dev",
        "serial": os.environ.get("DEVICE_BV", "EEA9700PRO0014587"),
        "pkg": "ovh.delhomme.ytmusic.dev",
        "expect_ver": "d+1.3.40",
        "login_api": f"http://{LAN_IP}:8787",
    },
    {
        "name": "blackview-prod",
        "serial": os.environ.get("DEVICE_BV", "EEA9700PRO0014587"),
        "pkg": "ovh.delhomme.ytmusic",
        "expect_ver": "p+1.3.40",
        "login_api": os.environ.get("PUBLIC_API_URL", "https://ytmusic.delhomme.ovh"),
    },
    {
        "name": "samsung-dev-local",
        "serial": os.environ.get("DEVICE_SAM", "R5CT7263YJL"),
        "pkg": "ovh.delhomme.ytmusic.dev",
        "expect_ver": "d+1.3.40",
        "login_api": f"http://{LAN_IP}:8787",
    },
    {
        "name": "samsung-dev-prod-api",
        "serial": os.environ.get("DEVICE_SAM", "R5CT7263YJL"),
        "pkg": "ovh.delhomme.ytmusic.dev",
        "expect_ver": "d+1.3.40",
        "login_api": os.environ.get("PUBLIC_API_URL", "https://ytmusic.delhomme.ovh"),
    },
    {
        "name": "samsung-prod",
        "serial": os.environ.get("DEVICE_SAM", "R5CT7263YJL"),
        "pkg": "ovh.delhomme.ytmusic",
        "expect_ver": "p+1.3.40",
        "login_api": os.environ.get("PUBLIC_API_URL", "https://ytmusic.delhomme.ovh"),
    },
]

LISTEN_S = float(os.environ.get("LISTEN_S", "8"))
TRACKS = int(os.environ.get("TRACKS", "2"))


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(serial: str, *args: str, timeout: int = 45) -> str:
    try:
        r = subprocess.run(["adb", "-s", serial, *args], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


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
        state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING"}
        state = named if named else state_map.get(code, str(code) if code >= 0 else "?")
        pos = int(m.group(3)) if m else -1
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        if title != "?" and score == 0 and pos > 0:
            score = 1
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best["score"]:
            best = cand
    return best


def dispatch(serial: str, key: str) -> None:
    sh(serial, "shell", "cmd", "media_session", "dispatch", key)


def mute(serial: str) -> None:
    sh(serial, "shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh(serial, "shell", "media", "volume", "--stream", "3", "--set", "0")


def login(serial: str, pkg: str, api: str) -> bool:
    env = os.environ.copy()
    env["DEVICE"] = serial
    env["PKG"] = pkg
    env["API_BASE_URL"] = api.rstrip("/")
    try:
        r = subprocess.run(
            ["bash", str(ROOT / "scripts/adb/adb-login.sh")],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
        )
        out = (r.stdout or "") + (r.stderr or "")
        log(f"login {pkg}@{api}: rc={r.returncode} {out.strip().splitlines()[-1] if out.strip() else ''}")
        return r.returncode == 0
    except Exception as e:
        log(f"login fail: {e}")
        return False


def tap_home_play(serial: str) -> bool:
    sh(serial, "shell", "uiautomator", "dump", "/sdcard/ui-mf.xml", timeout=30)
    xml = sh(serial, "shell", "cat", "/sdcard/ui-mf.xml", timeout=15)
    for label in ("Aléatoire", "Papaoutai", "Welcome to The Internet", "Lecture"):
        for m in re.finditer(
            r'(?:text|content-desc)="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            if m.group(1) == label:
                x = (int(m.group(2)) + int(m.group(4))) // 2
                y = (int(m.group(3)) + int(m.group(5))) // 2
                sh(serial, "shell", "input", "tap", str(x), str(y))
                time.sleep(4)
                return True
    return False


def early_end_delta(serial: str) -> int:
    out = sh(serial, "shell", "logcat", "-d", "-t", "120", timeout=20)
    return len(re.findall(r"fin trop tôt", out))


def smoke(tgt: dict) -> dict:
    name, serial, pkg = tgt["name"], tgt["serial"], tgt["pkg"]
    res = {"name": name, "serial": serial, "pkg": pkg, "ok": True, "checks": []}

    def check(label: str, ok: bool, detail: str = "") -> None:
        res["checks"].append({"name": label, "ok": ok, "detail": detail})
        if not ok:
            res["ok"] = False
        log(f"[{name}] {'PASS' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail else ""))

    online = "device" in sh(serial, "get-state")
    check("device:online", online, serial)
    if not online:
        return res

    ver = sh(serial, "shell", f"dumpsys package {pkg} | grep versionName | head -1")
    check("pkg:version", tgt["expect_ver"] in ver, ver.strip()[:80])

    mute(serial)
    before = early_end_delta(serial)
    ok_login = login(serial, pkg, tgt["login_api"])
    check("auth:login", ok_login, tgt["login_api"])
    time.sleep(2)
    tap_home_play(serial)
    dispatch(serial, "play")
    time.sleep(3)
    m0 = media(serial, pkg)
    playing = m0["state"] in ("PLAYING", "BUFFERING", "PAUSED") and m0["title"] != "?"
    check("playback:session", playing, f"{m0['state']} · {m0['title'][:40]}")

    # Force-stop + reopen → doit rester en pause (pas auto-play)
    sh(serial, "shell", f"am force-stop {pkg}")
    time.sleep(1)
    sh(serial, "shell", f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1", timeout=20)
    time.sleep(4)
    m1 = media(serial, pkg)
    not_auto = m1["state"] != "PLAYING"
    check("reopen:paused", not_auto, f"{m1['state']} · {m1['title'][:36]}")

    # Reprendre + skips
    dispatch(serial, "play")
    time.sleep(2)
    tap_home_play(serial)
    dispatch(serial, "play")
    for i in range(TRACKS):
        time.sleep(LISTEN_S)
        m = media(serial, pkg)
        check(
            f"track{i+1}:alive",
            m["title"] != "?" or m["pos"] > 0,
            f"pos={m['pos']} · {m['title'][:36]}",
        )
        if i < TRACKS - 1:
            dispatch(serial, "next")
            time.sleep(2)

    after = early_end_delta(serial)
    delta = max(0, after - before)
    check("eos:no_burst", delta <= 2, f"fin trop tôt delta={delta}")
    return res


def main() -> int:
    log(f"multi-flavor-smoke OUT={OUT} LAN={LAN_IP}")
    report = {"ok": True, "targets": []}
    for tgt in TARGETS:
        r = smoke(tgt)
        report["targets"].append(r)
        if not r["ok"]:
            report["ok"] = False
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} → {OUT / 'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
