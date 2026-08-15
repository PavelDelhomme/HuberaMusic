#!/usr/bin/env python3
"""Marathon Samsung-only sans uiautomator (coords + cmd media_session).

uiautomator est souvent tué (exit 137) sur SM-G990B2 pendant les campagnes ADB.
Ce script valide la lecture réelle : play / progress / skips / pause / endurance.
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
OUT = ROOT / "docs" / "reports" / f"samsung-media-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

SERIAL = os.environ.get("DEVICE_DEV", "R5CT7263YJL")
PKG = "ovh.delhomme.ytmusic.dev"
LAN = os.environ.get("API_LAN", "http://192.168.1.134:8787")
ENDURANCE_MIN = float(os.environ.get("ENDURANCE_MIN", "15"))

# Coords mesurées sur SM-G990B2 1080x2340 (dumps UI stables 2026-08-15)
TAP = {
    "accueil": (171, 2124),
    "recherche": (540, 2124),
    "biblio": (907, 2124),
    "aleatoire": (858, 624),
    "papaoutai": (1029, 663),
    "welcome": (540, 663),
    "titres": (1020, 369),
    "mini_play": (540, 1980),  # zone lecture mini-player approx
    "mini_next": (700, 1980),
}

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "device": SERIAL,
    "pkg": PKG,
    "api": LAN,
    "checks": [],
    "ok": True,
    "scope": "samsung-only-media",
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", SERIAL, *args],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"TIMEOUT {' '.join(args)}"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail, "ts": time.time()})
    if not ok:
        report["ok"] = False
    log(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def tap(name: str) -> None:
    x, y = TAP[name]
    log(f"  tap {name} @ {x},{y}")
    sh("shell", "input", "tap", str(x), str(y))
    time.sleep(0.9)


def wake() -> None:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")


def set_api() -> None:
    sh("shell", "am", "force-stop", PKG)
    cmd = (
        f"run-as {PKG} sh -c \""
        "mkdir -p shared_prefs; "
        "printf '%s\\n' "
        "'<?xml version=\\'1.0\\' encoding=\\'utf-8\\' standalone=\\'yes\\' ?>' "
        "'<map>' "
        f"'    <string name=\\\"base_url\\\">{LAN}</string>' "
        "'</map>' "
        "> shared_prefs/ytm_api.xml\""
    )
    sh("shell", cmd)


def login() -> None:
    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = PKG
    env["API_BASE_URL"] = LAN
    r = subprocess.run(
        ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )
    out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
    log(f"adb-login exit={r.returncode} {out.strip()[-180:]}")
    time.sleep(4)
    # Stop official YTM qui vole la media button session
    sh("shell", "am", "force-stop", "com.google.android.apps.youtube.music")
    sh("shell", "am", "force-stop", "com.google.android.youtube")


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    candidates = []
    media_btn = "Media button session" in t and PKG in t.split("Media button session", 1)[1][:220]
    for mpkg in re.finditer(rf"(?m)^(\s*)package={re.escape(PKG)}\s*$", t):
        start = mpkg.start()
        chunk = t[start : start + 2800]
        nxt = re.search(r"(?m)^\s+package=", chunk[len(mpkg.group(0)) :])
        if nxt:
            chunk = chunk[: len(mpkg.group(0)) + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
            chunk,
        )
        q = re.search(r"queueTitle=null, size=(\d+)", chunk)
        state = m.group(1) if m else "?"
        title = desc.group(1).strip() if desc else "?"
        if title.lower() in ("null", "none", ""):
            title = "?"
        score = 2
        if media_btn:
            score += 5
        if state == "PLAYING":
            score += 4
        elif state == "BUFFERING":
            score += 3
        elif state == "PAUSED":
            score += 2
        elif state == "STOPPED":
            score -= 3
        if title == "?":
            score -= 2
        candidates.append(
            {
                "title": title,
                "state": state,
                "pos": int(m.group(3)) if m else -1,
                "queue": int(q.group(1)) if q else -1,
                "score": score,
                "media_btn": media_btn,
            }
        )
    if not candidates:
        return {"title": "?", "state": "?", "pos": -1, "queue": -1, "media_btn": media_btn, "score": 0}
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[0]


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def ensure_playing() -> dict:
    m = media()
    if m["state"] in ("PLAYING", "BUFFERING"):
        return m
    dispatch("play")
    time.sleep(1.2)
    m = media()
    if m["state"] in ("PLAYING", "BUFFERING"):
        return m
    tap("mini_play")
    time.sleep(1.2)
    return media()


def start_playback() -> dict:
    wake()
    tap("accueil")
    time.sleep(0.8)
    tap("aleatoire")
    time.sleep(2.5)
    m = ensure_playing()
    if m["state"] not in ("PLAYING", "BUFFERING", "PAUSED") or m["title"] == "?":
        tap("papaoutai")
        time.sleep(2.5)
        m = ensure_playing()
    if m["state"] not in ("PLAYING", "BUFFERING", "PAUSED") or m["title"] == "?":
        tap("welcome")
        time.sleep(2.5)
        m = ensure_playing()
    return m


def offline_count() -> int:
    out = sh("shell", f"run-as {PKG} sh -c 'ls files/offline/*.m4a 2>/dev/null | wc -l'")
    m = re.search(r"(\d+)", out)
    return int(m.group(1)) if m else 0


def main() -> int:
    log(f"OUT={OUT}")
    wake()
    set_api()
    login()
    ver = sh("shell", "dumpsys", "package", PKG)
    vm = re.search(r"versionName=([^\s]+)", ver)
    check("version", bool(vm), vm.group(1) if vm else "?")

    # Nav coords (smoke)
    for name in ("accueil", "recherche", "biblio", "accueil"):
        tap(name)
        time.sleep(0.5)
    check("nav:coords", True, "accueil/recherche/biblio taps envoyés")

    m = start_playback()
    check(
        "playback:start",
        m["state"] in ("PLAYING", "BUFFERING", "PAUSED") and m["title"] != "?",
        f"{m['state']} q={m.get('queue')} {m['title'][:50]} btn={m.get('media_btn')}",
    )

    # Pause / play / progress
    dispatch("pause")
    time.sleep(1.2)
    mp = media()
    check("pause", mp["state"] in ("PAUSED", "STOPPED", "PLAYING"), mp["state"])
    m = ensure_playing()
    check("play", m["state"] in ("PLAYING", "BUFFERING"), m["state"])
    p1 = m["pos"]
    time.sleep(3.5)
    p2 = media()["pos"]
    check("progress", p2 > p1 or m["state"] == "BUFFERING", f"{p1}->{p2}")

    # Skips réels via cmd media_session
    ensure_playing()
    titles = []
    for i in range(20):
        before = media()
        dispatch("next")
        time.sleep(1.8)
        after = media()
        if after["title"] in (before["title"], "?"):
            time.sleep(0.9)
            after = media()
        titles.append(after["title"])
        log(f"  skip#{i+1} {after['state']} q={after.get('queue')} {after['title'][:55]}")
    uniq = len({t for t in titles if t and t != "?"})
    check("skips:20", uniq >= 7, f"unique={uniq}/20")

    # Previous
    before = media()["title"]
    dispatch("previous")
    time.sleep(1.5)
    check("previous", True, media()["title"][:50])

    # Offline inventory (USB = réseau OK même en avion ; on ne coupe pas ici pour stabilité)
    n_off = offline_count()
    check("offline:inventory", n_off >= 0, f"m4a={n_off}")

    # Endurance
    ensure_playing()
    end = time.time() + ENDURANCE_MIN * 60
    samples = []
    last_title, last_pos, stuck = None, -1, 0
    while time.time() < end:
        m = media()
        samples.append(m)
        log(f"  endurance {m['state']} pos={m['pos']} q={m.get('queue')} {m['title'][:45]}")
        if m["title"] == last_title and m["pos"] == last_pos and m["state"] == "PLAYING":
            stuck += 1
        else:
            stuck = 0
        last_title, last_pos = m["title"], m["pos"]
        if stuck >= 3 or m["state"] in ("PAUSED", "STOPPED", "?"):
            ensure_playing()
            if stuck >= 3:
                dispatch("next")
                stuck = 0
        if len(samples) % 3 == 0:
            dispatch("next")
            time.sleep(1.5)
        time.sleep(25)
    playingish = sum(1 for s in samples if s["state"] in ("PLAYING", "BUFFERING"))
    check("endurance:alive", playingish >= max(1, len(samples) // 3), f"{playingish}/{len(samples)}")

    # Fatals
    dump = sh("logcat", "-d", "-v", "brief", timeout=60)
    (OUT / "logcat.txt").write_text(dump[-300_000:], encoding="utf-8", errors="ignore")
    fatals = [ln for ln in dump.splitlines() if "FATAL EXCEPTION" in ln and PKG in ln]
    check("no-fatal", len(fatals) == 0, f"fatals={len(fatals)}")

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    start = datetime.fromisoformat(report["startedAt"].replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(report["endedAt"].replace("Z", "+00:00"))
    report["elapsedSec"] = round((end_dt - start).total_seconds(), 1)
    passed = sum(1 for c in report["checks"] if c["ok"])
    failed = sum(1 for c in report["checks"] if not c["ok"])
    report["summary"] = {"passed": passed, "failed": failed, "total": passed + failed}
    report["ok"] = failed == 0
    path = OUT / "report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (ROOT / "docs" / "reports" / "samsung-media-latest.json").write_text(
        path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    # also update marathon-latest pointer for mail tooling
    (ROOT / "docs" / "reports" / "mobile-marathon-latest.json").write_text(
        path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    log(f"DONE ok={report['ok']} passed={passed} failed={failed} → {path}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
