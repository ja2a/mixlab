// FFmpeg integration: binary discovery, probing, decoding, artwork extraction.
// Decoding writes a float32 stereo 44.1 kHz cache file and streams a mono 11.025 kHz copy for analysis.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE } from '../types';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  soxr: boolean;
}

let cached: FfmpegPaths | null = null;

function works(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Look for FFmpeg: explicit env var, binaries bundled with the packaged app, Homebrew / common
 * install locations, then PATH.
 */
export function findFfmpeg(extraDirs: string[] = []): FfmpegPaths {
  if (cached) return cached;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dirs = [
    process.env.MIXLAB_FFMPEG_DIR,
    ...extraDirs,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    'C:\\ffmpeg\\bin',
  ].filter(Boolean) as string[];
  let ffmpeg: string | null = null;
  let ffprobe: string | null = null;
  for (const d of dirs) {
    const a = path.join(d, 'ffmpeg' + exe);
    const b = path.join(d, 'ffprobe' + exe);
    if (!ffmpeg && fs.existsSync(a) && works(a)) ffmpeg = a;
    if (!ffprobe && fs.existsSync(b) && works(b)) ffprobe = b;
  }
  if (!ffmpeg && works('ffmpeg')) ffmpeg = 'ffmpeg';
  if (!ffprobe && works('ffprobe')) ffprobe = 'ffprobe';
  if (!ffmpeg || !ffprobe) {
    throw new Error(
      'FFmpeg introuvable. Installez-le (macOS : « brew install ffmpeg », Windows : winget install ffmpeg) ou définissez MIXLAB_FFMPEG_DIR.',
    );
  }
  const probe = spawnSync(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000', '-af', 'aresample=44100:resampler=soxr', '-t', '0.05', '-f', 'null', '-'],
    { stdio: 'ignore', timeout: 5000 },
  );
  cached = { ffmpeg, ffprobe, soxr: probe.status === 0 };
  return cached;
}

/** High quality resampler arguments (SoX resampler when available, otherwise long-filter swresample). */
export function resampleFilter(rate: number): string {
  const { soxr } = findFfmpeg();
  return soxr
    ? `aresample=${rate}:resampler=soxr:precision=28`
    : `aresample=${rate}:filter_size=64:phase_shift=12:cutoff=0.97:linear_interp=1`;
}

export interface ProbeResult {
  duration: number;
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate: number | null;
  hasArtwork: boolean;
  tags: Record<string, string>;
}

export function probe(file: string): Promise<ProbeResult> {
  const { ffprobe } = findFfmpeg();
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(cleanError(err) || 'Fichier illisible'));
      try {
        const j = JSON.parse(out);
        const streams: any[] = j.streams ?? [];
        const audio = streams.find((s) => s.codec_type === 'audio');
        if (!audio) return reject(new Error('Aucune piste audio dans ce fichier'));
        const art = streams.some((s) => s.codec_type === 'video' && (s.disposition?.attached_pic === 1 || /mjpeg|png/.test(s.codec_name)));
        const tags: Record<string, string> = {};
        for (const src of [j.format?.tags ?? {}, audio.tags ?? {}]) {
          for (const [k, v] of Object.entries(src)) tags[k.toLowerCase()] = String(v);
        }
        resolve({
          duration: parseFloat(j.format?.duration ?? audio.duration ?? '0') || 0,
          sampleRate: parseInt(audio.sample_rate, 10) || 0,
          channels: audio.channels || 0,
          codec: audio.codec_name ?? 'inconnu',
          bitrate: parseInt(j.format?.bit_rate ?? audio.bit_rate, 10) || null,
          hasArtwork: art,
          tags,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function cleanError(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(' — ').slice(0, 300);
}

export interface DecodeResult {
  frames: number; // stereo frames written to the cache file
  analysis: Float32Array; // mono, ANALYSIS_SAMPLE_RATE
  warnings: string[];
}

/**
 * Decode `file` to `pcmPath` (float32 interleaved stereo, 44.1 kHz) and return a mono analysis copy.
 * The cache is written to a temporary name and renamed on success.
 */
export function decode(
  file: string,
  pcmPath: string,
  onProgress?: (seconds: number) => void,
  signal?: AbortSignal,
): Promise<DecodeResult> {
  const { ffmpeg } = findFfmpeg();
  const tmp = pcmPath + '.part';
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:2', '-nostats',
      '-i', file,
      '-map', '0:a:0', '-vn', '-af', resampleFilter(INTERNAL_SAMPLE_RATE), '-ac', '2', '-f', 'f32le', '-y', tmp,
      '-map', '0:a:0', '-vn', '-af', resampleFilter(ANALYSIS_SAMPLE_RATE), '-ac', '1', '-f', 'f32le', 'pipe:1',
    ];
    const p = spawn(ffmpeg, args);
    const chunks: Buffer[] = [];
    let err = '';
    const warnings: string[] = [];
    signal?.addEventListener('abort', () => p.kill('SIGKILL'));
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      const m = /out_time_us=(\d+)/.exec(s);
      if (m && onProgress) onProgress(parseInt(m[1], 10) / 1e6);
      for (const line of s.split('\n')) {
        if (line && !/^[a-z_]+=/.test(line)) err += line + '\n';
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal?.aborted) { fs.rmSync(tmp, { force: true }); return reject(new Error('Analyse annulée')); }
      const buf = Buffer.concat(chunks);
      const analysis = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
      let size = 0;
      try { size = fs.statSync(tmp).size; } catch { /* missing */ }
      const frames = Math.floor(size / 8);
      if (code !== 0 && frames === 0) {
        fs.rmSync(tmp, { force: true });
        return reject(new Error(cleanError(err) || 'Décodage impossible : fichier corrompu ou format non pris en charge'));
      }
      if (err.trim()) warnings.push('Le décodeur a signalé des erreurs (fichier partiellement corrompu ?) : ' + cleanError(err));
      if (frames < INTERNAL_SAMPLE_RATE * 0.5) {
        fs.rmSync(tmp, { force: true });
        return reject(new Error('Fichier trop court ou vide'));
      }
      fs.renameSync(tmp, pcmPath);
      resolve({ frames, analysis, warnings });
    });
  });
}

/** Extract embedded cover art (if any) to `outPath` as JPEG. */
export function extractArtwork(file: string, outPath: string): Promise<boolean> {
  const { ffmpeg } = findFfmpeg();
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', outPath,
    ]);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
  });
}
