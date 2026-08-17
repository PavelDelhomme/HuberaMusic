import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PATH = join(ROOT, 'data', 'runtime-settings.json');

export type RuntimeSettings = {
  /** null = suivre AUTH_ALLOW_REGISTER / mode privé */
  allowRegister: boolean | null;
  updatedAt: number | null;
};

const DEFAULTS: RuntimeSettings = { allowRegister: null, updatedAt: null };

function ensureDir() {
  const dir = join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadRuntimeSettings(): RuntimeSettings {
  try {
    if (!existsSync(PATH)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Partial<RuntimeSettings>;
    return {
      allowRegister: typeof raw.allowRegister === 'boolean' ? raw.allowRegister : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  ensureDir();
  const next: RuntimeSettings = {
    ...loadRuntimeSettings(),
    ...patch,
    updatedAt: Date.now(),
  };
  writeFileSync(PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function allowRegisterOverride(): boolean | null {
  return loadRuntimeSettings().allowRegister;
}
