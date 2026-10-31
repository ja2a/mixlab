// Block-based mix renderer shared by preview and export.
// Stateful and sequential: call seek() then render() repeatedly. Random access is supported
// through seek() with a short pre-roll that settles filters and the limiter.

import { evalBreakpoints } from './curves';
import { ThreeBand, Limiter, SweepFilter, Echo } from './dsp';
import { ResampledSource, Wsola, WsolaChain, WSOLA_HOP, type PcmSource } from './stretch';
import { srcAtRel, type MixPlan, type VoicePlan } from './plan';

const SUB = 64; // automation sub-block
const XF = 1024; // crossfade from stretched to direct playback
const PREROLL = 0.25; // seconds
const LOOP_FADE = 96; // micro-fade at each loop-roll repetition (frames)
const WARM = 4096; // block size when warming up an echo after a seek

/**
 * Stretcher chains survive renderer instances (each preview seek opens a new session), keyed by
 * everything that determines them.
 */
const chainCache = new Map<string, WsolaChain>();
function chainFor(v: VoicePlan, startFrame: number, sr: number, ratio: number): WsolaChain {
  const key = `${v.pcmPath}|${startFrame}|${v.srcStart}|${ratio}|${JSON.stringify(v.segments)}`;
  let c = chainCache.get(key);
  if (!c) {
    // With a transposition the chain walks the resampled view, whose frame x is source frame x · ratio.
    c = new WsolaChain((o) => (srcAtRel(v, (o - startFrame) / sr) * sr) / ratio, startFrame - WSOLA_HOP);
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
  /** Last frame (exclusive) the voice contributes to: endFrame plus the echo tail. */
  tailEndFrame: number;
  stretchUntilFrame: number; // Infinity = stretched until the end, startFrame = never stretched
  directBase: number;
  ratio: number; // pitch ratio (1 = no transposition)
  loop: { start: number; end: number; beat: number } | null; // frames
  sendStartFrame: number; // first frame where the echo send is open (Infinity without echo)
  reader: PcmSource | null;
  wsola: Wsola | null;
  eq: ThreeBand | null;
  eqNext: number;
  filter: SweepFilter | null;
  filterNext: number;
  echo: Echo | null;
  echoNext: number;
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
  private lL = new Float32Array(0);
  private lR = new Float32Array(0);
  private wL = new Float32Array(WARM);
  private wR = new Float32Array(WARM);

  constructor(private readonly plan: MixPlan, private readonly open: (path: string) => PcmSource & { close?: () => void }) {
    this.sampleRate = plan.sampleRate;
    this.totalFrames = plan.totalFrames;
    const sr = plan.sampleRate;
    this.voices = plan.voices.map((v) => {
      const startFrame = Math.round(v.start * sr);
      const endFrame = Math.round(v.end * sr);
      const ratio = v.pitch ? Math.pow(2, v.pitch / 12) : 1;
      // A transposed voice always goes through the stretcher.
      const never = v.stretchUntil === 0 && ratio === 1;
      const stretchUntilFrame = ratio !== 1 ? Infinity : never ? startFrame : Number.isFinite(v.stretchUntil) ? startFrame + Math.round(v.stretchUntil * sr) : Infinity;
      const directBase = never ? Math.round(v.srcStart * sr) : Number.isFinite(stretchUntilFrame) ? Math.round(srcAtRel(v, v.stretchUntil) * sr) : 0;
      const loop = v.loop ? { start: Math.round(v.loop.start * sr), end: Math.min(endFrame, Math.round(v.loop.end * sr)), beat: Math.max(4 * LOOP_FADE, Math.round(v.loop.beat * sr)) } : null;
      const firstSend = v.echo?.send.find((b) => b.v > 0);
      return {
        plan: v, startFrame, endFrame, tailEndFrame: endFrame + (v.echo ? Math.ceil(v.echo.tail * sr) : 0), stretchUntilFrame, directBase, ratio, loop,
        sendStartFrame: firstSend ? Math.max(startFrame, Math.floor(firstSend.t * sr) - SUB) : Infinity,
        reader: null, wsola: null, eq: null, eqNext: -1, filter: null, filterNext: -1, echo: null, echoNext: -1,
      };
    });
    this.seek(0);
  }

  get position(): number { return this.outCursor; }
  get latency(): number { return this.limiter.lookahead; }
  get limiterMinGain(): number { return this.limiter.minGain; }

  seek(frame: number): void {
    const f = Math.max(0, Math.min(frame, this.totalFrames));
    this.limiter = new Limiter(this.sampleRate, this.plan.settings.ceilingDb);
    for (const v of this.voices) { v.wsola = null; v.eq = null; v.eqNext = -1; v.filter = null; v.filterNext = -1; v.echo = null; v.echoNext = -1; }
    const start = Math.max(0, f - Math.round(PREROLL * this.sampleRate));
    // An echo carries seconds of history: replay that voice alone from where its send opened.
    this.ensure(WARM);
    for (const v of this.voices) {
      if (!(v.sendStartFrame < start && start < v.tailEndFrame)) continue;
      for (let p = v.sendStartFrame; p < start; p += WARM) {
        const n = Math.min(WARM, start - p);
        this.wL.fill(0, 0, n); this.wR.fill(0, 0, n);
        this.voice(v, p, n, this.wL, this.wR);
      }
    }
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
      this.lL = new Float32Array(n); this.lR = new Float32Array(n);
    }
  }

  private renderInternal(n: number) {
    this.ensure(Math.max(n, WARM));
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
    for (const v of this.voices) this.voice(v, f0, n, L, R);
  }

  /** Add the contribution of one voice to output frames [f0, f0 + n) of L / R. */
  private voice(v: VoiceState, f0: number, n: number, L: Float32Array, R: Float32Array): void {
    const sr = this.sampleRate;
    const a = Math.max(f0, v.startFrame);
    const b = Math.min(f0 + n, v.tailEndFrame);
    if (b <= a) {
      if (v.reader && f0 > v.tailEndFrame + sr) { (v.reader as any).close?.(); v.reader = null; v.wsola = null; }
      return;
    }
    if (!v.reader) {
      const raw = this.open(v.plan.pcmPath);
      v.reader = v.ratio === 1 ? raw : new ResampledSource(raw, v.ratio);
    }
    const len = b - a;
    const off = a - f0;
    // Source audio until the voice ends; silence while its echo tail rings out.
    const srcLen = Math.max(0, Math.min(b, v.endFrame) - a);
    if (srcLen > 0) this.voiceInput(v, a, srcLen, this.vL, this.vR);
    this.vL.fill(0, srcLen, len); this.vR.fill(0, srcLen, len);
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
    // Filter sweep: one knob value per aligned sub-block (the mean of its two ends).
    if (v.plan.filter) {
      if (!v.filter || v.filterNext !== a) v.filter = new SweepFilter(sr);
      for (let s = 0; s < len; s += subLen(a + s, len - s)) {
        const m = subLen(a + s, len - s);
        const S = a + s - ((a + s) % SUB);
        const k = 0.5 * (evalBreakpoints(v.plan.filter, S / sr) + evalBreakpoints(v.plan.filter, (S + SUB) / sr));
        v.filter.process(this.vL, this.vR, s, m, k);
      }
      v.filterNext = b;
    }
    const ec = v.plan.echo;
    if (ec && (!v.echo || v.echoNext !== a)) v.echo = new Echo(sr, ec.delay, ec.feedback);
    // Fader × gain (and echo send × gain), interpolated per sub-block
    const gain = v.plan.gain;
    for (let s = 0; s < len; s += subLen(a + s, len - s)) {
      const m = subLen(a + s, len - s);
      const S = a + s - ((a + s) % SUB);
      const g0 = gain * evalBreakpoints(v.plan.fader, S / sr);
      const g1 = gain * evalBreakpoints(v.plan.fader, (S + SUB) / sr);
      const u0 = (a + s - S) / SUB;
      if (!ec) {
        for (let i = 0; i < m; i++) {
          const g = g0 + (g1 - g0) * (u0 + i / SUB);
          L[off + s + i] += this.vL[s + i] * g;
          R[off + s + i] += this.vR[s + i] * g;
        }
        continue;
      }
      const e0 = gain * evalBreakpoints(ec.send, S / sr);
      const e1 = gain * evalBreakpoints(ec.send, (S + SUB) / sr);
      const echo = v.echo!;
      for (let i = 0; i < m; i++) {
        const u = u0 + i / SUB;
        const g = g0 + (g1 - g0) * u;
        const e = e0 + (e1 - e0) * u;
        const xl = this.vL[s + i], xr = this.vR[s + i];
        echo.tick(xl * e, xr * e);
        L[off + s + i] += xl * g + echo.outL;
        R[off + s + i] += xr * g + echo.outR;
      }
    }
    if (ec) v.echoNext = b;
  }

  /** Voice audio for output frames [a, a+len) before EQ: plain playback, or the loop roll inside its window. */
  private voiceInput(v: VoiceState, a: number, len: number, outL: Float32Array, outR: Float32Array): void {
    const lp = v.loop;
    if (!lp || a + len <= lp.start || a >= lp.end) { this.voiceSamples(v, a, len, outL, outR); return; }
    let f = a;
    if (f < lp.start) { this.voiceSamples(v, f, lp.start - f, outL, outR); f = lp.start; }
    // Roll: one beat over the first half of the window, then half a beat, then a quarter.
    const W = lp.end - lp.start;
    const phases = [
      { at: lp.start, len: lp.beat },
      { at: lp.start + Math.round(W / 2), len: Math.round(lp.beat / 2) },
      { at: lp.start + Math.round((3 * W) / 4), len: Math.round(lp.beat / 4) },
    ];
    const stop = Math.min(a + len, lp.end);
    while (f < stop) {
      let ph = 0;
      while (ph < 2 && f >= phases[ph + 1].at) ph++;
      const { at, len: L } = phases[ph];
      const pos = (f - at) % L;
      const next = Math.min(stop, f + (L - pos), ph < 2 ? phases[ph + 1].at : Infinity);
      const m = next - f;
      this.voiceSamples(v, lp.start + pos, m, this.lL, this.lR);
      const F = Math.min(LOOP_FADE, L >> 2);
      for (let i = 0; i < m; i++) {
        const p = pos + i;
        const env = Math.min(1, p / F, (L - p) / F);
        outL[f - a + i] = this.lL[i] * env;
        outR[f - a + i] = this.lR[i] * env;
      }
      f = next;
    }
    if (a + len > lp.end) {
      const tmpL = this.lL, tmpR = this.lR;
      this.voiceSamples(v, lp.end, a + len - lp.end, tmpL, tmpR);
      outL.set(tmpL.subarray(0, a + len - lp.end), lp.end - a);
      outR.set(tmpR.subarray(0, a + len - lp.end), lp.end - a);
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
      if (!v.wsola || v.wsola.position !== a) v.wsola = new Wsola(reader, chainFor(v.plan, v.startFrame, sr, v.ratio), a);
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
