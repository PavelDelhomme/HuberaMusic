/**
 * Contrôle la répartition estimée des paroles (titres sans LRC).
 *
 *   npx tsx scripts/qa/lyrics-timing-check.mts
 */
import {
  estimateTimedFromPlain,
  looksLikeLyrics,
  snapPlainToCaptions,
} from '../../api/src/youtube/lyricsTiming.ts';

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

const caps = [
  { startMs: 12_000, text: 'Raut not dead' },
  { startMs: 18_000, text: 'Ich bleib stehen' },
  { startMs: 28_000, text: 'Die Nacht ist lang' },
  { startMs: 40_000, text: 'Wir fahren weiter' },
  { startMs: 55_000, text: 'Raut not dead' },
];
const snapped = snapPlainToCaptions(sample, caps);
const snapOk = Boolean(
  snapped &&
    snapped.length >= 4 &&
    snapped[0]!.startMs === 12_000 &&
    snapped.every((l, i) => i === 0 || l.startMs >= snapped[i - 1]!.startMs),
);
console.log(
  `${snapOk ? 'OK' : 'ÉCHEC'} snap ${snapped?.length ?? 0} lignes sur sous-titres`,
);
process.exit(ok && snapOk ? 0 : 1);
