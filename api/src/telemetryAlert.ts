import { sendMail, getAppEnv } from './mail.js';

const THROTTLE_MS = Number(process.env.TELEMETRY_ALERT_THROTTLE_MS || 5 * 60_000);
const lastSent = new Map<string, number>();

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
  const tip = (stack || message || '').split('\n').slice(0, 4).join('|').slice(0, 240);
  return `${level}|${kind}|${tip}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Email admin sur error/fatal (throttle par fingerprint).
 * Inclut stack + meta + extrait de logs si fourni dans meta.recentLogs.
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
}): Promise<{ sent: boolean; reason?: string }> {
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
  if (now - prev < THROTTLE_MS) {
    return { sent: false, reason: 'throttled' };
  }
  lastSent.set(fp, now);
  // prune map
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) {
      if (now - t > THROTTLE_MS * 4) lastSent.delete(k);
    }
  }

  const env = ev.env || getAppEnv();
  const metaStr =
    ev.meta == null
      ? ''
      : typeof ev.meta === 'string'
        ? ev.meta
        : (() => {
            try {
              return JSON.stringify(ev.meta, null, 2);
            } catch {
              return String(ev.meta);
            }
          })();

  const subject = `[PLM ${env}] ${level.toUpperCase()} · ${ev.kind} · ${(ev.message || 'erreur').slice(0, 80)}`;
  const text = [
    `PLM telemetry alert`,
    `id=${ev.id}`,
    `env=${env} level=${level} kind=${ev.kind}`,
    `device=${ev.deviceId || '—'} user=${ev.userId || '—'}`,
    `url=${ev.url || '—'}`,
    `ua=${ev.userAgent || '—'}`,
    '',
    `--- message ---`,
    ev.message || '(vide)',
    '',
    `--- stack ---`,
    ev.stack || '(aucune)',
    '',
    `--- meta ---`,
    metaStr || '(aucune)',
  ].join('\n');

  const html = `
<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.45;color:#111">
  <p><strong>PLM ${esc(env)}</strong> · ${esc(level)} · ${esc(ev.kind)}</p>
  <p>id=<code>${esc(ev.id)}</code><br/>
  device=<code>${esc(ev.deviceId || '—')}</code><br/>
  user=<code>${esc(ev.userId || '—')}</code><br/>
  url=<code>${esc(ev.url || '—')}</code></p>
  <h3>Message</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px">${esc(ev.message || '(vide)')}</pre>
  <h3>Stack</h3>
  <pre style="white-space:pre-wrap;background:#111;color:#fafafa;padding:12px;border-radius:8px;overflow:auto;max-height:480px">${esc(ev.stack || '(aucune)')}</pre>
  <h3>Meta / logs</h3>
  <pre style="white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto;max-height:640px">${esc(metaStr || '(aucune)')}</pre>
</div>`.trim();

  try {
    await sendMail({ to, subject, html, text });
    return { sent: true };
  } catch (err) {
    console.error('[telemetry-alert] mail failed', err);
    return { sent: false, reason: 'mail-failed' };
  }
}
