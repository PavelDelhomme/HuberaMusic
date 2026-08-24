import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PATH = join(ROOT, 'data', 'runtime-settings.json');

export type RuntimeSettings = {
  /** null = suivre AUTH_ALLOW_REGISTER / mode privé */
  allowRegister: boolean | null;
  /** Bannière / écran maintenance (ops, DNS, incidents) */
  maintenance: boolean;
  maintenanceMessage: string | null;
  /** Epoch ms — auto-désactivation passée cette date */
  maintenanceUntil: number | null;
  /** Si true, les clients devraient refuser de lancer le stream */
  maintenanceBlockPlayback: boolean;
  updatedAt: number | null;
};

const DEFAULTS: RuntimeSettings = {
  allowRegister: null,
  maintenance: false,
  maintenanceMessage: null,
  maintenanceUntil: null,
  maintenanceBlockPlayback: false,
  updatedAt: null,
};

function ensureDir() {
  const dir = join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalize(raw: Partial<RuntimeSettings>): RuntimeSettings {
  return {
    allowRegister: typeof raw.allowRegister === 'boolean' ? raw.allowRegister : null,
    maintenance: raw.maintenance === true,
    maintenanceMessage:
      typeof raw.maintenanceMessage === 'string' && raw.maintenanceMessage.trim()
        ? raw.maintenanceMessage.trim().slice(0, 500)
        : null,
    maintenanceUntil:
      typeof raw.maintenanceUntil === 'number' && Number.isFinite(raw.maintenanceUntil)
        ? raw.maintenanceUntil
        : null,
    maintenanceBlockPlayback: raw.maintenanceBlockPlayback === true,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
  };
}

/** Applique l’expiration auto du mode maintenance. */
export function effectiveRuntimeSettings(base?: RuntimeSettings): RuntimeSettings {
  const s = base ? { ...base } : loadRuntimeSettingsRaw();
  if (
    s.maintenance &&
    s.maintenanceUntil != null &&
    Number.isFinite(s.maintenanceUntil) &&
    Date.now() >= s.maintenanceUntil
  ) {
    const cleared = saveRuntimeSettings({
      maintenance: false,
      maintenanceMessage: null,
      maintenanceUntil: null,
      maintenanceBlockPlayback: false,
    });
    return cleared;
  }
  return s;
}

function loadRuntimeSettingsRaw(): RuntimeSettings {
  try {
    if (!existsSync(PATH)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Partial<RuntimeSettings>;
    return normalize({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadRuntimeSettings(): RuntimeSettings {
  return effectiveRuntimeSettings();
}

export function saveRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  ensureDir();
  const cur = loadRuntimeSettingsRaw();
  const next = normalize({
    ...cur,
    ...patch,
    updatedAt: Date.now(),
  });
  writeFileSync(PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return effectiveRuntimeSettings(next);
}

export function allowRegisterOverride(): boolean | null {
  return loadRuntimeSettings().allowRegister;
}

/** Payload public (health / auth config / clients). */
export function publicMaintenanceStatus() {
  const s = loadRuntimeSettings();
  return {
    active: s.maintenance === true,
    message:
      s.maintenanceMessage ||
      (s.maintenance
        ? 'PLM est en maintenance — réessaie dans un instant.'
        : null),
    until: s.maintenanceUntil,
    blockPlayback: s.maintenance === true && s.maintenanceBlockPlayback === true,
  };
}
