#!/usr/bin/env python3
"""Marathon EOS : chaque titre joue jusqu'à la fin naturelle (pas de seek, pas de chaos).

Détecte :
- skip prématuré (changement de titre avant ~88 % durée Exo)
- rebouclage coda (même titre, position recule)
- retour arrière vers un titre déjà joué

Usage:
  DEVICE=192.168.1.184:5555 TRACKS=30 NO_CHAOS=1 python3 -u scripts/android/eos-full-marathon.py
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
SERIAL = os.environ.get("DEVICE", "192.168.1.184:5555")
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
TARGET = int(os.environ.get("TRACKS", "30"))
MIN_RATIO = float(os.environ.get("MIN_EOS_RATIO", "0.85"))
OUT = ROOT / "docs" / "reports" / f"eos-full-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

report: dict = {
    "ok": True,
    "checks": [],
    "transitions": [],
    "earlySkips": [],
    "backwardJumps": [],
    "loops": [],
    "playedTitles": [],
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 45) -> str:
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


def dispatch(a: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", a)


def login() -> None:
    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = PKG
    env["API_BASE_URL"] = (
        "https://ytmusic.delhomme.ovh"
        if not PKG.endswith(".dev")
        else os.environ.get("API_LAN", "http://192.168.1.134:8787")
    )
    subprocess.run(
        ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )


def start_playback() -> dict:
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
    time.sleep(2)
    mute()
    return media()


def title_key(title: str) -> str:
    return title.strip()[:60].lower()


def main() -> int:
    log(f"OUT={OUT} device={SERIAL} pkg={PKG} target={TARGET} min_ratio={MIN_RATIO}")
    log("Mode: lecture complète — PAS de seek, PAS de chaos réseau")
    sh("shell", "svc", "wifi", "enable")
    sh("shell", "svc", "data", "enable")
    mute()
    sh("shell", "logcat", "-c")
    cur = start_playback()
    check(
        "start",
        cur["state"] in ("PLAYING", "BUFFERING") and cur["title"] != "?",
        f"{cur['state']} {cur['title'][:45]}",
    )

    last_title = cur["title"]
    peak_pos = cur["pos"]
    track_dur = duration_ms()
    trans = 0
    loops = 0
    seen_keys: list[str] = []
    if last_title != "?":
        seen_keys.append(title_key(last_title))

    t_end = time.time() + int(os.environ.get("MAX_MIN", "240")) * 60
    stall_ticks = 0
    last_pos = cur["pos"]

    while trans < TARGET and time.time() < t_end:
        time.sleep(6)
        mute()
        cur = media()
        if cur["title"] == "?":
            stall_ticks += 1
            if stall_ticks >= 8:
                dispatch("play")
                stall_ticks = 0
            continue
        stall_ticks = 0

        if cur["title"] == last_title:
            if cur["pos"] > peak_pos:
                peak_pos = cur["pos"]
            if track_dur < 0 and peak_pos > 30_000:
                track_dur = duration_ms()
            # boucle coda
            if peak_pos >= 45_000 and cur["pos"] >= 20_000 and (peak_pos - cur["pos"]) >= 8_000:
                loops += 1
                report["loops"].append(
                    {"title": cur["title"], "peak": peak_pos, "pos": cur["pos"]}
                )
                log(f"  LOOP-CODA peak={peak_pos} → {cur['pos']} {cur['title'][:40]}")
                peak_pos = cur["pos"]
            if cur["state"] in ("PAUSED", "STOPPED"):
                dispatch("play")
        elif last_title != "?":
            # Transition EOS
            dur = track_dur if track_dur > 0 else peak_pos
            ratio = (peak_pos / dur) if dur > 0 else 0.0
            tk = title_key(cur["title"])
            backward = tk in seen_keys[:-1] if len(seen_keys) > 1 else False
            entry = {
                "from": last_title[:55],
                "to": cur["title"][:55],
                "peakMs": peak_pos,
                "durMs": dur,
                "ratio": round(ratio, 3),
                "backward": backward,
            }
            report["transitions"].append(entry)
            trans += 1
            log(
                f"  EOS #{trans} {last_title[:32]} @{peak_pos}ms "
                f"({ratio * 100:.0f}% dur={dur}) → {cur['title'][:32]}"
                + (" BACKWARD!" if backward else "")
            )
            if dur >= 45_000 and ratio < MIN_RATIO:
                report["earlySkips"].append(entry)
                log(f"  EARLY-SKIP ratio={ratio:.2f} < {MIN_RATIO}")
            if backward:
                report["backwardJumps"].append(entry)
            if cur["title"] != "?":
                seen_keys.append(tk)
                report["playedTitles"].append(cur["title"][:55])
            last_title = cur["title"]
            peak_pos = cur["pos"]
            track_dur = duration_ms()
            if cur["state"] in ("PAUSED", "STOPPED", "NONE"):
                dispatch("play")
        else:
            last_title = cur["title"]
            peak_pos = cur["pos"]
            track_dur = duration_ms()

        if cur["pos"] == last_pos and cur["state"] == "PLAYING":
            pass
        last_pos = cur["pos"]

        if trans > 0 and trans % 5 == 0:
            log(f"  … progress {trans}/{TARGET} early={len(report['earlySkips'])} back={len(report['backwardJumps'])}")

    check("eos-transitions", trans >= min(5, TARGET), f"n={trans} target={TARGET}")
    check("no-early-skip", len(report["earlySkips"]) == 0, str(report["earlySkips"][:5]))
    check("no-backward-jump", len(report["backwardJumps"]) == 0, str(report["backwardJumps"][:5]))
    check("no-coda-loop", loops == 0, f"loops={loops}")

    raw = sh("shell", f"run-as {PKG} sh -c 'tail -n 200 files/ytm-logs/app.log'", timeout=25)
    (OUT / "app.log.txt").write_text(raw, encoding="utf-8", errors="ignore")
    today = datetime.now().strftime("%Y-%m-%d")
    early_logs = [ln for ln in raw.splitlines() if today in ln and "fin trop tôt" in ln]
    check("logs:fin-trop-tôt", len(early_logs) == 0, f"n={len(early_logs)}")

    dispatch("pause")
    mute()
    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log(
        f"DONE ok={report['ok']} trans={trans} early={len(report['earlySkips'])} "
        f"back={len(report['backwardJumps'])} loops={loops}"
    )
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
