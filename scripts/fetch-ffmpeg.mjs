// Downloads pinned, checksum-verified static FFmpeg builds into vendor/ffmpeg/<os>-<arch>/,
// from where electron-builder embeds them in the app (Contents/Resources/bin).
//
//   node scripts/fetch-ffmpeg.mjs --platform mac --arch arm64 --arch x64 [--verify]
//   node scripts/fetch-ffmpeg.mjs --platform win --arch x64 [--verify]
//
// --verify runs the extracted binaries (only those matching the host) and checks that the MP3
// encoder is available. Used on the CI runners that build the installers.
//
// To update FFmpeg: change the URLs below and their SHA-256 (published next to each download).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARTIN_RIEDL = 'https://ffmpeg.martin-riedl.de/download/macos';
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-30-13-01';
const BTBN_NAME = 'ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-9.0';

/** Pinned sources: one archive per binary (macOS) or one archive with both (Windows). */
const SOURCES = {
  'mac-arm64': {
    license: 'GPL-3.0-or-later (build by Martin Riedl, https://ffmpeg.martin-riedl.de)',
    archives: [
      { url: `${MARTIN_RIEDL}/arm64/1789931890_9.0.2/ffmpeg.zip`, sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924', files: { ffmpeg: 'ffmpeg' } },
      { url: `${MARTIN_RIEDL}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6', files: { ffprobe: 'ffprobe' } },
    ],
  },
  'mac-x64': {
    license: 'GPL-3.0-or-later (build by Martin Riedl, https://ffmpeg.martin-riedl.de)',
    archives: [
      { url: `${MARTIN_RIEDL}/amd64/1789931006_9.0.2/ffmpeg.zip`, sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4', files: { ffmpeg: 'ffmpeg' } },
      { url: `${MARTIN_RIEDL}/amd64/1789931006_9.0.2/ffprobe.zip`, sha256: '2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd', files: { ffprobe: 'ffprobe' } },
    ],
  },
  'win-x64': {
    license: 'LGPL-2.1-or-later (build by BtbN, https://github.com/BtbN/FFmpeg-Builds)',
    archives: [
      {
        url: `${BTBN}/${BTBN_NAME}.zip`,
        sha256: 'af8ed2ae77febbee949f1e7ba8f42883c1b51713e412a6e5bc8f63cc4f77af87',
        files: { 'ffmpeg.exe': `${BTBN_NAME}/bin/ffmpeg.exe`, 'ffprobe.exe': `${BTBN_NAME}/bin/ffprobe.exe`, 'FFMPEG-LICENSE.txt': `${BTBN_NAME}/LICENSE.txt` },
      },
    ],
  },
};

function parseArgs() {
  const a = process.argv.slice(2);
  const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const platform = a.includes('--platform') ? a[a.indexOf('--platform') + 1] : hostOs;
  const arches = a.flatMap((x, i) => (x === '--arch' ? [a[i + 1]] : []));
  return { platform, arches: arches.length ? arches : [process.arch], verify: a.includes('--verify') };
}

async function download(url, dest, sha256) {
  if (fs.existsSync(dest) && hash(dest) === sha256) return;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Téléchargement impossible (${res.status}) : ${url}\nLe build épinglé a peut-être été retiré : mettez à jour l'URL et le SHA-256 dans scripts/fetch-ffmpeg.mjs.`);
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const got = hash(dest);
  if (got !== sha256) {
    fs.rmSync(dest, { force: true });
    throw new Error(`Empreinte SHA-256 inattendue pour ${url}\n  attendue : ${sha256}\n  obtenue  : ${got}`);
  }
}

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify(dir, key) {
  const [plat, arch] = key.split('-');
  const host = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;
  if (`${plat}-${arch}` !== host) {
    console.log(`  (vérification d'exécution ignorée : ${key} sur ${host})`);
    return;
  }
  const exe = plat === 'win' ? '.exe' : '';
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const out = execFileSync(path.join(dir, bin + exe), ['-hide_banner', '-version'], { encoding: 'utf8' });
    console.log(`  ${bin}: ${out.split('\n')[0]}`);
  }
  const enc = execFileSync(path.join(dir, 'ffmpeg' + exe), ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (!/libmp3lame/.test(enc)) throw new Error(`${key} : l'encodeur MP3 (libmp3lame) est absent`);
  console.log('  encodeur MP3 : ok');
}

async function main() {
  const { platform, arches, verify: doVerify } = parseArgs();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const arch of arches) {
    const key = `${platform}-${arch}`;
    const src = SOURCES[key];
    if (!src) throw new Error(`Aucune source FFmpeg pour ${key} (disponibles : ${Object.keys(SOURCES).join(', ')})`);
    const outDir = path.join(root, 'vendor', 'ffmpeg', key);
    const cache = path.join(root, 'vendor', 'ffmpeg', '.cache');
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    console.log(`FFmpeg ${key}`);
    for (const archive of src.archives) {
      const zip = path.join(cache, `${key}-${path.basename(new URL(archive.url).pathname)}`);
      await download(archive.url, zip, archive.sha256);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixlab-ffmpeg-'));
      // bsdtar (macOS, Windows 10+) extracts zip archives.
      execFileSync('tar', ['-xf', zip, '-C', tmp]);
      for (const [name, inner] of Object.entries(archive.files)) {
        const from = path.join(tmp, inner);
        if (!fs.existsSync(from)) throw new Error(`${inner} introuvable dans ${archive.url}`);
        fs.copyFileSync(from, path.join(outDir, name));
        if (!name.endsWith('.exe') && !name.endsWith('.txt')) fs.chmodSync(path.join(outDir, name), 0o755);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(outDir, 'SOURCE.txt'), `FFmpeg 9.0.2 — ${src.license}\n${src.archives.map((a) => `${a.url}\n  sha256 ${a.sha256}`).join('\n')}\n`);
    if (doVerify) verify(outDir, key);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
