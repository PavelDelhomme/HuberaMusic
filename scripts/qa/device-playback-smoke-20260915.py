#!/usr/bin/env python3
"""Smoke lecture PLM Dev (Samsung + Blackview) → API LAN.

Usage:
  API_BASE_URL=http://192.168.1.134:8787 python3 -u scripts/qa/device-playback-smoke-20260915.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("API_BASE_URL", "http://192.168.1.134:8787").rstrip("/")
PKG = "ovh.delhomme.ytmusic.dev"
DEVICES = [
    ("samsung", os.environ.get("DEVICE_DEV", "R5CT7263YJL")),
    ("blackview", os.environ.get("DEVICE_BV", "EEA9700PRO0014587")),
]
OUT = ROOT / "tmp" / f"device-playback-smoke-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
TRACKS = int(os.environ.get("TRACKS", "3"))
LISTEN_S = float(os.environ.get("LISTEN_S", "9"))


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(serial: str, *args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", serial, *args],
            capture_output=True,
            timeout=timeout,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return (r.stdout or "") + (r.stderr or "")


def load_env_password() -> tuple[str, str]:
    email = os.environ.get("SEED_EMAIL") or os.environ.get("LOGIN_EMAIL") or "dev@delhomme.ovh"
    password = (
        os.environ.get("SEED_PASSWORD")
        or os.environ.get("LOGIN_PASSWORD")
        or os.environ.get("VITE_DEV_PASSWORD")
        or ""
    )
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("SEED_EMAIL=") and "SEED_EMAIL" not in os.environ:
                email = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("SEED_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("VITE_DEV_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
    return email, password


def api_login() -> tuple[str, str, str]:
    email, password = load_env_password()
    req = urllib.request.Request(
        f"{API}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read().decode())
    token = d.get("token") or d.get("accessToken") or ""
    refresh = d.get("refreshToken") or ""
    if not token:
        raise RuntimeError(f"login failed: {d}")
    return token, refresh, email


def media(serial: str) -> dict:
    t = sh(serial, "shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3200]
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
        if title != "?" and pos > 0 and score == 0:
            score = 1
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best["score"]:
            best = cand
    return best


def ui_has_home(serial: str) -> bool:
    sh(serial, "shell", "uiautomator", "dump", "/sdcard/ui-plm-smoke.xml")
    xml = sh(serial, "shell", "cat", "/sdcard/ui-plm-smoke.xml")
    return any(x in xml for x in ("Accueil", "Biblio", "Bibliothèque", "Recherche", "Mixés"))


def tap_text(serial: str, label: str) -> bool:
    sh(serial, "shell", "uiautomator", "dump", "/sdcard/ui-plm-smoke.xml")
    xml = sh(serial, "shell", "cat", "/sdcard/ui-plm-smoke.xml")
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        t, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        if t == label or label.lower() in t.lower():
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            sh(serial, "shell", "input", "tap", str(x), str(y))
            log(f"  tap {t!r} @{x},{y}")
            return True
    return False


def inject(serial: str, token: str, refresh: str, email: str) -> None:
    sh(serial, "shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh(serial, "shell", "am", "force-stop", PKG)
    # Évite que Gasoil vole le focus (vu sur Blackview)
    for p in (
        "ovh.delhomme.gasoil",
        "ovh.delhomme.gasoil.dev",
        "ovh.delhomme.gasoiltracking",
        "ovh.delhomme.gasoiltracking.dev",
    ):
        sh(serial, "shell", "am", "force-stop", p)
    time.sleep(0.4)
    args = [
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
        "--es",
        "ytm_access_token",
        token,
        "--es",
        "ytm_user_email",
        email,
    ]
    if refresh:
        args += ["--es", "ytm_refresh_token", refresh]
    sh(serial, *args)
    time.sleep(4.5)
    sh(serial, "shell", "am", "start", "-n", f"{PKG}/ovh.delhomme.ytmusic.MainActivity")
    time.sleep(1.5)


def try_start_playback(serial: str) -> dict:
    m0 = media(serial)
    if m0["state"] in ("PLAYING", "BUFFERING") or m0["pos"] > 1500:
        return m0
    sh(serial, "shell", "cmd", "media_session", "dispatch", "play")
    time.sleep(2.5)
    m = media(serial)
    if m["state"] in ("PLAYING", "BUFFERING") or m["pos"] > 1500:
        return m
    # Mini-player / titre récent
    for label in ("Écouté récemment", "StarStruck", "Mixés pour toi"):
        if tap_text(serial, label):
            time.sleep(1.2)
            # second tap on first track-ish text if still idle
            break
    # Tap near typical first card / miniplayer play
    for x, y in ((270, 920), (540, 1100), (200, 1700), (540, 1980)):
        sh(serial, "shell", "input", "tap", str(x), str(y))
        time.sleep(1.2)
        m = media(serial)
        if m["state"] in ("PLAYING", "BUFFERING") or m["pos"] > 800:
            return m
    sh(serial, "shell", "input", "keyevent", "85")
    time.sleep(2)
    return media(serial)


def smoke_one(name: str, serial: str, token: str, refresh: str, email: str) -> dict:
    result = {"name": name, "serial": serial, "ok": False, "checks": [], "titles": []}
    state = sh(serial, "get-state").strip()
    online = "device" in state
    result["checks"].append({"name": "online", "ok": online, "detail": state})
    log(f"[{name}] online={online}")
    if not online:
        return result

    inject(serial, token, refresh, email)
    home = ui_has_home(serial)
    result["checks"].append({"name": "home_ui", "ok": home})
    log(f"[{name}] home_ui={home}")
    if not home:
        # retry inject once
        inject(serial, token, refresh, email)
        home = ui_has_home(serial)
        result["checks"].append({"name": "home_ui_retry", "ok": home})
        log(f"[{name}] home_ui_retry={home}")

    m = try_start_playback(serial)
    started = m["state"] in ("PLAYING", "BUFFERING", "PAUSED") or m["pos"] > 500
    result["checks"].append(
        {"name": "playback_start", "ok": started, "detail": f"{m['state']} · {m['title'][:40]}"}
    )
    log(f"[{name}] start {m['state']} pos={m['pos']} title={m['title'][:40]!r}")

    progress_ok = 0
    for i in range(TRACKS):
        time.sleep(LISTEN_S)
        m = media(serial)
        result["titles"].append(m["title"])
        ok = m["pos"] > 1500 or m["state"] in ("PLAYING", "BUFFERING")
        if ok:
            progress_ok += 1
        result["checks"].append(
            {
                "name": f"track{i+1}",
                "ok": ok,
                "detail": f"pos={m['pos']} state={m['state']} title={m['title'][:36]}",
            }
        )
        log(f"[{name}] track{i+1} {'PASS' if ok else 'FAIL'} pos={m['pos']} {m['title'][:36]!r}")
        if i < TRACKS - 1:
            sh(serial, "shell", "cmd", "media_session", "dispatch", "next")
            time.sleep(2.2)

    result["ok"] = home and progress_ok >= max(1, TRACKS - 1)
    log(f"[{name}] DONE ok={result['ok']} progress={progress_ok}/{TRACKS}")
    return result


def main() -> int:
    log(f"API={API} OUT={OUT}")
    token, refresh, email = api_login()
    log(f"api login ok token_len={len(token)} email={email}")
    report = {"ok": True, "api": API, "devices": []}
    for name, serial in DEVICES:
        r = smoke_one(name, serial, token, refresh, email)
        report["devices"].append(r)
        if not r["ok"]:
            report["ok"] = False
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"GLOBAL ok={report['ok']} → {OUT / 'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
