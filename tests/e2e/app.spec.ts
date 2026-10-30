// UI acceptance scenarios on the real Electron app (native dialogs are stubbed to the fixtures).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(root, 'fixtures');
let app: ElectronApplication;
let win: Page;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mixlab-e2e-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixlab-out-'));

async function stubDialogs(open: string[] | null, save: string | null) {
  await app.evaluate(({ dialog }, { open, save }) => {
    dialog.showOpenDialog = (async () => ({ canceled: !open, filePaths: open ?? [] })) as any;
    dialog.showSaveDialog = (async () => ({ canceled: !save, filePath: save ?? undefined })) as any;
  }, { open, save });
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 8, from.y + 8, { steps: 4 });
  await win.mouse.move(to.x, to.y, { steps: 18 });
  await win.waitForTimeout(150);
  await win.mouse.up();
  await win.waitForTimeout(300);
}

const center = async (sel: ReturnType<Page['locator']>) => {
  const b = (await sel.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

const order = () => win.locator('[data-testid=playlist-entry] .entry-title').allTextContents();

test.beforeAll(async () => {
  app = await electron.launch({ args: [root], env: { ...process.env, MIXLAB_USER_DATA: userData } });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});
test.afterAll(async () => { await app?.close(); });

test('1–2 · imports 20+ MP3 files, computes durations and BPM, flags the corrupted one', async () => {
  const files = fs.readdirSync(fixtures).filter((f) => f.endsWith('.mp3')).map((f) => path.join(fixtures, f));
  expect(files.length).toBeGreaterThanOrEqual(23);
  await stubDialogs(files, null);
  await win.getByRole('button', { name: 'Importer des morceaux (⌘I)' }).click();
  await expect(win.locator('[data-testid=library-row]')).toHaveCount(files.length);
  await expect(win.locator('.import-progress')).toHaveCount(0, { timeout: 180_000 });
  await expect(win.locator('.lib-row.status-ready')).toHaveCount(files.length - 1);
  await expect(win.locator('.lib-row.status-error')).toHaveCount(1);
  await expect(win.locator('.lib-row.status-error')).toContainText('Corrupted');
  // durations + BPM chips are shown
  const first = win.locator('.lib-row.status-ready').first();
  await expect(first.locator('.lib-sub')).toContainText(/\d:\d\d/);
  await expect(first.locator('.chip').first()).toContainText(/\d{2,3}/);
});

test('3 · builds a playlist by drag & drop from the library and reorders it', async () => {
  // drag one track from the library into the empty playlist
  await drag(await center(win.locator('.lib-row.status-ready').nth(3)), await center(win.getByTestId('playlist')));
  await expect(win.locator('[data-testid=playlist-entry]')).toHaveCount(1);
  // add the rest
  await win.locator('.panel-actions').getByRole('button', { name: 'Options de la bibliothèque' }).click();
  await win.getByRole('menuitem', { name: 'Ajouter tous les morceaux à la mixtape' }).click();
  const n = await win.locator('[data-testid=playlist-entry]').count();
  expect(n).toBeGreaterThanOrEqual(23);
  const before = await order();
  // reorder: drag the 1st entry below the 3rd one
  const grip = win.locator('[data-testid=playlist-entry]').nth(0).locator('.entry-grip');
  const target = win.locator('[data-testid=playlist-entry]').nth(2).locator('.entry');
  const t = await center(target);
  await drag(await center(grip), { x: t.x, y: t.y + 20 });
  const after = await order();
  expect(after).not.toEqual(before);
  expect(after.slice().sort()).toEqual(before.slice().sort());
  expect(after.indexOf(before[0])).toBeGreaterThan(0);
});

test('4–6 · shows several computed proposals, auditions one and applies it', async () => {
  await win.locator('[data-testid=transition-capsule]').first().click();
  await expect(win.locator('[data-testid=proposal]')).toHaveCount(4);
  await expect(win.locator('[data-testid=proposal]').first()).toContainText(/BPM|Fondu/);
  await win.locator('[data-testid=proposal]').nth(1).getByRole('button', { name: /Écouter/ }).click();
  await expect(win.locator('.now-sub')).toContainText('Écoute d’une transition', { timeout: 15_000 });
  const t0 = await win.getByTestId('player-time').textContent();
  await win.waitForTimeout(1500);
  expect(await win.getByTestId('player-time').textContent()).not.toBe(t0);
  await win.locator('[data-testid=proposal]').nth(1).getByRole('button', { name: 'Appliquer' }).click();
  await expect(win.locator('[data-testid=proposal]').nth(1)).toHaveClass(/is-active/);
  await win.getByTestId('listen-transition').click();
  await win.waitForTimeout(1200);
  await win.getByTestId('play-button').click(); // pause
});

test('7 · previews several successive transitions (playback across track boundaries)', async () => {
  await win.locator('[data-testid=transition-capsule]').nth(2).click();
  const t = await win.locator('.point-row .point-value').first().textContent();
  expect(t).toBeTruthy();
  // play from just before transition 2 and keep listening through transition 3
  await win.getByRole('button', { name: 'Transition précédente' }).click();
  await win.getByTestId('play-button').click();
  await win.waitForTimeout(3000);
  await win.getByRole('button', { name: 'Transition suivante' }).click();
  await win.waitForTimeout(3000);
  await expect(win.locator('.play-btn.is-playing')).toHaveCount(1);
  await win.getByTestId('play-button').click();
});

test('5 · generates alternative orders without overwriting the manual order', async () => {
  const manual = await order();
  await win.getByTestId('generate-button').click();
  await expect(win.locator('[data-testid=order-card]').first()).toBeVisible({ timeout: 30_000 });
  expect(await win.locator('[data-testid=order-card]').count()).toBeGreaterThanOrEqual(3);
  await win.locator('[data-testid=order-card]').nth(1).click();
  await win.getByTestId('apply-order').click();
  const generated = await order();
  expect(generated).not.toEqual(manual);
  await win.getByRole('button', { name: 'Ordre manuel' }).click();
  expect(await order()).toEqual(manual);
});

test('8, 12 · exports one MP3 in the background while the UI stays responsive', async () => {
  // keep a short mixtape for speed: remove all but the first 6 entries
  while ((await win.locator('[data-testid=playlist-entry]').count()) > 6) {
    await win.locator('[data-testid=playlist-entry]').last().locator('.entry').click();
    await win.keyboard.press('Backspace');
  }
  const out = path.join(outDir, 'Ma mixtape.mp3');
  await stubDialogs(null, out);
  await win.getByTestId('export-button').click();
  await win.getByTestId('export-start').click();
  await expect(win.getByTestId('export-running')).toBeVisible();
  // UI is not blocked: hide the dialog and interact with the playlist while rendering
  await win.getByRole('button', { name: 'Masquer' }).click();
  await win.locator('[data-testid=playlist-entry]').nth(1).locator('.entry').click();
  await expect(win.getByTestId('inspector')).toContainText('Début et fin de lecture');
  await expect(win.locator('.export-pill')).toBeVisible();
  await win.locator('.export-pill').click();
  await expect(win.getByTestId('export-done')).toBeVisible({ timeout: 120_000 });
  await expect(win.getByTestId('export-done')).toContainText('aucun silence');
  await expect(win.getByTestId('export-done')).toContainText('sans saturation');
  expect(fs.statSync(out).size).toBeGreaterThan(500_000);
  await win.getByRole('button', { name: 'Terminé' }).click();
});

test('13 · saves and reloads a project', async () => {
  const proj = path.join(outDir, 'Projet test.mixlab');
  await stubDialogs(null, proj);
  const titles = await order();
  await win.getByRole('button', { name: 'Enregistrer le projet (⌘S)' }).click();
  await expect.poll(() => fs.existsSync(proj)).toBe(true);
  const saved = JSON.parse(fs.readFileSync(proj, 'utf8'));
  expect(saved.format).toBe('mixlab-project');
  // new project, then reopen
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'new'));
  await expect(win.locator('[data-testid=playlist-entry]')).toHaveCount(0);
  await stubDialogs([proj], null);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'open'));
  await expect(win.locator('[data-testid=playlist-entry]')).toHaveCount(titles.length);
  await expect(win.locator('.import-progress')).toHaveCount(0, { timeout: 60_000 });
  expect(await order()).toEqual(titles);
});
