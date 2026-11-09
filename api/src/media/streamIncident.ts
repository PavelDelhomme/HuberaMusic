/**
 * Consignation d'incident de lecture — Hubera Music.
 *
 * Quand l'auto-heal (`fastStart.healGlobally`) tourne, il faut une trace
 * exploitable, pas seulement une ligne de log :
 *  - une tâche **Hubera Docs** (colonne todo, catégorie bug) pour le suivi,
 *  - un **e-mail** récapitulatif (SMTP maison via `sendMail`, outbox si SMTP absent).
 *
 * Garde-fous :
 *  - déduplication par titre (pas 500 mails pour le même son cassé),
 *  - plafond global par fenêtre (anti-boucle de mails),
 *  - jamais de secret dans le corps (seulement id/titre/via/durée).
 */
import { sendMail, appUrl } from '../platform/mail.js';
import { docsTaskPayload, postDocsTask } from '../platform/docsTask.js';

/** Jeton de service Docs (allowlisté côté Hubera Docs) — jamais loggé. */
const DOCS_TOKEN =
  process.env.DOCS_SERVICE_TOKEN ||
  process.env.HUBERA_DOCS_TOKEN ||
  process.env.DOCS_API_TOKEN ||
  '';
const DOCS_ORIGIN = process.env.DOCS_API_URL || 'https://docs.hubera.cloud';

const DEDUP_MS = Math.max(
  5 * 60_000,
  Number(process.env.STREAM_INCIDENT_DEDUP_MS || 30 * 60_000) || 30 * 60_000,
);
const MAX_PER_HOUR = Math.max(1, Number(process.env.STREAM_INCIDENT_MAX_PER_HOUR || 12) || 12);
/** Destinataire ops — jamais un secret, juste une adresse de service. */
const OPS_EMAIL =
  process.env.STREAM_INCIDENT_EMAIL ||
  process.env.OPS_ALERT_EMAIL ||
  process.env.SMTP_REPLY_TO ||
  process.env.SMTP_USER ||
  '';

const lastByTrack = new Map<string, number>();
let hourBucket = { at: 0, n: 0 };
const stats = { docs: 0, mails: 0, skipped: 0, errors: 0 };

export type StreamIncident = {
  videoId: string;
  playId?: string;
  via?: string;
  reason: string;
  userId?: string;
  title?: string;
  artist?: string;
  healed: boolean;
  replacement?: string | null;
  ms?: number;
};

function deduped(videoId: string): boolean {
  const now = Date.now();
  const last = lastByTrack.get(videoId);
  if (last && now - last < DEDUP_MS) return true;
  lastByTrack.set(videoId, now);
  if (lastByTrack.size > 3_000) {
    const cutoff = now - DEDUP_MS * 2;
    for (const [k, t] of lastByTrack) {
      if (t < cutoff) lastByTrack.delete(k);
    }
  }
  return false;
}

function withinHourCap(): boolean {
  const now = Date.now();
  if (now - hourBucket.at > 3_600_000) hourBucket = { at: now, n: 0 };
  if (hourBucket.n >= MAX_PER_HOUR) return false;
  hourBucket.n += 1;
  return true;
}

function label(inc: StreamIncident): string {
  const t = String(inc.title || '').trim();
  const a = String(inc.artist || '').trim();
  if (t && a) return `${t} — ${a}`;
  if (t) return t;
  return inc.videoId;
}

/** Corps texte partagé Docs + mail (aucune donnée sensible). */
function bodyText(inc: StreamIncident): string {
  const lines = [
    `Titre : ${label(inc)}`,
    `videoId : ${inc.videoId}`,
    inc.playId && inc.playId !== inc.videoId ? `Servi depuis : ${inc.playId}` : null,
    inc.replacement ? `Remplacement canonique : ${inc.replacement}` : null,
    `Motif : ${inc.reason}`,
    `Réparé automatiquement : ${inc.healed ? 'oui' : 'non'}`,
    inc.via ? `Voie de réparation : ${inc.via}` : null,
    typeof inc.ms === 'number' ? `Durée de réparation : ${Math.round(inc.ms / 100) / 10} s` : null,
    inc.userId ? `Compte concerné : ${String(inc.userId).slice(0, 8)}…` : null,
    `Application : ${appUrl()}`,
    `Horodatage : ${new Date().toISOString()}`,
    '',
    'Généré par Hubera Music (fastStart → streamHeal). Le disque partagé a été',
    'mis à jour : le titre est réparé pour tous les comptes, pas seulement celui-ci.',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Consigne un incident. Non bloquant : `void` côté appelant.
 * Rend un résumé de ce qui a réellement été envoyé (utile aux tests).
 */
export async function recordStreamIncident(
  inc: StreamIncident,
): Promise<{ docs: boolean; mail: boolean; skipped: boolean; error?: string }> {
  if (deduped(inc.videoId)) {
    stats.skipped += 1;
    return { docs: false, mail: false, skipped: true };
  }
  if (!withinHourCap()) {
    stats.skipped += 1;
    return { docs: false, mail: false, skipped: true };
  }

  const body = bodyText(inc);
  const title = `Lecture Music KO — ${label(inc)}`.slice(0, 180);
  let docs = false;
  let mail = false;
  const errors: string[] = [];

  // 1) Hubera Docs (tâche bug dans le backlog vivant).
  if (!DOCS_TOKEN) {
    errors.push('docs: DOCS_SERVICE_TOKEN non configuré');
  } else {
    try {
      const payload = docsTaskPayload({
        title,
        body,
        project: 'music',
        priority: inc.healed ? 2 : 3,
      });
      const res = await postDocsTask(payload, {
        origin: DOCS_ORIGIN,
        accessToken: DOCS_TOKEN,
      });
      docs = Boolean(res?.ok);
      if (!docs && res?.error) errors.push(`docs: ${res.error}`);
      if (docs) stats.docs += 1;
    } catch (err) {
      errors.push(`docs: ${String((err as Error).message || err).slice(0, 120)}`);
    }
  }

  // 2) Mail ops.
  if (OPS_EMAIL) {
    try {
      const safeBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
        <h2 style="margin:0 0 4px">${inc.healed ? '✅ Réparé' : '⚠️ Non réparé'} — lecture Music</h2>
        <p style="color:#555;margin:0 0 16px">${title}</p>
        <pre style="background:#f6f6f6;padding:12px;border-radius:8px;white-space:pre-wrap">${safeBody}</pre>
        <p style="color:#666;font-size:12px">Hubera Music · auto-heal · aucune donnée sensible</p>
      </div>`;
      await sendMail({
        to: OPS_EMAIL,
        subject: `[Hubera Music] ${inc.healed ? 'Réparé' : 'KO'} — ${label(inc)}`,
        text: body,
        html,
      });
      mail = true;
      stats.mails += 1;
    } catch (err) {
      errors.push(`mail: ${String((err as Error).message || err).slice(0, 120)}`);
    }
  } else {
    errors.push('mail: OPS_EMAIL non configuré');
  }

  if (errors.length) stats.errors += 1;
  console.info(
    `[stream-incident] ${inc.videoId} healed=${inc.healed} docs=${docs} mail=${mail}${
      errors.length ? ` err=${errors.join(' | ')}` : ''
    }`,
  );
  return { docs, mail, skipped: false, error: errors.length ? errors.join(' | ') : undefined };
}

export function streamIncidentStats() {
  return {
    ...stats,
    opsEmail: OPS_EMAIL || null,
    dedupMs: DEDUP_MS,
    maxPerHour: MAX_PER_HOUR,
  };
}

/** Test/debug : permet de réarmer la déduplication (ex. script QA). */
export function resetStreamIncidentDedup(): void {
  lastByTrack.clear();
  hourBucket = { at: 0, n: 0 };
}
