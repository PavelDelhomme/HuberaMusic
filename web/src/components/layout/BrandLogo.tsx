import type { SVGProps } from 'react';

/** Logo style YouTube Music (disque rouge + note/play), pas le rectangle YouTube. */
export function BrandLogo({ className = 'h-8 w-8', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden {...props}>
      <circle cx="256" cy="256" r="256" fill="#FF0033" />
      <g fill="#fff">
        <path d="M196 152v208c0 8 6 14 14 14 3 0 6-1 9-3l148-92c7-4 11-12 11-20s-4-16-11-20L219 147c-3-2-6-3-9-3-8 0-14 6-14 14z" />
        <rect x="338" y="148" width="28" height="120" rx="10" />
        <ellipse cx="352" cy="140" rx="36" ry="28" transform="rotate(-25 352 140)" />
      </g>
    </svg>
  );
}
