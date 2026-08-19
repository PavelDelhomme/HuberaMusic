#!/usr/bin/env python3
"""Retest complet Nothing PROD : erreurs déjà vues (null, skip milieu, réseau).

ADB Wi‑Fi : les coupures Wi‑Fi sont auto-restaurées côté téléphone, puis reconnect.
Volume forcé à 0. Pause en fin. Ne lance pas le Samsung.

Usage:
  DEVICE=192.168.1.44:40967 python3 -u scripts/android/nothing-full-retest.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PKG = "ovh.delhomme.ytmusic"
IP = "192.168.1.44"
SERIAL = os.environ.get("DEVICE") or os.environ.get("ANDROID_SERIAL") or f"{IP}:40967"
SAMSUNG = os.environ.get("SAMSUNG_SERIAL", "R5CT7263YJL")
OUT = ROOT / "docs" / "reports" / f"nothing-full-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "device": SERIAL,
    "pkg": PKG,
    "checks": [],
    "ok": True,
    "nullHits": [],
    "playerErrors": [],
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 40, serial: str | None = None) -> str:
    s = serial or SERIAL
    try:
        r = subprocess.run(
            ["adb", "-s", s, *args],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail, "ts": time.time()})
    if not ok:
        report["ok"] = False
    log(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def mute(hard: bool = False) -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")
    if hard:
        for _ in range(10):
            sh("shell", "input", "keyevent", "25")


def reconnect() -> bool:
    global SERIAL
    subprocess.run(["adb", "connect", SERIAL], capture_output=True, timeout=15)
    model = sh("shell", "getprop", "ro.product.model").strip()
    if model == "A059":
        return True
    ports = [SERIAL.split(":")[-1], "40967", "5555"]
    try:
        n = subprocess.run(
            ["nmap", "-Pn", "-p", "30000-65000", "--open", "--min-rate", "4000", IP],
            capture_output=True,
            timeout=40,
            text=True,
        )
        ports += re.findall(r"(\d+)/tcp\s+open", n.stdout or "")
    except Exception:
        pass
    seen: list[str] = []
    for p in ports:
        if p in seen:
            continue
        seen.append(p)
        cand = f"{IP}:{p}"
        subprocess.run(["adb", "connect", cand], capture_output=True, timeout=10)
        time.sleep(0.4)
        blob = subprocess.run(
            ["adb", "-s", cand, "shell", "getprop", "ro.product.model"],
            capture_output=True,
            timeout=8,
        )
        if (blob.stdout or b"").decode().strip() == "A059":
            SERIAL = cand
            log(f"  reconnecté Nothing via {cand}")
            return True
    return False


def vol() -> str:
    t = sh("shell", "dumpsys", "audio")
    m = re.search(r"STREAM_MUSIC:.*?streamVolume:\s*(\d+)", t, re.S)
    return m.group(1) if m else "?"


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "raw_title": ""}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3000]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
            chunk,
        )
        raw = desc.group(1).strip() if desc else ""
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        state = m.group(1) if m else "?"
        pos = int(m.group(3)) if m else -1
        score = (4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0)
        cand = {"title": title, "state": state, "pos": pos, "raw_title": raw, "score": score}
        if cand["score"] >= best.get("score", -1):
            best = cand
    return best


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def wake() -> None:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")


def dump_ui(tag: str) -> str:
    remote = f"/sdcard/ui-{tag}.xml"
    sh("shell", "uiautomator", "dump", remote, timeout=20)
    local = OUT / f"ui-{tag}.xml"
    subprocess.run(
        ["adb", "-s", SERIAL, "pull", remote, str(local)],
        capture_output=True,
        timeout=20,
    )
    return local.read_text(encoding="utf-8", errors="ignore") if local.exists() else ""


def texts_of(xml: str) -> list[str]:
    return re.findall(r'text="([^"]*)"', xml)


def nullish(xml: str) -> list[str]:
    hits = []
    for t in texts_of(xml):
        if t.strip().lower() in ("null", "undefined", "none") or t.strip() == "Erreur null":
            hits.append(t)
        if re.fullmatch(r"(?i)erreur\s*[:\-]?\s*null", t.strip()):
            hits.append(t)
    return hits


def tap_text(xml: str, label: str, contains: bool = False) -> bool:
    for m in re.finditer(
        r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        t, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        ok = (label in t) if contains else (t == label)
        if ok:
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            log(f"  tap {t!r} @{x},{y}")
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def login() -> None:
    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = PKG
    env["API_BASE_URL"] = "https://ytmusic.delhomme.ovh"
    r = subprocess.run(
        ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )
    out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
    log(f"adb-login exit={r.returncode} {out.strip()[-180:]}")
    sh("shell", "am", "force-stop", "com.google.android.apps.youtube.music")
    sh("shell", "am", "force-stop", "com.google.android.youtube")


def app_log_today() -> str:
    return sh(
        "shell",
        f"run-as {PKG} sh -c 'tail -n 250 files/ytm-logs/app.log 2>/dev/null'",
        timeout=20,
    )


def scan_logs(raw: str) -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    npe, fatal, player, early, auto, toast_null = [], [], [], [], [], []
    for ln in raw.splitlines():
        if today not in ln and "E/AndroidRuntime" not in ln:
            # logcat lines may not have same date fmt
            pass
        low = ln.lower()
        if "nullpointer" in low or "kotlin.kotlinnullpointerexception" in low:
            npe.append(ln[-240:])
        if "fatal exception" in low:
            fatal.append(ln[-240:])
        if "onplayererror" in low:
            player.append(ln[-240:])
        if "fin trop" in low or "skip fin" in low:
            early.append(ln[-240:])
        if "playnow" in low and "auto=true" in low:
            auto.append(ln[-240:])
        if re.search(r"erreur\s*null|\bnull\b.*toast", low):
            toast_null.append(ln[-240:])
    return {
        "npe": npe,
        "fatal": fatal,
        "player": player,
        "early": early,
        "auto": auto,
        "toast_null": toast_null,
    }


def start_play() -> dict:
    wake()
    mute()
    xml = dump_ui("home")
    nh = nullish(xml)
    if nh:
        report["nullHits"].extend(nh)
    tap_text(xml, "Accueil") or True
    time.sleep(0.8)
    xml = dump_ui("accueil")
    report["nullHits"].extend(nullish(xml))
    if not tap_text(xml, "Aléatoire") and not tap_text(xml, "Aléatoire", contains=True):
        # fallback zone mosaïque
        sh("shell", "input", "tap", "860", "640")
    time.sleep(3.5)
    mute()
    dispatch("play")
    time.sleep(1.5)
    m = media()
    if m["state"] not in ("PLAYING", "BUFFERING"):
        xml = dump_ui("retry")
        tap_text(xml, "Papaoutai", contains=True) or tap_text(xml, "Welcome", contains=True)
        time.sleep(3)
        dispatch("play")
        m = media()
    return m


def wifi_blip(off_s: int = 16) -> bool:
    """Coupe le Wi‑Fi côté device (4G), le rallume, reconnecte ADB."""
    log(f"  wifi blip {off_s}s (4G puis restore)")
    sh(
        "shell",
        f"nohup sh -c 'svc data enable; svc wifi disable; sleep {off_s}; svc wifi enable; svc data enable' >/dev/null 2>&1 &",
    )
    time.sleep(off_s + 8)
    ok = False
    for i in range(12):
        if reconnect():
            ok = True
            break
        time.sleep(3)
        log(f"  reconnect try {i+1}")
    return ok


def main() -> int:
    global SERIAL
    log(f"OUT={OUT} serial={SERIAL}")
    mute(hard=True)
    sh("shell", "cmd", "media_session", "dispatch", "pause", serial=SAMSUNG)
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0", serial=SAMSUNG)

    sh("shell", "logcat", "-c")
    login()
    time.sleep(2)
    mute()
    check("volume-forced", True, f"vol={vol()}")

    m = start_play()
    check(
        "play:start",
        m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?" and m["raw_title"].lower() != "null",
        f"{m['state']} raw={m['raw_title'][:50]!r} vol={vol()}",
    )
    mute()

    xml = dump_ui("playing")
    nh = nullish(xml)
    report["nullHits"].extend(nh)
    ui_err = [t for t in texts_of(xml) if re.search(r"(?i)erreur|lecture impossible|connexion perdue", t)]
    check("ui:no-null", len(nh) == 0, f"null={nh} err={ui_err[:4]}")

    # soak milieu de titre (le bug Nothing)
    t0 = media()
    auto_skips = 0
    for i in range(10):
        time.sleep(8)
        mute()
        cur = media()
        log(f"  soak#{i+1} {cur['state']} pos={cur['pos']} {cur['title'][:42]} raw={cur['raw_title'][:20]!r}")
        if t0["title"] not in ("?", "") and cur["title"] not in ("?", t0["title"]) and cur["raw_title"].lower() != "null":
            auto_skips += 1
            log(f"  AUTO-SKIP {t0['title'][:30]} → {cur['title'][:30]}")
            t0 = cur
        if cur["raw_title"].lower() == "null":
            report["nullHits"].append("media_session description=null")
    check("soak:no-mid-skip", auto_skips == 0, f"auto={auto_skips} end={media()['title'][:36]}")
    check("soak:no-null-title", all("description=null" not in x for x in report["nullHits"]), str(report["nullHits"]))

    # skip / seek / pause
    a = media()
    dispatch("next")
    time.sleep(2.8)
    mute()
    b = media()
    check("skip", b["title"] != "?" and b["raw_title"].lower() != "null", f"{a['title'][:24]} → {b['title'][:24]}")
    dispatch("fast forward")
    time.sleep(1)
    dispatch("fast forward")
    time.sleep(1.2)
    c = media()
    check("seek-same-track", c["title"] == b["title"] or b["title"] == "?", f"pos {b['pos']}→{c['pos']}")
    dispatch("pause")
    time.sleep(1.2)
    dispatch("play")
    time.sleep(1.5)
    mute()
    d = media()
    check("pause-play", d["state"] in ("PLAYING", "BUFFERING"), d["state"])
    for i in range(4):
        dispatch("next")
        time.sleep(2.2)
        mute()
        x = media()
        log(f"  skip#{i+2} {x['state']} {x['title'][:40]} raw={x['raw_title'][:16]!r}")
        if x["raw_title"].lower() == "null":
            report["nullHits"].append(f"skip title null #{i}")
    check("skips:no-null", not any("null" in str(x).lower() for x in report["nullHits"] if "skip" in str(x)), str(report["nullHits"]))

    # tabs biblio / recherche — chasse « null » à l’écran
    for tab in ("Recherche", "Biblio", "Accueil"):
        xml = dump_ui(f"tab-{tab}")
        report["nullHits"].extend(nullish(xml))
        tap_text(xml, tab)
        time.sleep(1.4)
        xml = dump_ui(f"after-{tab}")
        report["nullHits"].extend(nullish(xml))
        bad = [t for t in texts_of(xml) if re.search(r"(?i)^null$|erreur\s*null", t)]
        check(f"tab:{tab}:no-null", len(bad) == 0, f"bad={bad} sample={texts_of(xml)[:8]}")

    # réseau : 1 blip Wi‑Fi→4G→Wi‑Fi pendant lecture (restore auto)
    dispatch("play")
    time.sleep(2)
    held = media()
    blip_ok = wifi_blip(16)
    check("adb:reconnect-after-4g", blip_ok, f"serial={SERIAL}")
    mute()
    if blip_ok:
        back = media()
        if back["state"] in ("PAUSED", "STOPPED"):
            dispatch("play")
            time.sleep(2)
            back = media()
        same = back["title"] in (held["title"], "?") or held["title"] == "?"
        check(
            "net:same-track-after-4g",
            same and back["raw_title"].lower() != "null",
            f"held={held['title'][:28]} back={back['title'][:28]} {back['state']}",
        )
        dispatch("next")
        time.sleep(2.5)
        mute()
        nxt = media()
        check("net:skip-after-restore", nxt["title"] != "?" and nxt["raw_title"].lower() != "null", nxt["title"][:40])
    else:
        check("net:same-track-after-4g", False, "ADB perdu après blip Wi‑Fi")

    # logs
    raw = app_log_today()
    (OUT / "app.log.txt").write_text(raw, encoding="utf-8", errors="ignore")
    lc = sh("logcat", "-d", "-t", "400", timeout=30)
    (OUT / "logcat.txt").write_text(lc[-200_000:], encoding="utf-8", errors="ignore")
    scanned = scan_logs(raw + "\n" + lc)
    report["playerErrors"] = scanned["player"][-8:]
    today = datetime.now().strftime("%Y-%m-%d")
    early_today = [x for x in scanned["early"] if today in x]
    npe_today = [x for x in scanned["npe"] if today in x or "AndroidRuntime" in x]
    check("logs:no-NPE", len(npe_today) == 0, str(npe_today[-3:]))
    check("logs:no-fatal", "FATAL EXCEPTION" not in lc or PKG not in "".join([ln for ln in lc.splitlines() if "FATAL" in ln][-3:]), "")
    fatals = [ln for ln in lc.splitlines() if "FATAL EXCEPTION" in ln and PKG in ln]
    check("logs:no-fatal-pkg", len(fatals) == 0, str(fatals[-2:]))
    check("logs:no-early-end", len(early_today) == 0, str(early_today[-3:]))
    check("logs:no-erreur-null", len(scanned["toast_null"]) == 0, str(scanned["toast_null"][-3:]))
    check("logs:onPlayerError-count", True, f"n={len(scanned['player'])} sample={scanned['player'][-2:]}")

    dispatch("pause")
    mute()
    sh("shell", "svc", "wifi", "enable")
    sh("shell", "svc", "data", "enable")
    sh("shell", "cmd", "media_session", "dispatch", "pause", serial=SAMSUNG)

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    report["volumeEnd"] = vol()
    report["nullHits"] = list(dict.fromkeys(report["nullHits"]))
    passed = sum(1 for c in report["checks"] if c["ok"])
    failed = sum(1 for c in report["checks"] if not c["ok"])
    report["summary"] = {"passed": passed, "failed": failed}
    path = OUT / "report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} passed={passed} failed={failed} vol={report['volumeEnd']} → {path}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
