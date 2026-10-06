#!/usr/bin/env python3
"""Nuit 6→7 oct 2026 — mesh muet Music + Maps/Fuel + smoke suite.

- STREAM_MUSIC=0 (HP + BT), alarmes volume 7
- Nothing hors harnais (YouTube / sommeil) — jamais paul@ injecté
- Overlay -r seulement, pas de down -v, pas de wipe
- Stop 2026-10-07 02:00 Europe/Paris

  python3 -u scripts/qa/nuit-mesh-2026-10-06.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STOP_AT = datetime.strptime(os.environ.get("STOP_AT", "2026-10-07 02:00"), "%Y-%m-%d %H:%M")
OUT = Path(os.environ.get("OUT_DIR", "/tmp/hubera-nuit-2026-10-06"))
OUT.mkdir(parents=True, exist_ok=True)
EVENTS = OUT / "events.jsonl"
SUMMARY = OUT / "summary.json"
LIVE = OUT / "live.log"

# Labo seulement — Nothing hors tests (YouTube / sommeil).
DEVICES = {
    "samsung": os.environ.get("DEVICE_SAMSUNG", "R5CT7263YJL"),
    "blackview": os.environ.get("DEVICE_BLACKVIEW", "EEA9700PRO0014587"),
}
PKG_MUSIC = os.environ.get("PKG_MUSIC", "cloud.hubera.music")
PKG_MAPS = "cloud.hubera.maps"
PKG_FUEL = os.environ.get("PKG_FUEL", "cloud.hubera.fuel")
OTHER = [
    "cloud.hubera.mail",
    "cloud.hubera.drive",
    "cloud.hubera.pass",
    "cloud.hubera.calendar",
    "cloud.hubera.contacts",
    "cloud.hubera.photos",
    "cloud.hubera.admin",
]
BUF_S = float(os.environ.get("BUF_S", "90"))
FROZEN_S = float(os.environ.get("FROZEN_S", "10"))
POLL = float(os.environ.get("POLL", "2.2"))
REMUTE_S = 90
MAPS_EVERY_S = 25 * 60
SMOKE_EVERY_S = 40 * 60
STATE_MAP = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR", 8: "CONNECTING"}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LIVE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def emit(kind: str, **kw) -> None:
    row = {"ts": datetime.now().isoformat(timespec="seconds"), "kind": kind, **kw}
    with EVENTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def sh(serial: str, *args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", serial, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return (r.stdout or "") + (r.stderr or "")
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return f"ERR {e}"


def alive(serial: str) -> bool:
    out = sh(serial, "get-state", timeout=8)
    return "device" in out and "offline" not in out


def mute(serial: str) -> None:
    """Musique à 0 (HP). Alarmes conservées. Pas de DND (casse YouTube / alarmes)."""
    sh(serial, "shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh(serial, "shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh(serial, "shell", "settings", "put", "system", "volume_music_bt_a2dp", "0")
    sh(serial, "shell", "settings", "put", "system", "volume_alarm_speaker", "7")
    sh(serial, "shell", "cmd", "media_session", "volume", "--stream", "4", "--set", "7")


def wake(serial: str) -> None:
    sh(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh(serial, "shell", "wm", "dismiss-keyguard")


def launch_music(serial: str) -> None:
    wake(serial)
    sh(serial, "shell", "monkey", "-p", PKG_MUSIC, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2)
    sh(serial, "shell", "input", "keyevent", "KEYCODE_MEDIA_PLAY")


def parse_session(serial: str) -> dict:
    t = sh(serial, "shell", "dumpsys", "media_session", timeout=20)
    best = {"title": "?", "state": "?", "pos": -1, "code": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG_MUSIC)}\s*$", t):
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
        if m:
            named = (m.group(1) or "").upper()
            code = int(m.group(2))
            state = named if named else STATE_MAP.get(code, str(code))
            pos = int(m.group(3))
            score = 3 if state == "PLAYING" else 2 if state == "BUFFERING" else 1
            if score > (3 if best["state"] == "PLAYING" else 0):
                best = {"title": title, "state": state, "pos": pos, "code": code}
    return best


def skip(serial: str) -> None:
    sh(serial, "shell", "input", "keyevent", "87")  # MEDIA_NEXT


def screenshot(serial: str, name: str) -> None:
    dest = OUT / "shots"
    dest.mkdir(exist_ok=True)
    p = dest / name
    try:
        r = subprocess.run(
            ["adb", "-s", serial, "exec-out", "screencap", "-p"],
            capture_output=True,
            timeout=20,
        )
        if r.stdout[:8] == b"\x89PNG\r\n\x1a\n" or r.stdout.startswith(b"\x89PNG"):
            p.write_bytes(r.stdout)
    except Exception:
        pass


def launch_pkg(serial: str, pkg: str) -> str:
    return sh(
        serial,
        "shell",
        "monkey",
        "-p",
        pkg,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
        timeout=20,
    )


def pkg_installed(serial: str, pkg: str) -> bool:
    return "package:" in sh(serial, "shell", "pm", "path", pkg, timeout=10)


def write_summary(stats: dict, extra: dict) -> None:
    SUMMARY.write_text(
        json.dumps(
            {
                "stop_at": STOP_AT.isoformat(),
                "updated": datetime.now().isoformat(timespec="seconds"),
                "pkg_music": PKG_MUSIC,
                "devices": DEVICES,
                "stats": stats,
                **extra,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> None:
    log(f"START nuit mesh → {STOP_AT} out={OUT}")
    emit("start", stop_at=str(STOP_AT), devices=DEVICES)
    stats = {
        name: {"titles": 0, "skips_buf": 0, "skips_frozen": 0, "skips_err": 0, "playing_s": 0.0, "last": "?"}
        for name in DEVICES
    }
    buf_since = {n: None for n in DEVICES}
    paused_since = {n: None for n in DEVICES}
    frozen = {n: {"title": "", "pos": -1, "since": None} for n in DEVICES}
    seen_title = {n: "" for n in DEVICES}
    last_remute = 0.0
    last_maps = 0.0
    last_smoke = 0.0
    last_hb = 0.0
    maps_runs = 0
    smoke_runs = 0
    notes = []

    for name, serial in DEVICES.items():
        if not alive(serial):
            notes.append(f"{name} ADB mort au départ")
            log(f"WARN {name} offline")
            continue
        mute(serial)
        if not pkg_installed(serial, PKG_MUSIC):
            notes.append(f"{name} pas de {PKG_MUSIC}")
            continue
        launch_music(serial)
        emit("launch_music", device=name)

    t0 = time.time()
    last_maps = t0 - MAPS_EVERY_S + 180  # 1er cycle Maps/Fuel ~3 min
    last_smoke = t0 - SMOKE_EVERY_S + 480  # 1er smoke suite ~8 min
    last_remute = t0

    while datetime.now() < STOP_AT:
        now = time.time()
        if now - last_remute >= REMUTE_S:
            for name, serial in DEVICES.items():
                if alive(serial):
                    mute(serial)
            last_remute = now

        for name, serial in DEVICES.items():
            if not alive(serial):
                emit("adb_dead", device=name)
                continue
            ses = parse_session(serial)
            title, state, pos = ses["title"], ses["state"], ses["pos"]
            if title and title != "?" and title != seen_title[name]:
                seen_title[name] = title
                stats[name]["titles"] += 1
                stats[name]["last"] = title
                buf_since[name] = None
                frozen[name] = {"title": title, "pos": pos, "since": now}
                emit("title", device=name, title=title, state=state, pos=pos)
            if state == "PLAYING":
                stats[name]["playing_s"] += POLL
                buf_since[name] = None
                paused_since[name] = None
                if frozen[name]["title"] == title:
                    if pos <= frozen[name]["pos"] + 400:
                        if frozen[name]["since"] and now - frozen[name]["since"] >= FROZEN_S:
                            stats[name]["skips_frozen"] += 1
                            emit("skip_frozen", device=name, title=title, pos=pos)
                            skip(serial)
                            frozen[name]["since"] = now
                    else:
                        frozen[name] = {"title": title, "pos": pos, "since": now}
            elif state in ("BUFFERING", "CONNECTING") or ses["code"] in (6, 8):
                if buf_since[name] is None:
                    buf_since[name] = now
                elif now - buf_since[name] >= BUF_S and pos < 1500:
                    stats[name]["skips_buf"] += 1
                    emit("skip_buf", device=name, title=title, waited=round(now - buf_since[name], 1), pos=pos)
                    skip(serial)
                    buf_since[name] = now
                elif now - buf_since[name] >= BUF_S and pos >= 1500:
                    buf_since[name] = None
            elif state == "ERROR" or ses["code"] == 7:
                stats[name]["skips_err"] += 1
                emit("skip_err", device=name, title=title)
                skip(serial)
            elif state == "PAUSED":
                if paused_since[name] is None:
                    paused_since[name] = now
                wake(serial)
                sh(serial, "shell", "cmd", "media_session", "dispatch", "play")
                sh(serial, "shell", "input", "keyevent", "KEYCODE_MEDIA_PLAY")
                sh(serial, "shell", "input", "keyevent", "85")  # PLAY_PAUSE
                if now - paused_since[name] >= 12:
                    emit("skip_paused", device=name, title=title, pos=pos)
                    skip(serial)
                    paused_since[name] = now

        if now - last_maps >= MAPS_EVERY_S:
            maps_runs += 1
            log(f"PHASE maps/fuel #{maps_runs} (Samsung+Blackview, pas de login Nothing)")
            for lab in ("samsung", "blackview"):
                serial = DEVICES[lab]
                if not alive(serial):
                    continue
                if pkg_installed(serial, PKG_MAPS):
                    launch_pkg(serial, PKG_MAPS)
                    time.sleep(4)
                    screenshot(serial, f"{lab}-maps-{maps_runs}.png")
                    emit("maps", device=lab, run=maps_runs)
                fuel_pkg = PKG_FUEL if pkg_installed(serial, PKG_FUEL) else "com.gasoiltracking.app"
                if pkg_installed(serial, fuel_pkg):
                    launch_pkg(serial, fuel_pkg)
                    time.sleep(4)
                    screenshot(serial, f"{lab}-fuel-{maps_runs}.png")
                    emit("fuel", device=lab, run=maps_runs, pkg=fuel_pkg)
                launch_music(serial)
            last_maps = now

        if now - last_smoke >= SMOKE_EVERY_S:
            smoke_runs += 1
            serial = DEVICES["samsung"]
            log(f"SMOKE autres apps Samsung #{smoke_runs}")
            if alive(serial):
                for pkg in OTHER:
                    if not pkg_installed(serial, pkg):
                        emit("smoke_missing", pkg=pkg)
                        continue
                    out = launch_pkg(serial, pkg)
                    ok = "Events injected" in out or "starting:" in out.lower() or "cmp=" in out.lower()
                    time.sleep(3)
                    screenshot(serial, f"samsung-smoke-{pkg.split('.')[-1]}-{smoke_runs}.png")
                    emit("smoke", pkg=pkg, ok=ok)
                    sh(serial, "shell", "am", "force-stop", pkg)
                launch_music(serial)
            last_smoke = now

        if now - last_hb >= 60:
            write_summary(stats, {"maps_runs": maps_runs, "smoke_runs": smoke_runs, "notes": notes, "elapsed_min": round((now - t0) / 60, 1)})
            log(
                "HB "
                + " | ".join(
                    f"{n}: t={stats[n]['titles']} buf={stats[n]['skips_buf']} frz={stats[n]['skips_frozen']} play={int(stats[n]['playing_s'])}s"
                    for n in DEVICES
                )
            )
            last_hb = now

        time.sleep(POLL)

    write_summary(stats, {"maps_runs": maps_runs, "smoke_runs": smoke_runs, "notes": notes, "done": True})
    emit("stop", stats=stats)
    log("STOP 02:00 atteint — résumé écrit")
    print(
        'AGENT_LOOP_TICK_nuit {"prompt":"wrap-up nuit: PDF + mail résultats détaillés Music/Maps/Fuel"}',
        flush=True,
    )


if __name__ == "__main__":
    main()
