#!/usr/bin/env bash
# Smoke test exhaustif APK Kotlin — DEV (local) puis PROD.
# Usage: DEVICE=R5CT7263YJL bash scripts/android/mobile-full-smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a || true

PKG=ovh.delhomme.ytmusic
ADB="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-$($ADB devices | awk '/\tdevice$/{print $1; exit}')}"
REPORT_DIR=/tmp/ytmusic-mobile-smoke
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/report-$(date +%Y%m%d-%H%M%S).txt"
: >"$REPORT"

log() { echo "$*" | tee -a "$REPORT"; }
fail=0
note_fail() { fail=1; log "FAIL $*"; }
note_ok() { log "OK   $*"; }
note_warn() { log "WARN $*"; }

if [[ -z "${DEVICE:-}" ]]; then
  log "FAIL aucun device ADB"
  exit 1
fi
log "==> device=$DEVICE report=$REPORT"

dump_ui() {
  local out="$1"
  $ADB -s "$DEVICE" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  $ADB -s "$DEVICE" pull /sdcard/ui.xml "$out" >/dev/null 2>&1 || true
}

ui_texts() {
  python3 - "$1" <<'PY'
import re,sys
p=sys.argv[1]
try: xml=open(p,encoding='utf-8',errors='ignore').read()
except: print(''); sys.exit(0)
texts=[t for t in re.findall(r'text="([^"]*)"', xml) if t.strip()]
print(' | '.join(texts[:40]))
PY
}

tap_text() {
  local needle="$1"
  DEVICE="$DEVICE" python3 - "$REPORT_DIR/ui.xml" "$needle" <<'PY'
import re, sys, subprocess, os
xml = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
needle = sys.argv[2].lower()
cands = []
for m in re.finditer(
    r'(?:text|content-desc)="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    r'|bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*(?:text|content-desc)="([^"]*)"',
    xml,
):
    g = m.groups()
    if g[0] is not None:
        label, x1, y1, x2, y2 = g[0], int(g[1]), int(g[2]), int(g[3]), int(g[4])
    else:
        x1, y1, x2, y2, label = int(g[5]), int(g[6]), int(g[7]), int(g[8]), g[9] or ''
    if needle in label.lower():
        cands.append((len(label), (x1 + x2) // 2, (y1 + y2) // 2, label))
if not cands:
    sys.exit(2)
cands.sort(key=lambda t: t[0])
_, x, y, lab = cands[0]
print(f'TAP {lab!r} @ {x},{y}', flush=True)
subprocess.check_call(['adb', '-s', os.environ['DEVICE'], 'shell', 'input', 'tap', str(x), str(y)])
PY
}

set_api_override() {
  local url="$1" # empty = clear
  $ADB -s "$DEVICE" shell am force-stop "$PKG" || true
  if [[ -z "$url" ]]; then
    $ADB -s "$DEVICE" shell "run-as $PKG sh -c 'rm -f shared_prefs/ytm_api.xml'" >/dev/null 2>&1 || true
  else
    $ADB -s "$DEVICE" shell "run-as $PKG sh -c 'mkdir -p shared_prefs; cat > shared_prefs/ytm_api.xml'" <<EOF
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="base_url">${url}</string>
</map>
EOF
  fi
}

collect_errors() {
  local tag="$1"
  local file="$REPORT_DIR/logcat-$tag.txt"
  $ADB -s "$DEVICE" logcat -d -v time >"$file" 2>/dev/null || true
  python3 - "$file" "$tag" <<'PY' | tee -a "$REPORT"
import sys,re
path,tag=sys.argv[1],sys.argv[2]
lines=open(path,encoding='utf-8',errors='ignore').read().splitlines()
# Focus app + exo + okhttp
pat=re.compile(r'YtMusic|ovh\.delhomme\.ytmusic|ExoPlayer|PlaybackException|OkHttp|AndroidRuntime|FATAL|Source error|CodecException', re.I)
err=re.compile(r'\sE\s|\sF\s|FATAL|Exception|Error|←-- [45]\d\d|failed|FAIL', re.I)
noise=re.compile(r'Choreographer|BufferQueue|gralloc|OpenGLRenderer|eglCodec|RenderThread|TrafficStats|StrictMode', re.I)
hits=[]
for ln in lines:
    if not pat.search(ln): continue
    if noise.search(ln): continue
    if err.search(ln):
        hits.append(ln[-240:])
print(f'--- errors[{tag}] count={len(hits)} ---')
for h in hits[-40:]:
    print(h)
# HTTP status summary for our API
codes={}
for ln in lines:
    m=re.search(r'←-- (\d{3}) (https?://\S+)', ln)
    if m:
        codes.setdefault(m.group(1),0)
        codes[m.group(1)]+=1
    m2=re.search(r'--> (\d{3}) (https?://\S+)', ln)  # some loggers
if codes:
    print('http_status:', ' '.join(f'{k}×{v}' for k,v in sorted(codes.items())))
# stream / lyrics / home
for key in ('/api/home','/api/search','/api/stream','/api/lyrics','/api/library','/api/track'):
    n=sum(1 for ln in lines if key in ln)
    bad=sum(1 for ln in lines if key in ln and re.search(r'←-- [45]\d\d', ln))
    if n: print(f'hit {key}: {n} lines, errors≈{bad}')
PY
}

exercise_ui() {
  local env="$1"
  log "==> UI exercise ($env)"
  dump_ui "$REPORT_DIR/ui.xml"
  log "ui: $(ui_texts "$REPORT_DIR/ui.xml")"

  # Tabs (éviter « Bibliothèque » — collision UI / notifications)
  for tab in Accueil Recherche Biblio; do
    if tap_text "$tab" 2>/dev/null; then
      note_ok "tap $tab"
      sleep 1.2
      dump_ui "$REPORT_DIR/ui.xml"
    fi
  done

  # Search flow
  if tap_text "Recherche" 2>/dev/null; then
    sleep 1
    dump_ui "$REPORT_DIR/ui.xml"
    tap_text "Rechercher" 2>/dev/null || tap_text "Titres, artistes" 2>/dev/null || true
    sleep 0.4
    $ADB -s "$DEVICE" shell input text "daft%spunk" || true
    $ADB -s "$DEVICE" shell input keyevent 66 || true
    sleep 3
    dump_ui "$REPORT_DIR/ui.xml"
    log "search_ui: $(ui_texts "$REPORT_DIR/ui.xml")"
    # Filtre Playlists (crashait avant : clés Compose dupliquées)
    if tap_text "Playlists" 2>/dev/null; then
      sleep 1.5
      dump_ui "$REPORT_DIR/ui.xml"
      log "playlists_ui: $(ui_texts "$REPORT_DIR/ui.xml")"
      note_ok "filtre Playlists sans crash"
    fi
    tap_text "Titres" 2>/dev/null || true
    sleep 1
    tap_text "Lire" 2>/dev/null || true
    sleep 2
  fi

  # Home + play
  $ADB -s "$DEVICE" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
  sleep 1
  tap_text "Accueil" 2>/dev/null || true
  sleep 2
  dump_ui "$REPORT_DIR/ui.xml"
  tap_text "Lire" 2>/dev/null || true
  sleep 4
  dump_ui "$REPORT_DIR/ui.xml"
  log "player_ui: $(ui_texts "$REPORT_DIR/ui.xml")"

  # Library tab only
  tap_text "Biblio" 2>/dev/null || true
  sleep 2
  dump_ui "$REPORT_DIR/ui.xml"
  log "lib_ui: $(ui_texts "$REPORT_DIR/ui.xml")"
}

api_probe() {
  local base="$1" token="$2" env="$3"
  log "==> API probe $env ($base)"
  python3 - "$base" "$token" "$env" <<'PY' | tee -a "$REPORT"
import json,sys,urllib.request,urllib.error,urllib.parse
base,token,env=sys.argv[1:4]
base=base.rstrip('/')
H={'Authorization':f'Bearer {token}','Content-Type':'application/json'}

def get(path):
    req=urllib.request.Request(base+path, headers=H)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body=r.read()
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()

checks=[
 ('/api/health', False),
 ('/api/home', True),
 ('/api/search?q=welcome+to+the+internet', True),
 ('/api/library', True),
 ('/api/pins', True),
]
vid=None
for path,auth in checks:
    st,body=get(path if auth or True else path)
    ok=200<=st<300
    print(('OK  ' if ok else 'FAIL'), env, path, st, f'bytes={len(body)}')
    if path.startswith('/api/search') and ok:
        try:
            d=json.loads(body)
            songs=d.get('songs') or []
            if songs: vid=songs[0].get('id')
        except: pass

if vid:
    for path in (f'/api/track/{vid}', f'/api/track/{vid}/lyrics', f'/api/stream/{vid}/url'):
        st,body=get(path)
        ok=200<=st<300
        extra=''
        if 'lyrics' in path and ok:
            try:
                d=json.loads(body); extra=f" lyrics={bool(d.get('lyrics'))}"
            except: pass
        if 'stream' in path and ok:
            try:
                d=json.loads(body); extra=f" url={bool(d.get('url'))}"
            except: pass
        print(('OK  ' if ok else 'FAIL'), env, path, st, extra)
else:
    print('WARN', env, 'no song id from search')
PY
}

login_token() {
  local api="$1"
  EMAIL="${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}" PASS="${SEED_PASSWORD:-${VITE_DEV_PASSWORD:-}}" API="$api" node <<'NODE'
const email = process.env.EMAIL;
const password = process.env.PASS;
const api = process.env.API.replace(/\/$/, '');
const r = await fetch(`${api}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const j = await r.json();
if (!r.ok) { console.error('login_fail', r.status, JSON.stringify(j)); process.exit(2); }
process.stdout.write(j.token || '');
NODE
}

inject_session() {
  local api="$1"
  bash "$ROOT/scripts/adb/adb-login.sh" >/dev/null
  # adb-login uses API_BASE_URL from env
}

run_env() {
  local env="$1" api="$2" use_reverse="$3"
  log ""
  log "############################################################"
  log "## ENV $env  API=$api"
  log "############################################################"

  $ADB -s "$DEVICE" reverse --remove-all >/dev/null 2>&1 || true
  if [[ "$use_reverse" == "1" ]]; then
    $ADB -s "$DEVICE" reverse tcp:8787 tcp:8787 || true
    note_ok "adb reverse :8787"
  fi

  if [[ "$env" == "DEV" ]]; then
    # Prefer 127.0.0.1 via reverse for stability
    set_api_override "http://127.0.0.1:8787"
  else
    set_api_override "https://ytmusic.delhomme.ovh"
  fi

  export API_BASE_URL="$api"
  DEVICE="$DEVICE" API_BASE_URL="$api" bash "$ROOT/scripts/adb/adb-login.sh" | tee -a "$REPORT"
  sleep 3

  BOOT="$($ADB -s "$DEVICE" logcat -d 2>/dev/null | grep -F 'YtMusic : boot' | tail -1 || true)"
  log "boot: $BOOT"
  if [[ "$env" == "PROD" ]]; then
    echo "$BOOT" | grep -q 'api=https://ytmusic.delhomme.ovh' && note_ok "boot API prod" || note_fail "boot API pas prod ($BOOT)"
  else
    echo "$BOOT" | grep -qE 'api=http://(127\.0\.0\.1|192\.168\.)' && note_ok "boot API local" || note_warn "boot API=$BOOT"
  fi

  dump_ui "$REPORT_DIR/ui.xml"
  TEXTS="$(ui_texts "$REPORT_DIR/ui.xml")"
  log "ui0: $TEXTS"
  if echo "$TEXTS" | grep -qE 'Accueil|Recherche|Biblio'; then
    note_ok "session home visible"
  elif echo "$TEXTS" | grep -q 'Se connecter'; then
    note_fail "toujours sur login"
  else
    note_warn "UI ambiguë"
  fi

  TOKEN="$(login_token "$api")"
  api_probe "$api" "$TOKEN" "$env"

  $ADB -s "$DEVICE" logcat -c
  exercise_ui "$env"
  sleep 3
  collect_errors "$env"

  # Crash check
  if $ADB -s "$DEVICE" logcat -d 2>/dev/null | grep -q 'FATAL EXCEPTION'; then
    note_fail "FATAL EXCEPTION dans logcat ($env)"
    $ADB -s "$DEVICE" logcat -d 2>/dev/null | grep -A4 'FATAL EXCEPTION' | tail -30 | tee -a "$REPORT" || true
  else
    note_ok "pas de FATAL EXCEPTION ($env)"
  fi
}

# Ensure local API
if ! curl -sf http://127.0.0.1:8787/api/health >/dev/null; then
  log "==> ensure-api local"
  bash "$ROOT/scripts/dev/ensure-api.sh" >/dev/null || true
fi

run_env "DEV" "http://127.0.0.1:8787" 1
run_env "PROD" "https://ytmusic.delhomme.ovh" 0

# Restore DEV default for daily use
set_api_override "http://127.0.0.1:8787"
$ADB -s "$DEVICE" reverse tcp:8787 tcp:8787 || true
DEVICE="$DEVICE" API_BASE_URL="http://127.0.0.1:8787" bash "$ROOT/scripts/adb/adb-login.sh" >/dev/null || true

log ""
log "==> SUMMARY fail=$fail report=$REPORT"
exit "$fail"
