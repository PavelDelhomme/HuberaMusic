/** Préfixe date/heure locale sur tous les console.* de l’API. */

const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let patched = false;

function localStamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function wrap(fn: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    // Évite double-prefix si déjà horodaté (pipe externe)
    if (typeof args[0] === 'string' && /^\[\d{4}-\d{2}-\d{2} /.test(args[0])) {
      fn(...args);
      return;
    }
    fn(`[${localStamp()}]`, ...args);
  };
}

/** À appeler tout en haut de index.ts (avant le reste des imports métier si possible). */
export function installConsoleTimestamps() {
  if (patched) return;
  patched = true;
  console.log = wrap(orig.log) as typeof console.log;
  console.info = wrap(orig.info) as typeof console.info;
  console.warn = wrap(orig.warn) as typeof console.warn;
  console.error = wrap(orig.error) as typeof console.error;
  console.debug = wrap(orig.debug) as typeof console.debug;
}
