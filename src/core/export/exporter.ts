// Streaming export of a mix plan to a single MP3 (LAME through FFmpeg) or WAV file.
// The mix is rendered block by block; memory use is independent of the mix length.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findFfmpeg } from '../audio/ffmpeg';
import { PcmReader } from '../audio/pcm';
import { MixRenderer } from '../mix/renderer';
import { LoudnessMeter } from '../analysis/loudness';
import type { MixPlan } from '../mix/plan';

export interface ExportOptions {
  format: 'mp3' | 'wav';
  bitrate: 192 | 256 | 320;
  outPath: string;
  metadata: { title: string; artist: string; album?: string; comment?: string; year?: string };
  chapters: boolean;
  cueSheet: boolean;
}

export interface ExportReport {
  outPath: string;
  format: 'mp3' | 'wav';
  duration: number;
  frames: number;
  truePeakDb: number;
  samplePeakDb: number;
  lufs: number | null;
  /** Longest run of near-silence (< −60 dBFS) between the start and the end of the music, seconds. */
  longestSilence: number;
  limiterMaxReductionDb: number;
  elapsedMs: number;
  cuePath?: string;
}

export interface ExportProgress {
  frames: number;
  totalFrames: number;
  stage: 'render' | 'finalize';
}

const BLOCK = 1 << 14;

export class ExportCancelled extends Error {
  constructor() { super('Export annulé'); }
}

function fmtCueTime(s: number): string {
  const frames = Math.round(s * 75);
  const mm = Math.floor(frames / (75 * 60));
  const ss = Math.floor((frames / 75) % 60);
  const ff = frames % 75;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

/** Chapter / cue position of each track: middle of its incoming transition (or 0). */
export function trackMarkers(plan: MixPlan): Array<{ start: number; end: number; title: string; artist: string }> {
  return plan.voices.map((v, i) => {
    const tin = plan.transitions[i - 1];
    const tout = plan.transitions[i];
    const start = tin ? (tin.start + tin.end) / 2 : 0;
    const end = tout ? (tout.start + tout.end) / 2 : plan.duration;
    return { start, end, title: v.title, artist: v.artist };
  });
}

function escMeta(s: string): string {
  return s.replace(/([=;#\\\n])/g, '\\$1');
}

export async function exportMix(
  plan: MixPlan,
  opts: ExportOptions,
  onProgress: (p: ExportProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<ExportReport> {
  const t0 = Date.now();
  if (!plan.voices.length) throw new Error('La playlist est vide');
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const tmp = opts.outPath + '.mixlab-part';
  const metaFile = opts.outPath + '.mixlab-meta.txt';
  const sr = plan.sampleRate;
  const total = plan.totalFrames;
  const readers: PcmReader[] = [];
  const renderer = new MixRenderer(plan, (p) => { const r = new PcmReader(p); readers.push(r); return r; });
  const meter = new LoudnessMeter(sr, 2);

  // Silence tracking on 50 ms windows
  const win = Math.round(sr * 0.05);
  let winAcc = 0, winN = 0, run = 0, longest = 0, seenSound = false;
  const silentThr = Math.pow(10, -60 / 20) ** 2;
  const track = (l: Float32Array, r: Float32Array, n: number) => {
    for (let i = 0; i < n; i++) {
      winAcc += (l[i] * l[i] + r[i] * r[i]) / 2;
      if (++winN === win) {
        const silent = winAcc / win < silentThr;
        if (silent) run++; else { if (seenSound) longest = Math.max(longest, run); run = 0; seenSound = true; }
        winAcc = 0; winN = 0;
      }
    }
  };

  let sink: { write(buf: Buffer): Promise<void>; end(): Promise<void>; abort(): void };
  if (opts.format === 'mp3') {
    const { ffmpeg } = findFfmpeg();
    const markers = trackMarkers(plan);
    const lines = [';FFMETADATA1', `title=${escMeta(opts.metadata.title)}`, `artist=${escMeta(opts.metadata.artist)}`];
    if (opts.metadata.album) lines.push(`album=${escMeta(opts.metadata.album)}`);
    if (opts.metadata.year) lines.push(`date=${escMeta(opts.metadata.year)}`);
    const tracklist = markers.map((m, i) => `${i + 1}. ${m.artist} – ${m.title}`).join(' / ');
    lines.push(`comment=${escMeta(opts.metadata.comment || 'Mixé avec MixLab — ' + tracklist)}`);
    if (opts.chapters) {
      for (const m of markers) {
        lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(m.start * 1000)}`, `END=${Math.round(m.end * 1000)}`, `title=${escMeta(`${m.artist} – ${m.title}`)}`);
      }
    }
    fs.writeFileSync(metaFile, lines.join('\n') + '\n');
    const args = [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', 'pipe:0',
      '-i', metaFile, '-map', '0:a', '-map_metadata', '1', '-map_chapters', opts.chapters ? '1' : '-1',
      '-c:a', 'libmp3lame', '-b:a', `${opts.bitrate}k`, '-compression_level', '0',
      '-id3v2_version', '3', '-write_xing', '1',
      '-f', 'mp3', '-y', tmp,
    ];
    const p = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const done = new Promise<void>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Encodeur MP3 : ' + (err.trim() || `code ${code}`)))));
    });
    done.catch(() => {});
    let stdinErr: Error | null = null;
    p.stdin.on('error', (e) => (stdinErr = e));
    sink = {
      write: (buf) => new Promise((resolve, reject) => {
        if (stdinErr || !p.stdin.writable) return reject(new Error('Encodeur MP3 interrompu : ' + (err.trim() || stdinErr?.message)));
        if (p.stdin.write(buf)) resolve();
        else p.stdin.once('drain', resolve);
      }),
      end: async () => { p.stdin.end(); await done; },
      abort: () => { p.kill('SIGKILL'); },
    };
  } else {
    const fd = fs.openSync(tmp, 'w');
    const header = Buffer.alloc(44);
    fs.writeSync(fd, header, 0, 44, 0);
    let bytes = 0;
    sink = {
      write: async (buf) => {
        // float32 interleaved → 24-bit PCM
        const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const out = Buffer.alloc(f.length * 3);
        for (let i = 0; i < f.length; i++) {
          const v = Math.max(-8388608, Math.min(8388607, Math.round(f[i] * 8388607)));
          out.writeIntLE(v, i * 3, 3);
        }
        fs.writeSync(fd, out, 0, out.length, 44 + bytes);
        bytes += out.length;
      },
      end: async () => {
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
        h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34);
        h.write('data', 36); h.writeUInt32LE(bytes, 40);
        fs.writeSync(fd, h, 0, 44, 0);
        fs.closeSync(fd);
      },
      abort: () => { try { fs.closeSync(fd); } catch { /* closed */ } },
    };
  }

  const cleanup = () => {
    renderer.close();
    for (const r of readers) r.close();
    fs.rmSync(metaFile, { force: true });
  };

  try {
    let done = 0;
    let lastReport = 0;
    while (done < total) {
      if (signal?.aborted) throw new ExportCancelled();
      const n = Math.min(BLOCK, total - done);
      const { left, right } = renderer.render(n);
      meter.push([left, right], n);
      track(left, right, n);
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { inter[2 * i] = left[i]; inter[2 * i + 1] = right[i]; }
      await sink.write(Buffer.from(inter.buffer));
      done += n;
      if (done - lastReport >= sr * 2 || done === total) {
        lastReport = done;
        onProgress({ frames: done, totalFrames: total, stage: 'render' });
        // Yield so cancellation messages can be processed.
        await new Promise((r) => setImmediate(r));
      }
    }
    onProgress({ frames: total, totalFrames: total, stage: 'finalize' });
    await sink.end();
    if (signal?.aborted) throw new ExportCancelled();
    fs.renameSync(tmp, opts.outPath);
  } catch (e) {
    sink.abort();
    cleanup();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  cleanup();

  let cuePath: string | undefined;
  if (opts.cueSheet) {
    cuePath = opts.outPath.replace(/\.[^.]+$/, '') + '.cue';
    const markers = trackMarkers(plan);
    const cue = [
      `PERFORMER "${opts.metadata.artist.replace(/"/g, "'")}"`,
      `TITLE "${opts.metadata.title.replace(/"/g, "'")}"`,
      `FILE "${path.basename(opts.outPath)}" ${opts.format === 'mp3' ? 'MP3' : 'WAVE'}`,
      ...markers.flatMap((m, i) => [
        `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`,
        `    TITLE "${m.title.replace(/"/g, "'")}"`,
        `    PERFORMER "${m.artist.replace(/"/g, "'")}"`,
        `    INDEX 01 ${fmtCueTime(m.start)}`,
      ]),
    ].join('\n');
    fs.writeFileSync(cuePath, cue + '\n');
  }

  const loud = meter.result();
  return {
    outPath: opts.outPath,
    format: opts.format,
    duration: total / sr,
    frames: total,
    truePeakDb: loud.truePeakDb,
    samplePeakDb: loud.samplePeakDb,
    lufs: loud.integrated,
    longestSilence: (longest * win) / sr,
    limiterMaxReductionDb: -20 * Math.log10(Math.max(1e-6, renderer.limiterMinGain)),
    elapsedMs: Date.now() - t0,
    cuePath,
  };
}
