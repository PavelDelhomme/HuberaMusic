/** Création d’une tâche Hubera Docs (POST /api/tasks). Aucun secret en dur : le jeton est celui de la session appelante. */

export type DocsTaskInput = {
  title: string;
  body?: string;
  project?: string;
  category?: string;
  column_id?: string;
  priority?: number;
};

export type DocsTaskPayload = {
  title: string;
  body: string;
  project: string;
  category: 'bug';
  column_id: 'todo';
  priority: number;
};

export type DocsTaskResult = {
  ok: boolean;
  status: number;
  error?: string;
  id?: string;
  task: DocsTaskPayload;
};

const DEFAULT_ORIGIN = 'https://docs.hubera.cloud';

export function docsTaskPayload(task: DocsTaskInput): DocsTaskPayload {
  const priority = Number(task.priority);
  return {
    title: String(task.title || '').trim().slice(0, 180),
    body: String(task.body || ''),
    project: String(task.project || 'music').slice(0, 40) || 'music',
    category: 'bug',
    column_id: 'todo',
    priority: Number.isFinite(priority) && priority > 0 ? priority : 1,
  };
}

type DocsResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

async function readJson(res: DocsResponse): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Échange le jeton Hubera / Music contre une session Docs (allowlist côté Docs),
 * puis POST /api/tasks. Sans jeton, aucun appel : le payload reste disponible.
 */
export async function postDocsTask(
  task: DocsTaskInput,
  opts: {
    origin?: string;
    accessToken?: string;
    fetchImpl?: (url: string, init: RequestInit) => Promise<DocsResponse>;
  },
): Promise<DocsTaskResult> {
  const payload = docsTaskPayload(task);
  const origin = String(opts.origin || DEFAULT_ORIGIN).replace(/\/$/, '');
  const accessToken = String(opts.accessToken || '').trim();
  if (!payload.title) return { ok: false, status: 400, error: 'title', task: payload };
  if (!accessToken) return { ok: false, status: 0, error: 'auth', task: payload };

  const doFetch = opts.fetchImpl ?? fetch;
  const call = (url: string, init: RequestInit) =>
    doFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8000) });

  let session = '';
  try {
    const login = await call(`${origin}/api/auth/login/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    const loginBody = await readJson(login);
    const token = String(loginBody.token || '').trim();
    if (!login.ok || !token) {
      return {
        ok: false,
        status: login.status,
        error: String(loginBody.error || 'auth'),
        task: payload,
      };
    }
    session = token;
  } catch {
    return { ok: false, status: 0, error: 'unreachable', task: payload };
  }

  try {
    const created = await call(`${origin}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${session}`,
      },
      body: JSON.stringify(payload),
    });
    const createdBody = await readJson(created);
    if (!created.ok) {
      return {
        ok: false,
        status: created.status,
        error: String(createdBody.error || 'docs'),
        task: payload,
      };
    }
    const id = String(createdBody.id || '').trim();
    return { ok: true, status: created.status, id: id || undefined, task: payload };
  } catch {
    return { ok: false, status: 0, error: 'unreachable', task: payload };
  }
}
