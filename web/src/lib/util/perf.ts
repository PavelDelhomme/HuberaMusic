/** Marqueurs perf légers (web). Activer : localStorage.ytm_perf = '1' */

type PerfSample = { name: string; ms: number; at: number; detail?: string };

const MAX = 40;
const samples: PerfSample[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function perfEnabled(): boolean {
  try {
    return localStorage.getItem('ytm_perf') === '1';
  } catch {
    return false;
  }
}

export function setPerfEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem('ytm_perf', '1');
    else localStorage.removeItem('ytm_perf');
  } catch {
    /* ignore */
  }
  emit();
}

export function perfMark(name: string, ms: number, detail?: string) {
  if (!Number.isFinite(ms) || ms < 0) return;
  samples.unshift({ name, ms: Math.round(ms), at: Date.now(), detail });
  if (samples.length > MAX) samples.length = MAX;
  if (typeof console !== 'undefined' && perfEnabled()) {
    console.info(`[perf] ${name} ${Math.round(ms)}ms${detail ? ` · ${detail}` : ''}`);
  }
  emit();
}

export function perfStart(name: string): (detail?: string) => void {
  const t0 = performance.now();
  return (detail?: string) => perfMark(name, performance.now() - t0, detail);
}

export function getPerfSamples(): PerfSample[] {
  return samples.slice();
}

export function subscribePerf(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearPerfSamples() {
  samples.length = 0;
  emit();
}
