/**
 * Hubera ID SSO Integration for HuberaMusic
 * 
 * Provides cross-app Single Sign-On via Hubera ID.
 * Users logged into any Hubera app will see "Continue with {email}"
 * when opening HuberaMusic.
 */

const HUBERA_ID_URL = import.meta.env.VITE_HUBERA_ID_URL || 'https://id.hubera.cloud';
const DEVICE_ID_KEY = 'hubera_device_id';
const HUBERA_SESSION_KEY = 'hubera_id_session';

export const APP_ID = 'music';

export interface HuberaIdSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  email: string;
  expiresIn: number;
  linkedAt?: string;
}

export interface HuberaDetectResult {
  found: boolean;
  email?: string;
  huberaUserId?: number;
  lastSeen?: string;
  canQuickLogin?: boolean;
  reason?: string;
}

export interface HuberaQuickLoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  email: string;
  expiresIn: number;
  quickLogin: boolean;
  sourceApp: string;
  targetApp: string;
}

export interface HuberaIdentityLink {
  appId: string;
  externalUserId: string;
  emailNormalized: string;
  linkedAt: string;
}

export function getHuberaIdUrl(): string {
  return HUBERA_ID_URL.replace(/\/$/, '');
}

export function getDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export async function detectHuberaSession(): Promise<HuberaDetectResult> {
  try {
    const deviceId = getDeviceId();
    const response = await fetch(`${getHuberaIdUrl()}/auth/identity/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId }),
    });

    if (!response.ok) {
      return { found: false, reason: 'api_error' };
    }

    const data = await response.json();
    return {
      found: data.found === true,
      email: data.email,
      huberaUserId: data.hubera_user_id,
      lastSeen: data.last_seen,
      canQuickLogin: data.can_quick_login === true,
      reason: data.reason,
    };
  } catch (error) {
    console.warn('[HuberaID] detect error:', error);
    return { found: false, reason: 'network_error' };
  }
}

export async function quickLoginWithHuberaId(): Promise<HuberaQuickLoginResult | null> {
  try {
    const deviceId = getDeviceId();
    const response = await fetch(`${getHuberaIdUrl()}/auth/identity/quick-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId,
        target_app: APP_ID,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('[HuberaID] quick-login failed:', errorData);
      return null;
    }

    const data = await response.json();
    
    const session: HuberaIdSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user_id,
      tenantId: data.tenant_id,
      email: data.email,
      expiresIn: data.expires_in,
      linkedAt: new Date().toISOString(),
    };
    localStorage.setItem(HUBERA_SESSION_KEY, JSON.stringify(session));

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user_id,
      tenantId: data.tenant_id,
      email: data.email,
      expiresIn: data.expires_in,
      quickLogin: data.quick_login === true,
      sourceApp: data.source_app,
      targetApp: data.target_app,
    };
  } catch (error) {
    console.error('[HuberaID] quick-login error:', error);
    return null;
  }
}

export async function loginWithHuberaId(
  email: string,
  password: string
): Promise<HuberaIdSession | null> {
  try {
    const deviceId = getDeviceId();
    const response = await fetch(`${getHuberaIdUrl()}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        device_id: deviceId,
        app_id: APP_ID,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Login failed');
    }

    const data = await response.json();

    if (data.requires_2fa) {
      return null;
    }

    const session: HuberaIdSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user_id,
      tenantId: data.tenant_id,
      email: email,
      expiresIn: data.expires_in,
    };

    localStorage.setItem(HUBERA_SESSION_KEY, JSON.stringify(session));
    return session;
  } catch (error) {
    console.error('[HuberaID] login error:', error);
    throw error;
  }
}

export async function linkToHuberaId(
  huberaAccessToken: string,
  localUserId: string,
  localEmail: string
): Promise<boolean> {
  try {
    const response = await fetch(`${getHuberaIdUrl()}/auth/identity/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${huberaAccessToken}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        external_user_id: localUserId,
        email: localEmail,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('[HuberaID] link failed:', errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[HuberaID] link error:', error);
    return false;
  }
}

export async function getHuberaIdLinks(
  huberaAccessToken: string
): Promise<HuberaIdentityLink[]> {
  try {
    const response = await fetch(`${getHuberaIdUrl()}/auth/identity/links`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${huberaAccessToken}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return (data.links || []).map((link: any) => ({
      appId: link.app_id,
      externalUserId: link.external_user_id,
      emailNormalized: link.email_normalized,
      linkedAt: link.linked_at,
    }));
  } catch (error) {
    console.warn('[HuberaID] get links error:', error);
    return [];
  }
}

export async function refreshHuberaSession(): Promise<HuberaIdSession | null> {
  try {
    const sessionRaw = localStorage.getItem(HUBERA_SESSION_KEY);
    if (!sessionRaw) return null;

    const session: HuberaIdSession = JSON.parse(sessionRaw);
    
    const response = await fetch(`${getHuberaIdUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });

    if (!response.ok) {
      localStorage.removeItem(HUBERA_SESSION_KEY);
      return null;
    }

    const data = await response.json();
    const newSession: HuberaIdSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: session.userId,
      tenantId: session.tenantId,
      email: session.email,
      expiresIn: data.expires_in,
    };

    localStorage.setItem(HUBERA_SESSION_KEY, JSON.stringify(newSession));
    return newSession;
  } catch (error) {
    console.warn('[HuberaID] refresh error:', error);
    return null;
  }
}

export function getStoredHuberaSession(): HuberaIdSession | null {
  try {
    const sessionRaw = localStorage.getItem(HUBERA_SESSION_KEY);
    if (!sessionRaw) return null;
    return JSON.parse(sessionRaw);
  } catch {
    return null;
  }
}

export function clearHuberaSession(): void {
  localStorage.removeItem(HUBERA_SESSION_KEY);
}

export async function validateHuberaToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${getHuberaIdUrl()}/auth/validate`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) return false;

    const data = await response.json();
    return data.valid === true;
  } catch {
    return false;
  }
}
