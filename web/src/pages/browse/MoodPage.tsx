import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, type Shelf } from '../../api';
import { ShelfRow } from '../../components/media/MediaCard';

export function MoodPage() {
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const titleHint = sp.get('title') || '';
  const [title, setTitle] = useState(titleHint || 'Moods & genres');
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError('');
    api
      .mood(id, titleHint || undefined)
      .then((r) => {
        setTitle(r.title || titleHint || 'Moods & genres');
        setShelves(r.shelves || []);
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [id, titleHint]);

  return (
    <div className="animate-fade-up">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-2 text-sm text-yt-muted hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" /> Accueil
      </Link>
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mb-6 text-sm text-yt-muted">Playlists et mix pour cette ambiance.</p>

      {loading && <p className="text-sm text-yt-muted">Chargement…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && !shelves.length && (
        <p className="text-sm text-yt-muted">Aucun contenu pour cette catégorie.</p>
      )}
      {shelves.map((s) => (
        <ShelfRow key={`${s.title}-${s.items[0]?.id || ''}`} title={s.title} items={s.items} />
      ))}
    </div>
  );
}
