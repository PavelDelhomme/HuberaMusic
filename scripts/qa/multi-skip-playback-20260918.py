#!/usr/bin/env python3
"""Parcours lecture réel : play → écoute → skip ×N (biblio + titres froids).

Ne touche JAMAIS au Wi‑Fi.
Usage:
  DEVICE=R5CT7263YJL python3 -u scripts/qa/multi-skip-playback-20260918.py
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

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
PKG = os.environ.get("PKG", "ovh.delhomme.ytmusic")
SERIAL = os.environ.get("DEVICE", "R5CT7263YJL")
SET_PATH = Path(os.environ.get("TRACK_SET", "/tmp/plm-playback-set.json"))
OUT = ROOT / "tmp" / f"multi-skip-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
LISTEN_S = float(os.environ.get("LISTEN_S", "8"))
SKIP_N = int(os.environ.get("SKIP_N", "8"))
COLD_N = int(os.environ.get("COLD_N", "4"))
KNOWN_N = int(os.environ.get("KNOWN_N", "6"))
LOAD_TIMEOUT_S = float(os.environ.get("LOAD_TIMEOUT_S", "45"))


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def sh(*args: str, timeout: int = 40) -> str:
    try:
        r = subprocess.run(
            ["adb", "-s", SERIAL, *args],
            capture_output=True,
            timeout=timeout,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    return (r.stdout or "") + (r.stderr or "")


def wifi_on() -> str:
    return sh("shell", "settings", "get", "global", "wifi_on").strip()


def load_env() -> tuple[str, str]:
    email = os.environ.get("SEED_EMAIL") or "dev@delhomme.ovh"
    password = os.environ.get("SEED_PASSWORD") or os.environ.get("VITE_DEV_PASSWORD") or ""
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
    token = d.get("token") or d.get("accessToken") or ""
    refresh = d.get("refreshToken") or ""
    if not token:
        raise RuntimeError(f"login failed: {d}")
    return token, refresh, email


def media() -> dict:
    t = sh("shell", "dumpsys", "media_session")
    best = {"title": "?", "state": "?", "pos": -1, "score": -1}
    for mpkg in re.finditer(rf"(?m)^\s*package={re.escape(PKG)}\s*$", t):
        chunk = t[mpkg.start() : mpkg.start() + 3500]
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
        if title != "?" and pos > 0 and score == 0:
            score = 1
        cand = {"title": title, "state": state, "pos": pos, "score": score}
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
        f"{PKG}/.MainActivity",
    )


def skip_next() -> None:
    sh("shell", "cmd", "media_session", "dispatch", "skip_to_next")
    time.sleep(0.4)
    sh("shell", "input", "keyevent", "87")  # KEYCODE_MEDIA_NEXT


def _title_key(title: str) -> str:
    t = (title or "?").split(",")[0].strip().lower()
    if t in ("titre", "title", "?", "null", "none", ""):
        return ""
    return t


def wait_playing(
    label: str,
    timeout_s: float = LOAD_TIMEOUT_S,
    *,
    prev_title: str | None = None,
    prev_pos: int | None = None,
    require_fresh: bool = False,
) -> dict:
    """Attend PLAYING avec pos≥2.5s. Si require_fresh, exige nouveau titre ou rewind clair."""
    t0 = time.time()
    last = media()
    saw_rewind = False
    while time.time() - t0 < timeout_s:
        last = media()
        fresh_ok = True
        if require_fresh:
            cur_k = _title_key(last["title"])
            prev_k = _title_key(prev_title or "")
            if prev_pos is not None and last["pos"] >= 0 and last["pos"] + 2500 < prev_pos:
                saw_rewind = True
            if prev_k and cur_k:
                # Titres connus : il faut vraiment changer
                if cur_k == prev_k and last["pos"] > 5_000:
                    fresh_ok = False
            else:
                # Métadonnées placeholder : exiger rewind (nouveau buffer) + pos encore basse
                if not saw_rewind and last["pos"] > 6_000:
                    fresh_ok = False
                if last["pos"] > 18_000:
                    fresh_ok = False
        if last["state"] == "PLAYING" and last["pos"] >= 2500 and fresh_ok:
            return {
                **last,
                "ok": True,
                "load_s": round(time.time() - t0, 2),
                "label": label,
                "fresh": True,
            }
        if last["state"] == "ERROR":
            break
        time.sleep(1.0)
    return {
        **last,
        "ok": False,
        "load_s": round(time.time() - t0, 2),
        "label": label,
        "fresh": False,
    }


def probe_stream(token: str, video_id: str) -> dict:
    t0 = time.time()
    req = urllib.request.Request(
        f"{API}/api/stream/{video_id}",
        headers={
            "Authorization": f"Bearer {token}",
            "Range": "bytes=0-2047",
            "X-YTM-Client": "android",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            body = r.read(2048)
            return {
                "id": video_id,
                "status": r.status,
                "bytes": len(body),
                "ms": int((time.time() - t0) * 1000),
                "via": r.headers.get("X-YTM-Stream-Via") or r.headers.get("X-PLM-Stream-Cache") or "",
                "ok": r.status in (200, 206) and len(body) > 500,
            }
    except Exception as e:  # noqa: BLE001
        return {
            "id": video_id,
            "status": 0,
            "bytes": 0,
            "ms": int((time.time() - t0) * 1000),
            "via": "",
            "ok": False,
            "err": str(e)[:160],
        }


def build_queue() -> list[dict]:
    data = json.loads(SET_PATH.read_text(encoding="utf-8")) if SET_PATH.exists() else {}
    known = list(data.get("known") or [])
    cold = list(data.get("cold") or [])
    # Interleave: known, cold, known, cold…
    q: list[dict] = []
    ki, ci = 0, 0
    while len(q) < SKIP_N + 1 and (ki < KNOWN_N or ci < COLD_N):
        if ki < min(KNOWN_N, len(known)):
            q.append({"id": known[ki], "kind": "known"})
            ki += 1
        if len(q) >= SKIP_N + 1:
            break
        if ci < min(COLD_N, len(cold)):
            item = cold[ci]
            if isinstance(item, dict):
                q.append({"id": item["id"], "kind": "cold", "title": item.get("title")})
            else:
                q.append({"id": item, "kind": "cold"})
            ci += 1
    # Fallback classics if set thin
    fallbacks = [
        ("dQw4w9WgXcQ", "known"),
        ("IDgKCpZw044", "known"),
        ("RmYCOm4ehKs", "known"),
        ("4yhMlYF0I44", "cold"),
        ("Jh8kowHamE4", "cold"),
    ]
    for vid, kind in fallbacks:
        if len(q) >= SKIP_N + 1:
            break
        if not any(x["id"] == vid for x in q):
            q.append({"id": vid, "kind": kind})
    return q[: SKIP_N + 1]


def main() -> int:
    log(f"OUT={OUT}")
    log(f"DEVICE={SERIAL} PKG={PKG} API={API}")
    wifi_before = wifi_on()
    log(f"wifi_on before={wifi_before}")
    assert wifi_before == "1", "Wi‑Fi doit rester ON — abort"

    token, refresh, email = api_login()
    log(f"login ok {email}")
    queue = build_queue()
    log(f"queue n={len(queue)} kinds={[t['kind'] for t in queue]}")

    probes = [probe_stream(token, t["id"]) for t in queue]
    (OUT / "stream-probes.json").write_text(json.dumps(probes, indent=2), encoding="utf-8")
    for p in probes:
        log(
            f"  probe {p['id']} ok={p['ok']} status={p.get('status')} ms={p['ms']} via={p.get('via')} {p.get('err','')}"
        )

    sh("shell", "cmd", "media_session", "volume", "--stream", "3", "--set", "0")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(0.8)
    # Inject session
    args = [
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/.MainActivity",
        "--es",
        "ytm_access_token",
        token,
        "--es",
        "ytm_user_email",
        email,
    ]
    if refresh:
        args += ["--es", "ytm_refresh_token", refresh]
    sh(*args)
    time.sleep(3)

    results: list[dict] = []
    # Start with first deeplink
    first = queue[0]
    log(f"=== START {first['kind']} {first['id']} ===")
    deeplink(first["id"])
    r0 = wait_playing(f"start:{first['kind']}:{first['id']}")
    results.append(r0)
    log(f"  → ok={r0['ok']} load={r0['load_s']}s state={r0['state']} pos={r0['pos']} title={r0['title'][:50]}")

    for i, track in enumerate(queue[1:], start=1):
        # Listen a bit on current before skip (real usage)
        time.sleep(LISTEN_S)
        mid = media()
        log(f"  listen mid state={mid['state']} pos={mid['pos']} title={mid['title'][:40]}")
        log(f"=== SKIP#{i} → {track['kind']} {track['id']} ===")
        # Prefer deeplink to force known target (queue may differ); also press next
        deeplink(track["id"])
        time.sleep(1.0)
        # If still on previous, try media next once
        cur = media()
        if cur["pos"] > 20_000 and track["kind"] == "cold":
            skip_next()
        r = wait_playing(
            f"skip{i}:{track['kind']}:{track['id']}",
            prev_title=mid.get("title"),
            prev_pos=mid.get("pos"),
            require_fresh=True,
        )
        results.append(r)
        log(f"  → ok={r['ok']} load={r['load_s']}s state={r['state']} pos={r['pos']} title={r['title'][:50]}")

    # Final: after several skips, play one more known and verify still OK
    time.sleep(LISTEN_S)
    finale = queue[0]
    log(f"=== FINALE back to {finale['id']} ===")
    deeplink(finale["id"])
    rf = wait_playing(f"finale:{finale['id']}")
    results.append(rf)
    log(f"  → ok={rf['ok']} load={rf['load_s']}s state={rf['state']} pos={rf['pos']}")

    wifi_after = wifi_on()
    log(f"wifi_on after={wifi_after}")

    ok_n = sum(1 for r in results if r.get("ok"))
    slow = [r for r in results if r.get("ok") and r.get("load_s", 0) > 20]
    fail = [r for r in results if not r.get("ok")]
    summary = {
        "device": SERIAL,
        "pkg": PKG,
        "api": API,
        "wifi_before": wifi_before,
        "wifi_after": wifi_after,
        "queue": queue,
        "probes": probes,
        "results": results,
        "ok": ok_n,
        "total": len(results),
        "slow_gt_20s": slow,
        "fail": fail,
        "pass": ok_n == len(results) and wifi_after == "1" and not fail,
    }
    (OUT / "SUMMARY.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"SUMMARY ok={ok_n}/{len(results)} pass={summary['pass']} slow={len(slow)} fail={len(fail)}")
    # Logcat crumbs
    crumbs = sh("logcat", "-d", "-t", "300")
    interesting = "\n".join(
        ln
        for ln in crumbs.splitlines()
        if re.search(r"Serveur audio|streamDown|onPlayerError|502|410|rebind|Format error|after-call", ln, re.I)
    )
    (OUT / "logcat-interesting.txt").write_text(interesting[:50_000], encoding="utf-8")
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
