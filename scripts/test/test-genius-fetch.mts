import { fetchGeniusLyrics } from '../../api/src/youtube/lyricsGenius.ts';

const samples: [string, string][] = [
  ['InTheLight', 'ABCD ADAH'],
  ['Daft Punk', 'Get Lucky'],
  ['Stromae', 'Alors on danse'],
];

let miss = 0;
for (const [artist, title] of samples) {
  const r = await fetchGeniusLyrics(artist, title);
  if (r?.lyrics) {
    console.log('ok ', artist, title, r.lyrics.length + 'c');
  } else {
    miss += 1;
    console.error('MISS', artist, title);
  }
}
if (miss) process.exit(1);
console.log('Genius fetch samples OK');
