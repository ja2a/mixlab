// End-to-end acceptance on the 22-track fixture set (+ beat-less, corrupted and truncated files):
// import (fingerprint + analysis) → automatic order → transitions → single-MP3 export.
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRoot, decodeMono } from './helpers';
import { analyzeTrack } from '../src/core/analysis/analyze';
import { fingerprint } from '../src/core/project/project';
import { effectiveTrack } from '../src/core/music/grid';
import { generateOrders } from '../src/core/music/optimize';
import { proposeTransitions } from '../src/core/music/suggest';
import { buildPlan, type MixPlan } from '../src/core/mix/plan';
import { exportMix } from '../src/core/export/exporter';
import { probe } from '../src/core/audio/ffmpeg';
import { DEFAULT_SETTINGS, type EffectiveTrack, type LibraryTrack, type PlaylistEntry, type TransitionSpec } from '../src/core/types';

const FIX = path.resolve('fixtures');
const work = tmpRoot();
const tracks = new Map<string, EffectiveTrack>();
const errors: Record<string, string> = {};
let entries: PlaylistEntry[] = [];

beforeAll(async () => {
  if (!fs.existsSync(path.join(FIX, '22 - Ember.mp3'))) execFileSync('npx', ['tsx', 'scripts/gen-fixtures.ts'], { stdio: 'inherit' });
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.mp3')).sort();
  const t0 = Date.now();
  await Promise.all(files.map(async (f, i) => {
    const p = path.join(FIX, f);
    const fp = fingerprint(p);
    try {
      const { analysis, meta } = await analyzeTrack(p, path.join(work, fp.fingerprint));
      const lib: LibraryTrack = { id: 't' + i, path: p, fileName: f, ...fp, meta, status: 'ready', overrides: {}, cacheDir: path.join(work, fp.fingerprint), addedAt: 0 };
      tracks.set(lib.id, effectiveTrack(lib, analysis));
    } catch (e: any) {
      errors[f] = e.message;
    }
  }));
  console.log(`analysed ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  entries = [...tracks.keys()].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).map((id, i) => ({ id: 'e' + i, trackId: id, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
});

describe('acceptance — 20+ MP3 files', () => {
  it('imports ≥ 20 MP3, computes durations and tries BPM on all of them', () => {
    expect(tracks.size).toBeGreaterThanOrEqual(23); // 22 songs + ambient + truncated
    for (const t of tracks.values()) expect(t.analysis.duration).toBeGreaterThan(10);
    const withBpm = [...tracks.values()].filter((t) => t.bpm !== null);
    expect(withBpm.length).toBeGreaterThanOrEqual(22);
  });

  it('handles the corrupted file and the beat-less track explicitly', () => {
    expect(Object.keys(errors)).toEqual(['98 - Corrupted.mp3']);
    expect(errors['98 - Corrupted.mp3'].length).toBeGreaterThan(5);
    const amb = [...tracks.values()].find((t) => t.title === 'Ambient Drift')!;
    expect(amb.bpm).toBeNull();
    expect(amb.analysis.warnings.join(' ')).toMatch(/BPM indisponible/);
  });

  let plan: MixPlan;
  it('generates alternative orders without overwriting the manual order', () => {
    const manual = entries.map((e) => e.id);
    const orders = generateOrders({ entries, transitions: {}, tracks, settings: DEFAULT_SETTINGS });
    expect(orders[0].order).toEqual(manual);
    expect(entries.map((e) => e.id)).toEqual(manual);
    const best = orders.find((o) => o.strategy === 'fluid')!;
    expect(best.order).not.toEqual(manual);
    expect(best.meanPair).toBeGreaterThan(orders[0].meanPair);
    // Use the generated order with the "smooth" proposal for each pair.
    const byId = new Map(entries.map((e) => [e.id, e]));
    const ordered = best.order.map((id) => byId.get(id)!);
    const specs: Record<string, TransitionSpec> = {};
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i], b = ordered[i + 1];
      specs[a.id] = { ...proposeTransitions(tracks.get(a.trackId)!, a, tracks.get(b.trackId)!, b, DEFAULT_SETTINGS).proposals[0].spec, toEntryId: b.id };
    }
    plan = buildPlan({ mixtape: { entries: ordered, transitions: specs, settings: DEFAULT_SETTINGS }, tracks });
    expect(plan.voices).toHaveLength(entries.length);
    expect(plan.transitions.filter((t) => t.synced).length).toBeGreaterThan(plan.transitions.length / 2);
  });

  it('exports the whole mix into a single MP3 with the expected duration, no gaps and no clipping', async () => {
    const out = path.join(work, 'acceptance.mp3');
    const t0 = Date.now();
    const rep = await exportMix(plan, { format: 'mp3', bitrate: 256, outPath: out, metadata: { title: 'Acceptance', artist: 'MixLab' }, chapters: true, cueSheet: false });
    const elapsed = (Date.now() - t0) / 1000;
    const played = plan.voices.reduce((s, v) => s + (v.end - v.start), 0);
    const overlaps = plan.transitions.reduce((s, t) => s + t.duration, 0);
    const pr = await probe(out);
    console.log(`mix ${(plan.duration / 60).toFixed(1)} min rendered in ${elapsed.toFixed(1)} s (×${(plan.duration / elapsed).toFixed(0)} realtime), ${rep.lufs?.toFixed(1)} LUFS, TP ${rep.truePeakDb.toFixed(2)} dBTP`);
    // Container estimate (older FFmpeg includes the encoder padding); the decoded length below is exact.
    expect(Math.abs(pr.duration - (played - overlaps))).toBeLessThan(0.1);
    expect(rep.longestSilence).toBeLessThan(0.1);
    expect(rep.truePeakDb).toBeLessThanOrEqual(DEFAULT_SETTINGS.ceilingDb + 0.05);
    // Shared CI runners are slower and run the suites in parallel; a regression still shows up there.
    expect(plan.duration / elapsed).toBeGreaterThan(process.env.CI ? 3 : 8);
    const d = await decodeMono(out);
    expect(Math.abs(d.length / 44100 - plan.duration)).toBeLessThan(0.03);
  });
});
