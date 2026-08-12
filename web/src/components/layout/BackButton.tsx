import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/** Retour à la page précédente (ou fallback). */
export function BackButton({
  fallback = '/',
  label = 'Retour',
  className = '',
}: {
  fallback?: string;
  label?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <button
      type="button"
      onClick={() => {
        // React Router : key !== 'default' ⇒ on a navigué depuis une autre route
        if (location.key !== 'default') {
          navigate(-1);
        } else {
          navigate(fallback);
        }
      }}
      className={`mb-4 inline-flex items-center gap-2 rounded-full px-1 py-1.5 text-sm text-yt-muted transition hover:text-white ${className}`}
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </button>
  );
}
