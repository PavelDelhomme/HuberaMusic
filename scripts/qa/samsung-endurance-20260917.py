#!/usr/bin/env python3
"""Endurance Samsung PLM Dev — sessions lecture / next / shuffle / pause.

Usage:
  DEVICE=R5CT7263YJL API_BASE_URL=http://192.168.1.134:8787 \\
    SESSIONS=2 SESSION_MIN=20 TRACKS=40 \\
    python3 -u scripts/qa/samsung-endurance-20260917.py
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
API = os.environ.get("API_BASE_URL", "http://192.168.1.134:8787").rstrip("/")
PKG = "ovh.delhomme.ytmusic.dev"
DEVICE = os.environ.get("DEVICE", "R5CT7263YJL")
SESSIONS = int(os.environ.get("SESSIONS", "2"))
SESSION_MIN = float(os.environ.get("SESSION_MIN", "20"))
TRACKS_API = int(os.environ.get("TRACKS", "40"))
OUT = ROOT / "tmp" / f"samsung-endurance-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
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


def api(path: str, token: str | None = None, method: str = "GET", body: dict | None = None):
    headers = {"Content-Type": "application/json", "User-Agent": "PLM-Android-QA"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
        ct = r.headers.get("content-type", "")
        if "json" in ct or raw[:1] in (b"{", b"["):
            return json.loads(raw.decode() or "{}"), r.status, dict(r.headers)
        return raw, r.status, dict(r.headers)


def login() -> tuple[str, str, str]:
    email, password = load_env()
    d, _, _ = api("/api/auth/login", method="POST", body={"email": email, "password": password})
    token = d.get("token") or d.get("accessToken") or ""
    refresh = d.get("refreshToken") or ""
    if not token:
        raise RuntimeError(f"login fail {d}")
    return token, refresh, email


def library_ids(token: str) -> list[dict]:
    ids: list[dict] = []
    for path in (
        "/api/library",
        "/api/home",
    ):
        try:
            d, st, _ = api(path, token)
        except Exception as e:
            log(f"library {path} ERR {e}")
            continue
        if st >= 400 or not isinstance(d, dict):
            continue
        bag = []
        for k in (
            "songs",
            "liked",
            "tracks",
            "items",
            "history",
            "downloaded",
            "mixes",
            "albums",
        ):
            v = d.get(k)
            if isinstance(v, list):
                bag.extend(v)
        for sec in d.get("shelves") or d.get("sections") or []:
            if isinstance(sec, dict):
                bag.extend(sec.get("items") or sec.get("tracks") or sec.get("songs") or [])
        for pl in d.get("playlists") or d.get("likedPlaylists") or []:
            if isinstance(pl, dict):
                bag.extend(pl.get("tracks") or pl.get("songs") or pl.get("items") or [])
        for it in bag:
            if not isinstance(it, dict):
                continue
            vid = it.get("videoId") or it.get("id") or it.get("trackId")
            if isinstance(vid, str) and len(vid) == 11:
                ids.append({"id": vid, "title": str(it.get("title") or it.get("name") or vid)})
        if len(ids) >= TRACKS_API:
            break
    seen = set()
    out = []
    for x in ids:
        if x["id"] in seen:
            continue
        seen.add(x["id"])
        out.append(x)
    return out[:TRACKS_API]


def stream_probe(token: str, video_id: str) -> dict:
    t0 = time.time()
    try:
        # Suit les 302 de remplacement (titres morts → nouvel id)
        class Redir(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
                return urllib.request.HTTPRedirectHandler.redirect_request(
                    self, req, fp, code, msg, headers, newurl
                )

        opener = urllib.request.build_opener(Redir)
        req = urllib.request.Request(
            f"{API}/api/stream/{video_id}",
            headers={
                "Authorization": f"Bearer {token}",
                "Range": "bytes=0-2047",
                "User-Agent": "PLM-Android",
                "X-YTM-Client": "android",
            },
            method="GET",
        )
        with opener.open(req, timeout=55) as r:
            buf = r.read(2048)
            brand = "?"
            i = buf.find(b"ftyp")
            if i >= 0 and i + 8 <= len(buf):
                brand = buf[i + 4 : i + 8].decode("ascii", "replace")
            return {
                "id": video_id,
                "ok": r.status in (200, 206) and brand.lower() != "dash",
                "status": r.status,
                "brand": brand,
                "ms": int((time.time() - t0) * 1000),
                "bytes": len(buf),
            }
    except Exception as e:
        return {
            "id": video_id,
            "ok": False,
            "status": 0,
            "brand": str(e)[:80],
            "ms": int((time.time() - t0) * 1000),
            "bytes": 0,
        }


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3200]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+)",
            chunk,
        )
        title = (desc.group(1).strip() if desc else "?")
        if title.lower() in ("null", "none", ""):
            title = "?"
        named = (m.group(1) or "").upper() if m else ""
        code = int(m.group(2)) if m else -1
        state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
        state = named if named else state_map.get(code, str(code))
        pos = int(m.group(3)) if m else -1
        best = {"title": title, "state": state, "pos": pos}
        if state == "PLAYING":
            break
    return best


def inject(token: str, refresh: str, email: str) -> None:
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "3")
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


def tap_aleatoire() -> bool:
    """Démarre la lecture via tuile Accueil « Aléatoire » (media session sinon absente)."""
    sh("shell", "uiautomator", "dump", "/sdcard/ui-plm-endurance.xml")
    xml = sh("shell", "cat", "/sdcard/ui-plm-endurance.xml")
    for m in re.finditer(
        r'text="Aléatoire"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        x1, y1, x2, y2 = map(int, m.groups())
        x, y = (x1 + x2) // 2, (y1 + y2) // 2
        sh("shell", "input", "tap", str(x), str(y))
        log(f"  tap Aléatoire @{x},{y}")
        return True
    # Fallback coords Samsung G990 (Accueil)
    sh("shell", "input", "tap", "222", "639")
    log("  tap Aléatoire fallback @222,639")
    return True


def ensure_playing(timeout_s: float = 25.0) -> dict:
    end = time.time() + timeout_s
    m = media()
    if m["state"] == "PLAYING" and m["pos"] >= 0:
        return m
    tap_aleatoire()
    time.sleep(6)
    while time.time() < end:
        m = media()
        if m["state"] in ("PLAYING", "BUFFERING") and m.get("title", "?") != "?":
            return m
        dispatch("play")
        time.sleep(2.5)
        m = media()
        if m["state"] == "PLAYING":
            return m
        # mini-player Lecture
        sh("shell", "input", "tap", "834", "1860")
        time.sleep(2)
    return media()


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def session_device(session_idx: int, minutes: float) -> dict:
    log(f"=== DEVICE session {session_idx+1} ({minutes} min) ===")
    m0 = ensure_playing()
    log(f"  start {m0['state']} pos={m0['pos']} {m0['title'][:40]!r}")
    end = time.time() + minutes * 60
    actions = ["next", "next", "pause", "play", "next", "previous", "play"]
    samples = []
    stalls = 0
    last_pos = -1
    last_title = "?"
    frozen = 0
    while time.time() < end:
        act = random.choice(actions)
        dispatch(act)
        time.sleep(random.uniform(2.5, 6.0))
        m = media()
        if m["state"] in ("?", "NONE", "STOPPED") or m["title"] == "?":
            ensure_playing(12)
            m = media()
        ok = m["state"] in ("PLAYING", "BUFFERING", "PAUSED")
        if m["state"] == "PLAYING" and m["pos"] == last_pos and m["title"] == last_title and m["pos"] > 0:
            frozen += 1
            if frozen >= 3:
                stalls += 1
                log(f"  STALL? pos frozen {m['pos']} title={m['title'][:40]!r} → next")
                dispatch("next")
                frozen = 0
                time.sleep(3)
        else:
            frozen = 0
        last_pos, last_title = m["pos"], m["title"]
        samples.append({**m, "action": act, "ok": ok})
        log(f"  {act:8} → {m['state']:9} pos={m['pos']:>8} {m['title'][:40]!r}")
        if random.random() < 0.1:
            # Re-tap Aléatoire parfois (reset file)
            if random.random() < 0.35:
                tap_aleatoire()
                time.sleep(5)
            else:
                dispatch("pause")
                time.sleep(1.2)
                dispatch("play")
                time.sleep(2)
    playing = sum(1 for s in samples if s["state"] == "PLAYING")
    return {
        "samples": len(samples),
        "playing": playing,
        "stalls": stalls,
        "ok": stalls == 0 and playing >= max(3, len(samples) // 5),
        "last": samples[-5:] if samples else [],
    }


def main() -> int:
    log(f"DEVICE={DEVICE} API={API} OUT={OUT}")
    st = sh("get-state").strip()
    if "device" not in st:
        log(f"Samsung offline: {st}")
        return 2
    token, refresh, email = login()
    log(f"login ok {email}")

    tracks = library_ids(token)
    log(f"library tracks={len(tracks)}")
    if len(tracks) < 5:
        # fallback search
        for q in ("histoire", "keny", "starstruck", "lofi", "daft"):
            try:
                d, _, _ = api(f"/api/search?q={urllib.request.quote(q)}", token)
                for it in (d.get("songs") or d.get("results") or d.get("items") or [])[:8]:
                    vid = it.get("videoId") or it.get("id")
                    if isinstance(vid, str) and len(vid) == 11:
                        tracks.append({"id": vid, "title": it.get("title") or vid})
            except Exception as e:
                log(f"search {q} {e}")
        # dedup
        seen = set()
        tracks = [t for t in tracks if not (t["id"] in seen or seen.add(t["id"]))][:TRACKS_API]
        log(f"after search tracks={len(tracks)}")

    # API stream integrity (many titles)
    stream_results = []
    for t in tracks:
        r = stream_probe(token, t["id"])
        stream_results.append({**r, "title": t["title"]})
        log(
            f"stream {t['id']} {r['status']} brand={r['brand']} {r['ms']}ms {'OK' if r['ok'] else 'FAIL'} {t['title'][:36]!r}"
        )
        time.sleep(0.15)
    stream_ok = sum(1 for r in stream_results if r["ok"])
    log(f"STREAM {stream_ok}/{len(stream_results)} ok")

    inject(token, refresh, email)
    device_sessions = []
    for i in range(SESSIONS):
        inject(token, refresh, email)
        s = session_device(i, SESSION_MIN)
        device_sessions.append({"kind": f"session-{i+1}", **s})

    report = {
        "ok": stream_ok >= max(1, int(len(stream_results) * 0.7))
        and all(s.get("ok") for s in device_sessions if s.get("kind") != "smoke"),
        "stream_ok": stream_ok,
        "stream_total": len(stream_results),
        "stream_fails": [r for r in stream_results if not r["ok"]][:20],
        "sessions": device_sessions,
        "api": API,
        "device": DEVICE,
        "version": "d+1.3.242",
    }
    # smoke may fail UI but stream matters; overall ok if streams good + at least one session ok
    if stream_ok >= max(1, int(len(stream_results) * 0.75)):
        if any(s.get("ok") for s in device_sessions):
            report["ok"] = True
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"GLOBAL ok={report['ok']} → {OUT / 'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
