/**
 * Substitution des videoId morts.
 *
 * Une partie de la bibliothèque pointe vers des vidéos supprimées / privées côté
 * YouTube : tous les backends répondent alors « This video is unavailable » et la
 * lecture échoue définitivement. Plutôt que de sauter le titre, on retrouve le même
 * morceau sous un autre identifiant (titre + artiste), on vérifie qu'il est bien
 * lisible, puis on mémorise la correspondance pour que les lectures suivantes soient
 * immédiates.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload } from '../library/db.js';
import { getAudioFormat, getTrack, search } from '../youtube/yt.js';
import type { Track } from '../youtube/types.js';
import { artistLine, scoreCandidate } from './trackMatch.js';
import { findAtlasEquivalent, rememberAtlasPlayable } from './trackAtlas.js';

const CACHE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'data',
  'cache',
);

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const PROBE_MS = 8_000;
/** Score minimal pour accepter un remplaçant — au-dessous, mieux vaut échouer que jouer un autre morceau. */
const MIN_SCORE = 70;

let schemaReady = false;
const inflight = new Map<string, Promise<string | null>>();
/** Une seule recherche YouTube à la fois — sinon health + lecture saturent. */
let heavySearches = 0;

export function ensureTrackReplacementSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_id_replacements (
      dead_id TEXT PRIMARY KEY,
      replacement_id TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_track_repl_replacement
      ON track_id_replacements(replacement_id);
  `);
  schemaReady = true;
}

export function getReplacementId(deadId: string): string | null {
  if (!VIDEO_ID.test(deadId)) return null;
  try {
    ensureTrackReplacementSchema();
    const row = db
      .prepare('SELECT replacement_id FROM track_id_replacements WHERE dead_id = ?')
      .get(deadId) as { replacement_id?: string } | undefined;
    const id = row?.replacement_id;
    return id && VIDEO_ID.test(id) && id !== deadId ? id : null;
  } catch {
    return null;
  }
}

function saveReplacement(
  deadId: string,
  replacementId: string,
  title: string,
  artist: string,
  score: number,
) {
  // Anti-boucle : si B → A existe déjà, ne PAS créer A → B (sinon ping-pong
  // Brisa ↔ Brisa Salada et BUFFERING 50 s).
  if (getReplacementId(replacementId) === deadId) {
    console.warn(`[replacement] refuse boucle ${deadId} ↔ ${replacementId}`);
    return;
  }
  // Suivre la chaîne si le remplaçant est lui-même redirigé.
  const hop = getReplacementId(replacementId);
  if (hop && hop !== deadId && VIDEO_ID.test(hop)) {
    replacementId = hop;
  }
  if (replacementId === deadId) return;
  try {
    ensureTrackReplacementSchema();
    const now = Date.now();
    db.prepare(
      `INSERT INTO track_id_replacements
         (dead_id, replacement_id, title, artist, score, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'auto', ?, ?)
       ON CONFLICT(dead_id) DO UPDATE SET
         replacement_id = excluded.replacement_id,
         title = excluded.title,
         artist = excluded.artist,
         score = excluded.score,
         updated_at = excluded.updated_at`,
    ).run(deadId, replacementId, title, artist, score, now, now);
  } catch (err) {
    console.warn('[replacement] persist KO:', String((err as Error).message || err).slice(0, 120));
  }
}

async function playable(id: string): Promise<boolean> {
  // Déjà sur disque : inutile d'interroger YouTube.
  try {
    const file = join(CACHE_DIR, `${id}.m4a`);
    if (existsSync(file) && statSync(file).size > 256 * 1024) return true;
  } catch {
    /* pas de cache lisible */
  }
  try {
    const fmt = await Promise.race([
      getAudioFormat(id, { live: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_MS)),
    ]);
    return Boolean(fmt?.url);
  } catch {
    return false;
  }
}

async function metaFor(
  deadId: string,
  hints?: { title?: string; artist?: string; durationSeconds?: number | null },
): Promise<{ title: string; artist: string; durationSec: number | null }> {
  let title = (hints?.title || '').trim();
  let artist = (hints?.artist || '').trim();
  let durationSec = hints?.durationSeconds ?? null;

  if (!title || !artist) {
    const cached = getTrackPayload(deadId);
    if (cached) {
      title = title || cached.title || '';
      artist = artist || artistLine(cached);
      durationSec = durationSec ?? cached.durationSeconds ?? null;
    }
  }
  // Dernier recours : la vidéo est morte, mais les métadonnées peuvent encore répondre.
  if (!title) {
    try {
      const { track } = await getTrack(deadId, { light: true });
      title = track.title || '';
      artist = artist || artistLine(track);
      durationSec = durationSec ?? track.durationSeconds ?? null;
    } catch {
      /* rien de plus à tenter */
    }
  }

  // Chaînes lyrics / TV : l’« artiste » est souvent le compte upload, pas l’interprète.
  // « ROSALÍA - Despecha (Letra) » → artiste ROSALÍA, titre Despecha.
  const channelish =
    !artist ||
    /mundial|lyrics?|letra|topic|vevo|music\s*core|mbc|kpop|official|records?/i.test(artist);
  if (title && channelish) {
    const m = title.match(/^(.{2,60}?)\s*[-–—:]\s*(.+)$/u);
    if (m) {
      const left = m[1]!.trim();
      const right = m[2]!.trim();
      // « Artist - Song » le plus fréquent
      if (left.length <= 40 && right.length >= 2) {
        artist = left;
        title = right.replace(/\b(letra|lyrics?|official\s*video)\b/gi, ' ').replace(/\s+/g, ' ').trim() || right;
      }
    }
  }
  return { title, artist, durationSec };
}

/**
 * Une seule formulation ne suffit pas : « GJS (feat. Jul & SCH) GIMS » ne remonte
 * pas le bon titre alors que « GJS GIMS » le donne en tête. On cumule donc
 * plusieurs formulations, du plus précis au plus large.
 */
async function collectCandidates(
  deadId: string,
  title: string,
  artist: string,
  userId?: string,
): Promise<Track[]> {
  const bareTitle = title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  const mainArtist = artist.split(',')[0]?.trim() || artist;
  const queries = [...new Set([
    `${title} ${artist}`,
    `${bareTitle} ${mainArtist}`,
    bareTitle,
  ].map((q) => q.trim()).filter(Boolean))];

  const out = new Map<string, Track>();
  for (const q of queries) {
    try {
      // « all » et non « song » : quand un morceau du catalogue meurt, la copie
      // encore lisible est souvent une vidéo (chaîne de l'artiste, titre inédit),
      // que le filtre morceaux ne remonte jamais.
      const buckets = await search(q, 'all', userId ? { userId } : undefined);
      const pool = [
        ...(buckets.topResult ? [buckets.topResult as Track] : []),
        ...((buckets.songs || []) as Track[]),
        ...((buckets.videos || []) as Track[]),
      ];
      for (const t of pool) {
        if (t?.id && t.id !== deadId && VIDEO_ID.test(t.id) && !out.has(t.id)) out.set(t.id, t);
      }
    } catch (err) {
      console.warn(
        `[replacement] recherche KO ${deadId} « ${q} »:`,
        String((err as Error).message || err).slice(0, 120),
      );
    }
    // Un candidat parfait rend les formulations suivantes inutiles.
    if ([...out.values()].some((t) => scoreCandidate(t, title, artist) >= 90)) break;
  }
  return [...out.values()];
}

/**
 * Cherche un identifiant de remplacement lisible pour un titre mort.
 * Retourne `null` plutôt que de risquer un morceau différent.
 */
export async function findReplacementId(
  deadId: string,
  hints?: {
    title?: string;
    artist?: string;
    durationSeconds?: number | null;
    userId?: string;
  },
): Promise<string | null> {
  if (!VIDEO_ID.test(deadId)) return null;

  const known = getReplacementId(deadId);
  if (known) return known;
  const fromDisk = findAtlasEquivalent(deadId);
  if (fromDisk) {
    const meta = getTrackPayload(deadId);
    saveReplacement(
      deadId,
      fromDisk,
      meta?.title || '',
      meta ? artistLine(meta) : '',
      95,
    );
    return fromDisk;
  }

  const running = inflight.get(deadId);
  if (running) return running;

  const job = (async (): Promise<string | null> => {
    if (heavySearches >= 1) {
      console.warn(`[replacement] file pleine, skip search ${deadId}`);
      return null;
    }
    heavySearches += 1;
    try {
    const { title, artist, durationSec } = await metaFor(deadId, hints);
    if (!title || !artist) {
      console.warn(`[replacement] ${deadId} : métadonnées insuffisantes`);
      return null;
    }

    const candidates = await collectCandidates(deadId, title, artist, hints?.userId);
    if (!candidates.length) {
      console.warn(`[replacement] ${deadId} « ${title} — ${artist} » : recherche sans résultat`);
      return null;
    }

    const ranked = candidates
      .map((t) => ({ t, s: scoreCandidate(t, title, artist, durationSec) }))
      .filter((x) => x.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s);

    const seen = new Set<string>();
    const unique = ranked.filter(({ t }) => (seen.has(t.id) ? false : seen.add(t.id)));

    for (const { t, s } of unique.slice(0, 6)) {
      if (getReplacementId(t.id) === deadId) continue;
      // Disque seulement — plus de getAudioFormat 8 s × 6 (ça saturait /api/health).
      try {
        const file = join(CACHE_DIR, `${t.id}.m4a`);
        if (existsSync(file) && statSync(file).size > 256 * 1024) {
          console.log(
            `[replacement] ${deadId} → ${t.id} disque (score ${s}) « ${t.title} — ${artistLine(t)} »`,
          );
          saveReplacement(deadId, t.id, title, artist, s);
          rememberAtlasPlayable(t.id, t.title || title, artistLine(t) || artist);
          return t.id;
        }
      } catch {
        /* suivant */
      }
    }

    const best = unique[0];
    if (best) {
      console.warn(
        `[replacement] mémorise sans probe ${deadId} → ${best.t.id} score=${best.s}`,
      );
      saveReplacement(deadId, best.t.id, title, artist, best.s);
      return best.t.id;
    }
    return null;
    } finally {
      heavySearches = Math.max(0, heavySearches - 1);
    }
  })();

  inflight.set(deadId, job);
  try {
    return await job;
  } finally {
    inflight.delete(deadId);
  }
}

/** Signature d'une erreur « vidéo réellement morte » (par opposition à un souci réseau). */
export function looksUnavailable(message: string): boolean {
  // NE PAS matcher « streaming data not available » / LOGIN_REQUIRED / bot :
  // c’est le message générique getAudioFormat (timeout / proxy saturé),
  // pas une vidéo morte — sinon on persiste un remplacement lyrics et on 302.
  return /this video is unavailable|video unavailable|private video|removed by the uploader|no longer available|has been removed|violating youtube|copyright claim|members?.only/i.test(
    message,
  );
}

/** Erreurs CDN / rate-limit / googlevideo — souvent guéries par proxies ou un autre id. */
export function looksTransientStreamError(message: string): boolean {
  return /non 2xx|http error 40[03]|status code 40[03]|403:|401:|429|too many requests|timed out|timeout|econnreset|econnrefused|socket hang up|tls|certificate|proxy/i.test(
    message,
  );
}
