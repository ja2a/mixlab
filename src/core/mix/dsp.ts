// Rendering DSP blocks: 3-band Linkwitz-Riley splitter and a look-ahead true-peak-aware limiter.

import { Biquad } from '../analysis/dsp';
import { TP_COEFS, TP_PHASES, TP_TAPS } from '../analysis/loudness';

const Q_BW = Math.SQRT1_2;

/** 4th-order Linkwitz-Riley = two cascaded 2nd-order Butterworth sections. */
class LR4 {
  private a: Biquad;
  private b: Biquad;
  constructor(fs: number, fc: number, kind: 'lp' | 'hp') {
    this.a = kind === 'lp' ? Biquad.lowpass(fs, fc, Q_BW) : Biquad.highpass(fs, fc, Q_BW);
    this.b = kind === 'lp' ? Biquad.lowpass(fs, fc, Q_BW) : Biquad.highpass(fs, fc, Q_BW);
  }
  process(x: number): number { return this.b.process(this.a.process(x)); }
}

/** Splits a stereo signal into low (< 200 Hz), mid, high (> 2.5 kHz) bands with flat magnitude sum. */
export class ThreeBand {
  private ch: Array<{ lp1: LR4; hp1: LR4; lp2: LR4; hp2: LR4 }>;
  constructor(fs: number, lowHz = 200, highHz = 2500) {
    this.ch = [0, 1].map(() => ({
      lp1: new LR4(fs, lowHz, 'lp'),
      hp1: new LR4(fs, lowHz, 'hp'),
      lp2: new LR4(fs, highHz, 'lp'),
      hp2: new LR4(fs, highHz, 'hp'),
    }));
  }

  /**
   * In-place: apply per-band gains. Each gain moves linearly from g0 to g1 across an automation
   * sub-block; `u0` is the position of the first sample inside it and `du` the step per sample.
   */
  process(
    L: Float32Array, R: Float32Array, off: number, n: number, u0: number, du: number,
    low0: number, low1: number, mid0: number, mid1: number, high0: number, high1: number,
  ): void {
    for (let c = 0; c < 2; c++) {
      const buf = c === 0 ? L : R;
      const f = this.ch[c];
      for (let i = 0; i < n; i++) {
        const u = u0 + i * du;
        const x = buf[off + i];
        const lo = f.lp1.process(x);
        const rest = f.hp1.process(x);
        const mi = f.lp2.process(rest);
        const hi = f.hp2.process(rest);
        buf[off + i] = lo * (low0 + (low1 - low0) * u) + mi * (mid0 + (mid1 - mid0) * u) + hi * (high0 + (high1 - high0) * u);
      }
    }
  }
}

/**
 * Brick-wall look-ahead limiter. Gain is the sliding minimum of the required gain over the look-ahead
 * window, with exponential release, then smoothed by a moving average of the same length — this
 * guarantees the delayed signal never exceeds the ceiling. Peak detection uses the same 4×
 * oversampling filter as the true-peak meter, so inter-sample peaks are limited too.
 */
export class Limiter {
  /** Total latency in frames (look-ahead + detector pre-delay). */
  readonly lookahead: number;
  private readonly la: number;
  private ceiling: number;
  private delayL: Float32Array;
  private delayR: Float32Array;
  private deque: Int32Array; // indices into a virtual stream (monotonic queue)
  private dqHead = 0;
  private dqTail = 0;
  private reqRing: Float64Array;
  private boxRing: Float64Array;
  private boxSum = 0;
  private idx = 0;
  private release: number;
  private env = 1;
  // 4× oversampling FIR history per channel, and the pre-delay matching its group delay.
  private tpHist = [new Float64Array(TP_TAPS), new Float64Array(TP_TAPS)];
  private tpPos = 0;
  private static readonly PRE = TP_TAPS / 2;
  private preL = new Float32Array(TP_TAPS / 2);
  private preR = new Float32Array(TP_TAPS / 2);
  minGain = 1;

  constructor(fs: number, ceilingDb = -1, lookaheadMs = 5, releaseMs = 120) {
    this.la = Math.max(8, Math.round((fs * lookaheadMs) / 1000));
    this.lookahead = this.la + Limiter.PRE;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    const L = this.la;
    this.delayL = new Float32Array(L);
    this.delayR = new Float32Array(L);
    this.reqRing = new Float64Array(L + 1);
    this.deque = new Int32Array(L + 2);
    this.boxRing = new Float64Array(L).fill(1);
    this.boxSum = L;
    this.release = 1 - Math.exp(-1 / ((fs * releaseMs) / 1000));
  }

  /** True-peak estimate (max of the 4 interpolated values) around the sample PRE frames ago. */
  private truePeak(xl: number, xr: number): number {
    this.tpPos = (this.tpPos + 1) % TP_TAPS;
    let m = 0;
    for (let c = 0; c < 2; c++) {
      const h = this.tpHist[c];
      h[this.tpPos] = c === 0 ? xl : xr;
      for (let p = 0; p < TP_PHASES; p++) {
        const co = TP_COEFS[p];
        let y = 0;
        let idx = this.tpPos;
        for (let j = 0; j < TP_TAPS; j++) {
          y += co[j] * h[idx];
          idx = idx === 0 ? TP_TAPS - 1 : idx - 1;
        }
        const a = Math.abs(y);
        if (a > m) m = a;
      }
    }
    return m;
  }

  /** Process in place. Output is delayed by exactly `lookahead` frames. */
  process(L: Float32Array, R: Float32Array, n: number): void {
    const LA = this.la;
    const size = LA + 1;
    for (let i = 0; i < n; i++) {
      // Pre-delay the audio so it lines up with the oversampled detector.
      const pslot = this.idx % Limiter.PRE;
      const xl = this.preL[pslot], xr = this.preR[pslot];
      const tp = this.truePeak(L[i], R[i]);
      this.preL[pslot] = L[i];
      this.preR[pslot] = R[i];
      const pk = Math.max(tp, Math.abs(xl), Math.abs(xr));
      const req = pk > this.ceiling ? this.ceiling / pk : 1;
      const k = this.idx;
      const slot = k % size;
      this.reqRing[slot] = req;
      // Monotonic deque for the sliding minimum over the last LA+1 required gains.
      const dq = this.deque, cap = dq.length;
      while (this.dqTail !== this.dqHead) {
        const last = dq[(this.dqTail - 1 + cap) % cap];
        if (this.reqRing[last % size] >= req) this.dqTail = (this.dqTail - 1 + cap) % cap; else break;
      }
      dq[this.dqTail] = k; this.dqTail = (this.dqTail + 1) % cap;
      while (dq[this.dqHead] <= k - size) this.dqHead = (this.dqHead + 1) % cap;
      const winMin = this.reqRing[dq[this.dqHead] % size];
      // Release: rise slowly, fall instantly.
      this.env = winMin < this.env ? winMin : this.env + (winMin - this.env) * this.release;
      const g0 = Math.min(this.env, winMin);
      // Moving average (length LA) of the gain
      const bslot = k % LA;
      this.boxSum += g0 - this.boxRing[bslot];
      this.boxRing[bslot] = g0;
      const g = this.boxSum / LA;
      if (g < this.minGain) this.minGain = g;
      // Delay line (exactly LA frames, matching the sliding-minimum window)
      const dslot = k % LA;
      const outL = this.delayL[dslot], outR = this.delayR[dslot];
      this.delayL[dslot] = xl;
      this.delayR[dslot] = xr;
      // Safety clamp (should never engage)
      const c = this.ceiling;
      L[i] = Math.max(-c, Math.min(c, outL * g));
      R[i] = Math.max(-c, Math.min(c, outR * g));
      this.idx++;
    }
  }
}

/**
 * DJ-style filter knob: a resonant 2-pole state-variable filter (TPT form, stable under modulation).
 * Knob value k ∈ [-1, 1]: k < 0 low-pass from 20 kHz down to 200 Hz, k > 0 high-pass from 20 Hz up to
 * 2 kHz, k = 0 exactly dry (the filtered signal is crossfaded in over the first few % of travel).
 */
export class SweepFilter {
  private s1 = [0, 0];
  private s2 = [0, 0];
  private readonly kRes = 1 / 0.8;
  constructor(private readonly fs: number) {}

  static cutoff(k: number): number {
    return k < 0 ? 20000 * Math.pow(0.01, -k) : 20 * Math.pow(100, k);
  }

  /** In place over [off, off + n) with a constant knob value (callers update it per automation sub-block). */
  process(L: Float32Array, R: Float32Array, off: number, n: number, knob: number): void {
    const k = Math.max(-1, Math.min(1, knob));
    const wet = Math.min(1, Math.abs(k) * 25);
    const g = Math.tan((Math.PI * Math.min(SweepFilter.cutoff(k), this.fs * 0.45)) / this.fs);
    const a1 = 1 / (1 + g * (g + this.kRes)), a2 = g * a1, a3 = g * a2;
    const hp = k > 0;
    for (let c = 0; c < 2; c++) {
      const buf = c === 0 ? L : R;
      let ic1 = this.s1[c], ic2 = this.s2[c];
      for (let i = off; i < off + n; i++) {
        const x = buf[i];
        const v3 = x - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const y = hp ? x - this.kRes * v1 - v2 : v2;
        buf[i] = x + (y - x) * wet;
      }
      this.s1[c] = ic1; this.s2[c] = ic2;
    }
  }
}

/**
 * Stereo feedback delay for echo-outs. Repeats cross between channels and are band-limited
 * (one-pole high-pass ~250 Hz, low-pass ~5 kHz in the loop) so they thin out as they decay.
 */
export class Echo {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private pos = 0;
  private lpL = 0; private lpR = 0;
  private hpL = 0; private hpR = 0;
  private readonly aLp: number;
  private readonly aHp: number;
  outL = 0;
  outR = 0;
  constructor(fs: number, delaySec: number, private readonly feedback: number) {
    const d = Math.max(1, Math.round(delaySec * fs));
    this.bufL = new Float32Array(d);
    this.bufR = new Float32Array(d);
    this.aLp = 1 - Math.exp((-2 * Math.PI * 5000) / fs);
    this.aHp = 1 - Math.exp((-2 * Math.PI * 250) / fs);
  }

  /** Push one input frame; the delayed output is left in outL / outR. */
  tick(inL: number, inR: number): void {
    const yl = this.bufL[this.pos], yr = this.bufR[this.pos];
    this.lpL += this.aLp * (yl - this.lpL);
    this.lpR += this.aLp * (yr - this.lpR);
    this.hpL += this.aHp * (this.lpL - this.hpL);
    this.hpR += this.aHp * (this.lpR - this.hpR);
    this.bufL[this.pos] = inL + this.feedback * (this.lpR - this.hpR);
    this.bufR[this.pos] = inR + this.feedback * (this.lpL - this.hpL);
    this.pos = this.pos + 1 === this.bufL.length ? 0 : this.pos + 1;
    this.outL = yl;
    this.outR = yr;
  }
}
