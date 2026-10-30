// Random access reader for decoded PCM caches (float32 interleaved stereo).
// Reads are served from an LRU of fixed-size chunks so a long mix never sits fully in memory.

import fs from 'node:fs';

const CHUNK_FRAMES = 1 << 16; // ~1.5 s at 44.1 kHz
const MAX_CHUNKS = 48;

export class PcmReader {
  readonly frames: number;
  private fd: number;
  private chunks = new Map<number, Float32Array>();

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'r');
    this.frames = Math.floor(fs.fstatSync(this.fd).size / 8);
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.chunks.clear();
  }

  private chunk(idx: number): Float32Array {
    let c = this.chunks.get(idx);
    if (c) {
      this.chunks.delete(idx);
      this.chunks.set(idx, c);
      return c;
    }
    const start = idx * CHUNK_FRAMES;
    const n = Math.max(0, Math.min(CHUNK_FRAMES, this.frames - start));
    const buf = Buffer.alloc(CHUNK_FRAMES * 8);
    if (n > 0) fs.readSync(this.fd, buf, 0, n * 8, start * 8);
    c = new Float32Array(buf.buffer, buf.byteOffset, CHUNK_FRAMES * 2);
    this.chunks.set(idx, c);
    if (this.chunks.size > MAX_CHUNKS) {
      const first = this.chunks.keys().next().value as number;
      this.chunks.delete(first);
    }
    return c;
  }

  /**
   * Copy frames [start, start + n) into `left`/`right` at `offset`. Out-of-range frames are silence.
   */
  read(start: number, n: number, left: Float32Array, right: Float32Array, offset = 0): void {
    let i = 0;
    while (i < n) {
      const f = start + i;
      if (f < 0 || f >= this.frames) {
        left[offset + i] = 0;
        right[offset + i] = 0;
        i++;
        continue;
      }
      const ci = Math.floor(f / CHUNK_FRAMES);
      const c = this.chunk(ci);
      let pos = f - ci * CHUNK_FRAMES;
      const lim = Math.min(n - i, CHUNK_FRAMES - pos, this.frames - f);
      for (let k = 0; k < lim; k++, pos++, i++) {
        left[offset + i] = c[pos * 2];
        right[offset + i] = c[pos * 2 + 1];
      }
    }
  }
}

/** Iterate over a cache file in blocks (used by analysis). */
export function forEachBlock(path: string, blockFrames: number, cb: (l: Float32Array, r: Float32Array, n: number) => void): void {
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(blockFrames * 8);
    const l = new Float32Array(blockFrames);
    const r = new Float32Array(blockFrames);
    let pos = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      pos += read;
      const n = Math.floor(read / 8);
      const f = new Float32Array(buf.buffer, buf.byteOffset, n * 2);
      for (let i = 0; i < n; i++) { l[i] = f[2 * i]; r[i] = f[2 * i + 1]; }
      cb(l, r, n);
      if (read < buf.length) break;
    }
  } finally {
    fs.closeSync(fd);
  }
}
