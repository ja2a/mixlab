// electron-builder afterPack hook: ad-hoc sign the whole macOS bundle.
// Without a valid signature covering all resources, a downloaded (quarantined) copy is reported
// by macOS as "damaged". Ad-hoc signing needs no Apple certificate; users still confirm the first
// launch (right-click → Open, or System Settings → Privacy & Security → Open Anyway).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
