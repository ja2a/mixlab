import { describe, expect, it, beforeAll } from 'vitest';
import { buildTrack, tmpRoot, type Built } from './helpers';
import { harmonicMatch, camelotCode } from '../src/core/music/camelot';
import { pairScore } from '../src/core/music/compat';
import { proposeTransitions } from '../src/core/music/suggest';
import { generateOrders, evaluateOrder, buildUnits, layout } from '../src/core/music/optimize';
import { PairCache } from '../src/core/music/compat';
import { DEFAULT_SETTINGS, type PlaylistEntry, type TransitionSpec, defaultTransition } from '../src/core/types';

describe('Camelot wheel', () => {
  it('maps keys to the conventional codes', () => {
    expect(camelotCode(9, 'minor')).toBe('8A'); // A minor
    expect(camelotCode(0, 'major')).toBe('8B'); // C major
    expect(camelotCode(7, 'major')).toBe('9B'); // G major
    expect(camelotCode(4, 'minor')).toBe('9A'); // E minor
    expect(camelotCode(5, 'major')).toBe('7B'); // F major
    expect(camelotCode(11, 'major')).toBe('1B'); // B major
  });

  it('classifies relations', () => {
    expect(harmonicMatch('8A', '8A').relation).toBe('same');
    expect(harmonicMatch('8A', '9A').relation).toBe('adjacent');
    expect(harmonicMatch('12A', '1A').relation).toBe('adjacent');
    expect(harmonicMatch('8A', '8B').relation).toBe('relative');
    expect(harmonicMatch('8A', '10A').relation).toBe('boost');
    expect(harmonicMatch('3B', '9B').relation).toBe('distant');
    expect(harmonicMatch('8A', '9A').score).toBeGreaterThan(harmonicMatch('8A', '2B').score);
  });
});

describe('compatibility, proposals and ordering on real analyses', () => {
  const dir = tmpRoot();
  const specs = [
    { bpm: 124, tonic: 9, mode: 'minor' as const }, // 8A
    { bpm: 125, tonic: 4, mode: 'minor' as const }, // 9A
    { bpm: 126, tonic: 0, mode: 'major' as const }, // 8B
    { bpm: 123, tonic: 6, mode: 'major' as const }, // 2B (far from 8A)
    { bpm: 128, tonic: 11, mode: 'minor' as const }, // 10A
    { bpm: 70, tonic: 9, mode: 'minor' as const }, // half-time
    { bpm: 100, tonic: 1, mode: 'major' as const }, // not syncable with the others
  ];
  const built: Built[] = [];
  const tracks = new Map();
  beforeAll(async () => {
    for (const [i, s] of specs.entries()) {
      const b = await buildTrack(dir, `k${i}`, { ...s, bars: 32, seed: 60 + i });
      built.push(b);
      tracks.set(b.lib.id, b.eff);
    }
  });

  it('scores compatible pairs higher (tempo and harmony matter, not only BPM)', () => {
    const near = pairScore(built[0].eff, built[1].eff, DEFAULT_SETTINGS); // 124→125, 8A→9A
    const far = pairScore(built[0].eff, built[3].eff, DEFAULT_SETTINGS); // 124→123, 8A→2B
    const slow = pairScore(built[0].eff, built[6].eff, DEFAULT_SETTINGS); // 124→100
    expect(near.total).toBeGreaterThan(far.total);
    expect(far.tempo.score).toBeGreaterThan(0.8); // tempo is fine…
    expect(far.harmonic.score).toBeLessThan(near.harmonic.score); // …harmony is what differs
    expect(slow.tempo.syncable).toBe(false);
    expect(near.reasons.length).toBeGreaterThan(1);
  });

  it('recognises half/double time', () => {
    // built[5] was synthesised at 70 BPM; the analyser reports the DJ convention (140).
    expect(Math.abs(built[5].eff.bpm! - 140)).toBeLessThan(0.5);
    const half = { ...built[0].eff, bpm: built[5].eff.bpm! / 2, bpmConfidence: 0.95 };
    const p = pairScore(built[5].eff, half, DEFAULT_SETTINGS);
    expect(p.tempo.factor).toBe(2);
    expect(p.tempo.syncable).toBe(true);
    expect(p.tempo.stretchPct).toBeLessThan(0.5);
    expect(p.tempo.label).toMatch(/demi/);
  });

  it('proposes four distinct, explained transitions computed from the analysis', () => {
    const e = (id: string): PlaylistEntry => ({ id, trackId: id, locked: false, cueIn: null, cueOut: null, gainDb: 0 });
    const { proposals } = proposeTransitions(built[0].eff, e(built[0].lib.id), built[1].eff, e(built[1].lib.id), DEFAULT_SETTINGS);
    expect(proposals.map((p) => p.kind)).toEqual(['smooth', 'energetic', 'harmonic', 'surprise']);
    for (const p of proposals) {
      expect(p.reasons.length).toBeGreaterThan(0);
      expect(p.score).toBeGreaterThan(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
    const sigs = new Set(proposals.map((p) => `${p.spec.type}|${p.spec.bars}|${p.spec.inStart}|${p.spec.swapPoint}|${p.spec.fadeIn}`));
    expect(sigs.size).toBeGreaterThanOrEqual(3);
    // an unsyncable pair gets no fake beatmatch
    const slow = proposeTransitions(built[0].eff, e(built[0].lib.id), built[6].eff, e(built[6].lib.id), DEFAULT_SETTINGS);
    for (const p of slow.proposals) expect(['crossfade', 'curve']).toContain(p.spec.type);
  });

  it('generates several orders, keeps the manual order intact and beats a plain BPM sort', () => {
    const entries: PlaylistEntry[] = built.map((b, i) => ({ id: 'e' + i, trackId: b.lib.id, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
    const before = entries.map((e) => e.id).join(',');
    const res = generateOrders({ entries, transitions: {}, tracks, settings: DEFAULT_SETTINGS });
    expect(res[0].strategy).toBe('manual');
    expect(res[0].order.join(',')).toBe(before);
    expect(entries.map((e) => e.id).join(',')).toBe(before); // input not mutated
    expect(res.length).toBeGreaterThanOrEqual(3);
    for (const r of res) expect(new Set(r.order).size).toBe(entries.length);

    const byId = new Map(entries.map((e) => [e.id, e]));
    const cache = new PairCache(tracks, DEFAULT_SETTINGS);
    const bpmSorted = [...entries].sort((a, b) => (tracks.get(a.trackId)!.bpm ?? 0) - (tracks.get(b.trackId)!.bpm ?? 0)).map((e) => e.id);
    const fluid = res.find((r) => r.strategy === 'fluid')!;
    expect(fluid.meanPair).toBeGreaterThanOrEqual(evaluateOrder(bpmSorted, 'fluid', byId, cache, tracks).meanPair);
    const harmonic = res.find((r) => r.strategy === 'harmonic') ?? fluid;
    expect(harmonic.harmonicOk).toBeGreaterThanOrEqual(evaluateOrder(bpmSorted, 'harmonic', byId, cache, tracks).harm);
  });

  it('respects locked tracks and locked transitions', () => {
    const entries: PlaylistEntry[] = built.map((b, i) => ({ id: 'e' + i, trackId: b.lib.id, locked: i === 2, cueIn: null, cueOut: null, gainDb: 0 }));
    const transitions: Record<string, TransitionSpec> = { e4: { ...defaultTransition(), locked: true } }; // e4 → e5 glued
    const res = generateOrders({ entries, transitions, tracks, settings: DEFAULT_SETTINGS, iterations: 3000 });
    for (const r of res) {
      expect(r.order[2]).toBe('e2');
      const i = r.order.indexOf('e4');
      expect(r.order[i + 1]).toBe('e5');
    }
  });

  it('lays out units around pinned positions', () => {
    const entries: PlaylistEntry[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, trackId: id, locked: i === 4, cueIn: null, cueOut: null, gainDb: 0 }));
    const units = buildUnits(entries, { a: { ...defaultTransition(), locked: true } });
    expect(units[0].ids).toEqual(['a', 'b']);
    const pinned = units.filter((u) => u.pinned !== null);
    const free = units.filter((u) => u.pinned === null).reverse();
    const out = layout(free, pinned, 5)!;
    expect(out[4]).toBe('e');
    expect(out.indexOf('b')).toBe(out.indexOf('a') + 1);
  });
});
