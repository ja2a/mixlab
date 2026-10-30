// ITU-R BS.1770-4 loudness (integrated LUFS, loudness range) and 4x-oversampled true peak.
// Streaming implementation: push stereo chunks, read the result at the end.

import { Biquad } from './dsp';

/** K-weighting filters for an arbitrary sample rate (coefficients derived as in pyloudnorm). */
function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high shelf
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const shelf = new Biquad().setCoefficients(
    Vh + (Vb * K) / Q + K * K,
    2 * (K * K - Vh),
    Vh - (Vb * K) / Q + K * K,
    1 + K / Q + K * K,
    2 * (K * K - 1),
    1 - K / Q + K * K,
  );
  // Stage 2: high pass (RLB)
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / fs);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  const hp = new Biquad();
  hp.b0 = 1; hp.b1 = -2; hp.b2 = 1;
  hp.a1 = (2 * (K1 * K1 - 1)) / a01;
  hp.a2 = (1 - K1 / Q1 + K1 * K1) / a01;
  return [shelf, hp];
}

/** Polyphase 4x interpolator used for true-peak estimation (windowed sinc, 12 taps per phase). */
export const TP_TAPS = 12;
export const TP_PHASES = 4;
export const TP_COEFS: Float64Array[] = (() => {
  const L = TP_TAPS * TP_PHASES;
  const h = new Float64Array(L);
  const c = (L - 1) / 2;
  for (let n = 0; n < L; n++) {
    const x = (n - c) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (L - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (L - 1));
    h[n] = sinc * w;
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const ph = new Float64Array(TP_TAPS);
    let s = 0;
    for (let j = 0; j < TP_TAPS; j++) { ph[j] = h[j * TP_PHASES + p]; s += ph[j]; }
    for (let j = 0; j < TP_TAPS; j++) ph[j] /= s;
    phases.push(ph);
  }
  return phases;
})();

export class TruePeakMeter {
  private hist: Float64Array[];
  private pos = 0;
  peak = 0;
  samplePeak = 0;

  constructor(channels: number) {
    this.hist = Array.from({ length: channels }, () => new Float64Array(TP_TAPS));
  }

  push(channels: Float32Array[], length: number): void {
    for (let i = 0; i < length; i++) {
      this.pos = (this.pos + 1) % TP_TAPS;
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c][i];
        const ax = Math.abs(x);
        if (ax > this.samplePeak) this.samplePeak = ax;
        const h = this.hist[c];
        h[this.pos] = x;
        for (let p = 0; p < TP_PHASES; p++) {
          const co = TP_COEFS[p];
          let y = 0;
          let idx = this.pos;
          for (let j = 0; j < TP_TAPS; j++) {
            y += co[j] * h[idx];
            idx = idx === 0 ? TP_TAPS - 1 : idx - 1;
          }
          const ay = Math.abs(y);
          if (ay > this.peak) this.peak = ay;
        }
      }
    }
  }
}

export interface LoudnessResult {
  integrated: number | null; // LUFS
  range: number | null; // LU
  truePeakDb: number;
  samplePeakDb: number;
  /** Momentary-ish loudness of each 400 ms block (LUFS), useful for silence detection. */
  blocks: number[];
}

export class LoudnessMeter {
  private readonly filters: Array<[Biquad, Biquad]>;
  private readonly subLen: number;
  private subAcc: number[];
  private subCount = 0;
  private readonly subBlocks: number[] = []; // channel-summed mean square for each 100 ms sub-block
  private readonly tp: TruePeakMeter;

  constructor(fs: number, private readonly channels: number) {
    this.filters = Array.from({ length: channels }, () => kWeighting(fs));
    this.subLen = Math.round(fs * 0.1);
    this.subAcc = new Array(channels).fill(0);
    this.tp = new TruePeakMeter(channels);
  }

  push(data: Float32Array[], length: number): void {
    this.tp.push(data, length);
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < this.channels; c++) {
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(data[c][i]));
        this.subAcc[c] += y * y;
      }
      if (++this.subCount === this.subLen) {
        let s = 0;
        for (let c = 0; c < this.channels; c++) { s += this.subAcc[c] / this.subLen; this.subAcc[c] = 0; }
        this.subBlocks.push(s);
        this.subCount = 0;
      }
    }
  }

  result(): LoudnessResult {
    const sb = this.subBlocks;
    const toL = (ms: number) => -0.691 + 10 * Math.log10(ms);
    // 400 ms gating blocks, 75 % overlap
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= sb.length; i++) blocks.push((sb[i] + sb[i + 1] + sb[i + 2] + sb[i + 3]) / 4);
    const blocksL = blocks.map((b) => (b > 0 ? toL(b) : -Infinity));

    let integrated: number | null = null;
    const abs = blocks.filter((_, i) => blocksL[i] > -70);
    if (abs.length) {
      const rel = toL(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const gated = blocks.filter((_, i) => blocksL[i] > -70 && blocksL[i] > rel);
      if (gated.length) integrated = toL(gated.reduce((a, b) => a + b, 0) / gated.length);
    }

    // Loudness range (EBU Tech 3342): 3 s short-term windows, 10 Hz rate.
    let range: number | null = null;
    const st: number[] = [];
    for (let i = 0; i + 30 <= sb.length; i++) {
      let s = 0;
      for (let k = 0; k < 30; k++) s += sb[i + k];
      st.push(s / 30);
    }
    const stAbs = st.filter((x) => x > 0 && toL(x) > -70);
    if (stAbs.length > 2) {
      const relGate = toL(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20;
      const vals = stAbs.map(toL).filter((l) => l > relGate).sort((a, b) => a - b);
      if (vals.length > 2) {
        const p = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(q * (vals.length - 1))))];
        range = p(0.95) - p(0.1);
      }
    }

    return {
      integrated,
      range,
      truePeakDb: this.tp.peak > 0 ? 20 * Math.log10(this.tp.peak) : -Infinity,
      samplePeakDb: this.tp.samplePeak > 0 ? 20 * Math.log10(this.tp.samplePeak) : -Infinity,
      blocks: blocksL,
    };
  }
}
