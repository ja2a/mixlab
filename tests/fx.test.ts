// Transposition, transition effects (filter, echo, loop roll) and energy-shaped / length-targeted generation.
import { describe, expect, it, beforeAll } from 'vitest';
import { buildTrack, mixtapeOf, tmpRoot, type Built } from './helpers';
import { buildPlan, type MixPlan, type VoicePlan } from '../src/core/mix/plan';
import { MixRenderer } from '../src/core/mix/renderer';
import { SweepFilter } from '../src/core/mix/dsp';
import type { PcmSource } from '../src/core/mix/stretch';
import { PcmReader } from '../src/core/audio/pcm';
import { bestTransposition, makeKey, transposeKey } from '../src/core/music/camelot';
import { generateOrders, ARC_SHAPES } from '../src/core/music/optimize';
import { proposeTransitions } from '../src/core/music/suggest';
import { DEFAULT_SETTINGS, defaultTransition, type EffectiveTrack, type PlaylistEntry, type TrackAnalysis, type TransitionSpec } from '../src/core/types';

const SR = 44100;

function render(p: MixPlan, open: (f: string) => PcmSource, chunk = 16384, from = 0): { L: Float32Array; R: Float32Array } {
  const r = new MixRenderer(p, open);
  if (from) r.seek(from);
  const n = p.totalFrames - from;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let pos = 0; pos < n; pos += chunk) {
    const m = Math.min(chunk, n - pos);
    const o = r.render(m);
    L.set(o.left, pos); R.set(o.right, pos);
  }
  r.close();
  return { L, R };
}

const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

describe('transposition', () => {
  class Sine implements PcmSource {
    readonly frames = SR * 6;
    read(start: number, n: number, l: Float32Array, r: Float32Array, off = 0) {
      for (let i = 0; i < n; i++) {
        const f = start + i;
        l[off + i] = r[off + i] = f >= 0 && f < this.frames ? 0.3 * Math.sin((2 * Math.PI * 440 * f) / SR) : 0;
      }
    }
  }
  const voice = (pitch: number): MixPlan => {
    const v: VoicePlan = {
      entryId: 'e', trackId: 't', title: 'Sine', artist: '', pcmPath: 'mem:sine440', start: 0, end: 5, srcStart: 0, srcEnd: 5,
      segments: [{ t0: 0, t1: Infinity, r0: 1, r1: 1 }], stretchUntil: 0, trimmed: { in: 0, out: 0 }, gain: 1, normDb: 0, fader: [{ t: 0, v: 1 }], eq: null,
      pitch, filter: null, echo: null, loop: null,
    };
    return { sampleRate: SR, duration: 5, totalFrames: 5 * SR, voices: [v], transitions: [], warnings: [], settings: { ...DEFAULT_SETTINGS } };
  };
  const freq = (x: Float32Array) => {
    let z = 0;
    const a = 2 * SR, b = 3 * SR;
    for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
    return z / 2;
  };

  it('changes the pitch by the requested semitones and keeps the duration', () => {
    for (const s of [-2, 1, 2]) {
      const p = voice(s);
      const { L } = render(p, () => new Sine());
      expect(L.length).toBe(5 * SR);
      expect(Math.abs(freq(L) / (440 * Math.pow(2, s / 12)) - 1)).toBeLessThan(0.003);
      expect(rms(L, 2 * SR, 3 * SR)).toBeGreaterThan(0.15); // no level collapse through the stretcher
    }
    expect(Math.abs(freq(render(voice(0), () => new Sine()).L) / 440 - 1)).toBeLessThan(0.003);
  });

  it('transposes keys on the Camelot wheel and finds the shift that fixes a clash', () => {
    const am = makeKey(9, 'minor', 1); // 8A
    expect(transposeKey(am, 1).camelot).toBe('3A'); // B♭ minor
    expect(transposeKey(am, -2).camelot).toBe('6A'); // G minor
    const gsm = makeKey(8, 'minor', 1); // G♯ minor = 1A, a semitone below A minor
    const best = bestTransposition(am, gsm, 2);
    expect(best.semitones).toBe(1);
    expect(best.key.camelot).toBe('8A');
    expect(bestTransposition(am, am, 2).semitones).toBe(0);
  });
});

describe('sweep filter', () => {
  const tone = (hz: number) => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    return x;
  };
  const through = (hz: number, knob: number) => {
    const L = tone(hz), R = tone(hz);
    new SweepFilter(SR).process(L, R, 0, L.length, knob);
    return 20 * Math.log10(rms(L, SR / 2) / rms(tone(hz), SR / 2));
  };
  it('high-passes, low-passes, and is exactly dry at the centre', () => {
    expect(through(60, 1)).toBeLessThan(-30); // HP at 2 kHz removes the bass
    expect(through(8000, 1)).toBeGreaterThan(-1);
    expect(through(6000, -1)).toBeLessThan(-30); // LP at 200 Hz removes the highs
    expect(through(60, -1)).toBeGreaterThan(-1);
    const L = tone(440), R = tone(440);
    new SweepFilter(SR).process(L, R, 0, L.length, 0);
    expect(L).toEqual(tone(440));
  });
});

describe('transition effects in the rendered mix', () => {
  const dir = tmpRoot();
  let A: Built, B: Built, C: Built, D: Built;
  const open = (f: string) => new PcmReader(f);
  const fx = (effect: TransitionSpec['effect'], toEntryId: string): TransitionSpec => ({ ...defaultTransition(), bars: 8, effect, origin: 'manual', toEntryId });

  beforeAll(async () => {
    A = await buildTrack(dir, 'A', { bpm: 124, tonic: 9, mode: 'minor', bars: 32, seed: 51 });
    B = await buildTrack(dir, 'B', { bpm: 124, tonic: 0, mode: 'major', bars: 32, seed: 52 });
    C = await buildTrack(dir, 'C', { bpm: 125, tonic: 4, mode: 'minor', bars: 32, seed: 53 });
    D = await buildTrack(dir, 'D', { bpm: 124, tonic: 7, mode: 'major', bars: 32, seed: 54 });
  });

  const planWith = (effects: Array<TransitionSpec['effect']>, pitch: Record<number, number> = {}) => {
    const { mixtape, map } = mixtapeOf([A, B, C, D]);
    mixtape.entries.forEach((e, i) => { if (pitch[i]) e.pitch = pitch[i]; });
    effects.forEach((ef, i) => { mixtape.transitions['e' + i] = fx(ef, 'e' + (i + 1)); });
    return buildPlan({ mixtape, tracks: map });
  };

  it('plans each effect on the right voices', () => {
    const p = planWith(['echo', 'loop', 'filter'], { 2: 1 });
    expect(p.transitions.map((t) => t.effect)).toEqual(['echo', 'loop', 'filter']);
    expect(p.transitions.every((t) => t.synced && t.beat !== null)).toBe(true);
    const [va, vb, vc, vd] = p.voices;
    expect(va.echo?.delay).toBeCloseTo(60 / 124, 3); // one beat
    expect(va.echo!.tail).toBeGreaterThan(3 * va.echo!.delay);
    expect(vb.loop).not.toBeNull();
    expect(vb.loop!.end).toBeCloseTo(p.transitions[1].end, 6);
    expect(vc.pitch).toBe(1);
    expect(vc.filter?.some((b) => b.v > 0.5)).toBe(true); // C is high-passed away
    expect(vd.filter?.some((b) => b.v < -0.5)).toBe(true); // D opens from a low-pass
    expect(vd.filter![vd.filter!.length - 1].v).toBe(0);
  });

  it('is identical whatever the block size, with every effect and a transposition', () => {
    const p = planWith(['echo', 'loop', 'filter'], { 2: 1 });
    const a = render(p, open, 16384);
    const b = render(p, open, 997);
    expect(b.L).toEqual(a.L);
    expect(b.R).toEqual(a.R);
  });

  it('echo: the outgoing track rings on after its end, and the audio before the send is untouched', () => {
    const withFx = planWith(['echo', 'none', 'none']);
    const plain = planWith(['none', 'none', 'none']);
    const t = withFx.transitions[0];
    expect(withFx.totalFrames).toBe(plain.totalFrames);
    const x = render(withFx, open).L, y = render(plain, open).L;
    const diff = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) diff[i] = x[i] - y[i];
    const s = (sec: number) => Math.round(sec * SR);
    // Before the transition (beyond the limiter look-ahead) the mixes are identical.
    expect(rms(diff, 0, s(t.start) - 1000)).toBe(0);
    // Echo repeats ring over B once A's dry signal is gone, and past A's end.
    expect(rms(diff, s(t.start + 0.93 * t.duration), s(t.end))).toBeGreaterThan(0.02);
    expect(rms(diff, s(t.end), s(t.end + 1))).toBeGreaterThan(0.004);
  });

  it('echo: seeking into the tail sounds like continuous playback', () => {
    const p = planWith(['echo', 'none', 'none']);
    const t = p.transitions[0];
    const at = Math.round((t.end + 0.4) * SR);
    const full = render(p, open).L;
    const sought = render(p, open, 16384, at).L;
    const n = SR;
    let e = 0, ref = 0;
    for (let i = 0; i < n; i++) { e += (sought[i] - full[at + i]) ** 2; ref += full[at + i] ** 2; }
    expect(10 * Math.log10(e / ref)).toBeLessThan(-40);
  });

  it('loop roll: the outgoing track repeats its beat inside the window', () => {
    const p = planWith(['none', 'loop', 'none']);
    const v = p.voices[1];
    // Listen to B alone.
    for (const o of p.voices) if (o !== v) o.fader = [{ t: 0, v: 0 }];
    const lp = v.loop!;
    const { L } = render(p, open);
    const beat = Math.round(lp.beat * SR), s0 = Math.round(lp.start * SR);
    // Repetition k of the first (one-beat) phase against the first one, skipping the micro-fades.
    const corr = (k: number) => {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 200; i < beat - 200; i++) {
        const x = L[s0 + i], y = L[s0 + k * beat + i];
        xy += x * y; xx += x * x; yy += y * y;
      }
      return xy / Math.sqrt(xx * yy);
    };
    expect(rms(L, s0, s0 + beat)).toBeGreaterThan(0.01);
    expect(corr(1)).toBeGreaterThan(0.99);
    expect(corr(2)).toBeGreaterThan(0.99);
  });

  it('a transposed track reports its new key to the transition analysis', () => {
    const { mixtape, map } = mixtapeOf([A, B]);
    const p0 = buildPlan({ mixtape, tracks: map });
    mixtape.entries[1].pitch = 2;
    const p1 = buildPlan({ mixtape, tracks: map });
    expect(p1.voices[1].pitch).toBe(2);
    expect(p1.duration).toBeCloseTo(p0.duration, 6); // tempo, so timing, unchanged
  });
});

describe('energy shape and target length', () => {
  // Synthetic analyses: same tempo and key everywhere, so only energy and length decide.
  const fake = (id: string, energy: number, duration = 240): EffectiveTrack => {
    const analysis = {
      version: 3, duration, sourceSampleRate: SR, sourceChannels: 2, codec: 'mp3', bitrate: 320,
      bpm: 124, bpmConfidence: 1, tempoStability: 1, firstBeat: 0, downbeatPhase: 0, downbeatConfidence: 1,
      key: makeKey(9, 'minor', 1), tuningCents: 0, lufs: -14, truePeakDb: -1, samplePeakDb: -1, loudnessRange: 5,
      silenceStart: 0, silenceEnd: duration, energy, onsetRate: 2, brightness: 2000, vocalness: 0.2,
      barEnergy: [], barVocal: [], barLow: [], sections: [], waveform: { points: 0, peak: [], low: [], mid: [], high: [] }, warnings: [],
    } as TrackAnalysis;
    return { id, title: id, artist: '', analysis, bpm: 124, bpmConfidence: 1, firstBeat: 0, downbeatPhase: 0, key: analysis.key, pcmPath: '' };
  };
  const energies = [5, 2, 9, 1, 7, 3, 10, 4, 8, 6, 2.5, 7.5];
  const tracks = new Map(energies.map((e, i) => [`t${i}`, fake(`t${i}`, e)]));
  const entries: PlaylistEntry[] = energies.map((_, i) => ({ id: `e${i}`, trackId: `t${i}`, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
  const pearson = (y: number[]) => {
    const n = y.length, mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    y.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; syy += (v - my) ** 2; });
    return sxy / Math.sqrt(sxx * syy);
  };

  it('follows the chosen energy shape', () => {
    for (const [arc, sign] of [['rise', 1], ['fall', -1]] as const) {
      const r = generateOrders({ entries, transitions: {}, tracks, settings: DEFAULT_SETTINGS, arc, strategies: ['energy', 'fluid'] });
      const shaped = r.find((x) => x.strategy === 'energy')!;
      expect(shaped.title).toContain(ARC_SHAPES[arc].label);
      expect(sign * pearson(shaped.energy)).toBeGreaterThan(0.85);
      // The other strategies follow it too, more loosely (an identical order is merged into the first one).
      expect(sign * pearson((r.find((x) => x.strategy === 'fluid') ?? shaped).energy)).toBeGreaterThan(0.5);
    }
    const peak = generateOrders({ entries, transitions: {}, tracks, settings: DEFAULT_SETTINGS, arc: 'peak', strategies: ['energy'] })[1];
    const top = peak.energy.indexOf(Math.max(...peak.energy)) / (peak.energy.length - 1);
    expect(top).toBeGreaterThan(0.45);
    expect(top).toBeLessThan(0.9);
  });

  it('selects the tracks that make a mix of the requested length, keeping locked ones', () => {
    const locked = entries.map((e, i) => (i === 3 ? { ...e, locked: true } : e));
    const target = 30 * 60;
    const r = generateOrders({ entries: locked, transitions: {}, tracks, settings: DEFAULT_SETTINGS, targetSeconds: target });
    expect(r[0].strategy).toBe('manual');
    expect(r[0].order.length).toBe(12); // the current order is shown untouched
    for (const o of r.slice(1)) {
      expect(o.order.length).toBeLessThan(12);
      expect(Math.abs(o.seconds - target)).toBeLessThan(4 * 60);
      expect(o.order[3]).toBe('e3'); // locked position respected
      expect(new Set(o.order).size).toBe(o.order.length);
    }
  });

  it('suggests effects in the energetic and surprising proposals', () => {
    const [a, b] = [tracks.get('t0')!, tracks.get('t1')!];
    const { proposals } = proposeTransitions(a, entries[0], b, entries[1], DEFAULT_SETTINGS);
    expect(['filter', 'loop']).toContain(proposals.find((p) => p.kind === 'energetic')!.spec.effect);
    expect(proposals.find((p) => p.kind === 'smooth')!.spec.effect ?? 'none').toBe('none');
  });
});
