export type ErrorEvent = { level?: string; kind?: string; message?: string };

export function groupErrorSignatures(events: ErrorEvent[]) {
  const map = new Map<string, { app: string; signature: string; count: number }>();
  for (const ev of events || []) {
    if (ev.level !== 'error' && ev.level !== 'fatal') continue;
    const app = String(ev.kind || 'music').split('.')[0] || 'music';
    const signature = String(ev.message || ev.kind || 'inconnu').replace(/\d+/g, '#').slice(0, 140);
    const key = `${app}|${signature}`;
    const cur = map.get(key) || { app, signature, count: 0 };
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Corps de POST /api/tasks : colonne todo, catégorie bug. L’envoi passe par postDocsTask. */
export function docsTaskFromGroup(group: { app: string; signature: string; count: number }) {
  const title = `${group.app} · ${group.signature}`.slice(0, 180);
  return {
    title,
    body: `${group.count} occurrence(s) groupées. Signature : ${group.signature}`,
    project: group.app || 'music',
    category: 'bug' as const,
    column_id: 'todo' as const,
    priority: 1,
  };
}
