#!/usr/bin/env python3
"""Rotating guardian : harvest / score / persist les proxies HTTP MHC (pas SOCKS). Stdlib only."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import random
import re
import socket
import ssl
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

UA = "MHC-steward/1.0"
CONNECT_HOST = "www.google.com"
CONNECT_PORT = 443
KEEP = 200
HARVEST_CAP = 800
PROBE_CAP = 280
PROBE_WORKERS = 32
LOOP_S = 300
PROBE_TIMEOUT = 2.5
HARVEST_TIMEOUT = 8.0

SOURCES = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all",
    "https://www.proxy-list.download/api/v1/get?type=http",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt",
    "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt",
    "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
    "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",
]

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "proxy-steward"
OUT_FILE = OUT_DIR / "live.json"

_HOSTPORT_RE = re.compile(r"^[\w.\[\]:-]+:\d+$")


def is_blocked_host(host: str) -> bool:
    h = (host or "").strip().lower().strip("[]")
    if not h:
        return True
    if h in {"localhost", "::1", "0.0.0.0", "::", "metadata.google.internal", "metadata"}:
        return True
    if h.endswith(".internal") or h.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return True
        if str(ip).startswith("169.254."):
            return True
    except ValueError:
        pass
    return False


def normalize_http_proxy(raw: str) -> str | None:
    s = raw.strip()
    if not s or s.startswith("#"):
        return None
    low = s.lower()
    if low.startswith("socks"):
        return None
    if "@" in s.split("://", 1)[-1].rsplit("/", 1)[0]:
        return None
    if _HOSTPORT_RE.match(s):
        s = f"http://{s}"
    if not re.match(r"^https?://", s, re.I):
        return None
    try:
        u = urlparse(s)
        if u.username or u.password:
            return None
        host = u.hostname
        if not host or is_blocked_host(host):
            return None
        port = u.port or (443 if u.scheme == "https" else 80)
        return f"http://{host}:{port}"
    except Exception:
        return None


def _read_headers(sock: socket.socket, limit: int = 65536) -> bytes:
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            break
    return bytes(buf)


class ProxyStewardAgent:
    """Gardien rotatif : collect → probe CONNECT google:443 → score pondéré → persist atomique."""

    def __init__(self) -> None:
        self.raw: list[str] = []
        self.live: list[dict] = []

    def _fetch_source(self, src: str) -> list[str]:
        found: list[str] = []
        try:
            req = Request(src, headers={"User-Agent": UA, "Accept": "text/plain,*/*"})
            with urlopen(req, timeout=HARVEST_TIMEOUT) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            for line in text.splitlines():
                n = normalize_http_proxy(line)
                if n:
                    found.append(n)
        except Exception as exc:
            print(f"[steward] list KO {src[:48]} {str(exc)[:80]}", file=sys.stderr)
        return found

    def collect(self) -> list[str]:
        found: list[str] = []
        with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
            futs = [pool.submit(self._fetch_source, src) for src in SOURCES]
            for fut in as_completed(futs):
                found.extend(fut.result())
        uniq = list(dict.fromkeys(found))
        self.raw = uniq[:HARVEST_CAP]
        sample = urlparse(self.raw[0]).hostname if self.raw else "-"
        print(f"[steward] harvested n={len(self.raw)} sample_host={sample}")
        return self.raw

    def _probe_one(self, proxy_url: str) -> dict | None:
        parsed = urlparse(proxy_url)
        host = parsed.hostname
        port = parsed.port or 80
        if not host or is_blocked_host(host):
            return None
        t0 = time.monotonic()
        sock: socket.socket | None = None
        ssock: ssl.SSLSocket | None = None
        try:
            sock = socket.create_connection((host, port), timeout=PROBE_TIMEOUT)
            sock.settimeout(PROBE_TIMEOUT)
            req = (
                f"CONNECT {CONNECT_HOST}:{CONNECT_PORT} HTTP/1.1\r\n"
                f"Host: {CONNECT_HOST}:{CONNECT_PORT}\r\n"
                f"User-Agent: {UA}\r\n"
                "Proxy-Connection: keep-alive\r\n"
                "\r\n"
            )
            sock.sendall(req.encode("ascii"))
            header_blob = _read_headers(sock)
            first = header_blob.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
            parts = first.split(" ", 2)
            if len(parts) < 2 or not parts[1].isdigit() or int(parts[1]) != 200:
                return None
            ctx = ssl.create_default_context()
            ssock = ctx.wrap_socket(sock, server_hostname=CONNECT_HOST)
            sock = None
            get = (
                "GET /generate_204 HTTP/1.1\r\n"
                f"Host: {CONNECT_HOST}\r\n"
                f"User-Agent: {UA}\r\n"
                "Accept: */*\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
            ssock.sendall(get.encode("ascii"))
            resp = _read_headers(ssock)
            status_line = resp.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
            sp = status_line.split(" ", 2)
            if len(sp) < 2 or not sp[1].isdigit() or int(sp[1]) not in (204, 200):
                return None
            latency = time.monotonic() - t0
            return {"url": proxy_url, "latency": latency, "ok": True}
        except Exception:
            return None
        finally:
            for s in (ssock, sock):
                if s is not None:
                    try:
                        s.close()
                    except OSError:
                        pass

    def probe(self, urls: list[str] | None = None) -> list[dict]:
        urls = list(urls if urls is not None else self.raw)
        if len(urls) > PROBE_CAP:
            urls = random.sample(urls, PROBE_CAP)
        else:
            random.shuffle(urls)
        live: list[dict] = []
        with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
            futs = [pool.submit(self._probe_one, u) for u in urls]
            for fut in as_completed(futs):
                row = fut.result()
                if row:
                    live.append(row)
        self.live = live
        sample = urlparse(live[0]["url"]).hostname if live else "-"
        print(f"[steward] probed live={len(live)} sample_host={sample}")
        return live

    def score(self, rows: list[dict] | None = None) -> list[dict]:
        # Heuristique pondérée (pas un modèle ML) : succès + latence inverse.
        rows = rows if rows is not None else self.live
        ranked: list[dict] = []
        for row in rows:
            lat = max(0.05, float(row.get("latency") or 2.5))
            s = 0.55 + 0.45 * (1.0 / (1.0 + lat))
            ranked.append({"url": row["url"], "score": round(s, 4), "latency": round(lat, 3)})
        ranked.sort(key=lambda x: x["score"], reverse=True)
        self.live = ranked[:KEEP]
        return self.live

    def persist(self, rows: list[dict] | None = None) -> Path:
        rows = rows if rows is not None else self.live
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"updated": int(time.time() * 1000), "proxies": rows}
        fd, tmp = tempfile.mkstemp(prefix="live.", suffix=".json", dir=str(OUT_DIR))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, separators=(",", ":"))
            os.replace(tmp, OUT_FILE)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        print(f"[steward] wrote n={len(rows)} {OUT_FILE}")
        return OUT_FILE

    def run_once(self) -> None:
        self.collect()
        self.probe()
        self.score()
        self.persist()


def main() -> int:
    p = argparse.ArgumentParser(description="MHC proxy steward")
    p.add_argument("--once", action="store_true")
    p.add_argument("--loop", action="store_true")
    args = p.parse_args()
    agent = ProxyStewardAgent()
    if args.loop:
        while True:
            try:
                agent.run_once()
            except Exception as exc:
                print(f"[steward] loop err {str(exc)[:120]}", file=sys.stderr)
            time.sleep(LOOP_S)
    else:
        agent.run_once()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
