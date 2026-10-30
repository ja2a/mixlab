// Deterministic music synthesiser used to build royalty-free test material with known
// tempo, key and structure (intro / main / break / main / outro).

import { spawn } from 'node:child_process';
import { findFfmpeg } from '../audio/ffmpeg';

export interface SynthSpec {
  bpm: number;
  tonic: number; // 0..11
  mode: 'major' | 'minor';
  bars: number; // total bars
  seed?: number;
  /** Leading silence in seconds. */
  lead?: number;
  sampleRate?: number;
  /** Generate a beat-less ambient texture instead. */
  ambient?: boolean;
  level?: number; // linear master gain
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export function synthesize(spec: SynthSpec): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const sr = spec.sampleRate ?? 44100;
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const lead = spec.lead ?? 0;
  const total = Math.ceil((lead + spec.bars * bar + 0.5) * sr);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const rand = rng(spec.seed ?? 1);
  const scale = spec.mode === 'major' ? MAJOR : MINOR;
  // Progression in scale degrees
  const prog = spec.mode === 'major' ? [0, 4, 5, 3] : [0, 3, 5, 4];
  const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
  const add = (t0: number, dur: number, fn: (t: number, i: number) => number, pan = 0) => {
    const a = Math.floor(t0 * sr);
    const n = Math.floor(dur * sr);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n && a + i < total; i++) {
      if (a + i < 0) continue;
      const v = fn(i / sr, i);
      L[a + i] += v * gl * Math.SQRT2;
      R[a + i] += v * gr * Math.SQRT2;
    }
  };

  const sectionOf = (b: number) => {
    const p = b / spec.bars;
    if (b < 8) return 'intro';
    if (b >= spec.bars - 8) return 'outro';
    if (p > 0.45 && p < 0.6) return 'break';
    return 'main';
  };

  if (spec.ambient) {
    // Slowly evolving filtered noise + detuned drones, no pulse.
    let lp = 0, lp2 = 0;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * t * 0.037 + 1.3) * Math.sin(2 * Math.PI * t * 0.011);
      const n = rand() * 2 - 1;
      lp += 0.02 * (n - lp);
      lp2 += 0.02 * (lp - lp2);
      const drone = 0.08 * Math.sin(2 * Math.PI * freq(48 + spec.tonic) * t) + 0.05 * Math.sin(2 * Math.PI * freq(55 + spec.tonic) * 1.003 * t + Math.sin(t * 0.3));
      const v = (lp2 * 1.8 + drone) * swell * (t < lead ? 0 : 1);
      L[i] += v; R[i] += v * 0.97;
    }
  } else {
    for (let b = 0; b < spec.bars; b++) {
      const sec = sectionOf(b);
      const tb = lead + b * bar;
      const deg = prog[Math.floor(b) % 4];
      const root = 36 + spec.tonic + scale[deg];
      const drums = sec !== 'break';
      for (let k = 0; k < 4; k++) {
        const t = tb + k * beat;
        if (drums) {
          // Kick: pitched sine sweep, slightly stronger on the downbeat.
          const amp = k === 0 ? 0.9 : 0.75;
          add(t, 0.35, (x) => amp * Math.sin(2 * Math.PI * (50 * x + 90 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 9));
          // Closed hat on the off-beat
          if (sec !== 'intro' || b >= 4) add(t + beat / 2, 0.05, () => (rand() * 2 - 1) * 0.12, 0.3);
          // Clap on 2 and 4
          if ((k === 1 || k === 3) && sec !== 'intro') add(t, 0.15, (x) => (rand() * 2 - 1) * 0.3 * Math.exp(-x * 25), -0.2);
        }
        // Bass on 8ths (root + fifth), not in intro/outro first halves
        if (sec === 'main' || (sec === 'outro' && b < spec.bars - 4)) {
          for (let e = 0; e < 2; e++) {
            const m = e === 0 ? root : root + 12;
            const f = freq(m);
            add(t + (e * beat) / 2, beat / 2 * 0.9, (x) => 0.35 * Math.tanh(2 * Math.sin(2 * Math.PI * f * x)) * Math.min(1, x * 200) * Math.exp(-x * 4));
          }
        }
      }
      // Crash on the first beat of each 8-bar phrase
      if (b % 8 === 0 && drums) add(tb, 1.2, (x) => (rand() * 2 - 1) * 0.18 * Math.exp(-x * 3), 0.1);
      // Chord pad (triad + octave) during main and break, softer in intro/outro
      const padAmp = sec === 'main' ? 0.07 : sec === 'break' ? 0.1 : 0.04;
      const chord = [0, 2, 4].map((d) => 60 + spec.tonic + scale[(deg + d) % 7] + ((deg + d) >= 7 ? 12 : 0) - 12);
      for (const [ci, m] of chord.entries()) {
        const f = freq(m);
        add(tb, bar, (x) => padAmp * Math.min(1, x * 8) * Math.min(1, (bar - x) * 8) * (Math.sin(2 * Math.PI * f * x) + 0.4 * Math.sin(4 * Math.PI * f * x) + 0.2 * Math.sin(6 * Math.PI * f * x)), ci === 0 ? -0.4 : ci === 1 ? 0 : 0.4);
      }
      // Lead melody (scale notes) in main
      if (sec === 'main' && b % 2 === 1) {
        for (let k = 0; k < 4; k++) {
          const m = 72 + spec.tonic + scale[(deg + [0, 2, 4, 2][k]) % 7];
          const f = freq(m);
          add(tb + k * beat, beat * 0.8, (x) => 0.05 * Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 3), 0.2);
        }
      }
    }
  }
  const lvl = spec.level ?? 0.5;
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0 ? lvl / peak : 1;
  for (let i = 0; i < total; i++) { L[i] *= g; R[i] *= g; }
  return { left: L, right: R, sampleRate: sr };
}

/** Encode a stereo buffer to a file through FFmpeg (format from extension). */
export function encodeFile(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  out: string,
  tags: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<void> {
  const { ffmpeg } = findFfmpeg();
  const inter = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) { inter[2 * i] = left[i]; inter[2 * i + 1] = right[i]; }
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const codec = out.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3'] : [];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0', ...extraArgs, ...codec, ...meta, '-y', out]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err))));
    p.stdin.end(Buffer.from(inter.buffer));
  });
}
