#!/usr/bin/env python3
"""Samsung-only : lecture muette + coupures + Wi‑Fi ↔ 4G pendant play/skip/seek/pause.

Ne touche pas le Nothing (pause volume seulement). Restaure toujours Wi‑Fi+data.

Usage:
  DEVICE=R5CT7263YJL python3 scripts/android/samsung-network-handover.py
  ONLY=dev|prod DEVICE=R5CT7263YJL python3 scripts/android/samsung-network-handover.py
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
SERIAL = os.environ.get("DEVICE", "R5CT7263YJL")
NOTHING = os.environ.get("NOTHING_SERIAL", "192.168.1.44:40967")
ONLY = os.environ.get("ONLY", "both").lower()
LAN = os.environ.get("API_LAN", "http://192.168.1.134:8787")
PROD_API = os.environ.get("API_PROD", "https://ytmusic.delhomme.ovh")

TAP = {
    "accueil": (171, 2124),
    "aleatoire": (858, 624),
    "papaoutai": (1029, 663),
}

OUT = ROOT / "docs" / "reports" / f"samsung-net-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "device": SERIAL,
    "checks": [],
    "ok": True,
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
        return f"TIMEOUT {' '.join(args)}"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail, "ts": time.time()})
    if not ok:
        report["ok"] = False
    log(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def mute(serial: str | None = None) -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0", serial=serial)
    sh("shell", "media", "volume", "--stream", "3", "--set", "0", serial=serial)


def restore_net() -> None:
    sh("shell", "cmd", "connectivity", "airplane-mode", "disable")
    sh("shell", "svc", "wifi", "enable")
    sh("shell", "svc", "data", "enable")
    time.sleep(2)


def net_kind() -> str:
    """Transport réellement utilisé (évite l’IMS 4G qui reste toujours « CELLULAR »)."""
    route = sh("shell", "ip", "route", "get", "1.1.1.1")
    if "wlan0" in route:
        return "WIFI"
    if "rmnet" in route or "ccmni" in route or "offline" in route.lower():
        if "unreachable" in route.lower() or "Network is unreachable" in route:
            return "NONE"
        if "rmnet" in route or "ccmni" in route:
            return "CELLULAR"
    t = sh("shell", "dumpsys", "connectivity")
    mid = re.search(r"Active default network:\s+(\d+)", t)
    if mid:
        m2 = re.search(rf"network\{{{mid.group(1)}\}}\s+.*?Transports:\s+(\w+)", t, re.S)
        if m2:
            tr = m2.group(1).upper()
            if tr == "CELLULAR":
                # IMS-only ne route pas 1.1.1.1
                if "wlan0" not in route and "rmnet" not in route:
                    return "NONE"
            return tr
    if "unreachable" in route.lower() or not route.strip():
        return "NONE"
    return "NONE"


def wait_transport(want: str, secs: float = 18) -> str:
    deadline = time.time() + secs
    last = "?"
    while time.time() < deadline:
        last = net_kind()
        if want == "CELL" and last.startswith("CELL"):
            return last
        if want == "WIFI" and last.startswith("WIFI"):
            return last
        if want == "NONE" and last == "NONE":
            return last
        time.sleep(1.2)
    return last


def to_wifi() -> str:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "enable")
    return wait_transport("WIFI", 16)


def to_cell() -> str:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "disable")
    return wait_transport("CELL", 20)


def cut_all() -> None:
    sh("shell", "svc", "wifi", "disable")
    sh("shell", "svc", "data", "disable")


def media(pkg: str) -> dict:
    t = sh("shell", "dumpsys", "media_session")
    candidates = []
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
        title = desc.group(1).strip() if desc else "?"
        if title.lower() in ("null", "none", ""):
            title = "?"
        candidates.append(
            {
                "title": title,
                "state": m.group(1) if m else "?",
                "pos": int(m.group(3)) if m else -1,
            }
        )
    if not candidates:
        return {"title": "?", "state": "?", "pos": -1}
    playing = [c for c in candidates if c["state"] in ("PLAYING", "BUFFERING", "PAUSED")]
    return (playing or candidates)[0]


def dispatch(action: str) -> None:
    sh("shell", "cmd", "media_session", "dispatch", action)


def tap(name: str) -> None:
    x, y = TAP[name]
    sh("shell", "input", "tap", str(x), str(y))
    time.sleep(0.8)


def wake() -> None:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")


def app_log_hits(pkg: str, since_token: str) -> list[str]:
    raw = sh(
        "shell",
        f"run-as {pkg} sh -c 'tail -n 400 files/ytm-logs/app.log 2>/dev/null'",
        timeout=20,
    )
    keys = (
        "fin trop",
        "skip fin",
        "STATE_ENDED",
        "playNow",
        "transport change",
        "rebind",
        "Hors ligne",
        "EOS",
    )
    today = datetime.now().strftime("%Y-%m-%d")
    hits = []
    for ln in raw.splitlines():
        if today not in ln:
            continue
        if any(k in ln for k in keys):
            hits.append(ln[-220:])
    return hits[-30:]


def unexpected_skip(before: dict, after: dict, *, allow_pause: bool = False) -> bool:
    if before["title"] in ("?", "") or after["title"] in ("?", ""):
        return False
    if after["title"] != before["title"]:
        return True
    return False


def watch_same_track(pkg: str, seconds: float, tag: str) -> dict:
    """Échantillonne : le titre ne doit pas changer tout seul."""
    start = media(pkg)
    last = start
    flips = 0
    t_end = time.time() + seconds
    samples = []
    while time.time() < t_end:
        time.sleep(3)
        mute()
        cur = media(pkg)
        samples.append(cur)
        if cur["title"] not in ("?", start["title"]) and start["title"] != "?":
            flips += 1
            log(f"  SKIP-AUTO {tag}: {start['title'][:40]} → {cur['title'][:40]}")
            start = cur
        last = cur
    return {"start": start, "last": last, "flips": flips, "samples": samples}


def login(pkg: str, api: str) -> None:
    env = os.environ.copy()
    env["DEVICE"] = SERIAL
    env["PKG"] = pkg
    env["API_BASE_URL"] = api
    r = subprocess.run(
        ["bash", str(ROOT / "scripts" / "adb" / "adb-login.sh")],
        cwd=str(ROOT),
        capture_output=True,
        timeout=90,
        env=env,
    )
    out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
    log(f"adb-login {pkg} exit={r.returncode} {out.strip()[-160:]}")
    sh("shell", "am", "force-stop", "com.google.android.apps.youtube.music")
    sh("shell", "am", "force-stop", "com.google.android.youtube")


def start_playback(pkg: str) -> dict:
    wake()
    tap("accueil")
    time.sleep(0.6)
    tap("aleatoire")
    time.sleep(3)
    m = media(pkg)
    if m["state"] not in ("PLAYING", "BUFFERING"):
        dispatch("play")
        time.sleep(1.5)
        m = media(pkg)
    if m["state"] not in ("PLAYING", "BUFFERING") or m["title"] == "?":
        tap("papaoutai")
        time.sleep(3)
        dispatch("play")
        time.sleep(1.2)
        m = media(pkg)
    return m


def flavor(tag: str, pkg: str, api: str) -> None:
    log(f"======== {tag} {pkg} ========")
    restore_net()
    mute()
    sh("shell", "am", "force-stop", "ovh.delhomme.ytmusic")
    sh("shell", "am", "force-stop", "ovh.delhomme.ytmusic.dev")
    time.sleep(0.6)
    login(pkg, api)
    time.sleep(2)
    m = start_playback(pkg)
    check(
        f"{tag}:start",
        m["state"] in ("PLAYING", "BUFFERING") and m["title"] != "?",
        f"{m['state']} {m['title'][:50]} net={net_kind()}",
    )
    mute()

    # --- Wi‑Fi : play / skip / seek / pause ---
    to_wifi()
    dispatch("play")
    time.sleep(4)
    m0 = media(pkg)
    dispatch("next")
    time.sleep(2.5)
    mute()
    m1 = media(pkg)
    check(
        f"{tag}:wifi-skip",
        m1["title"] != "?" and m1["state"] in ("PLAYING", "BUFFERING", "PAUSED"),
        f"{m0['title'][:28]} → {m1['title'][:28]} net={net_kind()}",
    )
    dispatch("fast forward")
    time.sleep(1.2)
    dispatch("fast forward")
    time.sleep(1.5)
    m2 = media(pkg)
    check(
        f"{tag}:wifi-seek",
        m2["title"] == m1["title"] or m1["title"] == "?",
        f"pos {m1['pos']}→{m2['pos']} {m2['title'][:36]}",
    )
    dispatch("pause")
    time.sleep(1.2)
    dispatch("play")
    time.sleep(1.5)
    check(f"{tag}:wifi-pause-play", media(pkg)["state"] in ("PLAYING", "BUFFERING"), media(pkg)["state"])

    # --- Wi‑Fi → 4G pendant lecture (même titre) ---
    before = media(pkg)
    kind = to_cell()
    time.sleep(6)
    mute()
    after = media(pkg)
    auto = unexpected_skip(before, after)
    check(
        f"{tag}:wifi→4g-same-track",
        not auto and after["title"] != "?",
        f"{before['title'][:32]} → {after['title'][:32]} pos {before['pos']}→{after['pos']} net={kind}/{net_kind()}",
    )

    # --- Actions sur 4G : skip, seek, pause ---
    a = media(pkg)
    dispatch("next")
    time.sleep(3)
    mute()
    b = media(pkg)
    check(
        f"{tag}:4g-skip",
        b["state"] in ("PLAYING", "BUFFERING", "PAUSED") and b["title"] != "?",
        f"{a['title'][:28]} → {b['title'][:28]} net={net_kind()}",
    )
    dispatch("rewind")
    time.sleep(1)
    dispatch("fast forward")
    time.sleep(1.5)
    c = media(pkg)
    check(
        f"{tag}:4g-seek-same",
        c["title"] == b["title"] or b["title"] == "?",
        f"{b['title'][:36]} pos {b['pos']}→{c['pos']}",
    )
    dispatch("pause")
    time.sleep(2)
    dispatch("play")
    time.sleep(2)
    check(f"{tag}:4g-pause-play", media(pkg)["state"] in ("PLAYING", "BUFFERING"), str(media(pkg)))

    # --- 4G → Wi‑Fi pendant skip ---
    before = media(pkg)
    dispatch("next")
    kind = to_wifi()
    time.sleep(5)
    mute()
    after = media(pkg)
    check(
        f"{tag}:4g→wifi-during-skip",
        after["title"] != "?" and after["state"] in ("PLAYING", "BUFFERING", "PAUSED"),
        f"{before['title'][:28]} → {after['title'][:28]} net={kind}",
    )

    # --- Bascule régulière Wi‑Fi ↔ 4G pendant lecture (sans skip manuel) ---
    dispatch("play")
    time.sleep(2)
    start = media(pkg)
    flips_auto = 0
    for i in range(6):
        mute()
        if i % 2 == 0:
            k = to_cell()
        else:
            k = to_wifi()
        snap0 = media(pkg)
        time.sleep(8)
        mute()
        snap1 = media(pkg)
        if unexpected_skip(snap0, snap1) or (start["title"] not in ("?", snap1["title"]) and snap1["title"] != "?" and snap0["title"] != start["title"] and snap1["title"] != snap0["title"]):
            if snap0["title"] != snap1["title"] and "?" not in (snap0["title"], snap1["title"]):
                flips_auto += 1
                log(f"  auto-skip flip#{i+1} {snap0['title'][:30]} → {snap1['title'][:30]} net={k}")
        log(f"  flip#{i+1} {k} {snap1['state']} pos={snap1['pos']} {snap1['title'][:40]}")
        # seek au milieu d’une bascule
        if i == 2:
            dispatch("fast forward")
        if i == 4:
            dispatch("pause")
            time.sleep(1)
            dispatch("play")
    end = media(pkg)
    check(
        f"{tag}:flips-no-mid-skip",
        flips_auto == 0,
        f"auto={flips_auto} start={start['title'][:28]} end={end['title'][:28]} net={net_kind()}",
    )

    # --- Coupure totale 15 s puis 4G puis Wi‑Fi : même titre (ou pause réseau, pas autre piste) ---
    held = media(pkg)
    cut_all()
    time.sleep(15)
    mute()
    mid = media(pkg)
    k4 = to_cell()
    time.sleep(8)
    mute()
    back4 = media(pkg)
    if back4["state"] in ("PAUSED", "STOPPED"):
        dispatch("play")
        time.sleep(2)
        back4 = media(pkg)
    kwi = to_wifi()
    time.sleep(6)
    mute()
    backw = media(pkg)
    if backw["state"] in ("PAUSED", "STOPPED"):
        dispatch("play")
        time.sleep(2)
        backw = media(pkg)
    jumped = (
        held["title"] not in ("?", "")
        and backw["title"] not in ("?", held["title"])
        and mid["title"] not in ("?", held["title"])
        and back4["title"] not in ("?", held["title"])
    )
    # OK si même titre, ou pause réseau (titre identique paused)
    sameish = backw["title"] in (held["title"], "?") or back4["title"] == held["title"]
    check(
        f"{tag}:cut-15s-resume-same",
        sameish and not jumped,
        f"held={held['title'][:28]} mid={mid['state']}/{mid['title'][:22]} "
        f"4g={back4['title'][:22]} wifi={backw['title'][:22]} net={k4}->{kwi}",
    )

    # skip après retour réseau
    dispatch("next")
    time.sleep(3)
    mute()
    nxt = media(pkg)
    check(
        f"{tag}:skip-after-restore",
        nxt["title"] != "?",
        f"{nxt['state']} {nxt['title'][:40]} net={net_kind()}",
    )

    hits = app_log_hits(pkg, "")
    auto_playnow = [h for h in hits if "playNow" in h and "auto=true" in h]
    early = [h for h in hits if "fin trop" in h or "skip fin" in h]
    check(
        f"{tag}:logs-early-end",
        len(early) == 0,
        f"early={len(early)} auto_playNow={len(auto_playnow)} hits={len(hits)}",
    )
    (OUT / f"log-{tag}.txt").write_text("\n".join(hits), encoding="utf-8")

    dispatch("pause")
    mute()
    restore_net()


def leave_phones_quiet() -> None:
    restore_net()
    mute()
    dispatch("pause")
    mute(NOTHING)
    sh("shell", "cmd", "media_session", "dispatch", "pause", serial=NOTHING)
    mute(NOTHING)
    # ne PAS am start le Nothing
    sh("shell", "am", "force-stop", "ovh.delhomme.ytmusic", serial=NOTHING)
    mute()


def main() -> int:
    log(f"OUT={OUT} samsung={SERIAL}")
    mute()
    mute(NOTHING)
    sh("shell", "cmd", "media_session", "dispatch", "pause", serial=NOTHING)
    try:
        flavors = []
        if ONLY in ("both", "dev"):
            flavors.append(("DEV", "ovh.delhomme.ytmusic.dev", LAN))
        if ONLY in ("both", "prod"):
            flavors.append(("PROD", "ovh.delhomme.ytmusic", PROD_API))
        for tag, pkg, api in flavors:
            try:
                flavor(tag, pkg, api)
            except Exception as e:
                check(f"{tag}:exception", False, str(e)[:180])
                restore_net()
    finally:
        leave_phones_quiet()

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    passed = sum(1 for c in report["checks"] if c["ok"])
    failed = sum(1 for c in report["checks"] if not c["ok"])
    report["summary"] = {"passed": passed, "failed": failed}
    path = OUT / "report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} passed={passed} failed={failed} → {path}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
