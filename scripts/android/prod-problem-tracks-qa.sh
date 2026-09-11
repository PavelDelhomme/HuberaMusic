#!/usr/bin/env bash
# QA titres froids / problématiques en prod — Samsung (+ Blackview si branché).
# Usage:
#   bash scripts/android/prod-problem-tracks-qa.sh
#   DEVICES="192.168.1.184:35357 EEA9700PRO0014587" bash scripts/android/prod-problem-tracks-qa.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a || true

API="${API_PROD:-https://ytmusic.delhomme.ovh}"
API="${API%/}"
ADB="${ADB_BIN:-adb}"
PKG=ovh.delhomme.ytmusic
REPORT_DIR="/tmp/ytmusic-problem-qa"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/report-$(date +%Y%m%d-%H%M%S).txt"
: >"$REPORT"

DEVICES="${DEVICES:-}"
if [[ -z "$DEVICES" ]]; then
  DEVICES="$($ADB devices | awk '/\tdevice$/{print $1}' | rg '192\.168\.1\.184|EEA9700' || true)"
fi

fail=0
log() { echo "$*" | tee -a "$REPORT"; }
ok() { log "OK   $*"; }
bad() { fail=1; log "FAIL $*"; }
warn() { log "WARN $*"; }

log "==> Problem-tracks QA API=$API"
log "    devices: $DEVICES"
log "    report=$REPORT"

# Resolve token once
eval "$(
  EMAIL="${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}" \
  PASS_PRIMARY="${LOGIN_PASSWORD:-${SEED_PASSWORD:-}}" \
  PASS_FALLBACK="${VITE_DEV_PASSWORD:-}" \
  API="$API" node <<'NODE'
const email = process.env.EMAIL;
const api = process.env.API;
const passwords = [...new Set([process.env.PASS_PRIMARY, process.env.PASS_FALLBACK].filter(Boolean))];
for (const password of passwords) {
  const r = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (r.ok && j.token) {
    const esc = (s) => String(s || '').replace(/'/g, "'\\''");
    console.log(`TOKEN='${esc(j.token)}'`);
    process.exit(0);
  }
}
console.error('login_fail');
process.exit(2);
NODE
)"
ok "api login token_len=${#TOKEN}"

# Search problem tracks → ids
TRACKS_JSON="$(TOKEN="$TOKEN" API="$API" node <<'NODE'
const api = process.env.API.replace(/\/$/, '');
const tok = process.env.TOKEN;
const H = { Authorization: 'Bearer ' + tok, 'X-YTM-Client': 'android' };
const queries = [
  'Sapé comme jamais Maître Gims',
  'Mama Burito',
  'Hollywood Scylla',
  'GROSSE BELTA',
  'IMMORTEL Gims',
  'Sois pas timide Gims',
  'Côté Noir Gims',
];
const out = [];
for (const q of queries) {
  const r = await fetch(api + '/api/search?q=' + encodeURIComponent(q) + '&filter=songs', { headers: H, signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  const songs = j.songs || j.results || [];
  const s = songs.find((x) => x && String(x.id || '').length === 11);
  if (s) out.push({ q, id: s.id, title: s.title || '?', artists: (s.artists || []).map((a) => a.name || a).slice(0, 2).join(', ') });
  else out.push({ q, id: null, title: null });
}
console.log(JSON.stringify(out));
NODE
)"
log "tracks: $TRACKS_JSON"

# API stream smoke for each id
API="$API" TOKEN="$TOKEN" TRACKS_JSON="$TRACKS_JSON" node <<'NODE' | tee -a "$REPORT"
const api = process.env.API.replace(/\/$/, '');
const tok = process.env.TOKEN;
const tracks = JSON.parse(process.env.TRACKS_JSON);
const H = { Authorization: 'Bearer ' + tok, 'X-YTM-Client': 'android' };
let fails = 0;
for (const t of tracks) {
  if (!t.id) { console.log('WARN  no id for ' + t.q); continue; }
  const t0 = Date.now();
  await fetch(api + '/api/stream/warm', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [t.id] }), signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  let st = 0, n = 0;
  try {
    const r = await fetch(api + '/api/stream/' + t.id, {
      headers: { ...H, Range: 'bytes=0-65535' },
      signal: AbortSignal.timeout(25000),
    });
    st = r.status;
    n = Buffer.from(await r.arrayBuffer()).length;
  } catch (e) { st = 0; }
  const ms = Date.now() - t0;
  const good = (st === 200 || st === 206) && n > 500;
  console.log((good ? 'OK   ' : 'FAIL ') + `stream ${t.id} (${t.title}) → ${st} ${n}b ${ms}ms`);
  if (!good) fails++;
}
if (fails) process.exit(3);
NODE
api_rc=$?
if [[ $api_rc -ne 0 ]]; then bad "API stream suite"; else ok "API stream suite"; fi

play_and_watch() {
  local device="$1" id="$2" label="$3"
  log ""
  log "---- $device play $id ($label) ----"
  $ADB -s "$device" logcat -c >/dev/null 2>&1 || true
  $ADB -s "$device" shell cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true
  $ADB -s "$device" shell am start -a android.intent.action.VIEW \
    -d "https://plm.delhomme.ovh/watch/$id" \
    -n "$PKG/ovh.delhomme.ytmusic.MainActivity" >/dev/null 2>&1 || \
  $ADB -s "$device" shell am start -a android.intent.action.VIEW \
    -d "ytmusic://watch/$id" >/dev/null 2>&1 || true
  sleep 1
  $ADB -s "$device" shell input keyevent 126 >/dev/null 2>&1 || true  # MEDIA_PLAY
  $ADB -s "$device" shell cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true

  local ready=0 playing=0 pos_max=0 seek0=0 escalate=0 skipped=0 buf_stall=0
  local i
  for i in $(seq 1 28); do
    sleep 2
    local sess
    sess="$($ADB -s "$device" shell dumpsys media_session 2>/dev/null | rg -A22 "package=$PKG" | head -30 || true)"
    # Samsung: state=PLAYING(3) · Blackview: state=3
    if echo "$sess" | rg -q "state=PLAYING|state=3[, }]"; then playing=1; fi
    # Volume 0 pendant les tests (coupe le son, pas la lecture)
    $ADB -s "$device" shell cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true
    if echo "$sess" | rg -q "state=PlaybackState"; then
      local pos
      pos="$(echo "$sess" | rg -o 'position=[0-9]+' | head -1 | cut -d= -f2 || echo 0)"
      if [[ "${pos:-0}" -gt "$pos_max" ]]; then pos_max="$pos"; fi
    fi
    local lc
    lc="$($ADB -s "$device" logcat -d -t 120 --pid="$($ADB -s "$device" shell pidof "$PKG" 2>/dev/null || echo 0)" 2>/dev/null || true)"
    if echo "$lc" | rg -q "STATE_READY"; then ready=1; fi
    if echo "$lc" | rg -q "rebindCurrentStream reason=stall.*pos=0 |stall-buffer-restart|seekFromStart"; then seek0=$((seek0 + 1)); fi
    if echo "$lc" | rg -q "STATE_READY id=$id pos=0 "; then
      # pos=0 at first READY is OK; after mid-play escalate with prior high pos is bad — counted via seek0 pattern
      :
    fi
    if echo "$lc" | rg -q "stall-buffer escalate-recover"; then escalate=$((escalate + 1)); fi
    if echo "$lc" | rg -q "Skipped [0-9]{3,} frames"; then skipped=$((skipped + 1)); fi
    if echo "$lc" | rg -q "PlaybackException|Source error"; then buf_stall=$((buf_stall + 1)); fi
    # Early success: playing and advanced > 8s
    if [[ "$playing" -eq 1 && "$pos_max" -gt 8000 ]]; then
      break
    fi
  done

  log "    ready=$ready playing=$playing pos_max=${pos_max}ms escalate=$escalate seek0_hits=$seek0 skipped_frames_hits=$skipped exo_err=$buf_stall"

  if [[ "$playing" -ne 1 ]]; then
    # Blackview parfois state numérique déjà capté ; sinon pos qui avance = lecture OK.
    if [[ "$pos_max" -ge 8000 ]]; then
      warn "$device $label state≠PLAYING but pos_max=${pos_max}ms — treat OK"
    else
      bad "$device $label not PLAYING"
      return 1
    fi
  fi
  if [[ "$pos_max" -lt 4000 ]]; then
    bad "$device $label position stuck (${pos_max}ms)"
    return 1
  fi
  if [[ "$seek0" -gt 0 ]]; then
    bad "$device $label seek-to-0 / restart detected"
    return 1
  fi
  if [[ "$skipped" -gt 3 ]]; then
    warn "$device $label UI jank (Skipped frames x$skipped)"
  fi
  ok "$device $label playing pos≥${pos_max}ms"
  return 0
}

# Transition test: track A then track B via second deeplink (simulates next)
transition_test() {
  local device="$1" id_a="$2" id_b="$3"
  log ""
  log "---- $device transition $id_a → $id_b ----"
  $ADB -s "$device" logcat -c >/dev/null 2>&1 || true
  $ADB -s "$device" shell am start -a android.intent.action.VIEW \
    -d "https://plm.delhomme.ovh/watch/$id_a" \
    -n "$PKG/ovh.delhomme.ytmusic.MainActivity" >/dev/null 2>&1 || true
  sleep 12
  local pos_before
  pos_before="$($ADB -s "$device" shell dumpsys media_session 2>/dev/null | rg -A15 "package=$PKG" | rg -o 'position=[0-9]+' | head -1 | cut -d= -f2 || echo 0)"
  $ADB -s "$device" shell am start -a android.intent.action.VIEW \
    -d "https://plm.delhomme.ovh/watch/$id_b" \
    -n "$PKG/ovh.delhomme.ytmusic.MainActivity" >/dev/null 2>&1 || true
  sleep 14
  local sess meta playing pos
  sess="$($ADB -s "$device" shell dumpsys media_session 2>/dev/null | rg -A22 "package=$PKG" | head -30 || true)"
  meta="$(echo "$sess" | rg 'metadata:' | head -1 || true)"
  playing=0; echo "$sess" | rg -q 'state=PLAYING|state=3[, }]' && playing=1
  pos="$(echo "$sess" | rg -o 'position=[0-9]+' | head -1 | cut -d= -f2 || echo 0)"
  local lc
  lc="$($ADB -s "$device" logcat -d -t 200 --pid="$($ADB -s "$device" shell pidof "$PKG" 2>/dev/null || echo 0)" 2>/dev/null || true)"
  local seek0=0
  echo "$lc" | rg -q "stall-buffer-restart|seekFromStart|rebindCurrentStream reason=stall.*pos=0 " && seek0=1
  log "    before_pos=${pos_before} after_pos=$pos playing=$playing meta=$meta seek0=$seek0"
  if [[ "$playing" -ne 1 ]]; then bad "$device transition not PLAYING"; return 1; fi
  if [[ "$seek0" -eq 1 ]]; then bad "$device transition seek-to-0"; return 1; fi
  if [[ "$pos" -lt 1500 ]]; then
    # new track may be early — OK if PLAYING
    warn "$device transition early pos=${pos}ms (OK if PLAYING)"
  fi
  ok "$device transition PLAYING"
}

for device in $DEVICES; do
  if ! $ADB -s "$device" get-state >/dev/null 2>&1; then
    warn "skip unreachable $device"
    continue
  fi
  log ""
  log "======== DEVICE $device ========"
  ver="$($ADB -s "$device" shell dumpsys package "$PKG" 2>/dev/null | rg 'versionName=' | head -1 | sed 's/.*versionName=//')"
  log "version=$ver"
  if [[ "$ver" != *1.3.128* ]]; then
    warn "$device version=$ver (attendu p+1.3.128)"
  fi

  DEVICE="$device" API_BASE_URL="$API" PKG="$PKG" bash "$ROOT/scripts/adb/adb-login.sh" | tee -a "$REPORT" || bad "$device login"
  sleep 3

  # Play top problem tracks (limit 5 for time)
  IDS="$(echo "$TRACKS_JSON" | python3 -c 'import sys,json; print(" ".join(t["id"] for t in json.load(sys.stdin) if t.get("id")))')"
  n=0
  for id in $IDS; do
    n=$((n + 1))
    [[ $n -gt 5 ]] && break
    title="$(echo "$TRACKS_JSON" | python3 -c 'import sys,json; d={t["id"]:t.get("title") for t in json.load(sys.stdin) if t.get("id")}; print(d.get("'"$id"'","?"))')"
    play_and_watch "$device" "$id" "$title" || true
  done

  # Transition Mama → Sapé if both present
  ID_A="$(echo "$TRACKS_JSON" | python3 -c 'import sys,json; xs=json.load(sys.stdin); print(next((t["id"] for t in xs if t.get("id") and "Mama" in (t.get("q") or "")), ""))')"
  ID_B="$(echo "$TRACKS_JSON" | python3 -c 'import sys,json; xs=json.load(sys.stdin); print(next((t["id"] for t in xs if t.get("id") and "Sap" in (t.get("q") or "")), ""))')"
  if [[ -n "$ID_A" && -n "$ID_B" ]]; then
    transition_test "$device" "$ID_A" "$ID_B" || true
  fi
done

log ""
if [[ $fail -eq 0 ]]; then
  ok "ALL CHECKS PASSED"
  exit 0
else
  bad "SOME CHECKS FAILED — see $REPORT"
  exit 1
fi
