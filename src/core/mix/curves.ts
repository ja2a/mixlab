// Fade curves and automation breakpoints.

import type { CurveShape } from '../types';

/** Fade-in shape: maps progress u ∈ [0,1] to gain ∈ [0,1]. */
export function fadeIn(shape: CurveShape, u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  switch (shape) {
    case 'linear': return x;
    case 'equalPower': return Math.sin((x * Math.PI) / 2);
    case 'sCurve': return x * x * (3 - 2 * x);
    case 'exponential': return (Math.exp(3 * x) - 1) / (Math.exp(3) - 1);
    case 'logarithmic': return 1 - (1 - x) * (1 - x);
  }
}

export function fadeOut(shape: CurveShape, u: number): number {
  return fadeIn(shape, 1 - u);
}

export interface Breakpoint {
  t: number; // absolute output time (s)
  v: number;
}

/** Sample a function into breakpoints over [t0, t1]. */
export function sampleCurve(t0: number, t1: number, fn: (u: number) => number, n = 48): Breakpoint[] {
  const out: Breakpoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push({ t: t0 + (t1 - t0) * u, v: fn(u) });
  }
  return out;
}

/** Linear interpolation inside a sorted breakpoint list; constant outside. */
export function evalBreakpoints(bp: Breakpoint[], t: number): number {
  if (!bp.length) return 1;
  if (t <= bp[0].t) return bp[0].v;
  const last = bp[bp.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = bp.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (bp[m].t <= t) lo = m; else hi = m;
  }
  const a = bp[lo], b = bp[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return a.v + (b.v - a.v) * f;
}

/** Piecewise-linear ramp helper: value `from` before u0, `to` after u1, smooth in between. */
export function ramp(u: number, u0: number, u1: number, from: number, to: number): number {
  if (u <= u0) return from;
  if (u >= u1) return to;
  const x = (u - u0) / (u1 - u0);
  const s = x * x * (3 - 2 * x);
  return from + (to - from) * s;
}
