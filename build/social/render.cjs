// Renders social-preview.html to docs/social-preview.png (1280×640).
// Usage: npx electron build/social/render.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 } });
  await win.loadFile(path.join(__dirname, 'social-preview.html'));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 640 });
  const out = path.join(__dirname, '..', '..', 'docs', 'social-preview.png');
  fs.writeFileSync(out, image.resize({ width: 1280, height: 640, quality: 'best' }).toPNG());
  console.log(out, fs.statSync(out).size, 'bytes');
  app.quit();
});
