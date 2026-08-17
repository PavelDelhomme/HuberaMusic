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
