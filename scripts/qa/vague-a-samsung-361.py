#!/usr/bin/env python3
"""Vague A lab — Samsung USB only. STREAM_MUSIC=0. Pas Nothing. Pas d’injection email."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

SERIAL = os.environ.get("DEVICE", "R5CT7263YJL")
PKG = "cloud.hubera.music"
LEGACY = "ovh.delhomme.ytmusic"
CAP = Path(
    os.environ.get(
        "CAP_DIR",
        "/home/pactivisme/Documents/Dev/Perso/HuberaCloud/products/docs/content/reports/captures/music",
    )
)
STAMP = datetime.now().strftime("%Y-%m-%d")
CAP.mkdir(parents=True, exist_ok=True)
TMP_XML = "/sdcard/hubera-vague-a.xml"
LOCAL_XML = "/tmp/hubera-vague-a.xml"
results: list[str] = []


def adb(*args: str, timeout: int = 40) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["adb", "-s", SERIAL, *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def log(msg: str) -> None:
    print(msg, flush=True)
    results.append(msg)


def shot(name: str) -> Path:
    dest = CAP / f"{STAMP}-samsung-{name}.png"
    raw = subprocess.run(
        ["adb", "-s", SERIAL, "exec-out", "screencap", "-p"],
        capture_output=True,
        timeout=40,
    )
    dest.write_bytes(raw.stdout or b"")
    log(f"SHOT {dest} ({dest.stat().st_size} bytes)")
    return dest


def dump_xml() -> str:
    adb("shell", "uiautomator", "dump", TMP_XML)
    adb("pull", TMP_XML, LOCAL_XML)
    p = Path(LOCAL_XML)
    return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""


def nodes(xml: str):
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return
    for n in root.iter("node"):
        t = n.attrib.get("text") or ""
        d = n.attrib.get("content-desc") or ""
        hint = n.attrib.get("hint") or ""
        b = n.attrib.get("bounds") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b)
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        yield t, d, hint, (x1, y1, x2, y2)


def tap_xy(x: int, y: int) -> None:
    adb("shell", "input", "tap", str(x), str(y))


def tap_label(*needles: str) -> bool:
    xml = dump_xml()
    nset = [n.lower() for n in needles]
    for t, d, hint, (x1, y1, x2, y2) in nodes(xml) or []:
        hay = f"{t} {d} {hint}".lower()
        if any(n in hay for n in nset):
            tap_xy((x1 + x2) // 2, (y1 + y2) // 2)
            log(f"  tap {t or d or hint!r}")
            return True
    return False


def has_any(*needles: str) -> bool:
    xml = dump_xml()
    nset = [n.lower() for n in needles]
    for t, d, hint, _ in nodes(xml) or []:
        hay = f"{t} {d} {hint}".lower()
        if any(n in hay for n in nset):
            return True
    return False


def type_text(s: str) -> None:
    escaped = s.replace(" ", "%s")
    adb("shell", "input", "text", escaped)


def media_pos() -> tuple[int, int, str]:
    out = adb("shell", "dumpsys", "media_session").stdout
    pos = -1
    state = ""
    uri = ""
    grab = False
    for line in out.splitlines():
        if PKG in line or LEGACY in line:
            grab = True
        if not grab:
            continue
        if "PlaybackState" in line or "state=" in line.lower():
            m = re.search(r"position=(-?\d+)", line)
            if m:
                pos = int(m.group(1))
            sm = re.search(r"state=(\w+)", line)
            if sm:
                state = sm.group(1)
        if "description=" in line or "mediaUri" in line or "file://" in line:
            uri += line.strip() + " | "
        if line.strip().startswith("active=") and grab and pos >= 0:
            break
    logcat = adb("logcat", "-d", "-t", "80", "-s", "PlaybackService:I", "YTMVideo:I", "offline:I").stdout
    if "file://" in logcat and "file://" not in uri:
        uri += "logcat-file:// "
    return pos, (1 if "Playing" in state or state in {"3", "STATE_PLAYING"} else 0), uri[:240]


def offline_files() -> list[str]:
    r = adb("shell", "run-as", PKG, "ls", "-l", "files/offline")
    lines = [ln.strip() for ln in (r.stdout or r.stderr or "").splitlines() if ln.strip()]
    log("offline files:\n  " + "\n  ".join(lines[:30]))
    return lines


def wake() -> None:
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    adb("shell", "wm", "dismiss-keyguard")
    adb("shell", "svc", "power", "stayon", "usb")


def grant_perms() -> None:
    for perm in (
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.GET_ACCOUNTS",
        "android.permission.RECORD_AUDIO",
        "android.permission.CAMERA",
        "android.permission.USE_BIOMETRIC",
        "android.permission.USE_FINGERPRINT",
    ):
        r = adb("shell", "pm", "grant", PKG, perm)
        if r.returncode != 0:
            log(f"  grant {perm}: {(r.stderr or r.stdout or '').strip()[:120]}")
    log("permissions granted (runtime + biometric)")


def skip_biometrics() -> None:
    for _ in range(4):
        if has_any(
            "empreinte",
            "Face ID",
            "biométr",
            "Biometric",
            "Utiliser le code",
            "Utiliser le mot de passe",
            "Passer",
            "Skip",
        ):
            if tap_label(
                "Annuler",
                "Passer",
                "Skip",
                "Utiliser le code",
                "Utiliser le mot de passe",
                "Not now",
                "Plus tard",
            ):
                log("skip biometric prompt")
                time.sleep(0.6)
                continue
            adb("shell", "input", "keyevent", "4")
            log("skip biometric via BACK")
            time.sleep(0.5)
            continue
        break


def m4a_count(lines: list[str]) -> int:
    return sum(
        1
        for ln in lines
        if ".m4a" in ln and ".part" not in ln and not ln.endswith("offline")
    )


def swipe_find_download() -> bool:
    for _ in range(4):
        if tap_label("Télécharger"):
            return True
        adb("shell", "input", "swipe", "900", "1450", "200", "1450", "250")
        time.sleep(0.35)
    return tap_label("Télécharger")


def restore_net() -> None:
    adb("shell", "svc", "wifi", "enable")
    adb("shell", "svc", "data", "enable")
    adb("shell", "cmd", "connectivity", "airplane-mode", "disable")


def main() -> int:
    log(f"==> Vague A Samsung {SERIAL} pkg={PKG}")
    wake()
    grant_perms()
    adb("shell", "media", "volume", "--stream", "3", "--set", "0")
    adb("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    alarm = adb("shell", "settings", "get", "system", "volume_alarm_speaker").stdout.strip()
    music = adb("shell", "settings", "get", "system", "volume_music_speaker").stdout.strip()
    log(f"STREAM_MUSIC=0 speaker={music} STREAM_ALARM speaker={alarm}")

    adb("shell", "am", "force-stop", PKG)
    time.sleep(0.6)
    adb(
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
    )
    time.sleep(5)
    skip_biometrics()
    shot("launch")
    if has_any("Mot de passe", "Connexion", "Se connecter", "Hubera ID", "Continuer avec"):
        log("WARN écran login — pas d’injection email. On continue si biblio déjà là.")
        shot("login")

    # Search FTS
    if not tap_label("Recherche", "Search"):
        # bottom nav often 2nd tab
        tap_xy(324, 2200)
        time.sleep(0.8)
    time.sleep(1.2)
    xml = dump_xml()
    focused = False
    try:
        root = ET.fromstring(xml)
        for n in root.iter("node"):
            cls = n.attrib.get("class", "")
            hint = (n.attrib.get("hint") or "") + (n.attrib.get("text") or "")
            if cls.endswith("EditText") or "artistes" in hint.lower():
                b = n.attrib.get("bounds") or ""
                m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b)
                if m:
                    x1, y1, x2, y2 = map(int, m.groups())
                    tap_xy((x1 + x2) // 2, (y1 + y2) // 2)
                    focused = True
                    break
    except ET.ParseError:
        pass
    if not focused:
        tap_label("Titres, artistes")
    time.sleep(0.4)
    type_text("brel")
    t_fts = time.time()
    adb("shell", "input", "keyevent", "66")
    found_fts = False
    for _ in range(12):
        time.sleep(0.35)
        xml_fts = dump_xml()
        for t, d, hint, (x1, y1, x2, y2) in nodes(xml_fts) or []:
            hay = f"{t} {d}".lower()
            if y1 > 280 and (
                "amsterdam" in hay or "jacques brel" in hay or (hay.strip() not in {"brel", ""} and "brel" in hay)
            ):
                found_fts = True
                break
        if found_fts:
            break
    fts_ms = int((time.time() - t_fts) * 1000)
    shot("search-fts-brel")
    log(f"FTS brel {'PASS' if found_fts else 'FAIL'} in {fts_ms} ms")
    xml = dump_xml()
    played = False
    for t, d, hint, (x1, y1, x2, y2) in nodes(xml) or []:
        hay = f"{t} {d}".lower()
        if "amsterdam" in hay or "jacques brel" in hay or "brel" in hay:
            if y1 > 200:
                tap_xy((x1 + x2) // 2, (y1 + y2) // 2)
                played = True
                log(f"play {t or d!r}")
                break
    if not played:
        # first result row below search field
        tap_xy(540, 720)
        log("play fallback tap 540,720")
    time.sleep(3.5)
    shot("play-online")

    # Open now playing then download (Amsterdam)
    tap_xy(540, 2050)
    time.sleep(1.2)
    if not swipe_find_download():
        log("BLOCKER now-playing: pas de bouton Télécharger visible — ⋮ sheet")
        tap_label("Plus d'options", "Plus")
        time.sleep(0.5)
        swipe_find_download()
    time.sleep(2)
    shot("download-amsterdam")

    # Second track: Biblio → ⋮ → Télécharger
    adb("shell", "input", "keyevent", "4")
    time.sleep(0.4)
    if not tap_label("Biblio", "Bibliothèque"):
        tap_xy(756, 2200)
    time.sleep(1.4)
    shot("biblio")
    if not tap_label("Plus d'options"):
        # overflow on first row, right side
        tap_xy(980, 620)
        log("overflow fallback tap 980,620")
    time.sleep(0.8)
    if not tap_label("Télécharger"):
        log("BLOCKER biblio sheet: Télécharger absent")
        shot("download-biblio-blocker")
    else:
        time.sleep(1.2)
        shot("download-biblio")

    # Wait for ≥2 .m4a
    files_ok = False
    n_m4a = 0
    for i in range(36):
        lines = offline_files()
        n_m4a = m4a_count(lines)
        if n_m4a >= 2:
            files_ok = True
            break
        time.sleep(5)
    log(f"DOWNLOAD_FILES={'PASS' if files_ok else 'FAIL'} count={n_m4a} (want ≥2)")

    offline_pass = False
    # Offline
    try:
        adb("shell", "svc", "wifi", "disable")
        adb("shell", "svc", "data", "disable")
        time.sleep(2)
        shot("offline-before-play")
        tap_label("Lecture", "Play") or tap_xy(540, 1900)
        time.sleep(4)
        p0, playing0, uri0 = media_pos()
        time.sleep(6)
        p1, playing1, uri1 = media_pos()
        uri = uri0 + uri1
        logcat = adb("logcat", "-d", "-t", "200").stdout
        fileish = "file://" in uri or "file://" in logcat or "scheme=file" in logcat or ":file" in logcat
        recable = "/api/stream" in uri and "file://" in (uri + logcat)
        advancing = p1 > p0 + 800
        shot("offline-play")
        offline_pass = files_ok and fileish and advancing and not recable
        log(
            f"OFFLINE pos {p0}->{p1} fileish={fileish} recable={recable} "
            f"advancing={advancing} PASS={offline_pass}"
        )
    finally:
        restore_net()
        time.sleep(4)
        shot("network-restored")

    # Compte OTA
    adb("shell", "input", "keyevent", "4")
    time.sleep(0.4)
    adb("shell", "input", "keyevent", "4")
    time.sleep(0.5)
    if not tap_label("Compte"):
        tap_xy(1000, 160)
    time.sleep(1.8)
    shot("compte-ota")

    # Video clip A/V — if surface exists
    adb("shell", "input", "keyevent", "4")
    time.sleep(0.5)
    tap_xy(540, 2050)
    time.sleep(1.0)
    av = "SKIP"
    if tap_label("Vidéo"):
        time.sleep(3)
        shot("video-clip")
        samples = []
        recable = False
        t_end = time.time() + 34
        while time.time() < t_end:
            p, _, u = media_pos()
            samples.append(p)
            if "/api/stream" in u and "file://" in u:
                recable = True
            lc = adb("logcat", "-d", "-t", "40", "-s", "YTMVideo:I", "YTMVideo:E", "PlaybackService:I").stdout
            if "rebindCurrentStream" in lc and "file://" in lc:
                recable = True
            time.sleep(4)
        span = (samples[-1] - samples[0]) if len(samples) >= 2 and samples[0] >= 0 else -1
        stuck = span >= 0 and span < 800
        av = "FAIL" if (stuck or recable) else "PASS"
        if span < 0:
            av = "FAIL"
        log(f"AV samples={samples} span={span} recable={recable} {av}")
    else:
        log("AV SKIP — pas de surface Vidéo visible")
        av = "SKIP"

    log(f"RESULT OFFLINE={'PASS' if offline_pass else 'FAIL'} AV={av}")
    return 0 if offline_pass else 1


if __name__ == "__main__":
    sys.exit(main())
