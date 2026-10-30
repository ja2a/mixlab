import { useEffect, useState } from 'react';
import { player } from './player';

export interface PlayerSnapshot {
  playing: boolean; // audio is advancing
  paused: boolean;
  position: number;
  duration: number;
  auditioning: string | null;
  error: string | null;
}

function snap(): PlayerSnapshot {
  const p = player();
  return { playing: p.isActive, paused: p.paused, position: p.position, duration: p.duration, auditioning: p.auditioning, error: p.error };
}

/** Player state, with the position refreshed `hz` times per second while playing. */
export function usePlayer(hz = 8): PlayerSnapshot {
  const [s, setS] = useState(snap);
  useEffect(() => {
    const p = player();
    const unsub = p.subscribe(() => setS(snap()));
    const t = window.setInterval(() => { if (p.isActive) setS(snap()); }, 1000 / hz);
    return () => { unsub(); clearInterval(t); };
  }, [hz]);
  return s;
}

/** Calls `cb(position)` on every animation frame while audio is playing (no React re-render). */
export function usePlayhead(cb: (pos: number) => void) {
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      cb(player().position);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cb]);
}
