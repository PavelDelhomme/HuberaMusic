import { sendMail } from './mail.js';

const MAX_ZIP_BYTES = 1_800_000; // ~1.8 Mo — reste sous les limites MX courantes

export function batteryReportRecipients(): string {
  return (
    process.env.BATTERY_REPORT_TO ||
    process.env.SEED_EMAIL ||
    (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() ||
    'dev@delhomme.ovh'
  );
}

export type BatteryReportPayload = {
  device?: {
    model?: string;
    serial?: string;
    android?: string;
    name?: string;
    transport?: string;
  };
  app?: {
    versionName?: string;
    package?: string;
    apiBase?: string;
  };
  session?: {
    stamp?: string;
    durationSec?: number;
    sampleSec?: number;
    unplugged?: boolean;
  };
  stats?: {
    levelStart?: number;
    levelEnd?: number;
    levelDelta?: number;
    tempStartC?: number;
    tempEndC?: number;
    chargeCounterStart?: number;
    chargeCounterEnd?: number;
    mAhDelta?: number;
    mAhPerHour?: number;
    percentPerHour?: number;
    wifiRxMb?: number;
    wifiTxMb?: number;
    foregroundSec?: number;
    exoWakeSec?: number;
  };
  notes?: string;
  /** Logcat / CSV / REPORT tronqués (texte). */
  samples?: Record<string, string>;
  /** Zip base64 optionnel (battery.csv + logcat + REPORT). */
  zipBase64?: string;
  zipFilename?: string;
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendBatteryOptimizationMail(payload: BatteryReportPayload) {
  const to = batteryReportRecipients();
  const d = payload.device || {};
  const a = payload.app || {};
  const s = payload.session || {};
  const st = payload.stats || {};
  const stamp = s.stamp || new Date().toISOString();
  const subject = `[PLM batterie] ${d.model || d.name || 'device'} · ${st.levelDelta ?? '?'}% · ${stamp}`;

  const pctH = st.percentPerHour;
  const pctColor =
    typeof pctH === 'number' ? (pctH <= 5 ? '#6dffb0' : pctH <= 10 ? '#ffb86b' : '#ff7b72') : '#e8eaed';

  const kv = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return '';
    return `<tr>
      <td style="padding:6px 0;font-size:13px;color:#8b93a7;width:40%;vertical-align:top;">${esc(label)}</td>
      <td style="padding:6px 0;font-size:13px;color:#e8eaed;text-align:right;font-weight:600;vertical-align:top;word-break:break-word;">${esc(value)}</td>
    </tr>`;
  };

  const deviceRows = [
    kv('Model', d.model),
    kv('Nom', d.name),
    kv('Serial', d.serial),
    kv('Android', d.android),
    kv('Transport', d.transport),
    kv('App', a.versionName),
    kv('Package', a.package),
    kv('API', a.apiBase),
  ].join('');

  const sessionRows = [
    kv('Durée', s.durationSec != null ? `${s.durationSec}s` : undefined),
    kv('Sample', s.sampleSec != null ? `${s.sampleSec}s` : undefined),
    kv('Débranché', s.unplugged === true ? 'oui' : s.unplugged === false ? 'non' : undefined),
    kv(
      'Batterie',
      st.levelStart != null && st.levelEnd != null
        ? `${st.levelStart}% → ${st.levelEnd}% (${st.levelDelta ?? '?'}%)`
        : undefined,
    ),
    kv(
      'Temp',
      st.tempStartC != null && st.tempEndC != null
        ? `${st.tempStartC} → ${st.tempEndC} °C`
        : undefined,
    ),
    kv('mAh', st.mAhDelta),
    kv('mAh/h', st.mAhPerHour),
    kv('%/h', st.percentPerHour),
    kv(
      'Wi-Fi Rx/Tx',
      st.wifiRxMb != null || st.wifiTxMb != null
        ? `${st.wifiRxMb ?? '?'} / ${st.wifiTxMb ?? '?'} Mo`
        : undefined,
    ),
    kv('Foreground', st.foregroundSec != null ? `${st.foregroundSec}s` : undefined),
    kv('ExoPlayer wake', st.exoWakeSec != null ? `${st.exoWakeSec}s` : undefined),
  ].join('');

  const sampleBlocks = Object.entries(payload.samples || {})
    .slice(0, 6)
    .map(
      ([name, body]) => `
      <div style="margin:0 0 12px;padding:12px 14px;background:#161b24;border:1px solid #2a3140;border-radius:12px;">
        <div style="font-size:13px;font-weight:700;color:#fff;margin:0 0 8px;">${esc(name)}</div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#0b0d10;color:#c9d1e0;padding:10px;border-radius:8px;font-size:11px;line-height:1.4;max-height:220px;overflow:auto;">${esc(
          String(body).slice(0, 8_000),
        )}</pre>
      </div>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Rapport batterie PLM</title></head>
<body style="margin:0;padding:0;background:#0a0c10;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="max-width:420px;margin:0 auto;padding:20px 14px 32px;box-sizing:border-box;">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">PLM batterie</p>
    <h1 style="margin:0 0 6px;font-size:22px;color:#fff;font-weight:800;">${esc(d.model || d.name || 'Device')}</h1>
    <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;line-height:1.45;">${esc(payload.notes || 'Session optimisation conso.')}</p>

    <div style="margin:0 0 16px;padding:18px 16px;background:linear-gradient(160deg,#0d3d2a,#0f1f18);border:1px solid #1a5c40;border-radius:16px;text-align:center;">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6dffb0;font-weight:700;">%/h</div>
      <div style="font-size:40px;font-weight:800;color:${pctColor};line-height:1.1;">${esc(pctH ?? '—')}</div>
      <div style="margin-top:8px;font-size:13px;color:#a7f3d0;">${esc(
        st.levelStart != null ? `${st.levelStart}% → ${st.levelEnd}%` : 'niveau n/a',
      )}</div>
    </div>

    <div style="margin:0 0 12px;background:#161b24;border:1px solid #2a3140;border-radius:14px;overflow:hidden;">
      <div style="padding:10px 14px;border-bottom:1px solid #2a3140;font-size:13px;font-weight:700;color:#fff;">Session</div>
      <div style="padding:4px 14px 10px;">
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">${sessionRows}</table>
      </div>
    </div>

    <div style="margin:0 0 12px;background:#161b24;border:1px solid #2a3140;border-radius:14px;overflow:hidden;">
      <div style="padding:10px 14px;border-bottom:1px solid #2a3140;font-size:13px;font-weight:700;color:#fff;">Appareil</div>
      <div style="padding:4px 14px 10px;">
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">${deviceRows}</table>
      </div>
    </div>

    ${sampleBlocks}
    <p style="margin:16px 0 0;font-size:11px;color:#4b5563;text-align:center;">→ ${esc(to)} · zip si fourni</p>
  </div>
</body></html>`;

  const textLines = [
    `PLM batterie ${d.model || d.name || ''}`,
    payload.notes || '',
    `%/h: ${pctH ?? '—'}`,
    `Level: ${st.levelStart} → ${st.levelEnd} (${st.levelDelta})`,
    `mAh/h: ${st.mAhPerHour}`,
    `API: ${a.apiBase}`,
  ];
  const text = textLines.filter(Boolean).join('\n');

  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
  if (payload.zipBase64) {
    const buf = Buffer.from(payload.zipBase64, 'base64');
    if (buf.length > MAX_ZIP_BYTES) {
      throw new Error(`Zip trop gros (${buf.length} > ${MAX_ZIP_BYTES})`);
    }
    attachments.push({
      filename: payload.zipFilename || `plm-battery-${stamp}.zip`,
      content: buf,
      contentType: 'application/zip',
    });
  }

  return sendMail({ to, subject, html, text, attachments });
}
