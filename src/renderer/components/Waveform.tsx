import { memo, useEffect, useRef } from 'react';
import type { Waveform as WaveData } from '../../core/types';

export interface WaveformProps {
  data: WaveData;
  duration: number;
  from?: number; // source seconds
  to?: number;
  style?: 'bars' | 'fill';
  hue?: number; // optional tint for the mid band
  dim?: Array<{ from: number; to: number }>; // source ranges drawn dimmed
  className?: string;
  mirrored?: boolean;
}

/** Three-band waveform drawn on a canvas (low = blue, mid = violet, high = white). Redrawn only on resize/data change. */
export const Waveform = memo(function Waveform({ data, duration, from = 0, to, style = 'bars', hue, dim, className, mirrored = true }: WaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const end = to ?? duration;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = data.points;
      const pps = n / Math.max(1e-6, duration);
      const step = style === 'bars' ? 3 : 1;
      const barW = style === 'bars' ? 2 : 1;
      const mid = mirrored ? h / 2 : h;
      const scale = mirrored ? h / 2 - 1 : h - 1;
      const lowC = 'rgba(75,125,255,0.95)';
      const midC = hue !== undefined ? `hsla(${hue}, 85%, 74%, 0.9)` : 'rgba(169,139,255,0.9)';
      const highC = 'rgba(236,242,255,0.9)';
      for (let x = 0; x < w; x += step) {
        const t0 = from + ((end - from) * x) / w;
        const t1 = from + ((end - from) * (x + step)) / w;
        const a = Math.max(0, Math.floor(t0 * pps));
        const b = Math.min(n, Math.max(a + 1, Math.ceil(t1 * pps)));
        if (a >= n || t0 >= duration || t1 <= 0) continue;
        let pk = 0, lo = 0, mi = 0, hi = 0;
        for (let i = a; i < b; i++) {
          if (data.peak[i] > pk) pk = data.peak[i];
          lo += data.low[i]; mi += data.mid[i]; hi += data.high[i];
        }
        const cnt = b - a;
        const p = Math.pow(pk / 255, 0.85);
        const l = lo / cnt / 255, m = mi / cnt / 255, hh = hi / cnt / 255;
        const dimmed = dim?.some((d) => t0 >= d.from && t0 < d.to);
        ctx.globalAlpha = dimmed ? 0.28 : 1;
        const hp = p * scale;
        const hl = hp * Math.min(1, 0.25 + l * 0.85);
        const hm = hp * Math.min(1, 0.15 + m * 0.7);
        const hhh = hp * Math.min(0.9, hh * 0.55);
        const bar = (height: number, color: string) => {
          if (height < 0.5) return;
          ctx.fillStyle = color;
          if (mirrored) ctx.fillRect(x, mid - height, barW, height * 2);
          else ctx.fillRect(x, mid - height, barW, height);
        };
        bar(hp, 'rgba(255,255,255,0.10)');
        bar(hm, midC);
        bar(hl, lowC);
        bar(hhh, highC);
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [data, duration, from, end, style, hue, dim, mirrored]);

  return <canvas ref={ref} className={`waveform ${className ?? ''}`} aria-hidden />;
});
