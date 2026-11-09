#!/usr/bin/env python3
"""Preuve silencieuse : premiers octets de 2000 titres, puis un échantillon hors bibliothèque.

Pas de yt-dlp local. Pas de lecture sonore. Un titre qui ne répond pas en 60 s est noté
et on passe. Jamais le morceau entier (16 Ko max).
"""
from __future__ import annotations

import json
import os
import random
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path('/tmp/hubera-music-proof-2026-10-19')
API = os.environ.get('MUSIC_API', 'https://music.hubera.cloud').rstrip('/')
N = 2000
FOREIGN_N = 12
TIMEOUT = 60
MAX_BYTES = 16 * 1024
CTX = ssl.create_default_context()


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = ROOT / '.env'
    if not path.exists():
        return env
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def request(
    url: str,
    token: str | None = None,
    data: bytes | None = None,
    timeout: int = 60,
    range_hdr: str | None = None,
    max_bytes: int | None = None,
):
    headers = {'Accept': 'application/json', 'User-Agent': 'hubera-music-proof-silent'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if data is not None:
        headers['Content-Type'] = 'application/json'
    if range_hdr:
        headers['Range'] = range_hdr
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as res:
            body = res.read() if max_bytes is None else res.read(max_bytes)
            return res.status, dict(res.headers), body
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b''
        body = raw if max_bytes is None else raw[:max_bytes]
        return e.code, dict(e.headers or {}), body


def token_from_file() -> str:
    path = os.environ.get('MUSIC_TOKEN_FILE', '').strip()
    if not path:
        return ''
    raw = Path(path).read_text(errors='replace').strip()
    return raw if raw.count('.') == 2 else ''


def login(env: dict[str, str]) -> tuple[str, str]:
    pairs = []
    for email_k, pass_k in (
        ('SEED_EMAIL', 'SEED_PASSWORD'),
        ('SEED_EMAIL_SECONDARY', 'SEED_PASSWORD_SECONDARY'),
    ):
        email = env.get(email_k, '').strip()
        password = env.get(pass_k, '').strip()
        if email and password:
            pairs.append((email, password))
    pavel_pass = env.get('MDP_PAVEL_USER_ACCOUNT', '').strip()
    if pavel_pass:
        for raw in (env.get('AUTH_ALLOWED_EMAILS') or '').replace(';', ',').split(','):
            email = raw.strip()
            if email and 'pavel' in email.lower():
                pairs.append((email, pavel_pass))
    if not pairs:
        raise SystemExit('auth manquante')
    best: tuple[str, str, int] | None = None
    for email, password in pairs:
        status, _headers, body = request(
            f'{API}/api/auth/login',
            data=json.dumps({'email': email, 'password': password, 'deviceLabel': 'proof-silent'}).encode(),
            timeout=30,
        )
        if status != 200:
            continue
        payload = json.loads(body.decode() or '{}')
        token = str(payload.get('token') or '')
        if not token:
            continue
        lib_status, _, lib_body = request(f'{API}/api/library?light=1&limit=12', token=token, timeout=40)
        total = 0
        if lib_status == 200:
            lib = json.loads(lib_body.decode() or '{}')
            total = int(lib.get('totalSongs') or len(lib.get('songs') or []))
        if best is None or total > best[2]:
            best = (token, email.split('@')[0][:3], total)
    if not best:
        raise SystemExit('login KO')
    return best[0], str(best[2])


def song_ids(token: str) -> list[str]:
    status, _, body = request(f'{API}/api/library', token=token, timeout=300)
    if status != 200:
        raise SystemExit(f'library HTTP {status}')
    lib = json.loads(body.decode() or '{}')
    ids: list[str] = []
    seen: set[str] = set()
    for key in ('songs', 'liked', 'history'):
        for t in lib.get(key) or []:
            tid = str((t or {}).get('id') or '')
            if len(tid) == 11 and tid not in seen:
                seen.add(tid)
                ids.append(tid)
    return ids


def classify(status: int, headers: dict, body: bytes, elapsed: float, err: str) -> str:
    replaced = headers.get('X-PLM-Replaced-From') or headers.get('x-plm-replaced-from')
    loc = headers.get('Location') or headers.get('location') or ''
    if replaced or (status in (301, 302, 303, 307, 308) and '/api/stream/' in loc):
        return 'meme_morceau'
    text = body[:400].decode('utf-8', 'replace').lower()
    if status in (404, 410) or 'unavailable' in text or 'indisponible' in text or 'video unavailable' in text:
        return 'indisponible'
    ctype = (headers.get('Content-Type') or headers.get('content-type') or '').lower()
    audioish = status in (200, 206) and len(body) >= 512 and (
        'audio' in ctype or 'video' in ctype or 'octet-stream' in ctype or 'mp4' in ctype or not ctype
    )
    if audioish:
        return 'joue'
    if err or status == 0 or status >= 500 or len(body) < 512:
        return 'pas_de_flux'
    return 'pas_de_flux'


def probe(token: str, tid: str) -> dict:
    t0 = time.monotonic()
    err = ''
    status = 0
    headers: dict = {}
    body = b''
    try:
        status, headers, body = request(
            f'{API}/api/stream/{tid}',
            token=token,
            timeout=TIMEOUT,
            range_hdr=f'bytes=0-{MAX_BYTES - 1}',
            max_bytes=MAX_BYTES,
        )
    except Exception as e:
        err = type(e).__name__
    elapsed = time.monotonic() - t0
    cat = classify(status, headers, body, elapsed, err)
    return {
        'id': tid,
        'cat': cat,
        'status': status,
        'ms': int(elapsed * 1000),
        'bytes': len(body),
        'under2s': cat == 'joue' and elapsed < 2.0,
        'err': err,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    log_path = OUT / 'rows.jsonl'
    env = load_env()
    file_token = token_from_file()
    if file_token:
        token, light_total = file_token, 'file'
    else:
        token, light_total = login(env)
    ids = song_ids(token)
    real = len(ids)
    print(f'library_ids={real} light_hint={light_total}', flush=True)
    rng = random.Random(20261019)
    sample = ids[:]
    rng.shuffle(sample)
    sample = sample[: min(N, len(sample))]
    meta = {
        'api': API,
        'library': real,
        'lightTotalHint': light_total,
        'sample': len(sample),
        'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    }
    (OUT / 'meta.json').write_text(json.dumps(meta))
    log = log_path
    counts = {'joue': 0, 'meme_morceau': 0, 'indisponible': 0, 'pas_de_flux': 0, 'under2s': 0}
    done: set[str] = set()
    if log.exists():
        for line in log.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get('pool') == 'library' and row.get('id'):
                done.add(row['id'])
                counts[row['cat']] = counts.get(row['cat'], 0) + 1
                if row.get('under2s'):
                    counts['under2s'] += 1
    pending = [tid for tid in sample if tid not in done]
    lock = threading.Lock()
    finished = len(done)
    print(f'resume done={finished} pending={len(pending)} workers=1', flush=True)
    with log.open('a') as fh:
        def one(tid: str) -> None:
            nonlocal finished
            row = probe(token, tid)
            row['pool'] = 'library'
            with lock:
                finished += 1
                row['n'] = finished
                fh.write(json.dumps(row) + '\n')
                fh.flush()
                counts[row['cat']] = counts.get(row['cat'], 0) + 1
                if row['under2s']:
                    counts['under2s'] += 1
                if finished % 10 == 0 or finished == len(sample):
                    print(f'lib {finished}/{len(sample)} {counts}', flush=True)

        with ThreadPoolExecutor(max_workers=1) as pool:
            list(pool.map(one, pending))
        foreign: list[str] = []
        try:
            st, _, body = request(
                f'{API}/api/search?q=miles%20davis%20so%20what&filter=songs&noHistory=1',
                token=token,
                timeout=40,
            )
            if st == 200:
                payload = json.loads(body.decode() or '{}')
                known = set(ids)
                for bucket in ('tracks', 'songs', 'results'):
                    for t in payload.get(bucket) or []:
                        tid = str((t or {}).get('id') or '')
                        if len(tid) == 11 and tid not in known and tid not in foreign:
                            foreign.append(tid)
                if not foreign:
                    for t in payload.get('shelves') or []:
                        for item in (t or {}).get('items') or (t or {}).get('contents') or []:
                            tid = str((item or {}).get('id') or '')
                            if len(tid) == 11 and tid not in known and tid not in foreign:
                                foreign.append(tid)
        except Exception as e:
            print('search skip', type(e).__name__, flush=True)
        foreign = foreign[:FOREIGN_N]
        fcounts = {'joue': 0, 'meme_morceau': 0, 'indisponible': 0, 'pas_de_flux': 0, 'under2s': 0}
        for i, tid in enumerate(foreign, 1):
            row = probe(token, tid)
            row['n'] = i
            row['pool'] = 'foreign'
            fh.write(json.dumps(row) + '\n')
            fh.flush()
            fcounts[row['cat']] = fcounts.get(row['cat'], 0) + 1
            if row['under2s']:
                fcounts['under2s'] += 1
        summary = {
            **meta,
            'finished': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'librarySample': counts,
            'foreign': {'n': len(foreign), **fcounts},
        }
        (OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
