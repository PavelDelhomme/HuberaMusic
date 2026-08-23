#!/usr/bin/env python3
"""Matrix stream audio + /visual + stream vidéo pour un corpus de titres froids.

Usage:
  set -a && source .env && set +a
  python3 -u scripts/qa/visual-stream-matrix.py

Écrit docs/reports/visual-matrix-<ts>/
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = os.environ.get("API_BASE", "https://ytmusic.delhomme.ovh").rstrip("/")
EMAIL = os.environ.get("SEED_EMAIL", "")
PASSWORD = os.environ.get("SEED_PASSWORD", "")
OUT = ROOT / "docs" / "reports" / f"visual-matrix-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

QUERIES = [
    ("lisa gurenge", "video"),
    ("stromae papaoutai", "song"),
    ("daft punk get lucky", "song"),
    ("bjork hyperballad", "song"),
    ("radiohead creep", "video"),
    ("booba validée", "song"),
    ("aya nakamura djadja", "song"),
    ("bts dynamite", "video"),
    ("yoasobi idol", "song"),
    ("bad bunny un verano sin ti", "song"),
    ("nirvana smells like teen spirit", "video"),
    ("mozart requiem", "song"),
]


def http_json(method: str, path: str, token: str | None = None, body: dict | None = None, timeout=45):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_code(path: str, token: str, range_header="bytes=0-1023", timeout=30) -> int:
    req = urllib.request.Request(
        f"{API}{path}",
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Range": range_header,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    if not EMAIL or not PASSWORD:
        raise SystemExit("SEED_EMAIL / SEED_PASSWORD requis")
    OUT.mkdir(parents=True, exist_ok=True)
    tok = http_json("POST", "/api/auth/login", body={"email": EMAIL, "password": PASSWORD})["token"]
    rows = []
    seen = set()
    for q, filt in QUERIES:
        try:
            buckets = http_json(
                "GET",
                f"/api/search?q={urllib.parse.quote(q)}&filter={filt}",
                token=tok,
            )
        except Exception as e:
            rows.append({"query": q, "error": str(e)})
            continue
        pool = (buckets.get("songs") or []) + (buckets.get("videos") or [])
        for t in pool[:2]:
            tid = t.get("id")
            if not tid or tid in seen:
                continue
            seen.add(tid)
            title = t.get("title") or ""
            artists = ", ".join(
                a.get("name") for a in (t.get("artists") or []) if a.get("name")
            )
            audio = http_code(f"/api/stream/{tid}", tok)
            vis = {}
            try:
                qs = urllib.parse.urlencode(
                    {
                        "title": title,
                        "artist": artists,
                        **(
                            {"durationSeconds": t["durationSeconds"]}
                            if t.get("durationSeconds")
                            else {}
                        ),
                    }
                )
                vis = http_json("GET", f"/api/track/{tid}/visual?{qs}", token=tok)
            except Exception as e:
                vis = {"error": str(e)}
            vid = vis.get("visualId")
            vcode = None
            if vid:
                vcode = http_code(f"/api/stream/{vid}?type=video", tok)
            row = {
                "query": q,
                "audioId": tid,
                "title": title,
                "artist": artists,
                "audioHttp": audio,
                "visual": vis,
                "videoHttp": vcode,
            }
            rows.append(row)
            print(
                f"{tid} audio={audio} visual={vis.get('source')}->{vid} video={vcode} | {title[:40]}"
            )
            time.sleep(0.35)

    summary = {
        "api": API,
        "at": datetime.now(timezone.utc).isoformat(),
        "n": len(rows),
        "audio_ok": sum(1 for r in rows if r.get("audioHttp") in (200, 206)),
        "visual_same": sum(1 for r in rows if (r.get("visual") or {}).get("source") == "same"),
        "visual_search": sum(1 for r in rows if (r.get("visual") or {}).get("source") == "search"),
        "visual_none": sum(1 for r in rows if (r.get("visual") or {}).get("source") == "none"),
        "video_ok": sum(1 for r in rows if r.get("videoHttp") in (200, 206)),
    }
    (OUT / "rows.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    md = [
        "# Visual stream matrix",
        "",
        f"- API: `{API}`",
        f"- n={summary['n']} audio_ok={summary['audio_ok']} video_ok={summary['video_ok']}",
        f"- visual same/search/none = {summary['visual_same']}/{summary['visual_search']}/{summary['visual_none']}",
        "",
    ]
    (OUT / "README.md").write_text("\n".join(md), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"OUT={OUT}")


if __name__ == "__main__":
    main()
