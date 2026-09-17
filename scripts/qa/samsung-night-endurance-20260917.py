#!/usr/bin/env python3
"""Endurance nuit Samsung — Accès rapide / Aléatoire / biblio / EOS longs.

STRICT : DEVICE=Samsung uniquement. Volume toujours 0. Ignore appels (pas de taps UI
hors résultats musique ciblés / deeplink).

  DEVICE=R5CT7263YJL API_BASE_URL=http://192.168.1.134:8787 \\
    python3 -u scripts/qa/samsung-night-endurance-20260917.py
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
DEVICE = os.environ.get("DEVICE", "R5CT7263YJL")
STRICT = os.environ.get("STRICT_DEVICE", "1") != "0"
MIN_RATIO = float(os.environ.get("MIN_EOS_RATIO", "0.85"))
EOS_TRACKS = int(os.environ.get("EOS_TRACKS", "3"))
SHUFFLE_MIN = int(os.environ.get("SHUFFLE_MINUTES", "12"))
OUT = ROOT / "tmp" / f"samsung-night-endurance-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

LONG_IDS = [
    ("Thunderstruck", "lhg9bYNLvOg"),
    ("Paranoid", "m7nwbJLO9qo"),
    ("Hotel California", "BciS5krYL80"),
    ("Bohemian Rhapsody", "BSTsnWoslP4"),
    ("Wonderwall", "hpSrLjc5SMs"),
]


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 60) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", DEVICE, *args],
            capture_output=True,
            timeout=timeout,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return (r.stdout or "") + (r.stderr or "")


def enforce_quiet() -> None:
    """Mute + DND — jamais de volume > 0 pendant la nuit."""
    for s in ("1", "2", "3", "4", "5"):
        sh("shell", "cmd", "media_session", "volume", "--stream", s, "--set", "0")
        sh("shell", "media", "volume", "--stream", s, "--set", "0")
    sh("shell", "settings", "put", "global", "zen_mode", "2")


def load_env() -> tuple[str, str]:
    email = os.environ.get("SEED_EMAIL") or "dev@delhomme.ovh"
    password = os.environ.get("SEED_PASSWORD") or os.environ.get("VITE_DEV_PASSWORD") or ""
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


def login() -> tuple[str, str, str]:
    email, password = load_env()
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
        raise RuntimeError(f"login fail {d}")
    return token, refresh, email


def inject(token: str, refresh: str, email: str) -> None:
    enforce_quiet()
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.5)
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
    sh(*args)
    time.sleep(5)
    enforce_quiet()


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "dur": -1, "buffered": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 4500]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+).*?buffered position=(\d+)",
            chunk,
        )
        title = (desc.group(1).strip() if desc else "?")
        if title.lower() in ("null", "none", ""):
            title = "?"
        named = (m.group(1) or "").upper() if m else ""
        code = int(m.group(2)) if m else -1
        state_map = {1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
        state = named if named else state_map.get(code, str(code))
        pos = int(m.group(3)) if m else -1
        buffered = int(m.group(4)) if m else -1
        dur = buffered if buffered >= 45_000 else -1
        best = {"title": title, "state": state, "pos": pos, "dur": dur, "buffered": buffered}
        if state == "PLAYING":
            break
    return best


def tap_text(label: str) -> bool:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-night.xml")
    xml = sh("shell", "cat", "/sdcard/ui-night.xml")
    for m in re.finditer(
        rf'text="{re.escape(label)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        x1, y1, x2, y2 = map(int, m.groups())
        sh("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
        log(f"  tap «{label}»")
        return True
    return False


def play_deeplink(video_id: str) -> None:
    enforce_quiet()
    sh(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        f"ytmusic://watch/{video_id}",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
    )
    time.sleep(7)
    enforce_quiet()
    if media()["state"] != "PLAYING":
        sh("shell", "input", "keyevent", "126")
        time.sleep(2)
    enforce_quiet()


def watch_eos(max_wait_s: float = 600.0) -> dict:
    enforce_quiet()
    m0 = media()
    if m0["state"] == "PAUSED":
        sh("shell", "input", "keyevent", "126")
        time.sleep(2)
        m0 = media()
    title0, dur0 = m0["title"], m0["dur"]
    if m0["state"] not in ("PLAYING", "BUFFERING", "PAUSED") or title0 == "?":
        return {"ok": False, "reason": "not_playing", "title": title0, "max_pos": -1, "dur": dur0}
    t0 = time.time()
    last_pos = max(0, m0["pos"])
    last_move = time.time()
    max_pos = last_pos
    remain = ((dur0 - last_pos) / 1000.0 + 60.0) if dur0 > 0 else max_wait_s
    wait_s = max(max_wait_s, remain)
    log(f"WATCH {title0[:48]!r} pos={last_pos} dur={dur0}")
    while time.time() - t0 < wait_s:
        time.sleep(5)
        if int(time.time() - t0) % 45 < 6:
            enforce_quiet()
        m = media()
        if m["title"] == title0 and m["state"] == "PAUSED":
            sh("shell", "input", "keyevent", "126")
            continue
        if m["pos"] > max_pos:
            max_pos = m["pos"]
            last_move = time.time()
        if m["title"] == title0 and m["state"] == "PLAYING" and time.time() - last_move > 15:
            return {
                "ok": False,
                "reason": "stall",
                "title": title0,
                "max_pos": max_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if m["title"] != title0 and m["title"] != "?" and title0 != "?":
            ok = (dur0 > 0 and max_pos >= int(dur0 * MIN_RATIO)) or (
                dur0 <= 0 and max_pos >= 180_000
            )
            return {
                "ok": ok,
                "reason": "natural_advance" if ok else "early_cut",
                "title": title0,
                "next": m["title"],
                "max_pos": max_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if dur0 > 0 and max_pos >= int(dur0 * 0.97):
            return {
                "ok": True,
                "reason": "reached_duration",
                "title": title0,
                "max_pos": max_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if int(time.time() - t0) % 30 < 6:
            log(f"  … {m['state']} {m['pos']}/{dur0}")
    return {
        "ok": False,
        "reason": "timeout",
        "title": title0,
        "max_pos": max_pos,
        "dur": dur0,
        "elapsed_s": round(time.time() - t0, 1),
    }


def phase_acces_rapide() -> dict:
    log("=== PHASE Accès rapide ===")
    enforce_quiet()
    # Accueil
    sh("shell", "input", "tap", "135", "2200")
    time.sleep(2)
    if not tap_text("Accès rapide"):
        # fallback zone
        sh("shell", "input", "tap", "540", "900")
        log("  tap Accès rapide fallback")
    time.sleep(3)
    # Premier titre de la grille (éviter Dev / nav)
    sh("shell", "uiautomator", "dump", "/sdcard/ui-night.xml")
    xml = sh("shell", "cat", "/sdcard/ui-night.xml")
    skip = {
        "dev",
        "accès rapide",
        "aléatoire",
        "bibliothèque",
        "accueil",
        "rechercher",
        "compte",
        "profil",
    }
    tapped = False
    for m in re.finditer(
        r'text="([^"]{2,60})"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        text, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        cy = (y1 + y2) // 2
        if cy < 500 or cy > 1800:
            continue
        low = text.lower().strip()
        if low in skip:
            continue
        # Dates / UI chrome (ex. « jeu. 17 sept. »)
        if re.search(r"\b(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc|lun|mar|mer|jeu|ven|sam|dim)\b", low):
            continue
        if re.match(r"^\d{1,2}[:h]\d{2}", low):
            continue
        sh("shell", "input", "tap", str((x1 + x2) // 2), str(cy))
        log(f"  tap track {text[:40]!r}")
        tapped = True
        break
    if not tapped:
        # Deeplink de secours — un titre long connu
        play_deeplink(LONG_IDS[0][1])
        log("  Accès rapide → deeplink secours Thunderstruck")
        time.sleep(2)
    else:
        time.sleep(8)
    enforce_quiet()
    m = media()
    ok = m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?"
    # Écoute 90s sans next
    if ok:
        t0 = time.time()
        pos0 = m["pos"]
        while time.time() - t0 < 90:
            time.sleep(5)
            enforce_quiet()
            mm = media()
            if mm["state"] == "PAUSED":
                sh("shell", "input", "keyevent", "126")
            if mm["pos"] > pos0 + 5000:
                pos0 = mm["pos"]
        m = media()
        ok = m["pos"] >= 60_000 or (m["state"] == "PLAYING" and m["pos"] > 20_000)
    return {"phase": "acces_rapide", "ok": ok, "media": m}


def phase_aleatoire(minutes: int) -> dict:
    log(f"=== PHASE Aléatoire {minutes} min ===")
    enforce_quiet()
    sh("shell", "input", "tap", "135", "2200")
    time.sleep(1.5)
    if not tap_text("Aléatoire"):
        sh("shell", "input", "tap", "222", "696")
        log("  tap Aléatoire fallback")
    time.sleep(8)
    enforce_quiet()
    t_end = time.time() + minutes * 60
    samples = []
    stalls = 0
    last_pos = -1
    last_title = "?"
    changes = 0
    while time.time() < t_end:
        enforce_quiet()
        m = media()
        samples.append({**m, "t": round(time.time(), 1)})
        if m["state"] == "PAUSED":
            sh("shell", "input", "keyevent", "126")
        if m["title"] != last_title and m["title"] != "?" and last_title != "?":
            changes += 1
            last_title = m["title"]
            last_pos = m["pos"]
            stalls = 0
        elif m["state"] == "PLAYING" and m["pos"] <= last_pos + 200:
            stalls += 1
        else:
            stalls = 0
            last_pos = max(last_pos, m["pos"])
            if last_title == "?":
                last_title = m["title"]
        if stalls >= 8:
            log(f"  stall detected pos={m['pos']}")
            # Relancer play — jamais next spam
            sh("shell", "input", "keyevent", "126")
            stalls = 0
        if int(time.time()) % 60 < 6:
            log(f"  … {m['state']} {m['title'][:36]!r} pos={m['pos']} changes={changes}")
        time.sleep(5)
    playing = sum(1 for s in samples if s.get("state") == "PLAYING")
    ok = playing >= max(3, len(samples) // 3) and stalls < 8
    return {
        "phase": "aleatoire",
        "ok": ok,
        "changes": changes,
        "playing_samples": playing,
        "samples": len(samples),
    }


def phase_eos(n: int) -> dict:
    log(f"=== PHASE EOS deeplink x{n} ===")
    results = []
    for name, vid in LONG_IDS[:n]:
        log(f"--- {name} {vid}")
        play_deeplink(vid)
        r = watch_eos()
        r["name"] = name
        r["id"] = vid
        results.append(r)
        log(f"{'PASS' if r['ok'] else 'FAIL'} {r.get('reason')} {r.get('title','')[:40]!r}")
        enforce_quiet()
    ok_n = sum(1 for r in results if r.get("ok"))
    return {
        "phase": "eos",
        "ok": ok_n >= max(1, int(len(results) * 0.66)),
        "passed": ok_n,
        "total": len(results),
        "results": results,
    }


def main() -> int:
    log(f"DEVICE={DEVICE} API={API} OUT={OUT}")
    if STRICT and DEVICE != "R5CT7263YJL":
        log("STRICT_DEVICE: Samsung only — abort")
        return 2
    if "device" not in sh("get-state"):
        log("offline")
        return 2
    enforce_quiet()
    token, refresh, email = login()
    inject(token, refresh, email)

    report = {
        "started": datetime.now().isoformat(),
        "device": DEVICE,
        "phases": [],
    }
    for phase in (
        phase_acces_rapide,
        lambda: phase_aleatoire(SHUFFLE_MIN),
        lambda: phase_eos(EOS_TRACKS),
    ):
        try:
            r = phase()
        except Exception as e:
            r = {"ok": False, "error": str(e)}
            log(f"PHASE ERR {e}")
        report["phases"].append(r)
        inject(token, refresh, email)

    report["ok"] = all(p.get("ok") for p in report["phases"] if isinstance(p, dict))
    report["ended"] = datetime.now().isoformat()
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"GLOBAL ok={report['ok']} → {OUT/'report.json'}")
    enforce_quiet()
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
