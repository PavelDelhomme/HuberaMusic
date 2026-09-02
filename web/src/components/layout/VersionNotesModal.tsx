import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiUrl } from '../../api';
import { APP_VERSION, appVersionLabel } from '../../lib/util/appVersion';

export type VersionNoteEntry = {
  version: string;
  date?: string;
  title?: string;
  notes: string[];
};

type VersionNotesPayload = {
  updatedAt?: string;
  versions?: VersionNoteEntry[];
};

async function loadVersionNotes(): Promise<VersionNoteEntry[]> {
  const tryUrls = [apiUrl('/api/version-notes'), '/version-notes.json'];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { credentials: url.startsWith('http') ? 'include' : 'same-origin' });
      if (!res.ok) continue;
      const data = (await res.json()) as VersionNotesPayload;
      if (Array.isArray(data.versions) && data.versions.length) return data.versions;
    } catch {
      /* next */
    }
  }
  return [];
}

/** Modal notes de version (clic sur Version dans Profil / menu). */
export function VersionNotesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<VersionNoteEntry[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    void loadVersionNotes().then((list) => {
      if (!cancelled) setEntries(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal
      aria-labelledby="version-notes-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(85vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-yt-border bg-yt-surface shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-yt-border px-5 py-4">
          <div>
            <h2 id="version-notes-title" className="font-display text-lg font-semibold text-white">
              Notes de version
            </h2>
            <p className="mt-1 text-xs tabular-nums tracking-wide text-yt-muted">
              Build {appVersionLabel()} · {APP_VERSION}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-yt-muted hover:bg-yt-hover hover:text-white"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {entries === null && <p className="text-sm text-yt-muted">Chargement…</p>}
          {entries !== null && entries.length === 0 && (
            <p className="text-sm text-yt-muted">Aucune note disponible pour le moment.</p>
          )}
          {entries?.map((entry) => (
            <article key={entry.version} className="mb-6 border-b border-yt-border/60 pb-5 last:mb-0 last:border-0 last:pb-0">
              <p className="text-sm font-semibold text-yt-red">v{entry.version}</p>
              {entry.title ? <h3 className="mt-1 text-base font-medium text-white">{entry.title}</h3> : null}
              {entry.date ? <p className="mt-0.5 text-xs text-yt-muted">{entry.date}</p> : null}
              <ul className="mt-3 space-y-1.5 text-sm text-yt-muted">
                {entry.notes.map((note) => (
                  <li key={note} className="flex gap-2">
                    <span className="shrink-0 text-yt-red">·</span>
                    <span className="text-white/85">{note}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Bouton / lien « Version … » ouvrant le modal. */
export function VersionNotesTrigger({
  className = '',
  label,
  title = 'Voir les notes de version',
}: {
  className?: string;
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ||
          'mt-8 text-center text-xs tabular-nums tracking-wide text-yt-muted/70 underline-offset-2 hover:text-white hover:underline'
        }
        title={title}
      >
        {label ?? `Version ${appVersionLabel()}`}
      </button>
      <VersionNotesModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
