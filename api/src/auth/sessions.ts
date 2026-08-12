import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { db } from '../library/db.js';
import type { Track } from '../youtube/types.js';

export type DeviceType = 'web' | 'mobile' | 'desktop' | 'tv';

export type PlaybackState = {
  current: Track | null;
  queue: Track[];
  queueIndex: number;
  /** Fin exclusive de la file « utilisateur » (style YTM). */
  userQueueEnd?: number;
  /** Suggestions auto après la file. */
  autoplay?: boolean;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  updatedAt: number;
};

export type DeviceInfo = {
  id: string;
  name: string;
  type: DeviceType;
  canPlay: boolean;
  lastSeen: number;
};

type ConnectedDevice = DeviceInfo & {
  ws: WebSocket;
  userId: string;
};

type UserHub = {
  devices: Map<string, ConnectedDevice>;
  /** Appareils HTTP (Android) sans WebSocket — heartbeat. */
  softDevices: Map<string, DeviceInfo>;
  activePlayerId: string | null;
  state: PlaybackState;
};

const hubs = new Map<string, UserHub>();
const SOFT_TTL_MS = 120_000;

function emptyState(): PlaybackState {
  return {
    current: null,
    queue: [],
    queueIndex: 0,
    userQueueEnd: 0,
    autoplay: true,
    isPlaying: false,
    progress: 0,
    duration: 0,
    volume: 0.9,
    shuffle: false,
    repeat: 'off',
    updatedAt: Date.now(),
  };
}

function loadPersistedState(userId: string): PlaybackState | null {
  try {
    const row = db.prepare('SELECT payload FROM playback_state WHERE user_id = ?').get(userId) as
      | { payload: string }
      | undefined;
    if (!row?.payload) return null;
    const parsed = JSON.parse(row.payload) as PlaybackState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...emptyState(),
      ...parsed,
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch {
    return null;
  }
}

function persistState(userId: string, state: PlaybackState) {
  try {
    db.prepare(
      `INSERT INTO playback_state (user_id, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run(userId, JSON.stringify(state), Date.now());
  } catch {
    /* ignore */
  }
}

function getHub(userId: string): UserHub {
  let hub = hubs.get(userId);
  if (!hub) {
    hub = {
      devices: new Map(),
      softDevices: new Map(),
      activePlayerId: null,
      state: loadPersistedState(userId) || emptyState(),
    };
    hubs.set(userId, hub);
  } else if (!hub.softDevices) {
    hub.softDevices = new Map();
  }
  pruneSoftDevices(hub);
  return hub;
}

function pruneSoftDevices(hub: UserHub) {
  const now = Date.now();
  for (const [id, d] of hub.softDevices) {
    if (now - d.lastSeen > SOFT_TTL_MS) hub.softDevices.delete(id);
  }
}

function setHubState(userId: string, hub: UserHub, patch: Partial<PlaybackState>) {
  const nextQueue = Array.isArray(patch.queue) ? patch.queue : hub.state.queue;
  let userQueueEnd =
    typeof patch.userQueueEnd === 'number' ? patch.userQueueEnd : hub.state.userQueueEnd;
  if (typeof userQueueEnd !== 'number') userQueueEnd = nextQueue.length;
  userQueueEnd = Math.max(0, Math.min(userQueueEnd, nextQueue.length));

  hub.state = {
    ...hub.state,
    ...patch,
    queue: nextQueue,
    userQueueEnd,
    updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
  };
  persistState(userId, hub.state);
}

function publicDevices(hub: UserHub) {
  pruneSoftDevices(hub);
  const out = new Map<string, ReturnType<typeof mapPublicDevice>>();
  for (const d of hub.devices.values()) out.set(d.id, mapPublicDevice(d, hub.activePlayerId));
  for (const d of hub.softDevices.values()) {
    if (!out.has(d.id)) out.set(d.id, mapPublicDevice(d, hub.activePlayerId));
  }
  return [...out.values()];
}

function mapPublicDevice(d: DeviceInfo, activePlayerId: string | null) {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    canPlay: d.canPlay,
    isActive: d.id === activePlayerId,
    lastSeen: d.lastSeen,
  };
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(hub: UserHub, payload: unknown, exceptId?: string) {
  for (const d of hub.devices.values()) {
    if (exceptId && d.id === exceptId) continue;
    send(d.ws, payload);
  }
}

function pushSnapshot(hub: UserHub, to?: ConnectedDevice) {
  const payload = {
    type: 'snapshot',
    devices: publicDevices(hub),
    activePlayerId: hub.activePlayerId,
    state: hub.state,
  };
  if (to) send(to.ws, payload);
  else broadcast(hub, payload);
}

export function handleSessionMessage(
  userId: string,
  ws: WebSocket,
  raw: string,
  meta: { defaultName?: string },
) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const hub = getHub(userId);
  const type = String(msg.type || '');

  if (type === 'register') {
    const id = String(msg.deviceId || randomUUID());
    const device: ConnectedDevice = {
      id,
      name: String(msg.name || meta.defaultName || 'Appareil'),
      type: (msg.deviceType || 'web') as DeviceType,
      canPlay: msg.canPlay !== false,
      lastSeen: Date.now(),
      ws,
      userId,
    };
    hub.devices.set(id, device);
    if (!hub.activePlayerId && device.canPlay) {
      hub.activePlayerId = id;
    }
    send(ws, { type: 'registered', deviceId: id });
    pushSnapshot(hub);
    return id;
  }

  const deviceId = String(msg.deviceId || '');
  const device = hub.devices.get(deviceId);
  if (device) device.lastSeen = Date.now();

  switch (type) {
    case 'ping':
      send(ws, { type: 'pong', t: Date.now() });
      break;

    case 'rename':
      if (device && msg.name) {
        device.name = String(msg.name);
        pushSnapshot(hub);
      }
      break;

    case 'set_active': {
      const targetId = String(msg.targetId || '');
      const target = hub.devices.get(targetId);
      if (target?.canPlay) {
        hub.activePlayerId = targetId;
        send(target.ws, {
          type: 'become_player',
          state: hub.state,
        });
        broadcast(hub, { type: 'active_changed', activePlayerId: targetId, state: hub.state });
        pushSnapshot(hub);
      }
      break;
    }

    case 'state_update': {
      if (hub.activePlayerId && deviceId && deviceId !== hub.activePlayerId) {
        break;
      }
      const s = msg.state || {};
      setHubState(userId, hub, s);
      broadcast(
        hub,
        { type: 'state', state: hub.state, activePlayerId: hub.activePlayerId },
        deviceId,
      );
      break;
    }

    case 'command': {
      const active = hub.activePlayerId ? hub.devices.get(hub.activePlayerId) : null;
      if (!active) {
        if (device?.canPlay) {
          hub.activePlayerId = device.id;
          send(device.ws, { type: 'command', command: msg.command, from: deviceId });
          pushSnapshot(hub);
        }
        break;
      }
      send(active.ws, {
        type: 'command',
        command: msg.command,
        from: deviceId,
      });
      broadcast(
        hub,
        { type: 'command_echo', command: msg.command, from: deviceId },
        active.id,
      );
      break;
    }

    case 'transfer_and_play': {
      const targetId = String(msg.targetId || '');
      const target = hub.devices.get(targetId);
      if (!target?.canPlay) break;
      if (msg.state) {
        setHubState(userId, hub, msg.state);
      }
      hub.activePlayerId = targetId;
      send(target.ws, { type: 'become_player', state: hub.state, autoplay: true });
      broadcast(hub, {
        type: 'active_changed',
        activePlayerId: targetId,
        state: hub.state,
      });
      pushSnapshot(hub);
      break;
    }

    case 'get_snapshot':
      if (device) pushSnapshot(hub, device);
      else {
        send(ws, {
          type: 'snapshot',
          devices: publicDevices(hub),
          activePlayerId: hub.activePlayerId,
          state: hub.state,
        });
      }
      break;

    default:
      break;
  }
}

export function detachSocket(ws: WebSocket) {
  for (const [userId, hub] of hubs) {
    for (const [id, device] of hub.devices) {
      if (device.ws === ws) {
        hub.devices.delete(id);
        if (hub.activePlayerId === id) {
          const next =
            [...hub.devices.values()].find((d) => d.canPlay) ||
            [...hub.softDevices.values()].find((d) => d.canPlay);
          hub.activePlayerId = next?.id || null;
          if (next && 'ws' in next && (next as ConnectedDevice).ws) {
            send((next as ConnectedDevice).ws, { type: 'become_player', state: hub.state });
          }
        }
        persistState(userId, hub.state);
        pushSnapshot(hub);
        if (hub.devices.size === 0 && hub.softDevices.size === 0) hubs.delete(userId);
        return;
      }
    }
  }
}

export function getHubPublic(userId: string) {
  const hub = getHub(userId);
  return {
    devices: publicDevices(hub),
    activePlayerId: hub.activePlayerId,
    state: hub.state,
  };
}

/** Enregistre / heartbeat un appareil HTTP (Android) pour qu’il apparaisse dans la liste. */
export function touchHttpDevice(
  userId: string,
  info: { id: string; name?: string; type?: DeviceType; canPlay?: boolean },
) {
  const hub = getHub(userId);
  const id = String(info.id || '').trim();
  if (!id) return getHubPublic(userId);
  // Si déjà en WS, juste rafraîchir lastSeen
  const wsDev = hub.devices.get(id);
  if (wsDev) {
    wsDev.lastSeen = Date.now();
    if (info.name) wsDev.name = String(info.name);
    return getHubPublic(userId);
  }
  hub.softDevices.set(id, {
    id,
    name: String(info.name || 'Android'),
    type: (info.type || 'mobile') as DeviceType,
    canPlay: info.canPlay !== false,
    lastSeen: Date.now(),
  });
  if (!hub.activePlayerId && info.canPlay !== false) {
    // Soft device peut être actif (Android joue) même sans WS
    hub.activePlayerId = id;
    broadcast(hub, { type: 'active_changed', activePlayerId: id, state: hub.state });
  }
  pushSnapshot(hub);
  return getHubPublic(userId);
}

export function setActiveDeviceHttp(userId: string, targetId: string) {
  const hub = getHub(userId);
  const id = String(targetId || '');
  const wsTarget = hub.devices.get(id);
  const soft = hub.softDevices.get(id);
  if (!wsTarget && !soft) return getHubPublic(userId);
  if ((wsTarget && !wsTarget.canPlay) || (soft && !soft.canPlay)) return getHubPublic(userId);
  hub.activePlayerId = id;
  if (wsTarget) {
    send(wsTarget.ws, { type: 'become_player', state: hub.state });
  }
  broadcast(hub, { type: 'active_changed', activePlayerId: id, state: hub.state });
  pushSnapshot(hub);
  return getHubPublic(userId);
}

export function transferPlaybackHttp(
  userId: string,
  targetId: string,
  state?: Partial<PlaybackState>,
) {
  const hub = getHub(userId);
  const id = String(targetId || '');
  const wsTarget = hub.devices.get(id);
  const soft = hub.softDevices.get(id);
  if (!wsTarget?.canPlay && !soft?.canPlay) return getHubPublic(userId);
  if (state) setHubState(userId, hub, state);
  hub.activePlayerId = id;
  if (wsTarget) {
    send(wsTarget.ws, { type: 'become_player', state: hub.state, autoplay: true });
  }
  broadcast(hub, { type: 'active_changed', activePlayerId: id, state: hub.state });
  pushSnapshot(hub);
  return getHubPublic(userId);
}

/**
 * HTTP : publier l’état de lecture (mobile sans WS).
 * - LWW via updatedAt
 * - Si un autre appareil WS est actif, n’accepte que si force=true ou deviceId = actif
 */
export function publishPlaybackState(
  userId: string,
  patch: Partial<PlaybackState> & { force?: boolean },
  opts?: { deviceId?: string; force?: boolean },
) {
  const hub = getHub(userId);
  const deviceId = opts?.deviceId || '';
  const force = Boolean(opts?.force || patch.force);

  const incomingAt = typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now();
  if (incomingAt + 2000 < (hub.state.updatedAt || 0) && !force) {
    // Patch plus vieux → ignorer (évite écrasement file)
    return getHubPublic(userId);
  }

  const active = hub.activePlayerId;
  if (active && deviceId && active !== deviceId && !force) {
    // Soft take-over : l’appareil appuie play → devient actif (sinon Android refuse le claim)
    if (patch.isPlaying === true) {
      hub.activePlayerId = deviceId;
      const soft = hub.softDevices.get(deviceId);
      if (soft) soft.lastSeen = Date.now();
      const d = hub.devices.get(deviceId);
      if (d) d.lastSeen = Date.now();
    } else if (Array.isArray(patch.queue) && patch.queue.length) {
      // Autre appareil actif : n’écrase pas la file entière
      // Accepte quand même progress/isPlaying sans queue
      const { queue: _q, queueIndex: _i, current: _c, ...light } = patch as Partial<PlaybackState> & {
        queue?: unknown;
        queueIndex?: unknown;
        current?: unknown;
      };
      if (typeof light.progress === 'number' || typeof light.isPlaying === 'boolean') {
        setHubState(userId, hub, { ...light, updatedAt: incomingAt });
        broadcast(hub, { type: 'state', state: hub.state, activePlayerId: hub.activePlayerId });
      }
      return getHubPublic(userId);
    }
  }

  // Soft heartbeat si deviceId fourni
  if (deviceId && !hub.devices.has(deviceId)) {
    const soft = hub.softDevices.get(deviceId);
    if (soft) soft.lastSeen = Date.now();
  }

  const { force: _f, ...clean } = patch as Partial<PlaybackState> & { force?: boolean };
  setHubState(userId, hub, clean);
  broadcast(hub, { type: 'state', state: hub.state, activePlayerId: hub.activePlayerId });
  return getHubPublic(userId);
}
