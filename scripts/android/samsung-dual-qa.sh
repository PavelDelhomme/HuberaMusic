#!/usr/bin/env bash
# QA long Samsung — PLM Dev (.dev / LAN) + PLM Prod (package principal) en séquence.
# Ne touche PAS le Nothing Phone.
#
# Usage:
#   DEVICE=R5CT7263YJL bash scripts/android/samsung-dual-qa.sh
#   ONLY=dev|prod bash scripts/android/samsung-dual-qa.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a || true

ADB="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-R5CT7263YJL}"
ONLY="${ONLY:-both}" # both|dev|prod
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
API_DEV="${API_DEV:-http://${LAN_IP:-192.168.1.134}:8787}"
API_PROD="${API_PROD:-${PUBLIC_API_URL:-https://ytmusic.delhomme.ovh}}"
API_PROD="${API_PROD%/}"
API_DEV="${API_DEV%/}"

PKG_DEV=ovh.delhomme.ytmusic.dev
PKG_PROD=ovh.delhomme.ytmusic
REPORT_DIR="/tmp/ytmusic-samsung-dual-qa"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/report-$(date +%Y%m%d-%H%M%S).txt"
: >"$REPORT"

fail=0
log() { echo "$*" | tee -a "$REPORT"; }
ok() { log "OK   $*"; }
bad() { fail=1; log "FAIL $*"; }
warn() { log "WARN $*"; }

if ! $ADB -s "$DEVICE" get-state >/dev/null 2>&1; then
  bad "device $DEVICE inaccessible"
  exit 1
fi

log "==> Samsung dual QA device=$DEVICE"
log "    DEV  $PKG_DEV → $API_DEV"
log "    PROD $PKG_PROD → $API_PROD"
log "    report=$REPORT"

login_token() {
  local api="$1"
  EMAIL="${SEED_EMAIL:-}" PASS="${SEED_PASSWORD:-}" API="$api" node <<'NODE'
const r = await fetch(process.env.API.replace(/\/$/,'') + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASS }),
});
const j = await r.json();
if (!r.ok) { console.error('login_fail', r.status, JSON.stringify(j)); process.exit(2); }
process.stdout.write(j.token || '');
NODE
}

api_suite() {
  local name="$1" api="$2"
  log ""
  log "======== API $name ($api) ========"
  local tok
  if ! tok="$(login_token "$api")"; then
    bad "$name login"
    return 1
  fi
  ok "$name login token_len=${#tok}"
  NAME="$name" API="$api" TOK="$tok" node <<'NODE' | tee -a "$REPORT"
const api = process.env.API.replace(/\/$/, '');
const tok = process.env.TOK;
const name = process.env.NAME;
const H = { Authorization: 'Bearer ' + tok, 'X-YTM-Client': 'android' };
let fails = 0;
async function get(path, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(api + path, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 25000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ms: Date.now() - t0, buf, headers: r.headers };
}
function mark(ok, msg) {
  console.log((ok ? 'OK   ' : 'FAIL ') + msg);
  if (!ok) fails++;
}
const health = await get('/api/health', { timeout: 8000 });
mark(health.status === 200, `${name} health ${health.status} ${health.ms}ms`);
for (const path of ['/api/auth/me', '/api/home', '/api/library', '/api/search?q=stromae&filter=songs']) {
  const r = await get(path);
  mark(r.status === 200 && r.buf.length > 20, `${name} ${path} → ${r.status} ${r.buf.length}b ${r.ms}ms`);
}
const s = await get('/api/search?q=never+gonna+give+you+up&filter=songs');
let songs = [];
try {
  const j = JSON.parse(s.buf.toString('utf8'));
  songs = j.songs || j.results || [];
} catch { /* */ }
const playable = [
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up (ref)' },
  { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody (ref)' },
  ...songs.filter((x) => x && String(x.id || '').length === 11),
].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).slice(0, 5);
mark(playable.length > 0, `${name} search+refs songs=${playable.length}`);
let streamOk = 0;
for (const t of playable) {
  const t0 = Date.now();
  const warm = await fetch(api + '/api/stream/warm', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [t.id] }),
    signal: AbortSignal.timeout(12000),
  }).catch(() => null);
  let st;
  try {
    st = await get(`/api/stream/${t.id}`, {
      headers: { Range: 'bytes=0-8191' },
      timeout: 20000,
    });
  } catch (e) {
    st = { status: 0, ms: Date.now() - t0, buf: Buffer.from(String(e)) };
  }
  const good = st.status === 200 || st.status === 206;
  const audio = good && st.buf.length > 500 && !String(st.buf.slice(0, 40)).includes('error');
  if (audio) streamOk++;
  // Log only — les covers YT « login required » ne font pas échouer toute la suite
  console.log((audio ? 'OK   ' : 'WARN ') + `${name} stream ${t.id} (${t.title || '?'}) → ${st.status} ${st.buf.length}b ${st.ms}ms warm=${warm?.status}`);
}
mark(streamOk >= 1, `${name} at least 1 stream OK (${streamOk}/${playable.length})`);
// lyrics / related smoke
if (playable[0]) {
  const id = playable[0].id;
  for (const path of [`/api/lyrics/${id}`, `/api/related/${id}?fast=1`]) {
    const r = await get(path, { timeout: 30000 }).catch((e) => ({ status: 0, buf: Buffer.from(String(e)), ms: 0 }));
    mark(r.status === 200, `${name} ${path} → ${r.status} ${r.ms}ms`);
  }
}
if (fails) process.exit(3);
NODE
  local rc=$?
  if [[ $rc -ne 0 ]]; then bad "$name API suite"; else ok "$name API suite"; fi
  return $rc
}

web_suite() {
  local name="$1" origin="$2"
  log ""
  log "======== WEB $name ($origin) ========"
  local code
  code="$(curl -sS -m 15 -o /tmp/ytm-web-$name.html -w '%{http_code}' "$origin/" || echo 000)"
  if [[ "$code" == "200" ]]; then
    ok "$name web index $code"
  else
    bad "$name web index $code"
  fi
  # assets / health via same origin if proxied
  local h
  h="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$origin/api/health" || echo 000)"
  if [[ "$h" == "200" ]]; then ok "$name web→api health"; else warn "$name web→api health=$h (ok si Vite sans proxy)"; fi
  # no obvious crash markers
  if grep -qiE 'Cannot GET|Internal Server Error' /tmp/ytm-web-$name.html 2>/dev/null; then
    bad "$name web HTML erreur"
  else
    ok "$name web HTML charge"
  fi
}

dump_ui() {
  local tag="$1"
  $ADB -s "$DEVICE" shell uiautomator dump /sdcard/ui-$tag.xml >/dev/null 2>&1 || true
  $ADB -s "$DEVICE" pull /sdcard/ui-$tag.xml "$REPORT_DIR/ui-$tag.xml" >/dev/null 2>&1 || true
}

ui_texts() {
  python3 - "$1" <<'PY'
import re,sys
p=sys.argv[1]
try: xml=open(p,encoding='utf-8',errors='ignore').read()
except Exception: print(''); raise SystemExit
print(' | '.join([t for t in re.findall(r'text="([^"]*)"', xml) if t.strip()][:35]))
PY
}

tap_exact() {
  local tag="$1" label="$2"
  DEVICE="$DEVICE" python3 - "$REPORT_DIR/ui-$tag.xml" "$label" <<'PY'
import re,sys,subprocess,os
xml=open(sys.argv[1],encoding='utf-8',errors='ignore').read()
label=sys.argv[2]
for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    t,x1,y1,x2,y2=m.group(1),*map(int,m.groups()[1:])
    if t==label:
        x,y=(x1+x2)//2,(y1+y2)//2
        print(f'TAP {t!r} @{x},{y}', flush=True)
        subprocess.check_call(['adb','-s',os.environ['DEVICE'],'shell','input','tap',str(x),str(y)])
        raise SystemExit(0)
raise SystemExit(2)
PY
}

tap_contains() {
  local tag="$1" needle="$2"
  DEVICE="$DEVICE" python3 - "$REPORT_DIR/ui-$tag.xml" "$needle" <<'PY'
import re,sys,subprocess,os
xml=open(sys.argv[1],encoding='utf-8',errors='ignore').read()
needle=sys.argv[2].lower()
cands=[]
for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    t,x1,y1,x2,y2=m.group(1),*map(int,m.groups()[1:])
    if needle in t.lower():
        cands.append((len(t),(x1+x2)//2,(y1+y2)//2,t))
if not cands: raise SystemExit(2)
cands.sort()
_,x,y,t=cands[0]
print(f'TAP {t!r} @{x},{y}', flush=True)
subprocess.check_call(['adb','-s',os.environ['DEVICE'],'shell','input','tap',str(x),str(y)])
PY
}

meminfo() {
  local pkg="$1" tag="$2"
  log "meminfo $tag"
  $ADB -s "$DEVICE" shell dumpsys meminfo "$pkg" 2>/dev/null \
    | awk '/TOTAL PSS:|Java Heap:|Native Heap:|Graphics:|App Summary/{print}' \
    | tee -a "$REPORT" | head -12 || true
}

collect_errs() {
  local tag="$1" pkg="$2"
  local f="$REPORT_DIR/logcat-$tag.txt"
  $ADB -s "$DEVICE" logcat -d -t 800 >"$f" 2>/dev/null || true
  python3 - "$f" "$tag" "$pkg" <<'PY' | tee -a "$REPORT" || true
import sys,re
path,tag,pkg=sys.argv[1:4]
lines=open(path,encoding='utf-8',errors='ignore').read().splitlines()
pat=re.compile(re.escape(pkg.split('.')[-1]) + r'|PlaybackService|ExoPlayer|AndroidRuntime|Source error|PlaybackException', re.I)
err=re.compile(r'\sE\s|\sF\s|FATAL|Exception|Source error|Lecture impossible|502|403')
hits=[]
for ln in lines:
    if pat.search(ln) and err.search(ln):
        hits.append(ln[-220:])
print(f'errors {tag}: {len(hits)}')
for h in hits[-12:]:
    print('   ', h)
PY
}

mobile_flow() {
  local tag="$1" pkg="$2" api="$3"
  log ""
  log "======== MOBILE $tag ($pkg) ========"
  $ADB -s "$DEVICE" shell am force-stop "$PKG_DEV" >/dev/null 2>&1 || true
  $ADB -s "$DEVICE" shell am force-stop "$PKG_PROD" >/dev/null 2>&1 || true
  sleep 1
  DEVICE="$DEVICE" API_BASE_URL="$api" PKG="$pkg" bash "$ROOT/scripts/adb/adb-login.sh" | tee -a "$REPORT"
  sleep 3
  dump_ui "$tag-home"
  local texts
  texts="$(ui_texts "$REPORT_DIR/ui-$tag-home.xml")"
  log "ui: $texts"
  if echo "$texts" | grep -qE 'Accueil|Recherche|Biblio'; then
    ok "$tag home session"
  elif echo "$texts" | grep -qi 'connecter'; then
    bad "$tag encore login"
    return 1
  else
    warn "$tag UI ambiguë"
  fi

  $ADB -s "$DEVICE" logcat -c >/dev/null 2>&1 || true

  # Navigation tabs
  for tab in Recherche Biblio Accueil; do
    dump_ui "$tag-tab"
    if tap_exact "$tag-tab" "$tab" 2>/dev/null; then
      ok "$tag tab $tab"
      sleep 1.2
    else
      warn "$tag tab $tab introuvable"
    fi
  done

  # Recherche + play
  dump_ui "$tag-presearch"
  tap_exact "$tag-presearch" "Recherche" 2>/dev/null || true
  sleep 1
  dump_ui "$tag-search"
  # focus edit
  DEVICE="$DEVICE" python3 - "$REPORT_DIR/ui-$tag-search.xml" <<'PY' || true
import re,sys,subprocess,os
xml=open(sys.argv[1],encoding='utf-8',errors='ignore').read()
for m in re.finditer(r'class="[^"]*EditText[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    x1,y1,x2,y2=map(int,m.groups())
    subprocess.check_call(['adb','-s',os.environ['DEVICE'],'shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)])
    break
PY
  sleep 0.4
  $ADB -s "$DEVICE" shell input text 'never%sgonna' >/dev/null
  $ADB -s "$DEVICE" shell input keyevent 66 >/dev/null
  sleep 4
  dump_ui "$tag-results"
  texts="$(ui_texts "$REPORT_DIR/ui-$tag-results.xml")"
  log "search: $texts"
  if echo "$texts" | grep -qiE 'Never Gonna|Rick Astley|Give You Up'; then
    ok "$tag search résultats"
  else
    warn "$tag search résultats faibles"
  fi
  # Tap a concrete track title if present
  if tap_exact "$tag-results" "Never Gonna Give You Up" 2>/dev/null \
    || tap_contains "$tag-results" "Never Gonna Give You Up" 2>/dev/null; then
    sleep 10
    dump_ui "$tag-play"
    texts="$(ui_texts "$REPORT_DIR/ui-$tag-play.xml")"
    log "play: $texts"
    if echo "$texts" | grep -qE '\-[0-9]+:[0-9]{2}|Rick Astley|Never Gonna'; then
      ok "$tag lecture UI signal"
    else
      warn "$tag lecture UI peu claire (peut être buffering)"
    fi
  else
    warn "$tag pas de tap Never Gonna"
  fi

  # Seek / pause via notification hard — mini player tap
  sleep 2
  dump_ui "$tag-np"
  # Open now playing if mini bar visible
  if tap_contains "$tag-np" "Rick" 2>/dev/null || tap_contains "$tag-np" "Never" 2>/dev/null; then
    sleep 2
    dump_ui "$tag-np2"
    ok "$tag now playing tenté"
  fi

  # Library
  dump_ui "$tag-lib0"
  tap_exact "$tag-lib0" "Biblio" 2>/dev/null || true
  sleep 2
  dump_ui "$tag-lib"
  texts="$(ui_texts "$REPORT_DIR/ui-$tag-lib.xml")"
  log "biblio: $texts"
  if echo "$texts" | grep -qiE 'Biblioth|Titres|J.aime|Playlist|Télécharg'; then
    ok "$tag biblio"
  else
    warn "$tag biblio UI"
  fi

  # Cold restart session
  $ADB -s "$DEVICE" shell am force-stop "$pkg" >/dev/null
  sleep 1
  $ADB -s "$DEVICE" shell am start -n "$pkg/ovh.delhomme.ytmusic.MainActivity" >/dev/null
  sleep 4
  dump_ui "$tag-cold"
  texts="$(ui_texts "$REPORT_DIR/ui-$tag-cold.xml")"
  log "cold: $texts"
  if echo "$texts" | grep -qE 'Accueil|Recherche|Biblio' && ! echo "$texts" | grep -qi 'connecter'; then
    ok "$tag cold start session"
  else
    bad "$tag cold start perdu session"
  fi

  meminfo "$pkg" "$tag"
  collect_errs "$tag" "$pkg"

  # Stay on title ~25s to catch late stream errors
  log "soak 25s $tag"
  sleep 25
  collect_errs "$tag-soak" "$pkg"
  dump_ui "$tag-soak"
  texts="$(ui_texts "$REPORT_DIR/ui-$tag-soak.xml")"
  log "soak: $texts"
  if echo "$texts" | grep -qi 'Lecture impossible'; then
    bad "$tag toast lecture impossible pendant soak"
  else
    ok "$tag pas de toast KO pendant soak"
  fi
}

# ---- run ----
api_suite LOCAL "http://127.0.0.1:8787" || true
api_suite PROD "$API_PROD" || true
web_suite LOCAL "http://127.0.0.1:5173" || true
web_suite PROD "$API_PROD" || true

if [[ "$ONLY" == "both" || "$ONLY" == "dev" ]]; then
  mobile_flow DEV "$PKG_DEV" "$API_DEV" || true
fi
if [[ "$ONLY" == "both" || "$ONLY" == "prod" ]]; then
  mobile_flow PROD "$PKG_PROD" "$API_PROD" || true
fi

log ""
log "======== SUMMARY fail=$fail report=$REPORT ========"
if [[ $fail -eq 0 ]]; then
  log "PASS samsung dual QA"
  exit 0
fi
log "FAIL samsung dual QA (voir $REPORT)"
exit 1
