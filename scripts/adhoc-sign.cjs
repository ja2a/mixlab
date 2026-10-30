// electron-builder afterPack hook: ad-hoc sign the macOS bundle.
// Without a valid signature covering all resources, a downloaded (quarantined) copy is reported
// by macOS as "damaged". Ad-hoc signing needs no Apple certificate; users still confirm the first
// launch (System Settings → Privacy & Security → Open Anyway).
// Embedded executables (FFmpeg) are signed first: Apple Silicon refuses to run unsigned code.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const run = (args) => execFileSync('codesign', args, { stdio: 'inherit' });
const isValid = (file) => {
  try {
    execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const bin = path.join(app, 'Contents', 'Resources', 'bin');
  if (fs.existsSync(bin)) {
    for (const name of ['ffmpeg', 'ffprobe']) {
      const file = path.join(bin, name);
      if (fs.existsSync(file) && !isValid(file)) run(['--force', '--sign', '-', file]);
    }
  }
  run(['--force', '--deep', '--sign', '-', app]);
  run(['--verify', '--deep', '--strict', app]);
};
