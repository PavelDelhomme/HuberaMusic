/**
 * Journal des requêtes de flux, titre par titre.
 *
 * Quand le téléphone signale « onPlayerError code=2001 », la moitié de
 * l'histoire est côté serveur : le morceau était-il en cache, quel relais a
 * répondu, en combien de temps, avec quel code. Rien de tout cela n'était
 * conservé — les traces partaient sur la sortie standard du conteneur, sans
 * moyen de les recouper avec l'erreur reçue.
 *
 * Une ligne par requête servie, purgée au bout de quelques jours : assez pour
 * reconstituer ce qui s'est passé autour d'une erreur, pas assez pour peser.
 */
import type { Request, Response } from 'express';
import { db } from '../library/db.js';

/** Au-delà, la trace n'a plus d'intérêt : l'incident est analysé ou oublié. */
const RETENTION_MS = Number(process.env.STREAM_LOG_RETENTION_MS || 4 * 24 * 3_600_000);

let ready = false;

function ensureSchema() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      status INTEGER,
      source TEXT,
      bytes INTEGER,
      ms INTEGER,
      range TEXT,
      client TEXT,
      user_id TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stream_log_track ON stream_log(track_id, at);
    CREATE INDEX IF NOT EXISTS idx_stream_log_at ON stream_log(at);
  `);
  ready = true;
}

export type StreamLogRow = {
  at: number;
  status: number | null;
  source: string | null;
  bytes: number | null;
  ms: number | null;
  range: string | null;
  client: string | null;
  user_id: string | null;
  note: string | null;
};

/**
 * Chemin emprunté pour servir la requête (cache RAM, disque, relais maison,
 * googlevideo…). Posé au fil du traitement, lu à la fin.
 */
type Tracked = Response & {
  __plmStreamSource?: string;
  __plmStreamNote?: string;
};

export function noteStreamSource(res: Response, source: string) {
  (res as Tracked).__plmStreamSource = source;
}

/** Raison d'un échec, telle qu'on l'a comprise au moment où il survient. */
export function noteStreamNote(res: Response, note: string) {
  const cur = (res as Tracked).__plmStreamNote;
  (res as Tracked).__plmStreamNote = cur ? `${cur} | ${note}`.slice(0, 400) : note.slice(0, 400);
}

function clientOf(req: Request): string {
  if (String(req.headers['x-ytm-client'] || '') === 'android') return 'android';
  if (/PLM-Android/i.test(String(req.headers['user-agent'] || ''))) return 'android';
  if (String(req.query?.client || '') === 'android') return 'android';
  if (/Electron/i.test(String(req.headers['user-agent'] || ''))) return 'desktop';
  return 'web';
}

/**
 * Enregistre l'issue de la requête une fois la réponse terminée — y compris
 * quand le client raccroche en cours de route, cas fréquent et instructif :
 * c'est exactement ce que fait ExoPlayer quand il abandonne un morceau.
 */
export function watchStreamRequest(req: Request, res: Response, trackId: string) {
  ensureSchema();
  const startedAt = Date.now();
  let done = false;
  const finish = (aborted: boolean) => {
    if (done) return;
    done = true;
    try {
      const t = res as Tracked;
      const note = [t.__plmStreamNote, aborted ? 'client parti avant la fin' : '']
        .filter(Boolean)
        .join(' | ');
      db.prepare(
        `INSERT INTO stream_log (track_id, at, status, source, bytes, ms, range, client, user_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        trackId,
        startedAt,
        res.statusCode || null,
        t.__plmStreamSource || null,
        Number(res.getHeader('Content-Length') || 0) || null,
        Date.now() - startedAt,
        String(req.headers.range || '').slice(0, 60) || null,
        clientOf(req),
        (req as Request & { userId?: string }).userId || null,
        note || null,
      );
    } catch {
      /* une trace manquée ne doit jamais casser une lecture */
    }
    prune();
  };
  res.on('finish', () => finish(false));
  res.on('close', () => finish(!res.writableEnded));
}

let lastPrune = 0;

function prune() {
  const now = Date.now();
  if (now - lastPrune < 600_000) return;
  lastPrune = now;
  try {
    db.prepare('DELETE FROM stream_log WHERE at < ?').run(now - RETENTION_MS);
  } catch {
    /* ignore */
  }
}

export function recentStreamEvents(trackId: string, limit = 40): StreamLogRow[] {
  ensureSchema();
  try {
    return db
      .prepare(
        `SELECT at, status, source, bytes, ms, range, client, user_id, note
           FROM stream_log WHERE track_id = ? ORDER BY at DESC LIMIT ?`,
      )
      .all(trackId, limit) as StreamLogRow[];
  } catch {
    return [];
  }
}

/** Vue d'ensemble d'un titre : combien de requêtes, combien ont échoué. */
export function streamSummary(trackId: string): {
  total: number;
  failed: number;
  firstAt: number | null;
  lastAt: number | null;
} {
  ensureSchema();
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed,
                MIN(at) AS firstAt, MAX(at) AS lastAt
           FROM stream_log WHERE track_id = ?`,
      )
      .get(trackId) as { total: number; failed: number; firstAt: number; lastAt: number };
    return {
      total: row?.total || 0,
      failed: row?.failed || 0,
      firstAt: row?.firstAt || null,
      lastAt: row?.lastAt || null,
    };
  } catch {
    return { total: 0, failed: 0, firstAt: null, lastAt: null };
  }
}
