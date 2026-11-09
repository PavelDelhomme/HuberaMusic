import assert from 'node:assert/strict';
import { postDocsTask } from '../../../../api/src/platform/docsTask.ts';
import { docsTaskFromGroup, groupErrorSignatures } from './groupErrors.ts';

const groups = groupErrorSignatures([
  { level: 'error', kind: 'android.player', message: 'INSTALL_PARSE_FAILED_NOT_APK 12' },
  { level: 'error', kind: 'android.player', message: 'INSTALL_PARSE_FAILED_NOT_APK 99' },
  { level: 'info', kind: 'android.player', message: 'ok' },
  { level: 'fatal', kind: 'mail.imap', message: 'timeout' },
]);

assert.equal(groups.length, 2);
assert.equal(groups[0].count, 2);
assert.equal(groups[0].app, 'android');
assert.equal(groups[1].app, 'mail');
const task = docsTaskFromGroup(groups[0]);
assert.equal(task.category, 'bug');
assert.equal(task.column_id, 'todo');
assert.match(task.title, /INSTALL_PARSE_FAILED_NOT_APK/);
const empty = groupErrorSignatures([]);
assert.equal(empty.length, 0);

const calls: { url: string; body: string; authorization?: string }[] = [];
const created = await postDocsTask(task, {
  origin: 'https://docs.hubera.cloud',
  accessToken: 'music-session',
  fetchImpl: async (url, init) => {
    const headers = (init.headers || {}) as Record<string, string>;
    calls.push({ url, body: String(init.body || ''), authorization: headers.Authorization });
    if (url.endsWith('/api/auth/login/sso')) {
      assert.equal(JSON.parse(String(init.body)).access_token, 'music-session');
      return { ok: true, status: 200, json: async () => ({ token: 'docs-session' }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'task-1' }) };
  },
});
assert.equal(created.ok, true);
assert.equal(created.id, 'task-1');
assert.equal(calls.length, 2);
assert.match(calls[0].url, /\/api\/auth\/login\/sso$/);
assert.match(calls[1].url, /\/api\/tasks$/);
assert.equal(calls[1].authorization, 'Bearer docs-session');
const posted = JSON.parse(calls[1].body);
assert.equal(posted.category, 'bug');
assert.equal(posted.column_id, 'todo');
assert.equal(posted.project, 'android');
assert.match(posted.title, /INSTALL_PARSE_FAILED_NOT_APK/);

const refusedUrls: string[] = [];
const refused = await postDocsTask(task, {
  accessToken: 'music-session',
  fetchImpl: async (url) => {
    refusedUrls.push(url);
    return { ok: false, status: 403, json: async () => ({ error: 'allowlist' }) };
  },
});
assert.equal(refused.ok, false);
assert.equal(refused.error, 'allowlist');
assert.equal(refusedUrls.length, 1);
assert.match(refusedUrls[0], /\/api\/auth\/login\/sso$/);
assert.equal(refused.task.category, 'bug');
assert.equal(refused.task.column_id, 'todo');

let networkCalls = 0;
const offline = await postDocsTask(task, {
  accessToken: 'music-session',
  fetchImpl: async () => {
    networkCalls += 1;
    throw new Error('réseau coupé');
  },
});
assert.equal(offline.ok, false);
assert.equal(offline.error, 'unreachable');
assert.equal(networkCalls, 1);

let bareCalls = 0;
const noToken = await postDocsTask(task, {
  fetchImpl: async () => {
    bareCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  },
});
assert.equal(noToken.ok, false);
assert.equal(noToken.error, 'auth');
assert.equal(bareCalls, 0);
assert.equal(noToken.task.column_id, 'todo');

console.log('groupErrors ok');
