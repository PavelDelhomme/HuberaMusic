import { sendMail, getAppEnv } from './mail.js';
import { buildTextPdf } from './textPdf.js';
import { diagnoseTelemetryEvent, formatDiagnosisText } from './telemetryDiagnose.js';

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
  // 502 stream / early_end répétés : même empreinte (évite 1 mail / piste pendant une panne relais)
  const msg = message || '';
  if (/Response code:\s*502|HTTP 502|home stream 502|STREAM_UPSTREAM/i.test(msg + (stack || ''))) {
    return `${level}|${kind}|stream-502`;
  }
  if (/early end\s+\S+/i.test(msg) && /unavailable|502|Source error/i.test(stack || msg)) {
    return `${level}|${kind}|early-end-stream`;
  }
  if (/Player is accessed on the wrong thread|verifyApplicationThread/i.test(stack || msg)) {
    return `${level}|${kind}|exo-wrong-thread`;
  }
  // Inclut l’id piste / code erreur pour ne pas écraser des alertes distinctes
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

/**
 * Email admin sur error/fatal (throttle par fingerprint).
 * Inclut stack + breadcrumbs + recentLogs ; si trop gros → PDF en pièce jointe.
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

  const to = alertRecipients();
  if (!to) return { sent: false, reason: 'no-recipients' };

  const fp = fingerprint(level, ev.kind, ev.message || '', ev.stack);
  const now = Date.now();
  const prev = lastSent.get(fp) || 0;
  const kind = String(ev.kind || '');
  const gap =
    kind.startsWith('android.') || kind.includes('player') || kind.includes('crash')
      ? THROTTLE_PLAYER_MS
      : THROTTLE_MS;
  if (now - prev < gap) {
    suppressed.set(fp, (suppressed.get(fp) || 0) + 1);
    return { sent: false, reason: 'throttled' };
  }
  lastSent.set(fp, now);
  const skipped = suppressed.get(fp) || 0;
  suppressed.delete(fp);
  // prune map
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) {
      if (now - t > THROTTLE_MS * 4) lastSent.delete(k);
    }
  }

  const env = ev.env || getAppEnv();
  const logs = extractLogs(ev.meta);
  const crumbs = extractBreadcrumbs(ev.meta);
  const metaLite = metaWithoutHeavy(ev.meta);
  const stack = (ev.stack || '').trim() || '(aucune stack Throwable — voir logs / breadcrumbs)';
  const diagnosis = diagnoseTelemetryEvent({
    kind: ev.kind,
    message: ev.message,
    stack: ev.stack,
    url: ev.url,
    userAgent: ev.userAgent,
    meta: ev.meta,
  });
  const diagText = formatDiagnosisText(diagnosis);
  const skipNote =
    skipped > 0
      ? `\n(${skipped} occurrence${skipped > 1 ? 's' : ''} identique${skipped > 1 ? 's' : ''} non envoyée${skipped > 1 ? 's' : ''} pendant le throttle)`
      : '';

  const fullDump = [
    `PLM telemetry alert`,
    `id=${ev.id}`,
    `env=${env} level=${level} kind=${ev.kind}`,
    `device=${ev.deviceId || '—'} user=${ev.userId || '—'}`,
    `url=${ev.url || '—'}`,
    `ua=${ev.userAgent || '—'}`,
    '',
    '=== PRÉ-DIAGNOSTIC ===',
    diagText + skipNote,
    '',
    '=== MESSAGE ===',
    ev.message || '(vide)',
    '',
    '=== STACK / DIAGNOSTIC ===',
    stack,
    '',
    '=== BREADCRUMBS ===',
    crumbs || '(aucun)',
    '',
    '=== RECENT LOGS ===',
    logs || '(aucun)',
    '',
    '=== META ===',
    metaLite || '(aucune)',
  ].join('\n');

  const heavy = fullDump.length > INLINE_MAX;
  const subject = `[PLM ${env}] ${level.toUpperCase()} · ${diagnosis.family} · ${ev.kind} · ${diagnosis.title.slice(0, 72)}`;

  const textSummary = [
    `PLM telemetry alert`,
    `id=${ev.id}`,
    `env=${env} level=${level} kind=${ev.kind}`,
    `device=${ev.deviceId || '—'} user=${ev.userId || '—'}`,
    `url=${ev.url || '—'}`,
    '',
    '--- pré-diagnostic ---',
    diagText + skipNote,
    '',
    '--- message ---',
    ev.message || '(vide)',
    '',
    '--- stack (extrait) ---',
    stack.slice(0, 4_000) + (stack.length > 4_000 ? '\n…[tronqué — voir PDF]' : ''),
    '',
    '--- breadcrumbs (extrait) ---',
    (crumbs || '(aucun)').slice(0, 2_000),
    '',
    '--- recent logs (extrait) ---',
    (logs || '(aucun)').slice(-3_000),
    '',
    heavy ? '→ Dump complet en pièce jointe PDF.' : '--- meta ---\n' + metaLite,
  ].join('\n');

  const html = `
<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;color:#111">
  <p><strong>PLM ${esc(env)}</strong> · ${esc(level)} · ${esc(ev.kind)}</p>
  <p>id=<code>${esc(ev.id)}</code><br/>
  device=<code>${esc(ev.deviceId || '—')}</code><br/>
  user=<code>${esc(ev.userId || '—')}</code><br/>
  url=<code>${esc(ev.url || '—')}</code></p>
  <h3>Pré-diagnostic</h3>
  <pre style="white-space:pre-wrap;background:#fef3c7;padding:12px;border-radius:8px;border:1px solid #f59e0b">${esc(diagText)}${esc(skipNote)}</pre>
  <h3>Message</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px">${esc(ev.message || '(vide)')}</pre>
  <h3>Stack / diagnostic</h3>
  <pre style="white-space:pre-wrap;background:#111;color:#fafafa;padding:12px;border-radius:8px;overflow:auto;max-height:420px">${esc(stack.slice(0, 8_000))}${stack.length > 8_000 ? esc('\n…[tronqué — PDF]') : ''}</pre>
  <h3>Breadcrumbs</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto;max-height:240px">${esc((crumbs || '(aucun)').slice(0, 4_000))}</pre>
  <h3>Recent logs</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto;max-height:320px">${esc((logs || '(aucun)').slice(-6_000))}</pre>
  <h3>Meta</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto;max-height:240px">${esc(metaLite.slice(0, 4_000))}</pre>
  ${heavy ? '<p><em>Dump complet joint en PDF.</em></p>' : ''}
</div>`.trim();

  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
  if (heavy || !ev.stack || logs.length > 2_000) {
    try {
      const pdf = buildTextPdf({
        title: `PLM ${env} · ${level} · ${ev.kind} · ${ev.id}`,
        sections: [
          { heading: 'Résumé', body: `message: ${ev.message || '(vide)'}\ndevice: ${ev.deviceId || '—'}\nuser: ${ev.userId || '—'}\nurl: ${ev.url || '—'}\nua: ${ev.userAgent || '—'}` },
          { heading: 'Pré-diagnostic', body: diagText + skipNote },
          { heading: 'Stack / diagnostic', body: stack },
          { heading: 'Breadcrumbs', body: crumbs || '(aucun)' },
          { heading: 'Recent logs', body: logs || '(aucun)' },
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
      `[telemetry-alert] sent to=${to} kind=${ev.kind} id=${ev.id} pdf=${attachments.some((a) => a.contentType === 'application/pdf')}`,
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
  const lines = events.slice(0, 20).map((e) => {
    const c = Number(e.count) > 1 ? ` ×${e.count}` : '';
    const extra = [e.trackId, e.http ? `http ${e.http}` : ''].filter(Boolean).join(' · ');
    return `• ${e.kind}${c} — ${(e.message || '').slice(0, 160)}${extra ? ` (${extra})` : ''}`;
  });
  const subject = `[PLM ${env}] ${n} erreur${n > 1 ? 's' : ''} cumulée${n > 1 ? 's' : ''} hors-ligne`;
  const text = [
    `Digest télémétrie (appareil hors-ligne puis reconnecté).`,
    `device=${opts.deviceId || '—'} user=${opts.userId || '—'}`,
    `ua=${opts.userAgent || '—'}`,
    '',
    ...lines,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
  <h2>${esc(subject)}</h2>
  <p>Événements tamponnés sur l’appareil, envoyés <strong>en un seul mail</strong> au retour réseau.</p>
  <p>device=${esc(opts.deviceId || '—')} · user=${esc(opts.userId || '—')}</p>
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
