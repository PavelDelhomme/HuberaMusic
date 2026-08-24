/**
 * Cache RAM lazy des têtes de stream — titre déjà warm → TTFB typique ≪ 50–100 ms.
 * Fenêtre bornée (LRU) : on ne garde que N têtes prêtes en mémoire.
 * L’audio m4a n’est pas re-compressé (déjà compressé) ; le gzip HTTP porte sur le JSON.
 */
const HEAD_BYTES = Math.max(
  256 * 1024,
  Number(process.env.STREAM_HEAD_BYTES || 768 * 1024) || 768 * 1024,
);
const MAX_HEADS = Math.max(4, Math.min(48, Number(process.env.STREAM_HEAD_CACHE || 16) || 16));
const HEAD_TTL_MS = 25 * 60_000;

type HeadEntry = {
  buf: Buffer;
  totalSize: number | null;
  contentType: string;
  at: number;
};

const heads = new Map<string, HeadEntry>();
const inflight = new Map<string, Promise<void>>();

function touch(id: string) {
  const e = heads.get(id);
  if (!e) return;
  heads.delete(id);
  heads.set(id, e);
  while (heads.size > MAX_HEADS) {
    const first = heads.keys().next().value;
    if (first === undefined) break;
    heads.delete(first);
  }
}

export function getStreamHeadBytes(): number {
  return HEAD_BYTES;
}

export function peekStreamHead(videoId: string): HeadEntry | null {
  const e = heads.get(videoId);
  if (!e) return null;
  if (Date.now() - e.at > HEAD_TTL_MS) {
    heads.delete(videoId);
    return null;
  }
  touch(videoId);
  return e;
}

export function putStreamHead(
  videoId: string,
  buf: Buffer,
  opts?: { totalSize?: number | null; contentType?: string },
): void {
  if (!buf.length) return;
  const slice = buf.length > HEAD_BYTES ? Buffer.from(buf.subarray(0, HEAD_BYTES)) : Buffer.from(buf);
  const existing = heads.get(videoId);
  if (
    existing &&
    existing.buf.length >= slice.length &&
    Date.now() - existing.at < HEAD_TTL_MS
  ) {
    touch(videoId);
    return;
  }
  heads.set(videoId, {
    buf: slice,
    totalSize: opts?.totalSize ?? existing?.totalSize ?? null,
    contentType: opts?.contentType || existing?.contentType || 'audio/mp4',
    at: Date.now(),
  });
  touch(videoId);
}

export function invalidateStreamHead(videoId: string): void {
  heads.delete(videoId);
  inflight.delete(videoId);
  advertisedTotals.delete(videoId);
}

/**
 * Total Content-Range annoncé au client pour ce titre (1ʳᵉ réponse).
 * ExoPlayer plante (EOF ~64 s) si home dit T1 puis le cache disque dit T2 ≠ T1.
 */
const advertisedTotals = new Map<string, number>();

export function rememberAdvertisedTotal(videoId: string, total: number | null | undefined): void {
  if (total == null || !Number.isFinite(total) || total <= 0) return;
  if (!advertisedTotals.has(videoId)) {
    advertisedTotals.set(videoId, Math.floor(total));
  }
  const head = heads.get(videoId);
  if (head && head.totalSize == null) {
    head.totalSize = Math.floor(total);
  }
}

/** Total stable à remettre dans Content-Range (préfère le 1ʳᵉ annoncé). */
export function stableContentTotal(videoId: string, fileSize: number): number {
  const remembered = advertisedTotals.get(videoId);
  const headTotal = peekStreamHead(videoId)?.totalSize ?? null;
  const preferred = remembered ?? headTotal;
  if (preferred != null && preferred > 0) {
    // Fichier un peu plus grand (yt-dlp vs GV) : garder le total déjà vu par Exo.
    if (fileSize >= preferred) return preferred;
    // Fichier plus petit : ne pas mentir au-delà de la taille réelle.
    return fileSize;
  }
  rememberAdvertisedTotal(videoId, fileSize);
  return fileSize;
}

/** Précharge une tête via Range sur googlevideo (ou équivalent). */
export async function warmStreamHead(
  videoId: string,
  fetchRange: (range: string) => Promise<globalThis.Response>,
): Promise<boolean> {
  const existing = heads.get(videoId);
  if (existing && Date.now() - existing.at < HEAD_TTL_MS / 2) {
    touch(videoId);
    return true;
  }
  const pending = inflight.get(videoId);
  if (pending) {
    await pending;
    return heads.has(videoId);
  }

  const job = (async () => {
    const range = `bytes=0-${HEAD_BYTES - 1}`;
    const upstream = await fetchRange(range);
    if (!(upstream.ok || upstream.status === 206) || !upstream.body) {
      throw new Error(`head warm ${upstream.status}`);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    let totalSize: number | null = null;
    const cr = upstream.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) totalSize = Number(m[1]);
    }
    const cl = upstream.headers.get('content-length');
    if (totalSize == null && cl && upstream.status === 200) {
      totalSize = Number(cl);
    }
    putStreamHead(videoId, buf, {
      totalSize,
      contentType: upstream.headers.get('content-type') || 'audio/mp4',
    });
  })();

  inflight.set(videoId, job);
  try {
    await job;
    return true;
  } catch {
    return false;
  } finally {
    inflight.delete(videoId);
  }
}

/** Warm lazy : seulement les `limit` premiers ids (fenêtre courte, pas toute la file). */
export function warmStreamHeadsLazy(
  ids: string[],
  fetchForId: (id: string) => Promise<(range: string) => Promise<globalThis.Response>>,
  limit = 6,
): void {
  const slice = ids.slice(0, Math.max(1, limit));
  void (async () => {
    for (const id of slice) {
      try {
        const fetchRange = await fetchForId(id);
        await warmStreamHead(id, fetchRange);
      } catch {
        /* best-effort */
      }
    }
  })();
}

export function streamHeadStats() {
  return { size: heads.size, max: MAX_HEADS, headBytes: HEAD_BYTES };
}
