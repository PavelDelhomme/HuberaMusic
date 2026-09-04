/**
 * Rapport d'incident : tout ce qu'on sait d'une salve d'erreurs, en un document.
 *
 * Les mails d'alerte tenaient jusqu'ici sur quelques lignes tronquées — « ×3 »,
 * un message coupé à 120 caractères, aucun contexte serveur. Impossible de
 * comprendre ce qui s'était passé sans se connecter à la machine.
 *
 * Ce module reprend chaque erreur telle qu'elle a été enregistrée, sans
 * troncature, et lui adjoint l'histoire du titre concerné vue du serveur :
 * état de santé, remplacement éventuel, présence en cache, requêtes de flux
 * servies autour de l'incident, écoutes. Le tout part en pièce jointe.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { db, getTrackPayload } from '../library/db.js';
import { recentStreamEvents, streamSummary } from '../media/streamLog.js';
import { diagnoseTelemetryEvent, formatDiagnosisText } from './telemetryDiagnose.js';
import {
  extractTrackIds,
  tidyBreadcrumbs,
  tidyRecentLogs,
  tidyStack,
} from './telemetryTracks.js';
import { appUrl } from './mail.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'cache');

/** Enveloppe consacrée aux journaux applicatifs, répartie entre les erreurs. */
const BUDGET_LOGS_TOTAL = Number(process.env.INCIDENT_REPORT_LOG_BUDGET || 1_200_000);
/** Un titre n'est documenté qu'une fois, même s'il revient dans mille erreurs. */
const MAX_TRACKS_DOC = Number(process.env.INCIDENT_REPORT_MAX_TRACKS || 400);

export type TelemetryRow = {
  id: string;
  created_at: number;
  env?: string | null;
  level: string;
  kind: string;
  message?: string | null;
  stack?: string | null;
  url?: string | null;
  user_agent?: string | null;
  user_id?: string | null;
  device_id?: string | null;
  meta?: string | null;
  battery_level?: number | null;
  battery_charging?: number | null;
};

function horodate(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function duree(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function taille(octets?: number | null): string {
  if (!octets) return '—';
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

function parseMeta(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function trait(char = '─', n = 78): string {
  return char.repeat(n);
}

function titre(niveau: 1 | 2 | 3, texte: string): string {
  if (niveau === 1) return `\n${trait('═')}\n${texte.toUpperCase()}\n${trait('═')}`;
  if (niveau === 2) return `\n${trait()}\n${texte}\n${trait()}`;
  return `\n── ${texte} ──`;
}

/** Étiquette lisible d'un titre, depuis le cache de métadonnées. */
function libelle(trackId: string): { title: string; artist: string; durationSeconds?: number } {
  const t = getTrackPayload(trackId);
  const artist = (t?.artists || [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ');
  return { title: t?.title || '(titre inconnu du cache)', artist, durationSeconds: t?.durationSeconds ?? undefined };
}

function ligneRequete(r: ReturnType<typeof recentStreamEvents>[number]): string {
  const bits = [
    horodate(r.at),
    r.status ? `HTTP ${r.status}` : 'sans statut',
    r.source || 'origine inconnue',
    r.ms != null ? duree(r.ms) : '—',
    r.bytes ? taille(r.bytes) : '—',
    r.range ? `plage ${r.range}` : 'sans plage',
    r.client || '—',
  ];
  return `  · ${bits.join('  ·  ')}${r.note ? `\n      ${r.note}` : ''}`;
}

/**
 * Ce que le serveur sait d'un titre : c'est la moitié manquante des rapports
 * précédents, qui ne racontaient que le point de vue du téléphone.
 */
function historiqueTitre(trackId: string, autour?: number, maxRequetes = 60): string {
  const meta = libelle(trackId);
  const lignes: string[] = [];
  lignes.push(titre(2, `TITRE ${trackId} — ${meta.title}${meta.artist ? ` — ${meta.artist}` : ''}`));
  if (meta.durationSeconds) {
    lignes.push(`Durée connue : ${Math.floor(meta.durationSeconds / 60)} min ${meta.durationSeconds % 60} s`);
  }
  lignes.push(`Écoute PLM   : ${appUrl()}/watch/${trackId}`);
  lignes.push(`YouTube      : https://music.youtube.com/watch?v=${trackId}`);
  lignes.push(`Flux serveur : ${appUrl()}/api/stream/${trackId}`);

  // État de santé issu du balayage de bibliothèque.
  try {
    const h = db
      .prepare('SELECT state, checked_at FROM track_health WHERE track_id = ?')
      .get(trackId) as { state: string; checked_at: number } | undefined;
    lignes.push(
      h
        ? `\nSanté : « ${h.state} », vérifiée le ${horodate(h.checked_at)}.`
        : '\nSanté : jamais vérifiée par le balayage.',
    );
  } catch {
    /* table absente */
  }

  // Remplacement d'identifiant, dans un sens comme dans l'autre.
  try {
    const repl = db
      .prepare('SELECT replacement_id, score, source, updated_at FROM track_id_replacements WHERE dead_id = ?')
      .get(trackId) as { replacement_id: string; score: number; source: string; updated_at: number } | undefined;
    if (repl) {
      const r = libelle(repl.replacement_id);
      lignes.push(
        `Remplacement : cet identifiant est mort, servi via ${repl.replacement_id} ` +
          `(« ${r.title} », score ${repl.score}, ${repl.source}, depuis le ${horodate(repl.updated_at)}).`,
      );
    }
    const inverse = db
      .prepare('SELECT dead_id, score, updated_at FROM track_id_replacements WHERE replacement_id = ?')
      .all(trackId) as { dead_id: string; score: number; updated_at: number }[];
    for (const i of inverse) {
      lignes.push(
        `Remplace : sert de substitut à ${i.dead_id} (score ${i.score}, depuis le ${horodate(i.updated_at)}).`,
      );
    }
  } catch {
    /* table absente */
  }

  // Présence en cache disque : dit si le serveur pouvait répondre sans réseau.
  try {
    const file = join(CACHE_DIR, `${trackId}.m4a`);
    if (existsSync(file)) {
      const st = statSync(file);
      lignes.push(`Cache disque : présent, ${taille(st.size)}, écrit le ${horodate(st.mtimeMs)}.`);
    } else {
      lignes.push('Cache disque : absent — chaque lecture repassait par YouTube.');
    }
  } catch {
    /* chemin indisponible */
  }

  // Téléchargements hors-ligne demandés par les comptes.
  try {
    const dl = db
      .prepare('SELECT user_id, status FROM downloads WHERE track_id = ?')
      .all(trackId) as { user_id: string; status: string }[];
    if (dl.length) {
      const parStatut = dl.reduce<Record<string, number>>((acc, d) => {
        acc[d.status] = (acc[d.status] || 0) + 1;
        return acc;
      }, {});
      lignes.push(
        `Hors-ligne : ${Object.entries(parStatut)
          .map(([s, n]) => `${n} × ${s}`)
          .join(', ')}.`,
      );
    }
  } catch {
    /* table absente */
  }

  // Requêtes de flux réellement servies — le cœur du « côté serveur ».
  const resume = streamSummary(trackId);
  const req = recentStreamEvents(trackId, maxRequetes);
  lignes.push(titre(3, 'Requêtes de flux servies par le serveur'));
  if (!req.length) {
    lignes.push(
      '  (aucune trace — soit le journal est plus récent que l’incident,\n' +
        '   soit le lecteur n’a jamais atteint le serveur)',
    );
  } else {
    lignes.push(
      `  ${resume.total} requête${resume.total > 1 ? 's' : ''} conservée${resume.total > 1 ? 's' : ''}, ` +
        `dont ${resume.failed} en erreur, du ${horodate(resume.firstAt)} au ${horodate(resume.lastAt)}.`,
    );
    if (autour) {
      const proches = req.filter((r) => Math.abs(r.at - autour) < 300_000);
      if (proches.length) {
        lignes.push(`\n  Dans les cinq minutes autour de l’erreur :`);
        for (const r of proches) lignes.push(ligneRequete(r));
      }
    }
    lignes.push(`\n  Historique récent (${req.length} dernières) :`);
    for (const r of req) lignes.push(ligneRequete(r));
  }

  // Écoutes : distingue un titre jamais lancé d'un titre systématiquement sauté.
  try {
    const ecoutes = db
      .prepare(
        `SELECT event, progress_pct, created_at FROM listen_events
          WHERE track_id = ? ORDER BY created_at DESC LIMIT 12`,
      )
      .all(trackId) as { event: string; progress_pct: number; created_at: number }[];
    if (ecoutes.length) {
      lignes.push(titre(3, 'Écoutes récentes'));
      for (const e of ecoutes) {
        lignes.push(`  · ${horodate(e.created_at)}  ${e.event}  ${Math.round(e.progress_pct || 0)} %`);
      }
    }
  } catch {
    /* table absente */
  }

  // Récidives pour ce titre précis. Le journal applicatif embarqué dans `meta`
  // cite des dizaines d'autres identifiants : chercher l'identifiant n'importe
  // où ramènerait les erreurs des morceaux voisins.
  try {
    const autres = db
      .prepare(
        `SELECT created_at, level, kind, message, device_id FROM telemetry_events
          WHERE level IN ('error','fatal')
            AND (message LIKE ? OR meta LIKE ?)
          ORDER BY created_at DESC LIMIT 15`,
      )
      .all(`%${trackId}%`, `%"trackId":"${trackId}"%`) as {
      created_at: number;
      level: string;
      kind: string;
      message: string;
      device_id: string;
    }[];
    if (autres.length) {
      lignes.push(titre(3, 'Erreurs déjà remontées pour ce titre'));
      for (const a of autres) {
        lignes.push(
          `  · ${horodate(a.created_at)}  ${a.level}/${a.kind}  ${String(a.message || '')
            .split('\n')[0]
            .slice(0, 150)}`,
        );
      }
    }
  } catch {
    /* ignore */
  }

  return lignes.join('\n');
}

/**
 * Détail d'une erreur. Le journal applicatif est la seule partie qu'on rogne,
 * et seulement quand la salve est massive : mieux vaut mille erreurs avec un
 * extrait de journal qu'un document de cent mégaoctets qu'aucun serveur mail
 * n'acceptera.
 */
function detailErreur(ev: TelemetryRow, index: number, total: number, budgetLogs: number): string {
  const meta = parseMeta(ev.meta);
  const logsRaw = typeof meta.recentLogs === 'string' ? meta.recentLogs : '';
  const crumbsRaw = Array.isArray(meta.breadcrumbs)
    ? meta.breadcrumbs.map(String).join('\n')
    : typeof meta.breadcrumbs === 'string'
      ? meta.breadcrumbs
      : '';
  const metaLite = { ...meta };
  delete metaLite.recentLogs;
  delete metaLite.breadcrumbs;

  const diag = diagnoseTelemetryEvent({
    kind: ev.kind,
    message: ev.message || undefined,
    stack: ev.stack || undefined,
    url: ev.url || undefined,
    userAgent: ev.user_agent || undefined,
    meta,
  });

  const nOcc = Number(meta.count) > 1 ? Number(meta.count) : 1;
  const lignes: string[] = [];
  lignes.push(titre(2, `ERREUR ${index}/${total} — ${ev.kind} — ${horodate(ev.created_at)}`));
  lignes.push(`Identifiant : ${ev.id}`);
  lignes.push(`Niveau      : ${ev.level}`);
  if (nOcc > 1) {
    // Les bornes viennent de deux horloges (appareil / serveur) : on les remet
    // dans l'ordre plutôt que d'afficher un intervalle à l'envers.
    const brut = [Number(meta.firstTs) || 0, ev.created_at].filter(Boolean).sort((a, b) => a - b);
    lignes.push(
      `Occurrences : ${nOcc} fois à l’identique` +
        (brut.length === 2 ? `, de ${horodate(brut[0])} à ${horodate(brut[1])}` : ''),
    );
  }
  const times = Array.isArray(meta.times)
    ? (meta.times as number[]).filter(Boolean).sort((a, b) => a - b)
    : [];
  if (times.length > 1) {
    lignes.push(
      `Chronologie : ${times.map((t) => horodate(t)).join('  ·  ')}` +
        (times.length < nOcc ? `  … (${nOcc - times.length} autres non horodatées)` : ''),
    );
  }
  if (meta.title) {
    lignes.push(`Morceau     : ${meta.title}${meta.artist ? ` — ${meta.artist}` : ''}`);
  }
  if (meta.positionMs != null && meta.durationMs != null) {
    const pos = Math.round(Number(meta.positionMs) / 1_000);
    const dur = Math.round(Number(meta.durationMs) / 1_000);
    lignes.push(
      `Où          : à ${pos} s sur ${dur} s` +
        (dur > 0 ? ` (${Math.round((pos / dur) * 100)} % du morceau)` : ''),
    );
  }
  if (meta.streak != null) lignes.push(`Échecs liés : ${meta.streak} d’affilée`);
  if (meta.diagnosis) lignes.push(`Vu du téléphone : ${meta.diagnosis}`);
  lignes.push(`Appareil    : ${ev.device_id || '—'}`);
  lignes.push(`Compte      : ${ev.user_id || '— (invité ou non connecté)'}`);
  if (meta.appVersion) lignes.push(`Version app : ${meta.appVersion}`);
  if (meta.model || meta.manufacturer) {
    lignes.push(`Matériel    : ${[meta.manufacturer, meta.model].filter(Boolean).join(' ')}${meta.sdk ? ` · Android SDK ${meta.sdk}` : ''}`);
  }
  if (ev.battery_level != null) {
    lignes.push(
      `Batterie    : ${Math.round((ev.battery_level || 0) * 100)} %${ev.battery_charging ? ' (en charge)' : ''}`,
    );
  }
  if (ev.url) lignes.push(`URL         : ${ev.url}`);
  if (ev.user_agent) lignes.push(`Client      : ${ev.user_agent}`);

  lignes.push(titre(3, 'Ce que le serveur en déduit'));
  lignes.push(formatDiagnosisText(diag));

  lignes.push(titre(3, 'Message complet'));
  lignes.push(ev.message || '(vide)');

  lignes.push(titre(3, 'Pile d’appels'));
  lignes.push(ev.stack ? tidyStack(ev.stack, 40) : '(aucune — erreur signalée sans exception)');

  lignes.push(titre(3, 'Fil des actions avant l’erreur'));
  lignes.push(crumbsRaw ? tidyBreadcrumbs(crumbsRaw, 80) : '(aucun)');

  lignes.push(titre(3, 'Journal de l’application'));
  lignes.push(logsRaw ? tidyRecentLogs(logsRaw, budgetLogs) : '(aucun)');

  lignes.push(titre(3, 'Contexte technique brut'));
  try {
    lignes.push(JSON.stringify(metaLite, null, 2));
  } catch {
    lignes.push(String(ev.meta));
  }

  return lignes.join('\n');
}

export type IncidentReport = {
  filename: string;
  text: string;
  html: string;
  errorCount: number;
  occurrenceCount: number;
  trackCount: number;
};

function idsDuneErreur(ev: TelemetryRow): string[] {
  const meta = parseMeta(ev.meta);
  const depuisMeta = [meta.trackId, meta.id].filter(
    (v): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(v),
  );
  const logs = typeof meta.recentLogs === 'string' ? meta.recentLogs : '';
  const crumbs = Array.isArray(meta.breadcrumbs) ? meta.breadcrumbs.map(String).join('\n') : '';
  const vus = new Set<string>();
  const out: string[] = [];
  for (const id of [...depuisMeta, ...extractTrackIds(ev.message, crumbs, logs)]) {
    if (!vus.has(id)) {
      vus.add(id);
      out.push(id);
    }
  }
  return out;
}

function occurrencesDe(ev: TelemetryRow): number {
  return Number(parseMeta(ev.meta).count) || 1;
}

/**
 * Construit le document joint aux mails d'alerte.
 *
 * Organisation voulue : comprendre un titre, pas une pile d'exceptions.
 * Chaque titre a son chapitre — ce que le téléphone a vu, ce que le serveur
 * a servi — puis les erreurs sans titre identifié. Aucune erreur n'est
 * escamotée : une salve de 1973 occurrences identiques apparaît comme 1973,
 * avec la chronologie et le détail unique, pas comme une ligne « ×1973 ».
 */
export function buildIncidentReport(opts: {
  titre: string;
  env: string;
  events: TelemetryRow[];
  deviceId?: string;
  userId?: string;
  userAgent?: string;
  /** Occurrences écrasées par le throttle, à signaler dans l'en-tête. */
  supprimees?: number;
}): IncidentReport {
  const events = [...opts.events].sort((a, b) => a.created_at - b.created_at);
  const now = Date.now();
  const parts: string[] = [];

  const trackIds: string[] = [];
  const vus = new Set<string>();
  const parTitre = new Map<string, TelemetryRow[]>();
  const sansTitre: TelemetryRow[] = [];
  for (const ev of events) {
    const ids = idsDuneErreur(ev);
    for (const id of ids) {
      if (!vus.has(id)) {
        vus.add(id);
        trackIds.push(id);
      }
    }
    const principal = ids[0];
    if (principal) {
      const liste = parTitre.get(principal) || [];
      liste.push(ev);
      parTitre.set(principal, liste);
    } else {
      sansTitre.push(ev);
    }
  }

  const occurrences = events.reduce((n, e) => n + occurrencesDe(e), 0);
  const debut = events.length ? Math.min(...events.map((e) => e.created_at)) : now;
  const fin = events.length ? Math.max(...events.map((e) => e.created_at)) : now;

  const enTete = [
    'RAPPORT D’INCIDENT — PLM',
    trait('═'),
    opts.titre,
    '',
    `Établi le          : ${horodate(now)}`,
    `Environnement      : ${opts.env}`,
    `Appareil           : ${opts.deviceId || '—'}`,
    `Compte             : ${opts.userId || '— (invité ou non connecté)'}`,
    `Client             : ${opts.userAgent || '—'}`,
    '',
    `Erreurs distinctes : ${events.length}`,
    `Occurrences réelles: ${occurrences}${
      occurrences > events.length
        ? ` (l’appareil a regroupé les répétitions identiques — le détail de chaque groupe est plus bas)`
        : ''
    }`,
    opts.supprimees
      ? `Non détaillées     : ${opts.supprimees} occurrence(s) identiques écartées par l’anti-rafale du mail, présentes en base`
      : '',
    `Période couverte   : du ${horodate(debut)} au ${horodate(fin)}${fin > debut ? ` (${duree(fin - debut)})` : ''}`,
    `Titres concernés   : ${trackIds.length}`,
  ]
    .filter(Boolean)
    .join('\n');
  parts.push(enTete);

  const parKind = new Map<string, number>();
  for (const e of events) {
    parKind.set(e.kind, (parKind.get(e.kind) || 0) + occurrencesDe(e));
  }
  parts.push(titre(1, 'Synthèse'));
  parts.push('Par type d’erreur :');
  for (const [k, n] of [...parKind.entries()].sort((a, b) => b[1] - a[1])) {
    parts.push(`  · ${k} — ${n} occurrence${n > 1 ? 's' : ''}`);
  }
  if (trackIds.length) {
    parts.push('\nPar titre (c’est l’entrée principale du document) :');
    for (const id of trackIds) {
      const m = libelle(id);
      const errs = parTitre.get(id) || [];
      const occ = errs.reduce((n, e) => n + occurrencesDe(e), 0);
      parts.push(
        `  · ${m.title}${m.artist ? ` — ${m.artist}` : ''}  (${id})  — ${occ} occurrence${
          occ > 1 ? 's' : ''
        } / ${errs.length} erreur${errs.length > 1 ? 's' : ''} distincte${errs.length > 1 ? 's' : ''}`,
      );
    }
  }

  const budgetLogs = Math.min(
    40_000,
    Math.max(1_200, Math.floor(BUDGET_LOGS_TOTAL / Math.max(1, events.length))),
  );
  if (budgetLogs < 40_000) {
    parts.push(
      `\n(salve importante : le journal applicatif de chaque erreur est ramené à ` +
        `${Math.round(budgetLogs / 1_000)} k caractères — tout le reste est intégral)`,
    );
  }

  const documentes = trackIds.slice(0, MAX_TRACKS_DOC);
  const requetesParTitre = Math.max(12, Math.floor(800 / Math.max(1, documentes.length)));
  let indexErreur = 0;

  if (documentes.length) {
    parts.push(titre(1, `Détail titre par titre (${documentes.length})`));
    if (trackIds.length > documentes.length) {
      parts.push(
        `(${documentes.length} titres documentés sur ${trackIds.length} : les suivants tiennent dans la synthèse)`,
      );
    }
    for (const id of documentes) {
      const errs = parTitre.get(id) || [];
      parts.push(historiqueTitre(id, fin, requetesParTitre));
      parts.push(titre(3, `Erreurs de ce titre (${errs.length} distincte${errs.length > 1 ? 's' : ''})`));
      if (!errs.length) {
        parts.push('  (aucune erreur rattachée — le titre apparaît seulement dans un journal voisin)');
        continue;
      }
      for (const ev of errs) {
        indexErreur += 1;
        parts.push(detailErreur(ev, indexErreur, events.length, budgetLogs));
      }
    }
  }

  if (sansTitre.length) {
    parts.push(titre(1, `Erreurs sans titre identifié (${sansTitre.length})`));
    for (const ev of sansTitre) {
      indexErreur += 1;
      parts.push(detailErreur(ev, indexErreur, events.length, budgetLogs));
    }
  }

  parts.push(
    [
      titre(1, 'Fin du rapport'),
      `Ce document reprend les ${events.length} erreur${events.length > 1 ? 's' : ''} distincte${
        events.length > 1 ? 's' : ''
      } (${occurrences} occurrence${occurrences > 1 ? 's' : ''} au total),`,
      'sans en retirer une seule, avec ce que le serveur a fait pour chaque titre',
      'au même moment. Les requêtes de flux sont conservées quatre jours.',
    ].join('\n'),
  );

  const text = parts.join('\n');
  const horoFichier = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    filename: `plm-incident-${horoFichier}`,
    text,
    html: htmlDuRapport({
      titre: opts.titre,
      env: opts.env,
      deviceId: opts.deviceId,
      userId: opts.userId,
      userAgent: opts.userAgent,
      events,
      trackIds: documentes,
      parTitre,
      sansTitre,
      occurrences,
      parKind,
      debut,
      fin,
      now,
    }),
    errorCount: events.length,
    occurrenceCount: occurrences,
    trackCount: trackIds.length,
  };
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pre(s: string): string {
  return `<pre>${escHtml(s)}</pre>`;
}

function htmlDuRapport(opts: {
  titre: string;
  env: string;
  deviceId?: string;
  userId?: string;
  userAgent?: string;
  events: TelemetryRow[];
  trackIds: string[];
  parTitre: Map<string, TelemetryRow[]>;
  sansTitre: TelemetryRow[];
  occurrences: number;
  parKind: Map<string, number>;
  debut: number;
  fin: number;
  now: number;
}): string {
  const cards = [...opts.parKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li><strong>${escHtml(k)}</strong> — ${n} occurrence${n > 1 ? 's' : ''}</li>`)
    .join('');

  const sommaire = opts.trackIds
    .map((id) => {
      const m = libelle(id);
      const errs = opts.parTitre.get(id) || [];
      const occ = errs.reduce((n, e) => n + occurrencesDe(e), 0);
      return `<li><a href="#t-${escHtml(id)}">${escHtml(m.title)}${
        m.artist ? ` — ${escHtml(m.artist)}` : ''
      }</a> <span class="muted">(${occ} occ. · ${escHtml(id)})</span></li>`;
    })
    .join('');

  const chapitres = opts.trackIds
    .map((id) => {
      const m = libelle(id);
      const errs = opts.parTitre.get(id) || [];
      const serveur = historiqueTitre(id, opts.fin, 40);
      const details = errs
        .map(
          (ev, i) =>
            `<article class="err"><h3>Erreur ${i + 1}/${errs.length} · ${escHtml(ev.kind)} · ${escHtml(
              horodate(ev.created_at),
            )}</h3>${pre(detailErreur(ev, i + 1, errs.length, 8_000))}</article>`,
        )
        .join('\n');
      return `<section id="t-${escHtml(id)}" class="track">
  <h2>${escHtml(m.title)}${m.artist ? ` <span class="muted">— ${escHtml(m.artist)}</span>` : ''}</h2>
  <p class="muted">${escHtml(id)} · ${errs.length} erreur${errs.length > 1 ? 's' : ''} distincte${
    errs.length > 1 ? 's' : ''
  }</p>
  ${pre(serveur)}
  ${details}
</section>`;
    })
    .join('\n');

  const orphelines = opts.sansTitre.length
    ? `<section class="track"><h2>Erreurs sans titre identifié</h2>${opts.sansTitre
        .map((ev, i) => `<article class="err">${pre(detailErreur(ev, i + 1, opts.sansTitre.length, 8_000))}</article>`)
        .join('\n')}</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>${escHtml(opts.titre)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.55; color: #111; max-width: 880px; margin: 32px auto; padding: 0 20px 64px; }
  h1 { font-size: 1.45rem; margin: 0 0 4px; }
  h2 { font-size: 1.2rem; margin: 36px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  h3 { font-size: 1rem; margin: 22px 0 6px; }
  .muted { color: #666; }
  .meta { background: #f4f4f5; border-radius: 10px; padding: 14px 16px; }
  .meta p { margin: 0 0 4px; }
  ul { margin: 8px 0 0; padding-left: 20px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #fafafa; padding: 14px 16px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; overflow-x: auto; }
  .track { margin-top: 28px; }
  .err { margin: 16px 0 28px; }
  a { color: #b91c1c; }
</style>
</head>
<body>
  <h1>Rapport d’incident — PLM</h1>
  <p class="muted">${escHtml(opts.titre)}</p>
  <div class="meta">
    <p><strong>Établi le</strong> ${escHtml(horodate(opts.now))} · <strong>${escHtml(opts.env)}</strong></p>
    <p>Appareil <code>${escHtml(opts.deviceId || '—')}</code> · compte <code>${escHtml(opts.userId || '—')}</code></p>
    <p>${opts.events.length} erreur${opts.events.length > 1 ? 's' : ''} distincte${
    opts.events.length > 1 ? 's' : ''
  } · <strong>${opts.occurrences} occurrence${opts.occurrences > 1 ? 's' : ''}</strong> · ${
    opts.trackIds.length
  } titre${opts.trackIds.length > 1 ? 's' : ''} · du ${escHtml(horodate(opts.debut))} au ${escHtml(
    horodate(opts.fin),
  )}</p>
    <p class="muted">${escHtml(opts.userAgent || '')}</p>
  </div>
  <h2>Synthèse</h2>
  <ul>${cards}</ul>
  ${sommaire ? `<h2>Titres</h2><ul>${sommaire}</ul>` : ''}
  ${chapitres}
  ${orphelines}
  <p class="muted">Document généré automatiquement. Chaque erreur enregistrée y figure, avec l’historique serveur du titre.</p>
</body>
</html>`;
}

type PieceJointe = {
  filename: string;
  content: Buffer;
  contentType: string;
};

function piece(nom: string, brut: Buffer, type: string): PieceJointe {
  if (brut.length <= 1024 * 1024) {
    return { filename: nom, content: brut, contentType: type };
  }
  return {
    filename: `${nom}.gz`,
    content: gzipSync(brut, { level: 9 }),
    contentType: 'application/gzip',
  };
}

/**
 * Document principal (HTML, lisible dans le navigateur) + copie texte.
 * Au-delà d'un mégaoctet chaque fichier part compressé : les serveurs de
 * messagerie refusent les grosses pièces, et un `.gz` s'ouvre partout.
 */
export function reportAttachments(report: IncidentReport): PieceJointe[] {
  return [
    piece(`${report.filename}.html`, Buffer.from(report.html, 'utf8'), 'text/html; charset=utf-8'),
    piece(`${report.filename}.txt`, Buffer.from(report.text, 'utf8'), 'text/plain; charset=utf-8'),
  ];
}

/** Compat : première pièce, le HTML. */
export function reportAttachment(report: IncidentReport): PieceJointe {
  return reportAttachments(report)[0];
}

/** Charge des événements par identifiant, pour bâtir le rapport après insertion. */
export function telemetryByIds(ids: string[]): TelemetryRow[] {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  try {
    return db
      .prepare(`SELECT * FROM telemetry_events WHERE id IN (${marks}) ORDER BY created_at`)
      .all(...ids) as TelemetryRow[];
  } catch {
    return [];
  }
}

/**
 * Toutes les erreurs d'un appareil (ou d'un compte) dans la fenêtre, plus
 * les identifiants déjà connus. C'est ce qui permet au document de raconter
 * aussi les erreurs envoyées en direct — et donc jamais apparues dans le
 * digest hors-ligne — pendant la même salve.
 */
export function telemetryAroundDevice(opts: {
  deviceId?: string;
  userId?: string;
  from: number;
  to: number;
  extraIds?: string[];
  limit?: number;
}): TelemetryRow[] {
  const limit = Math.min(opts.limit ?? 2_500, 4_000);
  const from = Math.max(0, opts.from);
  const to = Math.max(from, opts.to);
  const seen = new Set<string>();
  const out: TelemetryRow[] = [];
  const push = (rows: TelemetryRow[]) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  };
  try {
    if (opts.deviceId) {
      push(
        db
          .prepare(
            `SELECT * FROM telemetry_events
              WHERE level IN ('error','fatal') AND device_id = ?
                AND created_at BETWEEN ? AND ?
              ORDER BY created_at LIMIT ?`,
          )
          .all(opts.deviceId, from, to, limit) as TelemetryRow[],
      );
    }
    if (opts.userId && out.length < limit) {
      push(
        db
          .prepare(
            `SELECT * FROM telemetry_events
              WHERE level IN ('error','fatal') AND user_id = ?
                AND created_at BETWEEN ? AND ?
              ORDER BY created_at LIMIT ?`,
          )
          .all(opts.userId, from, to, limit - out.length) as TelemetryRow[],
      );
    }
  } catch {
    /* table absente */
  }
  if (opts.extraIds?.length) push(telemetryByIds(opts.extraIds));
  return out.sort((a, b) => a.created_at - b.created_at);
}
