#!/usr/bin/env python3
"""Vérifie que des titres vont jusqu'à la FIN (pas de next spam).

Usage:
  DEVICE=R5CT7263YJL API_BASE_URL=http://192.168.1.134:8787 TRACKS_TO_END=5 \\
    python3 -u scripts/qa/samsung-play-to-end-20260917.py
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
TRACKS_TO_END = int(os.environ.get("TRACKS_TO_END", "5"))
# Fin naturelle OBLIGATOIRE : ≥ ratio de la durée (pas de next spam)
MIN_RATIO = float(os.environ.get("MIN_EOS_RATIO", "0.85"))
# Si durée inconnue : au moins N ms écoutés avant changement de titre
MIN_LISTEN_MS = int(os.environ.get("MIN_LISTEN_MS", "180000"))
# Refuse les pistes trop courtes (OST / shorts) qui faussent le critère EOS
MIN_TRACK_DUR_MS = int(os.environ.get("MIN_TRACK_DUR_MS", "120000"))
OUT = ROOT / "tmp" / f"samsung-play-to-end-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)


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
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh("shell", "settings", "put", "global", "zen_mode", "2")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.6)
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


def tap_aleatoire() -> None:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-plm-eos.xml")
    xml = sh("shell", "cat", "/sdcard/ui-plm-eos.xml")
    for m in re.finditer(
        r'text="Aléatoire"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        x1, y1, x2, y2 = map(int, m.groups())
        sh("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
        log("  tap Aléatoire UI")
        return
    sh("shell", "input", "tap", "222", "696")
    log("  tap Aléatoire fallback")


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "dur": -1}
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
        # duration often as METADATA_KEY_DURATION / duration= / android.media.metadata.DURATION
        dur_m = re.search(
            r"(?:METADATA_KEY_DURATION|android\.media\.metadata\.DURATION|durationMs|duration)=(\d+)",
            chunk,
            re.I,
        )
        title = (desc.group(1).strip() if desc else "?")
        if title.lower() in ("null", "none", ""):
            title = "?"
        named = (m.group(1) or "").upper() if m else ""
        code = int(m.group(2)) if m else -1
        state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
        state = named if named else state_map.get(code, str(code))
        pos = int(m.group(3)) if m else -1
        buffered = int(m.group(4)) if m else -1
        dur = int(dur_m.group(1)) if dur_m else -1
        if dur < 0:
            for mm in re.finditer(r"duration[^\d]{0,20}(\d{5,})", chunk, re.I):
                cand = int(mm.group(1))
                if 30_000 <= cand <= 900_000:
                    dur = cand
                    break
        # Fallback : buffered position stable élevé ≈ durée (fichier progressif)
        if dur < 0 and buffered >= 45_000:
            dur = buffered
        best = {"title": title, "state": state, "pos": pos, "dur": dur, "buffered": buffered}
        if state == "PLAYING":
            break
    return best


def ensure_playing() -> dict:
    m = media()
    if m["state"] == "PLAYING" and m["title"] != "?":
        return m
    tap_aleatoire()
    time.sleep(8)
    for _ in range(12):
        m = media()
        if m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?":
            return m
        sh("shell", "cmd", "media_session", "dispatch", "play")
        time.sleep(2)
    return media()


def watch_until_end(max_wait_s: float = 600.0, _short_skips: int = 0) -> dict:
    """Laisse jouer SANS next jusqu'à la FIN réelle du titre (sinon FAIL)."""
    m0 = ensure_playing()
    # Relancer si pause (ne jamais skip)
    if m0["state"] == "PAUSED":
        sh("shell", "input", "keyevent", "126")  # MEDIA_PLAY
        time.sleep(2)
        m0 = media()
    title0 = m0["title"]
    dur0 = m0["dur"]
    if dur0 > 0 and dur0 < MIN_TRACK_DUR_MS:
        if _short_skips >= 8:
            return {
                "ok": False,
                "reason": "too_many_short_tracks",
                "title": title0,
                "max_pos": m0["pos"],
                "dur": dur0,
                "elapsed_s": 0,
                "samples": [],
            }
        log(f"SKIP short track {title0[:40]!r} dur={dur0}ms (<{MIN_TRACK_DUR_MS})")
        sh("shell", "cmd", "media_session", "dispatch", "next")
        time.sleep(4)
        return watch_until_end(max_wait_s=max_wait_s, _short_skips=_short_skips + 1)
    start_pos = max(0, m0["pos"])
    t0 = time.time()
    last_pos = start_pos
    last_move = time.time()
    samples = []
    # Timeout = durée restante + marge, jamais moins que max_wait_s
    remain_s = ((dur0 - start_pos) / 1000.0 + 45.0) if dur0 > 0 else max_wait_s
    wait_s = max(max_wait_s, remain_s)
    log(f"WATCH start title={title0[:50]!r} pos={start_pos} dur={dur0} wait={int(wait_s)}s")

    while time.time() - t0 < wait_s:
        time.sleep(3.0)
        m = media()
        # Si pause accidentelle → play (jamais next)
        if m["title"] == title0 and m["state"] == "PAUSED":
            sh("shell", "input", "keyevent", "126")
            time.sleep(1)
            m = media()
        samples.append({**m, "t": round(time.time() - t0, 1)})
        # Progression
        if m["pos"] > last_pos + 400:
            last_pos = m["pos"]
            last_move = time.time()
        # Stall : même titre, PLAYING, pos figée > 12s
        if (
            m["title"] == title0
            and m["state"] == "PLAYING"
            and m["pos"] >= 0
            and time.time() - last_move > 12
        ):
            log(f"  STALL pos={m['pos']} frozen>{int(time.time()-last_move)}s")
            return {
                "ok": False,
                "reason": "stall_frozen",
                "title": title0,
                "max_pos": last_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
                "samples": samples[-8:],
            }
        # Fin : titre a changé tout seul — OK seulement si on a atteint ≥ MIN_RATIO
        if m["title"] != title0 and m["title"] != "?" and title0 != "?":
            ratio = (last_pos / dur0) if dur0 and dur0 > 0 else None
            if dur0 and dur0 > 0:
                ok = last_pos >= int(dur0 * MIN_RATIO)
            else:
                ok = last_pos >= MIN_LISTEN_MS
            log(
                f"  EOS title→{m['title'][:40]!r} max_pos={last_pos} dur={dur0} "
                f"ratio={None if ratio is None else round(ratio,2)} "
                f"{'OK' if ok else 'FAIL early/cut'}"
            )
            return {
                "ok": ok,
                "reason": "natural_advance" if ok else "early_cut",
                "title": title0,
                "next": m["title"],
                "max_pos": last_pos,
                "dur": dur0,
                "ratio": ratio,
                "elapsed_s": round(time.time() - t0, 1),
                "samples": samples[-8:],
            }
        # Fin détectée via position ≈ durée
        if dur0 > 0 and last_pos >= int(dur0 * 0.97):
            log(f"  NEAR_END pos={last_pos}/{dur0}")
            # attendre un peu le skip auto
            time.sleep(5)
            m2 = media()
            return {
                "ok": True,
                "reason": "reached_duration",
                "title": title0,
                "next": m2["title"],
                "max_pos": last_pos,
                "dur": dur0,
                "ratio": last_pos / dur0,
                "elapsed_s": round(time.time() - t0, 1),
                "samples": samples[-8:],
            }
        if int(time.time() - t0) % 15 < 3:
            log(f"  … {m['state']} pos={m['pos']} / {dur0} title={m['title'][:36]!r}")

    return {
        "ok": False,
        "reason": "timeout",
        "title": title0,
        "max_pos": last_pos,
        "dur": dur0,
        "elapsed_s": round(time.time() - t0, 1),
        "samples": samples[-8:],
    }


def main() -> int:
    log(f"DEVICE={DEVICE} API={API} TRACKS_TO_END={TRACKS_TO_END} OUT={OUT}")
    if "device" not in sh("get-state"):
        log("Samsung offline")
        return 2
    token, refresh, email = login()
    inject(token, refresh, email)
    results = []
    for i in range(TRACKS_TO_END):
        log(f"=== track-to-end {i+1}/{TRACKS_TO_END} ===")
        # Si déjà en lecture fin de piste précédente, on continue sans retaper
        m = media()
        if m["state"] != "PLAYING":
            inject(token, refresh, email)
            ensure_playing()
        r = watch_until_end()
        results.append(r)
        if not r["ok"]:
            log(f"FAIL {r['reason']} on {r['title'][:50]!r}")
        else:
            log(f"PASS {r['reason']} {r['title'][:50]!r} pos={r['max_pos']}")
        # petite pause entre titres (le suivant a déjà démarré si natural_advance)
        time.sleep(2)

    ok_n = sum(1 for r in results if r["ok"])
    report = {
        "ok": ok_n >= max(1, int(TRACKS_TO_END * 0.8)),
        "passed": ok_n,
        "total": len(results),
        "results": results,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"GLOBAL ok={report['ok']} {ok_n}/{len(results)} → {OUT/'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
