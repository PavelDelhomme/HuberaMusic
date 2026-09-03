#!/usr/bin/env bash
# Endurance muette ~45 min Samsung + Blackview : titres froids + IDs problème télémétrie.
# Mute stream 3, deeplinks, skip/seek, logcat patterns (stall / early_end / FATAL / seek0).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
set -a; source .env; set +a

PKG="${PKG:-ovh.delhomme.ytmusic}"
API="${API:-https://ytmusic.delhomme.ovh}"
DURATION_SEC="${DURATION_SEC:-2700}"
SAMSUNG="${SAMSUNG:-192.168.1.184:35357}"
BLACKVIEW="${BLACKVIEW:-EEA9700PRO0014587}"
ADB="${ADB:-adb}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/logs/endurance/dual-45m-$STAMP"
mkdir -p "$OUT"
REPORT="$OUT/report.txt"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$REPORT"; }

DEVICES=()
for d in "$SAMSUNG" "$BLACKVIEW"; do
  if $ADB -s "$d" get-state >/dev/null 2>&1; then DEVICES+=("$d"); else log "WARN offline $d"; fi
done
[[ ${#DEVICES[@]} -ge 1 ]] || { log "FATAL no device"; exit 1; }

TOKEN="$(
  node --input-type=module <<'NODE'
const email = process.env.SEED_EMAIL;
const passwords = [process.env.VITE_DEV_PASSWORD, process.env.SEED_PASSWORD].filter(Boolean);
const api = (process.env.API || 'https://ytmusic.delhomme.ovh').replace(/\/$/, '');
for (const password of passwords) {
  const r = await fetch(api + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.token) { process.stdout.write(j.token); process.exit(0); }
}
process.exit(1);
NODE
)"
[[ -n "$TOKEN" ]] || { log "FATAL login"; exit 1; }

# IDs problème (télémétrie stall/502/early_end) + recherches froides
PROBLEM_IDS=(
  WryQZ_OPpaI aD-izFJxFh8 uCHU8qLiEEk wvrSkKYY3D4 KJtOTXqaW9w
  abiWZq7YKEc PZ2pAo9HntI dKJfJMMsqX4 XRw_OgoRnL8 O4jezMQWqjk
)
COLD_QS=(
  "gims sois pas timide"
  "scylla mama"
  "grosse belta"
  "immortel gims"
  "liSA crossing field"
  "homura lisa"
  "melrose place ytm"
  "juste une photo de toi"
)

TRACKS_JSON="$(
  API="$API" TOKEN="$TOKEN" PROBLEM_IDS="$(IFS=,; echo "${PROBLEM_IDS[*]}")" \
  COLD_QS="$(printf '%s\n' "${COLD_QS[@]}")" node <<'NODE'
const api = process.env.API.replace(/\/$/, '');
const tok = process.env.TOKEN;
const H = { Authorization: 'Bearer ' + tok, 'X-YTM-Client': 'android' };
const ids = (process.env.PROBLEM_IDS || '').split(',').filter(Boolean);
const qs = (process.env.COLD_QS || '').split('\n').filter(Boolean);
const out = [];
for (const id of ids) out.push({ id, title: id, src: 'problem' });
for (const q of qs) {
  try {
    const r = await fetch(api + '/api/search?q=' + encodeURIComponent(q) + '&filter=songs', {
      headers: H, signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    const songs = j.songs || j.results || [];
    const s = songs.find((x) => x && String(x.id || '').length === 11);
    if (s) out.push({ id: s.id, title: s.title || q, src: 'cold:' + q });
  } catch (_) {}
}
// dédup
const seen = new Set();
const uniq = [];
for (const t of out) {
  if (!t.id || seen.has(t.id)) continue;
  seen.add(t.id);
  uniq.push(t);
}
console.log(JSON.stringify(uniq));
NODE
)"
echo "$TRACKS_JSON" > "$OUT/tracks.json"
N="$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$TRACKS_JSON")"
log "tracks=$N devices=${DEVICES[*]} duration=${DURATION_SEC}s → $OUT"

mute() {
  local d="$1"
  $ADB -s "$d" shell cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true
  $ADB -s "$d" shell media volume --stream 3 --set 0 >/dev/null 2>&1 || true
}

play_id() {
  local d="$1" id="$2"
  mute "$d"
  $ADB -s "$d" shell am start -a android.intent.action.VIEW \
    -d "https://plm.delhomme.ovh/watch/$id" \
    -n "$PKG/ovh.delhomme.ytmusic.MainActivity" >/dev/null 2>&1 || \
  $ADB -s "$d" shell am start -a android.intent.action.VIEW \
    -d "ytmusic://watch/$id" >/dev/null 2>&1 || true
  sleep 1
  $ADB -s "$d" shell input keyevent 126 >/dev/null 2>&1 || true
  mute "$d"
}

session_pos() {
  local d="$1"
  local sess
  sess="$($ADB -s "$d" shell dumpsys media_session 2>/dev/null | rg -A30 "package=$PKG" | head -40 || true)"
  echo "$sess" | rg -o 'position=[0-9]+' | head -1 | cut -d= -f2 || echo 0
}

session_playing() {
  local d="$1"
  local sess
  sess="$($ADB -s "$d" shell dumpsys media_session 2>/dev/null | rg -A30 "package=$PKG" | head -40 || true)"
  echo "$sess" | rg -q "state=PLAYING|state=3[, }]" && echo 1 || echo 0
}

analyze_logcat() {
  local d="$1" tag="$2"
  local pid lc
  pid="$($ADB -s "$d" shell pidof "$PKG" 2>/dev/null || echo 0)"
  lc="$($ADB -s "$d" logcat -d -t 400 --pid="$pid" 2>/dev/null || true)"
  local escalate giveup early seek0 fatal exo
  escalate="$(echo "$lc" | rg -c "stall-buffer escalate-recover" || true)"
  giveup="$(echo "$lc" | rg -c "give-up|stall-buffer give-up" || true)"
  early="$(echo "$lc" | rg -c "early_end|android.player.early_end" || true)"
  seek0="$(echo "$lc" | rg -c "seekFromStart|stall-buffer-restart|rebindCurrentStream reason=stall.*pos=0 " || true)"
  fatal="$(echo "$lc" | rg -c "FATAL EXCEPTION|AndroidRuntime" || true)"
  exo="$(echo "$lc" | rg -c "PlaybackException|Source error" || true)"
  echo "$tag escalate=${escalate:-0} giveup=${giveup:-0} early=${early:-0} seek0=${seek0:-0} fatal=${fatal:-0} exo=${exo:-0}"
}

for d in "${DEVICES[@]}"; do
  $ADB -s "$d" logcat -c >/dev/null 2>&1 || true
  mute "$d"
  $ADB -s "$d" shell am force-stop "$PKG" >/dev/null 2>&1 || true
  sleep 1
  $ADB -s "$d" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
done

START=$(date +%s)
END=$((START + DURATION_SEC))
IDX=0
TRACK_N="$N"
ROUND=0

# Round-robin titres ; sur chaque device actions agressives
while [[ $(date +%s) -lt $END ]]; do
  ROUND=$((ROUND + 1))
  ID="$(node -e 'const a=JSON.parse(process.argv[1]); const i=Number(process.argv[2])%a.length; console.log(a[i].id)' "$TRACKS_JSON" "$IDX")"
  TITLE="$(node -e 'const a=JSON.parse(process.argv[1]); const i=Number(process.argv[2])%a.length; console.log(a[i].title||a[i].id)' "$TRACKS_JSON" "$IDX")"
  LEFT=$((END - $(date +%s)))
  log "=== round $ROUND idx=$IDX id=$ID ($TITLE) left=${LEFT}s ==="

  for d in "${DEVICES[@]}"; do
    play_id "$d" "$ID"
  done

  # Laisser démarrer ~25 s
  for _ in $(seq 1 12); do
    sleep 2
    for d in "${DEVICES[@]}"; do mute "$d"; done
  done

  for d in "${DEVICES[@]}"; do
    pos="$(session_pos "$d")"
    pl="$(session_playing "$d")"
    log "  $d playing=$pl pos=${pos}ms $(analyze_logcat "$d" "$d")"
  done

  # Stress : pause/play, skip, seek mid, play next deeplink
  ACTION=$((ROUND % 5))
  case $ACTION in
    0)
      for d in "${DEVICES[@]}"; do
        $ADB -s "$d" shell input keyevent 127 >/dev/null 2>&1 || true # pause
        sleep 1
        $ADB -s "$d" shell input keyevent 126 >/dev/null 2>&1 || true
        mute "$d"
      done
      log "  action=pause-play"
      ;;
    1)
      for d in "${DEVICES[@]}"; do
        $ADB -s "$d" shell input keyevent 87 >/dev/null 2>&1 || true # next
        mute "$d"
      done
      log "  action=media-next"
      sleep 8
      ;;
    2)
      # Seek vers ~40% via media session (si supporté) — sinon skip
      for d in "${DEVICES[@]}"; do
        $ADB -s "$d" shell input keyevent 90 >/dev/null 2>&1 || true # FF
        $ADB -s "$d" shell input keyevent 90 >/dev/null 2>&1 || true
        mute "$d"
      done
      log "  action=ff"
      sleep 6
      ;;
    3)
      NEXT="$(node -e 'const a=JSON.parse(process.argv[1]); const i=(Number(process.argv[2])+1)%a.length; console.log(a[i].id)' "$TRACKS_JSON" "$IDX")"
      for d in "${DEVICES[@]}"; do play_id "$d" "$NEXT"; done
      log "  action=deeplink-next $NEXT"
      sleep 10
      ;;
    4)
      # Laisser jouer plus longtemps (proche fin naturelle pour titres courts)
      log "  action=hold-play ~50s"
      for _ in $(seq 1 25); do
        sleep 2
        for d in "${DEVICES[@]}"; do mute "$d"; done
        [[ $(date +%s) -lt $END ]] || break
      done
      ;;
  esac

  IDX=$(( (IDX + 1) % TRACK_N ))

  # Snapshot périodique
  for d in "${DEVICES[@]}"; do
    slug="$(echo "$d" | tr ':/' '__')"
    $ADB -s "$d" logcat -d -t 800 > "$OUT/logcat-$slug-r$ROUND.txt" 2>/dev/null || true
    analyze_logcat "$d" "snap" | tee -a "$OUT/metrics.txt" >/dev/null
  done
done

log "=== FIN endurance ==="
FAIL=0
for d in "${DEVICES[@]}"; do
  slug="$(echo "$d" | tr ':/' '__')"
  $ADB -s "$d" logcat -d > "$OUT/logcat-$slug-final.txt" 2>/dev/null || true
  line="$(analyze_logcat "$d" "FINAL")"
  log "$line"
  if echo "$line" | rg -q "fatal=[1-9]"; then FAIL=1; fi
  if echo "$line" | rg -q "seek0=[1-9]"; then FAIL=1; fi
done

# Récap patterns sur fichiers finaux
rg -n "stall-buffer give-up|stall-buffer escalate-recover|early_end|FATAL EXCEPTION|seekFromStart|Source error|PlaybackException" \
  "$OUT"/logcat-*-final.txt 2>/dev/null | head -80 | tee -a "$REPORT" || true

log "report=$REPORT fail=$FAIL"
exit "$FAIL"
