#!/usr/bin/env python3
"""Smoke test AVD — lecture, skip, prefetch, pas de null."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = "ovh.delhomme.ytmusic"
APK = ROOT / "mobile-android/app/build/outputs/apk/prod/debug/app-prod-debug.apk"
SERIAL = os.environ.get("DEVICE") or subprocess.run(
    ["adb", "devices"], capture_output=True, text=True
).stdout.split("\n")[1].split("\t")[0]
OUT = ROOT / "docs" / "reports" / f"avd-smoke-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)


def sh(*args: str, timeout: int = 60) -> str:
    r = subprocess.run(["adb", "-s", SERIAL, *args], capture_output=True, timeout=timeout)
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""), flush=True)
    report["checks"].append({"name": name, "ok": ok, "detail": detail})
    if not ok:
        report["ok"] = False


report: dict = {"ok": True, "device": SERIAL, "checks": []}


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "raw_title": ""}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3000]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
            chunk,
        )
        raw = desc.group(1).strip() if desc else ""
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        state = m.group(1) if m else "?"
        pos = int(m.group(3)) if m else -1
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        cand = {"title": title, "state": state, "pos": pos, "raw_title": raw, "score": score}
        if cand["score"] >= best.get("score", -1):
            best = cand
    return best


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def wait_playing(timeout_s: float = 45) -> dict:
    deadline = time.time() + timeout_s
    last = media()
    while time.time() < deadline:
        last = media()
        if last["state"] in ("PLAYING", "BUFFERING", "PAUSED") and last["title"] != "?":
            return last
        dispatch("play")
        time.sleep(2)
    return last


def dump_ui(tag: str) -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui.xml", timeout=30)
    return sh("shell", "cat", "/sdcard/ui.xml", timeout=15)


def tap_text(xml: str, label: str) -> bool:
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml
    ):
        if label in m.group(1):
            x = (int(m.group(2)) + int(m.group(4))) // 2
            y = (int(m.group(3)) + int(m.group(5))) // 2
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def main() -> int:
    print(f"AVD smoke serial={SERIAL} OUT={OUT}")
    if not APK.is_file():
        check("apk:exists", False, str(APK))
        return 1
    sh("shell", "pm", "clear", PKG, timeout=30)
    out = sh("install", "-r", str(APK), timeout=120)
    sh("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS")
    check("install", "Success" in out, out.strip()[-80:])

    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = PKG
    env["API_BASE_URL"] = "https://ytmusic.delhomme.ovh"
    r = subprocess.run(
        ["bash", str(ROOT / "scripts/adb/adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )
    check("login", r.returncode == 0, (r.stdout or b"").decode()[-120:])
    sh("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS")

    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "logcat", "-c")
    time.sleep(3)

    xml = dump_ui("home")
    tap_text(xml, "Accueil")
    time.sleep(1.5)
    xml = dump_ui("accueil")
    if tap_text(xml, "Allow") or tap_text(xml, "Autoriser"):
        time.sleep(0.5)
        xml = dump_ui("post-allow")
    if not tap_text(xml, "Aléatoire"):
        sh("shell", "input", "tap", "864", "610")
    m = wait_playing(50)
    check(
        "play:start",
        m["state"] in ("PLAYING", "BUFFERING") and "null" not in m["title"].lower(),
        f"{m['state']} {m['title'][:40]}",
    )

    # Skip x3
    for i in range(3):
        sh("shell", "cmd", "media_session", "dispatch", "skip-to-next")
        time.sleep(2.5)
        m = media()
        check(
            f"skip:{i+1}",
            m["state"] in ("PLAYING", "BUFFERING", "PAUSED") and "null" not in m["title"].lower(),
            f"{m['state']} {m['title'][:36]}",
        )

    lc = sh("logcat", "-d", "-t", "200", timeout=25)
    prefetch = sum(1 for ln in lc.splitlines() if "prefetch" in ln.lower() or "warm" in ln.lower())
    errors = [ln for ln in lc.splitlines() if "FATAL" in ln or "onPlayerError" in ln]
    check("log:no-fatal", len(errors) == 0, errors[-1][-80:] if errors else f"warm/prefetch lines≈{prefetch}")
    check("log:no-null-ui", "null" not in dump_ui("final").lower())

    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Report: {OUT / 'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
