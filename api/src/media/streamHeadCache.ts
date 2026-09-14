/**
 * Cache RAM lazy des têtes de stream — titre déjà warm → TTFB typique ≪ 50–100 ms.
 * Fenêtre bornée (LRU) : on ne garde que N têtes prêtes en mémoire.
 * L’audio m4a n’est pas re-compressé (déjà compressé) ; le gzip HTTP porte sur le JSON.
 */
const HEAD_BYTES = Math.max(
  256 * 1024,
  Number(process.env.STREAM_HEAD_BYTES || 1024 * 1024) || 1024 * 1024,
);
const MAX_HEADS = Math.max(8, Math.min(128, Number(process.env.STREAM_HEAD_CACHE || 64) || 64));
const HEAD_TTL_MS = 35 * 60_000;

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
  const next = Math.floor(total);
  const prev = advertisedTotals.get(videoId);
  // Ne jamais rétrécir : un total partiel (.m4a encore en téléchargement) → Exo EOF ~30 s.
  if (prev == null || next > prev) {
    advertisedTotals.set(videoId, next);
  }
  const head = heads.get(videoId);
  if (head && (head.totalSize == null || next > head.totalSize)) {
    head.totalSize = advertisedTotals.get(videoId) ?? next;
  }
}

/**
 * Total Content-Range à annoncer.
 * `incomplete` = fichier disque encore en cours de téléchargement : ne jamais
 * annoncer la taille partielle (sinon le lecteur coupe à ~30 s puis « reprend »).
 */
export function stableContentTotal(
  videoId: string,
  fileSize: number,
  opts?: { incomplete?: boolean },
): number {
  const remembered = advertisedTotals.get(videoId);
  const headTotal = peekStreamHead(videoId)?.totalSize ?? null;
  const preferred = remembered ?? headTotal;
  const incomplete = Boolean(opts?.incomplete);

  if (incomplete) {
    if (preferred != null && preferred > 0) {
      // Garde le plus grand connu ; n’enregistre pas un partiel plus petit.
      return Math.max(preferred, fileSize);
    }
    // Pas encore de total fiable : on n’ancre pas le partiel comme vérité.
    return fileSize;
  }

  if (preferred != null && preferred > 0) {
    // Fichier final plus grand que l’annonce → upgrade (yt-dlp vs home).
    if (fileSize > preferred + 64 * 1024) {
      advertisedTotals.set(videoId, fileSize);
      return fileSize;
    }
    // Fichier final un peu plus petit mais cohérent → garder l’annonce (évite EOF Exo).
    if (fileSize >= preferred) return preferred;
    // Partiel / race : ne jamais renvoyer un total < déjà annoncé.
    if (fileSize > 0 && fileSize < preferred) return preferred;
    return preferred;
  }
  rememberAdvertisedTotal(videoId, fileSize);
  return fileSize;
}

/** Total déjà annoncé au client (s’il existe). */
export function getAdvertisedTotal(videoId: string): number | null {
  return advertisedTotals.get(videoId) ?? null;
}

/**
 * Sert un Range depuis le .m4a disque sans jamais planter createReadStream
 * (start > end → RangeError unhandledRejection en prod).
 */
export function safeDiskRangeBounds(
  size: number,
  rangeHdr: string,
): { ok: false; status: 416 } | { ok: true; start: number; end: number } {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, status: 416 };
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
  let start = m ? Number(m[1]) : 0;
  let end = m && m[2] !== '' && m[2] != null ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end)) end = size - 1;
  // Past EOF (Exo en fin de titre demande souvent start === size)
  if (start >= size) return { ok: false, status: 416 };
  end = Math.min(end, size - 1);
  if (end < start) return { ok: false, status: 416 };
  return { ok: true, start, end };
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
