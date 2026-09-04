/**
 * Affiche le rapport d'incident sans envoyer de mail.
 *
 * Le document part tout seul en pièce jointe à chaque alerte : sans ce point
 * de contrôle, on ne saurait qu'il est lisible et complet qu'en recevant le
 * mail, une fois l'incident passé.
 *
 *   npx tsx scripts/qa/incident-report-preview.mts                    # 10 dernières
 *   npx tsx scripts/qa/incident-report-preview.mts 40                 # les 40 dernières
 *   npx tsx scripts/qa/incident-report-preview.mts 5 --stats          # taille seulement
 *   npx tsx scripts/qa/incident-report-preview.mts 5 --kind=android   # par type
 */
import { db } from '../../api/src/library/db.ts';
import {
  buildIncidentReport,
  reportAttachments,
  type TelemetryRow,
} from '../../api/src/platform/incidentReport.ts';

const n = Number(process.argv[2]) || 10;
const statsOnly = process.argv.includes('--stats');
const kind = process.argv.find((a) => a.startsWith('--kind='))?.slice(7) || '';

const rows = db
  .prepare(
    `SELECT * FROM telemetry_events WHERE level IN ('error','fatal')
       AND (? = '' OR kind LIKE '%' || ? || '%')
      ORDER BY created_at DESC LIMIT ?`,
  )
  .all(kind, kind, n) as TelemetryRow[];

if (!rows.length) {
  console.log('Aucune erreur en base : rien à rapporter.');
  process.exit(0);
}

const report = buildIncidentReport({
  titre: `Aperçu : ${rows.length} dernière(s) erreur(s) enregistrée(s)`,
  env: 'prod',
  events: rows,
  deviceId: rows[0].device_id || undefined,
  userId: rows[0].user_id || undefined,
  userAgent: rows[0].user_agent || undefined,
});

if (statsOnly) {
  const lignes = report.text.split('\n').length;
  const pieces = reportAttachments(report);
  console.log(`Erreurs      : ${report.errorCount} distinctes · ${report.occurrenceCount} occurrences`);
  console.log(`Titres       : ${report.trackCount}`);
  console.log(`Document     : ${(report.text.length / 1024).toFixed(1)} Ko · ${lignes} lignes`);
  for (const pj of pieces) {
    console.log(`Pièce jointe : ${pj.filename} · ${(pj.content.length / 1024).toFixed(1)} Ko`);
  }
  process.exit(0);
}

console.log(report.text);
