/**
 * Contrôle la répartition estimée des paroles (titres sans LRC).
 *
 *   npx tsx scripts/qa/lyrics-timing-check.mts
 */
import { estimateTimedFromPlain, looksLikeLyrics } from '../../api/src/youtube/lyricsTiming.ts';

const sample = `
[Intro]
Yeah
Raut not dead
Ich bleib stehen wenn die anderen gehen
Die Nacht ist lang und die Straße kennt meinen Namen
Wir fahren weiter bis der Tank leer ist
[Chorus]
Raut not dead
Raut not dead
`;

const timed = estimateTimedFromPlain(sample, 180);
const starts = timed.map((l) => l.startMs);
const ok =
  timed.length >= 6 &&
  starts[0]! >= 6_000 &&
  starts[starts.length - 1]! < 180_000 &&
  starts.every((ms, i) => i === 0 || ms >= starts[i - 1]!);

console.log(
  `${ok ? 'OK' : 'ÉCHEC'} ${timed.length} lignes · ` +
    `première ${(starts[0]! / 1000).toFixed(1)} s · ` +
    `dernière ${(starts[starts.length - 1]! / 1000).toFixed(1)} s`,
);
for (const l of timed) {
  console.log(`  ${(l.startMs / 1000).toFixed(1).padStart(5)} s  ${l.text}`);
}
if (!looksLikeLyrics(sample)) {
  console.log('ÉCHEC looksLikeLyrics');
  process.exit(1);
}
process.exit(ok ? 0 : 1);
