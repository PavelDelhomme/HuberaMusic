import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMetadataQuery,
  isProbablyMp3,
  isSupportedAudio,
  parseFilenameTags,
  parseId3Tags,
} from './id3Meta.js';

function synchsafe(n: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (n >> 21) & 0x7f;
  b[1] = (n >> 14) & 0x7f;
  b[2] = (n >> 7) & 0x7f;
  b[3] = n & 0x7f;
  return b;
}

function id3Frame(id: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const hdr = Buffer.alloc(10);
  hdr.write(id, 0, 'ascii');
  synchsafe(payload.length).copy(hdr, 4);
  return Buffer.concat([hdr, payload]);
}

describe('id3Meta', () => {
  it('parse le nom de fichier Artiste - Titre.mp3', () => {
    const t = parseFilenameTags('Jive Me - 120 BPM.mp3');
    assert.equal(t.artist, 'Jive Me');
    assert.equal(t.title, '120 BPM');
  });

  it('parse un titre seul', () => {
    const t = parseFilenameTags('/tmp/Laisse Nous Raver.mp3');
    assert.equal(t.title, 'Laisse Nous Raver');
    assert.equal(t.artist, undefined);
  });

  it('construit la requête YouTube titre+artiste', () => {
    assert.equal(buildMetadataQuery({ title: '120 BPM', artist: 'Jive Me' }), 'Jive Me - 120 BPM');
    assert.equal(
      buildMetadataQuery({ filename: 'Jive Me - 120 BPM.mp3' }),
      'Jive Me - 120 BPM',
    );
  });

  it('détecte un MP3 ID3 et un MPEG frame', () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(13, 0)]);
    assert.equal(isProbablyMp3(id3), true);
    const mpeg = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(isProbablyMp3(mpeg, 'audio/mpeg'), true);
    assert.equal(isSupportedAudio(Buffer.from('not-audio'), 'text/plain', 'x.txt'), false);
  });

  it('lit TIT2 / TPE1 ID3v2.4', () => {
    const frames = Buffer.concat([id3Frame('TIT2', '120 BPM'), id3Frame('TPE1', 'Jive Me')]);
    const header = Buffer.alloc(10);
    header.write('ID3', 0);
    header[3] = 4;
    synchsafe(frames.length).copy(header, 6);
    const buf = Buffer.concat([header, frames]);
    const tags = parseId3Tags(buf);
    assert.equal(tags.title, '120 BPM');
    assert.equal(tags.artist, 'Jive Me');
  });
});
