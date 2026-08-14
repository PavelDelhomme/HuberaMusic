#!/usr/bin/env python3
"""Endurance prod mobile ~1h : lecture autoplay, coupures réseau (proxy), Maps BG, métriques.

Usage:
  DEVICE=192.168.1.44:5555 DURATION_MIN=60 python3 scripts/android/prod-endurance-1h.py
"""
from __future__ import annotations

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
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "logs" / "endurance" / datetime.now().strftime("%Y%m%d-%H%M%S")
OUT.mkdir(parents=True, exist_ok=True)
REPORT = OUT / "report.json"
LOG = OUT / "live.log"


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


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    i = t.find(PKG)
    c = t[i : i + 2800] if i >= 0 else ""
    desc = re.search(r"description=([^\n]+)", c)
    m = re.search(
        r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+).*?buffered position=(-?\d+)",
        c,
    )
    q = re.search(r"queueTitle=null, size=(\d+)", c)
    return {
        "title": desc.group(1).strip() if desc else "?",
        "state": m.group(1) if m else "?",
        "pos": int(m.group(3)) if m else -1,
        "buf": int(m.group(4)) if m else -1,
        "queue": int(q.group(1)) if q else -1,
    }


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


def cpu_top() -> str | None:
    t = sh("shell", "top", "-n", "1", "-b", "-q")
    for line in t.splitlines():
        if PKG in line or "ytmusic" in line.lower():
            return line.strip()
    # fallback pidstat-ish
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
    # Trajet simulé — Maps au premier plan puis home pour laisser musique en BG
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
    sh("shell", "input", "keyevent", "3")  # HOME
    log("MAPS: HOME (musique doit rester en BG)")


def ensure_playing() -> None:
    s = session()
    if s["state"] != "PLAYING":
        sh("shell", "cmd", "media_session", "dispatch", "play")
        time.sleep(2)


def main() -> None:
    log(f"START device={DEV} pkg={PKG} duration={DURATION_MIN}m out={OUT}")
    sh("logcat", "-c")
    ensure_playing()
    open_maps_nav()
    ensure_playing()

    t0 = time.time()
    end = t0 + DURATION_MIN * 60
    samples = []
    titles = []
    transitions = 0
    last_title = session()["title"]
    titles.append({"t": 0, "title": last_title})
    network_events = []
    stuck_events = []

    # Coupures planifiées : ~12 min, ~28 min, ~45 min — pendant un titre déjà bufferisé
    cut_at = [t0 + 12 * 60, t0 + 28 * 60, t0 + 45 * 60]
    cut_i = 0
    in_cut = False
    cut_until = 0.0

    while time.time() < end:
        now = time.time()
        elapsed = now - t0

        # Start cut
        if cut_i < len(cut_at) and now >= cut_at[cut_i] and not in_cut:
            s = session()
            # seulement si déjà un peu de buffer
            if s["state"] == "PLAYING" and s["buf"] > s["pos"] + 15_000:
                set_proxy(True)
                in_cut = True
                cut_until = now + 45  # 45s de « panne »
                network_events.append(
                    {"t": round(elapsed), "event": "cut_start", "title": s["title"], "pos": s["pos"], "buf": s["buf"]}
                )
                cut_i += 1
            else:
                cut_at[cut_i] = now + 30  # retente bientôt

        if in_cut and now >= cut_until:
            set_proxy(False)
            in_cut = False
            time.sleep(3)
            ensure_playing()
            s = session()
            network_events.append(
                {"t": round(elapsed), "event": "cut_end", "title": s["title"], "state": s["state"], "pos": s["pos"]}
            )

        s = session()
        if s["title"] != last_title and s["title"] != "?":
            transitions += 1
            titles.append({"t": round(elapsed), "title": s["title"], "state": s["state"]})
            log(f"TRANS #{transitions} {last_title[:36]} -> {s['title'][:36]} state={s['state']}")
            last_title = s["title"]

        if s["state"] in ("NONE", "STOPPED", "ERROR"):
            stuck_events.append({"t": round(elapsed), **s})
            log(f"STUCK {s}")
            ensure_playing()

        # Relance Maps périodiquement (~20 min) pour stress BG
        if int(elapsed) > 0 and int(elapsed) % (20 * 60) < SAMPLE_SECS:
            open_maps_nav()
            ensure_playing()

        mem = meminfo()
        cpu = cpu_top()
        sample = {
            "t": round(elapsed),
            "session": s,
            "mem": mem,
            "cpu": cpu,
            "inCut": in_cut,
        }
        samples.append(sample)
        log(
            f"t={int(elapsed)}s state={s['state']} pos={s['pos']} q={s['queue']} "
            f"pss={mem.get('totalPssKb')} cpu={cpu[:60] if cpu else '-'}"
        )

        # Accélère un peu les transitions en FF léger toutes les ~4 min (sans spoiler le vrai autoplay)
        if int(elapsed) > 0 and int(elapsed) % 240 < SAMPLE_SECS and not in_cut:
            for _ in range(8):
                sh("shell", "cmd", "media_session", "dispatch", "fast-forward")
                time.sleep(0.15)

        time.sleep(SAMPLE_SECS)

    set_proxy(False)
    logcat = sh("logcat", "-d")
    (OUT / "logcat.txt").write_text(logcat[-500_000:], encoding="utf-8", errors="ignore")
    exo_errs = len(re.findall(r"PlaybackException|Source error|ExoPlaybackException", logcat))
    state_ended = len(re.findall(r"STATE_ENDED", logcat))
    fatals = [ln for ln in logcat.splitlines() if "FATAL EXCEPTION" in ln and PKG in ln]

    batt = batterystats_uid()
    summary = {
        "device": DEV,
        "pkg": PKG,
        "startedAt": datetime.fromtimestamp(t0, tz=timezone.utc).isoformat(),
        "durationMin": DURATION_MIN,
        "elapsedSec": round(time.time() - t0),
        "transitions": transitions,
        "titles": titles,
        "networkEvents": network_events,
        "stuckEvents": stuck_events,
        "exoErrors": exo_errs,
        "stateEndedLogs": state_ended,
        "fatals": fatals[:10],
        "battery": batt,
        "memPeakPssKb": max((s["mem"].get("totalPssKb") or 0) for s in samples) if samples else None,
        "memAvgPssKb": (
            int(sum(s["mem"].get("totalPssKb") or 0 for s in samples) / max(1, len(samples)))
            if samples
            else None
        ),
        "samples": samples,
        "final": session(),
        "ok": exo_errs == 0 and len(fatals) == 0 and transitions >= 1,
    }
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"DONE ok={summary['ok']} transitions={transitions} exo_errs={exo_errs} report={REPORT}")


if __name__ == "__main__":
    main()
