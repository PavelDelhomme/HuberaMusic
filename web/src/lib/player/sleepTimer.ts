/** Options partagées minuteur de mise en veille (web). */
export type SleepPick =
  | { kind: 'ms'; ms: number; label: string }
  | { kind: 'end'; label: string }
  | { kind: 'queue'; label: string }
  | { kind: 'off'; label: string };

export const SLEEP_TIMER_OPTIONS: SleepPick[] = [
  { kind: 'ms', ms: 5 * 60_000, label: '5 minutes' },
  { kind: 'ms', ms: 15 * 60_000, label: '15 minutes' },
  { kind: 'ms', ms: 30 * 60_000, label: '30 minutes' },
  { kind: 'ms', ms: 60 * 60_000, label: '1 heure' },
  { kind: 'end', label: 'Fin de la chanson' },
  { kind: 'queue', label: "Fin de la file d'attente" },
  { kind: 'off', label: 'Annuler / manuel' },
];

export function applySleepPick(
  pick: SleepPick,
  setSleepTimer: (delayMs: number | 'end' | 'queue' | null, label: string | null) => void,
) {
  if (pick.kind === 'off') setSleepTimer(null, null);
  else if (pick.kind === 'end') setSleepTimer('end', pick.label);
  else if (pick.kind === 'queue') setSleepTimer('queue', pick.label);
  else setSleepTimer(pick.ms, pick.label);
}
