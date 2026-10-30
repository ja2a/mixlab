import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { buildTrack, decodeMono, mixtapeOf, tmpRoot, type Built } from './helpers';
import { buildPlan, type MixPlan } from '../src/core/mix/plan';
import { exportMix, ExportCancelled } from '../src/core/export/exporter';
import { findFfmpeg, probe } from '../src/core/audio/ffmpeg';

const dir = tmpRoot();
let plan: MixPlan;
let tracks: Built[];

beforeAll(async () => {
  tracks = [
    await buildTrack(dir, 'x1', { bpm: 124, tonic: 9, mode: 'minor', bars: 32, seed: 71 }),
    await buildTrack(dir, 'x2', { bpm: 125, tonic: 4, mode: 'minor', bars: 40, seed: 72, lead: 0.8 }),
    await buildTrack(dir, 'x3', { bpm: 127, tonic: 0, mode: 'major', bars: 32, seed: 73, level: 0.95 }),
    await buildTrack(dir, 'x4', { bpm: 110, tonic: 7, mode: 'major', bars: 24, seed: 74, level: 0.2 }),
  ];
  const { mixtape, map } = mixtapeOf(tracks);
  plan = buildPlan({ mixtape, tracks: map });
});

function ffprobeJson(file: string, extra: string[] = []) {
  const r = spawnSync(findFfmpeg().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

describe('MP3 export', () => {
  let out: string;
  let report: Awaited<ReturnType<typeof exportMix>>;
  beforeAll(async () => {
    out = path.join(dir, 'mix.mp3');
    report = await exportMix(plan, { format: 'mp3', bitrate: 320, outPath: out, metadata: { title: 'Ma mixtape', artist: 'MixLab', album: 'Tests' }, chapters: true, cueSheet: true });
  });

  it('produces one MP3 whose duration matches the plan (sum − overlaps)', async () => {
    const played = plan.voices.reduce((s, v) => s + (v.end - v.start), 0);
    const overlaps = plan.transitions.reduce((s, t) => s + t.duration, 0);
    const pr = await probe(out);
    expect(pr.codec).toBe('mp3');
    // Container estimate: older FFmpeg (6.x) includes the encoder padding here; the decoded length below is exact.
    expect(Math.abs(pr.duration - (played - overlaps))).toBeLessThan(0.1);
    const decoded = await decodeMono(out);
    expect(Math.abs(decoded.length / 44100 - plan.duration)).toBeLessThan(0.03); // gapless header honoured
  });

  it('uses the requested bitrate and writes metadata and chapters', () => {
    const j = ffprobeJson(out, ['-show_chapters']);
    expect(Math.round(parseInt(j.streams[0].bit_rate, 10) / 1000)).toBe(320);
    expect(j.format.tags.title).toBe('Ma mixtape');
    expect(j.format.tags.artist).toBe('MixLab');
    expect(j.chapters).toHaveLength(plan.voices.length);
    expect(fs.existsSync(out.replace(/\.mp3$/, '.cue'))).toBe(true);
  });

  it('is continuous (no silence between tracks) and does not clip', async () => {
    expect(report.longestSilence).toBeLessThan(0.1);
    expect(report.truePeakDb).toBeLessThanOrEqual(plan.settings.ceilingDb + 0.05);
    // also on the decoded MP3 (codec overshoot stays below 0 dBFS)
    const st = await decodeMono(out, 44100, true);
    let peak = 0;
    for (const x of st) peak = Math.max(peak, Math.abs(x));
    expect(20 * Math.log10(peak)).toBeLessThan(0);
    const d = await decodeMono(out);
    const win = 2205;
    let worst = 0;
    for (let i = 44100; i + win < d.length - 44100; i += win) {
      let s = 0;
      for (let k = i; k < i + win; k++) s += d[k] * d[k];
      worst = Math.min(worst, 10 * Math.log10(s / win + 1e-20));
    }
    expect(worst).toBeGreaterThan(-60);
  });

  it('keeps loudness consistent across tracks (normalisation)', () => {
    expect(report.lufs!).toBeGreaterThan(plan.settings.targetLufs - 1.5);
    expect(report.lufs!).toBeLessThan(plan.settings.targetLufs + 1.5);
    const gains = plan.voices.map((v) => v.normDb);
    expect(Math.max(...gains) - Math.min(...gains)).toBeGreaterThan(3); // quiet and loud sources were evened out
  });
});

describe('WAV export, cancellation and errors', () => {
  it('writes a valid 24-bit WAV with the exact frame count', async () => {
    const out = path.join(dir, 'mix.wav');
    await exportMix(plan, { format: 'wav', bitrate: 320, outPath: out, metadata: { title: 'x', artist: 'y' }, chapters: false, cueSheet: false });
    const j = ffprobeJson(out);
    expect(j.streams[0].codec_name).toBe('pcm_s24le');
    expect(parseInt(j.streams[0].duration_ts, 10)).toBe(plan.totalFrames);
  });

  it('cancels cleanly without leaving partial files', async () => {
    const out = path.join(dir, 'cancelled.mp3');
    const ac = new AbortController();
    const p = exportMix(plan, { format: 'mp3', bitrate: 192, outPath: out, metadata: { title: 'x', artist: 'y' }, chapters: true, cueSheet: false }, (pr) => {
      if (pr.frames > 44100 * 4) ac.abort();
    }, ac.signal);
    await expect(p).rejects.toBeInstanceOf(ExportCancelled);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('cancelled'))).toEqual([]);
  });

  it('reports errors without touching anything else', async () => {
    const broken: MixPlan = { ...plan, voices: plan.voices.map((v, i) => (i === 1 ? { ...v, pcmPath: path.join(dir, 'missing.f32') } : v)) };
    const out = path.join(dir, 'err.mp3');
    await expect(exportMix(broken, { format: 'mp3', bitrate: 192, outPath: out, metadata: { title: 'x', artist: 'y' }, chapters: false, cueSheet: false })).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('export runs off the main thread', () => {
  it('keeps the main event loop responsive while a worker renders', async () => {
    const outdir = path.join(dir, 'bundle');
    await build({ entryPoints: { workers: path.resolve('src/main/workers.ts') }, bundle: true, platform: 'node', format: 'cjs', outdir, external: ['electron'], logLevel: 'silent' });
    const out = path.join(dir, 'worker.mp3');
    const w = new Worker(path.join(outdir, 'workers.js'), { workerData: { role: 'export', plan, opts: { format: 'mp3', bitrate: 320, outPath: out, metadata: { title: 'w', artist: 'w' }, chapters: false, cueSheet: false } } });
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const progress: number[] = [];
    const result = await new Promise<any>((resolve, reject) => {
      w.on('message', (m) => { if (m.type === 'progress') progress.push(m.frames); else resolve(m); });
      w.on('error', reject);
    });
    clearInterval(timer);
    await w.terminate();
    expect(result.type).toBe('done');
    expect(progress.length).toBeGreaterThan(3);
    expect(maxLag).toBeLessThan(80);
    expect(fs.existsSync(out)).toBe(true);
  });
});
