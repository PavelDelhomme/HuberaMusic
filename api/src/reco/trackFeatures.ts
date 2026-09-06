/**
 * Embeddings légers phase 2 (sans CLAP/FAISS) :
 * vecteur sparse tags + énergie, persisté SQLite, cosine dans hybridRank.
 */
import { db } from '../library/db.js';
import type { Track } from '../youtube/types.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS track_features (
    track_id TEXT PRIMARY KEY,
    vec_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

/** Dimensions stables (ordre fixe pour cosine). */
export const FEATURE_DIMS = [
  'rap',
  'hiphop',
  'pop',
  'rock',
  'electro',
  'dance',
  'rnb',
  'soul',
  'jazz',
  'classical',
  'metal',
  'punk',
  'indie',
  'folk',
  'country',
  'reggae',
  'latin',
  'afro',
  'arabic',
  'comedy',
  'gospel',
  'blues',
  'funk',
  'house',
  'techno',
  'trap',
  'drill',
  'kpop',
  'energy',
] as const;

export type FeatureVec = number[];

function zeros(): FeatureVec {
  return FEATURE_DIMS.map(() => 0);
}

/** Construit un vecteur depuis tags style + énergie proxy (0..1). */
export function buildFeatureVec(tags: string[], energy: number): FeatureVec {
  const v = zeros();
  const set = new Set(tags.map((t) => t.toLowerCase()));
  for (let i = 0; i < FEATURE_DIMS.length - 1; i++) {
    const dim = FEATURE_DIMS[i]!;
    if (set.has(dim)) v[i] = 1;
  }
  v[FEATURE_DIMS.length - 1] = Math.max(0, Math.min(1, energy));
  // L2 normalize (sauf vecteur nul)
  let n2 = 0;
  for (const x of v) n2 += x * x;
  if (n2 > 1e-9) {
    const n = Math.sqrt(n2);
    for (let i = 0; i < v.length; i++) v[i]! /= n;
  }
  return v;
}

export function cosine(a: FeatureVec, b: FeatureVec): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] || 0) * (b[i] || 0);
  return Math.max(0, Math.min(1, dot));
}

export function getTrackFeatures(trackId: string): FeatureVec | null {
  const row = db
    .prepare(`SELECT vec_json FROM track_features WHERE track_id = ?`)
    .get(trackId) as { vec_json: string } | undefined;
  if (!row?.vec_json) return null;
  try {
    const arr = JSON.parse(row.vec_json) as number[];
    if (!Array.isArray(arr) || arr.length !== FEATURE_DIMS.length) return null;
    return arr;
  } catch {
    return null;
  }
}

export function putTrackFeatures(trackId: string, vec: FeatureVec) {
  if (!trackId || vec.length !== FEATURE_DIMS.length) return;
  db.prepare(
    `INSERT INTO track_features (track_id, vec_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET vec_json = excluded.vec_json, updated_at = excluded.updated_at`,
  ).run(trackId, JSON.stringify(vec), Date.now());
}

export function ensureTrackFeatures(
  track: Track,
  tags: string[],
  energy: number,
): FeatureVec {
  const id = track?.id;
  if (!id) return buildFeatureVec(tags, energy);
  const existing = getTrackFeatures(id);
  if (existing) return existing;
  const vec = buildFeatureVec(tags, energy);
  putTrackFeatures(id, vec);
  return vec;
}

/** Similarité contenu via embeddings (fallback 0.5 si seed absent). */
export function scoreContentEmbedding(
  candidate: Track,
  seed: Track | null,
  candTags: string[],
  candEnergy: number,
  seedTags: string[],
  seedEnergy: number,
): number | null {
  if (!seed?.id) return null;
  const a = ensureTrackFeatures(seed, seedTags, seedEnergy);
  const b = ensureTrackFeatures(candidate, candTags, candEnergy);
  return cosine(a, b);
}
