import nodemailer from 'nodemailer';
import { markMailOutboxDelivered, saveMailOutbox } from './platform.js';

export function appUrl() {
  return (
    process.env.APP_URL ||
    process.env.WEBAUTHN_ORIGIN ||
    (process.env.NODE_ENV === 'production' ? 'https://ytmusic.delhomme.ovh' : 'http://localhost:5173')
  ).replace(/\/$/, '');
}

export function getAppEnv() {
  return process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'local');
}

/** Parse `Name <addr@host>` ou adresse seule → objet nodemailer. */
export function parseFromAddress(raw: string): { name: string; address: string } {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    let name = m[1].replace(/^["']|["']$/g, '').trim() || 'PLM';
    if (/ytmusic/i.test(name)) name = 'PLM';
    return { name, address: m[2].trim() };
  }
  if (s.includes('@')) {
    let name = 'PLM';
    const angle = s.match(/^(.+?)\s+<?([^>]+@[^>]+)>?$/);
    if (angle) {
      name = angle[1].trim().replace(/^["']|["']$/g, '') || 'PLM';
      if (/ytmusic/i.test(name)) name = 'PLM';
      return { name, address: angle[2].trim() };
    }
    return { name, address: s };
  }
  return {
    name: 'PLM',
    address: process.env.SMTP_USER || 'noreply@localhost',
  };
}

export function smtpPublicConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const useSsl = process.env.SMTP_USE_SSL === '1' || process.env.SMTP_USE_SSL === 'true';
  const secure =
    process.env.SMTP_SECURE === '1' ||
    process.env.SMTP_SECURE === 'true' ||
    useSsl ||
    port === 465;
  const fromRaw =
    process.env.SMTP_FROM ||
    (process.env.SMTP_USER ? `PLM <${process.env.SMTP_USER}>` : 'PLM <noreply@localhost>');
  const from = parseFromAddress(fromRaw.replace(/YTMusic/gi, 'PLM'));
  return {
    configured: Boolean(host),
    host: host || null,
    port,
    secure,
    user: process.env.SMTP_USER || null,
    from: `${from.name} <${from.address}>`,
    fromParsed: from,
    replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_USER || from.address,
    mode: host ? 'smtp' : 'outbox',
    domainHint: 'SMTP (configuré via .env)',
  };
}

let transporter: nodemailer.Transporter | null = null;

async function getTransporter() {
  if (transporter) return transporter;
  const cfg = smtpPublicConfig();
  if (!cfg.host) return null;

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
    tls: { minVersion: 'TLSv1.2' },
    // Ne pas laisser le serveur réécrire silencieusement sans qu’on le voie
    name: undefined,
  });
  return transporter;
}

/** Reset le transporteur après changement d’env (admin / tests). */
export function resetMailTransporter() {
  transporter = null;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}) {
  const cfg = smtpPublicConfig();
  const from = cfg.fromParsed;
  const id = saveMailOutbox(opts.to, opts.subject, opts.html);
  const tx = await getTransporter();
  if (!tx) {
    console.log(
      `\n[mail:${getAppEnv()}] from=${cfg.from} → ${opts.to}\nSubject: ${opts.subject}\n${opts.text || opts.html}\nattachments=${opts.attachments?.length || 0}\n(outbox id=${id})\n`,
    );
    return { ok: true, mode: 'outbox' as const, id, from: cfg.from };
  }

  // From structuré : nom affiché « PLM » (pas le display name OVH JobbingTrack)
  const info = await tx.sendMail({
    from: { name: from.name, address: from.address },
    sender: from.address,
    to: opts.to,
    replyTo: cfg.replyTo || from.address,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
    headers: {
      'X-Mailer': 'PLM',
      'X-PLM-Env': getAppEnv(),
    },
  });

  markMailOutboxDelivered(id);
  console.log(
    `[mail:${getAppEnv()}] sent id=${info.messageId} from="${from.name}" <${from.address}> → ${opts.to} atts=${opts.attachments?.length || 0}`,
  );
  return {
    ok: true,
    mode: 'smtp' as const,
    id,
    from: cfg.from,
    messageId: info.messageId,
    response: info.response,
  };
}

export async function sendVerificationEmail(email: string, name: string, rawToken: string) {
  const link = `${appUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const apiHint =
    getAppEnv() === 'local'
      ? `\n(Sur Android USB : adb reverse tcp:8787 tcp:8787 — le lien ouvre l’API locale.)\n`
      : '\n';
  return sendMail({
    to: email,
    subject: 'Confirme ton adresse — PLM',
    text: `Salut ${name},\n\nConfirme ton email : ${link}${apiHint}\nLien valable 48h.\n\n— PLM`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#111">Bienvenue sur PLM</h2>
        <p>Salut <strong>${name}</strong>, confirme ton adresse email :</p>
        <p><a href="${link}" style="display:inline-block;background:#ff0033;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">Valider mon email</a></p>
        <p style="color:#666;font-size:12px">Ou copie ce lien :<br>${link}</p>
        ${
          getAppEnv() === 'local'
            ? '<p style="color:#666;font-size:12px">Local + téléphone : <code>adb reverse tcp:8787 tcp:8787</code> puis ouvre le lien.</p>'
            : ''
        }
        <p style="color:#666;font-size:12px">Envoyé par <strong>PLM</strong> via ${cfgDomain()} · ${getAppEnv()}</p>
      </div>`,
  });
}

function cfgDomain() {
  return process.env.SMTP_USER?.split('@')[1] || 'localhost';
}

/** Smoke SMTP — verify() + mail de test optionnel. */
export async function testSmtp(to?: string) {
  resetMailTransporter();
  const cfg = smtpPublicConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      mode: 'outbox' as const,
      error: 'SMTP_HOST non configuré — mails en outbox admin uniquement',
      config: cfg,
    };
  }
  try {
    const tx = await getTransporter();
    if (!tx) throw new Error('Transporteur indisponible');
    await tx.verify();
    let sent: Awaited<ReturnType<typeof sendMail>> | undefined;
    if (to) {
      sent = await sendMail({
        to,
        subject: `[PLM] Test SMTP · ${getAppEnv()} · ${new Date().toISOString()}`,
        text: `Test PLM OK.\nFrom configuré : ${cfg.from}\nHost : ${cfg.host}:${cfg.port}\nSi le nom d’affichage est faux, vide le cache du client mail.`,
        html: `<div style="font-family:system-ui,sans-serif">
          <p><strong>Test PLM OK</strong></p>
          <p>From configuré : <code>${cfg.from}</code></p>
          <p>Host : ${cfg.host}:${cfg.port} (${getAppEnv()})</p>
          <p style="color:#666;font-size:12px">Si le nom d’affichage est incorrect, c’est souvent le cache du client mail / le display name côté fournisseur SMTP — pas SMTP_FROM.</p>
        </div>`,
      });
    }
    return { ok: true, mode: 'smtp' as const, config: cfg, sent };
  } catch (err) {
    resetMailTransporter();
    return {
      ok: false,
      mode: 'smtp' as const,
      error: String((err as Error).message || err),
      config: cfg,
    };
  }
}
