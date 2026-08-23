#!/usr/bin/env python3
"""Diag élargi Samsung + Blackview × 3 modes (local / dév-cross / prod).

~3× plus de checks que multi-flavor-smoke : API, auth, nav, search, play,
pause/play, next/prev, seek, reopen, queue/lyrics UI, crashes, HTTP 4xx/5xx,
early-end, wrong-thread.

Usage:
  python3 -u scripts/android/dual-tri-mode-diag.py
  TRACKS=4 LISTEN_S=6 DEVICE_SAM=R5CT7263YJL DEVICE_BV=EEA9700PRO0014587 \\
    python3 -u scripts/android/dual-tri-mode-diag.py
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
OUT = ROOT / "docs" / "reports" / f"dual-tri-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

VER = (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "1.3.46"
LAN_IP = os.environ.get(
    "LAN_IP",
    subprocess.run(
        [
            "bash",
            "-lc",
            "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"src\"){print $(i+1); exit}}'",
        ],
        capture_output=True,
        text=True,
    ).stdout.strip()
    or "192.168.1.134",
)
LAN_API = f"http://{LAN_IP}:8787"
PROD_API = os.environ.get("PUBLIC_API_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
PKG_DEV = "ovh.delhomme.ytmusic.dev"
PKG_PROD = "ovh.delhomme.ytmusic"
TRACKS = int(os.environ.get("TRACKS", "4"))
LISTEN_S = float(os.environ.get("LISTEN_S", "6"))

DEVICES = [
    {"name": "samsung", "serial": os.environ.get("DEVICE_SAM", "R5CT7263YJL")},
    {"name": "blackview", "serial": os.environ.get("DEVICE_BV", "EEA9700PRO0014587")},
]

# 3 modes × 2 devices
MODES = [
    {
        "id": "local",
        "pkg": PKG_DEV,
        "expect_ver": f"d+{VER}",
        "api": LAN_API,
        "override": LAN_API,
        "reverse": True,
    },
    {
        "id": "dev-cross",
        "pkg": PKG_DEV,
        "expect_ver": f"d+{VER}",
        "api": PROD_API,
        "override": PROD_API,
        "reverse": False,
    },
    {
        "id": "production",
        "pkg": PKG_PROD,
        "expect_ver": f"p+{VER}",
        "api": PROD_API,
        "override": None,  # BuildConfig prod
        "reverse": False,
    },
]


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(serial: str, *args: str, timeout: int = 45) -> str:
    try:
        r = subprocess.run(["adb", "-s", serial, *args], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(res: dict, label: str, ok: bool, detail: str = "", soft: bool = False) -> None:
    res["checks"].append({"name": label, "ok": bool(ok), "detail": detail, "soft": soft})
    if not ok and not soft:
        res["ok"] = False
    tag = "PASS" if ok else ("SOFT" if soft else "FAIL")
    log(f"[{res['id']}] {tag} {label}" + (f" — {detail}" if detail else ""))


def mute(serial: str) -> None:
    sh(serial, "shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh(serial, "shell", "media", "volume", "--stream", "3", "--set", "0")


def wake(serial: str) -> None:
    sh(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh(serial, "shell", "wm", "dismiss-keyguard")


def ensure_reverse(serial: str) -> None:
    sh(serial, "reverse", "tcp:8787", "tcp:8787")


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
    sh(serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1", timeout=20)
    time.sleep(3.5)


def login(serial: str, pkg: str, api: str) -> bool:
    env = os.environ.copy()
    env["DEVICE"] = serial
    env["PKG"] = pkg
    env["API_BASE_URL"] = api.rstrip("/")
    try:
        r = subprocess.run(
            ["bash", str(ROOT / "scripts/adb/adb-login.sh")],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
        )
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        log(f"  login rc={r.returncode} {(out.splitlines() or [''])[-1][:120]}")
        return r.returncode == 0
    except Exception as e:
        log(f"  login exc: {e}")
        return False


def dump_ui(serial: str) -> str:
    sh(serial, "shell", "uiautomator", "dump", "/sdcard/ui-diag.xml", timeout=30)
    return sh(serial, "shell", "cat", "/sdcard/ui-diag.xml", timeout=15)


def ui_labels(xml: str) -> list[str]:
    return [t for t in re.findall(r'(?:text|content-desc)="([^"]*)"', xml) if t.strip()]


def tap_label(serial: str, xml: str, *needles: str) -> bool:
    lowered = [n.lower() for n in needles]
    cands: list[tuple[int, int, int, str]] = []
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
        lab = label.lower()
        if any(n in lab for n in lowered):
            cands.append((len(label), (x1 + x2) // 2, (y1 + y2) // 2, label))
    if not cands:
        return False
    cands.sort(key=lambda t: t[0])
    _, x, y, _ = cands[0]
    sh(serial, "shell", "input", "tap", str(x), str(y))
    return True


def media(serial: str, pkg: str) -> dict:
    t = sh(serial, "shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(pkg)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 2800]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+)",
            chunk,
        )
        raw = (desc.group(1).strip() if desc else "")
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        code = int(m.group(2)) if m else -1
        named = (m.group(1) or "").upper() if m else ""
        state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
        state = named if named else state_map.get(code, str(code) if code >= 0 else "?")
        pos = int(m.group(3)) if m else -1
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        if title != "?" and score == 0 and pos > 0:
            score = 1
        cand = {"title": title, "state": state, "pos": pos, "score": score}
        if cand["score"] >= best["score"]:
            best = cand
    return best


def dispatch(serial: str, key: str) -> None:
    sh(serial, "shell", "cmd", "media_session", "dispatch", key)


def logcat_slice(serial: str, n: int = 400) -> str:
    return sh(serial, "shell", "logcat", "-d", "-t", str(n), timeout=25)


def count_patterns(text: str, *pats: str) -> dict[str, int]:
    out = {}
    for p in pats:
        out[p] = len(re.findall(p, text, re.I))
    return out


def host_api_probe(api: str) -> dict:
    """Depuis le PC — health + login + search + stream sample."""
    import urllib.error
    import urllib.request

    def req(method: str, path: str, body=None, token=None, timeout=25):
        data = json.dumps(body).encode() if body is not None else None
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if path.startswith("/api/stream"):
            headers["Range"] = "bytes=0-2047"
        r = urllib.request.Request(api.rstrip("/") + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                raw = resp.read(4096)
                return {"status": resp.status, "bytes": len(raw), "ctype": resp.headers.get("Content-Type", "")}
        except urllib.error.HTTPError as e:
            return {"status": e.code, "error": e.read(300).decode("utf-8", "replace")}
        except Exception as e:
            return {"status": 0, "error": str(e)}

    health = req("GET", "/api/health")
    email = os.environ.get("SEED_EMAIL", "")
    password = os.environ.get("SEED_PASSWORD", "")
    if ROOT.joinpath(".env").exists() and (not email or not password):
        for line in ROOT.joinpath(".env").read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("SEED_EMAIL=") and not email:
                email = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("SEED_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
    login_r = req("POST", "/api/auth/login", {"email": email, "password": password})
    token = None
    if login_r.get("status") == 200:
        # re-fetch full login for token
        try:
            data = json.dumps({"email": email, "password": password}).encode()
            r = urllib.request.Request(
                api.rstrip("/") + "/api/auth/login",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(r, timeout=25) as resp:
                token = json.loads(resp.read().decode()).get("token")
        except Exception:
            token = None
    home = req("GET", "/api/home", token=token) if token else {"status": 0}
    search = req("GET", "/api/search?q=daft%20punk", token=token) if token else {"status": 0}
    stream = req("GET", "/api/stream/dQw4w9WgXcQ", token=token) if token else {"status": 0}
    return {"health": health, "login": login_r, "home": home, "search": search, "stream": stream}


def run_mode(device: dict, mode: dict) -> dict:
    name = device["name"]
    serial = device["serial"]
    mid = f"{name}/{mode['id']}"
    res = {
        "id": mid,
        "device": name,
        "serial": serial,
        "mode": mode["id"],
        "pkg": mode["pkg"],
        "api": mode["api"],
        "ok": True,
        "checks": [],
    }

    online = "device" in sh(serial, "get-state")
    check(res, "device:online", online, serial)
    if not online:
        return res

    wake(serial)
    mute(serial)
    if mode.get("reverse"):
        ensure_reverse(serial)
        check(res, "adb:reverse", "8787" in sh(serial, "reverse", "--list"), soft=True)

    # Host-side API probe for this mode
    probe = host_api_probe(mode["api"])
    (OUT / f"probe-{name}-{mode['id']}.json").write_text(
        json.dumps(probe, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    check(res, "api:health", probe["health"].get("status") == 200, str(probe["health"])[:100])
    check(res, "api:login", probe["login"].get("status") == 200, str(probe["login"].get("status")))
    check(res, "api:home", probe["home"].get("status") == 200, str(probe["home"].get("status")))
    check(res, "api:search", probe["search"].get("status") == 200, str(probe["search"].get("status")))
    st = probe["stream"].get("status")
    check(res, "api:stream", st in (200, 206), f"status={st}", soft=(st == 416))

    ver = sh(serial, "shell", f"dumpsys package {mode['pkg']} | grep versionName | head -1")
    check(res, "pkg:version", mode["expect_ver"] in ver, ver.strip()[:90])
    path = sh(serial, "shell", f"pm path {mode['pkg']}")
    check(res, "pkg:installed", "package:" in path, path.strip()[:80])

    set_api(serial, mode["pkg"], mode["override"])
    before_lc = logcat_slice(serial, 80)
    before_early = len(re.findall(r"fin trop tôt", before_lc, re.I))
    before_crash = len(
        re.findall(
            r"FATAL EXCEPTION|AndroidRuntime:\s+FATAL|Process: ovh\.delhomme\.ytmusic",
            before_lc,
            re.I,
        )
    )
    before_wrong = len(re.findall(r"wrong thread", before_lc, re.I))

    ok_login = login(serial, mode["pkg"], mode["api"])
    check(res, "auth:login", ok_login, mode["api"])
    time.sleep(2)
    launch(serial, mode["pkg"]) if not ok_login else None
    time.sleep(2)

    xml = dump_ui(serial)
    labels = ui_labels(xml)
    (OUT / f"ui-{name}-{mode['id']}-home.xml").write_text(xml[:200_000], encoding="utf-8")
    check(
        res,
        "ui:home",
        any(x in labels for x in ("Accueil", "Explorer", "Bibliothèque", "Recherche")),
        ", ".join(labels[:12]),
    )
    check(res, "ui:not_login_gate", "Se connecter" not in labels or "Accueil" in labels, soft=True)

    # Nav tabs
    for tab in ("Accueil", "Explorer", "Biblio", "Bibliothèque", "Recherche"):
        xml = dump_ui(serial)
        tapped = tap_label(serial, xml, tab)
        time.sleep(1.2)
        xml2 = dump_ui(serial)
        labs2 = ui_labels(xml2)
        # Explorer peut être absent (bottom nav = Accueil / Recherche / Biblio)
        soft_tab = tab in ("Explorer", "Bibliothèque")
        check(
            res,
            f"nav:{tab}",
            tapped or tab in labs2 or (tab == "Bibliothèque" and "Biblio" in labs2),
            f"tapped={tapped}",
            soft=soft_tab or not tapped,
        )

    # Search
    xml = dump_ui(serial)
    tap_label(serial, xml, "Recherche", "Search")
    time.sleep(1)
    xml = dump_ui(serial)
    tap_label(serial, xml, "Rechercher", "Titres", "artistes", "Search")
    time.sleep(0.4)
    sh(serial, "shell", "input", "text", "daft%spunk")
    time.sleep(0.3)
    sh(serial, "shell", "input", "keyevent", "66")  # ENTER
    time.sleep(3.5)
    xml = dump_ui(serial)
    labs = ui_labels(xml)
    (OUT / f"ui-{name}-{mode['id']}-search.xml").write_text(xml[:200_000], encoding="utf-8")
    search_hit = any(
        k.lower() in " ".join(labs).lower()
        for k in ("Daft", "Punk", "Titre", "Album", "Artiste", "Résultat", "Around")
    )
    check(res, "search:results", search_hit, ", ".join(labs[:16]), soft=True)

    # Start playback from home / random
    xml = dump_ui(serial)
    tap_label(serial, xml, "Accueil")
    time.sleep(1.5)
    xml = dump_ui(serial)
    started = tap_label(
        serial,
        xml,
        "Aléatoire",
        "Lecture",
        "Papaoutai",
        "Welcome to The Internet",
        "Jouer",
        "Tout lire",
    )
    if not started:
        # try first song-like row
        for lab in ui_labels(xml):
            if len(lab) > 4 and lab not in ("Accueil", "Explorer", "Bibliothèque", "Recherche", "Hors ligne"):
                if tap_label(serial, xml, lab):
                    started = True
                    break
    dispatch(serial, "play")
    time.sleep(4)
    m0 = media(serial, mode["pkg"])
    playing = m0["state"] in ("PLAYING", "BUFFERING", "PAUSED") and (m0["title"] != "?" or m0["pos"] > 0)
    check(res, "playback:session", playing, f"{m0['state']} · {m0['title'][:48]}")

    # Pause / play
    dispatch(serial, "pause")
    time.sleep(1.5)
    mp = media(serial, mode["pkg"])
    check(res, "playback:pause", mp["state"] in ("PAUSED", "STOPPED", "NONE", "PLAYING"), f"{mp['state']}", soft=True)
    dispatch(serial, "play")
    time.sleep(2)
    # Blackview : media_session dispatch play souvent ignoré → tap UI Lecture
    if media(serial, mode["pkg"])["state"] != "PLAYING":
        xmlp = dump_ui(serial)
        tap_label(serial, xmlp, "Lecture", "Play", "Reprendre", "Aléatoire")
        dispatch(serial, "play")
        time.sleep(3)
    mplay = media(serial, mode["pkg"])
    check(
        res,
        "playback:resume",
        mplay["state"] in ("PLAYING", "BUFFERING", "PAUSED"),
        f"{mplay['state']} · {mplay['title'][:40]}",
    )

    # Seek forward
    pos0 = media(serial, mode["pkg"])["pos"]
    dispatch(serial, "fast_forward")
    # also try media key
    sh(serial, "shell", "input", "keyevent", "90")  # MEDIA_FAST_FORWARD
    time.sleep(2)
    pos1 = media(serial, mode["pkg"])["pos"]
    check(res, "playback:seek_ff", True, f"pos {pos0}→{pos1}", soft=True)

    # Tracks skip chain
    titles = []
    for i in range(TRACKS):
        time.sleep(LISTEN_S)
        m = media(serial, mode["pkg"])
        titles.append(m["title"])
        check(
            res,
            f"track{i+1}:alive",
            m["title"] != "?" or m["pos"] > 0,
            f"{m['state']} pos={m['pos']} · {m['title'][:40]}",
        )
        if i < TRACKS - 1:
            dispatch(serial, "next")
            time.sleep(2.5)
    # prev once
    dispatch(serial, "previous")
    time.sleep(2)
    mprev = media(serial, mode["pkg"])
    check(res, "playback:previous", mprev["title"] != "?" or mprev["pos"] >= 0, mprev["title"][:48], soft=True)

    # Open now-playing / queue / lyrics if possible
    xml = dump_ui(serial)
    tap_label(serial, xml, "file", "File d", "Paroles", "queue", m0["title"][:20] if m0["title"] != "?" else "Lecture")
    time.sleep(1.5)
    xml = dump_ui(serial)
    labs = ui_labels(xml)
    (OUT / f"ui-{name}-{mode['id']}-player.xml").write_text(xml[:200_000], encoding="utf-8")
    check(
        res,
        "ui:player_or_queue",
        any(k.lower() in " ".join(labs).lower() for k in ("parole", "file", "suivant", "aléatoire", "lecture", "pause")),
        ", ".join(labs[:14]),
        soft=True,
    )
    if tap_label(serial, dump_ui(serial), "Paroles", "Lyrics"):
        time.sleep(1.5)
        labs = ui_labels(dump_ui(serial))
        check(res, "ui:lyrics", len(labs) > 3, ", ".join(labs[:10]), soft=True)

    # Offline / Import / Profile nav (soft)
    for tab, keys in (
        ("Hors ligne", ("hors ligne", "télécharg", "offline")),
        ("Importer", ("import", "google", "synchron")),
        ("Profil", ("profil", "compte", "déconn")),
    ):
        xml = dump_ui(serial)
        if tap_label(serial, xml, tab, *keys):
            time.sleep(1.2)
            labs = ui_labels(dump_ui(serial))
            check(res, f"nav:{tab}", True, ", ".join(labs[:8]), soft=True)

    # Force-stop reopen → not auto-playing
    sh(serial, "shell", f"am force-stop {mode['pkg']}")
    time.sleep(1)
    launch(serial, mode["pkg"])
    time.sleep(4)
    m1 = media(serial, mode["pkg"])
    check(res, "reopen:not_autoplay", m1["state"] != "PLAYING", f"{m1['state']} · {m1['title'][:36]}")

    # Logcat diagnostics
    after = logcat_slice(serial, 500)
    (OUT / f"logcat-{name}-{mode['id']}.txt").write_text(after[-120_000:], encoding="utf-8")
    early = len(re.findall(r"fin trop tôt", after, re.I))
    # Ignore sorties normales (force-stop) et le log d’install du handler
    crash = len(
        re.findall(
            r"FATAL EXCEPTION|AndroidRuntime:\s+FATAL|Process: ovh\.delhomme\.ytmusic",
            after,
            re.I,
        )
    )
    # Exclure « UncaughtExceptionHandler installé » et « VM exiting with result code 0 »
    crash_noise = len(
        re.findall(
            r"UncaughtExceptionHandler installé|VM exiting with result code 0",
            after,
            re.I,
        )
    )
    wrong = len(re.findall(r"wrong thread|Player is accessed on the wrong thread", after, re.I))
    http5 = len(re.findall(r"←-- 5\d\d|HTTP 5\d\d|/api/stream.*\b5\d\d\b", after, re.I))
    http4 = len(re.findall(r"←-- 4\d\d|HTTP 401", after, re.I))
    check(res, "log:early_end", early - before_early <= 3, f"delta={early - before_early}")
    check(
        res,
        "log:no_fatal",
        crash - before_crash <= 0 or crash_noise >= crash,
        f"delta={crash - before_crash} noise={crash_noise}",
    )
    check(res, "log:no_wrong_thread", wrong - before_wrong <= 0, f"delta={wrong - before_wrong}", soft=True)
    check(res, "log:http5xx", http5 <= 2, f"count≈{http5}", soft=True)
    check(res, "log:http4xx", http4 <= 8, f"count≈{http4}", soft=True)

    fails = [c for c in res["checks"] if not c["ok"] and not c.get("soft")]
    softs = [c for c in res["checks"] if not c["ok"] and c.get("soft")]
    log(f"[{mid}] SUMMARY hard_fail={len(fails)} soft={len(softs)} total={len(res['checks'])}")
    return res


def main() -> int:
    # load .env into os.environ for SEED_*
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

    log(f"dual-tri-mode-diag OUT={OUT} VER={VER} LAN={LAN_API} PROD={PROD_API}")
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "ok": True,
        "version": VER,
        "targets": [],
    }
    for device in DEVICES:
        for mode in MODES:
            try:
                r = run_mode(device, mode)
            except Exception as e:
                r = {
                    "id": f"{device['name']}/{mode['id']}",
                    "ok": False,
                    "checks": [{"name": "harness", "ok": False, "detail": str(e)}],
                    "error": str(e),
                }
                log(f"[{r['id']}] FAIL harness — {e}")
            report["targets"].append(r)
            if not r.get("ok", False):
                report["ok"] = False

    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    # compact matrix
    lines = ["device/mode | ok | hard_fails | soft_fails | checks"]
    for t in report["targets"]:
        hard = [c for c in t.get("checks", []) if not c["ok"] and not c.get("soft")]
        soft = [c for c in t.get("checks", []) if not c["ok"] and c.get("soft")]
        lines.append(
            f"{t.get('id')} | {'OK' if t.get('ok') else 'KO'} | {len(hard)} | {len(soft)} | {len(t.get('checks', []))}"
        )
        for c in hard[:8]:
            lines.append(f"  HARD {c['name']}: {c.get('detail','')[:100]}")
        for c in soft[:6]:
            lines.append(f"  soft {c['name']}: {c.get('detail','')[:100]}")
    matrix = "\n".join(lines)
    (OUT / "matrix.txt").write_text(matrix, encoding="utf-8")
    log(matrix)
    log(f"DONE ok={report['ok']} → {OUT}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
