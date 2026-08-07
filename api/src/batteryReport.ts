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
  const subject = `[PLM batterie] ${d.model || d.name || 'device'} · Δ${st.levelDelta ?? '?'}% · ${stamp}`;

  const rows: Array<[string, unknown]> = [
    ['Model', d.model],
    ['Nom', d.name],
    ['Serial', d.serial],
    ['Android', d.android],
    ['Transport', d.transport],
    ['App', a.versionName],
    ['Package', a.package],
    ['API', a.apiBase],
    ['Durée (s)', s.durationSec],
    ['Sample (s)', s.sampleSec],
    ['Débranché', s.unplugged],
    ['Level début→fin', `${st.levelStart} → ${st.levelEnd} (Δ ${st.levelDelta})`],
    ['Temp °C', `${st.tempStartC} → ${st.tempEndC}`],
    ['mAh Δ', st.mAhDelta],
    ['mAh/h', st.mAhPerHour],
    ['%/h', st.percentPerHour],
    ['Wi‑Fi Rx/Tx Mo', `${st.wifiRxMb} / ${st.wifiTxMb}`],
    ['Foreground (s)', st.foregroundSec],
    ['ExoPlayer wake (s)', st.exoWakeSec],
  ];

  const table = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:4px 8px;color:#888">${esc(k)}</td><td style="padding:4px 8px"><b>${esc(v)}</b></td></tr>`)
    .join('');

  const sampleBlocks = Object.entries(payload.samples || {})
    .slice(0, 8)
    .map(
      ([name, body]) =>
        `<h3>${esc(name)}</h3><pre style="background:#111;color:#ddd;padding:10px;overflow:auto;max-height:280px;font-size:11px">${esc(
          String(body).slice(0, 12_000),
        )}</pre>`,
    )
    .join('');

  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:720px">
    <h2>Rapport batterie PLM (optimisation)</h2>
    <p>${esc(payload.notes || 'Données device pour optimiser conso / radio / file.')}</p>
    <table style="border-collapse:collapse">${table}</table>
    ${sampleBlocks}
    <p style="color:#888;font-size:12px">Envoyé vers ${esc(to)} · pièce jointe zip si fournie (≤1.8 Mo).</p>
  </div>`;

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');

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
