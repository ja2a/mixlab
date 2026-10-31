// WSOLA (Waveform Similarity Overlap-Add) time-stretcher with a time-varying rate.
// Pitch is preserved; the analysis position of every frame follows an arbitrary mapping
// output frame → source frame, so tempo ramps are rendered exactly.
//
// Frame positions (the "chain") are computed once, sequentially, from the start of the voice and
// cached: rendering from any point (seek, preview, export) therefore produces identical audio.

export interface PcmSource {
  readonly frames: number;
  read(start: number, n: number, left: Float32Array, right: Float32Array, offset?: number): void;
}

const N = 2048; // frame length (46 ms)
const HS = N / 2; // synthesis hop
const DELTA = 384; // search tolerance (±8.7 ms)
const DEC = 4; // decimation for the coarse search

const WINDOW = (() => {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic Hann: sums to 1 at 50 % overlap
  return w;
})();

/** Sequentially computed source positions of the analysis frames of one voice. */
export class WsolaChain {
  private qs: number[] = [];
  private regL = new Float32Array(2 * DELTA + HS + DEC);
  private regR = new Float32Array(2 * DELTA + HS + DEC);
  private refL = new Float32Array(HS);
  private refR = new Float32Array(HS);
  private refD = new Float32Array(HS / DEC);
  private regD = new Float32Array(Math.floor((2 * DELTA + HS) / DEC));

  /**
   * @param posAt  maps an absolute output frame to a fractional source frame
   * @param origin output frame where frame 0 is placed (voice start − HS)
   */
  constructor(private readonly posAt: (outFrame: number) => number, readonly origin: number) {}

  /** Source position of frame k (the source is passed in so a cached chain never holds a closed reader). */
  q(k: number, src: PcmSource): number {
    while (this.qs.length <= k) this.qs.push(this.compute(this.qs.length, src));
    return this.qs[k];
  }

  private compute(k: number, src: PcmSource): number {
    const o = this.origin + k * HS;
    const p = Math.round(this.posAt(o + N / 2) - N / 2);
    return k === 0 ? p : this.search(p, this.qs[k - 1] + HS, src);
  }

  /** Find the frame start q ∈ [p − Δ, p + Δ] whose first half best continues the previous frame. */
  private search(p: number, natural: number, src: PcmSource): number {
    if (Math.abs(natural - p) <= 1) return natural;
    const lo = p - DELTA;
    const regLen = 2 * DELTA + HS;
    src.read(lo, regLen, this.regL, this.regR);
    src.read(natural, HS, this.refL, this.refR);
    const refD = this.refD, regD = this.regD;
    let refE = 0;
    for (let i = 0; i < refD.length; i++) {
      let s = 0;
      for (let k = 0; k < DEC; k++) s += this.refL[i * DEC + k] + this.refR[i * DEC + k];
      refD[i] = s;
      refE += s * s;
    }
    if (refE < 1e-9) return p;
    for (let i = 0; i < regD.length; i++) {
      let s = 0;
      for (let k = 0; k < DEC; k++) s += this.regL[i * DEC + k] + this.regR[i * DEC + k];
      regD[i] = s;
    }
    const nCand = Math.floor((2 * DELTA) / DEC) + 1;
    let bestC = DELTA / DEC, best = -Infinity;
    let e = 0;
    for (let i = 0; i < refD.length; i++) e += regD[i] * regD[i];
    for (let c = 0; c < nCand; c++) {
      if (c > 0) {
        const out = regD[c - 1], inn = regD[c - 1 + refD.length];
        e += inn * inn - out * out;
      }
      let dot = 0;
      for (let i = 0; i < refD.length; i++) dot += refD[i] * regD[c + i];
      const ncc = e > 1e-12 ? dot / Math.sqrt(e * refE) : 0;
      const score = ncc - (0.15 * Math.abs(c * DEC - DELTA)) / DELTA;
      if (score > best) { best = score; bestC = c; }
    }
    // Full-resolution refinement around the coarse optimum.
    let bestQ = lo + bestC * DEC;
    best = -Infinity;
    for (let off = bestC * DEC - DEC; off <= bestC * DEC + DEC; off++) {
      if (off < 0 || off > 2 * DELTA) continue;
      let dot = 0, en = 0, er = 0;
      for (let i = 0; i < HS; i += 2) {
        const x = this.regL[off + i] + this.regR[off + i];
        const y = this.refL[i] + this.refR[i];
        dot += x * y; en += x * x; er += y * y;
      }
      const ncc = en > 1e-12 && er > 1e-12 ? dot / Math.sqrt(en * er) : 0;
      const score = ncc - (0.15 * Math.abs(off - DELTA)) / DELTA;
      if (score > best) { best = score; bestQ = lo + off; }
    }
    return bestQ;
  }
}

/** Overlap-add renderer reading frame positions from a chain. Output starts at any frame. */
export class Wsola {
  private k: number; // next frame index
  private emitted: number; // next output frame to hand out
  private accL = new Float32Array(N);
  private accR = new Float32Array(N);
  private queueL = new Float32Array(HS);
  private queueR = new Float32Array(HS);
  private queueLen = 0;
  private queuePos = 0;
  private fL = new Float32Array(N);
  private fR = new Float32Array(N);

  constructor(private readonly src: PcmSource, private readonly chain: WsolaChain, start: number) {
    // Samples in [o_k, o_k + HS) need frames k−1 and k: begin one frame before the one covering `start`.
    this.k = Math.max(0, Math.floor((start - chain.origin) / HS) - 1);
    this.emitted = start;
  }

  /** Output frame index of the next sample `read` will produce. */
  get position(): number { return this.emitted; }

  read(n: number, outL: Float32Array, outR: Float32Array, offset = 0): void {
    let i = 0;
    while (i < n) {
      if (this.queuePos >= this.queueLen) this.step();
      const take = Math.min(n - i, this.queueLen - this.queuePos);
      outL.set(this.queueL.subarray(this.queuePos, this.queuePos + take), offset + i);
      outR.set(this.queueR.subarray(this.queuePos, this.queuePos + take), offset + i);
      this.queuePos += take;
      i += take;
      this.emitted += take;
    }
  }

  private step(): void {
    for (;;) {
      const frameOut = this.chain.origin + this.k * HS;
      const q = this.chain.q(this.k, this.src);
      this.src.read(q, N, this.fL, this.fR);
      const aL = this.accL, aR = this.accR;
      for (let j = 0; j < N; j++) {
        aL[j] += this.fL[j] * WINDOW[j];
        aR[j] += this.fR[j] * WINDOW[j];
      }
      // The first HS samples are now complete.
      const skip = Math.max(0, this.emitted - frameOut);
      this.queueLen = 0;
      this.queuePos = 0;
      for (let j = skip; j < HS; j++) {
        this.queueL[this.queueLen] = aL[j];
        this.queueR[this.queueLen] = aR[j];
        this.queueLen++;
      }
      aL.copyWithin(0, HS);
      aR.copyWithin(0, HS);
      aL.fill(0, N - HS);
      aR.fill(0, N - HS);
      this.k++;
      if (this.queueLen > 0) return;
    }
  }
}

export const WSOLA_FRAME = N;
export const WSOLA_HOP = HS;

/**
 * A source played `ratio` times faster (4-point Catmull-Rom interpolation): virtual frame x reads
 * source frame x · ratio. Stretching this view back to the original tempo with WSOLA transposes the
 * pitch by `ratio` without changing the tempo.
 */
export class ResampledSource implements PcmSource {
  readonly frames: number;
  private tL = new Float32Array(0);
  private tR = new Float32Array(0);
  constructor(private readonly src: PcmSource & { close?: () => void }, readonly ratio: number) {
    this.frames = Math.floor(src.frames / ratio);
  }

  read(start: number, n: number, left: Float32Array, right: Float32Array, offset = 0): void {
    if (n <= 0) return;
    const p = this.ratio;
    const s0 = Math.floor(start * p) - 1;
    const m = Math.floor((start + n - 1) * p) - s0 + 4;
    if (this.tL.length < m) { this.tL = new Float32Array(m); this.tR = new Float32Array(m); }
    this.src.read(s0, m, this.tL, this.tR);
    const L = this.tL, R = this.tR;
    for (let i = 0; i < n; i++) {
      const x = (start + i) * p - s0;
      const j = Math.floor(x);
      const f = x - j;
      const c0 = (-0.5 * f + f * f - 0.5 * f * f * f);
      const c1 = (1 - 2.5 * f * f + 1.5 * f * f * f);
      const c2 = (0.5 * f + 2 * f * f - 1.5 * f * f * f);
      const c3 = (-0.5 * f * f + 0.5 * f * f * f);
      left[offset + i] = c0 * L[j - 1] + c1 * L[j] + c2 * L[j + 1] + c3 * L[j + 2];
      right[offset + i] = c0 * R[j - 1] + c1 * R[j] + c2 * R[j + 1] + c3 * R[j + 2];
    }
  }

  close(): void { this.src.close?.(); }
}
