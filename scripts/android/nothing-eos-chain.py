#!/usr/bin/env python3
"""Nothing USB : enchaîner les FINS DE MORCEAU (pas de skip manuel) + chaos réseau.

Détecte la boucle coda : même titre, position qui recule près de la fin.
Usage:
  DEVICE=00145153K001434 PKG=ovh.delhomme.ytmusic python3 -u scripts/android/nothing-eos-chain.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERIAL = os.environ.get("DEVICE", "00145153K001434")
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
TARGET = int(os.environ.get("TRACKS", "6"))
OUT = ROOT / "docs" / "reports" / f"nothing-eos-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

report: dict = {"ok": True, "checks": [], "transitions": [], "loops": []}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(["adb", "-s", SERIAL, *args], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append({"name": name, "ok": ok, "detail": detail})
    if not ok:
        report["ok"] = False
    log(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def mute() -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")


def net_kind() -> str:
    route = sh("shell", "ip", "route", "get", "1.1.1.1")
    if "wlan0" in route:
        return "WIFI"
    if "unreachable" in route.lower():
        return "NONE"
    if "rmnet" in route or "ccmni" in route:
        return "CELLULAR"
    return "?"


def to_wifi() -> None:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "enable")


def to_cell() -> None:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "disable")


def cut_all() -> None:
    sh("shell", "svc", "wifi", "disable")
    sh("shell", "svc", "data", "disable")


def restore() -> None:
    sh("shell", "svc", "wifi", "enable")
    sh("shell", "svc", "data", "enable")


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 2800]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)", chunk)
        raw = (desc.group(1).strip() if desc else "")
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        state = m.group(1) if m else "?"
        pos = int(m.group(3)) if m else -1
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best.get("score", -1):
            best = cand
    return best


def duration_ms() -> int:
    t = sh("shell", "dumpsys", "media_session")
    m = re.search(r"android.media.metadata.DURATION[=, ]+(\d+)", t)
    if m:
        return int(m.group(1))
    m = re.search(r"duration[=:] ?(\d{4,})", t, re.I)
    return int(m.group(1)) if m else -1


def seek_near_end() -> None:
    """Raccourcir l’attente : 8–12 s avant la fin réelle, pour exercer STATE_ENDED."""
    dur = duration_ms()
    if dur < 40_000:
        return
    target = max(dur - 10_000, 20_000)
    sh("shell", "cmd", "media_session", "dispatch", "seek-to", str(target))
    log(f"  seek-near-end → {target}ms / {dur}ms")


def dispatch(a: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", a)


def login() -> None:
    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = PKG
    env["API_BASE_URL"] = (
        "https://ytmusic.delhomme.ovh" if not PKG.endswith(".dev") else os.environ.get("API_LAN", "http://192.168.1.134:8787")
    )
    subprocess.run(
        ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )


def start() -> dict:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    mute()
    login()
    time.sleep(2)
    sh("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = sh("shell", "cat", "/sdcard/ui.xml")
    m = re.search(r'text="Aléatoire"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    if m:
        x1, y1, x2, y2 = map(int, m.groups())
        sh("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    else:
        sh("shell", "input", "tap", "864", "610")
    time.sleep(3)
    dispatch("play")
    time.sleep(1.5)
    mute()
    return media()


def chaos(i: int) -> str:
    """Alterance Wi‑Fi / 4G / coupure courte — USB ADB reste."""
    if os.environ.get("NO_CHAOS") == "1":
        return net_kind()
    if i % 5 == 1:
        to_cell()
        return "CELL"
    if i % 5 == 2:
        to_wifi()
        return "WIFI"
    if i % 5 == 3:
        cut_all()
        time.sleep(6)
        to_cell()
        return "CUT→CELL"
    if i % 5 == 4:
        to_wifi()
        return "WIFI"
    return net_kind()


def main() -> int:
    log(f"OUT={OUT} pkg={PKG}")
    restore()
    mute()
    sh("shell", "logcat", "-c")
    m = start()
    check("start", m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?", f"{m['state']} {m['title'][:40]}")
    last = m
    peak = m["pos"]
    loops = 0
    trans = 0
    sought = False
    t_end = time.time() + int(os.environ.get("MAX_MIN", "18")) * 60
    n = 0
    while trans < TARGET and time.time() < t_end:
        time.sleep(5)
        mute()
        n += 1
        if n % 3 == 0:
            chaos(n // 3)
        cur = media()
        net = net_kind()
        log(f"  {cur['state']} pos={cur['pos']} net={net} {cur['title'][:42]}")
        if cur["title"] == last["title"] and cur["title"] != "?" and not sought and cur["pos"] >= 6_000:
            seek_near_end()
            sought = True
        if cur["title"] == last["title"] and cur["title"] != "?":
            if cur["pos"] > peak:
                peak = cur["pos"]
            # boucle coda : on était loin (>45s) et on recule de >8s sans changer de titre
            if peak >= 45_000 and cur["pos"] >= 20_000 and (peak - cur["pos"]) >= 8_000:
                loops += 1
                report["loops"].append({"title": cur["title"], "peak": peak, "pos": cur["pos"], "net": net})
                log(f"  LOOP-CODA peak={peak} → {cur['pos']} {cur['title'][:36]}")
                peak = cur["pos"]
        elif cur["title"] not in ("?", last["title"]) and last["title"] != "?":
            trans += 1
            report["transitions"].append(
                {"from": last["title"][:50], "to": cur["title"][:50], "fromPos": last["pos"], "peak": peak, "net": net}
            )
            log(f"  EOS #{trans} {last['title'][:28]} @{peak}ms → {cur['title'][:28]} net={net}")
            last = cur
            peak = cur["pos"]
            sought = False
            if cur["state"] in ("PAUSED", "STOPPED"):
                dispatch("play")
        elif cur["state"] in ("PAUSED", "STOPPED") and last["state"] == "PLAYING":
            dispatch("play")
        last_state = cur
        if cur["title"] == last["title"]:
            last = {**last, "pos": cur["pos"], "state": cur["state"]}
        else:
            last = cur

    check("eos-transitions", trans >= min(3, TARGET), f"n={trans} target={TARGET}")
    check("no-coda-loop", loops == 0, f"loops={loops} {report['loops'][:3]}")
    raw = sh("shell", f"run-as {PKG} sh -c 'tail -n 120 files/ytm-logs/app.log'", timeout=20)
    (OUT / "app.log.txt").write_text(raw, encoding="utf-8", errors="ignore")
    today = datetime.now().strftime("%Y-%m-%d")
    coda = [ln for ln in raw.splitlines() if today in ln and "fin trop tôt" in ln]
    ended = [ln for ln in raw.splitlines() if today in ln and "STATE_ENDED" in ln]
    check("logs:fin-trop-tôt-today", True, f"n={len(coda)} ended={len(ended)}")
    dispatch("pause")
    restore()
    mute()
    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} trans={trans} loops={loops}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        try:
            restore()
            mute()
            dispatch("pause")
        except Exception:
            pass
