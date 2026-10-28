#!/usr/bin/env python3
"""Preuve recherche Samsung. Volume 0. Ne lance pas la lecture. Pas le Nothing."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

SERIAL = "R5CT7263YJL"
PKG = "cloud.hubera.music"


def adb(*args, timeout=40):
    return subprocess.run(
        ["adb", "-s", SERIAL, *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def dump():
    adb("shell", "uiautomator", "dump", "/sdcard/hubera-search-proof.xml")
    p = adb("exec-out", "cat", "/sdcard/hubera-search-proof.xml")
    return p.stdout or ""


def nodes(xml):
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for n in root.iter("node"):
        t = n.attrib.get("text") or ""
        d = n.attrib.get("content-desc") or ""
        cls = n.attrib.get("class") or ""
        b = n.attrib.get("bounds") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b)
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        out.append((t, d, cls, (x1 + x2) // 2, (y1 + y2) // 2, y1))
    return out


def tap_label(*needles):
    xml = dump()
    for t, d, _cls, x, y, _y1 in nodes(xml):
        hay = f"{t} {d}".lower()
        if any(n.lower() in hay for n in needles):
            adb("shell", "input", "tap", str(x), str(y))
            print(f"tap {t or d!r}", flush=True)
            return True
    return False


def texts(xml):
    rows = []
    for t, d, _cls, _x, _y, y1 in nodes(xml):
        label = (t or d).strip()
        if label:
            rows.append((y1, label))
    rows.sort()
    seen = []
    for _, label in rows:
        if not seen or seen[-1] != label:
            seen.append(label)
    return seen


def pause():
    adb("shell", "input", "keyevent", "127")


def main():
    dev = subprocess.run(["adb", "devices"], text=True, capture_output=True).stdout
    if SERIAL not in dev:
        raise SystemExit(f"Samsung absent\n{dev}")
    adb("shell", "media", "volume", "--stream", "3", "--set", "0")
    adb("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    music = adb("shell", "settings", "get", "system", "volume_music_speaker").stdout.strip()
    print("VOLUME", music, flush=True)
    if os.environ.get("SKIP_LAUNCH") != "1":
        adb("shell", "input", "keyevent", "224")
        adb("shell", "am", "force-stop", PKG)
        time.sleep(0.5)
        adb("shell", "am", "start", "-n", f"{PKG}/ovh.delhomme.ytmusic.MainActivity")
        time.sleep(4)
        pause()
        if not tap_label("Recherche", "Search"):
            adb("shell", "input", "tap", "324", "2200")
            time.sleep(0.8)
        time.sleep(1)
    xml = dump()
    focused = False
    for t, d, cls, x, y, _y1 in nodes(xml):
        if cls.endswith("EditText"):
            adb("shell", "input", "tap", str(x), str(y))
            focused = True
            print("focus", cls, x, y, flush=True)
            break
    if not focused:
        tap_label("Titres", "artistes", "Recherche")
    time.sleep(0.4)

    def run_query(q):
        adb("shell", "input", "text", q.replace(" ", "%s"))
        time.sleep(0.3)
        adb("shell", "input", "keyevent", "66")
        time.sleep(7)
        pause()
        labels = texts(dump())
        print("QUERY", q, flush=True)
        for label in labels:
            print("UI", label, flush=True)
        return labels

    run_query("je vais bine ostromae")
    for _ in range(40):
        adb("shell", "input", "keyevent", "67")
    time.sleep(0.3)
    run_query("stromae")
    pause()
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
