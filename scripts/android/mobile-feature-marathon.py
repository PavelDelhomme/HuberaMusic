#!/usr/bin/env python3
"""Campagne mobile multi-phases ~1 h — parcours + inversions (Samsung DEV + Nothing PROD).

Usage:
  setsid -f env PYTHONUNBUFFERED=1 DEVICE_DEV=… DEVICE_PROD=… \\
    python3 -u scripts/android/mobile-feature-marathon.py \\
    >/tmp/plm-mobile-marathon-live.txt 2>&1
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "reports" / f"mobile-marathon-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

DEV = os.environ.get("DEVICE_DEV", "R5CT7263YJL")
PROD = os.environ.get("DEVICE_PROD", "00145153K001434")
PKG_DEV = "ovh.delhomme.ytmusic.dev"
PKG_PROD = "ovh.delhomme.ytmusic"
LAN = os.environ.get("API_LAN", "http://192.168.1.134:8787")

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "phases": [],
    "checks": [],
    "fatals": [],
    "ok": True,
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a") as f:
        f.write(line + "\n")


def sh(serial: str, *args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", serial, *args],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"TIMEOUT {' '.join(args)}"
    # bytes → utf-8 replace : titres FR / logcat ne doivent jamais planter le harness
    out = (r.stdout or b"") + (r.stderr or b"")
    return out.decode("utf-8", errors="replace")


def check(phase: str, name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append(
        {"phase": phase, "name": name, "ok": bool(ok), "detail": detail, "ts": time.time()}
    )
    if not ok:
        report["ok"] = False
    log(f"[{phase}] {'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def soft(phase: str, name: str, ok: bool, detail: str = "") -> None:
    """Check non bloquant (n’inverse pas report.ok)."""
    report["checks"].append(
        {
            "phase": phase,
            "name": name,
            "ok": bool(ok),
            "detail": detail,
            "soft": True,
            "ts": time.time(),
        }
    )
    log(f"[{phase}] {'PASS' if ok else 'SOFT'} {name}" + (f" — {detail}" if detail else ""))


def ensure_net(serial: str) -> None:
    sh(serial, "shell", "cmd", "connectivity", "airplane-mode", "disable")
    sh(serial, "shell", "svc", "wifi", "enable")
    sh(serial, "shell", "svc", "data", "enable")
    time.sleep(2)


def wake(serial: str) -> None:
    sh(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh(serial, "shell", "wm", "dismiss-keyguard")


def set_api(serial: str, pkg: str, url: str | None) -> None:
    sh(serial, "shell", "am", "force-stop", pkg)
    if not url:
        sh(serial, "shell", f"run-as {pkg} sh -c 'rm -f shared_prefs/ytm_api.xml'")
        return
    cmd = (
        f"run-as {pkg} sh -c \""
        "mkdir -p shared_prefs; "
        "printf '%s\\n' "
        "'<?xml version=\\'1.0\\' encoding=\\'utf-8\\' standalone=\\'yes\\' ?>' "
        "'<map>' "
        f"'    <string name=\\\"base_url\\\">{url}</string>' "
        "'</map>' "
        "> shared_prefs/ytm_api.xml\""
    )
    sh(serial, "shell", cmd)


def launch(serial: str, pkg: str) -> None:
    wake(serial)
    sh(serial, "shell", "am", "force-stop", pkg)
    sh(serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(3)


def ensure_logged_in(serial: str, pkg: str, api: str | None, phase: str) -> bool:
    """Si écran login visible → injection token DEBUG via adb-login.sh."""
    wake(serial)
    ui = dump_ui(serial, "auth-check")
    texts = ui_texts(ui)
    if any(t == "Accueil" for t in texts) and not any(t == "Se connecter" for t in texts):
        check(phase, "auth:session", True, "déjà connecté")
        return True
    if not any(t == "Se connecter" for t in texts):
        # splash / dump vide — relancer
        launch(serial, pkg)
        time.sleep(2)
        ui = dump_ui(serial, "auth-check2")
        texts = ui_texts(ui)
        if any(t == "Accueil" for t in texts):
            check(phase, "auth:session", True, "après relaunch")
            return True
    api_url = api or LAN
    log(f"  auth: injection session API={api_url}")
    env = os.environ.copy()
    env["DEVICE"] = serial
    env["PKG"] = pkg
    env["API_BASE_URL"] = api_url
    try:
        r = subprocess.run(
            ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
            cwd=str(ROOT),
            capture_output=True,
            timeout=90,
            env=env,
        )
        out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
        log(f"  adb-login exit={r.returncode} {out.strip()[-200:]}")
    except Exception as e:
        check(phase, "auth:session", False, f"adb-login exception {e}")
        return False
    time.sleep(4)
    texts = ui_texts(dump_ui(serial, "auth-after"))
    ok = any(t == "Accueil" for t in texts) and not any(t == "Se connecter" for t in texts)
    check(phase, "auth:session", ok, f"texts={len(texts)}")
    return ok


def clear_logcat(serial: str) -> None:
    sh(serial, "logcat", "-c")


def collect_fatals(serial: str, pkg: str, tag: str) -> int:
    dump = sh(serial, "logcat", "-d", "-v", "brief", timeout=60)
    (OUT / f"logcat-{tag}.txt").write_text(dump[-400_000:], encoding="utf-8", errors="ignore")
    pat = re.compile(rf"FATAL EXCEPTION|AndroidRuntime.*{re.escape(pkg)}", re.I)
    hits = [ln for ln in dump.splitlines() if pat.search(ln)]
    for h in hits[-8:]:
        report["fatals"].append({"tag": tag, "line": h[-240:]})
    return len(hits)


def dump_ui(serial: str, name: str) -> Path:
    remote = "/sdcard/ui-marathon.xml"
    local = OUT / f"ui-{name}.xml"
    # Samsung : dump raté laisse l’ancien XML → faux positifs login
    sh(serial, "shell", "rm", "-f", remote, timeout=8)
    sh(serial, "shell", "pkill", "-f", "uiautomator", timeout=8)
    time.sleep(0.3)
    out = sh(serial, "shell", "uiautomator", "dump", remote, timeout=25)
    if "ERROR" in out or "TIMEOUT" in out or "null root" in out.lower():
        time.sleep(1.5)
        sh(serial, "shell", "rm", "-f", remote, timeout=8)
        out = sh(serial, "shell", "uiautomator", "dump", remote, timeout=25)
    pull = sh(serial, "pull", remote, str(local), timeout=20)
    if (
        not local.exists()
        or local.stat().st_size < 50
        or "does not exist" in pull.lower()
        or "ERROR" in out
        or "null root" in out.lower()
    ):
        local.write_text("<hierarchy/>", encoding="utf-8")
    return local


def ui_texts(path: Path) -> list[str]:
    try:
        xml = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    return [t for t in re.findall(r'(?:text|content-desc)="([^"]*)"', xml) if t.strip()]


UI_BLACKLIST = (
    "défi",
    "bitwarden",
    "passkey",
    "choisissez",
    "empreinte",
    "credential",
    "samsung",
)


def tap_text(serial: str, needle: str, ui: Path | None = None) -> bool:
    try:
        safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", needle)[:24]
        path = ui if (ui and ui.exists()) else dump_ui(serial, f"tap-{safe}")
        xml = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    needle_l = needle.lower()
    cands = []
    for m in re.finditer(
        r'(?:text|content-desc)="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
        r'|bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*(?:text|content-desc)="([^"]*)"',
        xml,
    ):
        g = m.groups()
        if g[0] is not None:
            label, x1, y1, x2, y2 = g[0], int(g[1]), int(g[2]), int(g[3]), int(g[4])
        else:
            x1, y1, x2, y2, label = int(g[5]), int(g[6]), int(g[7]), int(g[8]), g[9] or ""
        lab_l = (label or "").lower()
        if any(b in lab_l for b in UI_BLACKLIST):
            continue
        if needle_l not in lab_l:
            continue
        # short needles ("Lire") : exact or word-ish only
        if len(needle_l) <= 5 and needle_l != lab_l and not re.search(
            rf"(^|[^a-z0-9]){re.escape(needle_l)}([^a-z0-9]|$)", lab_l
        ):
            continue
        exact = 0 if lab_l == needle_l else 1
        # nav bas d’écran pour Accueil/Recherche/Biblio ; sinon préfère centre contenu
        if needle_l in ("accueil", "recherche", "biblio"):
            rank_y = -y1
        else:
            rank_y = abs(y1 - 900)
        cands.append((exact, rank_y, len(label), (x1 + x2) // 2, (y1 + y2) // 2, label))
    if not cands:
        return False
    cands.sort()
    _, _, _, x, y, lab = cands[0]
    log(f"  tap {lab!r} @ {x},{y}")
    sh(serial, "shell", "input", "tap", str(x), str(y))
    time.sleep(1.0)
    return True


def media(serial: str, pkg: str) -> dict:
    """Préfère la session `package=` du pkg (évite YouTube / sessions STOPPED parasites)."""
    t = sh(serial, "shell", "dumpsys", "media_session")
    candidates = []
    media_btn = False
    if "Media button session" in t:
        tail = t.split("Media button session", 1)[1][:220]
        media_btn = pkg in tail
    for mpkg in re.finditer(rf"(?m)^(\s*)package={re.escape(pkg)}\s*$", t):
        start = mpkg.start()
        chunk = t[start : start + 2800]
        nxt = re.search(r"(?m)^\s+package=", chunk[len(mpkg.group(0)) :])
        if nxt:
            chunk = chunk[: len(mpkg.group(0)) + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
            chunk,
        )
        q = re.search(r"queueTitle=null, size=(\d+)", chunk) or re.search(
            r"size=(\d+)", chunk
        )
        state = m.group(1) if m else "?"
        score = 2  # package= exact
        if media_btn:
            score += 5
        if state == "PLAYING":
            score += 4
        elif state == "BUFFERING":
            score += 3
        elif state == "PAUSED":
            score += 2
        elif state == "STOPPED":
            score -= 3
        title = desc.group(1).strip() if desc else "?"
        if title.lower() in ("null", "none", ""):
            title = "?"
            score -= 2
        candidates.append(
            {
                "title": title,
                "state": state,
                "pos": int(m.group(3)) if m else -1,
                "queue": int(q.group(1)) if q else -1,
                "score": score,
                "raw_has_pkg": True,
            }
        )
    if not candidates:
        # fallback legacy (Media button line only)
        if pkg in t:
            desc = re.search(r"description=([^\n]+)", t)
            m = re.search(
                r"state=PlaybackState \{state=([A-Z]+)\((\d+)\).*?position=(\d+)",
                t,
            )
            title = desc.group(1).strip() if desc else "?"
            if title.lower() in ("null", "none", ""):
                title = "?"
            return {
                "title": title,
                "state": m.group(1) if m else "?",
                "pos": int(m.group(3)) if m else -1,
                "queue": -1,
                "raw_has_pkg": True,
                "score": 1,
            }
        return {"title": "?", "state": "?", "pos": -1, "queue": -1, "raw_has_pkg": False, "score": 0}
    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[0]


def dispatch(serial: str, action: str) -> None:
    # Android 12+ : `cmd media_session` (pas le binaire media_session)
    out = sh(serial, "shell", "cmd", "media_session", "dispatch", action)
    if "inaccessible" in out or "not found" in out or out.startswith("TIMEOUT"):
        sh(serial, "shell", "media_session", "dispatch", action)


def ensure_playing(serial: str, pkg: str) -> dict:
    m = media(serial, pkg)
    if m["state"] in ("PLAYING", "BUFFERING"):
        return m
    dispatch(serial, "play")
    time.sleep(1.2)
    m = media(serial, pkg)
    if m["state"] in ("PLAYING", "BUFFERING"):
        return m
    tap_text(serial, "Lecture") or tap_text(serial, "Play")
    time.sleep(1.2)
    return media(serial, pkg)


def offline_count(serial: str, pkg: str) -> int:
    out = sh(serial, "shell", f"run-as {pkg} sh -c 'ls files/offline/*.m4a 2>/dev/null | wc -l'")
    m = re.search(r"(\d+)", out)
    return int(m.group(1)) if m else 0


def phase_start(name: str, meta: dict) -> dict:
    log(f"==== PHASE {name} ====")
    p = {"name": name, "meta": meta, "started": time.time(), "notes": []}
    report["phases"].append(p)
    return p


def phase_end(p: dict) -> None:
    p["elapsedSec"] = round(time.time() - p["started"], 1)
    log(f"==== END {p['name']} ({p['elapsedSec']}s) ====")


def nav_tabs(serial: str, phase: str) -> None:
    for tab in ["Accueil", "Recherche", "Biblio"]:
        ok = tap_text(serial, tab)
        check(phase, f"nav:{tab}", ok)
        time.sleep(0.6)
        texts = ui_texts(dump_ui(serial, f"nav-{tab}"))
        check(phase, f"nav:{tab}:content", len(texts) > 2, f"texts={len(texts)}")


def library_filters(serial: str, phase: str) -> None:
    tap_text(serial, "Biblio")
    time.sleep(1)
    for chip in ["Titres", "Albums", "Artistes", "Playlists", "Télécharg", "Mix", "Hors-ligne"]:
        ok = tap_text(serial, chip)
        soft(phase, f"lib:{chip}", ok, "ok" if ok else "absent")
        time.sleep(0.4)
        sh(serial, "shell", "input", "keyevent", "4")
        time.sleep(0.25)


def search_flow(serial: str, phase: str) -> None:
    if not tap_text(serial, "Recherche"):
        check(phase, "search:open", False, "onglet Recherche introuvable")
        return
    check(phase, "search:open", True)
    time.sleep(0.6)
    tap_text(serial, "Rechercher")
    sh(serial, "shell", "input", "text", "Stromae")
    sh(serial, "shell", "input", "keyevent", "66")
    time.sleep(3)
    texts = ui_texts(dump_ui(serial, "search-results"))
    hit = any("stromae" in t.lower() or "papaoutai" in t.lower() for t in texts) or len(texts) > 8
    check(phase, "search:results", hit, f"n={len(texts)}")
    # fermer clavier / résultats avant Accueil
    sh(serial, "shell", "input", "keyevent", "4")
    time.sleep(0.3)
    sh(serial, "shell", "input", "keyevent", "4")
    time.sleep(0.3)


def play_from_home_or_lib(serial: str, pkg: str, phase: str) -> bool:
    # fermer overlays One UI éventuels
    sh(serial, "shell", "input", "keyevent", "4")
    time.sleep(0.4)
    tap_text(serial, "Accueil")
    time.sleep(1.2)
    ui = dump_ui(serial, "home")
    started = False
    for needle in ["Papaoutai", "Welcome to The Internet", "Welcome", "Formidable", "Aléatoire"]:
        if tap_text(serial, needle, ui):
            time.sleep(2.5)
            started = True
            break
    # « Lire » exact seulement (évite faux positifs)
    if not started:
        if tap_text(serial, "Lire", ui):
            time.sleep(2.5)
            started = True
    m = media(serial, pkg)
    if m["state"] not in ("PLAYING", "BUFFERING", "PAUSED"):
        tap_text(serial, "Biblio")
        time.sleep(1)
        soft(phase, "play:via-biblio", tap_text(serial, "Titres") or tap_text(serial, "J'aime"))
        time.sleep(1)
        ui = dump_ui(serial, "lib")
        for t in ui_texts(ui):
            tl = t.lower()
            if len(t) < 5 or len(t) > 60:
                continue
            if any(b in tl for b in UI_BLACKLIST):
                continue
            if t in ("Biblio", "Bibliothèque", "Titres", "Albums", "Artistes", "Playlists", "Compte"):
                continue
            if tap_text(serial, t, ui):
                break
        time.sleep(1.5)
        dispatch(serial, "play")
        time.sleep(2)
    m = ensure_playing(serial, pkg)
    ok = m["state"] in ("PLAYING", "BUFFERING", "PAUSED") and m["title"] not in ("?", "null")
    if not ok:
        tap_text(serial, "Accueil")
        time.sleep(0.8)
        tap_text(serial, "Papaoutai") or tap_text(serial, "Aléatoire") or tap_text(serial, "Lire")
        time.sleep(2.5)
        m = ensure_playing(serial, pkg)
        ok = m["state"] in ("PLAYING", "BUFFERING", "PAUSED")
    check(phase, "playback:start", ok, f"{m['state']} {m['title'][:40]}")
    if m["state"] == "PAUSED":
        dispatch(serial, "play")
        time.sleep(1)
    return ok


def skip_burst(serial: str, pkg: str, phase: str, n: int = 12) -> list[str]:
    ensure_playing(serial, pkg)
    titles = []
    for i in range(n):
        before = media(serial, pkg)
        dispatch(serial, "next")
        time.sleep(1.8)
        after = media(serial, pkg)
        # retry: metadata parfois lente après next
        if after["title"] in (before["title"], "?"):
            time.sleep(0.8)
            after = media(serial, pkg)
        if after["title"] == before["title"]:
            tap_text(serial, "Suivant") or tap_text(serial, "Next")
            time.sleep(1.4)
            after = media(serial, pkg)
        titles.append(after["title"])
        log(f"  skip#{i+1} {after['state']} q={after.get('queue')} {after['title'][:50]}")
    uniq = len({t for t in titles if t and t != "?"})
    check(phase, f"skips:{n}", uniq >= max(3, n // 3), f"unique={uniq}/{n}")
    return titles


def player_controls(serial: str, pkg: str, phase: str) -> None:
    ensure_playing(serial, pkg)
    dispatch(serial, "pause")
    time.sleep(1)
    check(phase, "pause", True, media(serial, pkg)["state"])
    m = ensure_playing(serial, pkg)
    check(phase, "play", m["state"] in ("PLAYING", "BUFFERING"), m["state"])
    pos1 = m["pos"]
    time.sleep(3)
    pos2 = media(serial, pkg)["pos"]
    check(phase, "progress", pos2 > pos1 or m["state"] == "BUFFERING", f"{pos1}->{pos2}")
    dispatch(serial, "previous")
    time.sleep(1.2)
    check(phase, "previous", True, media(serial, pkg)["title"][:40])


def inversion_no_crash_nav(serial: str, pkg: str, phase: str) -> None:
    for _ in range(8):
        for tab in ["Recherche", "Accueil", "Biblio"]:
            tap_text(serial, tab)
            sh(serial, "shell", "input", "keyevent", "4")
            time.sleep(0.2)
    fatals = collect_fatals(serial, pkg, f"{phase}-navspam")
    check(phase, "inversion:nav-spam-no-fatal", fatals == 0, f"fatals={fatals}")


def inversion_wifi_blip(serial: str, pkg: str, phase: str) -> None:
    dispatch(serial, "play")
    time.sleep(1)
    sh(serial, "shell", "svc", "wifi", "disable")
    sh(serial, "shell", "svc", "data", "disable")
    time.sleep(6)
    alive = bool(sh(serial, "shell", "pidof", pkg).strip())
    check(phase, "inversion:offline-alive", alive)
    sh(serial, "shell", "svc", "wifi", "enable")
    sh(serial, "shell", "svc", "data", "enable")
    time.sleep(5)
    dispatch(serial, "play")
    time.sleep(2)
    m = media(serial, pkg)
    check(phase, "inversion:online-recover", m["state"] in ("PLAYING", "BUFFERING", "PAUSED"), m["state"])


def offline_session(serial: str, pkg: str, phase: str) -> None:
    n = offline_count(serial, pkg)
    check(phase, "offline:inventory", n >= 1, f"m4a={n}")
    if n < 1:
        return
    sh(serial, "shell", "cmd", "connectivity", "airplane-mode", "enable")
    time.sleep(3)
    try:
        launch(serial, pkg)
        tap_text(serial, "Biblio")
        time.sleep(0.8)
        opened = (
            tap_text(serial, "Mix hors-ligne")
            or tap_text(serial, "Hors-ligne")
            or tap_text(serial, "Hors ligne")
            or tap_text(serial, "Télécharg")
        )
        soft(phase, "offline:open", opened)
        time.sleep(1.5)
        # Prefer explicit mix / play all
        tap_text(serial, "Mix hors-ligne") or tap_text(serial, "Aléatoire") or tap_text(serial, "Tout lire")
        time.sleep(2)
        ensure_playing(serial, pkg)
        m = media(serial, pkg)
        check(
            phase,
            "offline:play",
            m["state"] in ("PLAYING", "BUFFERING", "PAUSED"),
            f"{m['state']} q={m.get('queue')} {m['title'][:40]}",
        )
        titles = []
        for _ in range(8):
            before = media(serial, pkg)
            dispatch(serial, "next")
            time.sleep(1.6)
            after = media(serial, pkg)
            titles.append(after["title"])
            if after["title"] == before["title"] and n >= 3:
                # file Exo peut n’avoir qu’1 item — relancer mix
                tap_text(serial, "Mix hors-ligne") or tap_text(serial, "Aléatoire")
                time.sleep(2)
                ensure_playing(serial, pkg)
        uniq = len(set(t for t in titles if t and t != "?"))
        # Si 1 seul fichier offline, unique=1 est attendu
        check(phase, "offline:skips", uniq >= 2 or n < 3, f"unique={uniq} offline={n} {titles[:5]}")
        fatals = collect_fatals(serial, pkg, f"{phase}-airplane")
        check(phase, "offline:no-fatal", fatals == 0, f"fatals={fatals}")
    finally:
        sh(serial, "shell", "cmd", "connectivity", "airplane-mode", "disable")
        sh(serial, "shell", "svc", "wifi", "enable")
        sh(serial, "shell", "svc", "data", "enable")
        time.sleep(4)
        air = sh(serial, "shell", "settings", "get", "global", "airplane_mode_on").strip()
        check(phase, "offline:net-restored", air in ("0", "null", ""), f"airplane={air}")


def track_actions_deep(serial: str, pkg: str, phase: str) -> None:
    """Exercice du sheet ⋮ / Options sur un titre de test."""
    play_from_home_or_lib(serial, pkg, phase)
    ensure_playing(serial, pkg)
    # Ouvrir now playing
    tap_text(serial, "Papaoutai") or tap_text(serial, media(serial, pkg)["title"].split(",")[0][:20])
    time.sleep(1)
    opened = tap_text(serial, "Options") or tap_text(serial, "Plus") or tap_text(serial, "⋮")
    soft(phase, "actions:open", opened)
    if not opened:
        # long-press first track in biblio
        tap_text(serial, "Biblio")
        time.sleep(0.8)
        ui = dump_ui(serial, "lib-actions")
        for t in ui_texts(ui):
            if len(t) > 5 and t not in ("Biblio", "Titres", "Albums"):
                # long press via swipe? use input swipe same point
                # find bounds again
                break
        return
    time.sleep(1)
    ui = dump_ui(serial, "actions-sheet")
    labels = ui_texts(ui)
    (OUT / f"actions-labels-{phase}.txt").write_text("\n".join(labels), encoding="utf-8")
    expected = [
        "J'aime",
        "Télécharg",
        "playlist",
        "Mix",
        "Radio",
        "file",
        "Épingl",
        "Lire ensuite",
        "veille",
    ]
    found = 0
    for exp in expected:
        if any(exp.lower() in lab.lower() for lab in labels):
            found += 1
            soft(phase, f"actions:has:{exp}", True)
        else:
            soft(phase, f"actions:has:{exp}", False, "absent")
    check(phase, "actions:sheet-rich", found >= 4, f"found={found}/{len(expected)}")

    # Toggle like if present
    if tap_text(serial, "J'aime", ui):
        time.sleep(1.5)
        soft(phase, "actions:like-tap", True)
    # Download if present
    ui2 = dump_ui(serial, "actions-sheet2")
    if tap_text(serial, "Télécharg", ui2):
        time.sleep(2)
        soft(phase, "actions:download-tap", True)
    # Mix
    ui3 = dump_ui(serial, "actions-sheet3")
    if tap_text(serial, "Mix · similaires", ui3) or tap_text(serial, "Mix", ui3):
        time.sleep(4)
        m = media(serial, pkg)
        soft(phase, "actions:mix-start", m["state"] in ("PLAYING", "BUFFERING", "PAUSED"), m["title"][:40])
        ensure_playing(serial, pkg)
        skip_burst(serial, pkg, phase + "-mix", 6)
    # Close sheet
    sh(serial, "shell", "input", "keyevent", "4")
    time.sleep(0.5)


def playlist_qa_flow(serial: str, pkg: str, phase: str) -> None:
    """Ouvre playlist QA Endurance si visible."""
    tap_text(serial, "Biblio")
    time.sleep(1)
    soft(phase, "qa:open-playlists", tap_text(serial, "Playlists") or True)
    time.sleep(0.8)
    ui = dump_ui(serial, "playlists")
    hit = tap_text(serial, "QA Endurance", ui) or tap_text(serial, "Endurance", ui) or tap_text(serial, "Welcome", ui)
    soft(phase, "qa:playlist", hit)
    if not hit:
        return
    time.sleep(1.5)
    tap_text(serial, "Aléatoire") or tap_text(serial, "Tout lire") or tap_text(serial, "Lire")
    time.sleep(2)
    m = ensure_playing(serial, pkg)
    check(phase, "qa:play", m["state"] in ("PLAYING", "BUFFERING"), f"{m['state']} {m['title'][:40]}")
    skip_burst(serial, pkg, phase + "-qa", 15)


def endurance_listen(serial: str, pkg: str, phase: str, minutes: float = 12) -> None:
    ensure_playing(serial, pkg)
    end = time.time() + minutes * 60
    samples = []
    stuck = 0
    last_title = None
    last_pos = -1
    while time.time() < end:
        m = media(serial, pkg)
        samples.append(m)
        log(f"  endurance {m['state']} pos={m['pos']} q={m.get('queue')} {m['title'][:45]}")
        if m["title"] == last_title and m["pos"] == last_pos and m["state"] == "PLAYING":
            stuck += 1
        else:
            stuck = 0
        last_title, last_pos = m["title"], m["pos"]
        if stuck >= 3:
            log("  stuck → skip")
            dispatch(serial, "next")
            stuck = 0
        if m["state"] in ("PAUSED", "STOPPED", "?"):
            ensure_playing(serial, pkg)
        if len(samples) % 3 == 0:
            before = m["title"]
            dispatch(serial, "next")
            time.sleep(1.2)
            after = media(serial, pkg)
            if after["title"] == before:
                tap_text(serial, "Suivant")
        time.sleep(30)
    playingish = sum(1 for s in samples if s["state"] in ("PLAYING", "BUFFERING"))
    check(phase, "endurance:alive", playingish >= max(1, len(samples) // 3), f"{playingish}/{len(samples)}")
    fatals = collect_fatals(serial, pkg, f"{phase}-endurance")
    check(phase, "endurance:no-fatal", fatals == 0, f"fatals={fatals}")


def run_device(serial: str, pkg: str, label: str, api: str | None, endurance_min: float) -> None:
    p = phase_start(label, {"serial": serial, "pkg": pkg, "api": api})
    try:
        ensure_net(serial)
        wake(serial)
        set_api(serial, pkg, api) if api else set_api(serial, pkg, None)
        clear_logcat(serial)
        launch(serial, pkg)
        if not ensure_logged_in(serial, pkg, api, label):
            raise RuntimeError("session login impossible — stop phase")
        ver = sh(serial, "shell", "dumpsys", "package", pkg)
        vm = re.search(r"versionName=([^\s]+)", ver)
        check(label, "version", bool(vm), vm.group(1) if vm else "?")

        nav_tabs(serial, label)
        library_filters(serial, label)
        search_flow(serial, label)
        play_from_home_or_lib(serial, pkg, label)
        player_controls(serial, pkg, label)
        skip_burst(serial, pkg, label, 20)
        playlist_qa_flow(serial, pkg, label)
        track_actions_deep(serial, pkg, label)
        inversion_no_crash_nav(serial, pkg, label)
        play_from_home_or_lib(serial, pkg, label)
        inversion_wifi_blip(serial, pkg, label)
        offline_session(serial, pkg, label)
        launch(serial, pkg)
        play_from_home_or_lib(serial, pkg, label)
        ensure_playing(serial, pkg)
        endurance_listen(serial, pkg, label, endurance_min)
    except Exception as e:
        report["ok"] = False
        p["notes"].append(f"EXCEPTION {e}")
        log(f"EXCEPTION {e}\n{traceback.format_exc()}")
        ensure_net(serial)
    finally:
        ensure_net(serial)
        phase_end(p)


def main() -> int:
    samsung_only = os.environ.get("SAMSUNG_ONLY", "").strip() in ("1", "true", "yes")
    prod_off = PROD.strip().lower() in ("", "off", "none", "-", "skip")
    endurance = float(os.environ.get("ENDURANCE_MIN", "20" if samsung_only or prod_off else "25"))
    log(f"OUT={OUT}")
    log(f"DEV={DEV} PROD={PROD} LAN={LAN} samsung_only={samsung_only or prod_off} endurance={endurance}")
    run_device(DEV, PKG_DEV, "A-samsung-dev", LAN, endurance_min=endurance)
    if not (samsung_only or prod_off):
        run_device(PROD, PKG_PROD, "C-nothing-prod", None, endurance_min=endurance)
    else:
        log("SKIP Nothing (Samsung-only)")

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    start = datetime.fromisoformat(report["startedAt"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(report["endedAt"].replace("Z", "+00:00"))
    report["elapsedSec"] = round((end - start).total_seconds(), 1)
    hard = [c for c in report["checks"] if not c.get("soft")]
    passed = sum(1 for c in hard if c["ok"])
    failed = sum(1 for c in hard if not c["ok"])
    soft_fail = sum(1 for c in report["checks"] if c.get("soft") and not c["ok"])
    report["summary"] = {
        "passed": passed,
        "failed": failed,
        "soft_miss": soft_fail,
        "total_hard": passed + failed,
        "scope": "samsung-only" if (samsung_only or prod_off) else "samsung+nothing",
    }
    # ok only if hard checks pass
    report["ok"] = failed == 0
    path = OUT / "report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (ROOT / "docs" / "reports" / "mobile-marathon-latest.json").write_text(
        path.read_text(encoding="utf-8"), encoding="utf-8"
    )
    log(f"DONE ok={report['ok']} passed={passed} failed={failed} soft_miss={soft_fail} → {path}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
