// Shared helpers: synthesise, encode and analyse royalty-free test tracks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesize, encodeFile, type SynthSpec } from '../src/core/testing/synth';
import { analyzeTrack } from '../src/core/analysis/analyze';
import { effectiveTrack } from '../src/core/music/grid';
import { DEFAULT_SETTINGS, type EffectiveTrack, type LibraryTrack, type Mixtape, type PlaylistEntry, type TrackAnalysis } from '../src/core/types';

export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mixlab-test-'));

export interface Built {
  file: string;
  lib: LibraryTrack;
  analysis: TrackAnalysis;
  eff: EffectiveTrack;
  spec: SynthSpec;
}

export async function buildTrack(dir: string, name: string, spec: SynthSpec): Promise<Built> {
  const s = synthesize(spec);
  const file = path.join(dir, `${name}.mp3`);
  await encodeFile(s.left, s.right, s.sampleRate, file, { title: name, artist: 'Test' });
  const cacheDir = path.join(dir, 'cache-' + name);
  const { analysis, meta } = await analyzeTrack(file, cacheDir);
  const lib: LibraryTrack = {
    id: name, path: file, fileName: path.basename(file), size: fs.statSync(file).size, fingerprint: name, meta,
    status: 'ready', overrides: {}, cacheDir, addedAt: Date.now(),
  };
  return { file, lib, analysis, eff: effectiveTrack(lib, analysis), spec };
}

export function mixtapeOf(tracks: Built[], transitions: Mixtape['transitions'] = {}): { mixtape: Mixtape; map: Map<string, EffectiveTrack> } {
  const entries: PlaylistEntry[] = tracks.map((t, i) => ({ id: 'e' + i, trackId: t.lib.id, locked: false, cueIn: null, cueOut: null, gainDb: 0 }));
  return {
    mixtape: { id: 'm', name: 'Test', entries, transitions, manualOrder: null, settings: { ...DEFAULT_SETTINGS }, createdAt: 0 },
    map: new Map(tracks.map((t) => [t.lib.id, t.eff])),
  };
}

/** Decode any audio file to float32 at `sr` with FFmpeg: mono = (L + R) / 2, or interleaved stereo. */
export async function decodeMono(file: string, sr = 44100, stereo = false): Promise<Float32Array> {
  const { spawn } = await import('node:child_process');
  const { findFfmpeg } = await import('../src/core/audio/ffmpeg');
  return new Promise((resolve, reject) => {
    const mix = stereo ? ['-ac', '2'] : ['-af', 'pan=mono|c0=0.5*c0+0.5*c1'];
    const p = spawn(findFfmpeg().ffmpeg, ['-v', 'error', '-i', file, ...mix, '-ar', String(sr), '-f', 'f32le', 'pipe:1']);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice());
    });
  });
}
