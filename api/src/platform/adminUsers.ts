import { db } from '../library/db.js';

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  isAdmin: boolean;
  ytmLinked: boolean;
  hasOauth: boolean;
  hasCookie: boolean;
};

/**
 * Titres à préchauffer (cache .m4a global) pour tous les comptes :
 * history récente + likes + library_tracks, dédupliqués.
 */
export function listWarmCandidates(opts?: {
  maxPerUser?: number;
  maxTotal?: number;
}): { trackId: string; why: string; email: string }[] {
  const maxPerUser = Math.max(10, Math.min(200, opts?.maxPerUser ?? 60));
  const maxTotal = Math.max(50, Math.min(2000, opts?.maxTotal ?? 500));
  const users = db
    .prepare(
      `SELECT id, email FROM users
       WHERE email NOT LIKE '%@local.ytmusic'
         AND email NOT LIKE 'ami-test-%'
         AND email NOT LIKE 'web-test-%'
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all() as { id: string; email: string }[];

  const out: { trackId: string; why: string; email: string }[] = [];
  const seen = new Set<string>();

  const push = (trackId: string, why: string, email: string) => {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(trackId) || seen.has(trackId)) return;
    seen.add(trackId);
    out.push({ trackId, why, email });
  };

  for (const u of users) {
    let n = 0;
    const hist = db
      .prepare(
        `SELECT track_id FROM history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?`,
      )
      .all(u.id, maxPerUser) as { track_id: string }[];
    for (const r of hist) {
      if (n >= maxPerUser) break;
      push(r.track_id, 'history', u.email);
      n += 1;
    }
    const liked = db
      .prepare(`SELECT track_id FROM liked_tracks WHERE user_id = ? LIMIT ?`)
      .all(u.id, maxPerUser) as { track_id: string }[];
    for (const r of liked) {
      if (n >= maxPerUser) break;
      push(r.track_id, 'liked', u.email);
      n += 1;
    }
    const lib = db
      .prepare(
        `SELECT track_id FROM library_tracks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(u.id, maxPerUser) as { track_id: string }[];
    for (const r of lib) {
      if (n >= maxPerUser) break;
      push(r.track_id, 'library', u.email);
      n += 1;
    }
    if (out.length >= maxTotal) break;
  }
  return out.slice(0, maxTotal);
}

export function listAdminUsers(limit = 200): AdminUserRow[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at AS createdAt, u.is_admin AS isAdmin,
              y.oauth_enc AS oauthEnc, y.cookie_enc AS cookieEnc
       FROM users u
       LEFT JOIN ytm_accounts y ON y.user_id = u.id
       WHERE u.email NOT LIKE '%@local.ytmusic'
       ORDER BY u.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    email: string;
    name: string;
    createdAt: number;
    isAdmin: number | null;
    oauthEnc: string | null;
    cookieEnc: string | null;
  }>;
  return rows.map((r) => {
    const hasOauth = Boolean(r.oauthEnc);
    const hasCookie = Boolean(r.cookieEnc);
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.createdAt,
      isAdmin: Boolean(r.isAdmin),
      ytmLinked: hasOauth || hasCookie,
      hasOauth,
      hasCookie,
    };
  });
}
