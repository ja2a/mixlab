import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpRoot } from './helpers';
import { fingerprint, loadProject, relink, saveProject, serializeProject } from '../src/core/project/project';
import { DEFAULT_SETTINGS, defaultTransition, type LibraryTrack, type Mixtape } from '../src/core/types';

const dir = tmpRoot();

function fakeAudio(p: string, seed: number, size = 700_000) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 17) & 0xff;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, b);
}

describe('projects', () => {
  it('saves and reloads order, transitions, cue points, tempo and gain settings', () => {
    const f1 = path.join(dir, 'a.mp3'), f2 = path.join(dir, 'b.mp3');
    fakeAudio(f1, 1); fakeAudio(f2, 2);
    const tracks: LibraryTrack[] = [f1, f2].map((p, i) => ({
      id: 't' + i, path: p, fileName: path.basename(p), ...fingerprint(p),
      meta: { title: 'T' + i, artist: 'X', album: '', year: '', genre: '', hasArtwork: false },
      status: 'ready', overrides: i === 1 ? { bpm: 128, key: { tonic: 9, mode: 'minor' } } : {}, addedAt: 1,
    }));
    const m: Mixtape = {
      id: 'm1', name: 'Soirée', createdAt: 1, manualOrder: ['e0', 'e1'],
      entries: [
        { id: 'e1', trackId: 't1', locked: true, cueIn: 3.5, cueOut: 180.25, gainDb: -2 },
        { id: 'e0', trackId: 't0', locked: false, cueIn: null, cueOut: null, gainDb: 1.5 },
      ],
      transitions: { e1: { ...defaultTransition(), type: 'curve', seconds: 6, fadeOut: 'sCurve', outStart: 170, locked: true, origin: 'manual', toEntryId: 'e0' } },
      settings: { ...DEFAULT_SETTINGS, maxStretchPct: 4, targetLufs: -12 },
    };
    const file = path.join(dir, 'p.mixlab');
    saveProject(file, serializeProject('Mon projet', tracks, [m, { ...m, id: 'm2', name: 'Autre' }], 'm2'));
    const back = loadProject(file);
    expect(back.name).toBe('Mon projet');
    expect(back.activeMixtapeId).toBe('m2');
    expect(back.mixtapes).toHaveLength(2);
    expect(back.mixtapes[0].entries).toEqual(m.entries);
    expect(back.mixtapes[0].transitions).toEqual(m.transitions);
    expect(back.mixtapes[0].settings).toEqual(m.settings);
    expect(back.mixtapes[0].manualOrder).toEqual(['e0', 'e1']);
    expect(back.tracks[1].overrides).toEqual({ bpm: 128, key: { tonic: 9, mode: 'minor' } });
  });

  it('rejects files that are not MixLab projects', () => {
    const f = path.join(dir, 'x.mixlab');
    fs.writeFileSync(f, JSON.stringify({ hello: 1 }));
    expect(() => loadProject(f)).toThrow(/pas un projet MixLab/);
  });

  it('fingerprints content, not names, and relinks moved/renamed files', () => {
    const orig = path.join(dir, 'lib', 'song.mp3');
    fakeAudio(orig, 7);
    const fp = fingerprint(orig);
    const moved = path.join(dir, 'elsewhere', 'deep', 'renamed track.mp3');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(orig, moved);
    fakeAudio(path.join(dir, 'elsewhere', 'decoy.mp3'), 8); // same size, different content
    expect(fingerprint(moved)).toEqual(fp);
    const found = relink([{ id: 's', fileName: 'song.mp3', ...fp }], path.join(dir, 'elsewhere'));
    expect(found.get('s')).toBe(moved);
  });

  it('never modifies source files', () => {
    const f = path.join(dir, 'ro.mp3');
    fakeAudio(f, 3);
    const before = fs.readFileSync(f);
    const st = fs.statSync(f);
    fingerprint(f);
    relink([{ id: 'z', fileName: 'nope.mp3', size: 1, fingerprint: 'x' }], dir);
    expect(fs.readFileSync(f).equals(before)).toBe(true);
    expect(fs.statSync(f).mtimeMs).toBe(st.mtimeMs);
  });
});
