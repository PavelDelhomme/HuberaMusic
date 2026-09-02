import { sendMail, getAppEnv, appUrl } from './mail.js';
import { buildTextPdf } from './textPdf.js';
import { diagnoseTelemetryEvent, formatDiagnosisText } from './telemetryDiagnose.js';
import {
  enrichDiagnosisWithTracks,
  formatTracksHtml,
  formatTracksText,
  resolveTracksForTelemetry,
  tidyBreadcrumbs,
  tidyRecentLogs,
  tidyStack,
  type ResolvedTrack,
} from './telemetryTracks.js';

const THROTTLE_MS = Number(process.env.TELEMETRY_ALERT_THROTTLE_MS || 90_000);
/** Erreurs player / crash Android : mail quasi immédiat (demande produit). */
const THROTTLE_PLAYER_MS = Number(process.env.TELEMETRY_ALERT_PLAYER_THROTTLE_MS || 12_000);
const lastSent = new Map<string, number>();
/** Occurrences écrasées par le throttle — rappelées dans le prochain mail. */
const suppressed = new Map<string, number>();
/** Au-delà : corps email résumé + PDF PJ avec dump complet. */
const INLINE_MAX = Number(process.env.TELEMETRY_ALERT_INLINE_MAX || 10_000);

function alertRecipients(): string {
  const raw =
    process.env.TELEMETRY_ALERT_TO ||
    process.env.ADMIN_EMAILS ||
    process.env.SEED_EMAIL ||
    '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

function fingerprint(level: string, kind: string, message: string, stack?: string): string {
  const msg = message || '';
  const blob = msg + (stack || '');
  if (/Response code:\s*502|HTTP 502|home stream 502|STREAM_UPSTREAM/i.test(blob)) {
    return `${level}|${kind}|stream-502`;
  }
  if (/early end\s+\S+/i.test(msg) && /unavailable|502|Source error/i.test(blob)) {
    return `${level}|${kind}|early-end-stream`;
  }
  if (/Player is accessed on the wrong thread|verifyApplicationThread/i.test(blob)) {
    return `${level}|${kind}|exo-wrong-thread`;
  }
  // EOF mid-titre (souvent même piste en boucle) — un seul mail / piste / fenêtre.
  if (/EOFException/i.test(blob) && /Source error|onPlayerError|android\.player/i.test(blob)) {
    const tid = /id=([a-zA-Z0-9_-]{11})/.exec(msg)?.[1] || 'unknown';
    return `${level}|${kind}|exo-eof|${tid}`;
  }
  // Même piste / même code Exo (2001, 2004…) → un mail par fenêtre, pas une rafale
  if (/onPlayerError code=(\d+)/i.test(msg)) {
    const code = /onPlayerError code=(\d+)/i.exec(msg)?.[1] || 'x';
    const tid = /id=([a-zA-Z0-9_-]{11})/.exec(msg)?.[1] || 'unknown';
    const http = /http=(\d{3})/i.exec(msg)?.[1] || '';
    return `${level}|${kind}|exo-${code}|${http}|${tid}`;
  }
  if (/^Script error\.?$/i.test(msg.trim())) {
    return `${level}|${kind}|script-error`;
  }
  const tip = msg.slice(0, 120);
  const stackTip = (stack || '').split('\n').slice(0, 2).join('|').slice(0, 120);
  return `${level}|${kind}|${tip}|${stackTip}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function asRecord(meta: unknown): Record<string, unknown> {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return {};
}

function extractLogs(meta: unknown): string {
  const m = asRecord(meta);
  const logs = m.recentLogs;
  if (typeof logs === 'string' && logs.trim()) return logs;
  return '';
}

function extractBreadcrumbs(meta: unknown): string {
  const m = asRecord(meta);
  const b = m.breadcrumbs;
  if (Array.isArray(b)) return b.map((x) => String(x)).join('\n');
  if (typeof b === 'string') return b;
  return '';
}

function metaWithoutHeavy(meta: unknown): string {
  const m = { ...asRecord(meta) };
  delete m.recentLogs;
  delete m.breadcrumbs;
  try {
    return JSON.stringify(m, null, 2);
  } catch {
    return String(meta);
  }
}

function sectionCard(title: string, bodyHtml: string, tone: 'warn' | 'dark' | 'plain' = 'plain'): string {
  const bg =
    tone === 'warn' ? '#fef3c7' : tone === 'dark' ? '#111' : '#f4f4f5';
  const color = tone === 'dark' ? '#fafafa' : '#111';
  const border = tone === 'warn' ? 'border:1px solid #f59e0b;' : '';
  return `<h3 style="margin:20px 0 8px;font-family:system-ui,sans-serif;font-size:15px">${esc(title)}</h3>
<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;color:${color};background:${bg};padding:12px 14px;border-radius:10px;overflow:auto;max-height:360px;${border}white-space:pre-wrap">${bodyHtml}</div>`;
}

/**
 * Email admin sur error/fatal (throttle par fingerprint).
 * Inclut titres résolus + liens pour chaque trackId, dump lisible.
 */
export async function maybeAlertTelemetryError(ev: {
  id: string;
  env?: string;
  level: string;
  kind: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  userId?: string;
  deviceId?: string;
  meta?: unknown;
}): Promise<{ sent: boolean; reason?: string; pdfAttached?: boolean }> {
  const level = String(ev.level || '').toLowerCase();
  if (level !== 'error' && level !== 'fatal') {
    return { sent: false, reason: 'level' };
  }
  if (process.env.TELEMETRY_ALERT_DISABLE === '1' || process.env.TELEMETRY_ALERT_DISABLE === 'true') {
    return { sent: false, reason: 'disabled' };
  }

  // EOF / Source error mid-titre : reste en DB télémétrie, PAS de mail.
  // (APK ≤1.3.74 empoisonnés + boucles recovery = avalanche ; 1.3.75+ corrige la cause.)
  const kind0 = String(ev.kind || '');
  const blob0 = `${ev.message || ''}\n${ev.stack || ''}`;
  const meta0 = asRecord(ev.meta);
  const isEofSpam =
    kind0.includes('android.player') &&
    /EOFException|SampleDataQueue|FragmentedMp4Extractor/i.test(blob0) &&
    meta0.local !== true &&
    meta0.serious !== true;
  if (/stall escalate-skip|android\.player\.stall/i.test(blob0) || kind0.includes('android.player.stall')) {
    // always mail — intentional signal when silent buffering loop is broken
  } else if (isEofSpam) {
    return { sent: false, reason: 'eof-no-mail' };
  }
  // Cross-origin / SW noise web — inutile en mail
  if (
    kind0 === 'window.error' &&
    /script\s*error/i.test(String(ev.message || ''))
  ) {
    return { sent: false, reason: 'web-noise' };
  }
  if (kind0 === 'unhandledrejection' && /ServiceWorker script at /i.test(blob0)) {
    return { sent: false, reason: 'web-noise' };
  }
  // Fichier local KO : jamais de mail tant que streak bas (même si serious=true vieux APK)
  if (
    kind0.includes('android.player') &&
    (meta0.local === true || /local=true/i.test(String(ev.message || ''))) &&
    Number(meta0.streak || 0) < 5
  ) {
    return { sent: false, reason: 'local-soft' };
  }
  // Toast hors main thread — déjà corrigé, pas de mail
  if (kind0.includes('android.coroutine') && /Can't toast on a thread|Looper\.prepare/i.test(blob0)) {
    return { sent: false, reason: 'toast-thread' };
  }
  // APK obsolètes encore en prod : ignorer leurs alertes player non fatales.
  const ver = String(meta0.appVersion || meta0.versionName || '');
  if (
    kind0.includes('android.player') &&
    /p\+1\.3\.(6\d|7[0-4])\b/.test(ver) &&
    level !== 'fatal'
  ) {
    return { sent: false, reason: 'stale-apk' };
  }

  const to = alertRecipients();
  if (!to) return { sent: false, reason: 'no-recipients' };

  const fp = fingerprint(level, ev.kind, ev.message || '', ev.stack);
  const now = Date.now();
  const prev = lastSent.get(fp) || 0;
  const kind = String(ev.kind || '');
  const gapPlayer = Math.max(THROTTLE_PLAYER_MS, 45_000);
  const gap =
    /\|exo-eof\|/.test(fp) || /\|exo-\d+\|/.test(fp)
      ? Math.max(gapPlayer, 180_000) // même piste / code : 3 min
      : kind.startsWith('android.') || kind.includes('player') || kind.includes('crash')
        ? gapPlayer
        : THROTTLE_MS;
  if (now - prev < gap) {
    suppressed.set(fp, (suppressed.get(fp) || 0) + 1);
    return { sent: false, reason: 'throttled' };
  }
  lastSent.set(fp, now);
  const skipped = suppressed.get(fp) || 0;
  suppressed.delete(fp);
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) {
      if (now - t > THROTTLE_MS * 4) lastSent.delete(k);
    }
  }

  const env = ev.env || getAppEnv();
  const logsRaw = extractLogs(ev.meta);
  const crumbsRaw = extractBreadcrumbs(ev.meta);
  const logs = tidyRecentLogs(logsRaw);
  const crumbs = tidyBreadcrumbs(crumbsRaw);
  const stack = tidyStack((ev.stack || '').trim() || '(aucune stack Throwable — voir logs / breadcrumbs)');
  const metaLite = metaWithoutHeavy(ev.meta);

  let tracks: ResolvedTrack[] = [];
  try {
    tracks = await resolveTracksForTelemetry({
      meta: ev.meta,
      message: ev.message,
      stack: ev.stack,
      breadcrumbs: crumbsRaw,
      logs: logsRaw,
      limit: 8,
    });
  } catch (err) {
    console.error('[telemetry-alert] track resolve failed', err);
  }

  const diagnosis = diagnoseTelemetryEvent({
    kind: ev.kind,
    message: ev.message,
    stack: ev.stack,
    url: ev.url,
    userAgent: ev.userAgent,
    meta: ev.meta,
  });
  let diagText = enrichDiagnosisWithTracks(formatDiagnosisText(diagnosis), tracks);
  const skipNote =
    skipped > 0
      ? `\n(${skipped} occurrence${skipped > 1 ? 's' : ''} identique${skipped > 1 ? 's' : ''} non envoyée${skipped > 1 ? 's' : ''} pendant le throttle)`
      : '';
  const tracksText = formatTracksText(tracks);
  const tracksHtml = formatTracksHtml(tracks);

  const fullDump = [
    `PLM telemetry alert`,
    `id=${ev.id}`,
    `env=${env} level=${level} kind=${ev.kind}`,
    `device=${ev.deviceId || '—'} user=${ev.userId || '—'}`,
    `url=${ev.url || '—'}`,
    `ua=${ev.userAgent || '—'}`,
    `app=${appUrl()}`,
    '',
    '=== TITRES CONCERNÉS ===',
    tracksText,
    '',
    '=== PRÉ-DIAGNOSTIC ===',
    diagText + skipNote,
    '',
    '=== MESSAGE ===',
    ev.message || '(vide)',
    '',
    '=== STACK (nettoyée) ===',
    stack,
    '',
    '=== BREADCRUMBS ===',
    crumbs,
    '',
    '=== RECENT LOGS (filtrés) ===',
    logs,
    '',
    '=== META ===',
    metaLite || '(aucune)',
  ].join('\n');

  const heavy = fullDump.length > INLINE_MAX;
  const subjectTrack =
    tracks[0] && tracks[0].source !== 'id-only'
      ? ` · ${tracks[0].title.slice(0, 40)}`
      : tracks[0]
        ? ` · ${tracks[0].id}`
        : '';
  const subject = `[PLM ${env}] ${level.toUpperCase()} · ${diagnosis.family} · ${ev.kind}${subjectTrack}`;

  const textSummary = [
    `PLM · ${env} · ${level} · ${ev.kind}`,
    `id=${ev.id}`,
    `device=${ev.deviceId || '—'}  user=${ev.userId || '—'}`,
    '',
    '--- titres concernés ---',
    tracksText,
    '',
    '--- pré-diagnostic ---',
    diagText + skipNote,
    '',
    '--- message ---',
    ev.message || '(vide)',
    '',
    '--- stack ---',
    stack.slice(0, 3_500) + (stack.length > 3_500 ? '\n…[voir PDF]' : ''),
    '',
    '--- breadcrumbs ---',
    crumbs.slice(0, 2_000),
    '',
    '--- logs ---',
    logs.slice(-3_000),
    '',
    heavy ? '→ Dump complet en pièce jointe PDF.' : '--- meta ---\n' + metaLite,
  ].join('\n');

  const html = `
<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:720px">
  <p style="margin:0 0 4px"><strong>PLM ${esc(env)}</strong>
    <span style="color:#666"> · ${esc(level)} · ${esc(ev.kind)} · ${esc(diagnosis.family)}</span></p>
  <p style="margin:0 0 16px;color:#444;font-size:13px">
    id=<code>${esc(ev.id)}</code><br/>
    device=<code>${esc(ev.deviceId || '—')}</code>
    · user=<code>${esc(ev.userId || '—')}</code><br/>
    url=<code>${esc(ev.url || '—')}</code>
  </p>

  <h3 style="margin:0 0 8px;font-size:15px">Titres concernés</h3>
  <div style="background:#ecfdf5;border:1px solid #6ee7b7;padding:12px 14px;border-radius:10px;margin-bottom:8px">
    ${tracksHtml}
  </div>

  <h3 style="margin:16px 0 8px;font-size:15px">Pré-diagnostic</h3>
  <pre style="margin:0;white-space:pre-wrap;background:#fef3c7;padding:12px 14px;border-radius:10px;border:1px solid #f59e0b;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5">${esc(diagText)}${esc(skipNote)}</pre>

  ${sectionCard('Message', esc(ev.message || '(vide)'))}
  ${sectionCard('Stack (nettoyée)', esc(stack.slice(0, 6_000)) + (stack.length > 6_000 ? esc('\n…[PDF]') : ''), 'dark')}
  ${sectionCard('Breadcrumbs', esc(crumbs.slice(0, 4_000)))}
  ${sectionCard('Logs récents (filtrés)', esc(logs.slice(-6_000)))}
  ${sectionCard('Meta', esc(metaLite.slice(0, 3_500)))}
  ${heavy ? '<p style="color:#666;font-size:13px"><em>Dump complet joint en PDF.</em></p>' : ''}
</div>`.trim();

  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
  if (heavy || !ev.stack || logsRaw.length > 2_000) {
    try {
      const pdf = buildTextPdf({
        title: `PLM ${env} · ${level} · ${ev.kind} · ${ev.id}`,
        sections: [
          {
            heading: 'Résumé',
            body: [
              `message: ${ev.message || '(vide)'}`,
              `device: ${ev.deviceId || '—'}`,
              `user: ${ev.userId || '—'}`,
              `url: ${ev.url || '—'}`,
              `ua: ${ev.userAgent || '—'}`,
            ].join('\n'),
          },
          { heading: 'Titres concernés', body: tracksText },
          { heading: 'Pré-diagnostic', body: diagText + skipNote },
          { heading: 'Stack (nettoyée)', body: stack },
          { heading: 'Breadcrumbs', body: crumbs },
          { heading: 'Logs (filtrés)', body: logs },
          { heading: 'Meta', body: metaLite || '(aucune)' },
        ],
      });
      attachments.push({
        filename: `plm-telemetry-${ev.id.slice(0, 8)}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      });
    } catch (err) {
      console.error('[telemetry-alert] pdf failed', err);
      attachments.push({
        filename: `plm-telemetry-${ev.id.slice(0, 8)}.txt`,
        content: Buffer.from(fullDump, 'utf8'),
        contentType: 'text/plain; charset=utf-8',
      });
    }
  }

  try {
    await sendMail({
      to,
      subject,
      html,
      text: textSummary,
      attachments,
    });
    console.info(
      `[telemetry-alert] sent to=${to} kind=${ev.kind} id=${ev.id} tracks=${tracks.length} pdf=${attachments.some((a) => a.contentType === 'application/pdf')}`,
    );
    return { sent: true, pdfAttached: attachments.some((a) => a.contentType === 'application/pdf') };
  } catch (err) {
    console.error('[telemetry-alert] mail failed', err);
    return { sent: false, reason: 'mail-failed' };
  }
}

type DigestItem = {
  id: string;
  level: string;
  kind: string;
  message?: string;
  count?: number;
  trackId?: string;
  http?: number;
  ts?: number;
};

/**
 * Un seul mail pour N erreurs cumulées hors-ligne (pas N mails).
 */
export async function maybeAlertTelemetryDigest(opts: {
  env?: string;
  deviceId?: string;
  userId?: string;
  userAgent?: string;
  events: DigestItem[];
}): Promise<{ sent: boolean; reason?: string }> {
  const events = opts.events.filter((e) => {
    const lv = String(e.level || '').toLowerCase();
    return lv === 'error' || lv === 'fatal';
  });
  if (!events.length) return { sent: false, reason: 'empty' };
  if (process.env.TELEMETRY_ALERT_DISABLE === '1' || process.env.TELEMETRY_ALERT_DISABLE === 'true') {
    return { sent: false, reason: 'disabled' };
  }
  const to = alertRecipients();
  if (!to) return { sent: false, reason: 'no-recipients' };

  const env = opts.env || getAppEnv();
  const n = events.reduce((acc, e) => acc + (Number(e.count) || 1), 0);

  const ids = events.map((e) => e.trackId).filter(Boolean) as string[];
  let tracks: ResolvedTrack[] = [];
  try {
    tracks = await resolveTracksForTelemetry({
      message: ids.join(' '),
      meta: { trackIds: ids },
      limit: 10,
    });
  } catch {
    /* ignore */
  }
  const byId = new Map(tracks.map((t) => [t.id, t]));

  const lines = events.slice(0, 20).map((e) => {
    const c = Number(e.count) > 1 ? ` ×${e.count}` : '';
    const t = e.trackId ? byId.get(e.trackId) : undefined;
    const label = t
      ? `${t.title}${t.artist ? ` — ${t.artist}` : ''} (${e.trackId})`
      : [e.trackId, e.http ? `http ${e.http}` : ''].filter(Boolean).join(' · ');
    return `• ${e.kind}${c} — ${(e.message || '').slice(0, 120)}${label ? ` · ${label}` : ''}`;
  });
  const subject = `[PLM ${env}] ${n} erreur${n > 1 ? 's' : ''} cumulée${n > 1 ? 's' : ''} hors-ligne`;
  const text = [
    `Digest télémétrie (appareil hors-ligne puis reconnecté).`,
    `device=${opts.deviceId || '—'} user=${opts.userId || '—'}`,
    `ua=${opts.userAgent || '—'}`,
    '',
    '--- titres ---',
    formatTracksText(tracks),
    '',
    ...lines,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
  <h2>${esc(subject)}</h2>
  <p>Événements tamponnés sur l’appareil, envoyés <strong>en un seul mail</strong> au retour réseau.</p>
  <p>device=${esc(opts.deviceId || '—')} · user=${esc(opts.userId || '—')}</p>
  <h3>Titres concernés</h3>
  ${formatTracksHtml(tracks)}
  <ul>${lines.map((l) => `<li>${esc(l.replace(/^• /, ''))}</li>`).join('')}</ul>
</div>`;
  try {
    await sendMail({ to, subject, html, text });
    console.info(`[telemetry-alert] digest sent n=${n} to=${to}`);
    return { sent: true };
  } catch (err) {
    console.error('[telemetry-alert] digest mail failed', err);
    return { sent: false, reason: 'mail-failed' };
  }
}
