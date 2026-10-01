/**
 * CLI : npx tsx api/src/media/importFileCli.ts --email paul@delhomme.ovh --file /tmp/x.mp3 --title "Jive Me - 120 BPM"
 */
import { readFileSync, existsSync } from 'node:fs';
import { findUserByEmail } from '../library/db.js';
import { importLocalAudioFile } from './import.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return '';
  return String(process.argv[i + 1] || '').trim();
}

const email = arg('email');
const file = arg('file');
const title = arg('title');
const artist = arg('artist');
if (!email || !file) {
  console.error('usage: importFileCli --email <email> --file <mp3> [--title] [--artist]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error('fichier introuvable', file);
  process.exit(2);
}
const user = findUserByEmail(email);
if (!user) {
  console.error('utilisateur introuvable', email);
  process.exit(2);
}
const buf = readFileSync(file);
const result = await importLocalAudioFile(user.id, {
  buffer: buf,
  filename: file.split('/').pop(),
  mime: 'audio/mpeg',
  title: title || undefined,
  artist: artist || undefined,
});
console.log(
  JSON.stringify(
    {
      ok: true,
      userId: user.id,
      email: user.email,
      id: result.id,
      title: result.title,
      metaSource: result.metaSource,
      youtubeId: result.youtubeId,
      artists: result.track.artists,
    },
    null,
    2,
  ),
);
process.exit(0);
