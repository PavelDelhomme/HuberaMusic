/** Flags locaux pour l’UX passkey (bouton login + prompt post-connexion). */

const READY_KEY = 'ytm_passkey_ready';
const DISMISS_KEY = 'ytm_passkey_offer_dismissed';

export function passkeyPlatformOk(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

export function hasLocalPasskeyReady(): boolean {
  try {
    return localStorage.getItem(READY_KEY) === '1';
  } catch {
    return false;
  }
}

export function markLocalPasskeyReady() {
  try {
    localStorage.setItem(READY_KEY, '1');
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

export function wasPasskeyOfferDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissPasskeyOffer() {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* ignore */
  }
}
