/**
 * ID3v2 + nom de fichier — sans dépendance. Sert l’import MP3 utilisateur.
 */

export type Id3Tags = {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
};

const TEXT_FRAMES = new Set(['TIT2', 'TPE1', 'TALB', 'TLEN', 'TT2', 'TP1', 'TAL']);

function synchsafe(buf: Buffer, offset: number): number {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

function decodeId3Text(buf: Buffer): string {
  if (!buf.length) return '';
  const enc = buf[0];
  const body = buf.subarray(1);
  try {
    if (enc === 1 || enc === 2) {
      const le = enc === 1 && body.length >= 2 && body[0] === 0xff && body[1] === 0xfe;
      const start = enc === 1 && body.length >= 2 && (body[0] === 0xff || body[0] === 0xfe) ? 2 : 0;
      return body
        .subarray(start)
        .toString(le || enc === 1 ? 'utf16le' : 'utf16le')
        .replace(/\0/g, '')
        .trim();
    }
    if (enc === 3) return body.toString('utf8').replace(/\0/g, '').trim();
    return body.toString('latin1').replace(/\0/g, '').trim();
  } catch {
    return body.toString('utf8').replace(/\0/g, '').trim();
  }
}

/** Parse ID3v2.2 / 2.3 / 2.4 en tête de buffer. */
export function parseId3Tags(buf: Buffer): Id3Tags {
  const out: Id3Tags = {};
  if (!buf || buf.length < 10) return out;
  if (buf.subarray(0, 3).toString('ascii') !== 'ID3') return out;
  const major = buf[3];
  const tagSize = synchsafe(buf, 6);
  const end = Math.min(buf.length, 10 + tagSize);
  let off = 10;
  const idLen = major === 2 ? 3 : 4;
  const sizeLen = major === 2 ? 3 : 4;
  while (off + idLen + sizeLen < end) {
    const id = buf.subarray(off, off + idLen).toString('ascii');
    if (!/^[A-Z0-9]+$/.test(id)) break;
    off += idLen;
    let size = 0;
    if (major === 4) {
      size = synchsafe(buf, off);
      off += 4 + 2;
    } else if (major === 2) {
      size = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
      off += 3;
    } else {
      size = buf.readUInt32BE(off);
      off += 4 + 2;
    }
    if (size <= 0 || off + size > end) break;
    const payload = buf.subarray(off, off + size);
    off += size;
    const canon = id === 'TT2' ? 'TIT2' : id === 'TP1' ? 'TPE1' : id === 'TAL' ? 'TALB' : id;
    if (!TEXT_FRAMES.has(canon) && canon !== 'TLEN') continue;
    const text = decodeId3Text(payload);
    if (!text) continue;
    if (canon === 'TIT2') out.title = text;
    else if (canon === 'TPE1') out.artist = text.split('/')[0]?.trim() || text;
    else if (canon === 'TALB') out.album = text;
    else if (canon === 'TLEN') {
      const n = Number(text);
      if (Number.isFinite(n) && n > 0) out.durationMs = n > 100_000 ? n : n * 1000;
    }
  }
  return out;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac|mpeg)$/i;

/** « Artist - Title.mp3 » ou « Title.mp3 ». */
export function parseFilenameTags(filename: string): Id3Tags {
  const base = String(filename || '')
    .replace(/^.*[/\\]/, '')
    .replace(AUDIO_EXT, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return {};
  const dash = base.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  if (dash && dash[1] && dash[2]) {
    return { artist: dash[1].trim(), title: dash[2].trim() };
  }
  return { title: base };
}

export function isProbablyMp3(buf: Buffer, mime?: string, filename?: string): boolean {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mpeg') || m === 'audio/mp3' || m === 'audio/x-mpeg') {
    if (buf.length >= 16) return true;
  }
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.mp3') && buf.length >= 16) return true;
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return true;
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

export function isSupportedAudio(buf: Buffer, mime?: string, filename?: string): boolean {
  if (isProbablyMp3(buf, mime, filename)) return true;
  const m = String(mime || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac') || m.includes('wav') || m.includes('ogg')) {
    return buf.length >= 16;
  }
  if (/\.(m4a|aac|wav|ogg|flac)$/i.test(name)) return buf.length >= 16;
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF') return true;
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return true;
  return false;
}

export function formatDurationClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function buildMetadataQuery(parts: { title?: string; artist?: string; filename?: string }): string {
  const title = String(parts.title || '').trim();
  const artist = String(parts.artist || '').trim();
  if (artist && title) return `${artist} - ${title}`;
  if (title) return title;
  if (artist) return artist;
  const fromFile = parseFilenameTags(parts.filename || '');
  if (fromFile.artist && fromFile.title) return `${fromFile.artist} - ${fromFile.title}`;
  return fromFile.title || '';
}
