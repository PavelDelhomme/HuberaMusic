/**
 * Affiche le bilan de fin de balayage sans l'envoyer.
 *
 * Le mail part tout seul du serveur à chaque fin de cycle : sans ce point de
 * contrôle, on ne saurait qu'il est correct qu'en le recevant.
 *
 *   npx tsx scripts/qa/health-report-preview.mts
 */
import { buildCycleReport } from '../../api/src/media/libraryHealth.ts';

const report = buildCycleReport();
if (!report) {
  console.log('Aucun titre vérifié depuis le dernier bilan : pas de cycle à clore.');
  process.exit(0);
}
console.log(`Objet : ${report.subject}\n`);
console.log(report.text);
console.log(`\n(${report.done} titres dans ce bilan)`);
