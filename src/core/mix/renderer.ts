// Block-based mix renderer shared by preview and export.
// Stateful and sequential: call seek() then render() repeatedly. Random access is supported
// through seek() with a short pre-roll that settles filters and the limiter.

import { evalBreakpoints } from './curves';
import { ThreeBand, Limiter } from './dsp';
import { Wsola, WsolaChain, WSOLA_HOP, type PcmSource } from './stretch';
import { srcAtRel, type MixPlan, type VoicePlan } from './plan';

const SUB = 64; // automation sub-block
const XF = 1024; // crossfade from stretched to direct playback
const PREROLL = 0.25; // seconds

/**
 * Stretcher chains survive renderer instances (each preview seek opens a new session), keyed by
 * everything that determines them.
 */
const chainCache = new Map<string, WsolaChain>();
function chainFor(v: VoicePlan, startFrame: number, sr: number): WsolaChain {
  const key = `${v.pcmPath}|${startFrame}|${v.srcStart}|${JSON.stringify(v.segments)}`;
  let c = chainCache.get(key);
  if (!c) {
    c = new WsolaChain((o) => srcAtRel(v, (o - startFrame) / sr) * sr, startFrame - WSOLA_HOP);
    chainCache.set(key, c);
    if (chainCache.size > 64) chainCache.delete(chainCache.keys().next().value as string);
  }
  return c;
}

/** Automation sub-blocks are aligned on absolute multiples of SUB so output is independent of block size. */
function subLen(frame: number, remaining: number): number {
  return Math.min(SUB - (frame % SUB), remaining);
}

interface VoiceState {
  plan: VoicePlan;
  startFrame: number;
  endFrame: number;
  stretchUntilFrame: number; // Infinity = stretched until the end, startFrame = never stretched
  directBase: number;
  reader: PcmSource | null;
  wsola: Wsola | null;
  eq: ThreeBand | null;
  eqNext: number;
}

export class MixRenderer {
  readonly sampleRate: number;
  readonly totalFrames: number;
  private voices: VoiceState[];
  private limiter!: Limiter;
  private inCursor = 0;
  private outCursor = 0;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  private vL = new Float32Array(0);
  private vR = new Float32Array(0);
  private dL = new Float32Array(0);
  private dR = new Float32Array(0);

  constructor(private readonly plan: MixPlan, private readonly open: (path: string) => PcmSource & { close?: () => void }) {
    this.sampleRate = plan.sampleRate;
    this.totalFrames = plan.totalFrames;
    const sr = plan.sampleRate;
    this.voices = plan.voices.map((v) => {
      const startFrame = Math.round(v.start * sr);
      const endFrame = Math.round(v.end * sr);
      const never = v.stretchUntil === 0;
      const stretchUntilFrame = never ? startFrame : Number.isFinite(v.stretchUntil) ? startFrame + Math.round(v.stretchUntil * sr) : Infinity;
      const directBase = never ? Math.round(v.srcStart * sr) : Number.isFinite(v.stretchUntil) ? Math.round(srcAtRel(v, v.stretchUntil) * sr) : 0;
      return { plan: v, startFrame, endFrame, stretchUntilFrame, directBase, reader: null, wsola: null, eq: null, eqNext: -1 };
    });
    this.seek(0);
  }

  get position(): number { return this.outCursor; }
  get latency(): number { return this.limiter.lookahead; }
  get limiterMinGain(): number { return this.limiter.minGain; }

  seek(frame: number): void {
    const f = Math.max(0, Math.min(frame, this.totalFrames));
    this.limiter = new Limiter(this.sampleRate, this.plan.settings.ceilingDb);
    for (const v of this.voices) { v.wsola = null; v.eq = null; v.eqNext = -1; }
    const start = Math.max(0, f - Math.round(PREROLL * this.sampleRate));
    this.inCursor = start;
    // The limiter delays by `lookahead`; feed it until its output reaches `f`.
    this.outCursor = start - this.limiter.lookahead;
    const skip = f - this.outCursor;
    if (skip > 0) this.renderInternal(skip);
    this.outCursor = f;
  }

  /** Render the next `n` frames (silence beyond the end of the mix). */
  render(n: number): { left: Float32Array; right: Float32Array } {
    const out = this.renderInternal(n);
    return { left: out.left.slice(0, n), right: out.right.slice(0, n) };
  }

  private ensure(n: number) {
    if (this.bufL.length < n) {
      this.bufL = new Float32Array(n); this.bufR = new Float32Array(n);
      this.vL = new Float32Array(n); this.vR = new Float32Array(n);
      this.dL = new Float32Array(n); this.dR = new Float32Array(n);
    }
  }

  private renderInternal(n: number) {
    this.ensure(n);
    const L = this.bufL, R = this.bufR;
    L.fill(0, 0, n); R.fill(0, 0, n);
    this.mix(this.inCursor, n, L, R);
    this.limiter.process(L, R, n);
    this.inCursor += n;
    this.outCursor += n;
    return { left: L, right: R };
  }

  close(): void {
    for (const v of this.voices) {
      (v.reader as any)?.close?.();
      v.reader = null;
    }
  }

  private mix(f0: number, n: number, L: Float32Array, R: Float32Array): void {
    const sr = this.sampleRate;
    for (const v of this.voices) {
      const a = Math.max(f0, v.startFrame);
      const b = Math.min(f0 + n, v.endFrame);
      if (b <= a) {
        if (v.reader && f0 > v.endFrame + sr) { (v.reader as any).close?.(); v.reader = null; v.wsola = null; }
        continue;
      }
      if (!v.reader) v.reader = this.open(v.plan.pcmPath);
      const len = b - a;
      const off = a - f0;
      this.voiceSamples(v, a, len, this.vL, this.vR);
      // EQ (phase-coherent across the whole life of the voice)
      if (v.plan.eq) {
        if (!v.eq || v.eqNext !== a) v.eq = new ThreeBand(sr);
        for (let s = 0; s < len; s += subLen(a + s, len - s)) {
          const m = subLen(a + s, len - s);
          const S = a + s - ((a + s) % SUB); // aligned sub-block start
          const t0 = S / sr, t1 = (S + SUB) / sr;
          const e = v.plan.eq;
          v.eq.process(this.vL, this.vR, s, m, (a + s - S) / SUB, 1 / SUB,
            evalBreakpoints(e.low, t0), evalBreakpoints(e.low, t1),
            evalBreakpoints(e.mid, t0), evalBreakpoints(e.mid, t1),
            evalBreakpoints(e.high, t0), evalBreakpoints(e.high, t1));
        }
        v.eqNext = b;
      }
      // Fader × gain, interpolated per sub-block
      const gain = v.plan.gain;
      for (let s = 0; s < len; s += subLen(a + s, len - s)) {
        const m = subLen(a + s, len - s);
        const S = a + s - ((a + s) % SUB);
        const g0 = gain * evalBreakpoints(v.plan.fader, S / sr);
        const g1 = gain * evalBreakpoints(v.plan.fader, (S + SUB) / sr);
        const u0 = (a + s - S) / SUB;
        for (let i = 0; i < m; i++) {
          const g = g0 + (g1 - g0) * (u0 + i / SUB);
          L[off + s + i] += this.vL[s + i] * g;
          R[off + s + i] += this.vR[s + i] * g;
        }
      }
    }
  }

  /** Source samples of a voice for output frames [a, a+len). */
  private voiceSamples(v: VoiceState, a: number, len: number, outL: Float32Array, outR: Float32Array): void {
    const reader = v.reader!;
    const sr = this.sampleRate;
    const su = v.stretchUntilFrame;
    if (su === v.startFrame) {
      reader.read(v.directBase + (a - v.startFrame), len, outL, outR, 0);
      return;
    }
    const wsEnd = Math.min(a + len, su + XF);
    if (a < wsEnd) {
      if (!v.wsola || v.wsola.position !== a) v.wsola = new Wsola(reader, chainFor(v.plan, v.startFrame, sr), a);
      v.wsola.read(wsEnd - a, outL, outR, 0);
    }
    if (a + len > su) {
      const ds = Math.max(a, su);
      const dn = a + len - ds;
      reader.read(v.directBase + (ds - su), dn, this.dL, this.dR, 0);
      for (let i = 0; i < dn; i++) {
        const f = ds + i;
        const k = f - a;
        const w = Math.min(1, (f - su) / XF);
        if (w >= 1) { outL[k] = this.dL[i]; outR[k] = this.dR[i]; }
        else { outL[k] = outL[k] * (1 - w) + this.dL[i] * w; outR[k] = outR[k] * (1 - w) + this.dR[i] * w; }
      }
      if (a + len >= su + XF) v.wsola = null;
    }
  }
}
