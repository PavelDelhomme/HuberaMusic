#!/usr/bin/env python3
"""Chaîne aléatoire : fin de titre → suivant sans « Chargement » bloqué.

Sans son. Ne force-stop pas (session conservée). Pas de clavier.

Usage:
  DEVICE=R5CT7263YJL PKG=ovh.delhomme.ytmusic python3 -u scripts/android/shuffle-end-chain.py
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
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "logs" / "smoke" / f"shuffle-end-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{re.sub(r'[^a-zA-Z0-9]+', '_', DEV)[:24]}"
OUT.mkdir(parents=True, exist_ok=True)

# Enchaînement OK si le suivant est PLAYING en moins de ce délai
NEXT_OK_S = float(os.environ.get("NEXT_OK_S", "6.0"))
PASSES = int(os.environ.get("PASSES", "4"))


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
    sh("shell", "media", "volume", "--stream", "3", "--set", "0")


def dump_ui() -> str:
    sh("shell", "uiautomator", "dump", "/sdcard/ui-end.xml")
    return sh("shell", "cat", "/sdcard/ui-end.xml")


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
    for m in re.finditer(
        r'content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
        xml,
    ):
        t, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
        ok = (label.lower() in t.lower()) if contains else (t == label)
        if ok:
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
            log(f"  tap-desc {t!r} @{x},{y}")
            sh("shell", "input", "tap", str(x), str(y))
            return True
    return False


def session() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "dur": -1, "queue": -1, "score": -1}
    state_map = {0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 6: "BUFFERING", 7: "ERROR"}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 4000]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        st = re.search(r"state=PlaybackState\s*\{state=(?:([A-Z_]+)\()?(\d+)", chunk)
        md = re.search(r"metadata:.*description=(.*?)(?:,|\n|$)", chunk)
        q = re.search(r"Queue Size:\s*(\d+)", chunk) or re.search(r"queue size\s*=\s*(\d+)", chunk, re.I)
        if not st:
            continue
        state_num = int(st.group(2))
        state = state_map.get(state_num, st.group(1) or str(state_num))
        pos_m = re.search(r"position=(\d+)", chunk[st.start() : st.start() + 280])
        pos = int(pos_m.group(1)) if pos_m else -1
        dur_m = re.search(r"duration=(\d+)", chunk)
        dur = int(dur_m.group(1)) if dur_m else -1
        title = (md.group(1).strip() if md else "?")[:80]
        queue = int(q.group(1)) if q else -1
        score = (10 if state == "PLAYING" else 5 if state == "BUFFERING" else 1) + (1 if pos > 0 else 0)
        cand = {"title": title, "state": state, "pos": pos, "dur": dur, "queue": queue, "score": score}
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
        if last["state"] == "PLAYING" and last["title"] not in ("?", ""):
            return {**last, "ttfb_s": round(time.time() - t0, 2)}
        time.sleep(0.25)
    return {**last, "ttfb_s": round(time.time() - t0, 2)}


def dismiss_overlays() -> None:
    xml = dump_ui()
    if "intentresolver" in xml or "Texte à partager" in xml or "Partager" in xml:
        log("  dismiss share/overlay")
        sh("shell", "input", "keyevent", "4")
        time.sleep(0.35)


def remaining_from_ui(xml: str) -> tuple[int, int | None]:
    """Retourne (secondes restantes, y1 du label) ou (-1, None)."""
    best = (-1, None)
    for t, _d, (_a, y1, _c, _d2) in _nodes(xml):
        m = re.match(r"^-(\d+):(\d{2})$", t or "")
        if m:
            sec = int(m.group(1)) * 60 + int(m.group(2))
            if sec > best[0]:
                best = (sec, y1)
    return best


def player_sheet_open(xml: str) -> bool:
    texts = [t for t, _d, _b in _nodes(xml)]
    playerish = any(t in texts for t in ("Paroles", "File d'attente", "En cours", "Vitesse", "Égaliseur"))
    nav = "Accueil" in texts and "Biblio" in texts
    return playerish and not nav


def open_now_playing() -> None:
    dismiss_overlays()
    xml = dump_ui()
    if player_sheet_open(xml):
        return
    size = sh("shell", "wm", "size")
    m = re.search(r"(\d+)x(\d+)", size)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1080, 2340)
    # Mini-bar : à gauche de Pause/Lecture bas d’écran
    for t, d, (x1, y1, x2, y2) in _nodes(xml):
        if (t or d) in ("Pause", "Lecture", "Play") and y1 > h * 0.70:
            sh("shell", "input", "tap", str(max(80, x1 - 240)), str((y1 + y2) // 2))
            log("  open NP via mini-bar")
            time.sleep(0.95)
            return
    sh("shell", "input", "tap", str(w // 2), str(int(h * 0.80)))
    log("  open NP fallback")
    time.sleep(0.95)


def seek_near_end() -> bool:
    """Tap la barre de seek vers la fin (reste ~8–20 s)."""
    dismiss_overlays()
    open_now_playing()
    dismiss_overlays()
    xml = dump_ui()
    rem_s, rem_y = remaining_from_ui(xml)
    size = sh("shell", "wm", "size")
    m = re.search(r"(\d+)x(\d+)", size)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1080, 2340)
    seek_y = (rem_y - 52) if rem_y else int(h * 0.72)
    # Compose slider : swipe sur la ligne au-dessus du -M:SS (pas un tap extrême = share)
    x0, x1 = int(w * 0.16), int(w * 0.86)
    log(f"  seek-swipe {x0}->{x1} y={seek_y} rem_ui={rem_s}s")
    sh("shell", "input", "swipe", str(x0), str(seek_y), str(x1), str(seek_y), "320")
    time.sleep(0.7)
    dismiss_overlays()
    xml = dump_ui()
    rem_s, rem_y = remaining_from_ui(xml)
    if rem_y:
        seek_y = rem_y - 52
    if rem_s > 28:
        x1b = int(w * 0.90)
        log(f"  seek-swipe2 {x0}->{x1b} y={seek_y} rem_ui={rem_s}s")
        sh("shell", "input", "swipe", str(x0), str(seek_y), str(x1b), str(seek_y), "280")
        time.sleep(0.6)
        dismiss_overlays()
        xml = dump_ui()
        rem_s, _ = remaining_from_ui(xml)
    if 4 <= rem_s <= 28:
        log(f"  seek ok rem={rem_s}s")
        return True
    s = session()
    log(f"  after-seek rem={rem_s}s title={s['title']!r} {s['state']} pos={s['pos']}")
    return rem_s >= 0


def _nodes(xml: str):
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


def open_library_shuffle() -> dict:
    sh("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    sh("shell", "wm", "dismiss-keyguard")
    mute()
    sh("shell", "am", "start", "-n", f"{PKG}/ovh.delhomme.ytmusic.MainActivity")
    time.sleep(2.4)
    xml = dump_ui()
    tap_text(xml, "Biblio") or tap_text(xml, "Bibliothèque", contains=True)
    time.sleep(1.2)
    xml = dump_ui()
    tap_text(xml, "Titres")
    time.sleep(1.0)
    xml = dump_ui()
    t_click = time.time()
    ok = tap_text(xml, "Aléatoire") or tap_text(xml, "Aléatoire", contains=True)
    if not ok:
        return {"ok": False, "error": "Aléatoire biblio introuvable"}
    s = wait_playing(16.0)
    mute()
    return {
        "ok": s["state"] in ("PLAYING", "BUFFERING"),
        "click_to_play_s": round(time.time() - t_click, 2),
        **s,
    }


def enable_player_shuffle() -> None:
    xml = dump_ui()
    # Ouvre le lecteur si mini-bar
    if "Aléatoire" not in xml:
        size = sh("shell", "wm", "size")
        m = re.search(r"(\d+)x(\d+)", size)
        w, h = (int(m.group(1)), int(m.group(2))) if m else (1080, 2340)
        sh("shell", "input", "tap", str(w // 2), str(int(h * 0.86)))
        time.sleep(0.8)
        xml = dump_ui()
    tap_text(xml, "Aléatoire") or tap_text(xml, "Aléatoire", contains=True)
    time.sleep(0.5)
    mute()


def measure_end_to_next(label: str) -> dict:
    seek_near_end()
    mute()
    before = session()
    title0 = before.get("title") or "?"
    t0 = time.time()
    last = before
    buffering_s = 0.0
    buf_start = None
    while time.time() - t0 < 28.0:
        last = session()
        title = last.get("title") or "?"
        st = last.get("state")
        if st == "BUFFERING":
            if buf_start is None:
                buf_start = time.time()
        elif buf_start is not None:
            buffering_s += time.time() - buf_start
            buf_start = None
        changed = title not in ("?", title0) and title0 != "?"
        if changed and st == "PLAYING":
            if buf_start is not None:
                buffering_s += time.time() - buf_start
            gap = round(time.time() - t0, 2)
            ok = gap <= NEXT_OK_S and buffering_s <= NEXT_OK_S
            rec = {
                "label": label,
                "from": title0,
                "to": title,
                "gap_s": gap,
                "buffering_s": round(buffering_s, 2),
                "state": st,
                "ok": ok,
            }
            log(f"  END→NEXT {json.dumps(rec, ensure_ascii=False)}")
            return rec
        time.sleep(0.22)
    rec = {
        "label": label,
        "from": title0,
        "to": last.get("title"),
        "gap_s": round(time.time() - t0, 2),
        "buffering_s": round(buffering_s, 2),
        "state": last.get("state"),
        "ok": False,
        "error": "timeout",
    }
    log(f"  END→NEXT FAIL {json.dumps(rec, ensure_ascii=False)}")
    return rec


def measure_skip(label: str) -> dict:
    before = session()
    title0 = before.get("title") or "?"
    t0 = time.time()
    dispatch("next")
    last = before
    while time.time() - t0 < 14.0:
        last = session()
        title = last.get("title") or "?"
        if title not in ("?", title0) and last.get("state") == "PLAYING":
            rec = {
                "label": label,
                "from": title0,
                "to": title,
                "gap_s": round(time.time() - t0, 2),
                "state": last.get("state"),
                "ok": (time.time() - t0) <= NEXT_OK_S,
            }
            log(f"  SKIP {json.dumps(rec, ensure_ascii=False)}")
            mute()
            return rec
        time.sleep(0.22)
    rec = {
        "label": label,
        "from": title0,
        "to": last.get("title"),
        "gap_s": round(time.time() - t0, 2),
        "state": last.get("state"),
        "ok": False,
    }
    log(f"  SKIP FAIL {json.dumps(rec, ensure_ascii=False)}")
    mute()
    return rec


def try_playlist_shuffle() -> dict:
    xml = dump_ui()
    tap_text(xml, "Biblio") or tap_text(xml, "Bibliothèque", contains=True)
    time.sleep(0.8)
    xml = dump_ui()
    if not (tap_text(xml, "Playlists") or tap_text(xml, "Playlist", contains=True)):
        return {"ok": False, "error": "onglet Playlists absent"}
    time.sleep(1.0)
    xml = dump_ui()
    # Premier nom de playlist (évite les chips)
    opened = False
    for t, d, (x1, y1, x2, y2) in _nodes(xml):
        label = t or d
        if not label or label in ("Playlists", "Playlist", "Titres", "Albums", "Artistes", "Aléatoire", "Tout lire"):
            continue
        if y1 < 280:
            continue
        sh("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
        log(f"  open playlist {label!r}")
        opened = True
        break
    if not opened:
        return {"ok": False, "error": "aucune playlist cliquable"}
    time.sleep(1.2)
    xml = dump_ui()
    t0 = time.time()
    if not (tap_text(xml, "Aléatoire") or tap_text(xml, "Aléatoire", contains=True)):
        return {"ok": False, "error": "Aléatoire playlist introuvable"}
    s = wait_playing(16.0)
    mute()
    return {"ok": s["state"] in ("PLAYING", "BUFFERING"), "click_to_play_s": round(time.time() - t0, 2), **s}


def main() -> int:
    if not DEV:
        raise SystemExit("DEVICE required")
    log(f"START device={DEV} pkg={PKG} out={OUT}")
    mute()
    ver = ""
    pkg = sh("shell", "dumpsys", "package", PKG)
    for line in pkg.splitlines():
        if "versionName=" in line:
            ver = line.split("=", 1)[1].strip()
            break
    log(f"version={ver}")

    results: list[dict] = []
    shuf = open_library_shuffle()
    log(f"SHUFFLE_LIB {json.dumps(shuf, ensure_ascii=False)}")
    results.append({"kind": "shuffle_lib", **shuf})
    if not shuf.get("ok"):
        report = {"device": DEV, "version": ver, "results": results, "pass": False}
        (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        return 1

    # File déjà mélangée par « Aléatoire » biblio — ne pas retaper le chip liste.
    time.sleep(8.0)
    open_now_playing()
    mute()

    for i in range(PASSES):
        results.append(measure_end_to_next(f"lib-end-{i+1}"))
        time.sleep(7.0)  # warmup du nouveau +1

    for i in range(3):
        results.append(measure_skip(f"lib-skip-{i+1}"))
        time.sleep(5.0)

    pl = try_playlist_shuffle()
    log(f"SHUFFLE_PL {json.dumps(pl, ensure_ascii=False)}")
    results.append({"kind": "shuffle_playlist", **pl})
    if pl.get("ok"):
        time.sleep(8.0)
        open_now_playing()
        time.sleep(0.6)
        results.append(measure_end_to_next("pl-end-1"))
        time.sleep(6.0)
        results.append(measure_skip("pl-skip-1"))

    chain = [r for r in results if r.get("label")]
    ok_n = sum(1 for r in chain if r.get("ok"))
    report = {
        "device": DEV,
        "version": ver,
        "results": results,
        "chain_ok": ok_n,
        "chain_n": len(chain),
        "pass": bool(shuf.get("ok")) and ok_n >= max(3, len(chain) - 2),
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"DONE pass={report['pass']} chain={ok_n}/{len(chain)}")
    return 0 if report["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
