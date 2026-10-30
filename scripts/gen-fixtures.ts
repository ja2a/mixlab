// Generates royalty-free test material in ./fixtures (synthesised with known tempo/key).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { synthesize, encodeFile } from '../src/core/testing/synth';
import { findFfmpeg } from '../src/core/audio/ffmpeg';

const out = path.resolve(process.argv[2] ?? 'fixtures');
fs.mkdirSync(out, { recursive: true });
const NAMES = ['Aurora', 'Nightline', 'Glasshouse', 'Low Orbit', 'Cobalt', 'Silk Road', 'Afterglow', 'Prism', 'Tidal', 'Neon Rain', 'Polaris', 'Satin', 'Driftwood', 'Helix', 'Lumen', 'Monsoon', 'Quartz', 'Riviera', 'Static Bloom', 'Velvet', 'Zenith', 'Ember'];
const BPMS = [120, 122, 124, 124, 125, 126, 126, 127, 128, 128, 128, 130, 122, 118, 132, 124, 126, 140, 70, 174, 87, 123];
const MODES = ['minor', 'major'] as const;

export const FIXTURES = NAMES.map((name, i) => ({
  name, bpm: BPMS[i], tonic: (i * 7) % 12, mode: MODES[i % 3 === 0 ? 1 : 0], bars: 32 + (i % 3) * 8, lead: i % 4 === 0 ? 0.6 : 0,
}));

async function main() {
  const { ffmpeg } = findFfmpeg();
  for (const [i, f] of FIXTURES.entries()) {
    const file = path.join(out, `${String(i + 1).padStart(2, '0')} - ${f.name}.mp3`);
    if (fs.existsSync(file)) continue;
    const s = synthesize({ bpm: f.bpm, tonic: f.tonic, mode: f.mode, bars: f.bars, lead: f.lead, seed: i + 11, level: 0.35 + (i % 5) * 0.1 });
    const tmp = file + '.tmp.mp3';
    await encodeFile(s.left, s.right, s.sampleRate, tmp, { title: f.name, artist: `Synth Ensemble ${1 + (i % 4)}`, album: 'MixLab Test Suite', date: '2026' });
    if (i % 2 === 0) {
      const hue = (i * 37) % 360;
      const cover = file + '.cover.jpg';
      spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `gradients=s=320x320:c0=0x${hueHex(hue)}:c1=0x101018:speed=0`, '-frames:v', '1', '-y', cover]);
      const r = spawnSync(ffmpeg, ['-v', 'error', '-i', tmp, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3', '-y', file]);
      fs.rmSync(cover, { force: true });
      if (r.status !== 0) fs.renameSync(tmp, file); else fs.rmSync(tmp);
    } else fs.renameSync(tmp, file);
    process.stdout.write(`✓ ${path.basename(file)}\n`);
  }
  // Beat-less ambient piece
  const amb = path.join(out, '90 - Ambient Drift (sans pulsation).mp3');
  if (!fs.existsSync(amb)) {
    const s = synthesize({ bpm: 100, tonic: 4, mode: 'minor', bars: 30, ambient: true, seed: 5 });
    await encodeFile(s.left, s.right, s.sampleRate, amb, { title: 'Ambient Drift', artist: 'Synth Ensemble 5' });
  }
  // Corrupted: random bytes with an .mp3 name
  const bad = path.join(out, '98 - Corrupted.mp3');
  if (!fs.existsSync(bad)) {
    const buf = Buffer.alloc(200_000);
    let x = 12345;
    for (let i = 0; i < buf.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = x & 0xff; }
    fs.writeFileSync(bad, buf);
  }
  // Truncated: valid header, cut in the middle of a frame
  const trunc = path.join(out, '99 - Truncated.mp3');
  if (!fs.existsSync(trunc)) {
    const src = fs.readFileSync(path.join(out, '01 - Aurora.mp3'));
    fs.writeFileSync(trunc, src.subarray(0, Math.floor(src.length * 0.4) + 77));
  }
  console.log(`Fixtures in ${out}`);
}

/** HSL(h, 60 %, 50 %) as an RRGGBB hex string. */
function hueHex(h: number): string {
  const a = 0.6 * 0.5;
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

main().catch((e) => { console.error(e); process.exit(1); });
