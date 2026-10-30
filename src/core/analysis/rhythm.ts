// Rhythm analysis: onset strength, tempo estimation, beat tracking, constant-grid fit, downbeats.
// Operates on a mono signal at ANALYSIS_SAMPLE_RATE.

import { stft, lerpAt, mean, std, clamp } from './dsp';

export const ONSET_FFT = 1024;
export const ONSET_HOP = 128;
/** Measured latency between a transient and the peak of its spectral-flux response (s). */
export const ONSET_LATENCY = 0.029;

export interface FrameFeatures {
  fps: number;
  frameTime: (f: number) => number;
  frames: number;
  /** Normalised onset strength (spectral flux, log-compressed, local mean removed). */
  onset: Float32Array;
  /** Low-frequency (< 150 Hz) flux, for kick/bass accents. */
  lowFlux: Float32Array;
  /** Band energies (linear power) per frame. */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** Energy in the 300–3400 Hz "voice" band relative to the whole spectrum. */
  voiceRatio: Float32Array;
  /** Spectral flatness inside the voice band (0 = tonal, 1 = noise). */
  voiceFlatness: Float32Array;
  centroid: Float32Array;
  /** 12-bin chroma (200–2000 Hz) per frame, flattened [frame * 12 + pc]. */
  chroma: Float32Array;
}

export function frameFeatures(signal: Float32Array, sr: number): FrameFeatures {
  const n = ONSET_FFT;
  const hop = ONSET_HOP;
  const binHz = sr / n;
  const nb = n / 2 + 1;
  const frames = Math.max(0, Math.floor((signal.length - n) / hop) + 1);
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const voiceRatio = new Float32Array(frames);
  const voiceFlatness = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const chroma = new Float32Array(frames * 12);
  // Log-spaced bands (~1/4 octave) so that low-frequency transients weigh as much as broadband hats.
  const edges: number[] = [1];
  for (let f = 40; f < sr / 2; f *= Math.pow(2, 1 / 4)) {
    const k = Math.round(f / binHz);
    if (k > edges[edges.length - 1]) edges.push(k);
  }
  edges.push(nb);
  const nBands = edges.length - 1;
  const prevBand = new Float64Array(nBands);
  const lowBands = edges.filter((k) => k * binHz < 150).length;
  const b250 = Math.round(250 / binHz);
  const b2500 = Math.round(2500 / binHz);
  const v0 = Math.round(300 / binHz);
  const v1 = Math.round(3400 / binHz);
  const c0 = Math.round(200 / binHz);
  const c1 = Math.round(2000 / binHz);
  const pcOfBin = new Int8Array(nb).fill(-1);
  for (let k = c0; k <= c1; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  stft(signal, n, hop, (f, mag) => {
    let fl = 0, lf = 0, lo = 0, mi = 0, hi = 0, tot = 0, cen = 0, vo = 0, logSum = 0, linSum = 0;
    for (let b = 0; b < nBands; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += mag[k];
      const lm = Math.log1p((10 * s) / (edges[b + 1] - edges[b]));
      const d = lm - prevBand[b];
      if (d > 0) {
        fl += d;
        if (b < lowBands) lf += d;
      }
      prevBand[b] = lm;
    }
    for (let k = 1; k < nb; k++) {
      const m = mag[k];
      const p = m * m;
      tot += p;
      cen += p * k * binHz;
      if (k < b250) lo += p; else if (k < b2500) mi += p; else hi += p;
      if (k >= v0 && k <= v1) {
        vo += p;
        logSum += Math.log(p + 1e-12);
        linSum += p;
      }
      const pc = pcOfBin[k];
      if (pc >= 0) chroma[f * 12 + pc] += m;
    }
    flux[f] = fl;
    lowFlux[f] = lf;
    low[f] = lo; mid[f] = mi; high[f] = hi;
    centroid[f] = tot > 0 ? cen / tot : 0;
    voiceRatio[f] = tot > 0 ? vo / tot : 0;
    const nv = v1 - v0 + 1;
    voiceFlatness[f] = linSum > 0 ? Math.exp(logSum / nv) / (linSum / nv) : 1;
  });

  // Remove the local mean (~0.5 s) and half-wave rectify, then normalise.
  const fps = sr / hop;
  const onset = new Float32Array(frames);
  const w = Math.round(fps * 0.25);
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) { acc += flux[i]; pre[i + 1] = acc; }
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1);
    const m = (pre[b] - pre[a]) / (b - a);
    onset[i] = Math.max(0, flux[i] - m);
  }
  const s = std(onset) || 1;
  for (let i = 0; i < frames; i++) onset[i] /= s;

  return {
    fps,
    frameTime: (f: number) => (f * hop + n / 2) / sr + ONSET_LATENCY,
    frames,
    onset,
    lowFlux,
    low,
    mid,
    high,
    voiceRatio,
    voiceFlatness,
    centroid,
    chroma,
  };
}

export interface TempoResult {
  bpm: number | null;
  confidence: number;
  candidates: Array<{ bpm: number; score: number }>;
}

export function estimateTempo(onset: Float32Array, fps: number, minBpm = 60, maxBpm = 200): TempoResult {
  const N = onset.length;
  const maxLag = Math.ceil((fps * 60 * 4.2) / minBpm);
  if (N < fps * 8) return { bpm: null, confidence: 0, candidates: [] };
  const acf = new Float64Array(Math.min(maxLag, N - 1) + 1);
  const m = mean(onset);
  for (let lag = 0; lag < acf.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < N; i++) s += (onset[i] - m) * (onset[i + lag] - m);
    acf[lag] = s / (N - lag);
  }
  const acf0 = acf[0] || 1;
  for (let i = 0; i < acf.length; i++) acf[i] /= acf0;

  const scores: Array<{ bpm: number; score: number; raw: number }> = [];
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += 0.05) {
    const lag = (fps * 60) / bpm;
    let raw = 0;
    const harmonics = [1, 2, 3, 4];
    const weights = [1, 0.6, 0.4, 0.5];
    for (let h = 0; h < harmonics.length; h++) {
      const l = lag * harmonics[h];
      if (l < acf.length - 1) raw += weights[h] * Math.max(0, lerpAt(acf, l));
    }
    // Log-normal tempo prior centred on 120 BPM, one octave wide.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    scores.push({ bpm, score: raw * (0.35 + 0.65 * prior), raw });
  }
  const byBpm = (b: number) => scores[Math.round((b - minBpm) / 0.05)];
  scores.sort((a, b) => b.score - a.score);
  let best = scores[0];
  if (!best || best.raw <= 0) return { bpm: null, confidence: 0, candidates: [] };
  // Octave correction: DJ tempi are conventionally expressed between ~85 and ~175 BPM.
  const unsorted = [...scores].sort((a, b) => a.bpm - b.bpm);
  const near = (b: number) => {
    let r = byBpm(b) && unsorted[Math.round((b - minBpm) / 0.05)];
    for (let d = -0.5; d <= 0.5; d += 0.05) {
      const c = unsorted[Math.round((b + d - minBpm) / 0.05)];
      if (c && (!r || c.raw > r.raw)) r = c;
    }
    return r;
  };
  if (best.bpm < 85) {
    const dbl = near(best.bpm * 2);
    if (dbl && dbl.raw >= 0.55 * best.raw) best = dbl;
  } else if (best.bpm > 175) {
    const half = near(best.bpm / 2);
    if (half && half.raw >= 0.55 * best.raw) best = half;
  }

  // Strongest candidate that is not metrically related to the winner.
  const related = (a: number, b: number) =>
    [0.5, 2 / 3, 0.75, 1, 4 / 3, 1.5, 2].some((r) => Math.abs(a / (b * r) - 1) < 0.03);
  const rival = scores.find((s) => !related(s.bpm, best.bpm));
  const periodicity = clamp(Math.max(0, lerpAt(acf, (fps * 60) / best.bpm)) * 1.6, 0, 1);
  const distinct = rival ? clamp(1 - rival.score / best.score, 0, 1) : 1;
  const confidence = clamp(0.55 * periodicity + 0.45 * distinct * 1.4, 0, 1);

  const candidates: Array<{ bpm: number; score: number }> = [];
  for (const s of scores) {
    if (candidates.length >= 4) break;
    if (!candidates.some((c) => Math.abs(c.bpm / s.bpm - 1) < 0.02)) candidates.push({ bpm: s.bpm, score: s.score / best.score });
  }
  return { bpm: best.bpm, confidence, candidates };
}

/** Dynamic-programming beat tracker (Ellis, 2007). Returns beat frames. */
export function trackBeats(onset: Float32Array, fps: number, bpm: number, tightness = 100): number[] {
  const N = onset.length;
  const P = (fps * 60) / bpm;
  const score = new Float64Array(N);
  const back = new Int32Array(N).fill(-1);
  const lo = Math.round(P / 2);
  const hi = Math.round(2 * P);
  for (let t = 0; t < N; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const pen = Math.log((t - tau) / P);
      const v = score[tau] - tightness * pen * pen;
      if (v > best) { best = v; arg = tau; }
    }
    score[t] = onset[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // Pick the best ending beat in the final period.
  let end = N - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, N - Math.ceil(P)); t < N; t++) {
    if (score[t] > bestEnd) { bestEnd = score[t]; end = t; }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  return beats.reverse();
}

export interface GridResult {
  bpm: number;
  firstBeat: number; // seconds, earliest beat >= 0
  stability: number; // 0..1
  /** Fraction of beats sitting half a period off the grid (sign of a half-tempo phase ambiguity). */
  halfPhase: number;
  beatTimes: number[]; // detected beats (s)
}

/**
 * Robust least-squares fit of a constant tempo grid to detected beats.
 * Indices are accumulated from consecutive intervals (no drift from an imprecise initial period),
 * then refined from the fitted grid with iterative outlier rejection.
 */
export function fitGrid(beatTimes: number[], bpmGuess: number): GridResult | null {
  const n = beatTimes.length;
  if (n < 8) return null;
  // Period from the mean of "clean" consecutive intervals (accurate despite frame quantisation),
  // phase from the circular mean of beat positions — both insensitive to phase flips.
  let T0 = 60 / bpmGuess;
  const clean: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = beatTimes[i] - beatTimes[i - 1];
    if (Math.abs(d / T0 - 1) < 0.06) clean.push(d);
  }
  if (clean.length >= 8) T0 = clean.reduce((a, b) => a + b, 0) / clean.length;
  let cs = 0, sn = 0;
  for (const b of beatTimes) { cs += Math.cos((2 * Math.PI * b) / T0); sn += Math.sin((2 * Math.PI * b) / T0); }
  const phase0 = ((Math.atan2(sn, cs) / (2 * Math.PI)) * T0 + T0) % T0;
  let idx = beatTimes.map((b) => Math.round((b - phase0) / T0));
  let use = beatTimes.map((b, i) => Math.abs((b - phase0) / T0 - idx[i]) < 0.3);
  let T = T0, t0 = phase0;
  for (let iter = 0; iter < 5; iter++) {
    let m = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      if (!use[i]) continue;
      const x = idx[i], y = beatTimes[i];
      m++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const den = m * sxx - sx * sx;
    if (m < 8 || den === 0) return null;
    const slope = (m * sxy - sx * sy) / den;
    if (!(slope > 0)) return null;
    T = slope;
    t0 = (sy - slope * sx) / m;
    idx = beatTimes.map((b) => Math.round((b - t0) / T));
    const tol = iter < 2 ? 0.3 : 0.2;
    use = beatTimes.map((b, i) => Math.abs((b - t0) / T - idx[i]) < tol);
  }
  let s2 = 0, inl = 0, half = 0;
  for (const b of beatTimes) {
    const r = (b - t0) / T;
    const d = r - Math.round(r);
    s2 += (d * T) ** 2;
    if (Math.abs(d) < 0.06) inl++;
    if (Math.abs(d) > 0.38) half++;
  }
  const rms = Math.sqrt(s2 / n);
  const stability = clamp(0.5 * (inl / n) + 0.5 * clamp(1 - rms / (0.12 * T), 0, 1), 0, 1);
  const first = t0 - Math.floor(t0 / T) * T;
  return { bpm: 60 / T, firstBeat: first, stability, halfPhase: half / n, beatTimes };
}

/** Fine phase adjustment: maximise onset energy summed on the grid. */
export function refinePhase(onset: Float32Array, fps: number, frameTime: (f: number) => number, bpm: number, firstBeat: number): number {
  const T = 60 / bpm;
  const t0frame = (frameTime(0));
  const toFrame = (t: number) => (t - t0frame) * fps;
  let bestOff = 0, best = -Infinity;
  for (let off = -T / 8; off <= T / 8; off += 0.002) {
    let s = 0;
    for (let t = firstBeat + off; t < (onset.length / fps); t += T) s += lerpAt(onset, toFrame(t));
    if (s > best) { best = s; bestOff = off; }
  }
  let fb = firstBeat + bestOff;
  fb -= Math.floor(fb / T) * T;
  return fb;
}

export interface DownbeatResult {
  phase: number;
  confidence: number;
}

/** Estimate which of the 4 beats of the bar is the downbeat. */
export function estimateDownbeat(ff: FrameFeatures, bpm: number, firstBeat: number, duration: number, startTime: number): DownbeatResult {
  const T = 60 / bpm;
  const nBeats = Math.floor((duration - firstBeat) / T);
  if (nBeats < 16) return { phase: 0, confidence: 0 };
  const t0 = ff.frameTime(0);
  const beatChroma: Float64Array[] = [];
  const beatLow: number[] = [];
  const beatEnergy: number[] = [];
  for (let k = 0; k < nBeats; k++) {
    const a = Math.max(0, Math.round((firstBeat + k * T - t0) * ff.fps));
    const b = Math.min(ff.frames, Math.round((firstBeat + (k + 1) * T - t0) * ff.fps));
    const c = new Float64Array(12);
    let low = 0, en = 0;
    for (let f = a; f < b; f++) {
      for (let p = 0; p < 12; p++) c[p] += ff.chroma[f * 12 + p];
      en += ff.low[f] + ff.mid[f] + ff.high[f];
    }
    // Accent right at the beat (first 60 ms)
    const acc = Math.min(ff.frames, a + Math.max(1, Math.round(0.06 * ff.fps)));
    for (let f = a; f < acc; f++) low += ff.lowFlux[f];
    beatChroma.push(c);
    beatLow.push(low);
    beatEnergy.push(Math.log1p(en / Math.max(1, b - a)));
  }
  const cos = (x: Float64Array, y: Float64Array) => {
    let d = 0, nx = 0, ny = 0;
    for (let i = 0; i < 12; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
    return nx > 0 && ny > 0 ? d / Math.sqrt(nx * ny) : 1;
  };
  const sum2 = (i: number) => {
    const c = new Float64Array(12);
    for (let j = i; j < i + 2 && j < nBeats; j++) for (let p = 0; p < 12; p++) c[p] += beatChroma[j][p];
    return c;
  };
  const feat = [0, 1, 2, 3].map(() => ({ harm: 0, low: 0, nov: 0, n: 0 }));
  for (let k = 2; k < nBeats - 2; k++) {
    const ph = k % 4;
    feat[ph].harm += 1 - cos(sum2(k - 2), sum2(k));
    feat[ph].low += beatLow[k];
    feat[ph].nov += Math.max(0, beatEnergy[k] - beatEnergy[k - 1]);
    feat[ph].n++;
  }
  const z = (vals: number[]) => {
    const m = mean(vals), s = std(vals) || 1;
    return vals.map((v) => (v - m) / s);
  };
  const harm = z(feat.map((f) => f.harm / f.n));
  const low = z(feat.map((f) => f.low / f.n));
  const nov = z(feat.map((f) => f.nov / f.n));
  // Prior: music usually starts on a downbeat.
  const startBeat = Math.max(0, Math.round((startTime - firstBeat) / T));
  const score = [0, 1, 2, 3].map((p) => 1.0 * harm[p] + 0.6 * low[p] + 0.5 * nov[p] + (startBeat % 4 === p ? 0.6 : 0));
  const order = [0, 1, 2, 3].sort((a, b) => score[b] - score[a]);
  const confidence = clamp((score[order[0]] - score[order[1]]) / 2.5, 0, 1);
  return { phase: order[0], confidence };
}
