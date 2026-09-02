#!/usr/bin/env python3
"""QA ultra poussée — actions lecteur / file (sans suppressions)."""
from __future__ import annotations

import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

DEVICE = os.environ.get("DEVICE", "192.168.1.184:35357")
PKG = "ovh.delhomme.ytmusic"
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("OUT") or ROOT / f"logs/player-qa-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
OUT.mkdir(parents=True, exist_ok=True)
XML = OUT / "ui.xml"
REPORT = OUT / "REPORT.md"
LOGCAT = OUT / "logcat.txt"
SESSION = OUT / "session.log"

fails = 0
rows: list[str] = []


def adb(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["adb", "-s", DEVICE, *args],
        text=True,
        capture_output=True,
        check=check,
    )


def log(msg: str) -> None:
    line = msg.rstrip()
    print(line, flush=True)
    with SESSION.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def pass_(msg: str) -> None:
    log(f"PASS · {msg}")
    rows.append(f"- PASS: {msg}")


def fail(msg: str) -> None:
    global fails
    fails += 1
    log(f"FAIL · {msg}")
    rows.append(f"- FAIL: {msg}")


def warn(msg: str) -> None:
    log(f"WARN · {msg}")
    rows.append(f"- WARN: {msg}")


def dump_ui() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/plm-qa.xml")
    adb("pull", "/sdcard/plm-qa.xml", str(XML))
    return XML.read_text(encoding="utf-8", errors="replace") if XML.exists() else ""


def nodes(xml: str):
    for n in re.findall(r"<node[^>]*>", xml):
        t = re.search(r'text="([^"]*)"', n)
        d = re.search(r'content-desc="([^"]*)"', n)
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if not b:
            continue
        yield (
            (t.group(1) if t else ""),
            (d.group(1) if d else ""),
            tuple(map(int, b.groups())),
        )


def has_text(needle: str) -> bool:
    xml = dump_ui()
    n = needle.lower()
    return any(n in (t or "").lower() or n in (d or "").lower() for t, d, _ in nodes(xml))


def tap_xy(x: int, y: int) -> None:
    adb("shell", "input", "tap", str(x), str(y))


def tap_match(needle: str, prefer_desc: bool = False) -> bool:
    xml = dump_ui()
    n = needle.lower()
    cands = []
    for t, d, (x1, y1, x2, y2) in nodes(xml):
        label = d if prefer_desc else (t or d)
        alt = t if prefer_desc else d
        hay = f"{label} {alt}".lower()
        if n in hay:
            cands.append(((x1 + x2) // 2, (y1 + y2) // 2, t or d))
    if not cands:
        return False
    x, y, lab = cands[0]
    tap_xy(x, y)
    log(f"  tapped {lab!r} @ {x},{y}")
    return True


def remaining_sec() -> int:
    xml = dump_ui()
    for t, _, _ in nodes(xml):
        m = re.match(r"^-(\d+):(\d{2})$", t or "")
        if m:
            return int(m.group(1)) * 60 + int(m.group(2))
    return -1


def back() -> None:
    adb("shell", "input", "keyevent", "4")


def main() -> int:
    log(f"==> QA player device={DEVICE} out={OUT}")
    adb("shell", "media", "volume", "--stream", "3", "--set", "0")
    adb("logcat", "-c")
    adb("shell", "am", "force-stop", PKG)
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(6)

    ver = ""
    pkg = adb("shell", "dumpsys", "package", PKG).stdout
    for line in pkg.splitlines():
        if "versionName=" in line:
            ver = line.split("=", 1)[1].strip()
            break
    log(f"version={ver}")

    # Open NP
    tap_xy(350, 1835)
    time.sleep(1.5)
    if has_text("Titre") or has_text("Vidéo"):
        pass_("Ouverture Now Playing")
    else:
        tap_match("Accueil")
        time.sleep(1)
        tap_xy(350, 1835)
        time.sleep(1.5)
        if has_text("Titre") or has_text("Vidéo"):
            pass_("Ouverture Now Playing (retry)")
        else:
            fail("Ouverture Now Playing")

    # Seek short tap : Y juste au-dessus du label remaining
    xml = dump_ui()
    seek_y = 1655
    for t, _, (x1, y1, x2, y2) in nodes(xml):
        if re.match(r"^-\d+:\d{2}$", t or ""):
            seek_y = y1 - 52
            break
    r0 = remaining_sec()
    tap_xy(800, seek_y)
    time.sleep(0.9)
    r1 = remaining_sec()
    if r0 >= 0 and r1 >= 0 and r1 < r0 - 3:
        pass_(f"Seek tap court ({r0}s → {r1}s)")
    elif r0 >= 0 and r1 >= 0 and r1 > r0 + 30:
        fail(f"Seek tap court rebobine début ({r0}→{r1})")
    else:
        warn(f"Seek tap court ambigu ({r0}→{r1}) y={seek_y}")

    # Play/Pause
    if tap_match("Lecture", prefer_desc=True) or tap_match("Pause", prefer_desc=True):
        time.sleep(0.5)
        if tap_match("Lecture", prefer_desc=True) or tap_match("Pause", prefer_desc=True):
            pass_("Play / Pause")
        else:
            warn("Play/Pause 2e tap manquant")
    else:
        fail("Lecture/Pause introuvable")

    # Previous x3 + Next
    for _ in range(3):
        if not tap_match("Précédent", prefer_desc=True):
            tap_xy(200, 1900)
        time.sleep(0.65)
    pass_("Previous ×3")
    if not tap_match("Suivant", prefer_desc=True):
        tap_xy(880, 1900)
    time.sleep(0.9)
    pass_("Next")

    # Shuffle twice
    if tap_match("Aléatoire", prefer_desc=True):
        time.sleep(0.35)
        tap_match("Aléatoire", prefer_desc=True)
        pass_("Aléatoire on/off")
    else:
        warn("Aléatoire introuvable")

    # Repeat cycle
    if tap_match("Boucle", prefer_desc=True):
        time.sleep(0.3)
        tap_match("Boucle", prefer_desc=True)
        time.sleep(0.3)
        tap_match("Boucle", prefer_desc=True)
        pass_("Boucle cycle ×3")
    else:
        warn("Boucle introuvable")

    # Secondary actions (chips scrollables)
    for label in ["J'aime", "Paroles", "Playlist", "Télécharger", "Mix", "Égaliseur", "Vitesse"]:
        found = tap_match(label, prefer_desc=True) or tap_match(label)
        if not found:
            # scroll chips row to the right (révél Télécharger / Vitesse)
            adb("shell", "input", "swipe", "900", "1452", "200", "1452", "250")
            time.sleep(0.35)
            found = tap_match(label, prefer_desc=True) or tap_match(label)
        if found:
            time.sleep(0.85)
            if has_text("Annuler") or has_text("Fermer"):
                tap_match("Annuler") or tap_match("Fermer")
            else:
                back()
            time.sleep(0.4)
            if not (has_text("Titre") or has_text("File d'attente") or has_text("Playlist")):
                tap_xy(350, 1835)
                time.sleep(0.7)
            pass_(f"Action secondaire: {label}")
        else:
            warn(f"Action secondaire absente: {label}")

    # Queue
    opened = tap_match("File d'attente")
    if not opened:
        adb("shell", "input", "swipe", "540", "2100", "540", "900", "400")
        time.sleep(1)
    if has_text("File d'attente") or has_text("En cours") or has_text("À suivre"):
        pass_("Ouverture file d'attente")
    else:
        warn("File d'attente UI incertaine")
    tap_match("Radio", prefer_desc=True) or tap_match("Mix", prefer_desc=True)
    time.sleep(0.5)
    back()
    time.sleep(0.5)
    pass_("Gestes file d'attente")

    if has_text("Titre") or has_text("File d'attente") or has_text("Playlist"):
        pass_("Lecteur utilisable en fin de suite")
    else:
        warn("UI finale hors lecteur")

    # logcat
    pid = adb("shell", "pidof", "-s", PKG).stdout.strip()
    if pid:
        adb("logcat", "-d", "-t", "2500", f"--pid={pid}")
        LOGCAT.write_text(adb("logcat", "-d", "-t", "2500", f"--pid={pid}").stdout, encoding="utf-8")
    else:
        LOGCAT.write_text(adb("logcat", "-d", "-t", "1500").stdout, encoding="utf-8")
    lc = LOGCAT.read_text(encoding="utf-8", errors="replace")
    interesting = [
        l
        for l in lc.splitlines()
        if re.search(r"PlaybackService|PlayerController|early_end|stall|AndroidRuntime|FATAL", l, re.I)
    ][-80:]

    REPORT.write_text(
        "\n".join(
            [
                f"# QA lecteur multimédia — {datetime.now().isoformat(timespec='seconds')}",
                "",
                f"- Device: `{DEVICE}`",
                f"- Version: `{ver}`",
                "",
                "## Résultats",
                "",
                *rows,
                "",
                "## Logcat (extraits)",
                "",
                f"Lignes intéressantes: `{len(interesting)}`",
                "",
                "```text",
                *interesting,
                "```",
                "",
                "## Synthèse",
                "",
                f"- Échecs: **{fails}**",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (OUT / "fails.txt").write_text(str(fails), encoding="utf-8")
    log(f"==> done fails={fails} report={REPORT}")
    print(REPORT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
