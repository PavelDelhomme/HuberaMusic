import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import type { Track } from '../../api';
import { TrackRow } from './TrackRow';

function overflowParent(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
    node = node.parentElement;
  }
  return window;
}

type RowPass = Omit<
  ComponentProps<typeof TrackRow>,
  'track' | 'queue' | 'onPlay' | 'prefetch' | 'getQueue' | 'index'
>;

type Props = {
  tracks: Track[];
  rowHeight?: number;
  overscan?: number;
} & RowPass;

export function VirtualTrackList({ tracks, rowHeight = 72, overscan = 12, ...rowProps }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const getQueue = useCallback(() => tracksRef.current, []);
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(tracks.length, overscan * 2 + 24),
  }));

  const update = useCallback(() => {
    const wrap = wrapRef.current;
    const list = tracksRef.current;
    if (!wrap || !list.length) return;
    const parent = overflowParent(wrap);
    const rh = rowHeight;
    let scrollTop: number;
    let viewH: number;
    let offset: number;
    if (parent === window) {
      scrollTop = window.scrollY;
      viewH = window.innerHeight;
      offset = wrap.getBoundingClientRect().top + scrollTop;
    } else {
      const p = parent as HTMLElement;
      scrollTop = p.scrollTop;
      viewH = p.clientHeight;
      offset = wrap.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
    }
    const rel = scrollTop - offset;
    const rawStart = Math.max(0, Math.floor(rel / rh));
    const visible = Math.ceil(viewH / rh) + 1;
    const start = Math.max(0, rawStart - overscan);
    const end = Math.min(list.length, rawStart + visible + overscan);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [rowHeight, overscan]);

  useLayoutEffect(() => {
    update();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const parent = overflowParent(wrap);
    const target: EventTarget = parent === window ? window : parent;
    const onScroll = () => update();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [update, tracks.length]);

  if (!tracks.length) return null;

  const start = Math.min(range.start, tracks.length);
  const end = Math.min(tracks.length, Math.max(start, range.end));
  const slice = tracks.slice(start, end);
  const topH = start * rowHeight;
  const botH = Math.max(0, (tracks.length - end) * rowHeight);

  return (
    <div ref={wrapRef}>
      <div style={{ height: topH }} aria-hidden />
      {slice.map((t, i) => (
        <TrackRow
          key={`${t.id}-${start + i}`}
          {...rowProps}
          track={t}
          index={start + i}
          prefetch={false}
          getQueue={getQueue}
        />
      ))}
      <div style={{ height: botH }} aria-hidden />
    </div>
  );
}
