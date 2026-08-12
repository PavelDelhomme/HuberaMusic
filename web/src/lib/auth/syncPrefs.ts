/** Sync lecture multi-appareils (file + titre + progress). Défaut : off = chaque appareil indépendant. */
const KEY = 'ytm_receive_remote_sync';
const MIGRATION = 'ytm_playback_sync_independent_v1';

function ensureIndependentDefault() {
  try {
    if (localStorage.getItem(MIGRATION) === '1') return;
    // Force lectures indépendantes (même si une ancienne sync était activée).
    localStorage.setItem(KEY, '0');
    localStorage.setItem(MIGRATION, '1');
  } catch {
    /* ignore */
  }
}

ensureIndependentDefault();

export function getReceiveRemoteSync(): boolean {
  try {
    ensureIndependentDefault();
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setReceiveRemoteSync(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('ytm-receive-remote-sync', { detail: { on } }));
}

/** Alias clair : sync lecture = publier ET recevoir. */
export function isPlaybackSyncEnabled(): boolean {
  return getReceiveRemoteSync();
}
