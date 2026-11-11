/**
 * Lien Cloudity ID ↔ user PLM (opt-in).
 * Défaut : no-op tant que CLOUDITY_SSO / EXPO n’est pas activé côté API.
 */
const FLAG =
  String(process.env.CLOUDITY_SSO_ENABLED || process.env.YTM_CLOUDITY_SSO || '')
    .toLowerCase()
    .trim();

export function isClouditySSOEnabled(): boolean {
  return FLAG === '1' || FLAG === 'true' || FLAG === 'yes' || FLAG === 'on';
}

export type CloudityLinkResult = {
  linked: boolean;
  skipped?: boolean;
  reason?: string;
  cloudityUserId?: string;
};

/**
 * Demande à Cloudity auth-service d’enregistrer le lien.
 * Ne remplace jamais le login local PLM.
 */
export async function linkCloudityAccount(opts: {
  cloudityAccessToken: string;
  plmUserId: string;
  email: string;
  authBaseUrl?: string;
}): Promise<CloudityLinkResult> {
  if (!isClouditySSOEnabled()) {
    return { linked: false, skipped: true, reason: 'CLOUDITY_SSO_ENABLED off' };
  }
  const base = (opts.authBaseUrl || process.env.CLOUDITY_AUTH_URL || '').replace(/\/$/, '');
  if (!base) {
    return { linked: false, skipped: true, reason: 'CLOUDITY_AUTH_URL manquant' };
  }
  const res = await fetch(`${base}/auth/identity/link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.cloudityAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      app_id: 'ytmusic',
      external_user_id: String(opts.plmUserId),
      email: String(opts.email || '').toLowerCase().trim(),
    }),
  });
  if (res.status === 404) {
    return { linked: false, skipped: true, reason: 'SSO non déployé côté Cloudity' };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { linked: false, reason: `HTTP ${res.status} ${body.slice(0, 200)}` };
  }
  const data = (await res.json()) as { cloudity_user_id?: string | number };
  return {
    linked: true,
    cloudityUserId: data.cloudity_user_id != null ? String(data.cloudity_user_id) : undefined,
  };
}
