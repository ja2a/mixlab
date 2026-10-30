// Project persistence, file fingerprints and relinking of moved source files.
// Source audio files are only ever read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type LibraryTrack, type Mixtape, type ProjectFile } from '../types';

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.aif', '.aiff', '.ogg', '.opus'];

export function isAudioFile(p: string): boolean {
  return AUDIO_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

/** Content fingerprint: size + SHA-1 of the first and last 256 KiB. Stable across renames/moves. */
export function fingerprint(file: string): { fingerprint: string; size: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const h = crypto.createHash('sha1');
    h.update(String(size));
    const chunk = 256 * 1024;
    const buf = Buffer.alloc(Math.min(chunk, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    h.update(buf);
    if (size > chunk) {
      const tail = Buffer.alloc(Math.min(chunk, size - chunk));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
    return { fingerprint: h.digest('hex').slice(0, 24), size };
  } finally {
    fs.closeSync(fd);
  }
}

export function serializeProject(name: string, tracks: LibraryTrack[], mixtapes: Mixtape[], activeMixtapeId: string | null): ProjectFile {
  return {
    format: 'mixlab-project',
    version: 1,
    name,
    tracks: tracks.map((t) => ({
      id: t.id, path: t.path, fileName: t.fileName, size: t.size, fingerprint: t.fingerprint,
      meta: t.meta, overrides: t.overrides, addedAt: t.addedAt,
    })),
    mixtapes,
    activeMixtapeId,
    savedAt: Date.now(),
  };
}

export function saveProject(file: string, project: ProjectFile): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
  fs.renameSync(tmp, file);
}

export function loadProject(file: string): ProjectFile {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw?.format !== 'mixlab-project') throw new Error('Ce fichier n’est pas un projet MixLab');
  if (raw.version !== 1) throw new Error(`Version de projet non prise en charge (${raw.version})`);
  const p = raw as ProjectFile;
  for (const m of p.mixtapes) {
    m.settings = { ...DEFAULT_SETTINGS, ...(m.settings ?? {}) };
    m.transitions ??= {};
    m.manualOrder ??= null;
  }
  return p;
}

/**
 * Look for missing files under `root`: first by identical file name with matching fingerprint,
 * then by matching fingerprint among audio files of the same size.
 */
export function relink(
  missing: Array<{ id: string; fileName: string; size: number; fingerprint: string }>,
  root: string,
  maxFiles = 50000,
): Map<string, string> {
  const found = new Map<string, string>();
  const bySize = new Map<number, typeof missing>();
  for (const m of missing) {
    const l = bySize.get(m.size) ?? [];
    l.push(m);
    bySize.set(m.size, l);
  }
  let visited = 0;
  const stack = [root];
  while (stack.length && found.size < missing.length && visited < maxFiles) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile() || !isAudioFile(p)) continue;
      visited++;
      let size: number;
      try { size = fs.statSync(p).size; } catch { continue; }
      const cands = bySize.get(size)?.filter((m) => !found.has(m.id));
      if (!cands?.length) continue;
      const fp = fingerprint(p).fingerprint;
      for (const c of cands) if (c.fingerprint === fp) { found.set(c.id, p); break; }
    }
  }
  return found;
}
