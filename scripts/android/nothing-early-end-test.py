#!/usr/bin/env python3
"""Test prod Nothing : lecture naturelle jusqu’à la fin (détecte early_end).

Ne skippe PAS — laisse les titres aller au bout, mesure pos/durée à la transition.
Usage:
  DEVICE=00145153K001434 DURATION_MIN=45 TRACKS=8 \\
    python3 -u scripts/android/nothing-early-end-test.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

DEV = os.environ.get("DEVICE") or os.environ.get("ANDROID_SERIAL") or "00145153K001434"
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
DURATION_MIN = float(os.environ.get("DURATION_MIN", "45"))
TARGET_TRACKS = int(os.environ.get("TRACKS", "8"))
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "reports" / f"nothing-early-end-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "device": DEV,
    "pkg": PKG,
    "transitions": [],
    "earlySuspects": [],
    "ok": True,
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", DEV, *args],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = None
    media_btn = "Media button session" in t and PKG in t.split("Media button session", 1)[1][:220]
    for mpkg in re.finditer(rf"(?m)^(\s*)package={re.escape(PKG)}\s*$", t):
        start = mpkg.start()
        chunk = t[start : start + 3000]
        nxt = re.search(r"(?m)^\s+package=", chunk[len(mpkg.group(0)) :])
        if nxt:
            chunk = chunk[: len(mpkg.group(0)) + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
            chunk,
        )
        # durée parfois dans metadata duration=
        dur = re.search(r"android\.media\.metadata\.DURATION[=,]?\s*(\d+)", chunk)
        if not dur:
            dur = re.search(r"duration[=:]?\s*(\d{4,})", chunk, re.I)
        title = (desc.group(1).strip() if desc else "?")
        if title.lower() in ("null", "none", ""):
            title = "?"
        state = m.group(1) if m else "?"
        score = 2 + (5 if media_btn else 0)
        if state == "PLAYING":
            score += 4
        elif state == "BUFFERING":
            score += 3
        elif state == "PAUSED":
            score += 2
        elif state == "STOPPED":
            score -= 3
        cand = {
            "title": title,
            "state": state,
            "pos": int(m.group(3)) if m else -1,
            "dur": int(dur.group(1)) if dur else -1,
            "score": score,
        }
        if best is None or cand["score"] > best["score"]:
            best = cand
    return best or {"title": "?", "state": "?", "pos": -1, "dur": -1, "score": 0}


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def ensure_playing() -> dict:
    m = media()
    if m["state"] in ("PLAYING", "BUFFERING"):
        return m
    dispatch("play")
    time.sleep(1.2)
    return media()


def tap(x: int, y: int) -> None:
    sh("shell", "input", "tap", str(x), str(y))
    time.sleep(0.8)


def start_from_home() -> dict:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    sh("shell", "am", "start", "-n", f"{PKG}/ovh.delhomme.ytmusic.MainActivity")
    time.sleep(3)
    # Coords Nothing Phone typiques ~1080x2400 — Accueil bas + Aléatoire / Lire
    # Fallback : play media_session si déjà une file
    m = media()
    if m["state"] in ("PLAYING", "BUFFERING", "PAUSED") and m["title"] != "?":
        return ensure_playing()
    # Accueil bottom-ish + shuffle card approx (même famille que Samsung, à ajuster)
    for coords in [(180, 2200), (540, 2200), (900, 650), (540, 650), (540, 2000)]:
        tap(*coords)
        time.sleep(1.5)
        m = ensure_playing()
        if m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?":
            return m
    dispatch("play")
    time.sleep(2)
    return media()


def collect_early_logs() -> list[str]:
    dump = sh("logcat", "-d", "-v", "brief", timeout=90)
    (OUT / "logcat-tail.txt").write_text(dump[-250_000:], encoding="utf-8", errors="ignore")
    keys = ("early_end", "fin trop tôt", "STATE_ENDED", "skip fin vide", "FATAL EXCEPTION")
    return [ln for ln in dump.splitlines() if any(k in ln for k in keys)][-80:]


def main() -> int:
    log(f"OUT={OUT} DEV={DEV} PKG={PKG}")
    ver = sh("shell", "dumpsys", "package", PKG)
    vm = re.search(r"versionName=([^\s]+)", ver)
    report["version"] = vm.group(1) if vm else "?"
    log(f"version={report['version']}")
    sh("logcat", "-c")

    m = start_from_home()
    if m["state"] not in ("PLAYING", "BUFFERING", "PAUSED") or m["title"] == "?":
        report["ok"] = False
        log(f"FAIL start {m}")
    else:
        log(f"START {m['state']} {m['title'][:60]} pos={m['pos']} dur={m.get('dur')}")

    end = time.time() + DURATION_MIN * 60
    last = media()
    peak_pos_for_title: dict[str, int] = {}
    natural = 0

    while time.time() < end and natural < TARGET_TRACKS:
        m = media()
        if m["state"] in ("PAUSED", "STOPPED", "?"):
            ensure_playing()
            m = media()
        title = m["title"]
        if title and title != "?":
            peak_pos_for_title[title] = max(peak_pos_for_title.get(title, 0), m["pos"])

        # Transition titre = fin (naturelle ou early)
        if (
            last["title"] not in ("?", "")
            and title not in ("?", "")
            and title != last["title"]
            and last["pos"] > 5_000
        ):
            peak = peak_pos_for_title.get(last["title"], last["pos"])
            dur = last.get("dur") or -1
            ratio = (peak / dur) if dur and dur > 0 else None
            ev = {
                "from": last["title"][:80],
                "to": title[:80],
                "peakPosMs": peak,
                "lastPosMs": last["pos"],
                "durMs": dur,
                "ratio": round(ratio, 3) if ratio is not None else None,
                "ts": time.time(),
            }
            report["transitions"].append(ev)
            natural += 1
            flag = ""
            if ratio is not None and ratio < 0.85:
                flag = " EARLY?"
                report["earlySuspects"].append(ev)
                report["ok"] = False
            log(
                f"TRANSITION#{natural} peak={peak}ms dur={dur} ratio={ev['ratio']}{flag} "
                f"{last['title'][:40]} → {title[:40]}"
            )
            # reset peak for old title tracking noise
        last = m
        if natural > 0 and natural % 1 == 0 and m["pos"] >= 0:
            log(f"  listen {m['state']} pos={m['pos']} dur={m.get('dur')} {m['title'][:50]}")
        time.sleep(8)

    # Si trop peu de fins naturelles : forcer quelques skips pour valider media_session
    if natural < 2:
        log("peu de transitions naturelles — burst skips de contrôle")
        titles = []
        ensure_playing()
        for i in range(10):
            before = media()["title"]
            dispatch("next")
            time.sleep(1.8)
            after = media()["title"]
            titles.append(after)
            log(f"  skip#{i+1} {after[:50]}")
        uniq = len({t for t in titles if t and t != "?"})
        report["skipControlUnique"] = uniq
        if uniq < 5:
            report["ok"] = False

    hits = collect_early_logs()
    report["logHits"] = hits[-40:]
    early_log = [h for h in hits if "fin trop tôt" in h or "early_end" in h]
    report["earlyLogCount"] = len(early_log)
    if early_log:
        # retry=1 = warn, retry=2 = error mail — on marque soft fail si retry présent
        report["ok"] = False
        log(f"FAIL early_end logs={len(early_log)}")
        for h in early_log[-8:]:
            log(f"  {h[-200:]}")

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    report["naturalTransitions"] = natural
    report["elapsedSec"] = round(
        (
            datetime.fromisoformat(report["endedAt"].replace("Z", "+00:00"))
            - datetime.fromisoformat(report["startedAt"].replace("Z", "+00:00"))
        ).total_seconds(),
        1,
    )
    path = OUT / "report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (ROOT / "docs" / "reports" / "nothing-early-end-latest.json").write_text(
        path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    log(
        f"DONE ok={report['ok']} natural={natural} suspects={len(report['earlySuspects'])} "
        f"earlyLogs={report['earlyLogCount']} → {path}"
    )
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
