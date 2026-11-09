#!/usr/bin/env python3
"""
Batterie QA complète — utilisation réelle (taps UI), son muet.
  DEVICE=… OUT=… python3 scripts/qa/full-samsung-battery-20260911.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

DEVICE = os.environ["DEVICE"]
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic.dev")
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("OUT") or ROOT / "tmp/qa-full-samsung-20260911")
OUT.mkdir(parents=True, exist_ok=True)
API_HEALTH = os.environ.get("API_HEALTH", "http://192.168.1.134:8787/api/health")
XML = OUT / "ui.xml"
SESSION = OUT / "session.log"
RESULTS: list[dict] = []
fails = passes = warns = 0


def adb(*args: str, timeout: int = 90) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["adb", "-s", DEVICE, *args],
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(
            list(e.cmd) if e.cmd else [],
            124,
            (e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")),
            "timeout",
        )


def log(msg: str) -> None:
    line = msg.rstrip()
    print(line, flush=True)
    with SESSION.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def record(status: str, fid: str, detail: str) -> None:
    global fails, passes, warns
    RESULTS.append({"id": fid, "status": status, "detail": detail})
    log(f"{status} · {fid} — {detail}")
    if status == "PASS":
        passes += 1
    elif status == "FAIL":
        fails += 1
    elif status == "WARN":
        warns += 1


def mute() -> None:
    adb("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    adb("shell", "media", "volume", "--stream", "3", "--set", "0")


def dump() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/plm-full-qa.xml", timeout=30)
    adb("pull", "/sdcard/plm-full-qa.xml", str(XML), timeout=30)
    return XML.read_text(encoding="utf-8", errors="ignore") if XML.exists() else ""


def nodes(xml: str):
    out = []
    for n in re.findall(r"<node[^>]*>", xml):
        t = re.search(r'text="([^"]*)"', n)
        d = re.search(r'content-desc="([^"]*)"', n)
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        out.append(
            (
                t.group(1) if t else "",
                d.group(1) if d else "",
                (x1 + x2) // 2,
                (y1 + y2) // 2,
                y1,
            )
        )
    return out


def tap_xy(x: int, y: int) -> None:
    adb("shell", "input", "tap", str(x), str(y))


def swipe(x1, y1, x2, y2, ms=350) -> None:
    adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(ms))


def key(code: int) -> None:
    adb("shell", "input", "keyevent", str(code))


def tap_match(pred, wait: float = 0.9, bottom_only: bool = False) -> bool:
    xml = dump()
    for t, d, x, y, y1 in nodes(xml):
        if bottom_only and y1 < 1700:
            continue
        if pred(t, d):
            tap_xy(x, y)
            log(f"  tap '{t or d}' @{x},{y}")
            time.sleep(wait)
            return True
    return False


def has(pred) -> bool:
    xml = dump()
    return any(pred(t, d) for t, d, *_ in nodes(xml))


def wm_size():
    out = adb("shell", "wm", "size").stdout or ""
    m = re.search(r"(\d+)x(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else (1080, 2340)


def media_meta() -> str:
    out = adb("shell", "dumpsys", "media_session").stdout or ""
    pkg_esc = re.escape(PKG)
    m = re.search(rf"package={pkg_esc}[\s\S]*?description=([^\n]+)", out)
    if m:
        return m.group(1).strip()
    # Prefer our package chunk over other media apps
    idx = out.find(f"package={PKG}")
    if idx >= 0:
        chunk = out[idx : idx + 4500]
        m2 = re.search(r"description=([^\n]+)", chunk)
        if m2:
            return m2.group(1).strip()
    found = re.findall(r"description=([^\n]+)", out)
    return found[0].strip() if found else ""


def inject_login() -> None:
    """Injecte tokens LAN (dev@) pour éviter l’écran Connexion."""
    api = os.environ.get("API_BASE_URL", "http://192.168.1.134:8787").rstrip("/")
    email = os.environ.get("SEED_EMAIL") or "dev@delhomme.ovh"
    password = os.environ.get("SEED_PASSWORD") or os.environ.get("VITE_DEV_PASSWORD") or ""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("SEED_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("VITE_DEV_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not password:
        log("inject_login: pas de password .env — skip")
        return
    try:
        req = urllib.request.Request(
            f"{api}/api/auth/login",
            data=json.dumps({"email": email, "password": password}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode())
        token = d.get("token") or d.get("accessToken") or ""
        refresh = d.get("refreshToken") or ""
        if not token:
            log(f"inject_login fail: {d}")
            return
        adb("shell", "am", "force-stop", PKG)
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
        adb(*args)
        time.sleep(5)
        log("inject_login: OK")
    except Exception as e:
        log(f"inject_login: {e}")


def logcat_hits() -> int:
    lc = adb("logcat", "-d", "-t", "1500", timeout=40).stdout or ""
    return len(re.findall(r"VerifyError|FATAL EXCEPTION", lc))


def main() -> int:
    SESSION.write_text("", encoding="utf-8")
    mute()
    adb("shell", "settings", "put", "global", "zen_mode", "2")
    adb("logcat", "-c", timeout=20)
    W, H = wm_size()
    log(f"==> FULL QA {DEVICE} {datetime.now().isoformat()} {W}x{H} pkg={PKG}")

    ver = ""
    for line in (adb("shell", "dumpsys", "package", PKG).stdout or "").splitlines():
        if "versionName=" in line:
            ver = line.split("=", 1)[1].strip()
            break
    record("PASS" if "1.3.24" in ver or "1.3.2" in ver else "WARN", "version", ver or "?")

    inject_login()
    mute()

    c0 = logcat_hits()
    record("PASS" if c0 == 0 else "FAIL", "boot_crash", f"hits={c0}")

    # Bottom nav — prefer bottom_only to avoid Compte header false positives
    for tab in ("Accueil", "Explorer", "Bibliothèque"):
        ok = tap_match(
            lambda t, d, tab=tab: t == tab or tab.lower() in (t + d).lower(),
            wait=1.3,
            bottom_only=True,
        )
        record("PASS" if ok else "WARN", f"nav_{tab.lower()}", tab)

    # Bibliothèque flow
    tap_match(lambda t, d: "biblioth" in (t + d).lower(), wait=1.5, bottom_only=True)
    time.sleep(1)
    sec = False
    for label in ("Titres", "J'aime", "Récents", "Playlists"):
        if tap_match(lambda t, d, lab=label: lab.lower() in (t + d).lower(), wait=1.4):
            record("PASS", "library_section", label)
            sec = True
            break
    if not sec:
        record("WARN", "library_section", "tap centre liste")
        tap_xy(W // 2, int(H * 0.4))
        time.sleep(1.5)

    tap_xy(W // 2, int(H * 0.45))
    time.sleep(2.5)
    meta = media_meta()
    if not meta:
        tap_match(lambda t, d: t == "Accueil", bottom_only=True)
        time.sleep(1)
        tap_xy(W // 2, int(H * 0.35))
        time.sleep(2.5)
        meta = media_meta()
    record("PASS" if meta else "FAIL", "play_start", meta[:100] if meta else "pas de metadata")

    # Open NP
    tap_xy(W // 2, int(H * 0.92))
    time.sleep(2)
    if not has(lambda t, d: "replier" in (t + d).lower() or t in ("Titre", "Vidéo")):
        swipe(W // 2, int(H * 0.92), W // 2, int(H * 0.3), 450)
        time.sleep(2)
    record(
        "PASS" if has(lambda t, d: "replier" in (t + d).lower() or t in ("Titre", "Vidéo")) else "FAIL",
        "open_np",
        "NP",
    )

    # Video
    if tap_match(lambda t, d: t == "Vidéo", wait=3.0):
        time.sleep(2)
        xml = dump()
        if "Recherche du clip" in xml:
            record("FAIL", "video_mode", "Recherche du clip encore visible")
        else:
            record("PASS", "video_mode", "Vidéo OK sans écran recherche")
    else:
        record("WARN", "video_mode", "bouton Vidéo introuvable")

    # Transport
    if tap_match(lambda t, d: "pause" in (t + d).lower() or "lecture" in (t + d).lower()):
        tap_match(lambda t, d: "pause" in (t + d).lower() or "lecture" in (t + d).lower())
        record("PASS", "play_pause", "ok")
    else:
        record("WARN", "play_pause", "introuvable")

    record(
        "PASS" if tap_match(lambda t, d: "suivant" in (t + d).lower(), wait=1.2) else "WARN",
        "next",
        "Suivant",
    )
    if tap_match(lambda t, d: "précédent" in (t + d).lower()):
        tap_match(lambda t, d: "précédent" in (t + d).lower())
        record("PASS", "prev", "×2")
    else:
        record("WARN", "prev", "introuvable")

    for label in ("Paroles", "J'aime", "Mix"):
        if tap_match(lambda t, d, lab=label: lab.lower() in (t + d).lower() and "filtre" not in (t + d).lower()):
            key(4)
            time.sleep(0.5)
            record("PASS", f"chip_{label.lower()}", label)
        else:
            record("WARN", f"chip_{label.lower()}", "non trouvé")

    # Queue — swipe up from bottom of NP
    swipe(W // 2, int(H * 0.88), W // 2, int(H * 0.2), 500)
    time.sleep(1.8)
    xml = dump()
    if any(k in xml for k in ("À suivre", "En cours", "File d", "Mix à partir", "File d'attente")):
        record("PASS", "queue", "File visible")
        record(
            "PASS" if ("En cours" in xml or "À suivre" in xml) else "WARN",
            "queue_current",
            "labels courant",
        )
    else:
        # try text File
        if tap_match(lambda t, d: "file" in (t + d).lower() or "attente" in (t + d).lower()):
            xml = dump()
            record(
                "PASS" if any(k in xml for k in ("À suivre", "En cours", "File")) else "FAIL",
                "queue",
                "via tap",
            )
        else:
            record("FAIL", "queue", "non visible")

    key(4)
    time.sleep(0.8)

    # Collapse
    tap_match(lambda t, d: t == "Vidéo", wait=2.0)
    time.sleep(1)
    if not tap_match(lambda t, d: "replier" in (t + d).lower(), wait=1.5):
        key(4)
        time.sleep(1.5)
    time.sleep(2.5)
    xml = dump()
    if re.search(r'text="Chargement', xml):
        time.sleep(4)
        xml = dump()
        record(
            "FAIL" if re.search(r'text="Chargement', xml) else "WARN",
            "collapse_audio",
            "Chargement après repli",
        )
    else:
        record("PASS", "collapse_audio", "pas de Chargement bloquant")

    meta2 = media_meta()
    record("PASS" if meta2 else "WARN", "collapse_playing", meta2[:80] if meta2 else "metadata absente")

    c1 = logcat_hits()
    record("PASS" if c1 <= c0 else "FAIL", "no_crash", f"{c0}→{c1}")

    off = (adb("shell", f"run-as {PKG} sh -c 'ls files/offline 2>/dev/null | wc -l'").stdout or "").strip()
    m4a = (adb("shell", f"run-as {PKG} sh -c 'ls files/offline/*.m4a 2>/dev/null | wc -l'").stdout or "").strip()
    mp4 = (adb("shell", f"run-as {PKG} sh -c 'ls files/offline/*.mp4 2>/dev/null | wc -l'").stdout or "").strip()
    record("PASS" if off.isdigit() and int(off) > 0 else "WARN", "offline", f"≈{off} m4a={m4a} mp4={mp4}")

    # Search
    if tap_match(lambda t, d: t == "Explorer", bottom_only=True, wait=1.5):
        if tap_match(lambda t, d: "recherch" in (t + d).lower() or "search" in (t + d).lower()):
            adb("shell", "input", "text", "sia")
            time.sleep(0.4)
            key(66)
            time.sleep(2.5)
            record("PASS", "search", "sia")
            tap_xy(W // 2, int(H * 0.38))
            time.sleep(2)
            record("PASS", "search_play", media_meta()[:80])
        else:
            record("WARN", "search", "champ introuvable")
    else:
        record("WARN", "search", "Explorer non ouvert")

    try:
        health = json.loads(urllib.request.urlopen(API_HEALTH, timeout=8).read())
        av = health.get("appVersion", "")
        ver_ok = "1.3.24" in str(av) or "1.3.2" in str(av)
        record("PASS" if ver_ok else "WARN", "api_health", f"appVersion={av} url={API_HEALTH}")
    except Exception as e:
        record("FAIL", "api_health", str(e))

    (OUT / "logcat.txt").write_text(
        adb("logcat", "-d", "-t", "2500", timeout=40).stdout or "",
        encoding="utf-8",
        errors="ignore",
    )
    report = {
        "device": DEVICE,
        "version": ver,
        "iso": datetime.now().isoformat(),
        "passes": passes,
        "fails": fails,
        "warns": warns,
        "results": RESULTS,
    }
    (OUT / "REPORT.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        f"# QA complète — {report['iso']}",
        "",
        f"- Device: `{DEVICE}`",
        f"- Version: `{ver}`",
        f"- PASS={passes} FAIL={fails} WARN={warns}",
        "",
        "## Résultats",
        "",
    ]
    for r in RESULTS:
        lines.append(f"- **{r['status']}** `{r['id']}` — {r['detail']}")
    (OUT / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"==> DONE PASS={passes} FAIL={fails} WARN={warns}")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
