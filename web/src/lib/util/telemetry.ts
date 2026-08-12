import { api } from '../../api';

async function batteryInfo(): Promise<{ level?: number; charging?: boolean }> {
  try {
    const nav = navigator as any;
    if (!nav.getBattery) return {};
    const b = await nav.getBattery();
    return { level: b.level, charging: b.charging };
  } catch {
    return {};
  }
}

export async function reportTelemetry(payload: {
  level?: string;
  kind?: string;
  message?: string;
  stack?: string;
  meta?: unknown;
  perf?: unknown;
}) {
  try {
    const bat = await batteryInfo();
    await api.telemetry({
      ...payload,
      env: import.meta.env.MODE === 'production' ? undefined : 'local',
      url: location.href,
      batteryLevel: bat.level,
      batteryCharging: bat.charging,
      perf: payload.perf || {
        memory: (performance as any).memory
          ? {
              usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
              totalJSHeapSize: (performance as any).memory.totalJSHeapSize,
            }
          : undefined,
        timing: performance.now(),
      },
    });
  } catch {
    /* never break UX */
  }
}

export function installGlobalTelemetry() {
  window.addEventListener('error', (ev) => {
    void reportTelemetry({
      level: 'error',
      kind: 'window.error',
      message: ev.message,
      stack: ev.error?.stack,
      meta: { filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    void reportTelemetry({
      level: 'error',
      kind: 'unhandledrejection',
      message: reason?.message || String(reason),
      stack: reason?.stack,
    });
  });

  // Heartbeat perf léger
  setInterval(() => {
    void reportTelemetry({ level: 'info', kind: 'heartbeat' });
  }, 5 * 60 * 1000);
}
