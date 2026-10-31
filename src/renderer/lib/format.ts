import { camelotHue } from '../../core/music/camelot';

export function fmtTime(s: number, withTenths = false): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return withTenths ? `${base},${Math.floor((s % 1) * 10)}` : base;
}

/** Short length: "45 s" under a minute, "1:05" above. */
export function fmtLength(s: number): string {
  return s < 59.5 ? `${Math.round(s)} s` : fmtTime(s);
}

export function fmtBpm(b: number | null | undefined): string {
  if (!b) return '—';
  return Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1).replace('.', ',');
}

export function fmtDb(x: number | null | undefined, unit = 'dB'): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${x.toFixed(1).replace('.', ',')} ${unit}`;
}

export function fmtPct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits).replace('.', ',')} %`;
}

export function keyColor(camelot: string | undefined, alpha = 1): string {
  if (!camelot) return `rgba(255,255,255,${0.3 * alpha})`;
  return `hsla(${camelotHue(camelot)}, 78%, 66%, ${alpha})`;
}

/** Stable pleasant hue per track id for timeline lanes. */
export function trackHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const palette = [222, 248, 268, 200, 284, 190, 236, 300];
  return palette[h % palette.length];
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}
