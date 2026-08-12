import type { Request, Response, NextFunction } from 'express';

type Bucket = { n: number; reset: number };

/** Rate-limit simple en mémoire (par process) — IP ou clé custom. */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}) {
  const hits = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    // GC léger
    if (now - lastSweep > opts.windowMs * 2) {
      lastSweep = now;
      for (const [k, b] of hits) {
        if (now > b.reset) hits.delete(k);
      }
    }
    const key = (opts.key?.(req) || req.ip || 'unknown').slice(0, 200);
    let b = hits.get(key);
    if (!b || now > b.reset) {
      b = { n: 0, reset: now + opts.windowMs };
      hits.set(key, b);
    }
    b.n += 1;
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - b.n)));
    if (b.n > opts.max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retry)));
      res.status(429).json({ error: 'Trop de tentatives — réessaie dans un moment' });
      return;
    }
    next();
  };
}
