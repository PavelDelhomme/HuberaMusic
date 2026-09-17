#!/usr/bin/env python3
"""Endurance EOS : lance des titres LONGS via recherche (hors biblio) et
écoute jusqu'à la FIN (≥85% durée). Aucun next spam.

  DEVICE=R5CT7263YJL API_BASE_URL=http://192.168.1.134:8787 TRACKS=4 \\
    python3 -u scripts/qa/samsung-eos-search-20260917.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("API_BASE_URL", "http://192.168.1.134:8787").rstrip("/")
PKG = "ovh.delhomme.ytmusic.dev"
DEVICE = os.environ.get("DEVICE", "R5CT7263YJL")
TRACKS = int(os.environ.get("TRACKS", "4"))
MIN_RATIO = float(os.environ.get("MIN_EOS_RATIO", "0.85"))
MIN_DUR_MS = int(os.environ.get("MIN_TRACK_DUR_MS", "150000"))
OUT = ROOT / "tmp" / f"samsung-eos-search-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

QUERIES = [
    "Thunderstruck AC/DC",
    "Paranoid Black Sabbath",
    "Bohemian Rhapsody Queen",
    "Hotel California Eagles",
    "Nothing Else Matters Metallica",
    "Stairway to Heaven Led Zeppelin",
    "Billie Jean Michael Jackson",
    "Smells Like Teen Spirit Nirvana",
    "Wonderwall Oasis",
    "Viva La Vida Coldplay",
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


def api_json(path: str, token: str | None = None, data: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json", "X-YTM-Client": "android"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        API + path,
        data=body,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode())


def login() -> tuple[str, str, str]:
    email, password = load_env()
    d = api_json("/api/auth/login", data={"email": email, "password": password})
    token = d.get("token") or d.get("accessToken") or ""
    refresh = d.get("refreshToken") or ""
    if not token:
        raise RuntimeError(f"login fail {d}")
    return token, refresh, email


def inject(token: str, refresh: str, email: str) -> None:
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh("shell", "settings", "put", "global", "zen_mode", "2")
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
        state_map = {1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
        state = named if named else state_map.get(code, str(code))
        pos = int(m.group(3)) if m else -1
        buffered = int(m.group(4)) if m else -1
        dur = int(dur_m.group(1)) if dur_m else -1
        if dur < 0 and buffered >= 45_000:
            dur = buffered
        best = {"title": title, "state": state, "pos": pos, "dur": dur, "buffered": buffered}
        if state == "PLAYING":
            break
    return best


def search_pick(token: str, q: str) -> dict | None:
    qenc = urllib.parse.quote(q)
    for path in (f"/api/search?q={qenc}", f"/api/search?q={qenc}&filter=songs"):
        try:
            d = api_json(path, token=token)
        except Exception:
            continue
        items = d.get("songs") or d.get("results") or d.get("items") or []
        if not items and isinstance(d, dict):
            for v in d.values():
                if isinstance(v, list) and v:
                    items = v
                    break
        for it in items[:10]:
            vid = it.get("id") or it.get("videoId")
            title = it.get("title") or "?"
            if vid and len(str(vid)) == 11:
                return {"id": vid, "title": title, "q": q}
    return None


def open_search_and_play(query: str, video_id: str | None = None) -> bool:
    """Préfère le deeplink ytmusic://watch/:id (fiable) ; fallback UI recherche."""
    if video_id and len(video_id) == 11:
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
        log(f"  deeplink ytmusic://watch/{video_id}")
        time.sleep(7)
        m = media()
        if m["state"] != "PLAYING":
            sh("shell", "input", "keyevent", "126")
            time.sleep(2)
        return True
    # Fallback UI (souvent fragile — évite de taper « Dev »)
    sh("shell", "input", "tap", "270", "2200")
    time.sleep(1.2)
    sh("shell", "uiautomator", "dump", "/sdcard/ui-eos.xml")
    xml = sh("shell", "cat", "/sdcard/ui-eos.xml")
    m = re.search(
        r'class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    )
    if m:
        x1, y1, x2, y2 = map(int, m.groups())
        sh("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    else:
        sh("shell", "input", "tap", "540", "220")
    time.sleep(0.6)
    typed = query.replace(" ", "%s")
    sh("shell", "input", "text", typed)
    time.sleep(0.5)
    sh("shell", "input", "keyevent", "66")
    time.sleep(4.5)
    sh("shell", "uiautomator", "dump", "/sdcard/ui-eos.xml")
    xml = sh("shell", "cat", "/sdcard/ui-eos.xml")
    skip = {"dev", "rechercher", "search", "annuler", "cancel", "tout", "titres", "vidéos"}
    best = None
    for m in re.finditer(
        r'text="([^"]{3,80})"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        text, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        cy = (y1 + y2) // 2
        if cy < 380 or cy > 1600:
            continue
        if text.lower() in skip:
            continue
        best = ((x1 + x2) // 2, cy, text)
        break
    if not best:
        sh("shell", "input", "tap", "400", "700")
        log(f"  tap fallback résultat pour {query!r}")
        return True
    sh("shell", "input", "tap", str(best[0]), str(best[1]))
    log(f"  tap résultat {best[2][:40]!r} @({best[0]},{best[1]})")
    time.sleep(6)
    m2 = media()
    if m2["state"] != "PLAYING":
        sh("shell", "input", "keyevent", "126")
        time.sleep(2)
    return True


def watch_until_end(max_wait_s: float = 600.0) -> dict:
    m0 = media()
    if m0["state"] == "PAUSED":
        sh("shell", "input", "keyevent", "126")
        time.sleep(2)
        m0 = media()
    title0 = m0["title"]
    dur0 = m0["dur"]
    if dur0 > 0 and dur0 < MIN_DUR_MS:
        return {
            "ok": False,
            "reason": "short_track",
            "title": title0,
            "max_pos": m0["pos"],
            "dur": dur0,
        }
    if m0["state"] not in ("PLAYING", "BUFFERING", "PAUSED") or title0 == "?":
        return {"ok": False, "reason": "not_playing", "title": title0, "max_pos": -1, "dur": dur0}
    start_pos = max(0, m0["pos"])
    t0 = time.time()
    last_pos = start_pos
    last_move = time.time()
    remain = ((dur0 - start_pos) / 1000.0 + 60.0) if dur0 > 0 else max_wait_s
    wait_s = max(max_wait_s, remain)
    log(f"WATCH {title0[:50]!r} pos={start_pos} dur={dur0} wait={int(wait_s)}s")
    while time.time() - t0 < wait_s:
        time.sleep(4.0)
        m = media()
        if m["title"] == title0 and m["state"] == "PAUSED":
            sh("shell", "input", "keyevent", "126")
            continue
        if m["pos"] > last_pos + 400:
            last_pos = m["pos"]
            last_move = time.time()
        if (
            m["title"] == title0
            and m["state"] == "PLAYING"
            and time.time() - last_move > 15
        ):
            log(f"  STALL pos={m['pos']}")
            return {
                "ok": False,
                "reason": "stall",
                "title": title0,
                "max_pos": last_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if m["title"] != title0 and m["title"] != "?" and title0 != "?":
            ratio = (last_pos / dur0) if dur0 and dur0 > 0 else None
            ok = (dur0 > 0 and last_pos >= int(dur0 * MIN_RATIO)) or (
                dur0 <= 0 and last_pos >= 180_000
            )
            log(
                f"  EOS →{m['title'][:36]!r} max={last_pos}/{dur0} "
                f"ratio={None if ratio is None else round(ratio, 2)} {'OK' if ok else 'FAIL'}"
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
            }
        if dur0 > 0 and last_pos >= int(dur0 * 0.97):
            time.sleep(4)
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
            }
        if int(time.time() - t0) % 20 < 5:
            log(f"  … {m['state']} {m['pos']}/{dur0}")
    return {
        "ok": False,
        "reason": "timeout",
        "title": title0,
        "max_pos": last_pos,
        "dur": dur0,
        "elapsed_s": round(time.time() - t0, 1),
    }


def main() -> int:
    log(f"DEVICE={DEVICE} API={API} TRACKS={TRACKS} OUT={OUT}")
    if "device" not in sh("get-state"):
        log("offline")
        return 2
    token, refresh, email = login()
    inject(token, refresh, email)
    results = []
    used = 0
    for q in QUERIES:
        if used >= TRACKS:
            break
        pick = search_pick(token, q)
        log(f"=== {used+1}/{TRACKS} search {q!r} → {pick}")
        open_search_and_play(q, video_id=(pick or {}).get("id"))
        time.sleep(3)
        r = watch_until_end()
        if r.get("reason") == "short_track":
            log(f"SKIP short {r['title'][:40]!r}")
            continue
        results.append({**r, "query": q, "api_pick": pick})
        used += 1
        log(f"{'PASS' if r['ok'] else 'FAIL'} {r.get('reason')} {r.get('title','')[:40]!r}")
        # Ne PAS next — laisser la file naturelle ou relancer recherche
        if not r["ok"]:
            inject(token, refresh, email)

    ok_n = sum(1 for r in results if r.get("ok"))
    report = {
        "ok": ok_n >= max(1, int(len(results) * 0.75)) and ok_n > 0,
        "passed": ok_n,
        "total": len(results),
        "results": results,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"GLOBAL ok={report['ok']} {ok_n}/{len(results)} → {OUT/'report.json'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
