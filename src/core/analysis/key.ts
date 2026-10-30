// Key estimation: harmonic-enhanced (time-median filtered) spectrogram, tuning-compensated chroma,
// correlation with Krumhansl-Kessler and Temperley key profiles.

import { stft, clamp } from './dsp';
import { makeKey } from '../music/camelot';
import type { KeyInfo } from '../types';

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TP_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TP_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; my += y[i]; }
  mx /= 12; my /= 12;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[i] - mx, b = y[i] - my;
    n += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : 0;
}

export interface KeyResult {
  key: KeyInfo | null;
  tuningCents: number;
  chroma: number[];
}

/** Spectrogram restricted to bins [k0, k1], median-filtered along time to keep sustained (harmonic) content. */
function harmonicSpectrogram(seg: Float32Array, N: number, hop: number, k0: number, k1: number, medianHalf: number) {
  const nb = k1 - k0 + 1;
  const rows: Float32Array[] = [];
  stft(seg, N, hop, (_f, mag) => {
    const r = new Float32Array(nb);
    for (let k = 0; k < nb; k++) r[k] = mag[k0 + k];
    rows.push(r);
  });
  const F = rows.length;
  const out: Float32Array[] = [];
  const win = new Float32Array(2 * medianHalf + 1);
  for (let f = 0; f < F; f++) {
    const r = new Float32Array(nb);
    const a = Math.max(0, f - medianHalf), b = Math.min(F - 1, f + medianHalf);
    const len = b - a + 1;
    for (let k = 0; k < nb; k++) {
      for (let j = 0; j < len; j++) win[j] = rows[a + j][k];
      const w = win.subarray(0, len).sort();
      r[k] = Math.min(rows[f][k], w[len >> 1]);
    }
    out.push(r);
  }
  return out;
}

export function estimateKey(signal: Float32Array, sr: number, start = 0, end = Infinity): KeyResult {
  const N = 4096;
  const hop = 2048;
  const binHz = sr / N;
  const kMin = Math.ceil(80 / binHz);
  const kMax = Math.min(N / 2 - 1, Math.floor(2000 / binHz));
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(signal.length, Math.floor(Math.min(end, signal.length / sr) * sr));
  const seg = signal.subarray(a, b);
  const H = harmonicSpectrogram(seg, N, hop, kMin, kMax, 4);

  const framePeaks = (row: Float32Array, cb: (k: number, m: number, off: number) => void) => {
    let max = 0;
    for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
    const thr = max * 0.06;
    for (let i = 1; i < row.length - 1; i++) {
      const m = row[i];
      if (m > thr && m > row[i - 1] && m >= row[i + 1]) {
        const l = Math.log(row[i - 1] + 1e-12), c = Math.log(m + 1e-12), r = Math.log(row[i + 1] + 1e-12);
        const den = l - 2 * c + r;
        const off = den !== 0 ? clamp((0.5 * (l - r)) / den, -0.5, 0.5) : 0;
        cb(kMin + i, m, off);
      }
    }
  };

  // Tuning: magnitude-weighted circular mean of peak deviations from the 440 Hz grid.
  let sx = 0, sy = 0;
  for (const row of H) {
    framePeaks(row, (k, m, off) => {
      const cents = 1200 * Math.log2(((k + off) * binHz) / 440);
      const ang = (2 * Math.PI * cents) / 100;
      sx += Math.sqrt(m) * Math.cos(ang);
      sy += Math.sqrt(m) * Math.sin(ang);
    });
  }
  const tuningCents = sx || sy ? (Math.atan2(sy, sx) / (2 * Math.PI)) * 100 : 0;

  const chroma = new Float64Array(12);
  for (const row of H) {
    const frame = new Float64Array(12);
    let tot = 0;
    framePeaks(row, (k, m, off) => {
      const midi = 69 + 12 * Math.log2(((k + off) * binHz) / 440) - tuningCents / 100;
      const near = Math.round(midi);
      const dev = Math.abs(midi - near);
      if (dev > 0.35) return;
      const w = Math.sqrt(m) * (1 - dev);
      frame[((near % 12) + 12) % 12] += w;
      tot += w;
    });
    if (tot > 0) for (let p = 0; p < 12; p++) chroma[p] += frame[p] / Math.sqrt(tot);
  }

  // Bass chroma (45–200 Hz) with a longer window: bass lines strongly indicate the tonal centre.
  const NB = 8192;
  const bHz = sr / NB;
  const bk0 = Math.ceil(45 / bHz), bk1 = Math.floor(200 / bHz);
  const HB = harmonicSpectrogram(seg, NB, NB / 2, bk0, bk1, 3);
  const bass = new Float64Array(12);
  for (const row of HB) {
    let max = 0;
    for (const v of row) if (v > max) max = v;
    for (let i = 1; i < row.length - 1; i++) {
      if (row[i] > max * 0.2 && row[i] > row[i - 1] && row[i] >= row[i + 1]) {
        const midi = 69 + 12 * Math.log2(((bk0 + i) * bHz) / 440) - tuningCents / 100;
        const near = Math.round(midi);
        if (Math.abs(midi - near) > 0.4) continue;
        bass[((near % 12) + 12) % 12] += Math.sqrt(row[i]);
      }
    }
  }
  const sumC = chroma.reduce((s, x) => s + x, 0);
  const sumB = bass.reduce((s, x) => s + x, 0);
  if (sumC <= 0) return { key: null, tuningCents, chroma: Array.from(chroma) };
  const combined = Array.from({ length: 12 }, (_, p) => chroma[p] / sumC + (sumB > 0 ? (0.4 * bass[p]) / sumB : 0));

  const results: Array<{ tonic: number; mode: 'major' | 'minor'; r: number }> = [];
  for (let t = 0; t < 12; t++) {
    const rot = (prof: number[]) => Array.from({ length: 12 }, (_, i) => prof[(i - t + 12) % 12]);
    const rMaj = 0.5 * pearson(combined, rot(KK_MAJOR)) + 0.5 * pearson(combined, rot(TP_MAJOR));
    const rMin = 0.5 * pearson(combined, rot(KK_MINOR)) + 0.5 * pearson(combined, rot(TP_MINOR));
    results.push({ tonic: t, mode: 'major', r: rMaj }, { tonic: t, mode: 'minor', r: rMin });
  }
  results.sort((x, y) => y.r - x.r);
  const best = results[0];
  const second = results[1];
  const confidence = clamp(0.5 * clamp((best.r - 0.3) / 0.5, 0, 1) + 0.5 * clamp((best.r - second.r) / 0.15, 0, 1), 0, 1);
  const total = combined.reduce((s, x) => s + x, 0) || 1;
  const normChroma = combined.map((c) => c / total);
  if (best.r < 0.2) return { key: null, tuningCents, chroma: normChroma };
  return { key: makeKey(best.tonic, best.mode, confidence), tuningCents, chroma: normChroma };
}
