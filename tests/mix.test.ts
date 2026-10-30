import { describe, expect, it, beforeAll } from 'vitest';
import { buildTrack, mixtapeOf, tmpRoot, type Built } from './helpers';
import { buildPlan, srcAtRel, relAtSrc, type MixPlan } from '../src/core/mix/plan';
import { MixRenderer } from '../src/core/mix/renderer';
import { Wsola, WsolaChain, type PcmSource } from '../src/core/mix/stretch';
import { Limiter } from '../src/core/mix/dsp';
import { PcmReader } from '../src/core/audio/pcm';
import { TruePeakMeter } from '../src/core/analysis/loudness';
import { gridOf } from '../src/core/music/grid';
import { defaultTransition } from '../src/core/types';

const dir = tmpRoot();
let A: Built, B: Built, C: Built, D: Built;
let plan: MixPlan;

function renderAll(p: MixPlan, chunk = 16384): { L: Float32Array; R: Float32Array; r: MixRenderer } {
  const r = new MixRenderer(p, (f) => new PcmReader(f));
  const L = new Float32Array(p.totalFrames), R = new Float32Array(p.totalFrames);
  for (let pos = 0; pos < p.totalFrames; pos += chunk) {
    const n = Math.min(chunk, p.totalFrames - pos);
    const o = r.render(n);
    L.set(o.left, pos); R.set(o.right, pos);
  }
  r.close();
  return { L, R, r };
}

beforeAll(async () => {
  A = await buildTrack(dir, 'A', { bpm: 124, tonic: 9, mode: 'minor', bars: 40, seed: 31 });
  B = await buildTrack(dir, 'B', { bpm: 126, tonic: 0, mode: 'major', bars: 48, seed: 32, lead: 0.4 });
  C = await buildTrack(dir, 'C', { bpm: 128, tonic: 4, mode: 'minor', bars: 40, seed: 33 });
  D = await buildTrack(dir, 'D', { bpm: 100, tonic: 7, mode: 'major', bars: 24, seed: 34 });
  const { mixtape, map } = mixtapeOf([A, B, C, D]);
  plan = buildPlan({ mixtape, tracks: map });
});

describe('mix plan', () => {
  it('total length = sum of played lengths − overlaps', () => {
    const played = plan.voices.reduce((s, v) => s + (v.end - v.start), 0);
    const overlaps = plan.transitions.reduce((s, t) => s + t.duration, 0);
    expect(Math.abs(plan.duration - (played - overlaps))).toBeLessThan(1e-6);
    // and played length matches the source material consumed, tempo changes included
    for (const v of plan.voices) {
      expect(Math.abs(srcAtRel(v, v.end - v.start) - v.srcEnd)).toBeLessThan(1e-3);
    }
  });

  it('beat-matches synced transitions: B’s beats land on A’s beats (analytic, < 1 ms)', () => {
    const synced = plan.transitions.filter((t) => t.synced);
    expect(synced.length).toBeGreaterThanOrEqual(2);
    for (const t of synced) {
      const va = plan.voices[t.index], vb = plan.voices[t.index + 1];
      const ga = gridOf([A, B, C, D][t.index].eff)!, gb = gridOf([A, B, C, D][t.index + 1].eff)!;
      // A's beats in output time during the overlap
      for (let k = 0; k < 8; k++) {
        const srcA = t.aStart + k * ga.beat;
        const outA = va.start + relAtSrc(va, srcA);
        if (outA > t.end) break;
        // nearest B beat in output time
        const srcB = srcAtRel(vb, outA - vb.start);
        const nB = Math.round((srcB - gb.bar0) / gb.beat);
        const outB = vb.start + relAtSrc(vb, gb.bar0 + nB * gb.beat);
        expect(Math.abs(outB - outA)).toBeLessThan(0.001);
      }
      // downbeat on downbeat at the start
      const bars = (t.aStart - ga.bar0) / ga.bar;
      expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
    }
  });

  it('falls back to an unsynchronised fade when tempi are too far apart (and says so)', () => {
    const t = plan.transitions[2]; // 128 → 100 BPM
    expect(t.synced).toBe(false);
    expect(t.notes.join(' ')).toMatch(/Synchronisation impossible/);
    expect(t.severity).toBe('warn');
  });

  it('chooses half/double-time when it is the closest relation', async () => {
    const H = await buildTrack(dir, 'H', { bpm: 70, tonic: 9, mode: 'minor', bars: 24, seed: 40 });
    const F = await buildTrack(dir, 'F', { bpm: 141, tonic: 9, mode: 'minor', bars: 32, seed: 41 });
    const { mixtape, map } = mixtapeOf([F, H]);
    const p = buildPlan({ mixtape, tracks: map });
    const t = p.transitions[0];
    expect(t.synced).toBe(true);
    // H is detected at 140 (double of 70) or 70: either way the relation must be within ~1 %
    expect(t.stretchPct).toBeLessThan(1.5);
  });
});

describe('rendering', () => {
  let L: Float32Array, R: Float32Array;
  beforeAll(() => { ({ L, R } = renderAll(plan)); });

  it('never clips: true peak ≤ ceiling', () => {
    const tp = new TruePeakMeter(2);
    tp.push([L, R], L.length);
    expect(20 * Math.log10(tp.peak)).toBeLessThanOrEqual(plan.settings.ceilingDb + 0.05);
  });

  it('has no artificial silence between tracks', () => {
    const win = 2205; // 50 ms
    let longest = 0, run = 0;
    for (let i = 0; i + win <= L.length; i += win) {
      let s = 0;
      for (let k = i; k < i + win; k++) s += L[k] * L[k] + R[k] * R[k];
      const db = 10 * Math.log10(s / (2 * win) + 1e-20);
      if (db < -60) { run++; longest = Math.max(longest, run); } else run = 0;
    }
    expect(longest * 0.05).toBeLessThan(0.1);
  });

  it('has no clicks at voice boundaries or tempo-return switch points', () => {
    const sr = plan.sampleRate;
    const diffs = new Float32Array(L.length - 1);
    for (let i = 1; i < L.length; i++) diffs[i - 1] = Math.abs(L[i] - L[i - 1]);
    const sorted = Float32Array.from(diffs).sort();
    const p999 = sorted[Math.floor(sorted.length * 0.999)];
    const points: number[] = [];
    for (const v of plan.voices) {
      points.push(v.start, v.end);
      if (Number.isFinite(v.stretchUntil) && v.stretchUntil > 0) points.push(v.start + v.stretchUntil);
    }
    for (const t of points) {
      const c = Math.round(t * sr);
      let m = 0;
      for (let i = Math.max(0, c - 220); i < Math.min(diffs.length, c + 220); i++) m = Math.max(m, diffs[i]);
      expect(m, `boundary at ${t.toFixed(2)} s`).toBeLessThanOrEqual(p999 * 1.5);
    }
  });

  it('is identical whatever the block size (preview chunks = export blocks)', () => {
    const { L: L2 } = renderAll(plan, 4096);
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i] - L2[i]));
    expect(maxDiff).toBe(0);
  });

  it('seeking renders the same audio as continuous playback (after pre-roll)', () => {
    const r = new MixRenderer(plan, (f) => new PcmReader(f));
    const t = plan.transitions[0];
    const f = Math.round((t.start + 3) * plan.sampleRate);
    r.seek(f);
    const o = r.render(44100);
    r.close();
    let err = 0, ref = 0;
    for (let i = 0; i < 44100; i++) { err += (o.left[i] - L[f + i]) ** 2; ref += L[f + i] ** 2; }
    expect(10 * Math.log10(err / ref)).toBeLessThan(-50);
  });

  it('beat-matched audio: B’s kicks hit A’s grid in the rendered overlap', () => {
    const t = plan.transitions.find((x) => x.synced)!;
    const p2: MixPlan = { ...plan, voices: plan.voices.map((v, i) => (i === t.index ? { ...v, gain: 0 } : v)) };
    const r = new MixRenderer(p2, (f) => new PcmReader(f));
    const sr = plan.sampleRate;
    r.seek(Math.round(t.start * sr));
    const n = Math.round(t.duration * sr);
    const o = r.render(n);
    r.close();
    const va = plan.voices[t.index];
    const ga = gridOf([A, B, C, D][t.index].eff)!;
    const offsets: number[] = [];
    const env = (i: number) => Math.abs(o.left[i]) + Math.abs(o.right[i]);
    for (let k = 1; k < 24; k++) {
      const outA = va.start + relAtSrc(va, t.aStart + k * ga.beat) - t.start;
      if (outA > t.duration - 0.1) break;
      // onset = first sample in ±60 ms where the envelope rises above half the local max
      const a = Math.max(0, Math.round((outA - 0.06) * sr)), b = Math.min(n, Math.round((outA + 0.06) * sr));
      let mx = 0;
      for (let i = a; i < b; i++) mx = Math.max(mx, env(i));
      let on = a;
      while (on < b && env(on) < mx * 0.5) on++;
      offsets.push(on / sr - outA);
    }
    offsets.sort((x, y) => x - y);
    const med = offsets[Math.floor(offsets.length / 2)];
    expect(Math.abs(med)).toBeLessThan(0.012);
  });
});

describe('DSP building blocks', () => {
  const sr = 44100;
  const source = (data: Float32Array): PcmSource => ({
    frames: data.length,
    read(start, n, l, r, off = 0) { for (let i = 0; i < n; i++) { const f = start + i; const v = f >= 0 && f < data.length ? data[f] : 0; l[off + i] = v; r[off + i] = v; } },
  });

  it('WSOLA keeps the pitch while changing the tempo', () => {
    const n = sr * 4;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const rate = 0.94;
    const w = new Wsola(source(x), new WsolaChain((o) => o * rate, -1024), 0);
    const outN = sr * 3;
    const l = new Float32Array(outN), r = new Float32Array(outN);
    w.read(outN, l, r);
    // zero-crossing frequency estimate on the middle second
    let zc = 0;
    for (let i = sr + 1; i < 2 * sr; i++) if (l[i - 1] <= 0 && l[i] > 0) zc++;
    expect(Math.abs(zc - 440)).toBeLessThanOrEqual(3);
  });

  it('WSOLA follows the requested time map (click train)', () => {
    const n = sr * 6;
    const x = new Float32Array(n);
    for (let c = 0; c < 12; c++) for (let k = 0; k < 200; k++) x[Math.round(c * 0.5 * sr) + k] = Math.exp(-k / 30) * (k % 2 ? -1 : 1);
    const rate = 1.05;
    const w = new Wsola(source(x), new WsolaChain((o) => o * rate, -1024), 0);
    const outN = Math.floor((n / rate) * 0.95);
    const l = new Float32Array(outN), r = new Float32Array(outN);
    w.read(outN, l, r);
    for (let c = 2; c < 10; c++) {
      const expectAt = (c * 0.5) / rate;
      const a = Math.round((expectAt - 0.03) * sr), b = Math.round((expectAt + 0.03) * sr);
      let arg = a, mx = 0;
      for (let i = a; i < b; i++) if (Math.abs(l[i]) > mx) { mx = Math.abs(l[i]); arg = i; }
      expect(Math.abs(arg / sr - expectAt)).toBeLessThan(0.01);
    }
  });

  it('the limiter holds the true-peak ceiling on a hot signal', () => {
    const n = sr * 3;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      l[i] = 1.6 * Math.sin(2 * Math.PI * 60 * t) + 0.9 * Math.sin(2 * Math.PI * 7350 * t + 0.3) * (Math.sin(t * 9) > 0 ? 1 : 0.2);
      r[i] = l[i] * 0.9;
    }
    const lim = new Limiter(sr, -1);
    lim.process(l, r, n);
    const tp = new TruePeakMeter(2);
    tp.push([l.subarray(lim.lookahead), r.subarray(lim.lookahead)], n - lim.lookahead);
    expect(20 * Math.log10(tp.peak)).toBeLessThan(-0.85);
  });

  it('honours user cue points and explicit transition points', () => {
    const { mixtape, map } = mixtapeOf([A, B]);
    mixtape.entries[0].cueOut = 60;
    mixtape.entries[1].cueIn = 4;
    const ga = gridOf(A.eff)!;
    mixtape.transitions.e0 = { ...defaultTransition(), bars: 8, outStart: ga.bar0 + 20 * ga.bar, origin: 'manual' };
    const p = buildPlan({ mixtape, tracks: map });
    const t = p.transitions[0];
    expect(Math.abs(t.aStart - (ga.bar0 + 20 * ga.bar))).toBeLessThan(1e-6);
    expect(t.aEnd).toBeLessThanOrEqual(60 + 1e-6);
    expect(t.bStart).toBeGreaterThanOrEqual(4 - 1e-6);
  });
});
