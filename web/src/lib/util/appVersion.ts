/** Version affichée : d+X.Y.Z (dev/local) ou p+X.Y.Z (prod). */
declare const __APP_VERSION__: string;
declare const __APP_CHANNEL__: 'd' | 'p';

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const APP_CHANNEL: 'd' | 'p' =
  typeof __APP_CHANNEL__ !== 'undefined' ? __APP_CHANNEL__ : import.meta.env.PROD ? 'p' : 'd';

/** Ex. `d+1.2.0` ou `p+1.2.0` */
export function appVersionLabel(channel: 'd' | 'p' = APP_CHANNEL, semver = APP_VERSION): string {
  return `${channel}+${semver}`;
}
