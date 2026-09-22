/**
 * Digest quotidien (12h30 Europe/Paris) des problèmes de chargement / lecture.
 *
 * Agrège la télémétrie Android des dernières 24 h :
 *  - android.player.stall / cold_next / prefetch_miss / early_end
 *  - android.player.load_skip (auto-skip chargement KO — le plus fréquent)
 *  - android.player (error/fatal/warn)
 *  - listen_events skip très tôt (<8 % ou <15 s)
 *
 * Envoie un mail HTML lisible avec titres résolus (oembed) pour savoir
 * quelles musiques ont mis longtemps ou ont échoué.
 *
 * Env :
 *  PLAYBACK_DIGEST_DISABLE=1     → off
 *  PLAYBACK_DIGEST_TO=…          → destinataires (défaut TELEMETRY_ALERT_TO / ADMIN_EMAILS / SEED)
 *  PLAYBACK_DIGEST_HOUR=12
 *  PLAYBACK_DIGEST_MINUTE=30
 *  PLAYBACK_DIGEST_TZ=Europe/Paris
 *  PLAYBACK_DIGEST_WINDOW_MS=86400000
 *  PLAYBACK_DIGEST_SKIP_EMPTY=0  → 1 = n’envoie rien s’il n’y a aucun problème
 */
import { db } from '../library/db.js';
import { mailBrand, sendMail } from './mail.js';
import {
  extractTrackIds,
  resolveTracksForTelemetry,
  type ResolvedTrack,
} from './telemetryTracks.js';

const KIND_SET = new Set([
  'android.player.stall',
  'android.player.cold_next',
  'android.player.prefetch_miss',
  'android.player.early_end',
  'android.player.load_skip',
  'android.player.load_recover',
]);

type TelemetryRow = {
  id: string;
  created_at: number;
  level: string;
  kind: string;
  message: string | null;
  device_id: string | null;
  user_id: string | null;
  meta: string | null;
};

type TrackAgg = {
  trackId: string;
  title?: string;
  artist?: string;
  stalls: number;
  cold: number;
  prefetchMiss: number;
  earlyEnd: number;
  loadSkips: number;
  earlyListenSkips: number;
  playerErrors: number;
  lastAt: number;
  levels: Set<string>;
  sampleMessages: string[];
};

let timer: ReturnType<typeof setTimeout> | null = null;
let lastSentDayKey = '';

function enabled(): boolean {
  const v = String(process.env.PLAYBACK_DIGEST_DISABLE || '').trim().toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes');
}

function digestTo(): string {
  return (
    process.env.PLAYBACK_DIGEST_TO?.trim() ||
    process.env.TELEMETRY_ALERT_TO?.trim() ||
    process.env.BATTERY_REPORT_TO?.trim() ||
    process.env.ADMIN_EMAILS?.split(',')[0]?.trim() ||
    process.env.SEED_EMAIL?.trim() ||
    'dev@delhomme.ovh'
  );
}

function hourMinute(): { hour: number; minute: number } {
  const hour = Math.min(23, Math.max(0, Number(process.env.PLAYBACK_DIGEST_HOUR ?? 12) || 12));
  const minute = Math.min(59, Math.max(0, Number(process.env.PLAYBACK_DIGEST_MINUTE ?? 30) || 30));
  return { hour, minute };
}

/** Clé jour Europe/Paris (YYYY-MM-DD) pour anti-double envoi. */
function parisDayKey(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.PLAYBACK_DIGEST_TZ || 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function parisNowParts(d = new Date()): { hour: number; minute: number; dayKey: string } {
  const tz = process.env.PLAYBACK_DIGEST_TZ || 'Europe/Paris';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return { hour, minute, dayKey: parisDayKey(d) };
}

/** ms jusqu’au prochain créneau HH:MM Europe/Paris. */
export function msUntilNextDigest(from = Date.now()): number {
  const { hour: targetH, minute: targetM } = hourMinute();
  const tz = process.env.PLAYBACK_DIGEST_TZ || 'Europe/Paris';
  // Approche : avancer minute par minute jusqu’à trouver le créneau (max 25 h)
  let t = from + 15_000; // marge anti-double au boot
  const deadline = from + 26 * 3600_000;
  while (t < deadline) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    if (h === targetH && m === targetM) return Math.max(5_000, t - from);
    t += 30_000;
  }
  return 24 * 3600_000;
}

function parseMeta(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPlaybackProblem(row: TelemetryRow): boolean {
  if (KIND_SET.has(row.kind)) return true;
  if (row.kind === 'android.player' || row.kind.startsWith('android.player.')) {
    return row.level === 'error' || row.level === 'fatal' || row.level === 'warn';
  }
  return false;
}

export function queryPlaybackProblems(windowMs?: number): TelemetryRow[] {
  const win = windowMs ?? Number(process.env.PLAYBACK_DIGEST_WINDOW_MS || 24 * 3600_000);
  const since = Date.now() - win;
  const rows = db
    .prepare(
      `SELECT id, created_at, level, kind, message, device_id, user_id, meta
       FROM telemetry_events
       WHERE created_at > ?
         AND (
           kind IN ('android.player.stall','android.player.cold_next','android.player.prefetch_miss','android.player.early_end','android.player.load_skip')
           OR (kind LIKE 'android.player%' AND level IN ('warn','error','fatal'))
         )
       ORDER BY created_at DESC
       LIMIT 2000`,
    )
    .all(since) as TelemetryRow[];
  return rows.filter(isPlaybackProblem);
}

/** Skips d’écoute très tôt = souvent auto-skip silencieux (avant load_skip instrumenté). */
export function queryEarlyListenSkips(windowMs?: number): Array<{
  track_id: string;
  c: number;
  last_at: number;
}> {
  const win = windowMs ?? Number(process.env.PLAYBACK_DIGEST_WINDOW_MS || 24 * 3600_000);
  const since = Date.now() - win;
  try {
    return db
      .prepare(
        `SELECT track_id, COUNT(*) AS c, MAX(created_at) AS last_at
         FROM listen_events
         WHERE event = 'skip'
           AND created_at > ?
           AND (
             COALESCE(progress_pct, 0) < 8
             OR (COALESCE(duration_ms, 0) > 0 AND COALESCE(progress_pct, 0) / 100.0 * duration_ms < 15000)
           )
         GROUP BY track_id
         HAVING c >= 1
         ORDER BY c DESC
         LIMIT 80`,
      )
      .all(since) as Array<{ track_id: string; c: number; last_at: number }>;
  } catch {
    return [];
  }
}

function bump(
  map: Map<string, TrackAgg>,
  trackId: string,
  kind: string,
  level: string,
  at: number,
  message: string | null,
) {
  let agg = map.get(trackId);
  if (!agg) {
    agg = {
      trackId,
      stalls: 0,
      cold: 0,
      prefetchMiss: 0,
      earlyEnd: 0,
      loadSkips: 0,
      earlyListenSkips: 0,
      playerErrors: 0,
      lastAt: at,
      levels: new Set(),
      sampleMessages: [],
    };
    map.set(trackId, agg);
  }
  agg.lastAt = Math.max(agg.lastAt, at);
  agg.levels.add(level);
  if (kind === 'android.player.stall') agg.stalls += 1;
  else if (kind === 'android.player.cold_next') agg.cold += 1;
  else if (kind === 'android.player.prefetch_miss') agg.prefetchMiss += 1;
  else if (kind === 'android.player.early_end') agg.earlyEnd += 1;
  else if (kind === 'android.player.load_skip') agg.loadSkips += 1;
  else if (kind === 'listen.early_skip') agg.earlyListenSkips += 1;
  else agg.playerErrors += 1;
  if (message && agg.sampleMessages.length < 3 && !agg.sampleMessages.includes(message)) {
    agg.sampleMessages.push(message.slice(0, 180));
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'android.player.stall':
      return 'Buffer / chargement trop long (stall)';
    case 'android.player.cold_next':
      return 'Titre suivant froid (pas préchauffé)';
    case 'android.player.prefetch_miss':
      return 'Prefetch manqué';
    case 'android.player.early_end':
      return 'Fin prématurée du titre';
    case 'android.player.load_skip':
      return 'Auto-skip : chargement KO (passé au suivant)';
    case 'android.player.load_recover':
      return 'Rebind / recover (évite le skip)';
    case 'listen.early_skip':
      return 'Skip très tôt (<8 % / <15 s) — souvent auto ou abandon';
    default:
      return 'Erreur lecteur';
  }
}

export async function buildPlaybackDigest(opts?: {
  windowMs?: number;
}): Promise<{
  subject: string;
  html: string;
  text: string;
  totalEvents: number;
  trackCount: number;
  byKind: Record<string, number>;
}> {
  const rows = queryPlaybackProblems(opts?.windowMs);
  const byKind: Record<string, number> = {};
  const byTrack = new Map<string, TrackAgg>();
  const orphanEvents: TelemetryRow[] = [];

  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    const meta = parseMeta(row.meta);
    const ids = [
      ...extractTrackIds(row.message),
      ...extractTrackIds(typeof meta === 'object' && meta ? JSON.stringify(meta) : null),
    ];
    // meta.trackId prioritaire
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      for (const k of ['trackId', 'id', 'currentId', 'videoId']) {
        const v = String(m[k] || '').trim();
        if (/^[a-zA-Z0-9_-]{11}$/.test(v)) ids.unshift(v);
      }
    }
    const unique = [...new Set(ids)];
    if (!unique.length) {
      orphanEvents.push(row);
      continue;
    }
    for (const id of unique.slice(0, 2)) {
      bump(byTrack, id, row.kind, row.level, row.created_at, row.message);
    }
  }

  const earlySkips = queryEarlyListenSkips(opts?.windowMs);
  let earlySkipEvents = 0;
  for (const s of earlySkips) {
    const id = String(s.track_id || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
    earlySkipEvents += Number(s.c) || 0;
    byKind['listen.early_skip'] = (byKind['listen.early_skip'] || 0) + (Number(s.c) || 0);
    for (let i = 0; i < Math.min(Number(s.c) || 1, 12); i++) {
      bump(byTrack, id, 'listen.early_skip', 'warn', Number(s.last_at) || Date.now(), 'skip écoute très tôt');
    }
  }

  const trackIds = [...byTrack.keys()].slice(0, 40);
  let resolved: ResolvedTrack[] = [];
  if (trackIds.length) {
    resolved = await resolveTracksForTelemetry({
      meta: { trackIds },
      message: trackIds.map((id) => `trackId=${id}`).join(' '),
      limit: Math.min(40, trackIds.length),
    });
    const byId = new Map(resolved.map((t) => [t.id, t]));
    for (const [id, agg] of byTrack) {
      const t = byId.get(id);
      if (t) {
        agg.title = t.title;
        agg.artist = t.artist;
      }
    }
  }

  const ranked = [...byTrack.values()].sort((a, b) => {
    const score = (x: TrackAgg) =>
      x.loadSkips * 5 +
      x.stalls * 3 +
      x.earlyListenSkips * 3 +
      x.cold * 2 +
      x.prefetchMiss * 2 +
      x.earlyEnd * 2 +
      x.playerErrors * 4;
    return score(b) - score(a) || b.lastAt - a.lastAt;
  });

  const when = new Date().toLocaleString('fr-FR', {
    timeZone: process.env.PLAYBACK_DIGEST_TZ || 'Europe/Paris',
  });
  const total = rows.length + earlySkipEvents;
  const brand = mailBrand();
  const subject =
    total === 0
      ? `[${brand}] Digest lecture 12h30 — aucun problème (24 h)`
      : `[${brand}] Digest lecture 12h30 — ${total} signal${total > 1 ? 's' : ''} · ${ranked.length} titre${ranked.length > 1 ? 's' : ''}`;

  const kindLines = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  · ${kindLabel(k)} : ${n}`);

  const textLines = [
    `${brand} — Digest chargement / lecture`,
    `Généré : ${when}`,
    `Fenêtre : dernières 24 h`,
    '',
    `Total événements : ${total}`,
    `Titres distincts : ${ranked.length}`,
    '',
    'Par type :',
    ...(kindLines.length ? kindLines : ['  · (aucun)']),
    '',
  ];

  if (ranked.length) {
    textLines.push('Titres concernés (les plus fréquents en premier) :', '');
    for (const t of ranked.slice(0, 30)) {
      const label = t.title
        ? `${t.title}${t.artist ? ` — ${t.artist}` : ''}`
        : t.trackId;
      textLines.push(
        `• ${label}`,
        `  id=${t.trackId}  loadSkip=${t.loadSkips} stall=${t.stalls} cold=${t.cold} miss=${t.prefetchMiss} early=${t.earlyEnd} listenSkip=${t.earlyListenSkips} err=${t.playerErrors}`,
      );
      if (t.sampleMessages[0]) textLines.push(`  « ${t.sampleMessages[0]} »`);
      textLines.push(`  https://music.youtube.com/watch?v=${t.trackId}`, '');
    }
  } else {
    textLines.push('Aucun titre lent / stall signalé sur la fenêtre — RAS.');
  }

  if (orphanEvents.length) {
    textLines.push(
      '',
      `Événements sans trackId extractible : ${orphanEvents.length}`,
      ...orphanEvents.slice(0, 8).map(
        (e) =>
          `  · ${new Date(e.created_at).toLocaleString('fr-FR')} [${e.level}] ${e.kind} — ${(e.message || '').slice(0, 100)}`,
      ),
    );
  }

  const rowsHtml = ranked
    .slice(0, 30)
    .map((t) => {
      const label = t.title
        ? `<strong>${escapeHtml(t.title)}</strong>${t.artist ? ` <span style="color:#71717a">— ${escapeHtml(t.artist)}</span>` : ''}`
        : `<code>${t.trackId}</code>`;
      const badges = [
        t.loadSkips ? `<span style="background:#7f1d1d;color:#fef2f2;padding:2px 6px;border-radius:4px;font-size:12px">auto-skip ×${t.loadSkips}</span>` : '',
        t.earlyListenSkips ? `<span style="background:#9f1239;color:#fff1f2;padding:2px 6px;border-radius:4px;font-size:12px">skip tôt ×${t.earlyListenSkips}</span>` : '',
        t.stalls ? `<span style="background:#fef2f2;color:#991b1b;padding:2px 6px;border-radius:4px;font-size:12px">stall ×${t.stalls}</span>` : '',
        t.cold ? `<span style="background:#fff7ed;color:#9a3412;padding:2px 6px;border-radius:4px;font-size:12px">cold ×${t.cold}</span>` : '',
        t.prefetchMiss ? `<span style="background:#eff6ff;color:#1e40af;padding:2px 6px;border-radius:4px;font-size:12px">miss ×${t.prefetchMiss}</span>` : '',
        t.earlyEnd ? `<span style="background:#f5f3ff;color:#5b21b6;padding:2px 6px;border-radius:4px;font-size:12px">early ×${t.earlyEnd}</span>` : '',
        t.playerErrors ? `<span style="background:#18181b;color:#fafafa;padding:2px 6px;border-radius:4px;font-size:12px">err ×${t.playerErrors}</span>` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e4e4e7;vertical-align:top">${label}<div style="margin-top:6px">${badges}</div>
          ${t.sampleMessages[0] ? `<div style="margin-top:6px;font-size:12px;color:#52525b">${escapeHtml(t.sampleMessages[0])}</div>` : ''}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #e4e4e7;font-size:12px;white-space:nowrap">
          <a href="https://music.youtube.com/watch?v=${t.trackId}">YouTube Music</a><br/>
          <code style="font-size:11px">${t.trackId}</code>
        </td>
      </tr>`;
    })
    .join('');

  const kindHtml = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, n]) =>
        `<li><strong>${n}</strong> — ${escapeHtml(kindLabel(k))} <span style="color:#a1a1aa">(${escapeHtml(k)})</span></li>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5">
  <div style="max-width:720px;margin:20px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;font-family:Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;color:#18181b;line-height:1.5">
    <div style="background:#18181b;color:#fafafa;padding:20px 24px">
      <div style="font-size:12px;opacity:0.75;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(brand)} · Digest automatique 12h30</div>
      <h1 style="margin:6px 0 0;font-size:20px">Chargement / lecture — dernières 24 h</h1>
      <p style="margin:8px 0 0;font-size:13px;opacity:0.85">${escapeHtml(when)}</p>
    </div>
    <div style="padding:20px 24px;font-size:14px">
      <p style="margin:0 0 14px">Résumé des titres qui ont <strong>mis longtemps à charger</strong>, des stalls, des skips « froid », des prefetch manqués et des erreurs lecteur signalés par l’app Android.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 18px">
        <div style="background:#f4f4f5;border-radius:8px;padding:12px 16px;min-width:120px"><div style="font-size:11px;color:#71717a">Événements</div><div style="font-size:22px;font-weight:700">${total}</div></div>
        <div style="background:#f4f4f5;border-radius:8px;padding:12px 16px;min-width:120px"><div style="font-size:11px;color:#71717a">Titres</div><div style="font-size:22px;font-weight:700">${ranked.length}</div></div>
      </div>
      <h2 style="font-size:15px;margin:0 0 8px">Par type</h2>
      <ul style="margin:0 0 18px;padding-left:18px">${kindHtml || '<li>Aucun problème</li>'}</ul>
      ${
        ranked.length
          ? `<h2 style="font-size:15px;margin:0 0 8px">Titres concernés</h2>
             <table style="width:100%;border-collapse:collapse">${rowsHtml}</table>`
          : `<p style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;color:#166534;margin:0">Aucun titre lent signalé sur la fenêtre — RAS.</p>`
      }
      <p style="margin:22px 0 0;font-size:12px;color:#71717a">Source : table <code>telemetry_events</code> · heal auto via <code>streamHeal</code> déjà appliqué à la réception. Ce mail est un bilan quotidien, pas une alerte temps réel.</p>
    </div>
  </div>
</body></html>`;

  return {
    subject,
    html,
    text: textLines.join('\n'),
    totalEvents: total,
    trackCount: ranked.length,
    byKind,
  };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendPlaybackDigestNow(opts?: {
  windowMs?: number;
  force?: boolean;
}): Promise<{ ok: boolean; skipped?: string; subject?: string; totalEvents?: number }> {
  if (!enabled() && !opts?.force) {
    return { ok: false, skipped: 'disabled' };
  }
  const digest = await buildPlaybackDigest({ windowMs: opts?.windowMs });
  const skipEmpty = String(process.env.PLAYBACK_DIGEST_SKIP_EMPTY || '').trim() === '1';
  if (skipEmpty && digest.totalEvents === 0 && !opts?.force) {
    return { ok: true, skipped: 'empty', totalEvents: 0, subject: digest.subject };
  }
  const to = digestTo();
  await sendMail({
    to,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
  });
  console.info(
    `[playbackDigest] mail → ${to} events=${digest.totalEvents} tracks=${digest.trackCount}`,
  );
  return { ok: true, subject: digest.subject, totalEvents: digest.totalEvents };
}

function scheduleNext(): void {
  if (!enabled()) {
    console.info('[playbackDigest] disabled');
    return;
  }
  const wait = msUntilNextDigest();
  const { hour, minute } = hourMinute();
  console.info(
    `[playbackDigest] prochain envoi ~${hour.toString().padStart(2, '0')}:${minute
      .toString()
      .padStart(2, '0')} Paris dans ${Math.round(wait / 60_000)} min`,
  );
  timer = setTimeout(() => {
    void (async () => {
      try {
        const day = parisDayKey();
        if (day === lastSentDayKey) {
          console.info('[playbackDigest] déjà envoyé aujourd’hui — skip');
        } else {
          // Si on arrive pile dans la minute cible
          const now = parisNowParts();
          const target = hourMinute();
          if (now.hour === target.hour && Math.abs(now.minute - target.minute) <= 2) {
            const r = await sendPlaybackDigestNow();
            if (r.ok && !r.skipped) lastSentDayKey = day;
          } else {
            // Recalage (DST / drift)
            const r = await sendPlaybackDigestNow();
            if (r.ok && !r.skipped) lastSentDayKey = day;
          }
        }
      } catch (err) {
        console.error('[playbackDigest] send failed', err);
      } finally {
        scheduleNext();
      }
    })();
  }, wait);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    try {
      (timer as NodeJS.Timeout).unref?.();
    } catch {
      /* ignore */
    }
  }
}

/** Démarre le scheduler 12h30 (appelé au boot API). */
export function startPlaybackDigestScheduler(): void {
  if (!enabled()) {
    console.info('[playbackDigest] disabled');
    return;
  }
  if (timer) return;
  scheduleNext();
}
