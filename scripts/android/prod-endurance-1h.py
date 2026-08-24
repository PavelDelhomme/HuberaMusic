#!/usr/bin/env python3
"""Endurance prod mobile ~1h : lecture autoplay, coupures réseau (proxy), Maps BG, métriques.

Usage:
  DEVICE=192.168.1.44:5555 DURATION_MIN=60 python3 scripts/android/prod-endurance-1h.py
"""
from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

DEV = os.environ.get("DEVICE") or os.environ.get("ANDROID_SERIAL") or "192.168.1.44:5555"
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
DURATION_MIN = float(os.environ.get("DURATION_MIN", "60"))
SAMPLE_SECS = float(os.environ.get("SAMPLE_SECS", "30"))
STUCK_SECS = float(os.environ.get("STUCK_SECS", "45"))
ROOT = Path(__file__).resolve().parents[2]
_dev_slug = re.sub(r"[^a-zA-Z0-9]+", "_", DEV)[:32]
OUT = ROOT / "logs" / "endurance" / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{_dev_slug}"
OUT.mkdir(parents=True, exist_ok=True)
REPORT = OUT / "report.json"
LOG = OUT / "live.log"
BATTERY_CSV = OUT / "battery.csv"

# Coords mini-player play (1080p) — surcharge via PLAY_TAP=x,y
_DEFAULT_TAPS = [
    (540, 1980),
    (540, 2000),
    (540, 2050),
    (900, 1980),
]
if os.environ.get("PLAY_TAP"):
    _x, _y = os.environ["PLAY_TAP"].split(",", 1)
    PLAY_TAPS = [(int(_x), int(_y))]
else:
    PLAY_TAPS = _DEFAULT_TAPS


def sh(*args: str, check: bool = False, timeout: int = 60) -> str:
    r = subprocess.run(
        ["adb", "-s", DEV, *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    out = (r.stdout or "") + (r.stderr or "")
    if check and r.returncode != 0:
        raise RuntimeError(out or f"adb exit {r.returncode}")
    return out


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def wake() -> None:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")


def tap_xy(x: int, y: int) -> None:
    sh("shell", "input", "tap", str(x), str(y))
    time.sleep(0.9)


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    media_btn = "Media button session" in t and PKG in t.split("Media button session", 1)[1][:260]
    best = {"title": "?", "state": "?", "pos": -1, "buf": -1, "queue": -1, "score": -1}
    state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}

    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3000]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+).*?(?:buffered position=(-?\d+))?",
            chunk,
        )
        q = re.search(r"queueTitle=null, size=(\d+)", chunk)
        raw = (desc.group(1).strip() if desc else "")
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        if m:
            named = (m.group(1) or "").upper()
            code = int(m.group(2))
            state = named if named else state_map.get(code, str(code))
            pos = int(m.group(3))
            buf = int(m.group(4)) if m.group(4) else -1
        else:
            state, pos, buf = "?", -1, -1
        score = 0
        if media_btn:
            score += 5
        if title != "?":
            score += 2
        if state == "PLAYING":
            score += 6
        elif state == "BUFFERING":
            score += 4
        elif state == "PAUSED":
            score += 2
        elif state == "ERROR" and pos > 1500:
            score += 3
        elif state == "STOPPED":
            score -= 3
        if pos > 500:
            score += 1
        cand = {
            "title": title,
            "state": state,
            "pos": pos,
            "buf": buf,
            "queue": int(q.group(1)) if q else -1,
            "score": score,
        }
        if cand["score"] > best["score"]:
            best = cand
    return best


def dispatch(action: str) -> None:
    out = sh("shell", "cmd", "media_session", "dispatch", action)
    if "inaccessible" in out or "not found" in out:
        sh("shell", "media_session", "dispatch", action)


def is_active(s: dict, prev_pos: int = -1) -> bool:
    if s["state"] in ("PLAYING", "BUFFERING"):
        return True
    if s["pos"] > 1500:
        return True
    if prev_pos >= 0 and s["pos"] > prev_pos + 800:
        return True
    return False


def tap_play_ui() -> None:
    wake()
    for x, y in PLAY_TAPS:
        log(f"  tap play @ {x},{y}")
        tap_xy(x, y)
        time.sleep(1.2)
        s = session()
        if is_active(s):
            return
    sh("shell", "input", "keyevent", "85")  # MEDIA_PLAY
    time.sleep(1.0)
    sh("shell", "input", "keyevent", "126")  # MEDIA_PLAY_PAUSE
    time.sleep(1.0)


def recover_stuck(prev_pos: int) -> None:
    """Relance lecture : media_session → tap UI → next si BUFFERING figé."""
    s = session()
    log(f"RECOVER stuck state={s['state']} pos={s['pos']}")
    for _ in range(3):
        dispatch("play")
        time.sleep(1.5)
        s = session()
        if is_active(s, prev_pos):
            return
    tap_play_ui()
    s = session()
    if is_active(s, prev_pos):
        return
    if s["state"] == "BUFFERING" and s["pos"] == prev_pos and prev_pos > 0:
        dispatch("next")
        time.sleep(2.5)
        tap_play_ui()
        return
    if s["state"] in ("STOPPED", "NONE", "?"):
        sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(2)
        tap_play_ui()


def ensure_playing(prev_pos: int = -1) -> dict:
    s = session()
    if is_active(s, prev_pos):
        return s
    for _ in range(4):
        dispatch("play")
        time.sleep(1.5)
        s = session()
        if is_active(s, prev_pos):
            return s
    tap_play_ui()
    s = session()
    if not is_active(s, prev_pos):
        recover_stuck(prev_pos)
    return session()


def bootstrap_playback() -> None:
    """Réveille PLM et lance la lecture."""
    wake()
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.8)
    sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2.5)
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")
    sh("shell", "am", "force-stop", "com.google.android.apps.youtube.music")
    for _ in range(3):
        s = ensure_playing()
        if is_active(s):
            log(f"PLAY OK state={s['state']} pos={s['pos']} title={s['title'][:48]}")
            return
    s = session()
    log(f"PLAY weak state={s}")


def meminfo() -> dict:
    t = sh("shell", "dumpsys", "meminfo", PKG)

    def n(pat: str) -> int | None:
        m = re.search(pat, t)
        return int(m.group(1).replace(",", "")) if m else None

    return {
        "totalPssKb": n(r"TOTAL PSS:\s+([\d,]+)"),
        "nativeHeapKb": n(r"Native Heap:\s+([\d,]+)"),
        "javaHeapKb": n(r"Java Heap:\s+([\d,]+)"),
        "graphicsKb": n(r"Graphics:\s+([\d,]+)"),
    }


def battery_level() -> int | None:
    t = sh("shell", "dumpsys", "battery")
    m = re.search(r"level:\s*(\d+)", t)
    return int(m.group(1)) if m else None


def cpu_top() -> str | None:
    t = sh("shell", "top", "-n", "1", "-b", "-q")
    for line in t.splitlines():
        if PKG in line or "ytmusic" in line.lower():
            return line.strip()
    t2 = sh("shell", "dumpsys", "cpuinfo")
    for line in t2.splitlines():
        if PKG in line:
            return line.strip()
    return None


def batterystats_uid() -> dict:
    t = sh("shell", "dumpsys", "batterystats", PKG)
    out: dict = {"rawTail": "\n".join(t.splitlines()[-40:])}
    m = re.search(r"Uid u0a\d+:\s+([\d.]+)\s*\(([^)]+)\)", t)
    if m:
        out["uidPowerMah"] = m.group(1)
        out["uidDetail"] = m.group(2)
    m2 = re.search(r"Cpu:\s*([\d.]+)mAh", t)
    if m2:
        out["cpuMah"] = m2.group(1)
    return out


def set_proxy(on: bool) -> None:
    if on:
        sh("shell", "settings", "put", "global", "http_proxy", "127.0.0.1:9")
        log("RESEAU: proxy cassé (simule coupure HTTP)")
    else:
        sh("shell", "settings", "put", "global", "http_proxy", ":0")
        sh("shell", "settings", "delete", "global", "http_proxy")
        log("RESEAU: proxy rétabli")


def open_maps_nav() -> None:
    if os.environ.get("MAPS_STRESS", "1").strip() in ("0", "false", "no"):
        return
    sh(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "google.navigation:q=Tour+Eiffel,+Paris&mode=d",
    )
    log("MAPS: navigation démarrée")
    time.sleep(8)
    sh("shell", "input", "keyevent", "3")
    log("MAPS: HOME (musique doit rester en BG)")


def main() -> None:
    log(f"START device={DEV} pkg={PKG} duration={DURATION_MIN}m out={OUT}")
    sh("logcat", "-c")
    bootstrap_playback()
    open_maps_nav()
    s0 = ensure_playing()
    last_pos = s0["pos"]
    last_pos_change = time.time()

    t0 = time.time()
    end = t0 + DURATION_MIN * 60
    samples = []
    titles = []
    transitions = 0
    last_title = s0["title"]
    titles.append({"t": 0, "title": last_title, "state": s0["state"]})
    network_events = []
    stuck_events = []
    battery_rows = []

    cut_at = [t0 + 12 * 60, t0 + 28 * 60, t0 + 45 * 60]
    cut_i = 0
    in_cut = False
    cut_until = 0.0

    with BATTERY_CSV.open("w", newline="", encoding="utf-8") as bf:
        bw = csv.writer(bf)
        bw.writerow(["t_sec", "level_pct", "state", "pos", "pss_kb"])

        while time.time() < end:
            now = time.time()
            elapsed = now - t0

            if cut_i < len(cut_at) and now >= cut_at[cut_i] and not in_cut:
                s = session()
                if s["state"] == "PLAYING" and s["buf"] > s["pos"] + 15_000:
                    set_proxy(True)
                    in_cut = True
                    cut_until = now + 45
                    network_events.append(
                        {"t": round(elapsed), "event": "cut_start", "title": s["title"], "pos": s["pos"], "buf": s["buf"]}
                    )
                    cut_i += 1
                else:
                    cut_at[cut_i] = now + 30

            if in_cut and now >= cut_until:
                set_proxy(False)
                in_cut = False
                time.sleep(3)
                ensure_playing(last_pos)
                s = session()
                network_events.append(
                    {"t": round(elapsed), "event": "cut_end", "title": s["title"], "state": s["state"], "pos": s["pos"]}
                )

            s = session()
            if s["pos"] > last_pos + 500:
                last_pos = s["pos"]
                last_pos_change = now

            if s["title"] != last_title and s["title"] != "?":
                transitions += 1
                titles.append({"t": round(elapsed), "title": s["title"], "state": s["state"]})
                log(f"TRANS #{transitions} {last_title[:36]} -> {s['title'][:36]} state={s['state']}")
                last_title = s["title"]
                last_pos = s["pos"]
                last_pos_change = now

            stuck = (
                s["state"] in ("NONE", "STOPPED", "PAUSED", "ERROR")
                or (s["state"] == "BUFFERING" and now - last_pos_change > STUCK_SECS)
            )
            if stuck and not is_active(s, last_pos):
                stuck_events.append({"t": round(elapsed), **s})
                log(f"STUCK {s}")
                ensure_playing(last_pos)
                s2 = session()
                if s2["pos"] > last_pos + 500:
                    last_pos = s2["pos"]
                    last_pos_change = time.time()

            if int(elapsed) > 0 and int(elapsed) % (20 * 60) < SAMPLE_SECS:
                open_maps_nav()
                ensure_playing(last_pos)

            mem = meminfo()
            cpu = cpu_top()
            lvl = battery_level()
            sample = {"t": round(elapsed), "session": s, "mem": mem, "cpu": cpu, "batteryLevel": lvl, "inCut": in_cut}
            samples.append(sample)
            bw.writerow([int(elapsed), lvl or "", s["state"], s["pos"], mem.get("totalPssKb") or ""])
            log(
                f"t={int(elapsed)}s state={s['state']} pos={s['pos']} q={s['queue']} "
                f"pss={mem.get('totalPssKb')} bat={lvl}% cpu={cpu[:60] if cpu else '-'}"
            )

            if int(elapsed) > 0 and int(elapsed) % 240 < SAMPLE_SECS and not in_cut:
                for _ in range(8):
                    dispatch("fast-forward")
                    time.sleep(0.15)

            time.sleep(SAMPLE_SECS)

    set_proxy(False)
    logcat = sh("logcat", "-d")
    (OUT / "logcat.txt").write_text(logcat[-500_000:], encoding="utf-8", errors="ignore")
    exo_errs = len(re.findall(r"PlaybackException|Source error|ExoPlaybackException", logcat))
    state_ended = len(re.findall(r"STATE_ENDED", logcat))
    fatals = [ln for ln in logcat.splitlines() if "FATAL EXCEPTION" in ln and PKG in ln]

    batt = batterystats_uid()
    final = session()
    elapsed_total = round(time.time() - t0)
    duration_ok = elapsed_total >= DURATION_MIN * 60 * 0.92
    playing_ok = final["state"] in ("PLAYING", "BUFFERING") or final["pos"] > 1500
    transitions_ok = transitions >= 1
    not_frozen = not (final["state"] == "PAUSED" and transitions == 0)

    summary = {
        "device": DEV,
        "pkg": PKG,
        "startedAt": datetime.fromtimestamp(t0, tz=timezone.utc).isoformat(),
        "durationMin": DURATION_MIN,
        "elapsedSec": elapsed_total,
        "transitions": transitions,
        "titles": titles,
        "networkEvents": network_events,
        "stuckEvents": stuck_events,
        "exoErrors": exo_errs,
        "stateEndedLogs": state_ended,
        "fatals": fatals[:10],
        "battery": batt,
        "batteryCsv": str(BATTERY_CSV),
        "memPeakPssKb": max((s["mem"].get("totalPssKb") or 0) for s in samples) if samples else None,
        "memAvgPssKb": (
            int(sum(s["mem"].get("totalPssKb") or 0 for s in samples) / max(1, len(samples)))
            if samples
            else None
        ),
        "samples": samples,
        "final": final,
        "ok": (
            duration_ok
            and transitions_ok
            and not_frozen
            and playing_ok
            and exo_errs == 0
            and len(fatals) == 0
        ),
    }
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"DONE ok={summary['ok']} transitions={transitions} exo_errs={exo_errs} report={REPORT}")


if __name__ == "__main__":
    main()
