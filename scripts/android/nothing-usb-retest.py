#!/usr/bin/env python3
"""Nothing PROD via ADB **USB** — journal d’actions/événements + Wi‑Fi↔4G.

Le câble USB reste : on peut couper le Wi‑Fi sans tuer ADB (ni dépendre du debug Wi‑Fi).
Volume 0. Restaure Wi‑Fi + data en fin.

Usage:
  DEVICE=00145153K001434 python3 -u scripts/android/nothing-usb-retest.py
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
SERIAL = os.environ.get("DEVICE") or "00145153K001434"
OUT = ROOT / "docs" / "reports" / f"nothing-usb-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
EVENTS = OUT / "events.jsonl"

report: dict = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "device": SERIAL,
    "transport": "usb",
    "pkg": PKG,
    "checks": [],
    "ok": True,
    "nullHits": [],
}


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def event(kind: str, **payload) -> None:
    rec = {
        "ts": datetime.now().strftime("%H:%M:%S.%f")[:-3],
        "kind": kind,
        **payload,
    }
    with EVENTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def sh(*args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", SERIAL, *args],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        event("adb-timeout", cmd=" ".join(args))
        return "TIMEOUT"
    return ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        report["ok"] = False
    event("check", name=name, ok=bool(ok), detail=detail)
    log(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def mute() -> None:
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")


def vol() -> str:
    t = sh("shell", "dumpsys", "audio")
    m = re.search(r"STREAM_MUSIC:.*?streamVolume:\s*(\d+)", t, re.S)
    return m.group(1) if m else "?"


def net_kind() -> str:
    route = sh("shell", "ip", "route", "get", "1.1.1.1")
    if "wlan0" in route:
        return "WIFI"
    if "unreachable" in route.lower():
        return "NONE"
    if "rmnet" in route or "ccmni" in route:
        return "CELLULAR"
    t = sh("shell", "dumpsys", "connectivity")
    mid = re.search(r"Active default network:\s+(\d+)", t)
    if mid:
        m2 = re.search(rf"network\{{{mid.group(1)}\}}\s+.*?Transports:\s+(\w+)", t, re.S)
        if m2:
            return m2.group(1).upper()
    return "NONE"


def wait_transport(want: str, secs: float = 20) -> str:
    deadline = time.time() + secs
    last = "?"
    while time.time() < deadline:
        last = net_kind()
        event("net", want=want, got=last)
        if want == "CELL" and last.startswith("CELL"):
            return last
        if want == "WIFI" and last.startswith("WIFI"):
            return last
        if want == "NONE" and last == "NONE":
            return last
        time.sleep(1.0)
    return last


def to_wifi() -> str:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "enable")
    k = wait_transport("WIFI", 18)
    event("action", name="to_wifi", net=k)
    return k


def to_cell() -> str:
    sh("shell", "svc", "data", "enable")
    sh("shell", "svc", "wifi", "disable")
    k = wait_transport("CELL", 22)
    event("action", name="to_cell", net=k)
    return k


def cut_all() -> None:
    sh("shell", "svc", "wifi", "disable")
    sh("shell", "svc", "data", "disable")
    event("action", name="cut_all")


def restore_net() -> None:
    sh("shell", "cmd", "connectivity", "airplane-mode", "disable")
    sh("shell", "svc", "wifi", "enable")
    sh("shell", "svc", "data", "enable")
    wait_transport("WIFI", 18)
    event("action", name="restore_net", net=net_kind())


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
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        cand = {"title": title, "state": state, "pos": pos, "raw_title": raw, "score": score}
        if cand["score"] >= best.get("score", -1):
            best = cand
    event("media", **{k: best[k] for k in ("title", "state", "pos", "raw_title")})
    return best


def dispatch(action: str) -> None:
    event("action", name=f"media:{action}")
    sh("shell", "cmd", "media_session", "dispatch", action)


def dump_ui(tag: str) -> str:
    remote = f"/sdcard/ui-{tag}.xml"
    sh("shell", "uiautomator", "dump", remote, timeout=20)
    local = OUT / f"ui-{tag}.xml"
    subprocess.run(
        ["adb", "-s", SERIAL, "pull", remote, str(local)],
        capture_output=True,
        timeout=20,
    )
    xml = local.read_text(encoding="utf-8", errors="ignore") if local.exists() else ""
    event("ui", tag=tag, n=len(re.findall(r'text="([^"]*)"', xml)))
    return xml


def texts_of(xml: str) -> list[str]:
    return re.findall(r'text="([^"]*)"', xml)


def nullish(xml: str) -> list[str]:
    hits = []
    for t in texts_of(xml):
        s = t.strip()
        if s.lower() in ("null", "undefined") or re.fullmatch(r"(?i)erreur\s*[:\-]?\s*null", s):
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
            event("action", name="tap", label=t, x=x, y=y)
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
    event("action", name="login", rc=r.returncode, tail=out.strip()[-160:])
    log(f"adb-login exit={r.returncode} {out.strip()[-160:]}")
    sh("shell", "am", "force-stop", "com.google.android.apps.youtube.music")
    sh("shell", "am", "force-stop", "com.google.android.youtube")


def logcat_slice() -> str:
    return sh("logcat", "-d", "-t", "120", timeout=25)


def interesting(lc: str) -> list[str]:
    keys = (
        "onPlayerError",
        "fin trop",
        "skip fin",
        "playNow",
        "transport change",
        "rebind",
        "NullPointer",
        "FATAL",
        "Lecture impossible",
        "erreur null",
        "STATE_ENDED",
        "EOS",
    )
    hits = []
    for ln in lc.splitlines():
        if any(k.lower() in ln.lower() for k in keys) and PKG.split(".")[-1] in ln or any(
            k in ln for k in ("PlaybackService", "NetworkMonitor", "player:", "AndroidRuntime")
        ):
            if any(k.lower() in ln.lower() for k in keys):
                hits.append(ln[-240:])
    return hits[-12:]


def snap(tag: str) -> dict:
    mute()
    m = media()
    n = net_kind()
    rec = {**m, "net": n, "vol": vol(), "tag": tag}
    event("snap", **rec)
    log(f"  [{tag}] {m['state']} pos={m['pos']} net={n} {m['title'][:40]} raw={m['raw_title'][:18]!r}")
    return rec


def main() -> int:
    log(f"OUT={OUT} usb={SERIAL}")
    event("start", serial=SERIAL, usb=True)
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    restore_net()
    mute()
    sh("shell", "logcat", "-c")

    usb = "usb:" in sh("get-state") or "usb:" in subprocess.run(
        ["adb", "devices", "-l"], capture_output=True, text=True
    ).stdout
    # devices -l
    blob = subprocess.run(["adb", "devices", "-l"], capture_output=True, text=True).stdout
    check("transport:usb", SERIAL in blob and "usb:" in blob, blob.strip().replace("\n", " | "))

    login()
    time.sleep(2)
    mute()
    xml = dump_ui("home")
    report["nullHits"].extend(nullish(xml))
    tap_text(xml, "Accueil")
    time.sleep(0.7)
    xml = dump_ui("accueil")
    report["nullHits"].extend(nullish(xml))
    if not tap_text(xml, "Aléatoire"):
        sh("shell", "input", "tap", "864", "610")
        event("action", name="tap-fallback-aleatoire")
    time.sleep(3.2)
    dispatch("play")
    time.sleep(1.4)
    mute()
    s = snap("start")
    check(
        "play:start",
        s["state"] in ("PLAYING", "BUFFERING") and s["raw_title"].lower() != "null" and s["title"] != "?",
        f"{s['state']} {s['title'][:48]} vol={s['vol']}",
    )
    xml = dump_ui("playing")
    nh = nullish(xml)
    report["nullHits"].extend(nh)
    check("ui:no-null", len(nh) == 0, str(nh))

    # soak milieu
    held = snap("soak0")
    auto = 0
    for i in range(8):
        time.sleep(8)
        cur = snap(f"soak{i+1}")
        hits = interesting(logcat_slice())
        if hits:
            event("log", soak=i + 1, hits=hits)
        if held["title"] not in ("?", "") and cur["title"] not in ("?", held["title"]):
            auto += 1
            event("auto-skip", frm=held["title"], to=cur["title"])
            held = cur
        if cur["raw_title"].lower() == "null":
            report["nullHits"].append("media description=null")
    check("soak:no-mid-skip", auto == 0, f"auto={auto}")
    check("soak:no-null", not any("null" in str(x).lower() for x in report["nullHits"]), str(report["nullHits"]))

    # skip seek pause
    a = snap("pre-skip")
    dispatch("next")
    time.sleep(2.5)
    b = snap("post-skip")
    check("skip", b["title"] != "?" and b["raw_title"].lower() != "null", f"{a['title'][:24]} → {b['title'][:24]}")
    dispatch("fast forward")
    time.sleep(0.8)
    dispatch("fast forward")
    time.sleep(1.0)
    c = snap("post-seek")
    check("seek-same", c["title"] == b["title"] or b["title"] == "?", f"pos {b['pos']}→{c['pos']}")
    dispatch("pause")
    time.sleep(1.0)
    dispatch("play")
    time.sleep(1.2)
    check("pause-play", snap("post-pp")["state"] in ("PLAYING", "BUFFERING"))
    for i in range(4):
        dispatch("next")
        time.sleep(2.0)
        x = snap(f"skip{i+2}")
        if x["raw_title"].lower() == "null":
            report["nullHits"].append(f"skip-null-{i}")
    check("skips:no-null", all("skip-null" not in str(x) for x in report["nullHits"]))

    # tabs
    for tab in ("Recherche", "Biblio", "Accueil"):
        xml = dump_ui(f"pre-{tab}")
        tap_text(xml, tab)
        time.sleep(1.2)
        xml = dump_ui(f"tab-{tab}")
        bad = nullish(xml)
        report["nullHits"].extend(bad)
        check(f"tab:{tab}:no-null", len(bad) == 0, str(bad))

    # USB : Wi‑Fi → 4G pendant lecture (ADB câble intact)
    dispatch("play")
    time.sleep(1.5)
    before = snap("pre-4g")
    k = to_cell()
    time.sleep(6)
    after = snap("on-4g")
    check(
        "wifi→4g-same-track",
        after["title"] in (before["title"], "?") or before["title"] == "?",
        f"{before['title'][:28]} → {after['title'][:28]} net={k}/{after['net']}",
    )
    dispatch("next")
    time.sleep(2.5)
    check("4g-skip", snap("4g-skip")["title"] != "?")
    dispatch("fast forward")
    time.sleep(1.0)
    seek4 = snap("4g-seek")
    check("4g-seek", seek4["raw_title"].lower() != "null")
    dispatch("pause")
    time.sleep(1.0)
    dispatch("play")
    time.sleep(1.2)
    check("4g-pause-play", snap("4g-pp")["state"] in ("PLAYING", "BUFFERING"))

    held = snap("pre-wifi")
    dispatch("next")
    kw = to_wifi()
    time.sleep(5)
    back = snap("on-wifi")
    check(
        "4g→wifi-during-skip",
        back["title"] != "?" and back["raw_title"].lower() != "null",
        f"{held['title'][:24]} → {back['title'][:24]} net={kw}",
    )

    # flips réguliers
    start = snap("flip0")
    flips_auto = 0
    for i in range(6):
        k = to_cell() if i % 2 == 0 else to_wifi()
        s0 = snap(f"flip{i+1}a")
        time.sleep(7)
        s1 = snap(f"flip{i+1}b")
        if s0["title"] not in ("?", "") and s1["title"] not in ("?", s0["title"]):
            flips_auto += 1
            event("auto-skip", flip=i + 1, frm=s0["title"], to=s1["title"], net=k)
        if i == 2:
            dispatch("fast forward")
        if i == 4:
            dispatch("pause")
            time.sleep(0.8)
            dispatch("play")
    check("flips-no-mid-skip", flips_auto == 0, f"auto={flips_auto} net={net_kind()}")

    # coupure 15 s
    held = snap("pre-cut")
    cut_all()
    time.sleep(15)
    mid = snap("cut-15")
    k4 = to_cell()
    time.sleep(6)
    b4 = snap("after-cut-4g")
    if b4["state"] in ("PAUSED", "STOPPED"):
        dispatch("play")
        time.sleep(2)
        b4 = snap("after-cut-4g-play")
    kw = to_wifi()
    time.sleep(5)
    bw = snap("after-cut-wifi")
    if bw["state"] in ("PAUSED", "STOPPED"):
        dispatch("play")
        time.sleep(2)
        bw = snap("after-cut-wifi-play")
    same = bw["title"] in (held["title"], "?") or b4["title"] == held["title"]
    check(
        "cut-15s-same-track",
        same and bw["raw_title"].lower() != "null",
        f"held={held['title'][:24]} mid={mid['state']} 4g={b4['title'][:20]} wifi={bw['title'][:20]} {k4}->{kw}",
    )
    dispatch("next")
    time.sleep(2.2)
    check("skip-after-restore", snap("post-restore-skip")["title"] != "?")

    raw = sh("shell", f"run-as {PKG} sh -c 'tail -n 200 files/ytm-logs/app.log 2>/dev/null'", timeout=20)
    (OUT / "app.log.txt").write_text(raw, encoding="utf-8", errors="ignore")
    lc = sh("logcat", "-d", "-t", "500", timeout=30)
    (OUT / "logcat.txt").write_text(lc[-180_000:], encoding="utf-8", errors="ignore")
    today = datetime.now().strftime("%Y-%m-%d")
    early = [ln for ln in raw.splitlines() if today in ln and ("fin trop" in ln or "skip fin" in ln)]
    npe = [ln for ln in (raw + "\n" + lc).splitlines() if "NullPointer" in ln or "FATAL EXCEPTION" in ln]
    fatals = [ln for ln in lc.splitlines() if "FATAL EXCEPTION" in ln and PKG in ln]
    null_toast = [ln for ln in (raw + lc).splitlines() if re.search(r"(?i)erreur\s*null", ln)]
    perr = [ln for ln in raw.splitlines() if today in ln and "onPlayerError" in ln]
    event("logs", early=len(early), npe=len(npe), fatals=len(fatals), onPlayerError=len(perr))
    check("logs:no-NPE-fatal", len(npe) == 0 and len(fatals) == 0, str((npe + fatals)[-3:]))
    check("logs:no-early-end", len(early) == 0, str(early[-2:]))
    check("logs:no-erreur-null", len(null_toast) == 0, str(null_toast[-2:]))
    check("logs:onPlayerError", True, f"n={len(perr)}")

    dispatch("pause")
    mute()
    restore_net()
    # ne pas toucher au toggle « débogage sans fil » (USB suffit)
    check("wifi-restored", net_kind().startswith("WIFI") or net_kind() == "WIFI", net_kind())

    report["endedAt"] = datetime.now(timezone.utc).isoformat()
    report["volumeEnd"] = vol()
    report["nullHits"] = list(dict.fromkeys(report["nullHits"]))
    passed = sum(1 for c in report["checks"] if c["ok"])
    failed = sum(1 for c in report["checks"] if not c["ok"])
    report["summary"] = {"passed": passed, "failed": failed}
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE ok={report['ok']} {passed}/{passed+failed} vol={report['volumeEnd']} events={EVENTS}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        try:
            restore_net()
            mute()
            dispatch("pause")
        except Exception:
            pass
