#!/usr/bin/env python3
"""Endurance Samsung jusqu'à STOP_AT (défaut 2026-09-19 02:00).

- Musique muette (volume 0) ; DND alarms-only (zen=3) — alarmes audibles
- Biblio aléatoire + skips + titres froids fail-mail
- Ne touche PAS au Nothing
- Wi‑Fi intact

  DEVICE=R5CT7263YJL STOP_AT='2026-09-19 02:00' \\
    python3 -u scripts/qa/samsung-night-endurance-20260918.py
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERIAL = os.environ.get("DEVICE", "R5CT7263YJL")
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
STOP_AT = datetime.strptime(
    os.environ.get("STOP_AT", "2026-09-19 02:00"), "%Y-%m-%d %H:%M"
)
OUT = ROOT / "tmp" / f"endurance-night-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
LISTEN_S = float(os.environ.get("LISTEN_S", "25"))
LOAD_TIMEOUT_S = float(os.environ.get("LOAD_TIMEOUT_S", "40"))
SKIP_EVERY = float(os.environ.get("SKIP_EVERY", "55"))

FAILMAIL = ROOT / "tmp" / "multi-skip-failmail-set.json"


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 45) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", SERIAL, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return "TIMEOUT"


def mute_keep_alarms() -> None:
    for s in (1, 2, 3, 5):
        sh("shell", "cmd", "media_session", "volume", "--stream", str(s), "--set", "0")
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "cmd", "notification", "set_dnd", "alarms")
    sh("shell", "settings", "put", "global", "zen_mode", "3")
    sh("shell", "settings", "put", "system", "volume_alarm_speaker", "7")
    sh("shell", "cmd", "media_session", "volume", "--stream", "4", "--set", "7")


def load_env() -> tuple[str, str]:
    email = os.environ.get("SEED_EMAIL") or "dev@delhomme.ovh"
    password = os.environ.get("SEED_PASSWORD") or ""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("SEED_EMAIL=") and "SEED_EMAIL" not in os.environ:
                email = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("SEED_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
    return email, password


def api_login() -> tuple[str, str, str]:
    email, password = load_env()
    req = urllib.request.Request(
        f"{API}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode())
    return d.get("token") or "", d.get("refreshToken") or "", email


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3500]
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
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best["score"]:
            best = cand
    return best


def deeplink(video_id: str) -> None:
    sh(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        f"ytmusic://watch/{video_id}",
        "-n",
        f"{PKG}/.MainActivity",
    )


def skip_next() -> None:
    sh("shell", "cmd", "media_session", "dispatch", "skip_to_next")
    time.sleep(0.3)
    sh("shell", "input", "keyevent", "87")


def wait_playing(
    timeout_s: float = LOAD_TIMEOUT_S,
    *,
    prev_title: str | None = None,
    prev_pos: int | None = None,
) -> dict:
    t0 = time.time()
    last = media()
    while time.time() - t0 < timeout_s:
        last = media()
        fresh = True
        if prev_title and last["title"] not in ("?", prev_title):
            fresh = True
        elif prev_pos is not None and last["pos"] >= 0 and last["pos"] + 2000 < prev_pos:
            fresh = True
        elif prev_title and last["title"] == prev_title and last["pos"] > 8_000:
            fresh = False
        if last["state"] == "PLAYING" and last["pos"] >= 2000 and fresh:
            return {**last, "ok": True, "load_s": round(time.time() - t0, 2)}
        time.sleep(1.0)
    return {**last, "ok": False, "load_s": round(time.time() - t0, 2)}


def fetch_library_ids(token: str, n: int = 40) -> list[str]:
    req = urllib.request.Request(
        f"{API}/api/library",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        log(f"library fetch KO: {e}")
        return []
    tracks = []
    if isinstance(d, list):
        tracks = d
    elif isinstance(d, dict):
        tracks = d.get("songs") or d.get("tracks") or d.get("items") or []
    ids = []
    for t in tracks:
        vid = t.get("id") or t.get("videoId") or ""
        if isinstance(vid, str) and len(vid) == 11:
            ids.append(vid)
    random.shuffle(ids)
    return ids[:n]


def cold_ids() -> list[str]:
    if not FAILMAIL.exists():
        return []
    d = json.loads(FAILMAIL.read_text())
    return [c["id"] for c in d.get("cold", []) if c.get("id")]


def main() -> None:
    log(f"OUT={OUT}")
    log(f"STOP_AT={STOP_AT.isoformat()} DEVICE={SERIAL}")
    mute_keep_alarms()
    tok, ref, email = api_login()
    log(f"login ok {email}")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.8)
    sh(
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/.MainActivity",
        "--es",
        "ytm_access_token",
        tok,
        "--es",
        "ytm_user_email",
        email,
        "--es",
        "ytm_refresh_token",
        ref,
    )
    time.sleep(2.5)

    stats = {
        "ok": 0,
        "fail": 0,
        "slow": 0,
        "events": [],
        "started": datetime.now().isoformat(),
    }
    lib = fetch_library_ids(tok, 50)
    cold = cold_ids()
    log(f"pool lib={len(lib)} cold={len(cold)}")

    cycle = 0
    while datetime.now() < STOP_AT:
        cycle += 1
        mute_keep_alarms()
        # Mix: 2 library + 1 cold
        batch = []
        if lib:
            batch.extend(random.sample(lib, min(2, len(lib))))
        if cold:
            batch.append(random.choice(cold))
        if not batch:
            batch = ["d26A9g71eik"]
        random.shuffle(batch)

        for i, vid in enumerate(batch):
            if datetime.now() >= STOP_AT:
                break
            kind = "cold" if vid in cold else "lib"
            log(f"=== C{cycle}.{i} {kind} {vid} ===")
            prev = media()
            deeplink(vid)
            res = wait_playing(
                prev_title=prev.get("title"),
                prev_pos=prev.get("pos"),
            )
            ok = bool(res.get("ok"))
            load = float(res.get("load_s") or 0)
            if ok and load > 20:
                stats["slow"] += 1
            if ok:
                stats["ok"] += 1
            else:
                stats["fail"] += 1
            ev = {
                "t": datetime.now().isoformat(),
                "vid": vid,
                "kind": kind,
                "ok": ok,
                "load_s": load,
                "state": res.get("state"),
                "title": (res.get("title") or "")[:60],
            }
            stats["events"].append(ev)
            log(
                f"  → ok={ok} load={load}s state={res.get('state')} "
                f"pos={res.get('pos')} title={(res.get('title') or '')[:40]}"
            )
            (OUT / "SUMMARY.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            # Listen then skip
            t_listen = time.time()
            while time.time() - t_listen < LISTEN_S and datetime.now() < STOP_AT:
                time.sleep(min(5, LISTEN_S))
                m = media()
                if m["state"] in ("BUFFERING", "ERROR") and m["pos"] < 500:
                    log(f"  mid-stall {m['state']} — skip")
                    break
            skip_next()
            time.sleep(1.2)

        # Pause between cycles
        time.sleep(3)

    stats["ended"] = datetime.now().isoformat()
    stats["pass"] = stats["fail"] == 0 or (
        stats["ok"] / max(1, stats["ok"] + stats["fail"]) >= 0.85
    )
    (OUT / "SUMMARY.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(
        f"DONE ok={stats['ok']} fail={stats['fail']} slow={stats['slow']} "
        f"pass={stats['pass']}"
    )
    # Point symlink for PDF
    link = ROOT / "tmp" / "endurance-20260918-night" / "latest-summary.json"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.write_text(json.dumps({"out": str(OUT), **stats}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL {type(e).__name__}: {e}")
        raise
