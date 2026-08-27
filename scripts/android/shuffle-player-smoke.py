#!/usr/bin/env python3
"""Smoke court : Aléatoire biblio + ouverture lecteur + spam contrôles (pas d’endurance).

Usage:
  DEVICE=192.168.1.184:5555 PKG=ovh.delhomme.ytmusic.dev \\
    python3 -u scripts/android/shuffle-player-smoke.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

DEV = os.environ.get("DEVICE") or os.environ.get("ANDROID_SERIAL") or ""
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic.dev")
LOGIN_EMAIL = os.environ.get("LOGIN_EMAIL", "dev@delhomme.ovh")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")
# Si 1 : login API (.env VITE_DEV_PASSWORD / SEED_PASSWORD) + injection intent (fiable)
LOGIN_VIA_API = os.environ.get("LOGIN_VIA_API", "1") == "1"
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "logs" / "smoke" / f"shuffle-player-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{re.sub(r'[^a-zA-Z0-9]+', '_', DEV)[:24]}"
OUT.mkdir(parents=True, exist_ok=True)


def sh(*args: str, timeout: int = 45) -> str:
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
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def mute() -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")


def dump_ui() -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-smoke.xml")
    return sh("shell", "cat", "/sdcard/ui-smoke.xml")


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


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "queue": -1, "score": -1}
    state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3500]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        # Samsung dumpsys: state=PLAYING(3) ; d'autres : state=3
        st = re.search(r"state=PlaybackState\s*\{state=(?:([A-Z_]+)\()?(\d+)", chunk)
        md = re.search(r"metadata:.*description=(.*?)(?:,|\n|$)", chunk)
        q = re.search(r"Queue Size:\s*(\d+)", chunk) or re.search(r"queue size\s*=\s*(\d+)", chunk, re.I)
        if not st:
            continue
        state_num = int(st.group(2))
        state = state_map.get(state_num, st.group(1) or str(state_num))
        pos_m = re.search(r"position=(\d+)", chunk[st.start() : st.start() + 220])
        pos = int(pos_m.group(1)) if pos_m else -1
        title = (md.group(1).strip() if md else "?")[:80]
        queue = int(q.group(1)) if q else -1
        score = (10 if state == "PLAYING" else 5 if state == "BUFFERING" else 1) + (1 if pos > 0 else 0)
        cand = {"title": title, "state": state, "pos": pos, "queue": queue, "score": score}
        if cand["score"] > best["score"]:
            best = cand
    return best


def dispatch(action: str) -> None:
    out = sh("shell", "cmd", "media_session", "dispatch", action)
    if "inaccessible" in out or "No shell command" in out:
        key = {"next": "87", "previous": "88", "pause": "127", "play": "126"}.get(action, "85")
        sh("shell", "input", "keyevent", key)


def wait_playing(timeout_s: float = 12.0) -> dict:
    t0 = time.time()
    last = session()
    while time.time() - t0 < timeout_s:
        last = session()
        if last["state"] in ("PLAYING", "BUFFERING") and last["title"] not in ("?", ""):
            return {**last, "ttfb_s": round(time.time() - t0, 2)}
        time.sleep(0.35)
    return {**last, "ttfb_s": round(time.time() - t0, 2)}


def dismiss_chrome() -> None:
    xml = dump_ui()
    for label in ("Ne pas autoriser", "Deny", "CLOSE", "Fermer", "OK", "Autoriser"):
        if tap_text(xml, label):
            time.sleep(0.6)
            xml = dump_ui()


def inject_session_from_api() -> bool:
    """Login HTTP avec VITE_DEV_PASSWORD/.env puis extras MainActivity."""
    import urllib.request

    email = os.environ.get("SEED_EMAIL") or os.environ.get("LOGIN_EMAIL") or LOGIN_EMAIL
    password = (
        LOGIN_PASSWORD
        or os.environ.get("VITE_DEV_PASSWORD")
        or os.environ.get("SEED_PASSWORD")
        or ""
    )
    if not password:
        # charge .env à la racine si dispo
        env_path = ROOT / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("VITE_DEV_PASSWORD=") or line.startswith("SEED_PASSWORD="):
                    password = line.split("=", 1)[1].strip().strip('"').strip("'")
                if line.startswith("SEED_EMAIL=") and not os.environ.get("SEED_EMAIL"):
                    email = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not password:
        log("  no password for API login")
        return False
    try:
        req = urllib.request.Request(
            f"{API}/api/auth/login",
            data=json.dumps({"email": email, "password": password}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        log(f"  api login error: {e}")
        return False
    token = d.get("token") or ""
    refresh = d.get("refreshToken") or d.get("refresh_token") or ""
    if not token:
        log(f"  api login failed: {d}")
        return False
    log(f"  api login ok token_len={len(token)}")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.3)
    args = [
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
        "--es",
        "ytm_access_token",
        token,
    ]
    if refresh:
        args += ["--es", "ytm_refresh_token", refresh]
    sh(*args)
    time.sleep(2.5)
    dismiss_chrome()
    time.sleep(0.8)
    dismiss_chrome()
    return True


def ensure_logged_in() -> bool:
    """Session via API inject (défaut) ou écran login UI."""
    xml = dump_ui()
    dismiss_chrome()
    xml = dump_ui()
    if "Biblio" in xml or "Bibliothèque" in xml or "Accueil" in xml:
        return True
    if LOGIN_VIA_API:
        if inject_session_from_api():
            xml = dump_ui()
            dismiss_chrome()
            xml = dump_ui()
            if "Biblio" in xml or "Bibliothèque" in xml or "Accueil" in xml:
                return True
        return False
    if "Se connecter" not in xml and "Email" not in xml and "Mot de passe" not in xml:
        return True
    if LOGIN_PASSWORD:
        log(f"  login screen → override password for {LOGIN_EMAIL}")
        for m in re.finditer(
            r'password="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            x1, y1, x2, y2 = map(int, m.groups())
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            sh("shell", "input", "tap", str(x), str(y))
            time.sleep(0.25)
            for _ in range(32):
                sh("shell", "input", "keyevent", "67")
            time.sleep(0.15)
            sh("shell", "input", "text", LOGIN_PASSWORD.replace(" ", "%s"))
            time.sleep(0.3)
            break
        xml = dump_ui()
    else:
        log("  login screen → Se connecter (mdp BuildConfig)")
    if not tap_text(xml, "Se connecter"):
        return False
    for _ in range(25):
        time.sleep(1.0)
        dismiss_chrome()
        xml = dump_ui()
        if "Biblio" in xml or "Bibliothèque" in xml or "Accueil" in xml:
            return True
        if "incorrect" in xml.lower() or "Identifiants" in xml:
            log("  login failed (credentials)")
            return False
    return "Biblio" in dump_ui() or "Accueil" in dump_ui()


def start_shuffle() -> dict:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    mute()
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.4)
    sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2.8)
    if not ensure_logged_in():
        return {"ok": False, "error": "login impossible"}
    time.sleep(1.0)
    xml = dump_ui()
    tap_text(xml, "Biblio") or tap_text(xml, "Bibliothèque", contains=True)
    time.sleep(1.3)
    xml = dump_ui()
    tap_text(xml, "Titres")
    time.sleep(1.0)
    xml = dump_ui()
    t_click = time.time()
    ok = tap_text(xml, "Aléatoire") or tap_text(xml, "Aléatoire", contains=True)
    if not ok:
        return {"ok": False, "error": "Aléatoire introuvable", "xml_len": len(xml)}
    s = wait_playing(14.0)
    mute()
    return {
        "ok": s["state"] in ("PLAYING", "BUFFERING"),
        "click_to_play_s": round(time.time() - t_click, 2),
        **s,
    }


def open_now_playing_and_spam() -> dict:
    """Ouvre le mini-lecteur puis spam next/pause — ne doit pas refermer / jouer un autre titre biblio."""
    xml = dump_ui()
    before = session()
    opened = False
    title = (before.get("title") or "").split(",")[0].strip()

    def tap_xy(x: int, y: int, why: str) -> None:
        nonlocal opened
        log(f"  open player {why} @{x},{y}")
        sh("shell", "input", "tap", str(x), str(y))
        opened = True

    # 1) content-desc = titre courant (bandeau mini)
    if title and title != "?":
        for m in re.finditer(
            r'content-desc="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            if m.group(1) == title or title[:10] in m.group(1):
                x1, y1, x2, y2 = map(int, m.groups()[1:])
                if y1 > 1200:
                    tap_xy((x1 + x2) // 2, (y1 + y2) // 2, f"desc {m.group(1)!r}")
                    break
    # 2) à gauche du bouton Pause / Lecture du mini-player
    if not opened:
        for m in re.finditer(
            r'content-desc="(Pause|Lecture|Play)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            x1, y1, x2, y2 = map(int, m.groups()[1:])
            if y1 > 1400:
                tap_xy(max(80, x1 - 280), (y1 + y2) // 2, f"left-of {m.group(1)}")
                break
    # 3) texte titre en bas d’écran
    if not opened and title and title != "?":
        for m in re.finditer(
            r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            if title[:10] in m.group(1) or m.group(1) == title:
                x1, y1, x2, y2 = map(int, m.groups()[1:])
                if y1 > 1400:
                    tap_xy((x1 + x2) // 2, (y1 + y2) // 2, f"text {m.group(1)!r}")
                    break
    if not opened:
        size = sh("shell", "wm", "size")
        m = re.search(r"(\d+)x(\d+)", size)
        w, h = (int(m.group(1)), int(m.group(2))) if m else (1080, 2400)
        tap_xy(w // 2, int(h * 0.79), "fallback")
    time.sleep(0.45)
    size = sh("shell", "wm", "size")
    m = re.search(r"(\d+)x(\d+)", size)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1080, 2400)
    cy = int(h * 0.80)
    for _ in range(8):
        sh("shell", "input", "tap", str(int(w * 0.72)), str(cy))
        time.sleep(0.05)
        sh("shell", "input", "tap", str(int(w * 0.5)), str(cy))
        time.sleep(0.05)
    time.sleep(1.0)
    after = session()
    xml2 = dump_ui()
    texts = [m.group(1) for m in re.finditer(r'text="([^"]+)"', xml2) if m.group(1).strip()]
    nav_visible = "Accueil" in texts and "Biblio" in texts
    still_player = (not nav_visible) or ("En cours" in texts) or any(
        t.lower() in ("paroles", "vitesse", "égaliseur") for t in texts
    )
    biblio_exposed = nav_visible and not still_player
    return {
        "before_title": before.get("title"),
        "after_title": after.get("title"),
        "after_state": after.get("state"),
        "player_sheet_likely": still_player,
        "biblio_clickthrough": biblio_exposed,
        "nav_visible": nav_visible,
        "ok": after.get("state") in ("PLAYING", "BUFFERING", "PAUSED") and not biblio_exposed,
    }


def main() -> None:
    if not DEV:
        raise SystemExit("DEVICE required")
    log(f"START device={DEV} pkg={PKG} out={OUT}")
    sh("logcat", "-c")
    mute()
    shuffle = start_shuffle()
    log(f"SHUFFLE {json.dumps(shuffle, ensure_ascii=False)}")
    spam = {"ok": False, "skipped": True}
    if shuffle.get("ok"):
        time.sleep(1.0)
        spam = open_now_playing_and_spam()
        log(f"PLAYER_SPAM {json.dumps(spam, ensure_ascii=False)}")
        # 3 skips rapides + reprise
        for _ in range(3):
            dispatch("next")
            time.sleep(1.4)
            mute()
        s = wait_playing(8.0)
        log(f"AFTER_SKIPS {json.dumps(s, ensure_ascii=False)}")
        spam["after_skips"] = s
        spam["ok"] = spam.get("ok") and s.get("state") in ("PLAYING", "BUFFERING", "PAUSED")
    report = {
        "device": DEV,
        "pkg": PKG,
        "shuffle": shuffle,
        "player_spam": spam,
        "pass": bool(shuffle.get("ok")) and bool(spam.get("ok")),
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"PASS={report['pass']} report={OUT / 'report.json'}")
    raise SystemExit(0 if report["pass"] else 1)


if __name__ == "__main__":
    main()
