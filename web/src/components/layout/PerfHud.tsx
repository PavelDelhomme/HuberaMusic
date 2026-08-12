import { useEffect, useState } from 'react';
import {
  clearPerfSamples,
  getPerfSamples,
  perfEnabled,
  setPerfEnabled,
  subscribePerf,
} from '../../lib/util/perf';

/** HUD perf — activé via localStorage.ytm_perf=1 ou bouton Profil / console. */
export function PerfHud() {
  const [on, setOn] = useState(() => perfEnabled());
  const [rows, setRows] = useState(() => getPerfSamples());

  useEffect(() => subscribePerf(() => {
    setOn(perfEnabled());
    setRows(getPerfSamples());
  }), []);

  if (!on) return null;

  return (
    <div className="pointer-events-auto fixed bottom-[calc(var(--ytm-player-h,5.5rem)+var(--ytm-nav-h,0px)+0.75rem)] right-3 z-[80] w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/15 bg-black/85 p-2 text-[10px] text-white shadow-2xl backdrop-blur sm:bottom-[calc(var(--ytm-player-h,5.5rem)+1rem)]">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="font-semibold tracking-wide text-white/90">Perf</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-white/70 hover:bg-white/10"
            onClick={() => clearPerfSamples()}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-white/70 hover:bg-white/10"
            onClick={() => setPerfEnabled(false)}
          >
            Off
          </button>
        </div>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto px-1">
        {rows.length === 0 && <li className="text-white/40">En attente d’événements…</li>}
        {rows.slice(0, 12).map((r, i) => (
          <li key={`${r.at}-${i}`} className="flex justify-between gap-2 tabular-nums">
            <span className="min-w-0 truncate text-white/75">{r.name}</span>
            <span className={r.ms > 800 ? 'text-amber-300' : 'text-emerald-300'}>{r.ms}ms</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 px-1 text-[9px] text-white/35">localStorage.ytm_perf=1</p>
    </div>
  );
}

export function PerfToggleButton({ className = '' }: { className?: string }) {
  const [on, setOn] = useState(() => perfEnabled());
  useEffect(() => subscribePerf(() => setOn(perfEnabled())), []);
  return (
    <button
      type="button"
      className={className}
      onClick={() => setPerfEnabled(!on)}
      title="Afficher les timings (play, explore, mix…)"
    >
      Perf {on ? 'ON' : 'OFF'}
    </button>
  );
}
