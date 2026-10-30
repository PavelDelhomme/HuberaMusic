/**
 * Le téléphone (tas 256 Mo) lit toute la réponse JSON d'un coup.
 * Une bibliothèque de ~30 k titres avec 10 vignettes chacune dépasse ce tas.
 * On n'envoie qu'une vignette (aucune pour un id YouTube : la pochette vient de l'id)
 * et on coupe au-delà de 8 Mo pour qu'une réponse énorme ne sature plus le tas.
 */
export const CLIENT_JSON_MAX_BYTES = 8 * 1024 * 1024;

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

function slimNode(value: unknown, depth: number): unknown {
  if (depth > 8 || value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => slimNode(item, depth + 1));
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(src)) {
    if (key === 'thumbnails' && Array.isArray(child)) {
      const id = typeof src.id === 'string' ? src.id : '';
      out.thumbnails = VIDEO_ID.test(id) ? [] : child.slice(0, 1);
      continue;
    }
    out[key] = slimNode(child, depth + 1);
  }
  return out;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Réduit vignettes et listes pour que le JSON tienne dans le tas du client. */
export function fitClientJson(
  body: unknown,
  maxBytes = CLIENT_JSON_MAX_BYTES,
): { body: unknown; clipped: boolean } {
  if (body == null || typeof body !== 'object') return { body, clipped: false };
  let current = slimNode(body, 0);
  try {
    if (byteLength(current) <= maxBytes) return { body: current, clipped: false };
  } catch {
    return { body, clipped: false };
  }
  if (Array.isArray(current)) {
    return { body: { error: 'réponse trop volumineuse' }, clipped: true };
  }
  const obj = current as Record<string, unknown>;
  if (Array.isArray(obj.songs) && obj.totalSongs == null) obj.totalSongs = obj.songs.length;
  if (Array.isArray(obj.liked) && obj.totalLiked == null) obj.totalLiked = obj.liked.length;
  for (let guard = 0; guard < 8; guard += 1) {
    let cut = false;
    for (const [key, value] of Object.entries(obj)) {
      if (!Array.isArray(value) || value.length <= 24) continue;
      obj[key] = value.slice(0, Math.max(24, Math.floor(value.length * 0.7)));
      cut = true;
    }
    if (!cut) break;
    try {
      if (byteLength(obj) <= maxBytes) {
        obj.partial = true;
        return { body: obj, clipped: true };
      }
    } catch {
      break;
    }
  }
  return { body: { error: 'réponse trop volumineuse' }, clipped: true };
}
