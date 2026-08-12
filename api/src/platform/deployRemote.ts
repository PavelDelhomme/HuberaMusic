import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppEnv } from './mail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'deploy', 'admin-deploy-prod.sh');

export type DeployMode = 'web' | 'apk' | 'all';

let deployJob: {
  status: 'idle' | 'running' | 'ok' | 'error';
  mode?: DeployMode;
  startedAt?: number;
  finishedAt?: number;
  log: string;
} = { status: 'idle', log: '' };

export function getDeployJob() {
  return { ...deployJob };
}

export function deployAllowedFromThisHost() {
  const env = getAppEnv();
  if (env === 'local') return true;
  return process.env.ALLOW_REMOTE_ADMIN_DEPLOY === '1';
}

/** Méthode de redeploy VPS configurée (CE, sans webhook Pro). */
export function redeployMethod(): {
  method: 'ssh' | 'portainer-api' | 'watchtower-or-manual';
  label: string;
  ready: boolean;
} {
  if ((process.env.DEPLOY_SSH || '').trim()) {
    return { method: 'ssh', label: 'SSH (docker pull / restart)', ready: true };
  }
  if ((process.env.PORTAINER_URL || '').trim() && (process.env.PORTAINER_API_KEY || '').trim()) {
    return {
      method: 'portainer-api',
      label: 'Portainer API CE (Access Token)',
      ready: true,
    };
  }
  return {
    method: 'watchtower-or-manual',
    label: 'Watchtower (auto) ou Pull manuel Portainer',
    ready: false,
  };
}

export function startAdminDeploy(mode: DeployMode) {
  if (!deployAllowedFromThisHost()) {
    throw new Error('Déploiement Admin uniquement depuis APP_ENV=local (ton PC)');
  }
  if (deployJob.status === 'running') return getDeployJob();
  if (!['web', 'apk', 'all'].includes(mode)) {
    throw new Error('mode invalide (web|apk|all)');
  }

  deployJob = {
    status: 'running',
    mode,
    startedAt: Date.now(),
    log: `==> admin-deploy-prod.sh ${mode}\n`,
  };

  const child = spawn('bash', [SCRIPT, mode], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_ENV: process.env.APP_ENV || 'local',
    },
  });

  const append = (chunk: Buffer | string) => {
    deployJob.log += chunk.toString();
    if (deployJob.log.length > 80_000) deployJob.log = deployJob.log.slice(-64_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('close', (code) => {
    deployJob.status = code === 0 ? 'ok' : 'error';
    deployJob.finishedAt = Date.now();
    deployJob.log += `\n==> exit ${code}\n`;
  });
  child.on('error', (err) => {
    deployJob.status = 'error';
    deployJob.finishedAt = Date.now();
    deployJob.log += `\n${String(err)}\n`;
  });

  return getDeployJob();
}

export function deployAdminHints() {
  const prodUrl = (process.env.DEPLOY_URL || process.env.PROD_APP_URL || 'https://ytmusic.delhomme.ovh').replace(
    /\/$/,
    '',
  );
  const redeploy = redeployMethod();
  return {
    allowed: deployAllowedFromThisHost(),
    appEnv: getAppEnv(),
    prodUrl,
    redeploy,
    /** @deprecated webhooks = Portainer Pro — ne plus utiliser */
    portainerWebhookConfigured: false,
    job: getDeployJob(),
  };
}
