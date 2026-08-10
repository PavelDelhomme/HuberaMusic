import { apiOrigin, getToken } from '../api';
import type { Track } from '../api';
import { Capacitor } from '@capacitor/core';

export type DeviceType = 'web' | 'mobile' | 'desktop' | 'tv';

export type RemoteDevice = {
  id: string;
  name: string;
  type: DeviceType;
  canPlay: boolean;
  isActive: boolean;
  lastSeen: number;
};

export type PlaybackState = {
  current: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  updatedAt: number;
};

type Handlers = {
  onSnapshot?: (data: { devices: RemoteDevice[]; activePlayerId: string | null; state: PlaybackState }) => void;
  onState?: (state: PlaybackState, activePlayerId: string | null) => void;
  onCommand?: (command: any) => void;
  onBecomePlayer?: (state: PlaybackState, autoplay?: boolean) => void;
  onActiveChanged?: (activePlayerId: string | null, state: PlaybackState) => void;
  onRegistered?: (deviceId: string) => void;
  onDisconnected?: () => void;
};

const DEVICE_KEY = 'ytm_device';
const NAME_KEY = 'ytm_device_name';

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getDeviceName() {
  return localStorage.getItem(NAME_KEY) || guessDefaultName();
}

export function setDeviceName(name: string) {
  localStorage.setItem(NAME_KEY, name);
}

function guessDefaultName() {
  try {
    if (Capacitor.isNativePlatform()) {
      return Capacitor.getPlatform() === 'android' ? 'Android · PLM' : 'iOS · PLM';
    }
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent;
  if (/TV|SmartTV|WebOS|Tizen/i.test(ua)) return 'Télé';
  if (/Mobile|Android|iPhone/i.test(ua)) return 'Téléphone';
  if ((window as any).ytmDesktop?.isDesktop) return 'Ordinateur (desktop)';
  return `Navigateur · ${navigator.platform || 'Web'}`;
}

export function guessDeviceType(): DeviceType {
  try {
    if (Capacitor.isNativePlatform()) return 'mobile';
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent;
  if (/TV|SmartTV|WebOS|Tizen/i.test(ua) || location.pathname.startsWith('/tv')) return 'tv';
  if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
  if ((window as any).ytmDesktop?.isDesktop) return 'desktop';
  return 'web';
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private handlers: Handlers = {};
  private deviceId = getDeviceId();
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private reconnectAttempt = 0;

  get id() {
    return this.deviceId;
  }

  connect(handlers: Handlers) {
    this.handlers = handlers;
    this.intentionalClose = false;
    this.open();
  }

  private open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const token = getToken() || '';
    // Prod privée : sans JWT le serveur ferme en 4401 — attendre d’être connecté
    if (!token) {
      this.reconnectAttempt += 1;
      const delay = Math.min(15_000, 800 * 2 ** Math.min(this.reconnectAttempt, 4));
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
      return;
    }
    const qs = new URLSearchParams({
      device: this.deviceId,
      token,
    });
    const origin = apiOrigin();
    let url: string;
    if (origin) {
      const u = new URL(origin);
      const proto = u.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${u.host}/ws?${qs}`;
    } else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${location.host}/ws?${qs}`;
    }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.send({
        type: 'register',
        deviceId: this.deviceId,
        name: getDeviceName(),
        deviceType: guessDeviceType(),
        canPlay: true,
      });
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'registered':
          this.deviceId = msg.deviceId;
          this.handlers.onRegistered?.(msg.deviceId);
          break;
        case 'snapshot':
          this.handlers.onSnapshot?.(msg);
          break;
        case 'state':
          this.handlers.onState?.(msg.state, msg.activePlayerId);
          break;
        case 'command':
          this.handlers.onCommand?.(msg.command);
          break;
        case 'become_player':
          this.handlers.onBecomePlayer?.(msg.state, msg.autoplay);
          break;
        case 'active_changed':
          this.handlers.onActiveChanged?.(msg.activePlayerId, msg.state);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.handlers.onDisconnected?.();
      if (!this.intentionalClose) {
        // Backoff pendant un redeploy (502) : 1.5s → ~30s max
        const delay = Math.min(30_000, 1500 * 2 ** Math.min(this.reconnectAttempt, 4));
        this.reconnectAttempt += 1;
        this.reconnectTimer = window.setTimeout(() => this.open(), delay);
      }
    };
  }

  send(payload: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ ...payload, deviceId: this.deviceId }));
  }

  publishState(state: Partial<PlaybackState>) {
    this.send({ type: 'state_update', state });
  }

  command(command: Record<string, unknown>) {
    this.send({ type: 'command', command });
  }

  setActive(targetId: string) {
    this.send({ type: 'set_active', targetId });
  }

  transfer(targetId: string, state?: Partial<PlaybackState>) {
    this.send({ type: 'transfer_and_play', targetId, state });
  }

  rename(name: string) {
    setDeviceName(name);
    this.send({ type: 'rename', name });
  }

  close() {
    this.intentionalClose = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const sessionSocket = new SessionSocket();
