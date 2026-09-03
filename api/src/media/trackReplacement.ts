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

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(official|video|lyrics|audio|mv|clip|hd|4k|remaster(ed)?)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_MARKERS: [RegExp, string][] = [
  [/\bremix(e|ed)?\b|\bmix\b/i, 'remix'],
  [/\blive\b|\ben concert\b|\bconcert\b|\bsession\b/i, 'live'],
  [/\bacoustic|\bacoustique|\bunplugged\b/i, 'acoustic'],
  [/\binstrumental\b|\bkaraok/i, 'instrumental'],
  [/\bextended\b|\bclub edit\b|\blong version\b/i, 'extended'],
  [/\bradio edit\b|\bshort version\b/i, 'radio'],
  [/\bsped ?up\b|\bnightcore\b|\bslowed\b|\breverb\b/i, 'speed'],
  [/\bcover\b|\breprise\b/i, 'cover'],
  [/\bdemo\b|\bwork in progress\b|\brehearsal\b|\bmaquette\b/i, 'demo'],
];

/**
 * `normalize` supprime les parenthèses, donc « Don't Be So Shy (Filatov & Karas Remix) »
 * et « Don't Be So Shy (Work in Progress) » deviennent identiques. On compare donc à
 * part les mentions de version pour ne pas substituer un remix par l'original.
 */
function versionTags(title: string): Set<string> {
  const out = new Set<string>();
  for (const [re, tag] of VERSION_MARKERS) if (re.test(title)) out.add(tag);
  return out;
}

function sameVersion(deadTitle: string, candTitle: string): boolean {
  const want = versionTags(deadTitle);
  const got = versionTags(candTitle);
  if (want.size !== got.size) return false;
  for (const tag of want) if (!got.has(tag)) return false;
  return true;
}

function artistLine(t: Pick<Track, 'artists'>): string {
  return (t.artists || [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ');
}

/**
 * Exigeant volontairement : un mauvais remplaçant ferait jouer une reprise ou un
 * autre morceau, ce qui est pire qu'une erreur franche.
 */
function scoreCandidate(
  cand: Track,
  title: string,
  artist: string,
  durationSec?: number | null,
): number {
  const nt = normalize(title);
  const na = normalize(artist);
  const ct = normalize(cand.title || '');
  const ca = normalize(artistLine(cand));
  if (!nt || !ct) return 0;
  if (!sameVersion(title, cand.title || '')) return 0;

  let score = 0;
  if (ct === nt) score += 50;
  else if (ct.includes(nt) || nt.includes(ct)) score += 34;
  else {
    const want = new Set(nt.split(' ').filter((w) => w.length > 2));
    const got = ct.split(' ').filter((w) => w.length > 2);
    const hit = got.filter((w) => want.has(w)).length;
    const ratio = want.size ? hit / want.size : 0;
    if (ratio < 0.7) return 0;
    score += Math.round(ratio * 26);
  }

  // Sans correspondance d'artiste on refuse : c'est le garde-fou principal.
  if (!na || !ca) return 0;
  if (ca === na) score += 40;
  else if (ca.includes(na) || na.includes(ca)) score += 30;
  else {
    const want = new Set(na.split(' ').filter((w) => w.length > 2));
    const got = ca.split(' ').filter((w) => w.length > 2);
    if (!got.some((w) => want.has(w))) return 0;
    score += 16;
  }

  if (durationSec && cand.durationSeconds && cand.durationSeconds > 0) {
    const delta = Math.abs(cand.durationSeconds - durationSec) / durationSec;
    if (delta <= 0.05) score += 15;
    else if (delta <= 0.15) score += 8;
    else if (delta > 0.35) return 0;
  }
  return score;
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
 * Cherche un identifiant de remplacement lisible pour un titre mort.
 * Retourne `null` plutôt que de risquer un morceau différent.
 */
export async function findReplacementId(
  deadId: string,
  hints?: { title?: string; artist?: string; durationSeconds?: number | null },
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

    let candidates: Track[] = [];
    try {
      const buckets = await search(`${title} ${artist}`, 'song');
      candidates = [
        ...(buckets.topResult ? [buckets.topResult as Track] : []),
        ...((buckets.songs || []) as Track[]),
      ].filter((t) => t?.id && t.id !== deadId && VIDEO_ID.test(t.id));
    } catch (err) {
      console.warn(
        `[replacement] recherche KO ${deadId}:`,
        String((err as Error).message || err).slice(0, 120),
      );
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

    console.warn(`[replacement] ${deadId} : aucun remplaçant fiable (${unique.length} candidats)`);
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
