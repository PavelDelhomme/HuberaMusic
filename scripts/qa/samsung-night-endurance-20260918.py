#!/usr/bin/env python3
"""Endurance Samsung jusqu'à STOP_AT (défaut 2026-10-05 02:00).

- Musique muette (volume 0) ; DND alarms-only (zen=3) — alarmes audibles
- Scénarios : lecture complète, skip chaîne, saut loin dans la file, retour arrière
- Biblio aléatoire + titres froids ; préchauffe 20 titres d'avance
- Ne touche PAS au Nothing
- Wi‑Fi intact

  DEVICE=R5CT7263YJL STOP_AT='2026-10-05 02:00' \\
    python3 -u scripts/qa/samsung-night-endurance-20260918.py
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERIAL = os.environ.get("DEVICE", "R5CT7263YJL")
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
STOP_AT = datetime.strptime(
    os.environ.get("STOP_AT", "2026-10-05 02:00"), "%Y-%m-%d %H:%M"
)
OUT = ROOT / "tmp" / f"endurance-night-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
LISTEN_S = float(os.environ.get("LISTEN_S", "25"))
LOAD_TIMEOUT_S = float(os.environ.get("LOAD_TIMEOUT_S", "40"))
SKIP_EVERY = float(os.environ.get("SKIP_EVERY", "55"))
PLAY_TO_END = os.environ.get("PLAY_TO_END", "1") == "1"
MIN_EOS_RATIO = float(os.environ.get("MIN_EOS_RATIO", "0.85"))
MAX_TRACK_S = float(os.environ.get("MAX_TRACK_S", "480"))

FAILMAIL = ROOT / "tmp" / "multi-skip-failmail-set.json"


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 45) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", SERIAL, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return "TIMEOUT"


def mute_keep_alarms() -> None:
    for s in (1, 2, 3, 5):
        sh("shell", "cmd", "media_session", "volume", "--stream", str(s), "--set", "0")
    sh("shell", "settings", "put", "system", "volume_music_speaker", "0")
    sh("shell", "cmd", "notification", "set_dnd", "alarms")
    sh("shell", "settings", "put", "global", "zen_mode", "3")
    sh("shell", "settings", "put", "system", "volume_alarm_speaker", "7")
    sh("shell", "cmd", "media_session", "volume", "--stream", "4", "--set", "7")


def load_env() -> tuple[str, str]:
    email = os.environ.get("SEED_EMAIL") or "dev@delhomme.ovh"
    password = os.environ.get("SEED_PASSWORD") or ""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("SEED_EMAIL=") and "SEED_EMAIL" not in os.environ:
                email = line.split("=", 1)[1].strip().strip('"').strip("'")
            if line.startswith("SEED_PASSWORD=") and not password:
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
    return email, password


def api_login() -> tuple[str, str, str]:
    email, password = load_env()
    req = urllib.request.Request(
        f"{API}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode())
    return d.get("token") or "", d.get("refreshToken") or "", email


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "dur": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 4500]
        nxt = re.search(r"(?m)^\s+package=", chunk[20:])
        if nxt:
            chunk = chunk[: 20 + nxt.start()]
        desc = re.search(r"description=([^\n]+)", chunk)
        m = re.search(
            r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+).*?buffered position=(\d+)",
            chunk,
        )
        if not m:
            m = re.search(
                r"state=PlaybackState \{state=(?:([A-Z]+)\()?(\d+)\)?.*?position=(\d+)",
                chunk,
            )
        dur_m = re.search(
            r"(?:METADATA_KEY_DURATION|android\.media\.metadata\.DURATION|durationMs|duration)=(\d+)",
            chunk,
            re.I,
        )
        raw = (desc.group(1).strip() if desc else "")
        title = raw if raw.lower() not in ("null", "none", "") else "?"
        code = int(m.group(2)) if m else -1
        named = (m.group(1) or "").upper() if m else ""
        state_map = {
            0: "NONE",
            1: "STOPPED",
            2: "PAUSED",
            3: "PLAYING",
            6: "BUFFERING",
            7: "ERROR",
        }
        state = named if named else state_map.get(code, str(code) if code >= 0 else "?")
        pos = int(m.group(3)) if m else -1
        buffered = int(m.group(4)) if m and m.lastindex and m.lastindex >= 4 else -1
        dur = int(dur_m.group(1)) if dur_m else -1
        if dur < 0:
            for mm in re.finditer(r"duration[^\d]{0,20}(\d{5,})", chunk, re.I):
                cand_d = int(mm.group(1))
                if 30_000 <= cand_d <= 900_000:
                    dur = cand_d
                    break
        if dur < 0 and buffered >= 45_000:
            dur = buffered
        score = 4 if state == "PLAYING" else 2 if state in ("BUFFERING", "PAUSED") else 0
        cand = {
            "title": title,
            "state": state,
            "pos": pos,
            "dur": dur,
            "buffered": buffered,
            "score": score,
        }
        if cand["score"] >= best["score"]:
            best = cand
    return best


def deeplink(video_id: str) -> None:
    sh(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        f"ytmusic://watch/{video_id}",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
    )


def skip_next() -> None:
    sh("shell", "cmd", "media_session", "dispatch", "skip_to_next")
    time.sleep(0.3)
    sh("shell", "input", "keyevent", "87")


def skip_prev() -> None:
    sh("shell", "cmd", "media_session", "dispatch", "skip_to_previous")
    time.sleep(0.3)
    sh("shell", "input", "keyevent", "88")


def is_real_title(title: str) -> bool:
    t = (title or "").strip().lower()
    if not t or t in ("?", "null", "none"):
        return False
    if "titre, artiste" in t:
        return False
    if t.startswith("file d'attente") or t == "file d'attente":
        return False
    return True


def wait_playing(
    timeout_s: float = LOAD_TIMEOUT_S,
    *,
    prev_title: str | None = None,
    prev_pos: int | None = None,
) -> dict:
    t0 = time.time()
    last = media()
    while time.time() - t0 < timeout_s:
        last = media()
        fresh = True
        if prev_title and last["title"] not in ("?", prev_title):
            fresh = True
        elif prev_pos is not None and last["pos"] >= 0 and last["pos"] + 2000 < prev_pos:
            fresh = True
        elif prev_title and last["title"] == prev_title and last["pos"] > 8_000:
            fresh = False
        title_ok = is_real_title(last.get("title") or "")
        if (
            last["state"] == "PLAYING"
            and last["pos"] >= 2000
            and fresh
            and title_ok
        ):
            return {**last, "ok": True, "load_s": round(time.time() - t0, 2)}
        time.sleep(1.0)
    return {**last, "ok": False, "load_s": round(time.time() - t0, 2)}


def fetch_library_ids(token: str, n: int = 40) -> list[str]:
    req = urllib.request.Request(
        f"{API}/api/library",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        log(f"library fetch KO: {e}")
        return []
    tracks = []
    if isinstance(d, list):
        tracks = d
    elif isinstance(d, dict):
        tracks = d.get("songs") or d.get("tracks") or d.get("items") or []
    ids = []
    for t in tracks:
        vid = t.get("id") or t.get("videoId") or ""
        if isinstance(vid, str) and len(vid) == 11:
            ids.append(vid)
    random.shuffle(ids)
    return ids[:n]


def warm_ids(token: str, ids: list[str]) -> None:
    batch = [i for i in ids if isinstance(i, str) and len(i) == 11][:20]
    if not batch:
        return
    req = urllib.request.Request(
        f"{API}/api/stream/warm",
        data=json.dumps({"ids": batch}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            log(f"warm {r.status} n={len(batch)}")
    except Exception as e:
        log(f"warm KO: {e}")


def watch_until_end(title0: str, dur0: int) -> dict:
    """Laisse jouer jusqu’à la fin (EOS) ; skip seulement stall / BUFFERING >20s."""
    t0 = time.time()
    last_pos = max(0, media().get("pos") or 0)
    last_move = time.time()
    buf0 = None
    wait_s = MAX_TRACK_S
    if dur0 and dur0 > 0:
        wait_s = min(MAX_TRACK_S, max(90.0, dur0 / 1000.0 + 40.0))
    while time.time() - t0 < wait_s and datetime.now() < STOP_AT:
        time.sleep(3.0)
        mute_keep_alarms()
        m = media()
        if m["state"] == "PAUSED" and m["title"] == title0:
            sh("shell", "input", "keyevent", "126")
            continue
        if m["state"] == "BUFFERING":
            if buf0 is None:
                buf0 = time.time()
            elif time.time() - buf0 >= 20:
                log("  BUFFERING >20s — skip (lecture incomplète)")
                return {
                    "eos": False,
                    "reason": "buffering_20s",
                    "max_pos": last_pos,
                    "dur": dur0,
                    "elapsed_s": round(time.time() - t0, 1),
                }
        else:
            buf0 = None
        if m["state"] == "ERROR":
            return {
                "eos": False,
                "reason": "error",
                "max_pos": last_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if m["pos"] > last_pos + 400:
            last_pos = m["pos"]
            last_move = time.time()
        if (
            m["title"] == title0
            and m["state"] == "PLAYING"
            and time.time() - last_move > 16
        ):
            log(f"  STALL pos={m['pos']} — skip")
            return {
                "eos": False,
                "reason": "stall_frozen",
                "max_pos": last_pos,
                "dur": dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if m["title"] != title0 and m["title"] != "?" and title0 != "?":
            ratio = (last_pos / dur0) if dur0 and dur0 > 0 else None
            ok = (
                last_pos >= int(dur0 * MIN_EOS_RATIO)
                if dur0 and dur0 > 0
                else last_pos >= 90_000
            )
            log(
                f"  EOS → {m['title'][:36]!r} pos={last_pos}/{dur0} "
                f"ratio={None if ratio is None else round(ratio, 2)} "
                f"{'OK' if ok else 'CUT'}"
            )
            return {
                "eos": ok,
                "reason": "natural_advance" if ok else "early_cut",
                "max_pos": last_pos,
                "dur": dur0,
                "ratio": ratio,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if dur0 > 0 and last_pos >= int(dur0 * 0.97):
            log(f"  NEAR_END pos={last_pos}/{dur0}")
            return {
                "eos": True,
                "reason": "reached_duration",
                "max_pos": last_pos,
                "dur": dur0,
                "ratio": last_pos / dur0,
                "elapsed_s": round(time.time() - t0, 1),
            }
        if int(time.time() - t0) % 18 < 3:
            log(f"  … {m['state']} pos={m['pos']}/{dur0} {m['title'][:32]!r}")
    return {
        "eos": False,
        "reason": "timeout",
        "max_pos": last_pos,
        "dur": dur0,
        "elapsed_s": round(time.time() - t0, 1),
    }


def cold_ids() -> list[str]:
    if not FAILMAIL.exists():
        return []
    d = json.loads(FAILMAIL.read_text())
    return [c["id"] for c in d.get("cold", []) if c.get("id")]


def main() -> None:
    log(f"OUT={OUT}")
    log(f"STOP_AT={STOP_AT.isoformat()} DEVICE={SERIAL}")
    mute_keep_alarms()
    tok, ref, email = api_login()
    log(f"login ok {email}")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.8)
    sh(
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/ovh.delhomme.ytmusic.MainActivity",
        "--es",
        "ytm_access_token",
        tok,
        "--es",
        "ytm_user_email",
        email,
        "--es",
        "ytm_refresh_token",
        ref,
    )
    time.sleep(2.5)

    stats = {
        "ok": 0,
        "fail": 0,
        "slow": 0,
        "eos_ok": 0,
        "eos_fail": 0,
        "events": [],
        "started": datetime.now().isoformat(),
        "play_to_end": PLAY_TO_END,
    }
    lib = fetch_library_ids(tok, 80)
    cold = cold_ids()
    log(f"pool lib={len(lib)} cold={len(cold)} play_to_end={PLAY_TO_END}")
    warm_ids(tok, lib[:20] + cold[:8])

    cycle = 0
    scenarios = ["eos", "eos", "skip_chain", "jump_ahead", "go_back", "eos"]
    while datetime.now() < STOP_AT:
        cycle += 1
        mute_keep_alarms()
        scenario = scenarios[(cycle - 1) % len(scenarios)]
        log(f"--- scenario={scenario} ---")
        # Mix: 2 library + 1 cold
        batch = []
        if lib:
            n = 8 if scenario in ("skip_chain", "jump_ahead") else 2
            batch.extend(random.sample(lib, min(n, len(lib))))
        if cold:
            batch.append(random.choice(cold))
        if not batch:
            batch = ["d26A9g71eik"]
        if scenario != "skip_chain":
            random.shuffle(batch)

        if scenario == "skip_chain":
            first = batch[0]
            log(f"=== C{cycle}.skip_chain start {first} ===")
            warm_ids(tok, batch[:20])
            prev = media()
            deeplink(first)
            wait_playing(prev_title=prev.get("title"), prev_pos=prev.get("pos"))
            for k in range(8):
                if datetime.now() >= STOP_AT:
                    break
                before = media()
                skip_next()
                res = wait_playing(
                    timeout_s=min(18, LOAD_TIMEOUT_S),
                    prev_title=before.get("title"),
                    prev_pos=before.get("pos"),
                )
                ok = bool(res.get("ok"))
                stats["ok" if ok else "fail"] += 1
                stats["events"].append({
                    "t": datetime.now().isoformat(),
                    "vid": "skip_chain",
                    "kind": "skip_chain",
                    "ok": ok,
                    "load_s": res.get("load_s"),
                    "state": res.get("state"),
                    "title": (res.get("title") or "")[:60],
                })
                log(
                    f"  skip#{k+1} ok={ok} load={res.get('load_s')}s "
                    f"{(res.get('title') or '')[:36]}"
                )
                if not ok:
                    break
            (OUT / "SUMMARY.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            time.sleep(1.2)
            continue

        if scenario == "jump_ahead":
            first = batch[0]
            log(f"=== C{cycle}.jump_ahead {first} then +10 ===")
            warm_ids(tok, batch[:20])
            prev = media()
            deeplink(first)
            wait_playing(prev_title=prev.get("title"), prev_pos=prev.get("pos"))
            for _ in range(10):
                skip_next()
                time.sleep(0.35)
            res = wait_playing(timeout_s=LOAD_TIMEOUT_S)
            ok = bool(res.get("ok"))
            stats["ok" if ok else "fail"] += 1
            stats["events"].append({
                "t": datetime.now().isoformat(),
                "vid": "jump_ahead",
                "kind": "jump_ahead",
                "ok": ok,
                "load_s": res.get("load_s"),
                "title": (res.get("title") or "")[:60],
            })
            log(f"  jump ok={ok} load={res.get('load_s')}s {(res.get('title') or '')[:40]}")
            if ok and PLAY_TO_END:
                eos = watch_until_end(str(res.get("title") or ""), int(res.get("dur") or 0))
                stats["eos_ok" if eos.get("eos") else "eos_fail"] += 1
            (OUT / "SUMMARY.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            time.sleep(1.2)
            continue

        if scenario == "go_back":
            first = batch[0]
            log(f"=== C{cycle}.go_back {first} ===")
            warm_ids(tok, batch[:20])
            prev = media()
            deeplink(first)
            res = wait_playing(prev_title=prev.get("title"), prev_pos=prev.get("pos"))
            ok = bool(res.get("ok"))
            stats["ok" if ok else "fail"] += 1
            log(f"  start ok={ok} {(res.get('title') or '')[:40]}")
            time.sleep(min(40, LISTEN_S * 2))
            skip_next()
            time.sleep(8)
            skip_next()
            time.sleep(8)
            skip_prev()
            time.sleep(2)
            back = wait_playing(timeout_s=18)
            bok = bool(back.get("ok"))
            stats["ok" if bok else "fail"] += 1
            stats["events"].append({
                "t": datetime.now().isoformat(),
                "vid": "go_back",
                "kind": "go_back",
                "ok": bok,
                "load_s": back.get("load_s"),
                "title": (back.get("title") or "")[:60],
            })
            log(f"  prev ok={bok} load={back.get('load_s')}s {(back.get('title') or '')[:40]}")
            skip_prev()
            time.sleep(6)
            (OUT / "SUMMARY.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            time.sleep(1.2)
            continue

        for i, vid in enumerate(batch):
            if datetime.now() >= STOP_AT:
                break
            kind = "cold" if vid in cold else "lib"
            log(f"=== C{cycle}.{i} {kind} {vid} ===")
            rest = [x for x in batch[i:] if isinstance(x, str) and len(x) == 11]
            warm_ids(tok, rest[:20])
            prev = media()
            deeplink(vid)
            res = wait_playing(
                prev_title=prev.get("title"),
                prev_pos=prev.get("pos"),
            )
            ok = bool(res.get("ok"))
            load = float(res.get("load_s") or 0)
            if ok and load > 20:
                stats["slow"] += 1
            if ok:
                stats["ok"] += 1
            else:
                stats["fail"] += 1
            ev = {
                "t": datetime.now().isoformat(),
                "vid": vid,
                "kind": kind,
                "ok": ok,
                "load_s": load,
                "state": res.get("state"),
                "title": (res.get("title") or "")[:60],
            }
            stats["events"].append(ev)
            log(
                f"  → ok={ok} load={load}s state={res.get('state')} "
                f"pos={res.get('pos')} title={(res.get('title') or '')[:40]}"
            )
            if ok and PLAY_TO_END:
                eos = watch_until_end(
                    str(res.get("title") or ""),
                    int(res.get("dur") or 0),
                )
                ev["eos"] = eos.get("eos")
                ev["eos_reason"] = eos.get("reason")
                ev["max_pos"] = eos.get("max_pos")
                ev["dur"] = eos.get("dur")
                ev["ratio"] = eos.get("ratio")
                if eos.get("eos"):
                    stats["eos_ok"] += 1
                else:
                    stats["eos_fail"] += 1
                    skip_next()
            else:
                t_listen = time.time()
                buf0 = time.time() if media()["state"] == "BUFFERING" else None
                while time.time() - t_listen < LISTEN_S and datetime.now() < STOP_AT:
                    time.sleep(min(5, LISTEN_S))
                    m = media()
                    if m["state"] == "BUFFERING":
                        if buf0 is None:
                            buf0 = time.time()
                        elif time.time() - buf0 >= 20:
                            log("  BUFFERING >20s — skip")
                            break
                    else:
                        buf0 = None
                    if m["state"] in ("BUFFERING", "ERROR") and m["pos"] < 500:
                        log(f"  mid-stall {m['state']} — skip")
                        break
                skip_next()
            (OUT / "SUMMARY.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            time.sleep(1.2)

        # Pause between cycles
        time.sleep(3)

    stats["ended"] = datetime.now().isoformat()
    stats["pass"] = stats["fail"] == 0 or (
        stats["ok"] / max(1, stats["ok"] + stats["fail"]) >= 0.85
    )
    (OUT / "SUMMARY.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(
        f"DONE ok={stats['ok']} fail={stats['fail']} slow={stats['slow']} "
        f"eos_ok={stats.get('eos_ok')} eos_fail={stats.get('eos_fail')} pass={stats['pass']}"
    )
    # Point symlink for PDF
    link = ROOT / "tmp" / "endurance-20260918-night" / "latest-summary.json"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.write_text(json.dumps({"out": str(OUT), **stats}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL {type(e).__name__}: {e}")
        raise
