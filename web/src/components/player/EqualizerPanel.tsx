import { useEffect, useState } from 'react';
import { Power, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import {
  getEqState,
  resetEqBands,
  setEqBandGain,
  setEqEnabled,
  subscribeEq,
  type EqBand,
} from '../../lib/audio/equalizer';

export function EqualizerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState(() => getEqState().enabled);
  const [bands, setBands] = useState<EqBand[]>(() => getEqState().bands);

  useEffect(() => {
    return subscribeEq(() => {
      const s = getEqState();
      setEnabled(s.enabled);
      setBands(s.bands);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-3 sm:items-center">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Fermer" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-yt-border bg-yt-elevated p-4 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-yt-red" />
            <h2 className="font-display text-lg font-semibold">Égaliseur</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={enabled ? 'Désactiver' : 'Activer'}
              aria-pressed={enabled}
              onClick={() => setEqEnabled(!enabled)}
              className={`rounded-full p-2 ${
                enabled ? 'text-yt-red hover:bg-yt-red/15' : 'text-yt-muted hover:bg-white/10 hover:text-white'
              }`}
            >
              <Power className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Réinitialiser"
              disabled={!enabled}
              onClick={() => resetEqBands()}
              className="rounded-full p-2 text-yt-muted hover:bg-white/10 hover:text-white disabled:opacity-40"
            >
              <RotateCcw className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-yt-muted hover:bg-white/10 hover:text-white"
              aria-label="Fermer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className={`space-y-3 ${enabled ? '' : 'pointer-events-none opacity-40'}`}>
          {bands.map((b) => (
            <div key={b.id} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-yt-muted">{b.label}</span>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={b.gain}
                onChange={(e) => setEqBandGain(b.id, Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer accent-[#ff0033]"
                aria-label={b.label}
              />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-yt-muted">
                {b.gain > 0 ? '+' : ''}
                {b.gain.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
