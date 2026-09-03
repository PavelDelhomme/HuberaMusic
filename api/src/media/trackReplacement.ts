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

const CACHE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'data',
  'cache',
);

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const PROBE_MS = 40_000;
/** Score minimal pour accepter un remplaçant — au-dessous, mieux vaut échouer que jouer un autre morceau. */
const MIN_SCORE = 75;
/**
 * Au-dessus de ce score (titre et artiste quasi identiques), on redirige même sans
 * avoir pu vérifier le candidat : le pipeline de stream complet a bien plus de
 * recours que la seule résolution de format. La correspondance n'est alors pas
 * mémorisée, pour la revalider à la lecture suivante.
 */
const TRUST_SCORE = 85;

let schemaReady = false;
const inflight = new Map<string, Promise<string | null>>();

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
  // Garde-fou anti-boucle : jamais A → B si B → A est déjà enregistré.
  if (getReplacementId(replacementId) === deadId) {
    console.warn(`[replacement] boucle évitée ${deadId} ↔ ${replacementId}`);
    return;
  }
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
    if (existsSync(file) && statSync(file).size > 1024 * 1024) return true;
  } catch {
    /* pas de cache lisible */
  }
  try {
    const fmt = await Promise.race([
      getAudioFormat(id),
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
      const buckets = await search(q, 'song', userId ? { userId } : undefined);
      const pool = [
        ...(buckets.topResult ? [buckets.topResult as Track] : []),
        ...((buckets.songs || []) as Track[]),
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

  const running = inflight.get(deadId);
  if (running) return running;

  const job = (async (): Promise<string | null> => {
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
      if (!(await playable(t.id))) continue;
      console.log(
        `[replacement] ${deadId} → ${t.id} (score ${s}) « ${t.title} — ${artistLine(t)} »`,
      );
      saveReplacement(deadId, t.id, title, artist, s);
      return t.id;
    }

    const trusted = unique.find(({ s }) => s >= TRUST_SCORE);
    if (trusted) {
      console.log(
        `[replacement] ${deadId} → ${trusted.t.id} (score ${trusted.s}, non vérifié) ` +
          `« ${trusted.t.title} — ${artistLine(trusted.t)} »`,
      );
      // Mémorisé malgré l'absence de vérification : sans cela chaque lecture
      // repaierait la recherche (~50 s). Si ce remplaçant est mort lui aussi, il
      // déclenchera sa propre substitution.
      saveReplacement(deadId, trusted.t.id, title, artist, trusted.s);
      return trusted.t.id;
    }

    // Sans le détail des candidats écartés, impossible de savoir si le seuil est
    // trop strict ou si le morceau a réellement disparu du catalogue.
    const rejected = candidates
      .slice(0, 4)
      .map((t) => `${t.id}:${scoreCandidate(t, title, artist, durationSec)} « ${t.title} — ${artistLine(t)} »`)
      .join(' | ');
    console.warn(
      `[replacement] ${deadId} « ${title} — ${artist} » : aucun remplaçant fiable ` +
        `(${unique.length} retenus) écartés: ${rejected || 'aucun résultat'}`,
    );
    return null;
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
  return /video unavailable|this video is unavailable|private video|removed by the uploader|no longer available/i.test(
    message,
  );
}
