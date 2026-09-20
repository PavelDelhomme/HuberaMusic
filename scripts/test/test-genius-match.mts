/**
 * Matching Genius : ADHD ne doit pas remplacer InTheLight / ABCD ADAH.
 * npx tsx scripts/test/test-genius-match.mts
 */
import {
  pickBestHit,
  titleMatchScore,
  geniusSearchUrl,
} from '../../api/src/youtube/lyricsGenius.ts';

function fold(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const adhdRow = {
  url: 'https://genius.com/Joyner-lucas-adhd-lyrics',
  title: 'ADHD',
  artist_names: 'Joyner Lucas',
};
const realRow = {
  url: 'https://genius.com/Inthelight-abcd-adah-lyrics',
  title: 'ABCD ADAH',
  artist_names: 'InTheLight',
};

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok ', msg);
  }
}

assert(titleMatchScore(fold('ABCD ADAH'), fold('ADHD')) === 0, 'ADAH ≠ ADHD substring');
assert(titleMatchScore(fold('ABCD ADHD'), fold('ADHD')) === 0, 'ABCD ADHD ⊄ ADHD');
assert(titleMatchScore(fold('ABCD ADAH'), fold('ABCD ADAH')) === 50, 'titre exact');

assert(
  pickBestHit([adhdRow], 'InTheLight', 'ABCD ADAH') === null,
  'ADHD rejeté pour InTheLight / ABCD ADAH',
);
assert(
  pickBestHit([adhdRow, realRow], 'InTheLight', 'ABCD ADAH')?.url === realRow.url,
  'le hit InTheLight gagne',
);
assert(
  pickBestHit([adhdRow], 'InTheLight', 'ABCD ADHD') === null,
  'ADHD rejeté pour ABCD ADHD',
);

const url = geniusSearchUrl('InTheLight', 'ABCD ADAH');
assert(
  decodeURIComponent(url).includes('InTheLight') && decodeURIComponent(url).includes('ABCD ADAH'),
  'URL Genius = artiste + titre',
);
assert(!/q=ADHD(?:&|$)/i.test(url), 'URL Genius ne cherche pas ADHD seul');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nGenius match OK');
