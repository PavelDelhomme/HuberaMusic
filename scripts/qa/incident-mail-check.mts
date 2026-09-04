/**
 * Simule une salve d'erreurs hors-ligne et contrôle le mail produit.
 *
 * Le rapport ne se vérifie pas en lisant le code : il faut voir ce qui part
 * réellement, pièce jointe comprise. Ce script insère des erreurs de test en
 * base, déclenche le digest, puis affiche ce qui a été envoyé.
 *
 *   npx tsx scripts/qa/incident-mail-check.mts           # rendu seulement
 *   npx tsx scripts/qa/incident-mail-check.mts --envoyer # envoie vraiment
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../api/src/library/db.ts';
import { buildIncidentReport, reportAttachments, telemetryByIds } from '../../api/src/platform/incidentReport.ts';

const envoyer = process.argv.includes('--envoyer');

/** Titres réels de la bibliothèque : le rapport doit savoir les nommer. */
const titres = db
  .prepare('SELECT track_id FROM library_tracks LIMIT 3')
  .all() as { track_id: string }[];
if (!titres.length) {
  console.log('Bibliothèque vide en local : impossible de simuler.');
  process.exit(0);
}

const deviceId = `qa-${randomUUID().slice(0, 8)}`;
const maintenant = Date.now();
const ids: string[] = [];

for (const [i, t] of titres.entries()) {
  const id = randomUUID();
  const occurrences = [3, 1973, 12][i] ?? 1;
  const times = Array.from({ length: Math.min(8, occurrences) }, (_, k) => maintenant - k * 45_000);
  db.prepare(
    `INSERT INTO telemetry_events
       (id, created_at, env, level, kind, message, stack, url, user_agent, user_id, device_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    maintenant - i * 60_000,
    'prod',
    'error',
    'android.player',
    `onPlayerError code=2001 id=${t.track_id} streak=${i + 1} network=true local=false\n\n` +
      `Pré-diagnostic Android : source indisponible après trois tentatives, la requête ` +
      `n'a jamais reçu le premier octet.`,
    'androidx.media3.exoplayer.ExoPlaybackException: Source error\n' +
      '  at androidx.media3.exoplayer.source.ProgressiveMediaPeriod.onLoadError(ProgressiveMediaPeriod.java:612)\n' +
      '  at ovh.delhomme.ytmusic.player.PlaybackService.onPlayerError(PlaybackService.kt:1841)',
    'android://ovh.delhomme.ytmusic',
    'PLM-Android/p+1.3.143 (samsung SM-A536B; sdk=35)',
    null,
    deviceId,
    JSON.stringify({
      batch: true,
      count: occurrences,
      firstTs: maintenant - occurrences * 1_000,
      times,
      trackId: t.track_id,
      http: 502,
      code: 2001,
      streak: i + 1,
      positionMs: 42_000,
      durationMs: 214_000,
      network: true,
      local: false,
      appVersion: 'p+1.3.143',
      manufacturer: 'samsung',
      model: 'SM-A536B',
      sdk: 35,
      diagnosis: 'flux interrompu, aucun octet reçu',
      breadcrumbs: ['play · titre lancé', 'stall · aucune donnée depuis 8 s', 'error · abandon'],
      recentLogs: '13:02:11 D/Playback: open /api/stream/…\n13:02:19 W/Playback: no data\n',
    }),
  );
  ids.push(id);
}

const rows = telemetryByIds(ids);
const report = buildIncidentReport({
  titre: `${rows.length} erreurs cumulées pendant une coupure réseau`,
  env: 'prod',
  events: rows,
  deviceId,
  userAgent: 'PLM-Android/p+1.3.143 (samsung SM-A536B; sdk=35)',
});
const pieces = reportAttachments(report);

console.log(`Erreurs      : ${report.errorCount} distinctes · ${report.occurrenceCount} occurrences`);
console.log(`Titres       : ${report.trackCount}`);
for (const pj of pieces) {
  console.log(`Pièce jointe : ${pj.filename} · ${(pj.content.length / 1024).toFixed(1)} Ko`);
}
console.log('\n──────── premières lignes du rapport ────────\n');
console.log(report.text.split('\n').slice(0, 60).join('\n'));

if (envoyer) {
  const { sendMail } = await import('../../api/src/platform/mail.ts');
  await sendMail({
    to: process.env.TELEMETRY_ALERT_TO || 'dev@delhomme.ovh',
    subject: `[PLM qa] contrôle du rapport d’incident — ${report.errorCount} erreurs`,
    html: `<p>Contrôle du nouveau rapport joint aux alertes.</p><p>${report.errorCount} erreurs, ${report.trackCount} titres documentés.</p>`,
    text: `Contrôle du rapport d'incident. ${report.errorCount} erreurs, ${report.trackCount} titres.`,
    attachments: pieces,
  });
  console.log('\nMail envoyé.');
}

// Les erreurs de test ne doivent pas polluer les statistiques réelles.
db.prepare(`DELETE FROM telemetry_events WHERE device_id = ?`).run(deviceId);
console.log('\n(erreurs de test retirées de la base)');
