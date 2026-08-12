import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { useEffect, useRef } from 'react';
import { usePlayer } from '../../store/player';

const HOLD_MS = 320;
const TICK_MS = 160;
const STEP_SEC = 2;

/**
 * Appui long sur next/prev : seek ±2 s en boucle dans le titre courant.
 * Appui court : onShortPress (skip piste).
 * Parité avec HoldSeekIconButton (Android).
 */
export function useHoldSeek(deltaSign: 1 | -1, onShortPress: () => void) {
  const holdTimer = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);
  const held = useRef(false);
  const activePointer = useRef<number | null>(null);
  const shortRef = useRef(onShortPress);
  shortRef.current = onShortPress;
  const signRef = useRef(deltaSign);
  signRef.current = deltaSign;

  const clear = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    if (tickTimer.current != null) window.clearInterval(tickTimer.current);
    holdTimer.current = null;
    tickTimer.current = null;
  };

  useEffect(() => () => clear(), []);

  const startHoldLoop = () => {
    held.current = true;
    const step = () => usePlayer.getState().seekBy(signRef.current * STEP_SEC);
    step();
    tickTimer.current = window.setInterval(step, TICK_MS);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    // Un seul pointeur à la fois (évite double tick souris+touch)
    if (activePointer.current != null) return;
    e.preventDefault();
    e.stopPropagation();
    held.current = false;
    activePointer.current = e.pointerId;
    clear();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    holdTimer.current = window.setTimeout(startHoldLoop, HOLD_MS);
  };

  const endPress = (e: ReactPointerEvent, fireShort: boolean) => {
    if (activePointer.current != null && e.pointerId !== activePointer.current) return;
    e.preventDefault();
    e.stopPropagation();
    const wasHeld = held.current;
    clear();
    held.current = false;
    activePointer.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (fireShort && !wasHeld) shortRef.current();
  };

  const onClick = (e: SyntheticEvent) => {
    // Clic synthétique après pointer : déjà géré par pointerup (évite double skip + ouverture NP)
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    onPointerDown,
    onPointerUp: (e: ReactPointerEvent) => endPress(e, true),
    onPointerCancel: (e: ReactPointerEvent) => endPress(e, false),
    onLostPointerCapture: (e: ReactPointerEvent) => endPress(e, false),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick,
  };
}
