import type { Track } from '../youtube/types.js';
import { search } from '../youtube/yt.js';

export type IdentifyMode = 'listen' | 'hum';

export type IdentifyResult = {
  ok: boolean;
  query?: string;
  title?: string;
  artist?: string;
  album?: string;
  score?: number | null;
  provider?: string;
  search?: Awaited<ReturnType<typeof search>> | null;
  error?: string;
  hint?: string;
};

/**
 * Reconnaissance audio via AudD (écoute / fredonnement).
 * `AUDD_API_TOKEN` dans l’env — sinon token public `test` (très limité).
 */
export async function identifyAudio(opts: {
  audioBase64: string;
  mimeType?: string;
  mode?: IdentifyMode;
  userId?: string;
}): Promise<IdentifyResult> {
  const raw = String(opts.audioBase64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!raw || raw.length < 64) {
    return { ok: false, error: 'audio manquant ou trop court' };
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return { ok: false, error: 'audio base64 invalide' };
  }
  if (buf.length < 800) {
    return { ok: false, error: 'enregistrement trop court — réessaie ~8–12 s' };
  }
  // Cap ~4 Mo
  if (buf.length > 4_500_000) {
    return { ok: false, error: 'fichier audio trop volumineux' };
  }

  const token = String(process.env.AUDD_API_TOKEN || 'test').trim() || 'test';
  const mode: IdentifyMode = opts.mode === 'hum' ? 'hum' : 'listen';
  const endpoint =
    mode === 'hum'
      ? 'https://api.audd.io/recognizeWithOffset/'
      : 'https://api.audd.io/';

  const mime = String(opts.mimeType || 'audio/mp4').split(';')[0] || 'audio/mp4';
  const ext = mime.includes('mpeg') || mime.includes('mp3')
    ? 'mp3'
    : mime.includes('wav')
      ? 'wav'
      : mime.includes('ogg')
        ? 'ogg'
        : 'm4a';

  const form = new FormData();
  form.append('api_token', token);
  form.append('return', 'apple_music,spotify');
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), `clip.${ext}`);

  let audd: any;
  try {
    const res = await fetch(endpoint, { method: 'POST', body: form });
    audd = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: `AudD injoignable: ${String(err)}`,
      hint: 'Vérifie la connexion sortante du serveur',
    };
  }

  if (audd?.status === 'error' || audd?.error) {
    const msg = String(audd?.error?.error_message || audd?.error || 'échec reconnaissance');
    return {
      ok: false,
      error: msg,
      provider: 'audd',
      hint:
        token === 'test'
          ? 'Configure AUDD_API_TOKEN (dashboard.audd.io) pour un quota réel'
          : undefined,
    };
  }

  // Standard recognize
  const result = audd?.result;
  // recognizeWithOffset humming → result may be array
  const first = Array.isArray(result) ? result[0] : result;
  const title =
    first?.title ||
    first?.song_name ||
    first?.apple_music?.name ||
    first?.spotify?.name ||
    '';
  const artist =
    first?.artist ||
    first?.artist_name ||
    first?.apple_music?.artistName ||
    first?.spotify?.artists?.[0]?.name ||
    '';
  const album = first?.album || first?.apple_music?.albumName || '';

  if (!title && !artist) {
    return {
      ok: false,
      error: 'Aucun titre reconnu — rapproche-toi de la source ou fredonne plus clairement',
      provider: 'audd',
    };
  }

  const query = [artist, title].filter(Boolean).join(' ').trim() || title;
  let searchPayload: Awaited<ReturnType<typeof search>> | null = null;
  try {
    searchPayload = await search(query, 'song', { userId: opts.userId });
  } catch {
    searchPayload = null;
  }

  return {
    ok: true,
    query,
    title: String(title),
    artist: String(artist),
    album: String(album || ''),
    score: typeof first?.score === 'number' ? first.score : null,
    provider: 'audd',
    search: searchPayload,
  };
}
