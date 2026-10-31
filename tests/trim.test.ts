// Automatic shortening of long quiet intros and outros where a transition happens.
import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/core/mix/plan';
import { autoTrim, entryCues } from '../src/core/music/grid';
import { makeKey } from '../src/core/music/camelot';
import { estimateSeconds } from '../src/core/music/optimize';
import { DEFAULT_SETTINGS, type EffectiveTrack, type Mixtape, type Section, type SectionLabel, type TrackAnalysis } from '../src/core/types';

// 120 BPM: one bar = 2 s.
const BAR = 2;

function fake(id: string, layout: Array<[SectionLabel, number]>, opts: { reliable?: boolean } = {}): EffectiveTrack {
  const sections: Section[] = [];
  let bar = 0;
  for (const [label, bars] of layout) {
    sections.push({ startBar: bar, endBar: bar + bars, start: bar * BAR, end: (bar + bars) * BAR, label, energy: 0.5, vocal: 0 });
    bar += bars;
  }
  const duration = bar * BAR;
  const analysis = {
    version: 3, duration, sourceSampleRate: 44100, sourceChannels: 2, codec: 'mp3', bitrate: 320,
    bpm: 120, bpmConfidence: 1, tempoStability: opts.reliable === false ? 0.1 : 1, firstBeat: 0, downbeatPhase: 0, downbeatConfidence: 1,
    key: makeKey(9, 'minor', 1), tuningCents: 0, lufs: -14, truePeakDb: -1, samplePeakDb: -1, loudnessRange: 5,
    silenceStart: 0, silenceEnd: duration, energy: 5, onsetRate: 2, brightness: 2000, vocalness: 0.2,
    barEnergy: [], barVocal: [], barLow: [], sections, waveform: { points: 0, peak: [], low: [], mid: [], high: [] }, warnings: [],
  } as TrackAnalysis;
  return { id, title: id, artist: '', analysis, bpm: 120, bpmConfidence: opts.reliable === false ? 0.1 : 1, firstBeat: 0, downbeatPhase: 0, key: analysis.key, pcmPath: '' };
}

// 32-bar intro, 64 bars of music, 64-bar outro (5 min 20 s).
const LONG: Array<[SectionLabel, number]> = [['intro', 32], ['verse', 32], ['chorus', 32], ['outro', 64]];

function mixOf(tracks: EffectiveTrack[], trimBars = DEFAULT_SETTINGS.trimBars): Mixtape {
  return {
    id: 'm', name: 'Test', createdAt: 0, manualOrder: null, transitions: {},
    entries: tracks.map((t, i) => ({ id: 'e' + i, trackId: t.id, locked: false, cueIn: null, cueOut: null, gainDb: 0 })),
    settings: { ...DEFAULT_SETTINGS, trimBars },
  };
}

describe('automatic intro / outro trim', () => {
  it('keeps the chosen number of bars before the music and after it, on downbeats', () => {
    const t = fake('a', LONG);
    expect(autoTrim(t, 16)).toEqual({ cueIn: 64 - 16 * BAR, cueOut: 192 + 16 * BAR });
    expect(autoTrim(t, 8)).toEqual({ cueIn: 64 - 8 * BAR, cueOut: 192 + 8 * BAR });
    // Breaks around the intro / outro count as part of them.
    const withBreaks = fake('b', [['intro', 16], ['break', 16], ['drop', 32], ['break', 16], ['outro', 32]]);
    expect(autoTrim(withBreaks, 16)).toEqual({ cueIn: 64 - 16 * BAR, cueOut: 128 + 16 * BAR });
  });

  it('leaves short intros and outros, unreliable grids and the "off" setting alone', () => {
    // 20-bar intro with 16 kept: only 4 bars to gain, not worth a cut.
    expect(autoTrim(fake('a', [['intro', 20], ['verse', 64], ['outro', 16]]), 16)).toEqual({ cueIn: null, cueOut: null });
    expect(autoTrim(fake('b', LONG, { reliable: false }), 16)).toEqual({ cueIn: null, cueOut: null });
    expect(autoTrim(fake('c', LONG), 0)).toEqual({ cueIn: null, cueOut: null });
    // Nothing but quiet sections: no music to anchor on.
    expect(autoTrim(fake('d', [['intro', 32], ['break', 32], ['outro', 32]]), 16)).toEqual({ cueIn: null, cueOut: null });
  });

  it('never overrides manual cue points, and spares the first intro and the last outro', () => {
    const t = fake('a', LONG);
    expect(entryCues(t, { cueIn: 5, cueOut: null }, 16)).toMatchObject({ cueIn: 5, cueOut: 224, autoIn: false, autoOut: true });
    expect(entryCues(t, { cueIn: null, cueOut: null }, 16, { first: true, last: false })).toMatchObject({ cueIn: null, autoIn: false, autoOut: true });
    expect(entryCues(t, { cueIn: null, cueOut: null }, 16, { first: false, last: true })).toMatchObject({ cueOut: null, autoIn: true, autoOut: false });
  });

  it('shortens the mix only where transitions happen', () => {
    const tracks = ['a', 'b', 'c'].map((id) => fake(id, LONG));
    const map = new Map(tracks.map((t) => [t.id, t]));
    const trimmed = buildPlan({ mixtape: mixOf(tracks), tracks: map });
    const full = buildPlan({ mixtape: mixOf(tracks, 0), tracks: map });
    const [first, mid, last] = trimmed.voices;
    expect(first.srcStart).toBe(0);
    expect(first.trimmed).toEqual({ in: 0, out: 96 });
    expect(mid.srcStart).toBeCloseTo(32, 6);
    expect(mid.trimmed).toEqual({ in: 32, out: 96 });
    expect(last.trimmed).toEqual({ in: 32, out: 0 });
    expect(last.srcEnd).toBeCloseTo(320, 6);
    expect(full.voices.every((v) => v.trimmed.in === 0 && v.trimmed.out === 0)).toBe(true);
    // 96 + (32 + 96) + 32 s removed; the transitions themselves are unchanged.
    expect(full.duration - trimmed.duration).toBeCloseTo(256, 1);
    expect(trimmed.transitions.map((t) => t.duration)).toEqual(full.transitions.map((t) => t.duration));
    expect(trimmed.transitions.every((t) => t.synced)).toBe(true);
  });

  it('"keep it whole" (cue points on the silence bounds) restores the full track', () => {
    const tracks = ['a', 'b', 'c'].map((id) => fake(id, LONG));
    const map = new Map(tracks.map((t) => [t.id, t]));
    const m = mixOf(tracks);
    m.entries[1].cueIn = 0;
    m.entries[1].cueOut = 320;
    const mid = buildPlan({ mixtape: m, tracks: map }).voices[1];
    expect(mid.srcStart).toBe(0);
    expect(mid.trimmed).toEqual({ in: 0, out: 0 });
  });

  it('counts the trim in the length estimate used for target durations', () => {
    const tracks = ['a', 'b', 'c'].map((id) => fake(id, LONG));
    const map = new Map(tracks.map((t) => [t.id, t]));
    const ids = tracks.map((t) => t.id);
    const full = estimateSeconds(ids, map, null, { ...DEFAULT_SETTINGS, trimBars: 0 });
    const trimmed = estimateSeconds(ids, map, null, DEFAULT_SETTINGS);
    expect(full - trimmed).toBeCloseTo(256, 6);
  });
});
