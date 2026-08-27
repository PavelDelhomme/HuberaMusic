#!/usr/bin/env python3
"""Stress prod : Biblio → Aléatoire (tous titres) + skips + diagnostic erreurs stream.

Usage:
  DEVICE=192.168.1.184:5555 DURATION_MIN=60 python3 -u scripts/android/prod-library-shuffle-stress.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEV = os.environ.get("DEVICE") or os.environ.get("ANDROID_SERIAL") or ""
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
DURATION_MIN = float(os.environ.get("DURATION_MIN", "60"))
SKIP_EVERY_SECS = float(os.environ.get("SKIP_EVERY_SECS", "45"))
RESHUFFLE_EVERY_SECS = float(os.environ.get("RESHUFFLE_EVERY_SECS", "480"))
SAMPLE_SECS = float(os.environ.get("SAMPLE_SECS", "20"))
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
TOKEN = os.environ.get("API_TOKEN", "")

ROOT = Path(__file__).resolve().parents[2]
_dev_slug = re.sub(r"[^a-zA-Z0-9]+", "_", DEV or "nodev")[:32]
OUT = ROOT / "logs" / "endurance" / f"libshuffle-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{_dev_slug}"
OUT.mkdir(parents=True, exist_ok=True)
LOG = OUT / "live.log"
REPORT = OUT / "report.json"
ERRS = OUT / "errors.jsonl"


def sh(*args: str, timeout: int = 60) -> str:
    r = subprocess.run(
        ["adb", "-s", DEV, *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return (r.stdout or "") + (r.stderr or "")


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def wake() -> None:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    sh("shell", "settings", "put", "secure", "screen_off_pocket", "0")


def mute() -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")


def dump_ui() -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    return sh("shell", "cat", "/sdcard/ui.xml")


def tap_text(xml: str, label: str, *, contains: bool = False) -> bool:
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        t, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        ok = (label.lower() in t.lower()) if contains else (t == label)
        if ok:
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            log(f"  tap {t!r} @{x},{y}")
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def dismiss_anr(xml: str) -> bool:
    if "ne répond pas" not in xml and "isn't responding" not in xml.lower():
        return False
    return tap_text(xml, "Attendre") or tap_text(xml, "Fermer l'application") or tap_text(
        xml, "Close app", contains=True
    )


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "artist": "?", "state": "?", "pos": -1, "queue": -1, "score": -1}
    state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
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
        q = re.search(r"queueTitle=null, size=(\d+)", chunk)
        raw = (desc.group(1).strip() if desc else "")
        parts = [p.strip() for p in raw.split(",")] if raw else []
        title = parts[0] if parts and parts[0].lower() not in ("null", "none", "") else "?"
        artist = parts[1] if len(parts) > 1 else "?"
        if m:
            named = (m.group(1) or "").upper()
            code = int(m.group(2))
            state = named if named else state_map.get(code, str(code))
            pos = int(m.group(3))
        else:
            state, pos = "?", -1
        score = {"PLAYING": 6, "BUFFERING": 4, "PAUSED": 2}.get(state, 0)
        if title != "?":
            score += 2
        cand = {
            "title": title,
            "artist": artist,
            "state": state,
            "pos": pos,
            "queue": int(q.group(1)) if q else -1,
            "score": score,
        }
        if cand["score"] > best["score"]:
            best = cand
    return best


def dispatch(action: str) -> None:
    out = sh("shell", "cmd", "media_session", "dispatch", action)
    if "inaccessible" in out or "not found" in out or "No shell command" in out:
        sh("shell", "input", "keyevent", "87" if action == "next" else "85")


def start_library_shuffle() -> dict:
    """Biblio → Titres (si possible) → Aléatoire."""
    wake()
    mute()
    sh("shell", "am", "force-stop", "ovh.delhomme.ytmusic.dev")
    sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2.5)
    xml = dump_ui()
    dismiss_anr(xml)
    time.sleep(0.5)
    xml = dump_ui()
    tap_text(xml, "Biblio") or tap_text(xml, "Bibliothèque", contains=True)
    time.sleep(1.2)
    xml = dump_ui()
    dismiss_anr(xml)
    tap_text(xml, "Titres") or True
    time.sleep(0.8)
    xml = dump_ui()
    if not tap_text(xml, "Aléatoire") and not tap_text(xml, "Aléatoire", contains=True):
        if not tap_text(xml, "Tout lire"):
            # fallback: first track-ish row
            for m in re.finditer(
                r'text="([^"]{3,})"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                xml,
            ):
                t = m.group(1)
                y = (int(m.group(3)) + int(m.group(5))) // 2
                if y < 500 or y > 1700:
                    continue
                if t in ("Accueil", "Recherche", "Biblio", "Titres", "Playlists", "Mixes", "Téléchargés"):
                    continue
                x = (int(m.group(2)) + int(m.group(4))) // 2
                log(f"  fallback track tap {t!r} @{x},{y}")
                sh("shell", "input", "tap", str(x), str(y))
                break
    time.sleep(4.0)
    mute()
    dispatch("play")
    time.sleep(2.0)
    s = session()
    if s["state"] not in ("PLAYING", "BUFFERING"):
        dispatch("play")
        time.sleep(2.0)
        s = session()
    log(f"SHUFFLE start state={s['state']} q={s['queue']} title={s['title'][:48]}")
    return s


def scan_logcat_errors() -> list[dict]:
    raw = sh("logcat", "-d", "-t", "400")
    found = []
    for ln in raw.splitlines():
        if "onPlayerError" in ln or "PlaybackException" in ln or "Source error" in ln:
            found.append({"ts": time.time(), "line": ln[-320:]})
    return found


def scan_app_log_errors() -> list[dict]:
    """Only count fresh app.log lines (last ~3 min) to avoid stale false positives."""
    raw = sh(
        "shell",
        f"run-as {PKG} sh -c 'tail -n 120 files/ytm-logs/app.log 2>/dev/null'",
        timeout=20,
    )
    found = []
    now = datetime.now()
    for ln in raw.splitlines():
        low = ln.lower()
        if not (
            "onplayererror" in low
            or "playbackexception" in low
            or re.search(r"code=\d{4}", ln)
        ):
            continue
        m = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", ln)
        if m:
            try:
                ts = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
                if (now - ts).total_seconds() > 180:
                    continue
            except ValueError:
                pass
        found.append({"ts": time.time(), "line": ln[-320:]})
    return found


def diagnose_stream(track_hint: str) -> dict:
    """Probe /api/stream if we can extract an id; else just API health."""
    out: dict = {"hint": track_hint, "api": API}
    try:
        req = urllib.request.Request(f"{API}/api/health", method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            out["health"] = json.loads(r.read().decode())
    except Exception as e:
        out["healthError"] = str(e)
    # Try extract youtube-ish id from recent app log
    raw = sh(
        "shell",
        f"run-as {PKG} sh -c 'tail -n 200 files/ytm-logs/app.log 2>/dev/null'",
        timeout=20,
    )
    ids = re.findall(r"\bid=([A-Za-z0-9_-]{11})\b", raw)
    tid = ids[-1] if ids else None
    out["lastTrackId"] = tid
    if tid and TOKEN:
        try:
            req = urllib.request.Request(
                f"{API}/api/stream/{tid}",
                headers={
                    "Authorization": f"Bearer {TOKEN}",
                    "Range": "bytes=0-1023",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                out["streamStatus"] = r.status
                out["streamType"] = r.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            out["streamStatus"] = e.code
            out["streamBody"] = e.read()[:200].decode("utf-8", "replace")
        except Exception as e:
            out["streamError"] = str(e)
    return out


def record_error(kind: str, detail: dict) -> None:
    row = {"ts": datetime.now(timezone.utc).isoformat(), "kind": kind, **detail}
    with ERRS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    log(f"ERROR {kind}: {json.dumps(detail, ensure_ascii=False)[:240]}")


def main() -> None:
    if not DEV:
        raise SystemExit("DEVICE required")
    log(f"START device={DEV} pkg={PKG} duration={DURATION_MIN}m out={OUT}")
    sh("logcat", "-c")
    mute()
    s = start_library_shuffle()
    if s["state"] not in ("PLAYING", "BUFFERING"):
        s = start_library_shuffle()

    t0 = time.time()
    end = t0 + DURATION_MIN * 60
    last_skip = t0
    last_reshuffle = t0
    last_title = s["title"]
    titles: list[dict] = [{"t": 0, "title": last_title, "artist": s.get("artist"), "state": s["state"]}]
    transitions = 0
    skips = 0
    reshuffles = 1
    seen_err_lines: set[str] = set()
    samples: list[dict] = []

    while time.time() < end:
        now = time.time()
        elapsed = now - t0

        if now - last_reshuffle >= RESHUFFLE_EVERY_SECS:
            log("RESHUFFLE bibliothèque")
            start_library_shuffle()
            last_reshuffle = now
            last_skip = now
            reshuffles += 1

        if now - last_skip >= SKIP_EVERY_SECS:
            before = session()
            log(f"SKIP next from {before['title'][:40]}")
            dispatch("next")
            time.sleep(2.5)
            after = session()
            if after["state"] not in ("PLAYING", "BUFFERING"):
                dispatch("play")
                time.sleep(1.5)
                after = session()
            skips += 1
            last_skip = now
            if after["title"] == before["title"] and after["title"] != "?":
                log("SKIP same title — retry next")
                dispatch("next")
                time.sleep(2.0)

        s = session()
        if s["title"] != last_title and s["title"] != "?":
            transitions += 1
            titles.append(
                {
                    "t": round(elapsed),
                    "title": s["title"],
                    "artist": s.get("artist"),
                    "state": s["state"],
                }
            )
            log(f"TRANS #{transitions} {last_title[:36]} -> {s['title'][:36]} q={s['queue']}")
            last_title = s["title"]

        if s["state"] in ("STOPPED", "NONE", "ERROR") or s["queue"] == 0:
            log(f"RECOVER state={s['state']} q={s['queue']}")
            start_library_shuffle()
            last_reshuffle = now
            last_skip = now

        for err in scan_logcat_errors() + scan_app_log_errors():
            key = err["line"][-120:]
            if key in seen_err_lines:
                continue
            seen_err_lines.add(key)
            diag = diagnose_stream(s["title"])
            record_error("player", {"line": err["line"], "session": s, "diag": diag})

        samples.append({"t": round(elapsed), **s})
        log(
            f"t={int(elapsed)}s state={s['state']} pos={s['pos']} q={s['queue']} "
            f"title={s['title'][:40]} skips={skips} trans={transitions}"
        )
        time.sleep(SAMPLE_SECS)

    final = session()
    unique = sorted({t["title"] for t in titles if t["title"] != "?"})
    summary = {
        "device": DEV,
        "pkg": PKG,
        "startedAt": datetime.fromtimestamp(t0, tz=timezone.utc).isoformat(),
        "durationMin": DURATION_MIN,
        "elapsedSec": round(time.time() - t0),
        "transitions": transitions,
        "skips": skips,
        "reshuffles": reshuffles,
        "uniqueTitles": unique,
        "uniqueCount": len(unique),
        "titles": titles,
        "errorCount": len(seen_err_lines),
        "errorsFile": str(ERRS) if ERRS.exists() else None,
        "final": final,
        "samplesTail": samples[-20:],
        "ok": (
            transitions >= max(3, int(DURATION_MIN // 3))
            and final["state"] in ("PLAYING", "BUFFERING", "PAUSED")
            and len(seen_err_lines) == 0
        ),
    }
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    log(
        f"DONE ok={summary['ok']} unique={len(unique)} trans={transitions} "
        f"skips={skips} errors={len(seen_err_lines)} report={REPORT}"
    )


if __name__ == "__main__":
    main()
