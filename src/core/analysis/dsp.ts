// Low-level DSP helpers: radix-2 FFT, windows, biquads.

export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /** In-place complex FFT. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export function hann(n: number, periodic = true): Float64Array {
  const w = new Float64Array(n);
  const d = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

/**
 * Short-time magnitude spectrogram. Calls `onFrame(frameIndex, magnitudes)` for each frame.
 * The magnitude array is reused between calls.
 */
export function stft(
  signal: Float32Array,
  size: number,
  hop: number,
  onFrame: (index: number, mag: Float64Array) => void,
): number {
  const fft = new FFT(size);
  const win = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mag = new Float64Array(size / 2 + 1);
  const frames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = signal[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(f, mag);
  }
  return frames;
}

/** Direct form I biquad, one channel. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  setCoefficients(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  static lowpass(fs: number, f0: number, q: number): Biquad {
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    return new Biquad().setCoefficients((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static highpass(fs: number, f0: number, q: number): Biquad {
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    return new Biquad().setCoefficients((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }
}

export function dbToGain(db: number): number { return Math.pow(10, db / 20); }
export function gainToDb(g: number): number { return g > 0 ? 20 * Math.log10(g) : -Infinity; }

export function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
}

export function median(a: ArrayLike<number>): number {
  if (!a.length) return 0;
  const s = Array.from(a).sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function std(a: ArrayLike<number>): number {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return a.length ? Math.sqrt(s / a.length) : 0;
}

/** Linear interpolation into an array at fractional index. */
export function lerpAt(a: ArrayLike<number>, x: number): number {
  if (x <= 0) return a[0] ?? 0;
  const i = Math.floor(x);
  if (i >= a.length - 1) return a[a.length - 1] ?? 0;
  const f = x - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
