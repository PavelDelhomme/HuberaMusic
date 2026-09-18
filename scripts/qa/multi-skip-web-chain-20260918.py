#!/usr/bin/env python3
"""Chaîne stream web-like : play séquentiel known+cold avec mid-range (simule skip)."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("API_BASE_URL", "https://ytmusic.delhomme.ovh").rstrip("/")
SET_PATH = Path(os.environ.get("TRACK_SET", "/tmp/plm-playback-set.json"))
OUT = ROOT / "tmp" / f"multi-skip-web-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUT.mkdir(parents=True, exist_ok=True)
SKIP_N = int(os.environ.get("SKIP_N", "11"))
KNOWN_N = int(os.environ.get("KNOWN_N", "6"))
COLD_N = int(os.environ.get("COLD_N", "6"))


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with (OUT / "live.log").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


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


def login() -> str:
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
    if not token:
        raise RuntimeError(f"login failed: {d}")
    log(f"login ok {email}")
    return token


def build_queue() -> list[dict]:
    data = json.loads(SET_PATH.read_text(encoding="utf-8")) if SET_PATH.exists() else {}
    known = list(data.get("known") or [])
    cold = list(data.get("cold") or [])
    q: list[dict] = []
    ki = ci = 0
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
    return q[: SKIP_N + 1]


def fetch_range(token: str, video_id: str, start: int, end: int, client: str = "web") -> dict:
    t0 = time.time()
    req = urllib.request.Request(
        f"{API}/api/stream/{video_id}",
        headers={
            "Authorization": f"Bearer {token}",
            "Range": f"bytes={start}-{end}",
            "X-YTM-Client": client,
            "User-Agent": "Mozilla/5.0 PLM-multi-skip-web",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            body = r.read(end - start + 1)
            brand = body[:4].decode("latin1", errors="replace") if body else "?"
            return {
                "status": r.status,
                "ms": int((time.time() - t0) * 1000),
                "bytes": len(body),
                "brand": brand,
                "via": r.headers.get("X-YTM-Stream-Via") or r.headers.get("X-PLM-Stream-Cache") or "",
                "ok": r.status in (200, 206) and len(body) > 500,
            }
    except Exception as e:  # noqa: BLE001
        return {
            "status": 0,
            "ms": int((time.time() - t0) * 1000),
            "bytes": 0,
            "brand": "?",
            "via": "",
            "ok": False,
            "err": str(e)[:160],
        }


def main() -> int:
    log(f"OUT={OUT} API={API}")
    token = login()
    queue = build_queue()
    log(f"queue n={len(queue)} kinds={[t['kind'] for t in queue]}")
    out: list[dict] = []
    for i, t in enumerate(queue):
        label = "START" if i == 0 else f"SKIP#{i}"
        log(f"=== {label} → {t['kind']} {t['id']} ===")
        head = fetch_range(token, t["id"], 0, 2047)
        # mid-range like a player seeking/buffering during listen
        mid = fetch_range(token, t["id"], 256_000, 272_000)
        row = {
            **t,
            "status": head.get("status"),
            "ms": head.get("ms"),
            "brand": head.get("brand"),
            "via": head.get("via"),
            "mid": mid.get("status"),
            "midB": mid.get("bytes"),
            "mid_ms": mid.get("ms"),
            "ok": bool(head.get("ok") and mid.get("ok")),
            "err": head.get("err") or mid.get("err"),
        }
        out.append(row)
        log(
            f"  → ok={row['ok']} head={row['status']}/{row['ms']}ms mid={row['mid']}/{row['mid_ms']}ms "
            f"via={row['via']} brand={row['brand']!r} {row.get('err') or ''}"
        )
        time.sleep(0.35)  # petite écoute simulée entre skips

    finale = fetch_range(token, queue[0]["id"], 0, 2047)
    log(f"=== FINALE {queue[0]['id']} → ok={finale.get('ok')} {finale.get('ms')}ms ===")
    ok_n = sum(1 for r in out if r.get("ok"))
    fail = [r for r in out if not r.get("ok")]
    slow = [r for r in out if r.get("ok") and (r.get("ms") or 0) > 8000]
    summary = {
        "queue": queue,
        "out": out,
        "finale": finale,
        "ok": ok_n,
        "total": len(out),
        "fail": fail,
        "slow_gt_8s": slow,
        "pass": ok_n == len(out) and bool(finale.get("ok")),
    }
    (OUT / "SUMMARY.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"SUMMARY ok={ok_n}/{len(out)} pass={summary['pass']} slow={len(slow)} fail={len(fail)}")
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
