/** Canal bêta. Un compte absent de la liste ne voit jamais la version bêta. */

export function isBetaAccount(email: string | null | undefined, allowList: string): boolean {
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) return false;
  const allowed = allowList
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(emailNorm);
}

export function betaOfferBeatsProd(opts: {
  betaReady: boolean;
  betaCode: number;
  prodCode: number;
  clientCode: number;
}): boolean {
  if (!opts.betaReady || opts.betaCode <= 0) return false;
  if (opts.clientCode > 0 && opts.betaCode < opts.clientCode) return false;
  return opts.betaCode >= opts.prodCode;
}
