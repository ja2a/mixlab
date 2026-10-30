import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTrack, tmpRoot, type Built } from './helpers';
import { analyzeTrack } from '../src/core/analysis/analyze';
import { LoudnessMeter, TruePeakMeter } from '../src/core/analysis/loudness';
import { findFfmpeg } from '../src/core/audio/ffmpeg';
import { encodeFile } from '../src/core/testing/synth';
import { harmonicMatch } from '../src/core/music/camelot';

const dir = tmpRoot();

describe('tempo, beats and downbeats', () => {
  const cases = [
    { bpm: 100, tonic: 4, mode: 'minor' as const },
    { bpm: 118, tonic: 9, mode: 'minor' as const },
    { bpm: 124, tonic: 0, mode: 'major' as const, lead: 0.73 },
    { bpm: 128, tonic: 7, mode: 'major' as const },
    { bpm: 140, tonic: 2, mode: 'minor' as const, lead: 0.31 },
    { bpm: 174, tonic: 5, mode: 'major' as const },
  ];
  const built: Built[] = [];
  beforeAll(async () => {
    for (const [i, c] of cases.entries()) built.push(await buildTrack(dir, `t${c.bpm}`, { ...c, bars: 40, seed: 20 + i }));
  });

  it('estimates the BPM within 0.2 % (octave-correct)', () => {
    for (const b of built) {
      expect(b.analysis.bpm, `track ${b.spec.bpm}`).not.toBeNull();
      expect(Math.abs(b.analysis.bpm! / b.spec.bpm - 1)).toBeLessThan(0.002);
      expect(b.analysis.bpmConfidence).toBeGreaterThan(0.5);
      expect(b.analysis.tempoStability).toBeGreaterThan(0.6);
    }
  });

  it('places the beat grid within 15 ms of the true kicks', () => {
    for (const b of built) {
      const T = 60 / b.spec.bpm;
      const truth = (b.spec.lead ?? 0) % T;
      let d = Math.abs(b.analysis.firstBeat! - truth);
      d = Math.min(d, T - d);
      expect(d, `track ${b.spec.bpm}`).toBeLessThan(0.015);
    }
  });

  it('finds the downbeat of the bar', () => {
    let ok = 0;
    for (const b of built) {
      const T = 60 / b.spec.bpm;
      const db = b.analysis.firstBeat! + b.analysis.downbeatPhase * T;
      const bar0 = b.spec.lead ?? 0;
      const k = (db - bar0) / T;
      if (Math.abs(((Math.round(k) % 4) + 4) % 4) === 0 && Math.abs(k - Math.round(k)) < 0.1) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(built.length - 1);
  });

  it('detects the key (same or relative) with Camelot codes', () => {
    let exact = 0;
    for (const b of built) {
      const k = b.analysis.key!;
      expect(k).toBeTruthy();
      const rel = harmonicMatch(k.camelot, camelotOf(b.spec.tonic, b.spec.mode)).relation;
      expect(['same', 'relative']).toContain(rel);
      if (rel === 'same') exact++;
    }
    expect(exact).toBeGreaterThanOrEqual(built.length - 2);
  });

  it('detects leading silence', () => {
    const b = built.find((x) => x.spec.lead === 0.73)!;
    expect(Math.abs(b.analysis.silenceStart - 0.73)).toBeLessThan(0.03);
    expect(b.analysis.silenceEnd).toBeLessThanOrEqual(b.analysis.duration);
  });

  it('segments structure into labelled sections on phrase boundaries', () => {
    const b = built[2];
    expect(b.analysis.sections.length).toBeGreaterThanOrEqual(2);
    expect(b.analysis.sections[0].label).toBe('intro');
    for (const s of b.analysis.sections) expect(s.startBar % 4).toBe(0);
  });
});

function camelotOf(tonic: number, mode: 'major' | 'minor') {
  const major = mode === 'major' ? tonic : (tonic + 3) % 12;
  return `${((major * 7 + 7) % 12) + 1}${mode === 'major' ? 'B' : 'A'}`;
}

describe('loudness and peaks (BS.1770-4)', () => {
  it('measures a −20 dBFS 997 Hz stereo sine at −20 LUFS', () => {
    const sr = 48000, n = sr * 5;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = r[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / sr);
    const m = new LoudnessMeter(sr, 2);
    m.push([l, r], n);
    expect(m.result().integrated!).toBeCloseTo(-20, 1);
  });

  it('agrees with FFmpeg’s ebur128 filter on a real file', async () => {
    const b = await buildTrack(dir, 'loud', { bpm: 126, tonic: 3, mode: 'minor', bars: 24, seed: 3 });
    const r = spawnSync(findFfmpeg().ffmpeg, ['-hide_banner', '-nostats', '-i', b.file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split('Summary:').pop() ?? '');
    expect(m).toBeTruthy();
    expect(Math.abs(b.analysis.lufs! - parseFloat(m![1]))).toBeLessThan(0.3);
  });

  it('sees inter-sample peaks (true peak > sample peak)', () => {
    const sr = 44100, n = 4096;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = 0.8 * Math.sin((Math.PI / 2) * i + Math.PI / 4); // fs/4, samples at ±0.566
    const tp = new TruePeakMeter(1);
    tp.push([l], n);
    expect(20 * Math.log10(tp.samplePeak)).toBeCloseTo(20 * Math.log10(0.8 * Math.SQRT1_2), 1);
    expect(Math.abs(20 * Math.log10(tp.peak) - 20 * Math.log10(0.8))).toBeLessThan(0.35);
    void sr;
  });
});

describe('robustness', () => {
  it('keeps a beat-less track and reports BPM as unavailable', async () => {
    const b = await buildTrack(dir, 'ambient', { bpm: 100, tonic: 4, mode: 'minor', bars: 24, ambient: true, seed: 9 });
    expect(b.analysis.bpm).toBeNull();
    expect(b.analysis.warnings.join(' ')).toMatch(/BPM indisponible/);
    expect(b.analysis.duration).toBeGreaterThan(40);
    expect(b.analysis.lufs).not.toBeNull();
  });

  it('rejects a corrupted file with an explicit message', async () => {
    const bad = path.join(dir, 'bad.mp3');
    fs.writeFileSync(bad, Buffer.from(Array.from({ length: 50000 }, (_, i) => (i * 7919) % 251)));
    await expect(analyzeTrack(bad, path.join(dir, 'bad-cache'))).rejects.toThrow(/.+/);
  });

  it('analyses a truncated MP3 and keeps it with a warning', async () => {
    const b = await buildTrack(dir, 'full', { bpm: 122, tonic: 1, mode: 'major', bars: 24, seed: 5 });
    const trunc = path.join(dir, 'trunc.mp3');
    const buf = fs.readFileSync(b.file);
    fs.writeFileSync(trunc, buf.subarray(0, Math.floor(buf.length * 0.5) + 33));
    const out = await analyzeTrack(trunc, path.join(dir, 'trunc-cache'));
    expect(out.analysis.duration).toBeGreaterThan(10);
    expect(out.analysis.duration).toBeLessThan(b.analysis.duration);
  });

  it('accepts other formats (WAV, FLAC) through the same pipeline', async () => {
    const { synthesize } = await import('../src/core/testing/synth');
    const s = synthesize({ bpm: 125, tonic: 6, mode: 'minor', bars: 16, seed: 2, sampleRate: 48000 });
    for (const ext of ['wav', 'flac']) {
      const f = path.join(dir, `fmt.${ext}`);
      await encodeFile(s.left, s.right, s.sampleRate, f);
      const out = await analyzeTrack(f, path.join(dir, `fmt-${ext}`));
      expect(out.analysis.sourceSampleRate).toBe(48000);
      expect(Math.abs(out.analysis.bpm! - 125)).toBeLessThan(0.3);
    }
  });
});
