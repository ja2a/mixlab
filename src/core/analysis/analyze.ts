// Full track analysis pipeline. Runs in a worker thread (Node).

import fs from 'node:fs';
import path from 'node:path';
import { probe, decode, extractArtwork, type ProbeResult } from '../audio/ffmpeg';
import { forEachBlock } from '../audio/pcm';
import { LoudnessMeter } from './loudness';
import { frameFeatures, estimateTempo, trackBeats, fitGrid, refinePhase, estimateDownbeat, type FrameFeatures } from './rhythm';
import { estimateKey } from './key';
import { clamp, mean, std } from './dsp';
import {
  ANALYSIS_SAMPLE_RATE,
  ANALYSIS_VERSION,
  INTERNAL_SAMPLE_RATE,
  type Section,
  type SectionLabel,
  type TrackAnalysis,
  type TrackMeta,
  type Waveform,
} from '../types';

export interface AnalyzeOutput {
  analysis: TrackAnalysis;
  meta: TrackMeta;
}

export const PCM_FILE = 'pcm.f32';
export const ANALYSIS_FILE = 'analysis.json';
export const COVER_FILE = 'cover.jpg';

export function metaFromProbe(p: ProbeResult, file: string): TrackMeta {
  const t = p.tags;
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  let title = t.title?.trim() || '';
  let artist = (t.artist || t.album_artist || '').trim();
  if (!title) {
    const m = /^(.*?)\s+-\s+(.*)$/.exec(base);
    if (m && !artist) { artist = m[1]; title = m[2]; } else title = base;
  }
  return {
    title,
    artist: artist || 'Artiste inconnu',
    album: t.album?.trim() || '',
    year: (t.date || t.year || '').slice(0, 4),
    genre: t.genre?.trim() || '',
    hasArtwork: p.hasArtwork,
  };
}

export function loadCachedAnalysis(cacheDir: string): AnalyzeOutput | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, ANALYSIS_FILE), 'utf8'));
    if (j.analysis?.version !== ANALYSIS_VERSION) return null;
    if (!fs.existsSync(path.join(cacheDir, PCM_FILE))) return null;
    return j as AnalyzeOutput;
  } catch {
    return null;
  }
}

export async function analyzeTrack(
  file: string,
  cacheDir: string,
  onProgress: (p: number, stage: string) => void = () => {},
  signal?: AbortSignal,
): Promise<AnalyzeOutput> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const warnings: string[] = [];
  onProgress(0.02, 'Lecture des métadonnées');
  const pr = await probe(file);
  const meta = metaFromProbe(pr, file);
  if (pr.hasArtwork) {
    meta.hasArtwork = await extractArtwork(file, path.join(cacheDir, COVER_FILE));
  }

  onProgress(0.05, 'Décodage');
  const pcmPath = path.join(cacheDir, PCM_FILE);
  const dec = await decode(file, pcmPath, (s) => pr.duration > 0 && onProgress(0.05 + 0.45 * clamp(s / pr.duration, 0, 1), 'Décodage'), signal);
  warnings.push(...dec.warnings);
  const duration = dec.frames / INTERNAL_SAMPLE_RATE;
  const sig = dec.analysis;
  const sr = ANALYSIS_SAMPLE_RATE;

  // Loudness, peaks and overview waveform from the full-resolution cache.
  onProgress(0.55, 'Mesure du niveau sonore');
  const points = Math.round(clamp(duration * 10, 200, 6000));
  const framesPerPoint = dec.frames / points;
  const peak = new Float32Array(points);
  const meter = new LoudnessMeter(INTERNAL_SAMPLE_RATE, 2);
  let pos = 0;
  forEachBlock(pcmPath, 1 << 15, (l, r, n) => {
    meter.push([l, r], n);
    for (let i = 0; i < n; i++) {
      const pi = Math.min(points - 1, Math.floor((pos + i) / framesPerPoint));
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (a > peak[pi]) peak[pi] = a;
    }
    pos += n;
  });
  const loud = meter.result();
  if (loud.integrated === null) warnings.push('Niveau sonore non mesurable (piste silencieuse ?)');

  // Leading / trailing silence (−50 dBFS on 10 ms RMS windows).
  const { silenceStart, silenceEnd } = detectSilence(sig, sr, duration);

  onProgress(0.65, 'Analyse rythmique');
  const ff = frameFeatures(sig, sr);
  const tempo = estimateTempo(ff.onset, ff.fps);
  let bpm: number | null = null;
  let bpmConfidence = 0;
  let tempoStability = 0;
  let firstBeat: number | null = null;
  let downbeatPhase = 0;
  let downbeatConfidence = 0;
  if (tempo.bpm && tempo.confidence > 0.12) {
    const beats = trackBeats(ff.onset, ff.fps, tempo.bpm).map(ff.frameTime);
    let grid = fitGrid(beats, tempo.bpm);
    // Half the beats sitting half a period off: the pulse is really twice as fast (phase flips between kicks).
    if (grid && grid.halfPhase > 0.15 && tempo.bpm * 2 <= 200) {
      const dbl = fitGrid(trackBeats(ff.onset, ff.fps, grid.bpm * 2).map(ff.frameTime), grid.bpm * 2);
      if (dbl && dbl.stability > grid.stability) { grid = dbl; tempo.bpm = dbl.bpm; }
    }
    if (grid && Math.abs(grid.bpm / tempo.bpm - 1) < 0.04) {
      bpm = grid.bpm;
      tempoStability = grid.stability;
      firstBeat = refinePhase(ff.onset, ff.fps, ff.frameTime, grid.bpm, grid.firstBeat);
      bpmConfidence = clamp(tempo.confidence * (0.4 + 0.6 * grid.stability), 0, 1);
      const db = estimateDownbeat(ff, bpm, firstBeat, duration, silenceStart);
      downbeatPhase = db.phase;
      downbeatConfidence = db.confidence;
      if (tempoStability < 0.45) warnings.push('Tempo instable : la synchronisation sur les temps sera désactivée par défaut');
    } else {
      warnings.push('Grille rythmique incohérente : BPM non fiable');
      bpm = tempo.bpm;
      bpmConfidence = tempo.confidence * 0.3;
    }
  } else {
    warnings.push('Aucune pulsation régulière détectée : BPM indisponible');
  }

  onProgress(0.8, 'Détection de la tonalité');
  const keyRes = estimateKey(sig, sr, silenceStart, silenceEnd);
  if (!keyRes.key) warnings.push('Tonalité non détectée');
  else if (keyRes.key.confidence < 0.25) warnings.push('Tonalité incertaine');

  onProgress(0.9, 'Structure et énergie');
  const bands = bandWaveform(ff, points, duration);
  const waveform: Waveform = {
    points,
    peak: quantize(peak, 1),
    low: bands.low,
    mid: bands.mid,
    high: bands.high,
  };

  const feat = globalFeatures(ff, duration, silenceStart, silenceEnd);
  const bars = bpm && firstBeat !== null && bpmConfidence > 0.15 ? barFeatures(ff, bpm, firstBeat, downbeatPhase, duration) : null;
  const sections = bars ? segment(bars, duration) : [];

  const lufsN = loud.integrated !== null ? clamp((loud.integrated + 20) / 14, 0, 1) : 0.5;
  const bpmN = bpm ? clamp(((bpm < 95 && feat.onsetRate > 3 ? bpm * 2 : bpm) - 80) / 80, 0, 1) : 0.4;
  const energy = loud.integrated !== null
    ? Math.round(10 * (1 + 9 * (0.3 * lufsN + 0.25 * clamp(feat.onsetRate / 6, 0, 1) + 0.15 * clamp((feat.brightness - 800) / 2500, 0, 1) + 0.15 * bpmN + 0.15 * clamp(feat.density / 1.2, 0, 1)))) / 10
    : null;

  const analysis: TrackAnalysis = {
    version: ANALYSIS_VERSION,
    duration,
    sourceSampleRate: pr.sampleRate,
    sourceChannels: pr.channels,
    codec: pr.codec,
    bitrate: pr.bitrate,
    bpm,
    bpmConfidence,
    tempoStability,
    firstBeat,
    downbeatPhase,
    downbeatConfidence,
    key: keyRes.key,
    tuningCents: keyRes.tuningCents,
    lufs: loud.integrated,
    truePeakDb: Number.isFinite(loud.truePeakDb) ? loud.truePeakDb : null,
    samplePeakDb: Number.isFinite(loud.samplePeakDb) ? loud.samplePeakDb : null,
    loudnessRange: loud.range,
    silenceStart,
    silenceEnd,
    energy,
    onsetRate: feat.onsetRate,
    brightness: feat.brightness,
    vocalness: feat.vocalness,
    barEnergy: bars?.energy ?? [],
    barVocal: bars?.vocal ?? [],
    barLow: bars?.low ?? [],
    sections,
    waveform,
    warnings,
  };
  const out: AnalyzeOutput = { analysis, meta };
  fs.writeFileSync(path.join(cacheDir, ANALYSIS_FILE), JSON.stringify(out));
  onProgress(1, 'Terminé');
  return out;
}

function quantize(a: ArrayLike<number>, max: number): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(clamp(a[i] / (max || 1), 0, 1) * 255);
  return out;
}

export function detectSilence(sig: Float32Array, sr: number, duration: number): { silenceStart: number; silenceEnd: number } {
  const win = Math.round(sr * 0.01);
  const thr = Math.pow(10, -50 / 20);
  const nWin = Math.floor(sig.length / win);
  const rms = (w: number) => {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win; i++) s += sig[i] * sig[i];
    return Math.sqrt(s / win);
  };
  let first = 0;
  while (first < nWin && rms(first) < thr) first++;
  let last = nWin - 1;
  while (last > first && rms(last) < thr) last--;
  const silenceStart = Math.min(duration, (first * win) / sr);
  const silenceEnd = Math.max(silenceStart, Math.min(duration, ((last + 1) * win) / sr));
  return { silenceStart, silenceEnd };
}

function bandWaveform(ff: FrameFeatures, points: number, duration: number) {
  const low = new Float64Array(points), mid = new Float64Array(points), high = new Float64Array(points);
  const cnt = new Float64Array(points);
  for (let f = 0; f < ff.frames; f++) {
    const p = Math.min(points - 1, Math.floor((ff.frameTime(f) / duration) * points));
    low[p] += ff.low[f]; mid[p] += ff.mid[f]; high[p] += ff.high[f]; cnt[p]++;
  }
  const norm = (a: Float64Array) => {
    const v = Array.from(a, (x, i) => Math.sqrt(cnt[i] ? x / cnt[i] : 0));
    const sorted = [...v].sort((x, y) => x - y);
    const ref = sorted[Math.floor(sorted.length * 0.99)] || 1;
    return quantize(v, ref);
  };
  return { low: norm(low), mid: norm(mid), high: norm(high) };
}

function globalFeatures(ff: FrameFeatures, duration: number, s0: number, s1: number) {
  // Onset peak picking
  let count = 0;
  let last = -1e9;
  let dens = 0, nDens = 0;
  let cen = 0, cenW = 0, voc = 0, vocW = 0;
  const minGap = Math.round(0.05 * ff.fps);
  for (let f = 1; f < ff.frames - 1; f++) {
    const t = ff.frameTime(f);
    if (t < s0 || t > s1) continue;
    const o = ff.onset[f];
    dens += o; nDens++;
    if (o > 1.5 && o >= ff.onset[f - 1] && o >= ff.onset[f + 1] && f - last >= minGap) { count++; last = f; }
    const e = ff.low[f] + ff.mid[f] + ff.high[f];
    cen += ff.centroid[f] * e; cenW += e;
    voc += ff.voiceRatio[f] * (1 - ff.voiceFlatness[f]) * e; vocW += e;
  }
  const active = Math.max(1, s1 - s0);
  return {
    onsetRate: count / active,
    density: nDens ? dens / nDens : 0,
    brightness: cenW ? cen / cenW : 0,
    vocalness: clamp(vocW ? (voc / vocW) * 2.2 : 0, 0, 1),
    duration,
  };
}

interface BarData {
  bar0: number; // time of bar 0
  barDur: number;
  energy: number[];
  low: number[];
  vocal: number[];
  chroma: number[][];
}

function barFeatures(ff: FrameFeatures, bpm: number, firstBeat: number, phase: number, duration: number): BarData {
  const T = 60 / bpm;
  const barDur = 4 * T;
  let bar0 = firstBeat + phase * T;
  bar0 -= Math.floor(bar0 / barDur) * barDur;
  const n = Math.max(0, Math.floor((duration - bar0) / barDur));
  const energy: number[] = [], low: number[] = [], vocal: number[] = [], chroma: number[][] = [];
  const t0 = ff.frameTime(0);
  for (let b = 0; b < n; b++) {
    const fa = Math.max(0, Math.round((bar0 + b * barDur - t0) * ff.fps));
    const fb = Math.min(ff.frames, Math.round((bar0 + (b + 1) * barDur - t0) * ff.fps));
    let e = 0, lo = 0, v = 0, cnt = 0;
    const c = new Array(12).fill(0);
    for (let f = fa; f < fb; f++) {
      const tot = ff.low[f] + ff.mid[f] + ff.high[f];
      e += tot; lo += ff.low[f]; cnt++;
      v += ff.voiceRatio[f] * (1 - ff.voiceFlatness[f]);
      for (let p = 0; p < 12; p++) c[p] += ff.chroma[f * 12 + p];
    }
    energy.push(cnt ? Math.log10(1e-9 + e / cnt) : -9);
    low.push(e > 0 ? lo / e : 0);
    vocal.push(cnt ? v / cnt : 0);
    const cs = c.reduce((a, x) => a + x, 0) || 1;
    chroma.push(c.map((x) => x / cs));
  }
  // Normalise energy to 0..1 within the track (dB-like scale over the 0.5 .. 99.5 percentile).
  const sorted = [...energy].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
  const en = energy.map((x) => clamp((x - lo) / Math.max(1e-6, hi - lo), 0, 1));
  const vmax = Math.max(1e-6, ...vocal);
  return { bar0, barDur, energy: en, low, vocal: vocal.map((x) => clamp((x / vmax) * 1.0, 0, 1)), chroma };
}

/** Structural segmentation from a bar-level self-similarity novelty curve, snapped to 4-bar phrases. */
function segment(bars: BarData, duration: number): Section[] {
  const n = bars.energy.length;
  if (n < 8) return [];
  const feats = bars.energy.map((e, i) => [e * 2, bars.low[i] * 2, bars.vocal[i], ...bars.chroma[i].map((c) => c * 3)]);
  // z-normalise each dimension
  const dims = feats[0].length;
  for (let d = 0; d < dims; d++) {
    const col = feats.map((f) => f[d]);
    const m = mean(col), s = std(col) || 1;
    for (const f of feats) f[d] = (f[d] - m) / s;
  }
  const sim = (a: number[], b: number[]) => {
    let x = 0, na = 0, nb = 0;
    for (let i = 0; i < dims; i++) { x += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? x / Math.sqrt(na * nb) : 0;
  };
  const K = 4;
  const nov = new Array(n).fill(0);
  for (let i = K; i <= n - K; i++) {
    let s = 0;
    for (let a = -K; a < K; a++) {
      for (let b = -K; b < K; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const w = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (K / 2) ** 2));
        s += sign * w * sim(feats[i + a], feats[i + b]);
      }
    }
    nov[i] = Math.max(0, s);
  }
  // Energy steps also count as boundaries.
  for (let i = 2; i < n - 2; i++) {
    const before = (bars.energy[i - 1] + bars.energy[i - 2]) / 2;
    const after = (bars.energy[i] + bars.energy[i + 1]) / 2;
    nov[i] += Math.max(0, Math.abs(after - before) - 0.15) * 6;
  }
  const m = mean(nov), s = std(nov);
  const cands: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (nov[i] > m + 0.5 * s && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1]) cands.push(i);
  }
  // Snap to phrase grid (4 bars) and enforce a minimum length of 8 bars.
  const snapped = [...new Set(cands.map((c) => Math.round(c / 4) * 4))]
    .filter((c) => c > 0 && c < n)
    .sort((a, b) => nov[b] - nov[a] || a - b);
  const bounds: number[] = [0, n];
  for (const c of snapped) {
    if (bounds.every((b) => Math.abs(b - c) >= 8)) bounds.push(c);
  }
  bounds.sort((a, b) => a - b);
  const segs = [] as Array<{ a: number; b: number; e: number; v: number }>;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1];
    segs.push({ a, b, e: mean(bars.energy.slice(a, b)), v: mean(bars.vocal.slice(a, b)) });
  }
  const maxE = Math.max(...segs.map((x) => x.e), 1e-6);
  return segs.map((sg, i) => {
    const rel = sg.e / maxE;
    let label: SectionLabel;
    if (i === 0 && rel < 0.8 && segs.length > 1) label = 'intro';
    else if (i === segs.length - 1 && rel < 0.8 && segs.length > 1) label = 'outro';
    else if (rel >= 0.85) label = i > 0 && segs[i - 1].e / maxE < rel - 0.2 ? 'drop' : 'chorus';
    else if (rel < 0.6) label = 'break';
    else label = 'verse';
    const start = bars.bar0 + sg.a * bars.barDur;
    const end = Math.min(duration, bars.bar0 + sg.b * bars.barDur);
    return { startBar: sg.a, endBar: sg.b, start, end, label, energy: rel, vocal: sg.v };
  });
}

